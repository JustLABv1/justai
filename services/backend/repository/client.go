// Package repository contains the deliberately small, read-only provider
// clients used by the repository context feature. It never exposes a git
// checkout to the backend and it only issues GET requests to provider APIs.
package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	ProviderGitHub     Provider = "github"
	ProviderGitLab     Provider = "gitlab"
	MaxFiles                    = 200
	MaxFileBytes                = 2 * 1024 * 1024
	MaxRepositoryBytes          = 20 * 1024 * 1024
	MaxTreeEntries              = 5000
)

type Provider string

type Spec struct {
	Provider      Provider
	RepositoryURL string
	Owner         string
	Repository    string
	ProjectPath   string
	Ref           string
}

type File struct {
	Path    string
	URL     string
	Size    int64
	SHA     string
	Content string
	Hash    string
}

type Snapshot struct {
	Spec             Spec
	ResolvedRef      string
	Files            []File
	SkippedFileCount int
	TotalBytes       int64
}

// Limits keeps repository imports bounded while allowing deployments to tune
// the number of files retained in a snapshot. The defaults are deliberately
// conservative because every accepted file is fetched and indexed.
type Limits struct {
	MaxFiles           int
	MaxFileBytes       int64
	MaxRepositoryBytes int64
	MaxTreeEntries     int
}

func DefaultLimits() Limits {
	return Limits{
		MaxFiles:           MaxFiles,
		MaxFileBytes:       MaxFileBytes,
		MaxRepositoryBytes: MaxRepositoryBytes,
		MaxTreeEntries:     MaxTreeEntries,
	}
}

type Client struct {
	HTTPClient       *http.Client
	GitHubAPIBaseURL string
	GitHubRawBaseURL string
	GitLabAPIBaseURL string
	Limits           Limits
}

func NewClient() *Client {
	return NewClientWithLimits(DefaultLimits())
}

func NewClientWithLimits(limits Limits) *Client {
	defaults := DefaultLimits()
	if limits.MaxFiles <= 0 {
		limits.MaxFiles = defaults.MaxFiles
	}
	if limits.MaxFileBytes <= 0 {
		limits.MaxFileBytes = defaults.MaxFileBytes
	}
	if limits.MaxRepositoryBytes <= 0 {
		limits.MaxRepositoryBytes = defaults.MaxRepositoryBytes
	}
	if limits.MaxTreeEntries <= 0 {
		limits.MaxTreeEntries = defaults.MaxTreeEntries
	}
	return &Client{
		HTTPClient:       &http.Client{Timeout: 45 * time.Second},
		GitHubAPIBaseURL: "https://api.github.com",
		GitHubRawBaseURL: "https://raw.githubusercontent.com",
		GitLabAPIBaseURL: "https://gitlab.com/api/v4",
		Limits:           limits,
	}
}

func ParseURL(rawURL, rawRef string) (Spec, error) {
	rawURL = strings.TrimSpace(rawURL)
	if len(rawURL) > 2048 {
		return Spec{}, fmt.Errorf("repository URL is too long")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return Spec{}, fmt.Errorf("repository URL must be an https GitHub or GitLab URL")
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	parts := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	decodedParts := make([]string, 0, len(parts))
	for _, part := range parts {
		decoded, decodeErr := url.PathUnescape(part)
		if decodeErr != nil || decoded == "" || strings.ContainsAny(decoded, "\\\x00\r\n") {
			return Spec{}, fmt.Errorf("repository URL contains an invalid path")
		}
		decodedParts = append(decodedParts, decoded)
	}
	if len(decodedParts) > 0 {
		decodedParts[len(decodedParts)-1] = strings.TrimSuffix(decodedParts[len(decodedParts)-1], ".git")
	}
	if len(decodedParts) < 2 {
		return Spec{}, fmt.Errorf("repository URL must include an owner and repository")
	}
	for _, part := range decodedParts {
		if strings.TrimSpace(part) == "" || strings.Contains(part, "..") {
			return Spec{}, fmt.Errorf("repository URL contains an invalid path")
		}
	}

	var provider Provider
	switch host {
	case "github.com":
		if len(decodedParts) != 2 {
			return Spec{}, fmt.Errorf("GitHub URLs must look like https://github.com/owner/repository")
		}
		provider = ProviderGitHub
	case "gitlab.com":
		provider = ProviderGitLab
	default:
		return Spec{}, fmt.Errorf("only github.com and gitlab.com repositories are supported")
	}

	ref := strings.TrimSpace(rawRef)
	if ref == "" {
		ref = "HEAD"
	}
	if len(ref) > 256 || strings.ContainsAny(ref, "\x00\r\n") {
		return Spec{}, fmt.Errorf("repository ref is invalid or too long")
	}
	canonicalURL := "https://" + host + "/" + strings.Join(decodedParts, "/")
	spec := Spec{
		Provider:      provider,
		RepositoryURL: canonicalURL,
		Owner:         decodedParts[0],
		Repository:    decodedParts[len(decodedParts)-1],
		ProjectPath:   strings.Join(decodedParts, "/"),
		Ref:           ref,
	}
	return spec, nil
}

func (c *Client) Fetch(ctx context.Context, spec Spec, token string) (Snapshot, error) {
	if c == nil {
		c = NewClient()
	}
	if c.HTTPClient == nil {
		c.HTTPClient = &http.Client{Timeout: 45 * time.Second}
	}
	if c.Limits.MaxFiles <= 0 || c.Limits.MaxFileBytes <= 0 || c.Limits.MaxRepositoryBytes <= 0 || c.Limits.MaxTreeEntries <= 0 {
		c.Limits = normalizedLimits(c.Limits)
	}
	switch spec.Provider {
	case ProviderGitHub:
		return c.fetchGitHub(ctx, spec, token)
	case ProviderGitLab:
		return c.fetchGitLab(ctx, spec, token)
	default:
		return Snapshot{}, fmt.Errorf("unsupported repository provider")
	}
}

func normalizedLimits(limits Limits) Limits {
	defaults := DefaultLimits()
	if limits.MaxFiles <= 0 {
		limits.MaxFiles = defaults.MaxFiles
	}
	if limits.MaxFileBytes <= 0 {
		limits.MaxFileBytes = defaults.MaxFileBytes
	}
	if limits.MaxRepositoryBytes <= 0 {
		limits.MaxRepositoryBytes = defaults.MaxRepositoryBytes
	}
	if limits.MaxTreeEntries <= 0 {
		limits.MaxTreeEntries = defaults.MaxTreeEntries
	}
	return limits
}

type treeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
	Size int64  `json:"size"`
}

type githubTreeResponse struct {
	SHA       string      `json:"sha"`
	Truncated bool        `json:"truncated"`
	Tree      []treeEntry `json:"tree"`
}

func (c *Client) fetchGitHub(ctx context.Context, spec Spec, token string) (Snapshot, error) {
	if spec.Ref == "HEAD" {
		var metadata struct {
			DefaultBranch string `json:"default_branch"`
		}
		endpoint := appendPath(c.GitHubAPIBaseURL, "repos", spec.Owner, spec.Repository)
		if err := c.getJSON(ctx, endpoint, token, "github", &metadata); err != nil {
			return Snapshot{}, err
		}
		if strings.TrimSpace(metadata.DefaultBranch) == "" {
			return Snapshot{}, fmt.Errorf("GitHub repository did not report a default branch")
		}
		spec.Ref = metadata.DefaultBranch
	}
	endpoint := appendPath(c.GitHubAPIBaseURL, "repos", spec.Owner, spec.Repository, "git", "trees", spec.Ref)
	endpoint = withQuery(endpoint, "recursive", "1")
	var response githubTreeResponse
	if err := c.getJSON(ctx, endpoint, token, "github", &response); err != nil {
		return Snapshot{}, err
	}
	if response.Truncated || len(response.Tree) > c.Limits.MaxTreeEntries {
		return Snapshot{}, fmt.Errorf("repository tree is too large; connect a smaller repository or a narrower ref")
	}
	return c.fetchFiles(ctx, spec, token, response.SHA, response.Tree)
}

type gitlabTreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (c *Client) fetchGitLab(ctx context.Context, spec Spec, token string) (Snapshot, error) {
	entries := make([]treeEntry, 0, 128)
	page := 1
	for {
		endpoint := appendPath(c.GitLabAPIBaseURL, "projects", spec.ProjectPath, "repository", "tree")
		endpoint = withQuery(endpoint, "recursive", "true")
		endpoint = withQuery(endpoint, "per_page", "100")
		endpoint = withQuery(endpoint, "page", strconv.Itoa(page))
		if spec.Ref != "HEAD" {
			endpoint = withQuery(endpoint, "ref", spec.Ref)
		}
		var pageEntries []gitlabTreeEntry
		nextPage, err := c.getJSONWithHeader(ctx, endpoint, token, "gitlab", &pageEntries, "X-Next-Page")
		if err != nil {
			return Snapshot{}, err
		}
		for _, entry := range pageEntries {
			entries = append(entries, treeEntry{Path: entry.Path, Type: entry.Type, SHA: entry.ID})
		}
		if len(entries) > c.Limits.MaxTreeEntries {
			return Snapshot{}, fmt.Errorf("repository tree is too large; connect a smaller repository or a narrower ref")
		}
		if nextPage == "" || len(pageEntries) == 0 {
			break
		}
		parsed, parseErr := strconv.Atoi(nextPage)
		if parseErr != nil || parsed <= page {
			break
		}
		page = parsed
	}
	return c.fetchFiles(ctx, spec, token, spec.Ref, entries)
}

func (c *Client) fetchFiles(ctx context.Context, spec Spec, token, resolvedRef string, entries []treeEntry) (Snapshot, error) {
	limits := c.Limits
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	snapshot := Snapshot{Spec: spec, ResolvedRef: resolvedRef, Files: make([]File, 0, min(limits.MaxFiles, len(entries)))}
	seenPaths := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if _, seen := seenPaths[entry.Path]; seen {
			snapshot.SkippedFileCount++
			continue
		}
		seenPaths[entry.Path] = struct{}{}
		if entry.Type != "blob" || !isTextCandidate(entry.Path) || entry.Size > limits.MaxFileBytes {
			snapshot.SkippedFileCount++
			continue
		}
		if len(snapshot.Files) >= limits.MaxFiles {
			snapshot.SkippedFileCount++
			continue
		}
		file, err := c.fetchFile(ctx, spec, token, entry)
		if err != nil {
			return Snapshot{}, fmt.Errorf("read %s: %w", entry.Path, err)
		}
		if snapshot.TotalBytes+int64(len(file.Content)) > limits.MaxRepositoryBytes {
			snapshot.SkippedFileCount++
			continue
		}
		snapshot.TotalBytes += int64(len(file.Content))
		snapshot.Files = append(snapshot.Files, file)
	}
	if len(snapshot.Files) == 0 {
		return Snapshot{}, fmt.Errorf("repository contains no supported text files")
	}
	return snapshot, nil
}

func (c *Client) fetchFile(ctx context.Context, spec Spec, token string, entry treeEntry) (File, error) {
	var endpoint string
	switch spec.Provider {
	case ProviderGitHub:
		endpoint = appendPath(c.GitHubRawBaseURL, spec.Owner, spec.Repository, spec.Ref)
		endpoint = appendPath(endpoint, strings.Split(entry.Path, "/")...)
	case ProviderGitLab:
		endpoint = appendPath(c.GitLabAPIBaseURL, "projects", spec.ProjectPath, "repository", "files", entry.Path, "raw")
		if spec.Ref != "HEAD" {
			endpoint = withQuery(endpoint, "ref", spec.Ref)
		}
	default:
		return File{}, fmt.Errorf("unsupported repository provider")
	}
	content, err := c.getBody(ctx, endpoint, token, string(spec.Provider), c.Limits.MaxFileBytes)
	if err != nil {
		return File{}, err
	}
	if !utf8.Valid(content) || strings.IndexByte(string(content), 0) >= 0 {
		return File{}, fmt.Errorf("file is not valid UTF-8 text")
	}
	digest := sha256.Sum256(content)
	return File{
		Path:    entry.Path,
		URL:     fileWebURL(spec, entry.Path),
		Size:    int64(len(content)),
		SHA:     entry.SHA,
		Content: string(content),
		Hash:    hex.EncodeToString(digest[:]),
	}, nil
}

func (c *Client) getJSON(ctx context.Context, endpoint, token, provider string, target any) error {
	_, err := c.getJSONWithHeader(ctx, endpoint, token, provider, target, "")
	return err
}

func (c *Client) getJSONWithHeader(ctx context.Context, endpoint, token, provider string, target any, responseHeader string) (string, error) {
	request, err := c.newRequest(ctx, http.MethodGet, endpoint, token, provider)
	if err != nil {
		return "", err
	}
	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", providerError(response)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(target); err != nil {
		return "", fmt.Errorf("decode provider response: %w", err)
	}
	if responseHeader == "" {
		return "", nil
	}
	return strings.TrimSpace(response.Header.Get(responseHeader)), nil
}

func (c *Client) getBody(ctx context.Context, endpoint, token, provider string, maxBytes int64) ([]byte, error) {
	request, err := c.newRequest(ctx, http.MethodGet, endpoint, token, provider)
	if err != nil {
		return nil, err
	}
	if provider == string(ProviderGitHub) {
		request.Header.Set("Accept", "application/vnd.github.raw+json")
	}
	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, providerError(response)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("file exceeds the %d MB limit", maxBytes/(1024*1024))
	}
	return body, nil
}

func (c *Client) newRequest(ctx context.Context, method, endpoint, token, provider string) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "JustAI/0.1 read-only-repository-connector")
	if provider == string(ProviderGitHub) {
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
	} else if token != "" {
		request.Header.Set("PRIVATE-TOKEN", token)
	}
	return request, nil
}

func providerError(response *http.Response) error {
	return fmt.Errorf("repository provider returned %s", response.Status)
}

func appendPath(rawBase string, segments ...string) string {
	parsed, err := url.Parse(strings.TrimRight(rawBase, "/"))
	if err != nil {
		return ""
	}
	rawPath := strings.TrimRight(parsed.EscapedPath(), "/")
	for _, segment := range segments {
		rawPath += "/" + url.PathEscape(segment)
	}
	parsed.RawPath = rawPath
	parsed.Path, _ = url.PathUnescape(rawPath)
	return parsed.String()
}

func withQuery(rawURL, key, value string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func fileWebURL(spec Spec, path string) string {
	if spec.Provider == ProviderGitHub {
		endpoint := appendPath(spec.RepositoryURL, "blob", spec.Ref)
		return appendPath(endpoint, strings.Split(path, "/")...)
	}
	endpoint := appendPath(spec.RepositoryURL, "-", "blob", spec.Ref)
	return appendPath(endpoint, strings.Split(path, "/")...)
}

func isTextCandidate(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00\r\n") {
		return false
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	lower := strings.ToLower(path)
	for _, directory := range []string{".git/", "node_modules/", "vendor/", "dist/", "build/", ".next/", "coverage/"} {
		if strings.Contains(lower, directory) {
			return false
		}
	}
	base := strings.ToLower(parts[len(parts)-1])
	for _, sensitive := range []string{".env", ".pem", ".key", ".p12", ".pfx", "id_rsa", "credentials", "secret"} {
		if base == sensitive || strings.HasSuffix(base, sensitive) || strings.Contains(base, sensitive+".") {
			return false
		}
	}
	if strings.HasPrefix(base, ".") && !isKnownDotfile(base) {
		return false
	}
	if strings.Contains(base, ".map") {
		return false
	}
	if extension := fileExtension(base); extension != "" {
		_, ok := textExtensions[extension]
		return ok
	}
	_, ok := textFilenames[base]
	return ok
}

func fileExtension(name string) string {
	index := strings.LastIndexByte(name, '.')
	if index <= 0 || index == len(name)-1 {
		return ""
	}
	return name[index:]
}

func isKnownDotfile(name string) bool {
	_, ok := textFilenames[name]
	return ok
}

var textExtensions = map[string]struct{}{
	".c": {}, ".cc": {}, ".clj": {}, ".cpp": {}, ".cs": {}, ".css": {}, ".dart": {},
	".el": {}, ".elm": {}, ".ex": {}, ".exs": {}, ".fs": {}, ".fsx": {}, ".go": {},
	".graphql": {}, ".h": {}, ".hpp": {}, ".hcl": {}, ".html": {}, ".ini": {},
	".java": {}, ".js": {}, ".jsx": {}, ".json": {}, ".kt": {}, ".kts": {},
	".less": {}, ".lua": {}, ".md": {}, ".mdx": {}, ".php": {}, ".pl": {},
	".proto": {}, ".py": {}, ".r": {}, ".rb": {}, ".rs": {}, ".scss": {},
	".scala": {}, ".sh": {}, ".sql": {}, ".svelte": {}, ".swift": {},
	".tf": {}, ".toml": {}, ".ts": {}, ".tsx": {}, ".txt": {}, ".vue": {},
	".xml": {}, ".yaml": {}, ".yml": {},
}

var textFilenames = map[string]struct{}{
	".dockerignore": {}, ".editorconfig": {}, ".gitattributes": {}, ".gitignore": {},
	"dockerfile": {}, "license": {}, "makefile": {}, "readme": {}, "readme.md": {},
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
