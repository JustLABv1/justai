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
	"time"
)

type Server struct {
	EndpointURL string
	AuthType    string
	Credential  string
	Allowed     map[string]bool
}

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
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

func (s Server) ValidateURL(allowPrivate bool) error {
	parsed, err := url.Parse(s.EndpointURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return fmt.Errorf("MCP endpoint must use http or https")
	}
	if allowPrivate {
		return nil
	}
	return validateHost(parsed.Hostname())
}

func (s Server) Initialize(ctx context.Context) (json.RawMessage, error) {
	return s.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "JustAI", "version": "0.1.0"},
	})
}

func (s Server) ListTools(ctx context.Context) ([]Tool, error) {
	if _, err := s.Initialize(ctx); err != nil {
		return s.listToolsLegacy(ctx)
	}
	result, err := s.request(ctx, "tools/list", map[string]any{})
	if err != nil {
		return s.listToolsLegacy(ctx)
	}
	var payload struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, err
	}
	if len(s.Allowed) == 0 {
		return payload.Tools, nil
	}
	filtered := make([]Tool, 0, len(payload.Tools))
	for _, tool := range payload.Tools {
		if s.Allowed[tool.Name] {
			filtered = append(filtered, tool)
		}
	}
	return filtered, nil
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
	response, err := (&http.Client{Timeout: 45 * time.Second}).Do(streamRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("legacy MCP stream failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	reader := bufio.NewReader(response.Body)
	messageURL, err := legacyMessageURL(reader, s.EndpointURL)
	if err != nil {
		return nil, err
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
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, err
	}
	if len(s.Allowed) == 0 {
		return payload.Tools, nil
	}
	filtered := make([]Tool, 0, len(payload.Tools))
	for _, tool := range payload.Tools {
		if s.Allowed[tool.Name] {
			filtered = append(filtered, tool)
		}
	}
	return filtered, nil
}

func (s Server) CallTool(ctx context.Context, name string, arguments map[string]any) (json.RawMessage, error) {
	if len(s.Allowed) > 0 && !s.Allowed[name] {
		return nil, fmt.Errorf("MCP tool is not allowlisted")
	}
	return s.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
}

func (s Server) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.EndpointURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2025-06-18")
	s.setAuth(request)
	client := &http.Client{Timeout: 45 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("MCP request failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/event-stream") {
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "data:") {
				return parseResponse([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))))
			}
		}
		return nil, scanner.Err()
	}
	return parseResponseReader(response.Body)
}

func (s Server) setAuth(request *http.Request) {
	if (s.AuthType == "api_key" || s.AuthType == "oauth") && s.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+s.Credential)
	}
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
	server.setAuth(messageRequest)
	messageResponse, err := (&http.Client{Timeout: 45 * time.Second}).Do(messageRequest)
	if err != nil {
		return nil, err
	}
	messageResponse.Body.Close()
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
