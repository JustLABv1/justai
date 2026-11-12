package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"

	"justai-backend/config"
)

var pngHeader = []byte("\x89PNG\r\n\x1a\n")

func newRunnerApp(t *testing.T, handler http.HandlerFunc) (*App, func()) {
	t.Helper()
	runner := httptest.NewServer(handler)
	return &App{Config: config.Config{CodeRunner: config.CodeRunnerConfig{URL: runner.URL, Token: "runner-token-0123456789"}}}, runner.Close
}

func TestRunCodeToolIsOnlyOfferedWhenTheRunnerIsConfigured(t *testing.T) {
	disabled := &App{}
	if _, ok := disabled.builtInToolDiscovery().Bindings[codeRunnerToolName]; ok {
		t.Fatal("run_code must not be offered without a configured runner")
	}
	enabled := &App{Config: config.Config{CodeRunner: config.CodeRunnerConfig{URL: "http://code-runner:8090", Token: "runner-token-0123456789"}}}
	discovery := enabled.builtInToolDiscovery()
	binding, ok := discovery.Bindings[codeRunnerToolName]
	if !ok || !binding.Builtin {
		t.Fatalf("run_code binding missing: %+v", binding)
	}
	found := false
	for _, definition := range discovery.Definitions {
		found = found || definition.Name == codeRunnerToolName
	}
	if !found || !isAssistantBuiltInToolName(codeRunnerToolName) || !selectedContextToolAllowed(codeRunnerToolName) {
		t.Fatal("run_code must be a registered built-in tool")
	}
	if _, err := disabled.executeBuiltInChatTool(t.Context(), uuid.New(), uuid.New(), uuid.New(), codeRunnerToolName, map[string]any{"code": "print(1)"}, nil); err == nil {
		t.Fatal("expected an error when the runner is not configured")
	}
}

func TestRunCodeReturnsOutputAndStoresFiles(t *testing.T) {
	var received map[string]any
	app, closeRunner := newRunnerApp(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/run" || r.Header.Get("Authorization") != "Bearer runner-token-0123456789" {
			t.Errorf("unexpected runner request: %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&received)
		png := append(append([]byte{}, pngHeader...), []byte("data")...)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"exitCode": 0, "timedOut": false, "durationMs": 42, "stdout": "42\n", "stderr": "", "truncated": false,
			"files": []map[string]any{
				{"name": "figure-1.png", "mime": "image/png", "size": len(png), "data": base64.StdEncoding.EncodeToString(png)},
			},
		})
	})
	defer closeRunner()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	app.DB = database
	userID, organizationID, fileID := uuid.New(), uuid.New(), uuid.New()
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO generated_chat_files (user_id, organization_id, title, filename, mime_type, size_bytes, file_data)")).
		WithArgs(userID, organizationID, "figure-1.png", "figure-1.png", "image/png", sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "filename", "mime_type", "size_bytes", "created_at"}).
			AddRow(fileID, "figure-1.png", "figure-1.png", "image/png", int64(12), time.Now().UTC()))

	result, err := app.executeBuiltInChatTool(t.Context(), userID, organizationID, uuid.New(), codeRunnerToolName, map[string]any{
		"code": "print(6 * 7)", "stdin": "1\n", "timeoutSeconds": float64(5),
	}, nil)
	if err != nil {
		t.Fatalf("run_code: %v", err)
	}
	if received["code"] != "print(6 * 7)" || received["language"] != "python" || received["stdin"] != "1\n" || received["timeoutSeconds"] != float64(5) {
		t.Fatalf("runner got %v", received)
	}
	var decoded struct {
		CodeRun codeRunResult `json:"codeRun"`
	}
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatal(err)
	}
	run := decoded.CodeRun
	if run.Stdout != "42\n" || run.ExitCode == nil || *run.ExitCode != 0 || run.DurationMs != 42 || run.Language != "python" {
		t.Fatalf("unexpected run: %+v", run)
	}
	if len(run.Files) != 1 || run.Files[0].URL != "/api/v1/files/"+fileID.String() || run.Files[0].MimeType != "image/png" {
		t.Fatalf("unexpected files: %+v", run.Files)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRunCodeReportsFailuresWithoutHidingThem(t *testing.T) {
	app, closeRunner := newRunnerApp(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"exitCode": 1, "durationMs": 5, "stdout": "", "stderr": "Traceback...\nZeroDivisionError: division by zero\n", "files": []any{},
		})
	})
	defer closeRunner()
	result, err := app.runCodeForChat(t.Context(), uuid.New(), uuid.New(), map[string]any{"code": "1/0"})
	if err != nil {
		t.Fatalf("a failing program is a result, not a tool error: %v", err)
	}
	if !strings.Contains(string(result), "ZeroDivisionError") || !strings.Contains(string(result), `"exitCode":1`) {
		t.Fatalf("stderr or exit code missing: %s", result)
	}
}

func TestRunCodeTranslatesRunnerProblems(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"busy":     {http.StatusServiceUnavailable, `{}`, "busy"},
		"rejected": {http.StatusUnauthorized, `{}`, "rejected"},
		"broken":   {http.StatusInternalServerError, `{}`, "failed"},
		"garbage":  {http.StatusOK, `not json`, "invalid"},
		"redirect": {http.StatusFound, `{}`, "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			app, closeRunner := newRunnerApp(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", "http://169.254.169.254/")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			defer closeRunner()
			_, err := app.runCodeForChat(t.Context(), uuid.New(), uuid.New(), map[string]any{"code": "print(1)"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected an error containing %q, got %v", tc.want, err)
			}
		})
	}
}

func TestRunCodeUnreachableRunnerIsAFriendlyError(t *testing.T) {
	app := &App{Config: config.Config{CodeRunner: config.CodeRunnerConfig{URL: "http://127.0.0.1:1", Token: "runner-token-0123456789"}}}
	_, err := app.runCodeForChat(t.Context(), uuid.New(), uuid.New(), map[string]any{"code": "print(1)"})
	if err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("expected an unreachable error, got %v", err)
	}
}

func TestRunCodeValidatesArguments(t *testing.T) {
	app, closeRunner := newRunnerApp(t, func(http.ResponseWriter, *http.Request) { t.Error("runner must not be called") })
	defer closeRunner()
	for name, arguments := range map[string]map[string]any{
		"empty code":     {"code": "  "},
		"other language": {"language": "ruby", "code": "puts 1"},
		"too big":        {"code": strings.Repeat("x", maxCodeRunnerCodeBytes+1)},
		"big stdin":      {"code": "print(1)", "stdin": strings.Repeat("x", maxCodeRunnerStdinBytes+1)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := app.runCodeForChat(t.Context(), uuid.New(), uuid.New(), arguments); err == nil {
				t.Fatal("expected a validation error")
			}
		})
	}
}

func TestRunCodeShortensHugeOutputForTheModel(t *testing.T) {
	app, closeRunner := newRunnerApp(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"exitCode": 0, "stdout": strings.Repeat("ä", 60_000), "files": []any{}})
	})
	defer closeRunner()
	result, err := app.runCodeForChat(t.Context(), uuid.New(), uuid.New(), map[string]any{"code": "print()"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		CodeRun codeRunResult `json:"codeRun"`
	}
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.CodeRun.Truncated || len([]rune(decoded.CodeRun.Stdout)) > maxCodeRunnerModelOutputRunes+40 {
		t.Fatalf("stdout was not shortened: %d runes, truncated=%v", len([]rune(decoded.CodeRun.Stdout)), decoded.CodeRun.Truncated)
	}
}

func TestTrustedCodeRunnerMimeRejectsDisguisedFiles(t *testing.T) {
	for name, tc := range map[string]struct {
		claimed string
		data    []byte
		want    string
	}{
		"real png":          {"image/png", append(append([]byte{}, pngHeader...), 0), "image/png"},
		"html as png":       {"image/png", []byte("<script>alert(1)</script>"), "application/octet-stream"},
		"html claimed":      {"text/html", []byte("<h1>x</h1>"), "application/octet-stream"},
		"svg claimed":       {"image/svg+xml", []byte("<svg onload=alert(1)>"), "application/octet-stream"},
		"javascript":        {"application/javascript", []byte("alert(1)"), "application/octet-stream"},
		"csv text":          {"text/csv", []byte("a,b\n1,2"), "text/csv"},
		"binary as csv":     {"text/csv", []byte{0xff, 0xfe, 0x00}, "application/octet-stream"},
		"jpeg":              {"image/jpeg", []byte("\xff\xd8\xff\xe0abc"), "image/jpeg"},
		"gif":               {"image/gif", []byte("GIF89a..."), "image/gif"},
		"unknown type":      {"application/x-whatever", []byte("x"), "application/octet-stream"},
		"png without magic": {"image/png", []byte("not a png"), "application/octet-stream"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := trustedCodeRunnerMime(tc.claimed, tc.data); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
