package config

import (
	"strings"
	"testing"
)

func TestCodeRunnerConfigIsOptionalAndValidated(t *testing.T) {
	t.Setenv("JUSTAI_CODE_RUNNER_URL", "")
	t.Setenv("JUSTAI_CODE_RUNNER_TOKEN", "")
	disabled, err := codeRunnerConfig(fileCodeRunnerConfig{})
	if err != nil || disabled.URL != "" {
		t.Fatalf("an unset runner must simply be disabled: %+v, %v", disabled, err)
	}

	enabled, err := codeRunnerConfig(fileCodeRunnerConfig{URL: "http://code-runner:8090/", Token: "runner-token-0123456789"})
	if err != nil || enabled.URL != "http://code-runner:8090" {
		t.Fatalf("expected a trimmed URL, got %+v, %v", enabled, err)
	}

	for name, values := range map[string]fileCodeRunnerConfig{
		"not a url":    {URL: "code-runner:8090", Token: "runner-token-0123456789"},
		"wrong scheme": {URL: "ftp://code-runner", Token: "runner-token-0123456789"},
		"short token":  {URL: "http://code-runner:8090", Token: "short"},
		"no token":     {URL: "http://code-runner:8090"},
	} {
		if _, err := codeRunnerConfig(values); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	t.Setenv("JUSTAI_CODE_RUNNER_URL", "http://from-env:8090")
	t.Setenv("JUSTAI_CODE_RUNNER_TOKEN", "env-token-0123456789")
	fromEnv, err := codeRunnerConfig(fileCodeRunnerConfig{URL: "http://from-file:1", Token: "file-token-0123456789"})
	if err != nil || !strings.HasSuffix(fromEnv.URL, "from-env:8090") || fromEnv.Token != "env-token-0123456789" {
		t.Fatalf("environment must win over the file: %+v, %v", fromEnv, err)
	}
}
