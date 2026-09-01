package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"justai-backend/provider"
)

const (
	maxA2AAgentCardBytes = 2 * 1024 * 1024
	maxA2AResponseBytes  = 16 * 1024 * 1024
	maxA2AArtifactBytes  = 8 * 1024 * 1024
	a2aTransportLegacy   = "legacy-jsonrpc"
	a2aTransportJSONRPC  = "jsonrpc"
	a2aTransportHTTPJSON = "http-json"
)

func validateA2AEndpointURL(rawURL string, allowPrivate bool) error {
	return provider.ValidateEndpointURL(rawURL, allowPrivate)
}

func safeAgentHTTPClient(rawURL string, allowPrivate bool, timeout time.Duration) (*http.Client, error) {
	if err := provider.ValidateEndpointURL(rawURL, allowPrivate); err != nil {
		return nil, err
	}
	return provider.SafeHTTPClientForOrigin(timeout, allowPrivate, rawURL), nil
}

type a2aAgentCard struct {
	Name                string
	Description         string
	URL                 string
	Version             string
	Capabilities        json.RawMessage
	Skills              json.RawMessage
	SupportedInterfaces json.RawMessage
	SecuritySchemes     json.RawMessage
}

type agentConnectionSecret struct {
	APIKey       string `json:"apiKey,omitempty"`
	Username     string `json:"username,omitempty"`
	Password     string `json:"password,omitempty"`
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
}

type remoteAgentConnection struct {
	ID                   uuid.UUID
	EndpointURL          string
	AuthType             string
	EncryptedCredential  []byte
	EncryptedRefresh     []byte
	EncryptedCertificate []byte
	EncryptedPrivateKey  []byte
	OAuthTokenURL        string
	OAuthClientID        string
	OAuthScopes          string
	Enabled              bool
	TrustedReadOnly      bool
	AgentCard            json.RawMessage
}

type a2aExecutionResult struct {
	Summary          string
	TaskID           string
	Artifacts        []a2aArtifact
	ResponseMetadata map[string]any
	Transport        string
	Endpoint         string
	Tenant           string
}

type a2aArtifact struct {
	Name     string
	Kind     string
	MimeType string
	Content  []byte
	Metadata map[string]any
}

// discoverA2AAgentCard tries the configured URL first, then the well-known
// locations used by A2A deployments. Only a bounded, sanitized subset is
// stored; raw connection credentials never enter the card or error payload.
func discoverA2AAgentCard(ctx context.Context, endpoint string, allowPrivate bool) (json.RawMessage, a2aAgentCard, error) {
	return discoverA2AAgentCardWithClient(ctx, endpoint, allowPrivate, nil, nil)
}

// discoverA2AAgentCardWithClient keeps discovery usable for protected Agent
// Cards. A connection's auth is applied to the initial origin and the safe
// HTTP client's redirect policy removes credentials before crossing origins.
func discoverA2AAgentCardWithClient(ctx context.Context, endpoint string, allowPrivate bool, client *http.Client, decorate func(*http.Request)) (json.RawMessage, a2aAgentCard, error) {
	endpoint = strings.TrimSpace(endpoint)
	if err := provider.ValidateEndpointURL(endpoint, allowPrivate); err != nil {
		return nil, a2aAgentCard{}, err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, a2aAgentCard{}, err
	}
	candidates := []string{parsed.String()}
	origin := *parsed
	origin.RawQuery = ""
	origin.Fragment = ""
	origin.Path = "/.well-known/agent-card.json"
	candidates = append(candidates, origin.String())
	base := *parsed
	base.RawQuery = ""
	base.Fragment = ""
	base.Path = strings.TrimRight(base.Path, "/") + "/.well-known/agent-card.json"
	candidates = append(candidates, base.String())
	base.Path = strings.TrimRight(parsed.Path, "/") + "/.well-known/agent.json"
	candidates = append(candidates, base.String())
	var lastErr error
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		card, raw, fetchErr := fetchA2AJSONWithClient(ctx, candidate, allowPrivate, maxA2AAgentCardBytes, client, decorate)
		if fetchErr != nil {
			lastErr = fetchErr
			continue
		}
		sanitized, parsedCard, sanitizeErr := sanitizeA2AAgentCard(card)
		if sanitizeErr != nil {
			lastErr = sanitizeErr
			continue
		}
		_ = raw
		return sanitized, parsedCard, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("agent card was not found")
	}
	return nil, a2aAgentCard{}, fmt.Errorf("A2A agent card discovery failed: %w", lastErr)
}

func fetchA2AJSON(ctx context.Context, rawURL string, allowPrivate bool, limit int64) ([]byte, []byte, error) {
	return fetchA2AJSONWithClient(ctx, rawURL, allowPrivate, limit, nil, nil)
}

func fetchA2AJSONWithClient(ctx context.Context, rawURL string, allowPrivate bool, limit int64, client *http.Client, decorate func(*http.Request)) ([]byte, []byte, error) {
	if err := provider.ValidateRequestURL(rawURL, allowPrivate); err != nil {
		return nil, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Accept", "application/a2a+json, application/json, application/*+json")
	request.Header.Set("User-Agent", "JustAI/0.1 agent-discovery")
	if decorate != nil {
		decorate(request)
	}
	if client == nil {
		client = provider.SafeHTTPClientForOrigin(20*time.Second, allowPrivate, rawURL)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("agent endpoint returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(body)) > limit {
		return nil, nil, fmt.Errorf("agent response exceeds the supported size")
	}
	if !json.Valid(body) {
		return nil, nil, fmt.Errorf("agent endpoint returned invalid JSON")
	}
	return body, body, nil
}

func (a *App) discoverA2AAgentCardForConnection(ctx context.Context, connection remoteAgentConnection) (json.RawMessage, a2aAgentCard, error) {
	secret, err := a.decryptAgentSecret(connection)
	if err != nil {
		return nil, a2aAgentCard{}, err
	}
	client, err := a.a2aHTTPClient(ctx, connection, secret)
	if err != nil {
		return nil, a2aAgentCard{}, err
	}
	return discoverA2AAgentCardWithClient(ctx, connection.EndpointURL, a.Config.AllowPrivate, client, func(request *http.Request) {
		applyAgentAuth(request, connection.AuthType, secret)
	})
}

func sanitizeA2AAgentCard(raw []byte) (json.RawMessage, a2aAgentCard, error) {
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, a2aAgentCard{}, fmt.Errorf("invalid Agent Card: %w", err)
	}
	card := a2aAgentCard{
		Name:        boundedString(value, "name", 160),
		Description: boundedString(value, "description", 1000),
		URL:         boundedString(value, "url", 2000),
		Version:     boundedString(value, "version", 120),
	}
	if card.Name == "" {
		return nil, a2aAgentCard{}, fmt.Errorf("Agent Card is missing a name")
	}
	card.Capabilities = boundedJSON(redactAgentValue(value["capabilities"]), `{"streaming":false}`)
	card.Skills = boundedJSON(redactAgentValue(value["skills"]), `[]`)
	card.SupportedInterfaces = boundedJSON(redactAgentValue(value["supportedInterfaces"]), `[]`)
	card.SecuritySchemes = boundedJSON(redactAgentValue(value["securitySchemes"]), `{}`)
	// The persisted card contains protocol metadata useful to the UI and
	// executor. Unknown extension fields are deliberately dropped.
	sanitized := map[string]any{
		"name":                card.Name,
		"description":         card.Description,
		"url":                 card.URL,
		"version":             card.Version,
		"capabilities":        json.RawMessage(card.Capabilities),
		"skills":              json.RawMessage(card.Skills),
		"supportedInterfaces": json.RawMessage(card.SupportedInterfaces),
		"securitySchemes":     json.RawMessage(card.SecuritySchemes),
	}
	encoded, err := json.Marshal(sanitized)
	if err != nil {
		return nil, a2aAgentCard{}, err
	}
	return json.RawMessage(encoded), card, nil
}

func boundedString(value map[string]any, key string, limit int) string {
	text, _ := value[key].(string)
	text = strings.TrimSpace(text)
	if len([]rune(text)) > limit {
		return string([]rune(text)[:limit])
	}
	return text
}

func boundedJSON(value any, fallback string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > 512*1024 || string(encoded) == "null" {
		return json.RawMessage(fallback)
	}
	return json.RawMessage(encoded)
}

func (a *App) loadRemoteAgentConnection(ctx context.Context, id, userID, organizationID uuid.UUID) (remoteAgentConnection, error) {
	var connection remoteAgentConnection
	err := a.DB.QueryRowContext(ctx, `
		SELECT id, endpoint_url, auth_type, encrypted_credential,
		       encrypted_refresh_credential, encrypted_client_certificate,
		       encrypted_client_key, COALESCE(oauth_token_url, ''),
		       COALESCE(oauth_client_id, ''), COALESCE(oauth_scopes, ''),
		       enabled, trusted_read_only, agent_card
		FROM agent_connections
		WHERE id = $1 AND organization_id = $2
		  AND ((scope_type = 'organization') OR (scope_type = 'user' AND scope_id = $3))`,
		id, organizationID, userID).Scan(
		&connection.ID, &connection.EndpointURL, &connection.AuthType,
		&connection.EncryptedCredential, &connection.EncryptedRefresh,
		&connection.EncryptedCertificate, &connection.EncryptedPrivateKey,
		&connection.OAuthTokenURL, &connection.OAuthClientID, &connection.OAuthScopes,
		&connection.Enabled, &connection.TrustedReadOnly, &connection.AgentCard,
	)
	return connection, err
}

func (a *App) decryptAgentSecret(connection remoteAgentConnection) (agentConnectionSecret, error) {
	secret := agentConnectionSecret{}
	if len(connection.EncryptedCredential) > 0 {
		value, err := a.Secrets.Decrypt(connection.EncryptedCredential)
		if err != nil {
			return secret, fmt.Errorf("could not decrypt agent connection credential")
		}
		if json.Unmarshal([]byte(value), &secret) != nil {
			secret.APIKey = value
		}
	}
	if len(connection.EncryptedRefresh) > 0 {
		value, err := a.Secrets.Decrypt(connection.EncryptedRefresh)
		if err != nil {
			return secret, fmt.Errorf("could not decrypt agent connection refresh credential")
		}
		secret.RefreshToken = value
	}
	return secret, nil
}

func (a *App) a2aHTTPClient(ctx context.Context, connection remoteAgentConnection, secret agentConnectionSecret) (*http.Client, error) {
	if err := provider.ValidateEndpointURL(connection.EndpointURL, a.Config.AllowPrivate); err != nil {
		return nil, err
	}
	timeout := 10 * time.Minute
	client := provider.SafeHTTPClientForOrigin(timeout, a.Config.AllowPrivate, connection.EndpointURL)
	if connection.AuthType == "mtls" {
		certificate, err := a.Secrets.Decrypt(connection.EncryptedCertificate)
		if err != nil {
			return nil, fmt.Errorf("could not decrypt mTLS certificate")
		}
		privateKey, err := a.Secrets.Decrypt(connection.EncryptedPrivateKey)
		if err != nil {
			return nil, fmt.Errorf("could not decrypt mTLS private key")
		}
		pair, err := tls.X509KeyPair([]byte(certificate), []byte(privateKey))
		if err != nil {
			return nil, fmt.Errorf("mTLS certificate is invalid")
		}
		transport, ok := client.Transport.(*http.Transport)
		if !ok {
			return nil, fmt.Errorf("mTLS transport is unavailable")
		}
		clone := transport.Clone()
		clone.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}, RootCAs: systemCertPool()}
		client.Transport = clone
		origin := connection.EndpointURL
		redirects := client.CheckRedirect
		client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
			if len(via) > 0 && !sameA2AOrigin(origin, next.URL.String()) {
				return fmt.Errorf("mTLS redirect crossed the configured agent origin")
			}
			if redirects != nil {
				return redirects(next, via)
			}
			return nil
		}
	}
	_ = ctx
	return client, nil
}

func systemCertPool() *x509.CertPool {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		return x509.NewCertPool()
	}
	return pool
}

func (a *App) executeA2A(ctx context.Context, connection remoteAgentConnection, message string, onProgress func(string) error) (a2aExecutionResult, error) {
	if !connection.Enabled {
		return a2aExecutionResult{}, fmt.Errorf("agent connection is disabled")
	}
	secret, err := a.decryptAgentSecret(connection)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	client, err := a.a2aHTTPClient(ctx, connection, secret)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	requestMessage := map[string]any{
		"messageId": uuid.NewString(),
		"role":      "ROLE_USER",
		"parts":     []map[string]any{{"text": message}},
	}
	params := map[string]any{"message": requestMessage}
	selection := selectA2ATransport(connection)
	streamResult, streamErr := a.postA2ASelected(ctx, client, connection, secret, selection, "message/stream", params, true, onProgress)
	if streamErr == nil && (streamResult.Summary != "" || streamResult.TaskID != "") {
		if shouldPollA2ATask(streamResult) {
			return a.pollA2ATask(ctx, client, connection, secret, streamResult, onProgress)
		}
		return streamResult, nil
	}
	// Servers that do not advertise streaming still implement message/send.
	// Keep the stream error out of the user-visible payload unless both methods
	// fail, preventing remote response bodies from becoming an information leak.
	result, sendErr := a.postA2ASelected(ctx, client, connection, secret, selection, "message/send", params, false, onProgress)
	if sendErr == nil {
		if shouldPollA2ATask(result) {
			return a.pollA2ATask(ctx, client, connection, secret, result, onProgress)
		}
		return result, nil
	}

	// Cards published before A2A 1.0 and deployments without a card commonly
	// use the older lower-case JSON-RPC method names. Keep that path as a safe
	// compatibility fallback after the standards-compliant transport fails.
	legacySelection := a2aTransportSelection{Endpoint: connection.EndpointURL, Kind: a2aTransportLegacy}
	fallbacks := []a2aTransportSelection{legacySelection}
	if selection.Kind == a2aTransportLegacy {
		// A connection can be saved before discovery completes. In that case,
		// probe the two A2A 1.0 transports after the legacy compatibility path.
		fallbacks = []a2aTransportSelection{
			{Endpoint: connection.EndpointURL, Kind: a2aTransportHTTPJSON},
			{Endpoint: connection.EndpointURL, Kind: a2aTransportJSONRPC},
		}
	}
	for _, fallback := range fallbacks {
		if fallback.Kind == selection.Kind && fallback.Endpoint == selection.Endpoint {
			continue
		}
		fallbackStream, fallbackStreamErr := a.postA2ASelected(ctx, client, connection, secret, fallback, "message/stream", params, true, onProgress)
		if fallbackStreamErr == nil && (fallbackStream.Summary != "" || fallbackStream.TaskID != "") {
			if shouldPollA2ATask(fallbackStream) {
				return a.pollA2ATask(ctx, client, connection, secret, fallbackStream, onProgress)
			}
			return fallbackStream, nil
		}
		fallbackResult, fallbackErr := a.postA2ASelected(ctx, client, connection, secret, fallback, "message/send", params, false, onProgress)
		if fallbackErr == nil {
			if shouldPollA2ATask(fallbackResult) {
				return a.pollA2ATask(ctx, client, connection, secret, fallbackResult, onProgress)
			}
			return fallbackResult, nil
		}
	}
	if streamErr != nil {
		return a2aExecutionResult{}, fmt.Errorf("A2A request failed: %v; fallback failed: %w", streamErr, sendErr)
	}
	return a2aExecutionResult{}, sendErr
}

func shouldPollA2ATask(result a2aExecutionResult) bool {
	if result.TaskID == "" {
		return false
	}
	status := taskStatusFromCard(result.ResponseMetadata)
	if isTerminalA2AStatus(status) {
		return false
	}
	return result.Summary == "" || status != ""
}

func (a *App) postA2A(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, method string, params map[string]any, stream bool, onProgress func(string) error) (a2aExecutionResult, error) {
	return a.postA2ASelected(ctx, client, connection, secret, a2aTransportSelection{Endpoint: connection.EndpointURL, Kind: a2aTransportLegacy}, method, params, stream, onProgress)
}

type a2aTransportSelection struct {
	Endpoint string
	Kind     string
	Tenant   string
}

func selectA2ATransport(connection remoteAgentConnection) a2aTransportSelection {
	selection := a2aTransportSelection{Endpoint: connection.EndpointURL, Kind: a2aTransportLegacy}
	var card struct {
		SupportedInterfaces []struct {
			URL             string `json:"url"`
			ProtocolBinding string `json:"protocolBinding"`
			Tenant          string `json:"tenant"`
		} `json:"supportedInterfaces"`
	}
	if json.Unmarshal(connection.AgentCard, &card) != nil {
		return selection
	}
	for _, supported := range card.SupportedInterfaces {
		endpoint := strings.TrimSpace(supported.URL)
		if endpoint == "" || !sameA2AOrigin(connection.EndpointURL, endpoint) {
			continue
		}
		binding := strings.ToLower(strings.TrimSpace(supported.ProtocolBinding))
		kind := ""
		switch {
		case strings.Contains(binding, "http+json"), strings.Contains(binding, "http_json"), strings.Contains(binding, "rest"):
			kind = a2aTransportHTTPJSON
		case strings.Contains(binding, "jsonrpc"):
			kind = a2aTransportJSONRPC
		}
		if kind != "" {
			selection.Endpoint = endpoint
			selection.Kind = kind
			selection.Tenant = strings.TrimSpace(supported.Tenant)
			return selection
		}
	}
	return selection
}

func sameA2AOrigin(left, right string) bool {
	leftURL, leftErr := url.Parse(strings.TrimSpace(left))
	rightURL, rightErr := url.Parse(strings.TrimSpace(right))
	if leftErr != nil || rightErr != nil || leftURL == nil || rightURL == nil || leftURL.User != nil || rightURL.User != nil {
		return false
	}
	return strings.EqualFold(leftURL.Scheme, rightURL.Scheme) && strings.EqualFold(leftURL.Host, rightURL.Host)
}

func (a *App) postA2ASelected(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, selection a2aTransportSelection, method string, params map[string]any, stream bool, onProgress func(string) error) (a2aExecutionResult, error) {
	switch selection.Kind {
	case a2aTransportHTTPJSON:
		return a.postA2AHTTPJSON(ctx, client, connection, secret, selection, method, params, stream, onProgress)
	case a2aTransportJSONRPC:
		return a.postA2AJSONRPC(ctx, client, connection, secret, selection, method, params, stream, onProgress)
	default:
		return a.postA2ALegacyJSONRPC(ctx, client, connection, secret, selection, method, params, stream, onProgress)
	}
}

func (a *App) postA2ALegacyJSONRPC(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, selection a2aTransportSelection, method string, params map[string]any, stream bool, onProgress func(string) error) (a2aExecutionResult, error) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": uuid.NewString(), "method": method, "params": legacyA2AParams(params)})
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, connection.EndpointURL, bytes.NewReader(body))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	if stream {
		request.Header.Set("Accept", "text/event-stream, application/json")
	} else {
		request.Header.Set("Accept", "application/json")
	}
	applyAgentAuth(request, connection.AuthType, secret)
	response, err := client.Do(request)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return a2aExecutionResult{}, fmt.Errorf("A2A endpoint returned HTTP %d", response.StatusCode)
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if stream && strings.Contains(contentType, "text/event-stream") {
		result, parseErr := parseA2ASSE(response.Body, onProgress)
		result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
		return result, parseErr
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxA2AResponseBytes+1))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	if int64(len(data)) > maxA2AResponseBytes {
		return a2aExecutionResult{}, fmt.Errorf("A2A response exceeds the supported size")
	}
	result, parseErr := parseA2AJSON(data, onProgress)
	result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
	return result, parseErr
}

func (a *App) postA2AJSONRPC(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, selection a2aTransportSelection, method string, params map[string]any, stream bool, onProgress func(string) error) (a2aExecutionResult, error) {
	requestParams := cloneA2AParams(params, selection.Tenant)
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": uuid.NewString(), "method": standardA2AMethod(method), "params": requestParams})
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, selection.Endpoint, bytes.NewReader(body))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	if stream {
		request.Header.Set("Accept", "text/event-stream, application/json")
	} else {
		request.Header.Set("Accept", "application/json")
	}
	request.Header.Set("A2A-Version", "1.0")
	applyAgentAuth(request, connection.AuthType, secret)
	response, err := client.Do(request)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return a2aExecutionResult{}, fmt.Errorf("A2A endpoint returned HTTP %d", response.StatusCode)
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if stream && strings.Contains(contentType, "text/event-stream") {
		result, parseErr := parseA2ASSE(response.Body, onProgress)
		result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
		return result, parseErr
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxA2AResponseBytes+1))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	if int64(len(data)) > maxA2AResponseBytes {
		return a2aExecutionResult{}, fmt.Errorf("A2A response exceeds the supported size")
	}
	result, parseErr := parseA2AJSON(data, onProgress)
	result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
	return result, parseErr
}

func (a *App) postA2AHTTPJSON(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, selection a2aTransportSelection, method string, params map[string]any, stream bool, onProgress func(string) error) (a2aExecutionResult, error) {
	endpoint, err := a2AHTTPJSONOperationURL(selection.Endpoint, method, "")
	if err != nil {
		return a2aExecutionResult{}, err
	}
	requestParams := cloneA2AParams(params, selection.Tenant)
	body, err := json.Marshal(requestParams)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request.Header.Set("Content-Type", "application/a2a+json")
	if stream {
		request.Header.Set("Accept", "text/event-stream, application/a2a+json, application/json")
	} else {
		request.Header.Set("Accept", "application/a2a+json, application/json")
	}
	request.Header.Set("A2A-Version", "1.0")
	applyAgentAuth(request, connection.AuthType, secret)
	response, err := client.Do(request)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return a2aExecutionResult{}, fmt.Errorf("A2A endpoint returned HTTP %d", response.StatusCode)
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if stream && strings.Contains(contentType, "text/event-stream") {
		result, parseErr := parseA2ASSE(response.Body, onProgress)
		result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
		return result, parseErr
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxA2AResponseBytes+1))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	if int64(len(data)) > maxA2AResponseBytes {
		return a2aExecutionResult{}, fmt.Errorf("A2A response exceeds the supported size")
	}
	result, parseErr := parseA2AJSON(data, onProgress)
	result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
	return result, parseErr
}

func cloneA2AParams(params map[string]any, tenant string) map[string]any {
	cloned := make(map[string]any, len(params)+1)
	for key, value := range params {
		cloned[key] = value
	}
	if strings.TrimSpace(tenant) != "" {
		cloned["tenant"] = tenant
	}
	return cloned
}

func legacyA2AParams(params map[string]any) map[string]any {
	cloned := cloneA2AParams(params, "")
	message, ok := cloned["message"].(map[string]any)
	if !ok {
		return cloned
	}
	legacyMessage := make(map[string]any, len(message)+1)
	for key, value := range message {
		legacyMessage[key] = value
	}
	legacyMessage["role"] = "user"
	if parts, ok := message["parts"].([]map[string]any); ok {
		legacyParts := make([]map[string]any, 0, len(parts))
		for _, part := range parts {
			legacyPart := make(map[string]any, len(part)+1)
			for key, value := range part {
				legacyPart[key] = value
			}
			legacyPart["kind"] = "text"
			legacyParts = append(legacyParts, legacyPart)
		}
		legacyMessage["parts"] = legacyParts
	}
	cloned["message"] = legacyMessage
	return cloned
}

func standardA2AMethod(method string) string {
	switch method {
	case "message/stream":
		return "SendStreamingMessage"
	case "message/send":
		return "SendMessage"
	case "tasks/get":
		return "GetTask"
	default:
		return method
	}
}

func a2AHTTPJSONOperationURL(rawURL, method, taskID string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil {
		return "", fmt.Errorf("invalid A2A interface URL")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	path := strings.TrimRight(parsed.Path, "/")
	for _, operation := range []string{"/message:send", "/message:stream"} {
		if strings.HasSuffix(path, operation) {
			path = strings.TrimSuffix(path, operation)
			break
		}
	}
	path = strings.TrimSuffix(path, "/.well-known/agent-card.json")
	if method == "tasks/get" {
		path += "/tasks/" + url.PathEscape(taskID)
	} else if method == "message/stream" {
		path += "/message:stream"
	} else if method == "message/send" {
		path += "/message:send"
	}
	if path == "" {
		path = "/"
	}
	parsed.Path = path
	return parsed.String(), nil
}

func applyAgentAuth(request *http.Request, authType string, secret agentConnectionSecret) {
	switch strings.ToLower(authType) {
	case "api_key":
		key := secret.APIKey
		if key == "" {
			key = secret.AccessToken
		}
		if key != "" {
			request.Header.Set("Authorization", "Bearer "+key)
			request.Header.Set("X-API-Key", key)
		}
	case "http":
		if secret.Username != "" {
			request.SetBasicAuth(secret.Username, secret.Password)
		} else if secret.APIKey != "" {
			request.Header.Set("Authorization", secret.APIKey)
		}
	case "oauth2", "oidc":
		if secret.AccessToken != "" {
			request.Header.Set("Authorization", "Bearer "+secret.AccessToken)
		}
	}
}

func parseA2ASSE(reader io.Reader, onProgress func(string) error) (a2aExecutionResult, error) {
	result := a2aExecutionResult{Artifacts: []a2aArtifact{}}
	scanner := bufio.NewScanner(io.LimitReader(reader, maxA2AResponseBytes))
	scanner.Buffer(make([]byte, 1024), 2*1024*1024)
	var eventData strings.Builder
	lastText := ""
	flush := func() error {
		if strings.TrimSpace(eventData.String()) == "" {
			eventData.Reset()
			return nil
		}
		parsed, err := parseA2AJSON([]byte(eventData.String()), onProgress)
		if err != nil {
			eventData.Reset()
			return nil
		}
		if result.TaskID == "" {
			result.TaskID = parsed.TaskID
		}
		if parsed.ResponseMetadata != nil {
			result.ResponseMetadata = parsed.ResponseMetadata
		}
		if parsed.Summary != "" {
			if strings.HasPrefix(parsed.Summary, lastText) {
				result.Summary += strings.TrimPrefix(parsed.Summary, lastText)
			} else if result.Summary == "" {
				result.Summary = parsed.Summary
			}
			lastText = parsed.Summary
		}
		result.Artifacts = append(result.Artifacts, parsed.Artifacts...)
		eventData.Reset()
		return nil
	}
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return result, err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			value := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if value != "[DONE]" {
				if eventData.Len() > 0 {
					eventData.WriteByte('\n')
				}
				eventData.WriteString(value)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return result, err
	}
	if err := flush(); err != nil {
		return result, err
	}
	if result.Summary == "" && result.TaskID == "" {
		return result, fmt.Errorf("A2A stream returned no task or message")
	}
	return result, nil
}

func parseA2AJSON(data []byte, onProgress func(string) error) (a2aExecutionResult, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return a2aExecutionResult{}, err
	}
	if object, ok := value.(map[string]any); ok {
		if errorValue, exists := object["error"].(map[string]any); exists {
			return a2aExecutionResult{}, fmt.Errorf("A2A protocol error: %s", boundedString(errorValue, "message", 400))
		}
	}
	result := a2aExecutionResult{Artifacts: extractA2AArtifacts(value)}
	result.TaskID = findA2ATaskID(value)
	result.ResponseMetadata = extractA2AResponseMetadata(value)
	text := extractA2AText(value)
	if text != "" {
		result.Summary = text
		if onProgress != nil {
			if err := onProgress(text); err != nil {
				return result, err
			}
		}
	}
	if result.TaskID == "" && result.Summary == "" && len(result.Artifacts) == 0 {
		return result, fmt.Errorf("A2A response contained no task, message, or artifact")
	}
	return result, nil
}

func extractA2AResponseMetadata(value any) map[string]any {
	status := findA2AStatus(value)
	if status == "" {
		return nil
	}
	return map[string]any{"status": status}
}

func findA2AStatus(value any) string {
	switch item := value.(type) {
	case map[string]any:
		// A2A task envelopes use status.state. Accept a string status too for
		// compatible implementations, but only inspect the well-known task
		// fields before falling back to nested result/task/data objects.
		for _, key := range []string{"status", "state"} {
			if status, ok := item[key]; ok {
				if value := normalizeA2AStatus(status); value != "" {
					return value
				}
			}
		}
		for _, key := range []string{"result", "task", "data"} {
			if child, ok := item[key]; ok {
				if value := findA2AStatus(child); value != "" {
					return value
				}
			}
		}
		// Some providers wrap the task in an extension envelope. Do not walk
		// arbitrary metadata/artifact payloads because those can contain
		// unrelated status labels.
		for _, key := range []string{"response", "payload", "message"} {
			if child, ok := item[key]; ok {
				if value := findA2AStatus(child); value != "" {
					return value
				}
			}
		}
	case []any:
		for _, child := range item {
			if value := findA2AStatus(child); value != "" {
				return value
			}
		}
	}
	return ""
}

func normalizeA2AStatus(value any) string {
	switch item := value.(type) {
	case string:
		status := strings.ToLower(strings.TrimSpace(item))
		status = strings.TrimPrefix(status, "task_state_")
		return strings.ReplaceAll(status, "_", "-")
	case map[string]any:
		for _, key := range []string{"state", "status"} {
			if nested, ok := item[key]; ok {
				if status := normalizeA2AStatus(nested); status != "" {
					return status
				}
			}
		}
	}
	return ""
}

func findA2ATaskID(value any) string {
	// A JSON-RPC response's top-level id identifies the request, not the
	// provider task. Only a task object (or the result/task envelope that owns
	// it) may contribute a durable task id.
	return findA2ATaskIDValue(value, false)
}

func findA2ATaskIDValue(value any, allowBareID bool) string {
	if object, ok := value.(map[string]any); ok {
		if result, exists := object["result"]; exists {
			if id := findA2ATaskIDValue(result, true); id != "" {
				return id
			}
		}
		for _, key := range []string{"taskId", "task_id"} {
			if id, ok := object[key].(string); ok && id != "" {
				return id
			}
		}
		if task, exists := object["task"]; exists {
			if id := findA2ATaskIDValue(task, true); id != "" {
				return id
			}
		}
		if allowBareID {
			if id, ok := object["id"].(string); ok && id != "" {
				return id
			}
		}
	}
	return ""
}

func extractA2AText(value any) string {
	texts := []string{}
	var walk func(any, string)
	walk = func(current any, key string) {
		switch item := current.(type) {
		case map[string]any:
			for childKey, child := range item {
				if childKey == "text" {
					if text, ok := child.(string); ok && strings.TrimSpace(text) != "" {
						texts = append(texts, text)
					}
					continue
				}
				if childKey != "id" && childKey != "messageId" && childKey != "taskId" && childKey != "task_id" && childKey != "metadata" {
					walk(child, childKey)
				}
			}
		case []any:
			for _, child := range item {
				walk(child, key)
			}
		}
	}
	walk(value, "")
	return strings.Join(texts, "")
}

func extractA2AArtifacts(value any) []a2aArtifact {
	artifacts := []a2aArtifact{}
	var walk func(any)
	walk = func(current any) {
		switch item := current.(type) {
		case map[string]any:
			if raw, ok := item["artifacts"].([]any); ok {
				for _, artifactValue := range raw {
					if artifact, ok := artifactValue.(map[string]any); ok {
						artifacts = append(artifacts, parseA2AArtifact(artifact)...)
					}
				}
			}
			for _, child := range item {
				walk(child)
			}
		case []any:
			for _, child := range item {
				walk(child)
			}
		}
	}
	walk(value)
	return artifacts
}

func parseA2AArtifact(artifact map[string]any) []a2aArtifact {
	name, _ := artifact["name"].(string)
	mimeType, _ := artifact["mimeType"].(string)
	parts, _ := artifact["parts"].([]any)
	if len(parts) == 0 {
		text := extractA2AText(artifact)
		if text == "" {
			return nil
		}
		return []a2aArtifact{{Name: firstNonEmptyString(name, "artifact"), Kind: "text", MimeType: firstNonEmptyString(mimeType, "text/plain"), Content: []byte(text), Metadata: map[string]any{}}}
	}
	result := make([]a2aArtifact, 0, len(parts))
	for index, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		partName, _ := part["filename"].(string)
		partMime, _ := part["mediaType"].(string)
		if partMime == "" {
			partMime, _ = part["mimeType"].(string)
		}
		artifactName := firstNonEmptyString(partName, name, fmt.Sprintf("artifact-%d", index+1))
		artifactMime := firstNonEmptyString(partMime, mimeType, "text/plain")
		if text, ok := part["text"].(string); ok && text != "" {
			result = append(result, a2aArtifact{Name: artifactName, Kind: "text", MimeType: artifactMime, Content: []byte(text), Metadata: map[string]any{}})
			continue
		}
		if raw, ok := part["raw"].(string); ok && raw != "" {
			content, decodeErr := decodeA2ARawPart(raw)
			if decodeErr == nil && len(content) <= maxA2AArtifactBytes {
				result = append(result, a2aArtifact{Name: artifactName, Kind: "file", MimeType: artifactMime, Content: content, Metadata: map[string]any{}})
			}
			continue
		}
		if reference, ok := part["url"].(string); ok {
			if sanitizedReference, safe := sanitizeA2AArtifactReference(reference); safe {
				result = append(result, a2aArtifact{Name: artifactName, Kind: "file_reference", MimeType: artifactMime, Content: []byte(sanitizedReference), Metadata: map[string]any{"reference": true}})
			}
		}
	}
	return result
}

func decodeA2ARawPart(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	return base64.RawStdEncoding.DecodeString(value)
}

func sanitizeA2AArtifactReference(value string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return "", false
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), true
}

func (a *App) pollA2ATask(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, previous a2aExecutionResult, onProgress func(string) error) (a2aExecutionResult, error) {
	result := previous
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		params := map[string]any{"id": result.TaskID}
		selection := a2aTransportSelection{Endpoint: result.Endpoint, Kind: result.Transport, Tenant: result.Tenant}
		if selection.Endpoint == "" {
			selection.Endpoint = connection.EndpointURL
		}
		if selection.Kind == "" {
			selection.Kind = a2aTransportLegacy
		}
		var current a2aExecutionResult
		var err error
		if selection.Kind == a2aTransportHTTPJSON {
			current, err = a.getA2ATaskHTTPJSON(ctx, client, connection, secret, selection, result.TaskID, onProgress)
		} else {
			current, err = a.postA2ASelected(ctx, client, connection, secret, selection, "tasks/get", params, false, onProgress)
		}
		if err != nil {
			return result, err
		}
		if current.Transport == "" {
			current.Transport, current.Endpoint, current.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
		}
		if current.Summary != "" {
			result.Summary = current.Summary
		}
		result.Artifacts = append(result.Artifacts, current.Artifacts...)
		status := taskStatusFromCard(current.ResponseMetadata)
		if isTerminalA2AStatus(status) || isBlockedA2AStatus(status) {
			if status != "completed" && status != "" {
				return result, fmt.Errorf("remote A2A task ended with status %s", status)
			}
			return result, nil
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return result, fmt.Errorf("remote A2A task timed out")
}

func (a *App) getA2ATaskHTTPJSON(ctx context.Context, client *http.Client, connection remoteAgentConnection, secret agentConnectionSecret, selection a2aTransportSelection, taskID string, onProgress func(string) error) (a2aExecutionResult, error) {
	endpoint, err := a2AHTTPJSONOperationURL(selection.Endpoint, "tasks/get", taskID)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	request.Header.Set("Accept", "application/a2a+json, application/json")
	request.Header.Set("A2A-Version", "1.0")
	applyAgentAuth(request, connection.AuthType, secret)
	response, err := client.Do(request)
	if err != nil {
		return a2aExecutionResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return a2aExecutionResult{}, fmt.Errorf("A2A endpoint returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxA2AResponseBytes+1))
	if err != nil {
		return a2aExecutionResult{}, err
	}
	if int64(len(data)) > maxA2AResponseBytes {
		return a2aExecutionResult{}, fmt.Errorf("A2A response exceeds the supported size")
	}
	result, parseErr := parseA2AJSON(data, onProgress)
	result.Transport, result.Endpoint, result.Tenant = selection.Kind, selection.Endpoint, selection.Tenant
	return result, parseErr
}

func taskStatusFromCard(metadata map[string]any) string {
	if metadata == nil {
		return ""
	}
	for _, key := range []string{"status", "state"} {
		if value, ok := metadata[key].(string); ok {
			return normalizeA2AStatus(value)
		}
	}
	return ""
}

func isTerminalA2AStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "failed", "canceled", "cancelled", "rejected":
		return true
	default:
		return false
	}
}

func isBlockedA2AStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "input-required", "auth-required":
		return true
	default:
		return false
	}
}

func a2aCardToAgent(card json.RawMessage) (name, description string, capabilities, skills json.RawMessage) {
	var value map[string]any
	if json.Unmarshal(card, &value) != nil {
		return "", "", json.RawMessage(`{}`), json.RawMessage(`[]`)
	}
	name = boundedString(value, "name", 160)
	description = boundedString(value, "description", 1000)
	capabilities = boundedJSON(value["capabilities"], `{}`)
	skills = boundedJSON(value["skills"], `[]`)
	return
}

func (a *App) refreshAgentConnectionCard(ctx context.Context, connectionID, userID, organizationID uuid.UUID) (json.RawMessage, error) {
	connection, err := a.loadRemoteAgentConnection(ctx, connectionID, userID, organizationID)
	if err != nil {
		return nil, err
	}
	card, _, err := a.discoverA2AAgentCardForConnection(ctx, connection)
	if err != nil {
		_, _ = a.DB.ExecContext(ctx, `UPDATE agent_connections SET last_error = $2, updated_at = now() WHERE id = $1`, connectionID, redactAgentError(err.Error()))
		return nil, err
	}
	_, err = a.DB.ExecContext(ctx, `UPDATE agent_connections SET agent_card = $2, discovered_at = now(), last_error = '', updated_at = now() WHERE id = $1`, connectionID, card)
	return card, err
}

func redactAgentError(message string) string {
	message = strings.TrimSpace(message)
	if len([]rune(message)) > 500 {
		message = string([]rune(message)[:500])
	}
	return message
}

func encodeAgentSecret(secret agentConnectionSecret) ([]byte, error) {
	encoded, err := json.Marshal(secret)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func encryptAgentSecret(box interface{ Encrypt(string) ([]byte, error) }, secret agentConnectionSecret) ([]byte, error) {
	encoded, err := encodeAgentSecret(secret)
	if err != nil {
		return nil, err
	}
	return box.Encrypt(string(encoded))
}

func decodeBase64OrText(value string) []byte {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err == nil && len(decoded) > 0 {
		return decoded
	}
	return []byte(value)
}
