package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
)

const (
	codeRunnerToolName = "run_code"
	// The runner allows up to 60 s per program; leave room for queueing.
	codeRunnerRequestTimeout = 90 * time.Second
	maxCodeRunnerCodeBytes   = 100_000
	maxCodeRunnerStdinBytes  = 10_000
	// Twelve MB of files as base64 plus the text streams.
	maxCodeRunnerResponseBytes = 20 * 1024 * 1024
	// What the model (and the chat history) gets to see of each stream.
	maxCodeRunnerModelOutputRunes = 20_000
	maxCodeRunnerFiles            = 6
)

type codeRunnerResponse struct {
	ExitCode   *int   `json:"exitCode"`
	TimedOut   bool   `json:"timedOut"`
	DurationMs int    `json:"durationMs"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Truncated  bool   `json:"truncated"`
	Files      []struct {
		Name string `json:"name"`
		Mime string `json:"mime"`
		Data string `json:"data"`
	} `json:"files"`
}

// codeRunResult is what the model and the chat UI receive for one run_code call.
type codeRunResult struct {
	Language   string                 `json:"language"`
	ExitCode   *int                   `json:"exitCode"`
	TimedOut   bool                   `json:"timedOut"`
	DurationMs int                    `json:"durationMs"`
	Stdout     string                 `json:"stdout"`
	Stderr     string                 `json:"stderr"`
	Truncated  bool                   `json:"truncated"`
	Files      []models.GeneratedFile `json:"files"`
}

// codeRunnerClient is shared by all requests. It never follows redirects: the
// runner URL is operator configuration and must be talked to directly.
var codeRunnerClient = &http.Client{
	Timeout: codeRunnerRequestTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// codeRunnerEnabled reports whether the isolated runner service is configured.
// Without it the run_code tool is simply not offered.
func (a *App) codeRunnerEnabled() bool {
	return strings.TrimSpace(a.Config.CodeRunner.URL) != ""
}

func codeRunnerToolDefinition() provider.ToolDefinition {
	return provider.ToolDefinition{
		Name: codeRunnerToolName,
		Description: "Run a short Python 3 program in an isolated sandbox and get its output. " +
			"Use it instead of guessing whenever a result depends on calculation or data: arithmetic, statistics, " +
			"parsing or transforming text and tables, date maths, simulations, and charts. pandas, numpy and matplotlib " +
			"are installed. The sandbox has no internet access and cannot see the user's files, so put all data the " +
			"program needs into the code. Print every result you need: you receive stdout, stderr and the exit code. " +
			"Open matplotlib figures are saved and shown to the user automatically; files the program writes to its " +
			"working directory (for example a CSV) become downloads. Programs cannot wait for keyboard input unless you " +
			"provide it in stdin. If the run fails, read the error, fix the code and run it again. Base your answer on " +
			"the actual output and never claim a result you did not get. Do not repeat file URLs; JustAI shows files itself.",
		Parameters: json.RawMessage(`{"type":"object","properties":{"language":{"type":"string","enum":["python"],"description":"The programming language. Only python is available."},"code":{"type":"string","description":"The complete, self-contained program.","minLength":1,"maxLength":100000},"stdin":{"type":"string","description":"Optional text for input() calls, one line per call.","maxLength":10000},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":60,"description":"Optional time limit; the default is 20 seconds."}},"required":["code"],"additionalProperties":false}`),
	}
}

// builtInToolDiscovery returns JustAI's built-in tools plus the ones that
// depend on this deployment's configuration.
func (a *App) builtInToolDiscovery() voiceToolDiscovery {
	discovery := assistantBuiltInToolDiscovery()
	if !a.codeRunnerEnabled() {
		return discovery
	}
	definition := codeRunnerToolDefinition()
	discovery.Definitions = append(discovery.Definitions, definition)
	discovery.Bindings[definition.Name] = voiceToolBinding{
		ToolName:   definition.Name,
		Builtin:    true,
		Definition: definition,
	}
	return discovery
}

func clipRunes(value string, limit int) (string, bool) {
	if utf8.RuneCountInString(value) <= limit {
		return value, false
	}
	runes := []rune(value)
	return string(runes[:limit]) + "\n… (output shortened)", true
}

// runCodeForChat sends one program to the isolated runner and stores what it
// produced. The runner is untrusted for file contents: types are re-checked.
func (a *App) runCodeForChat(ctx context.Context, userID, organizationID uuid.UUID, arguments map[string]any) (json.RawMessage, error) {
	if !a.codeRunnerEnabled() {
		return nil, fmt.Errorf("code execution is not available on this server")
	}
	language := strings.ToLower(strings.TrimSpace(stringToolArgument(arguments, "language")))
	if language == "" {
		language = "python"
	}
	if language != "python" {
		return nil, fmt.Errorf("only python programs can be run")
	}
	code := stringToolArgument(arguments, "code")
	if strings.TrimSpace(code) == "" {
		return nil, fmt.Errorf("code is required")
	}
	if len(code) > maxCodeRunnerCodeBytes {
		return nil, fmt.Errorf("code must not exceed %d bytes", maxCodeRunnerCodeBytes)
	}
	stdin := stringToolArgument(arguments, "stdin")
	if len(stdin) > maxCodeRunnerStdinBytes {
		return nil, fmt.Errorf("stdin must not exceed %d bytes", maxCodeRunnerStdinBytes)
	}
	timeout := intToolArgument(arguments, "timeoutSeconds", 20)
	if timeout < 1 || timeout > 60 {
		timeout = 20
	}

	response, err := a.callCodeRunner(ctx, map[string]any{
		"language":       language,
		"code":           code,
		"stdin":          stdin,
		"timeoutSeconds": timeout,
	})
	if err != nil {
		return nil, err
	}

	stdout, stdoutClipped := clipRunes(response.Stdout, maxCodeRunnerModelOutputRunes)
	stderr, stderrClipped := clipRunes(response.Stderr, maxCodeRunnerModelOutputRunes)
	result := codeRunResult{
		Language:   language,
		ExitCode:   response.ExitCode,
		TimedOut:   response.TimedOut,
		DurationMs: response.DurationMs,
		Stdout:     stdout,
		Stderr:     stderr,
		Truncated:  response.Truncated || stdoutClipped || stderrClipped,
		Files:      []models.GeneratedFile{},
	}
	for _, file := range response.Files {
		if len(result.Files) >= maxCodeRunnerFiles {
			break
		}
		data, err := base64.StdEncoding.DecodeString(file.Data)
		if err != nil || len(data) == 0 {
			continue
		}
		mimeType := trustedCodeRunnerMime(file.Mime, data)
		item, err := a.storeGeneratedChatFile(ctx, userID, organizationID, file.Name, file.Name, mimeType, data)
		if err != nil {
			// A file that cannot be stored must not hide the program's output.
			continue
		}
		result.Files = append(result.Files, item)
	}
	return json.Marshal(map[string]any{"codeRun": result})
}

func (a *App) callCodeRunner(ctx context.Context, payload map[string]any) (*codeRunnerResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.Config.CodeRunner.URL, "/")+"/v1/run", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.Config.CodeRunner.Token)

	httpResponse, err := codeRunnerClient.Do(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("the code execution service is unreachable")
	}
	defer httpResponse.Body.Close()

	switch {
	case httpResponse.StatusCode == http.StatusServiceUnavailable:
		return nil, fmt.Errorf("the code execution service is busy; try again in a moment")
	case httpResponse.StatusCode >= 400 && httpResponse.StatusCode < 500:
		return nil, fmt.Errorf("the code execution service rejected the request")
	case httpResponse.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("the code execution service failed")
	}

	data, err := io.ReadAll(io.LimitReader(httpResponse.Body, maxCodeRunnerResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("the code execution response could not be read")
	}
	if len(data) > maxCodeRunnerResponseBytes {
		return nil, fmt.Errorf("the code execution response was too large")
	}
	var parsed codeRunnerResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("the code execution response was invalid")
	}
	return &parsed, nil
}

// trustedCodeRunnerMime accepts only a short allow-list of file types and
// checks image bytes, so a compromised runner cannot smuggle active content
// into the app under a harmless-looking name.
func trustedCodeRunnerMime(claimed string, data []byte) string {
	switch claimed {
	case "image/png":
		if bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
			return claimed
		}
	case "image/jpeg":
		if bytes.HasPrefix(data, []byte("\xff\xd8\xff")) {
			return claimed
		}
	case "image/gif":
		if bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")) {
			return claimed
		}
	case "text/csv", "text/tab-separated-values", "text/plain", "text/markdown", "application/json":
		if utf8.Valid(data) {
			return claimed
		}
	}
	return "application/octet-stream"
}
