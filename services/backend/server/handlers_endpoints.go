package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

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
		{"id": "openai", "name": "OpenAI", "kind": "native", "capabilities": []string{"chat", "embeddings", "transcription"}},
		{"id": "gemini", "name": "Google Gemini", "kind": "native", "capabilities": []string{"chat", "embeddings"}},
		{"id": "anthropic", "name": "Anthropic", "kind": "native", "capabilities": []string{"chat"}},
		{"id": "ollama", "name": "Ollama", "kind": "local", "capabilities": []string{"chat", "embeddings"}},
		{"id": "openai-compatible", "name": "OpenAI-compatible", "kind": "gateway", "examples": []string{"LiteLLM", "vLLM", "LM Studio", "OpenRouter"}, "capabilities": []string{"chat", "embeddings", "transcription"}},
		{"id": "mock", "name": "JustAI demo", "kind": "local", "capabilities": []string{"chat"}},
	}})
}

func (a *App) listEndpoints(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, scope_type, scope_id, provider_type, name, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(chat_model, ''), COALESCE(embedding_model, ''), COALESCE(transcription_model, ''), capabilities, credential_ciphertext IS NOT NULL, enabled, is_default, timeout_seconds, max_output_tokens, temperature, created_at, updated_at FROM endpoint_settings WHERE (scope_type = 'global') OR (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) ORDER BY is_default DESC, created_at DESC`, organizationID, principal.UserID)
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
	credential, err := a.Secrets.Encrypt(request.Credential)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	capabilities := request.Capabilities
	if capabilities == nil {
		capabilities = map[string]bool{"chat": true}
	}
	isDefault := request.IsDefault != nil && *request.IsDefault
	if isDefault {
		_, _ = a.DB.ExecContext(c, `UPDATE endpoint_settings SET is_default = FALSE WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2`, scopeType, scopeID)
	}
	var id uuid.UUID
	err = a.DB.QueryRowContext(c, `INSERT INTO endpoint_settings (scope_type, scope_id, provider_type, name, base_url, api_path, api_version, chat_model, embedding_model, transcription_model, capabilities, credential_ciphertext, enabled, is_default, timeout_seconds, max_output_tokens, temperature, created_by) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`, scopeType, scopeID, request.ProviderType, request.Name, request.BaseURL, request.APIPath, request.APIVersion, request.ChatModel, request.EmbeddingModel, request.TranscriptionModel, jsonRaw(capabilities), nullableBytes(credential), boolValue(request.Enabled, true), isDefault, intValue(request.TimeoutSeconds, 120), intValue(request.MaxOutputTokens, 2048), floatValue(request.Temperature, 0.2), principal.UserID).Scan(&id)
	if err != nil {
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
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	current, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
		return
	}
	if err := a.canManageEndpoint(current, principal, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
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
		capabilities = jsonRaw(request.Capabilities)
	}
	_, err = a.DB.ExecContext(c, `UPDATE endpoint_settings SET provider_type = $2, name = $3, base_url = $4, api_path = NULLIF($5, ''), api_version = NULLIF($6, ''), chat_model = NULLIF($7, ''), embedding_model = NULLIF($8, ''), transcription_model = NULLIF($9, ''), capabilities = $10, credential_ciphertext = COALESCE($11, credential_ciphertext), enabled = $12, is_default = $13, timeout_seconds = $14, max_output_tokens = $15, temperature = $16, updated_at = now() WHERE id = $1`, id, request.ProviderType, request.Name, request.BaseURL, request.APIPath, request.APIVersion, request.ChatModel, request.EmbeddingModel, request.TranscriptionModel, capabilities, encrypted, boolValue(request.Enabled, current.Enabled), boolValue(request.IsDefault, current.IsDefault), intValue(request.TimeoutSeconds, current.TimeoutSeconds), intValue(request.MaxOutputTokens, current.MaxOutputTokens), floatValue(request.Temperature, current.Temperature))
	if err != nil {
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
	if err := a.canManageEndpoint(current, principal, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM endpoint_settings WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
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
	if err := provider.Test(c, endpoint); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *App) getEndpoint(ctx context.Context, id uuid.UUID) (models.Endpoint, error) {
	row := a.DB.QueryRowContext(ctx, `SELECT id, scope_type, scope_id, provider_type, name, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(chat_model, ''), COALESCE(embedding_model, ''), COALESCE(transcription_model, ''), capabilities, credential_ciphertext IS NOT NULL, enabled, is_default, timeout_seconds, max_output_tokens, temperature, created_at, updated_at FROM endpoint_settings WHERE id = $1`, id)
	return scanEndpoint(row)
}

func scanEndpoint(scanner interface{ Scan(dest ...any) error }) (models.Endpoint, error) {
	var item models.Endpoint
	var scopeID sql.NullString
	var capabilities []byte
	if err := scanner.Scan(&item.ID, &item.ScopeType, &scopeID, &item.ProviderType, &item.Name, &item.BaseURL, &item.APIPath, &item.APIVersion, &item.ChatModel, &item.EmbeddingModel, &item.TranscriptionModel, &capabilities, &item.CredentialConfigured, &item.Enabled, &item.IsDefault, &item.TimeoutSeconds, &item.MaxOutputTokens, &item.Temperature, &item.CreatedAt, &item.UpdatedAt); err != nil {
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
	err := a.DB.QueryRowContext(ctx, `SELECT provider_type, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(chat_model, ''), COALESCE(embedding_model, ''), COALESCE(transcription_model, ''), credential_ciphertext, timeout_seconds, max_output_tokens, temperature FROM endpoint_settings WHERE id = $1 AND enabled = TRUE`, id).Scan(&endpoint.ProviderType, &endpoint.BaseURL, &endpoint.APIPath, &endpoint.APIVersion, &endpoint.ChatModel, &endpoint.EmbeddingModel, &endpoint.TranscriptionModel, &credential, &endpoint.TimeoutSeconds, &endpoint.MaxOutputTokens, &endpoint.Temperature)
	if err != nil {
		return endpoint, err
	}
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
		return organizationID, nil
	case "user":
		return principal.UserID, nil
	default:
		return nil, fmt.Errorf("scopeType must be global, organization, or user")
	}
}

func (a *App) canManageEndpoint(item models.Endpoint, principal middleware.Principal, organizationID uuid.UUID) error {
	if err := a.canUseEndpoint(item, principal, organizationID); err != nil {
		return err
	}
	if item.ScopeType == "user" && item.ScopeID != nil && *item.ScopeID == principal.UserID {
		return nil
	}
	return nil
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
