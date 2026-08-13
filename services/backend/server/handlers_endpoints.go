package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type endpointRequest struct {
	ScopeType          string          `json:"scopeType"`
	ProviderType       string          `json:"providerType"`
	Name               string          `json:"name"`
	BaseURL            string          `json:"baseUrl"`
	APIPath            string          `json:"apiPath"`
	APIVersion         string          `json:"apiVersion"`
	ChatModel          string          `json:"chatModel"`
	EmbeddingModel     string          `json:"embeddingModel"`
	TranscriptionModel string          `json:"transcriptionModel"`
	DiarizationModel   string          `json:"diarizationModel"`
	SpeechModel        string          `json:"speechModel"`
	Capabilities       map[string]bool `json:"capabilities"`
	Credential         string          `json:"credential"`
	Enabled            *bool           `json:"enabled"`
	IsDefault          *bool           `json:"isDefault"`
	TimeoutSeconds     int             `json:"timeoutSeconds"`
	MaxOutputTokens    int             `json:"maxOutputTokens"`
	Temperature        float64         `json:"temperature"`
}

func (a *App) supportedProviders(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"providers": []gin.H{
		{"id": "openai", "name": "OpenAI", "kind": "native", "capabilities": []string{"chat", "embeddings", "realtime-transcription", "diarization", "tool-calling", "tts"}},
		{"id": "gemini", "name": "Google Gemini", "kind": "native", "capabilities": []string{"chat", "embeddings", "realtime-transcription", "diarization"}},
		{"id": "anthropic", "name": "Anthropic", "kind": "native", "capabilities": []string{"chat"}},
		{"id": "ollama", "name": "Ollama", "kind": "local", "capabilities": []string{"chat", "embeddings"}},
		{"id": "openai-compatible", "name": "OpenAI-compatible", "kind": "gateway", "examples": []string{"LiteLLM", "vLLM", "LM Studio", "OpenRouter"}, "capabilities": []string{"chat", "embeddings", "realtime-transcription", "chunked-transcription", "diarization", "tool-calling", "tts"}},
		{"id": "mock", "name": "JustAI demo", "kind": "local", "capabilities": []string{"chat"}},
	}})
}

func (a *App) listEndpoints(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, scope_type, scope_id, provider_type, name, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(chat_model, ''), COALESCE(embedding_model, ''), COALESCE(transcription_model, ''), COALESCE(diarization_model, ''), COALESCE(speech_model, ''), capabilities, credential_ciphertext IS NOT NULL, enabled, is_default, timeout_seconds, max_output_tokens, temperature, created_at, updated_at FROM endpoint_settings WHERE (scope_type = 'global') OR (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) ORDER BY is_default DESC, created_at DESC`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []models.Endpoint{}
	for rows.Next() {
		item, err := scanEndpoint(rows)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, item)
	}
	c.JSON(http.StatusOK, gin.H{"endpoints": result})
}

func (a *App) createEndpoint(c *gin.Context) {
	var request endpointRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Credential = strings.TrimSpace(request.Credential)
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	scopeType := strings.TrimSpace(request.ScopeType)
	if scopeType == "" {
		scopeType = "organization"
	}
	scopeID, err := a.authorizeEndpointScope(c, scopeType, principal, organizationID)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if err := validateEndpointRequest(&request); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var credential []byte
	if strings.TrimSpace(request.Credential) != "" {
		credential, err = a.Secrets.Encrypt(strings.TrimSpace(request.Credential))
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	capabilities := request.Capabilities
	if capabilities == nil {
		capabilities = map[string]bool{"chat": true}
	}
	if err := validateProviderCapabilities(request.ProviderType, capabilities); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	isDefault := request.IsDefault != nil && *request.IsDefault
	enabled := boolValue(request.Enabled, true)
	if isDefault && !capabilities["chat"] {
		writeError(c, http.StatusBadRequest, fmt.Errorf("only chat-capable endpoints can be the default"))
		return
	}
	if isDefault && !enabled {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a disabled endpoint cannot be the default"))
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	if err := lockEndpointScope(c, transaction, scopeType, scopeIDUUID(scopeID)); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if isDefault {
		if _, err := transaction.ExecContext(c, `UPDATE endpoint_settings SET is_default = FALSE WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2`, scopeType, scopeID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	var id uuid.UUID
	err = transaction.QueryRowContext(c, `INSERT INTO endpoint_settings (scope_type, scope_id, provider_type, name, base_url, api_path, api_version, chat_model, embedding_model, transcription_model, diarization_model, speech_model, capabilities, credential_ciphertext, enabled, is_default, timeout_seconds, max_output_tokens, temperature, created_by) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`, scopeType, scopeID, request.ProviderType, request.Name, request.BaseURL, request.APIPath, request.APIVersion, request.ChatModel, request.EmbeddingModel, request.TranscriptionModel, request.DiarizationModel, request.SpeechModel, jsonRaw(capabilities), nullableBytes(credential), enabled, isDefault, intValue(request.TimeoutSeconds, 120), intValue(request.MaxOutputTokens, 2048), floatValue(request.Temperature, 0.2), principal.UserID).Scan(&id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := ensureEndpointDefault(c, transaction, scopeType, scopeIDUUID(scopeID)); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (a *App) updateEndpoint(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpoint id"))
		return
	}
	var request endpointRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Credential = strings.TrimSpace(request.Credential)
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	current, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
		return
	}
	if err := a.canManageEndpoint(current, principal, organizationID, middleware.GetOrganizationRole(c)); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	// Small state-only PATCHes (enable/disable and set-default) must not erase
	// the endpoint's optional models or routing fields. The editor sends the
	// complete form, but callers such as the sidebar intentionally send only a
	// flag, so hydrate those fields from the stored endpoint in that case.
	minimalPatch := request.ProviderType == "" && request.Name == "" && request.BaseURL == "" && request.APIPath == "" && request.APIVersion == "" && request.ChatModel == "" && request.EmbeddingModel == "" && request.TranscriptionModel == "" && request.DiarizationModel == "" && request.SpeechModel == "" && request.Capabilities == nil && request.Credential == ""
	if minimalPatch {
		request.ProviderType = current.ProviderType
		request.Name = current.Name
		request.BaseURL = current.BaseURL
		request.APIPath = current.APIPath
		request.APIVersion = current.APIVersion
		request.ChatModel = current.ChatModel
		request.EmbeddingModel = current.EmbeddingModel
		request.TranscriptionModel = current.TranscriptionModel
		request.DiarizationModel = current.DiarizationModel
		request.SpeechModel = current.SpeechModel
		currentCapabilities := map[string]bool{}
		if err := json.Unmarshal(current.Capabilities, &currentCapabilities); err == nil {
			request.Capabilities = currentCapabilities
		}
	}
	if request.ProviderType == "" {
		request.ProviderType = current.ProviderType
	}
	if request.Name == "" {
		request.Name = current.Name
	}
	if request.BaseURL == "" {
		request.BaseURL = current.BaseURL
	}
	if request.ChatModel == "" {
		request.ChatModel = current.ChatModel
	}
	if err := validateEndpointRequest(&request); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var encrypted any
	if request.Credential != "" {
		value, err := a.Secrets.Encrypt(request.Credential)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		encrypted = value
	}
	capabilities := current.Capabilities
	if request.Capabilities != nil {
		if err := validateProviderCapabilities(request.ProviderType, request.Capabilities); err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		capabilities = jsonRaw(request.Capabilities)
	} else {
		currentCapabilities := map[string]bool{}
		if err := json.Unmarshal(current.Capabilities, &currentCapabilities); err != nil {
			writeError(c, http.StatusInternalServerError, fmt.Errorf("stored endpoint capabilities are invalid"))
			return
		}
		if err := validateProviderCapabilities(request.ProviderType, currentCapabilities); err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	enabled := boolValue(request.Enabled, current.Enabled)
	isDefault := boolValue(request.IsDefault, current.IsDefault)
	if isDefault {
		var updatedCapabilities map[string]bool
		if err := json.Unmarshal(capabilities, &updatedCapabilities); err != nil || !updatedCapabilities["chat"] {
			writeError(c, http.StatusBadRequest, fmt.Errorf("only chat-capable endpoints can be the default"))
			return
		}
	}
	if isDefault && !enabled {
		isDefault = false
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	if err := lockEndpointScope(c, transaction, current.ScopeType, current.ScopeID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if isDefault {
		if _, err := transaction.ExecContext(c, `UPDATE endpoint_settings SET is_default = FALSE WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2 AND id <> $3`, current.ScopeType, current.ScopeID, id); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	_, err = transaction.ExecContext(c, `UPDATE endpoint_settings SET provider_type = $2, name = $3, base_url = $4, api_path = NULLIF($5, ''), api_version = NULLIF($6, ''), chat_model = NULLIF($7, ''), embedding_model = NULLIF($8, ''), transcription_model = NULLIF($9, ''), diarization_model = NULLIF($10, ''), speech_model = NULLIF($11, ''), capabilities = $12, credential_ciphertext = COALESCE($13, credential_ciphertext), enabled = $14, is_default = $15, timeout_seconds = $16, max_output_tokens = $17, temperature = $18, updated_at = now() WHERE id = $1`, id, request.ProviderType, request.Name, request.BaseURL, request.APIPath, request.APIVersion, request.ChatModel, request.EmbeddingModel, request.TranscriptionModel, request.DiarizationModel, request.SpeechModel, capabilities, encrypted, enabled, isDefault, intValue(request.TimeoutSeconds, current.TimeoutSeconds), intValue(request.MaxOutputTokens, current.MaxOutputTokens), floatValue(request.Temperature, current.Temperature))
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := ensureEndpointDefault(c, transaction, current.ScopeType, current.ScopeID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (a *App) deleteEndpoint(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpoint id"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	current, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
		return
	}
	if err := a.canManageEndpoint(current, principal, organizationID, middleware.GetOrganizationRole(c)); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	if err := lockEndpointScope(c, transaction, current.ScopeType, current.ScopeID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `DELETE FROM endpoint_settings WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := ensureEndpointDefault(c, transaction, current.ScopeType, current.ScopeID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

type sqlExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func lockEndpointScope(ctx context.Context, executor sqlExecutor, scopeType string, scopeID *uuid.UUID) error {
	// Serialize default promotion/demotion per scope. The partial unique index
	// protects the invariant at rest, while this transaction-scoped advisory
	// lock prevents two concurrent settings changes from racing into a 23505.
	_, err := executor.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('justai.endpoint.default:' || $1 || ':' || COALESCE($2::text, '')))`, scopeType, scopeID)
	return err
}

func scopeIDUUID(value any) *uuid.UUID {
	switch typed := value.(type) {
	case uuid.UUID:
		return &typed
	case *uuid.UUID:
		return typed
	default:
		return nil
	}
}

func ensureEndpointDefault(ctx context.Context, executor sqlExecutor, scopeType string, scopeID *uuid.UUID) error {
	// Older databases may contain a default that was later disabled or had its
	// chat capability removed. Clear that stale marker before promoting the next
	// eligible endpoint so delete/disable operations always leave a usable
	// default when one exists.
	if _, err := executor.ExecContext(ctx, `
		UPDATE endpoint_settings
		SET is_default = FALSE
		WHERE scope_type = $1
		  AND scope_id IS NOT DISTINCT FROM $2
		  AND is_default = TRUE
		  AND (enabled = FALSE OR NOT (capabilities ? 'chat'))`, scopeType, scopeID); err != nil {
		return err
	}
	_, err := executor.ExecContext(ctx, `
		UPDATE endpoint_settings candidate SET is_default = TRUE
		WHERE candidate.id = (
			SELECT id FROM endpoint_settings
			WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2 AND enabled = TRUE AND capabilities ? 'chat'
			ORDER BY created_at LIMIT 1
		)
		AND NOT EXISTS (
			SELECT 1 FROM endpoint_settings current_default
			WHERE current_default.scope_type = $1 AND current_default.scope_id IS NOT DISTINCT FROM $2 AND current_default.is_default = TRUE
		)`, scopeType, scopeID)
	return err
}

func (a *App) testEndpoint(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpoint id"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	metadata, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
		return
	}
	if err := a.canUseEndpoint(metadata, principal, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request struct {
		Capabilities []string `json:"capabilities"`
	}
	if c.Request.ContentLength > 0 && !decodeJSON(c, &request) {
		return
	}
	if len(request.Capabilities) == 0 {
		for capability, enabled := range endpoint.Capabilities {
			if enabled {
				request.Capabilities = append(request.Capabilities, capability)
			}
		}
	}
	if len(request.Capabilities) == 0 {
		request.Capabilities = []string{"chat"}
	}
	results := map[string]gin.H{}
	for _, capability := range request.Capabilities {
		result := gin.H{"ok": false, "supported": false, "tested": false}
		if !endpoint.Capabilities[capability] {
			result["error"] = "capability is not enabled on this endpoint"
			results[capability] = result
			continue
		}
		if err := validateProviderCapabilities(endpoint.ProviderType, map[string]bool{capability: true}); err != nil {
			result["error"] = err.Error()
			results[capability] = result
			continue
		}
		result["supported"] = true
		testContext, cancel := context.WithTimeout(c, 30*time.Second)
		switch capability {
		case "chat":
			err = provider.Test(testContext, endpoint)
			result["tested"] = true
		case "embeddings":
			_, err = provider.Embed(testContext, endpoint, "JustAI capability probe")
			result["tested"] = true
		case "tts":
			_, _, err = provider.SynthesizeSpeech(testContext, endpoint, "JustAI capability probe", "alloy")
			result["tested"] = true
		case "tool-calling", "transcription", "realtime-transcription", "chunked-transcription", "diarization":
			// These capabilities require a live audio/tool session and cannot be
			// proven by a harmless chat request. Report them explicitly as
			// supported-but-not-probed instead of claiming success.
			result["note"] = "available for a live session; no side-effect-free probe exists"
		default:
			result["supported"] = false
			result["error"] = "unknown capability"
		}
		cancel()
		if err != nil {
			result["error"] = err.Error()
		} else if result["tested"] == true {
			result["ok"] = true
		}
		results[capability] = result
	}
	status := http.StatusOK
	for _, result := range results {
		if result["tested"] == true && result["ok"] != true {
			status = http.StatusBadGateway
			break
		}
	}
	c.JSON(status, gin.H{"ok": status == http.StatusOK, "results": results})
}

func (a *App) getEndpoint(ctx context.Context, id uuid.UUID) (models.Endpoint, error) {
	row := a.DB.QueryRowContext(ctx, `SELECT id, scope_type, scope_id, provider_type, name, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(chat_model, ''), COALESCE(embedding_model, ''), COALESCE(transcription_model, ''), COALESCE(diarization_model, ''), COALESCE(speech_model, ''), capabilities, credential_ciphertext IS NOT NULL, enabled, is_default, timeout_seconds, max_output_tokens, temperature, created_at, updated_at FROM endpoint_settings WHERE id = $1`, id)
	return scanEndpoint(row)
}

func scanEndpoint(scanner interface{ Scan(dest ...any) error }) (models.Endpoint, error) {
	var item models.Endpoint
	var scopeID sql.NullString
	var capabilities []byte
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.ProviderType, &item.Name, &item.BaseURL, &item.APIPath, &item.APIVersion, &item.ChatModel, &item.EmbeddingModel, &item.TranscriptionModel, &item.DiarizationModel, &item.SpeechModel, &capabilities, &item.CredentialConfigured, &item.Enabled, &item.IsDefault, &item.TimeoutSeconds, &item.MaxOutputTokens, &item.Temperature, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	if scopeID.Valid {
		parsed, err := uuid.Parse(scopeID.String)
		if err == nil {
			item.ScopeID = &parsed
		}
	}
	item.Capabilities = json.RawMessage(capabilities)
	return item, nil
}

func (a *App) providerEndpoint(ctx context.Context, id uuid.UUID) (provider.Endpoint, error) {
	var endpoint provider.Endpoint
	var credential []byte
	var capabilities []byte
	err := a.DB.QueryRowContext(ctx, `SELECT provider_type, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(chat_model, ''), COALESCE(embedding_model, ''), COALESCE(transcription_model, ''), COALESCE(diarization_model, ''), COALESCE(speech_model, ''), capabilities, credential_ciphertext, timeout_seconds, max_output_tokens, temperature FROM endpoint_settings WHERE id = $1 AND enabled = TRUE`, id).Scan(&endpoint.ProviderType, &endpoint.BaseURL, &endpoint.APIPath, &endpoint.APIVersion, &endpoint.ChatModel, &endpoint.EmbeddingModel, &endpoint.TranscriptionModel, &endpoint.DiarizationModel, &endpoint.SpeechModel, &capabilities, &credential, &endpoint.TimeoutSeconds, &endpoint.MaxOutputTokens, &endpoint.Temperature)
	if err != nil {
		return endpoint, err
	}
	_ = json.Unmarshal(capabilities, &endpoint.Capabilities)
	if len(credential) > 0 {
		endpoint.Credential, err = a.Secrets.Decrypt(credential)
		if err != nil {
			return endpoint, fmt.Errorf("could not decrypt endpoint credential")
		}
	}
	return endpoint, nil
}

func (a *App) authorizeEndpointScope(c *gin.Context, scopeType string, principal middleware.Principal, organizationID uuid.UUID) (any, error) {
	switch scopeType {
	case "global":
		if !principal.PlatformAdmin {
			return nil, fmt.Errorf("global endpoints require platform admin access")
		}
		return nil, nil
	case "organization":
		if role := middleware.GetOrganizationRole(c); role != "owner" && role != "admin" && !principal.PlatformAdmin {
			return nil, fmt.Errorf("organization endpoints require owner or admin access")
		}
		return organizationID, nil
	case "user":
		return principal.UserID, nil
	default:
		return nil, fmt.Errorf("scopeType must be global, organization, or user")
	}
}

func (a *App) canManageEndpoint(item models.Endpoint, principal middleware.Principal, organizationID uuid.UUID, role string) error {
	if err := a.canUseEndpoint(item, principal, organizationID); err != nil {
		return err
	}
	if item.ScopeType == "user" && item.ScopeID != nil && *item.ScopeID == principal.UserID {
		return nil
	}
	if item.ScopeType == "organization" {
		if role == "owner" || role == "admin" || principal.PlatformAdmin {
			return nil
		}
		return fmt.Errorf("organization endpoints require owner or admin access")
	}
	if item.ScopeType == "global" && principal.PlatformAdmin {
		return nil
	}
	return fmt.Errorf("endpoint cannot be managed by this user")
}

func (a *App) canUseEndpoint(item models.Endpoint, principal middleware.Principal, organizationID uuid.UUID) error {
	if item.ScopeType == "global" {
		return nil
	}
	if item.ScopeType == "user" && item.ScopeID != nil && *item.ScopeID != principal.UserID {
		return fmt.Errorf("endpoint belongs to another user")
	}
	if item.ScopeType == "organization" && (item.ScopeID == nil || *item.ScopeID != organizationID) {
		return fmt.Errorf("endpoint belongs to another organization")
	}
	return nil
}

func validateEndpointRequest(request *endpointRequest) error {
	supported := map[string]bool{"mock": true, "openai": true, "openai-compatible": true, "gemini": true, "anthropic": true, "ollama": true}
	if !supported[request.ProviderType] {
		return fmt.Errorf("unsupported provider type")
	}
	if request.Name == "" {
		return fmt.Errorf("endpoint name is required")
	}
	if request.BaseURL == "" {
		switch request.ProviderType {
		case "openai":
			request.BaseURL = "https://api.openai.com/v1"
		case "gemini":
			request.BaseURL = "https://generativelanguage.googleapis.com"
		case "anthropic":
			request.BaseURL = "https://api.anthropic.com"
		case "ollama":
			request.BaseURL = "http://localhost:11434"
		case "mock":
			request.BaseURL = "http://mock.local"
		default:
			return fmt.Errorf("base URL is required for this provider")
		}
	}
	return nil
}

func validateProviderCapabilities(providerType string, capabilities map[string]bool) error {
	allowed := map[string]map[string]bool{
		"mock":              {"chat": true},
		"openai":            {"chat": true, "embeddings": true, "transcription": true, "realtime-transcription": true, "diarization": true, "tool-calling": true, "tts": true},
		"openai-compatible": {"chat": true, "embeddings": true, "transcription": true, "realtime-transcription": true, "chunked-transcription": true, "diarization": true, "tool-calling": true, "tts": true},
		"gemini":            {"chat": true, "embeddings": true, "transcription": true, "realtime-transcription": true, "diarization": true},
		"anthropic":         {"chat": true},
		"ollama":            {"chat": true, "embeddings": true},
	}
	for capability, enabled := range capabilities {
		if enabled && !allowed[providerType][capability] {
			return fmt.Errorf("provider %s does not support capability %s", providerType, capability)
		}
	}
	return nil
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func boolValue(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func intValue(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

func floatValue(value, fallback float64) float64 {
	if value == 0 {
		return fallback
	}
	return value
}
