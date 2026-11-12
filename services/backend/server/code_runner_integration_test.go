package server

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"justai-backend/config"
)

// Runs against a real code-runner service. Skipped unless
// JUSTAI_TEST_CODE_RUNNER_URL and JUSTAI_TEST_CODE_RUNNER_TOKEN are set:
//
//	podman run -d -p 18090:8090 -e CODE_RUNNER_TOKEN=... justai-code-runner:test
func TestCodeRunnerIntegration(t *testing.T) {
	url, token := os.Getenv("JUSTAI_TEST_CODE_RUNNER_URL"), os.Getenv("JUSTAI_TEST_CODE_RUNNER_TOKEN")
	if url == "" || token == "" {
		t.Skip("set JUSTAI_TEST_CODE_RUNNER_URL and JUSTAI_TEST_CODE_RUNNER_TOKEN to run against a real runner")
	}
	app := &App{Config: config.Config{CodeRunner: config.CodeRunnerConfig{URL: url, Token: token}}}

	response, err := app.callCodeRunner(t.Context(), map[string]any{
		"language": "python",
		"code":     "import pandas as pd, matplotlib.pyplot as plt\ndf = pd.DataFrame({'a': [1, 2, 3]})\nprint(df.a.sum())\nplt.plot(df.a)\nopen('out.csv', 'w').write('x,y\\n1,2')",
		"stdin":    "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.ExitCode == nil || *response.ExitCode != 0 || strings.TrimSpace(response.Stdout) != "6" {
		t.Fatalf("unexpected run: exit=%v stdout=%q stderr=%q", response.ExitCode, response.Stdout, response.Stderr)
	}
	types := map[string]string{}
	for _, file := range response.Files {
		types[file.Name] = trustedCodeRunnerMime(file.Mime, mustDecode(t, file.Data))
	}
	if types["figure-1.png"] != "image/png" || types["out.csv"] != "text/csv" {
		t.Fatalf("unexpected files: %v", types)
	}

	failing, err := app.runCodeForChat(t.Context(), uuid.New(), uuid.New(), map[string]any{"code": "raise RuntimeError('nope')"})
	if err != nil || !strings.Contains(string(failing), "RuntimeError: nope") {
		t.Fatalf("a failing program must come back as a result: %s, %v", failing, err)
	}
}

func mustDecode(t *testing.T, value string) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
