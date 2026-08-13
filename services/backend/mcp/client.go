package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

type Server struct {
	ID                string
	EndpointURL       string
	AuthType          string
	Credential        string
	OAuthTokenURL     string
	OAuthClientID     string
	OAuthRefreshToken string
	OAuthExpiresAt    time.Time
	Allowed           map[string]bool
	AllowPrivate      bool
	TrustedReadOnly   bool
	ProtocolVersion   string
	SessionID         string
	OnTokenRefresh    func(accessToken, refreshToken string, expiresAt time.Time)
	nextRequestID     int
	oauthMu           *sync.Mutex
	requestMu         *sync.Mutex
}

type ToolAnnotations struct {
	ReadOnlyHint       bool `json:"readOnlyHint,omitempty"`
	DestructiveHint    bool `json:"destructiveHint,omitempty"`
	ReadOnlyHintSet    bool `json:"-"`
	DestructiveHintSet bool `json:"-"`
}

func (a *ToolAnnotations) UnmarshalJSON(data []byte) error {
	var value struct {
		ReadOnlyHint    *bool `json:"readOnlyHint"`
		DestructiveHint *bool `json:"destructiveHint"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	a.ReadOnlyHintSet = value.ReadOnlyHint != nil
	a.DestructiveHintSet = value.DestructiveHint != nil
	if value.ReadOnlyHint != nil {
		a.ReadOnlyHint = *value.ReadOnlyHint
	}
	if value.DestructiveHint != nil {
		a.DestructiveHint = *value.DestructiveHint
	}
	return nil
}

func (a ToolAnnotations) MarshalJSON() ([]byte, error) {
	value := map[string]bool{}
	if a.ReadOnlyHintSet {
		value["readOnlyHint"] = a.ReadOnlyHint
	}
	if a.DestructiveHintSet {
		value["destructiveHint"] = a.DestructiveHint
	}
	return json.Marshal(value)
}

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	Annotations ToolAnnotations `json:"annotations,omitempty"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

const currentProtocolVersion = "2026-07-28"
const maxRequestBytes = 16 * 1024 * 1024
const maxResponseBytes = 16 * 1024 * 1024

const (
	connectionIdleTimeout = 10 * time.Minute
	connectionConcurrency = 8
)

type connectionEntry struct {
	mu         sync.Mutex
	session    *sdkmcp.ClientSession
	client     *sdkmcp.Client
	endpoint   string
	credential string
	transport  string
	lastUsed   time.Time
	semaphore  chan struct{}
}

type connectionRegistry struct {
	mu      sync.Mutex
	entries map[string]*connectionEntry
}

var connections = connectionRegistry{entries: map[string]*connectionEntry{}}

// Servers are commonly copied while loading request-scoped configuration. A
// pointer mutex avoids copying a lock with those values; the fallback keeps
// zero-value Server literals safe until a caller provides a per-instance lock.
var oauthFallbackMu sync.Mutex
var requestFallbackMu sync.Mutex

func (s *Server) oauthMutex() *sync.Mutex {
	if s.oauthMu != nil {
		return s.oauthMu
	}
	return &oauthFallbackMu
}

func (s *Server) requestMutex() *sync.Mutex {
	if s.requestMu != nil {
		return s.requestMu
	}
	return &requestFallbackMu
}

func (r *connectionRegistry) entry(key string) *connectionEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for existingKey, entry := range r.entries {
		entry.mu.Lock()
		idle := entry.session != nil && now.Sub(entry.lastUsed) > connectionIdleTimeout
		if idle {
			_ = entry.session.Close()
			entry.session = nil
			entry.client = nil
		}
		entry.mu.Unlock()
		if idle && existingKey != key {
			delete(r.entries, existingKey)
		}
	}
	if existing := r.entries[key]; existing != nil {
		return existing
	}
	created := &connectionEntry{semaphore: make(chan struct{}, connectionConcurrency)}
	r.entries[key] = created
	return created
}

func (r *connectionRegistry) invalidate(key string, session *sdkmcp.ClientSession) {
	r.mu.Lock()
	entry := r.entries[key]
	r.mu.Unlock()
	if entry == nil {
		return
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if session == nil || entry.session == session {
		if entry.session != nil {
			_ = entry.session.Close()
		}
		entry.session = nil
		entry.client = nil
	}
}

// Invalidate closes a cached MCP connection. It is called after a server's
// endpoint or credentials change so the next operation performs a fresh
// protocol negotiation.
func Invalidate(serverID string) {
	if strings.TrimSpace(serverID) == "" {
		return
	}
	connections.invalidate(serverID, nil)
}

func (s Server) connectionKey() string {
	if strings.TrimSpace(s.ID) != "" {
		return s.ID
	}
	return s.EndpointURL
}

func (s *Server) sdkSession(ctx context.Context) (*sdkmcp.ClientSession, *connectionEntry, error) {
	return s.sdkSessionWithTransport(ctx, false)
}

func (s *Server) sdkSessionWithTransport(ctx context.Context, legacySSE bool) (*sdkmcp.ClientSession, *connectionEntry, error) {
	if err := s.ValidateURL(s.AllowPrivate); err != nil {
		return nil, nil, err
	}
	if err := s.ensureOAuthToken(ctx); err != nil {
		return nil, nil, err
	}
	key := s.connectionKey()
	entry := connections.entry(key)
	entry.mu.Lock()
	defer entry.mu.Unlock()
	transportKind := "streamable-http"
	if legacySSE {
		transportKind = "legacy-sse"
	}
	if entry.session != nil && entry.endpoint == s.EndpointURL && entry.credential == s.Credential && entry.transport == transportKind {
		entry.lastUsed = time.Now()
		return entry.session, entry, nil
	}
	if entry.session != nil {
		_ = entry.session.Close()
		entry.session = nil
		entry.client = nil
	}
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "JustAI", Version: "0.1.0"}, nil)
	var transport sdkmcp.Transport
	if legacySSE {
		transport = &sdkmcp.SSEClientTransport{Endpoint: s.EndpointURL, HTTPClient: s.httpClient()}
	} else {
		transport = &sdkmcp.StreamableClientTransport{Endpoint: s.EndpointURL, HTTPClient: s.httpClient(), MaxRetries: 1, DisableStandaloneSSE: true}
	}
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, nil, err
	}
	entry.client = client
	entry.session = session
	entry.endpoint = s.EndpointURL
	entry.credential = s.Credential
	entry.transport = transportKind
	entry.lastUsed = time.Now()
	if initialized := session.InitializeResult(); initialized != nil {
		s.ProtocolVersion = initialized.ProtocolVersion
	}
	return session, entry, nil
}

func (e *connectionEntry) acquire(ctx context.Context) error {
	select {
	case e.semaphore <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *connectionEntry) release() {
	select {
	case <-e.semaphore:
	default:
	}
}

func (s *Server) sdkListTools(ctx context.Context) ([]Tool, error) {
	for attempt := 0; attempt < 2; attempt++ {
		session, entry, err := s.sdkSession(ctx)
		if err != nil {
			return nil, err
		}
		if err := entry.acquire(ctx); err != nil {
			return nil, err
		}
		var allTools []Tool
		for tool, iterErr := range session.Tools(ctx, nil) {
			if iterErr != nil {
				entry.release()
				if attempt == 0 {
					connections.invalidate(s.connectionKey(), session)
					continue
				}
				return nil, iterErr
			}
			if tool != nil {
				allTools = append(allTools, sdkTool(tool))
			}
		}
		entry.release()
		return filterTools(s.Allowed, allTools), nil
	}
	return nil, fmt.Errorf("MCP tool discovery failed after reconnect")
}

func (s *Server) sdkListToolsLegacy(ctx context.Context) ([]Tool, error) {
	session, entry, err := s.sdkSessionWithTransport(ctx, true)
	if err != nil {
		return nil, err
	}
	if err := entry.acquire(ctx); err != nil {
		return nil, err
	}
	var allTools []Tool
	for tool, iterErr := range session.Tools(ctx, nil) {
		if iterErr != nil {
			entry.release()
			connections.invalidate(s.connectionKey(), session)
			return nil, iterErr
		}
		if tool != nil {
			allTools = append(allTools, sdkTool(tool))
		}
	}
	entry.release()
	return filterTools(s.Allowed, allTools), nil
}

func (s *Server) sdkCallTool(ctx context.Context, name string, arguments map[string]any) (json.RawMessage, error) {
	for attempt := 0; attempt < 2; attempt++ {
		session, entry, err := s.sdkSession(ctx)
		if err != nil {
			return nil, err
		}
		if err := entry.acquire(ctx); err != nil {
			return nil, err
		}
		result, callErr := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: arguments})
		entry.release()
		if callErr != nil {
			if attempt == 0 {
				connections.invalidate(s.connectionKey(), session)
				continue
			}
			return nil, callErr
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		return encoded, nil
	}
	return nil, fmt.Errorf("MCP tool call failed after reconnect")
}

func (s *Server) sdkCallToolLegacy(ctx context.Context, name string, arguments map[string]any) (json.RawMessage, error) {
	session, entry, err := s.sdkSessionWithTransport(ctx, true)
	if err != nil {
		return nil, err
	}
	if err := entry.acquire(ctx); err != nil {
		return nil, err
	}
	result, callErr := session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: arguments})
	entry.release()
	if callErr != nil {
		connections.invalidate(s.connectionKey(), session)
		return nil, callErr
	}
	return json.Marshal(result)
}

func sdkTool(tool *sdkmcp.Tool) Tool {
	result := Tool{Name: tool.Name, Description: tool.Description}
	if tool.InputSchema != nil {
		if encoded, err := json.Marshal(tool.InputSchema); err == nil && string(encoded) != "null" {
			result.InputSchema = encoded
		}
	}
	if tool.Annotations != nil {
		result.Annotations.ReadOnlyHint = tool.Annotations.ReadOnlyHint
		result.Annotations.ReadOnlyHintSet = true
		if tool.Annotations.DestructiveHint != nil {
			result.Annotations.DestructiveHint = *tool.Annotations.DestructiveHint
			result.Annotations.DestructiveHintSet = true
		}
	}
	return result
}

func filterTools(allowed map[string]bool, tools []Tool) []Tool {
	if len(allowed) == 0 {
		return tools
	}
	filtered := make([]Tool, 0, len(tools))
	for _, tool := range tools {
		if allowed[tool.Name] {
			filtered = append(filtered, tool)
		}
	}
	return filtered
}

func (s Server) ValidateURL(allowPrivate bool) error {
	parsed, err := url.Parse(s.EndpointURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return fmt.Errorf("MCP endpoint must use http or https")
	}
	if allowPrivate || s.AllowPrivate {
		return nil
	}
	return validateHost(parsed.Hostname())
}

// OAuthMetadata is the small subset of RFC 8414 / protected-resource
// metadata needed to start an MCP OAuth flow. Manual URLs remain supported,
// but metadata discovery keeps the normal setup path safe and interoperable.
type OAuthMetadata struct {
	AuthorizationEndpoint string
	TokenEndpoint         string
	Scopes                []string
	Resource              string
}

func DiscoverOAuthMetadata(ctx context.Context, endpoint string, allowPrivate bool) (OAuthMetadata, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return OAuthMetadata{}, err
	}
	base := &Server{EndpointURL: endpoint, AllowPrivate: allowPrivate}
	if err := base.ValidateURL(allowPrivate); err != nil {
		return OAuthMetadata{}, err
	}
	client := base.httpClient()
	protected := struct {
		AuthorizationServers []string `json:"authorization_servers"`
		ScopesSupported      []string `json:"scopes_supported"`
		Resource             string   `json:"resource"`
	}{}
	protectedURL := *parsed
	protectedURL.Path = "/.well-known/oauth-protected-resource"
	protectedURL.RawQuery = ""
	_ = fetchMetadata(ctx, client, protectedURL.String(), &protected)

	authorizationServers := append([]string(nil), protected.AuthorizationServers...)
	if len(authorizationServers) == 0 {
		origin := *parsed
		origin.Path = ""
		origin.RawQuery = ""
		origin.Fragment = ""
		authorizationServers = []string{strings.TrimRight(origin.String(), "/")}
	}
	for _, issuer := range authorizationServers {
		issuerURL, parseErr := url.Parse(issuer)
		if parseErr != nil || issuerURL.Hostname() == "" || (issuerURL.Scheme != "http" && issuerURL.Scheme != "https") {
			continue
		}
		if err := (Server{EndpointURL: issuerURL.String(), AllowPrivate: allowPrivate}).ValidateURL(allowPrivate); err != nil {
			continue
		}
		for _, wellKnown := range []string{"oauth-authorization-server", "openid-configuration"} {
			metadataURL := *issuerURL
			metadataURL.Path = strings.TrimRight(issuerURL.Path, "/") + "/.well-known/" + wellKnown
			metadataURL.RawQuery = ""
			var authorization struct {
				AuthorizationEndpoint string   `json:"authorization_endpoint"`
				TokenEndpoint         string   `json:"token_endpoint"`
				ScopesSupported       []string `json:"scopes_supported"`
			}
			if fetchMetadata(ctx, client, metadataURL.String(), &authorization) != nil {
				continue
			}
			result := OAuthMetadata{AuthorizationEndpoint: authorization.AuthorizationEndpoint, TokenEndpoint: authorization.TokenEndpoint, Scopes: authorization.ScopesSupported, Resource: protected.Resource}
			if result.AuthorizationEndpoint == "" || result.TokenEndpoint == "" {
				continue
			}
			if err := (Server{EndpointURL: result.AuthorizationEndpoint, AllowPrivate: allowPrivate}).ValidateURL(allowPrivate); err != nil {
				continue
			}
			if err := (Server{EndpointURL: result.TokenEndpoint, AllowPrivate: allowPrivate}).ValidateURL(allowPrivate); err != nil {
				continue
			}
			if result.Resource == "" {
				result.Resource = endpoint
			}
			return result, nil
		}
	}
	return OAuthMetadata{}, fmt.Errorf("MCP OAuth metadata did not provide authorization and token endpoints")
}

func fetchMetadata(ctx context.Context, client *http.Client, rawURL string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("metadata endpoint returned status %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target)
}

func (s *Server) Initialize(ctx context.Context) (json.RawMessage, error) {
	result, err := s.request(ctx, "initialize", map[string]any{
		"protocolVersion": currentProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "JustAI", "version": "0.1.0"},
	})
	if err != nil {
		return nil, err
	}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if json.Unmarshal(result, &initialized) == nil && initialized.ProtocolVersion != "" {
		s.ProtocolVersion = initialized.ProtocolVersion
	}
	if err := s.notifyInitialized(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) ListTools(ctx context.Context) ([]Tool, error) {
	if err := s.ensureOAuthToken(ctx); err != nil {
		return nil, err
	}
	if tools, err := s.sdkListTools(ctx); err == nil {
		return tools, nil
	}
	if tools, err := s.sdkListToolsLegacy(ctx); err == nil {
		return tools, nil
	}
	if _, err := s.Initialize(ctx); err != nil {
		return s.listToolsLegacy(ctx)
	}
	result, err := s.request(ctx, "tools/list", map[string]any{})
	if err != nil {
		return s.listToolsLegacy(ctx)
	}
	var payload struct {
		Tools      []Tool `json:"tools"`
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, err
	}
	allTools := append([]Tool(nil), payload.Tools...)
	for payload.NextCursor != "" {
		result, err = s.request(ctx, "tools/list", map[string]any{"cursor": payload.NextCursor})
		if err != nil {
			return nil, err
		}
		payload = struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}{}
		if err := json.Unmarshal(result, &payload); err != nil {
			return nil, err
		}
		allTools = append(allTools, payload.Tools...)
	}
	return filterTools(s.Allowed, allTools), nil
}

// listToolsLegacy is the compatibility path for MCP servers that still expose
// the pre-2025 HTTP+SSE transport. The GET stream advertises a POST message
// endpoint, and JSON-RPC responses arrive back over that same stream.
func (s Server) listToolsLegacy(ctx context.Context) ([]Tool, error) {
	streamRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, s.EndpointURL, nil)
	if err != nil {
		return nil, err
	}
	streamRequest.Header.Set("Accept", "text/event-stream")
	s.setAuth(streamRequest)
	response, err := s.httpClient().Do(streamRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("legacy MCP stream failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	reader := bufio.NewReader(io.LimitReader(response.Body, maxResponseBytes))
	messageURL, err := legacyMessageURL(reader, s.EndpointURL)
	if err != nil {
		return nil, err
	}
	if err := (Server{EndpointURL: messageURL, AllowPrivate: s.AllowPrivate}).ValidateURL(s.AllowPrivate); err != nil {
		return nil, fmt.Errorf("legacy MCP message endpoint rejected: %w", err)
	}
	if _, err := legacyRPC(ctx, reader, messageURL, s, rpcRequest{JSONRPC: "2.0", ID: 1, Method: "initialize", Params: map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "JustAI", "version": "0.1.0"},
	}}); err != nil {
		return nil, err
	}
	result, err := legacyRPC(ctx, reader, messageURL, s, rpcRequest{JSONRPC: "2.0", ID: 2, Method: "tools/list", Params: map[string]any{}})
	if err != nil {
		return nil, err
	}
	var payload struct {
		Tools      []Tool `json:"tools"`
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, err
	}
	allTools := append([]Tool(nil), payload.Tools...)
	nextID := 3
	for payload.NextCursor != "" {
		result, err = legacyRPC(ctx, reader, messageURL, s, rpcRequest{JSONRPC: "2.0", ID: nextID, Method: "tools/list", Params: map[string]any{"cursor": payload.NextCursor}})
		if err != nil {
			return nil, err
		}
		payload = struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}{}
		if err := json.Unmarshal(result, &payload); err != nil {
			return nil, err
		}
		allTools = append(allTools, payload.Tools...)
		nextID++
	}
	return filterTools(s.Allowed, allTools), nil
}

func (s *Server) CallTool(ctx context.Context, name string, arguments map[string]any) (json.RawMessage, error) {
	if err := s.ensureOAuthToken(ctx); err != nil {
		return nil, err
	}
	if len(s.Allowed) > 0 && !s.Allowed[name] {
		return nil, fmt.Errorf("MCP tool is not allowlisted")
	}
	if result, err := s.sdkCallTool(ctx, name, arguments); err == nil {
		return result, nil
	}
	if result, err := s.sdkCallToolLegacy(ctx, name, arguments); err == nil {
		return result, nil
	}
	if s.SessionID == "" {
		if _, err := s.Initialize(ctx); err != nil {
			return s.callToolLegacy(ctx, name, arguments)
		}
	}
	return s.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
}

func (s *Server) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	requestMu := s.requestMutex()
	requestMu.Lock()
	defer requestMu.Unlock()
	if err := s.ensureOAuthToken(ctx); err != nil {
		return nil, err
	}
	s.nextRequestID++
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: s.nextRequestID, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.EndpointURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", firstNonEmpty(s.ProtocolVersion, currentProtocolVersion))
	if s.SessionID != "" {
		request.Header.Set("Mcp-Session-Id", s.SessionID)
	}
	s.setAuth(request)
	response, err := s.httpClient().Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("MCP request failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if sessionID := response.Header.Get("Mcp-Session-Id"); sessionID != "" {
		s.SessionID = sessionID
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/event-stream") {
		scanner := bufio.NewScanner(io.LimitReader(response.Body, maxResponseBytes))
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "data:") {
				return parseResponse([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))))
			}
		}
		return nil, scanner.Err()
	}
	return parseResponseReader(io.LimitReader(response.Body, maxResponseBytes))
}

func (s Server) callToolLegacy(ctx context.Context, name string, arguments map[string]any) (json.RawMessage, error) {
	streamRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, s.EndpointURL, nil)
	if err != nil {
		return nil, err
	}
	streamRequest.Header.Set("Accept", "text/event-stream")
	s.setAuth(streamRequest)
	response, err := s.httpClient().Do(streamRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("legacy MCP stream failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	reader := bufio.NewReader(io.LimitReader(response.Body, maxResponseBytes))
	messageURL, err := legacyMessageURL(reader, s.EndpointURL)
	if err != nil {
		return nil, err
	}
	if err := (Server{EndpointURL: messageURL, AllowPrivate: s.AllowPrivate}).ValidateURL(s.AllowPrivate); err != nil {
		return nil, fmt.Errorf("legacy MCP message endpoint rejected: %w", err)
	}
	if _, err := legacyRPC(ctx, reader, messageURL, s, rpcRequest{JSONRPC: "2.0", ID: 1, Method: "initialize", Params: map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "JustAI", "version": "0.1.0"},
	}}); err != nil {
		return nil, err
	}
	return legacyRPC(ctx, reader, messageURL, s, rpcRequest{JSONRPC: "2.0", ID: 2, Method: "tools/call", Params: map[string]any{"name": name, "arguments": arguments}})
}

func (s *Server) notifyInitialized(ctx context.Context) error {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
		"params":  map[string]any{},
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.EndpointURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", firstNonEmpty(s.ProtocolVersion, currentProtocolVersion))
	if s.SessionID != "" {
		request.Header.Set("Mcp-Session-Id", s.SessionID)
	}
	s.setAuth(request)
	response, err := s.httpClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("MCP initialized notification failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func (s Server) setAuth(request *http.Request) {
	if (s.AuthType == "api_key" || s.AuthType == "oauth") && s.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+s.Credential)
	}
}

func (s *Server) ensureOAuthToken(ctx context.Context) error {
	if s.AuthType != "oauth" || s.OAuthRefreshToken == "" || s.OAuthTokenURL == "" || (s.OAuthExpiresAt.IsZero() || time.Until(s.OAuthExpiresAt) > 30*time.Second) {
		return nil
	}
	mutex := s.oauthMutex()
	mutex.Lock()
	defer mutex.Unlock()
	if time.Until(s.OAuthExpiresAt) > 30*time.Second {
		return nil
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", s.OAuthRefreshToken)
	form.Set("client_id", s.OAuthClientID)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.OAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.httpClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return err
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("MCP OAuth refresh failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &token); err != nil || token.AccessToken == "" {
		return fmt.Errorf("MCP OAuth refresh returned no access token")
	}
	s.Credential = token.AccessToken
	if token.RefreshToken != "" {
		s.OAuthRefreshToken = token.RefreshToken
	}
	if token.ExpiresIn > 0 {
		s.OAuthExpiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
	} else {
		s.OAuthExpiresAt = time.Now().Add(5 * time.Minute)
	}
	if s.OnTokenRefresh != nil {
		s.OnTokenRefresh(s.Credential, s.OAuthRefreshToken, s.OAuthExpiresAt)
	}
	return nil
}

func (s Server) httpClient() *http.Client {
	baseTransport := &http.Transport{
		DialContext: safeDialContext(s.AllowPrivate),
	}
	return &http.Client{
		Timeout: 45 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("MCP redirect limit exceeded")
			}
			if err := (Server{EndpointURL: request.URL.String(), AllowPrivate: s.AllowPrivate}).ValidateURL(s.AllowPrivate); err != nil {
				return err
			}
			// Compare against the immediately previous hop. A redirect chain can
			// cross origins more than once; comparing only with the first URL could
			// accidentally preserve an Authorization header on a later hop.
			if len(via) > 0 && !sameOrigin(via[len(via)-1].URL, request.URL) {
				request.Header.Del("Authorization")
			}
			return nil
		},
		Transport: authTransport{base: baseTransport, endpoint: s.EndpointURL, tokenURL: s.OAuthTokenURL, authType: s.AuthType, credential: s.Credential},
	}
}

// SafeHTTPClient is used for OAuth metadata and token exchanges as well as
// MCP requests. It applies the same timeout, redirect, and connection-time
// DNS validation as the MCP transport without forwarding MCP credentials.
func SafeHTTPClient(rawURL string, allowPrivate bool) (*http.Client, error) {
	server := Server{EndpointURL: rawURL, AllowPrivate: allowPrivate}
	if err := server.ValidateURL(allowPrivate); err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout: 45 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("OAuth redirect limit exceeded")
			}
			return (Server{EndpointURL: request.URL.String(), AllowPrivate: allowPrivate}).ValidateURL(allowPrivate)
		},
		Transport: &http.Transport{DialContext: safeDialContext(allowPrivate)},
	}, nil
}

// safeDialContext repeats MCP hostname validation at connection time and
// dials the selected public address directly, preventing DNS rebinding from
// turning a previously safe endpoint into a private-network request.
func safeDialContext(allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if allowPrivate {
			return dialer.DialContext(ctx, network, address)
		}
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if parsed := net.ParseIP(host); parsed != nil {
			if privateIP(parsed) {
				return nil, fmt.Errorf("private and loopback MCP targets are blocked")
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(parsed.String(), port))
		}
		addresses, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, address := range addresses {
			if privateIP(address) {
				continue
			}
			connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("MCP hostname resolves only to private targets")
	}
}

type authTransport struct {
	base       http.RoundTripper
	endpoint   string
	tokenURL   string
	authType   string
	credential string
}

func (t authTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	clone := request.Clone(request.Context())
	if clone.ContentLength > maxRequestBytes {
		return nil, fmt.Errorf("MCP request exceeds the %d MiB limit", maxRequestBytes/(1024*1024))
	}
	if clone.Body != nil {
		clone.Body = &boundedBody{ReadCloser: clone.Body, remaining: maxRequestBytes, label: "MCP request"}
	}
	if clone.Header.Get("Authorization") == "" && t.credential != "" && (t.authType == "api_key" || t.authType == "oauth") {
		endpoint, endpointErr := url.Parse(t.endpoint)
		tokenURL, tokenErr := url.Parse(t.tokenURL)
		isTokenRequest := tokenErr == nil && tokenURL != nil && sameOrigin(clone.URL, tokenURL)
		if endpointErr == nil && endpoint != nil && sameOrigin(clone.URL, endpoint) && !isTokenRequest {
			clone.Header.Set("Authorization", "Bearer "+t.credential)
		}
	}
	response, err := base.RoundTrip(clone)
	if err != nil {
		return nil, err
	}
	if response.Body != nil {
		response.Body = &boundedBody{ReadCloser: response.Body, remaining: maxResponseBytes, label: "MCP response"}
	}
	return response, nil
}

// boundedBody applies a hard byte ceiling to SDK and compatibility transport
// bodies. It probes one byte after the limit so an exactly-at-limit response
// remains valid while an oversized response fails explicitly.
type boundedBody struct {
	io.ReadCloser
	remaining int64
	label     string
}

func (body *boundedBody) Read(target []byte) (int, error) {
	if len(target) == 0 {
		return 0, nil
	}
	if body.remaining == 0 {
		var probe [1]byte
		n, err := body.ReadCloser.Read(probe[:])
		if n > 0 {
			return 0, fmt.Errorf("%s exceeds the %d MiB limit", body.label, maxResponseBytes/(1024*1024))
		}
		return 0, err
	}
	if int64(len(target)) > body.remaining {
		target = target[:body.remaining]
	}
	n, err := body.ReadCloser.Read(target)
	body.remaining -= int64(n)
	return n, err
}

func sameOrigin(first, second *url.URL) bool {
	return strings.EqualFold(first.Scheme, second.Scheme) && strings.EqualFold(first.Host, second.Host)
}

func legacyMessageURL(reader *bufio.Reader, baseURL string) (string, error) {
	endpointEvent := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return "", err
		}
		line = strings.TrimSpace(line)
		if line == "event: endpoint" {
			endpointEvent = true
			continue
		}
		if !endpointEvent || !strings.HasPrefix(line, "data:") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		var endpoint string
		if json.Unmarshal([]byte(value), &endpoint) != nil {
			endpoint = value
		}
		parsedBase, err := url.Parse(baseURL)
		if err != nil {
			return "", err
		}
		parsedEndpoint, err := url.Parse(endpoint)
		if err != nil {
			return "", err
		}
		return parsedBase.ResolveReference(parsedEndpoint).String(), nil
	}
}

func legacyRPC(ctx context.Context, reader *bufio.Reader, messageURL string, server Server, request rpcRequest) (json.RawMessage, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	messageRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, messageURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	messageRequest.Header.Set("Content-Type", "application/json")
	messageRequest.Header.Set("Accept", "application/json, text/event-stream")
	base, _ := url.Parse(server.EndpointURL)
	messageTarget, _ := url.Parse(messageURL)
	if base != nil && messageTarget != nil && sameOrigin(base, messageTarget) {
		server.setAuth(messageRequest)
	}
	messageResponse, err := server.httpClient().Do(messageRequest)
	if err != nil {
		return nil, err
	}
	defer messageResponse.Body.Close()
	if messageResponse.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(messageResponse.Body, 4096))
		return nil, fmt.Errorf("legacy MCP message failed (%d): %s", messageResponse.StatusCode, strings.TrimSpace(string(body)))
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		result, err := parseResponse([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))))
		if err != nil {
			continue
		}
		return result, nil
	}
}

func parseResponseReader(reader io.Reader) (json.RawMessage, error) {
	var response rpcResponse
	if err := json.NewDecoder(reader).Decode(&response); err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, fmt.Errorf("MCP error %d: %s", response.Error.Code, response.Error.Message)
	}
	return response.Result, nil
}

func parseResponse(body []byte) (json.RawMessage, error) {
	var response rpcResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, fmt.Errorf("MCP error %d: %s", response.Error.Code, response.Error.Message)
	}
	return response.Result, nil
}

func validateHost(host string) error {
	ip := net.ParseIP(host)
	if ip != nil {
		if privateIP(ip) {
			return fmt.Errorf("private and loopback MCP targets are blocked")
		}
		return nil
	}
	addresses, err := net.LookupIP(host)
	if err != nil {
		return err
	}
	for _, address := range addresses {
		if privateIP(address) {
			return fmt.Errorf("MCP hostname resolves to a private target")
		}
	}
	return nil
}

func privateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsLinkLocalMulticast()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
