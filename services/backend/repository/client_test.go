package repository

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseURL(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		ref      string
		provider Provider
		owner    string
		project  string
	}{
		{name: "github", url: "https://github.com/acme/demo.git", provider: ProviderGitHub, owner: "acme", project: "acme/demo"},
		{name: "gitlab subgroup", url: "https://gitlab.com/acme/platform/demo", ref: "release/v2", provider: ProviderGitLab, owner: "acme", project: "acme/platform/demo"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spec, err := ParseURL(test.url, test.ref)
			if err != nil {
				t.Fatal(err)
			}
			if spec.Provider != test.provider || spec.Owner != test.owner || spec.ProjectPath != test.project {
				t.Fatalf("unexpected spec: %+v", spec)
			}
			if test.ref == "" && spec.Ref != "HEAD" {
				t.Fatalf("expected HEAD ref, got %q", spec.Ref)
			}
		})
	}

	for _, rawURL := range []string{
		"http://github.com/acme/demo",
		"https://example.com/acme/demo",
		"https://github.com/acme/demo?token=secret",
		"https://github.com/acme",
	} {
		if _, err := ParseURL(rawURL, ""); err == nil {
			t.Fatalf("expected %q to be rejected", rawURL)
		}
	}
}

func TestFetchGitHubIsReadOnlyAndLoadsTextFiles(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("unexpected method %s", request.Method)
		}
		if request.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("token was not sent as a bearer token")
		}
		switch request.URL.Path {
		case "/repos/acme/demo/git/trees/main":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"sha":"tree-sha","truncated":false,"tree":[{"path":"README.md","type":"blob","sha":"file-sha","size":12},{"path":"README.md","type":"blob","sha":"duplicate-sha","size":12},{"path":"image.png","type":"blob","size":3}]}`))
		case "/acme/demo/main/README.md":
			_, _ = writer.Write([]byte("hello repo\n"))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	client := NewClient()
	client.HTTPClient = server.Client()
	client.GitHubAPIBaseURL = server.URL
	client.GitHubRawBaseURL = server.URL
	spec, err := ParseURL("https://github.com/acme/demo", "main")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.Fetch(context.Background(), spec, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ResolvedRef != "tree-sha" || len(snapshot.Files) != 1 || snapshot.SkippedFileCount != 2 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	if snapshot.Files[0].Path != "README.md" || !strings.Contains(snapshot.Files[0].Content, "hello repo") {
		t.Fatalf("unexpected file: %+v", snapshot.Files[0])
	}
}

func TestTextCandidateFilterSkipsGeneratedAndSensitiveFiles(t *testing.T) {
	for _, path := range []string{"cmd/main.go", "README.md", "Dockerfile", ".gitignore"} {
		if !isTextCandidate(path) {
			t.Errorf("expected %s to be accepted", path)
		}
	}
	for _, path := range []string{".env", "config/server.pem", "node_modules/pkg/index.js", "dist/app.js", "image.png", "../escape.go"} {
		if isTextCandidate(path) {
			t.Errorf("expected %s to be skipped", path)
		}
	}
}
