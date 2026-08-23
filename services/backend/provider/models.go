package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// ChatModel is the provider-neutral model shape exposed to the endpoint and
// chat model pickers. ID is always the value that should be sent back to the
// provider; the other fields are optional display metadata.
type ChatModel struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	OwnedBy string `json:"ownedBy,omitempty"`
}

// DiscoverChatModels asks the configured provider for its model catalog.
// Provider APIs do not consistently publish capability metadata. LiteLLM is
// handled specially through /model/info so its configured chat aliases are
// preferred; other compatible gateways fall back to their standard /models
// response. The configured model remains available as a fallback when a
// gateway does not expose a catalog.
func DiscoverChatModels(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	switch endpoint.ProviderType {
	case "mock":
		return configuredModelFallback(endpoint, "justai-demo"), nil
	case "openai", "openai-compatible":
		return discoverOpenAIModels(ctx, endpoint)
	case "ollama":
		return discoverOllamaModels(ctx, endpoint)
	case "gemini":
		return discoverGeminiModels(ctx, endpoint)
	case "anthropic":
		return discoverAnthropicModels(ctx, endpoint)
	default:
		return nil, fmt.Errorf("provider %s does not support model discovery", endpoint.ProviderType)
	}
}

// Probe performs a safe provider reachability check for endpoint setup. Model
// catalogs are the least invasive probe for API-backed providers. Pyannote has
// a dedicated health endpoint because a real diarization request requires
// media and would be inappropriate during configuration.
func Probe(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	if endpoint.ProviderType != "pyannote" {
		return DiscoverChatModels(ctx, endpoint)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, joinURL(endpoint, "/healthz"), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds, endpoint.AllowPrivate)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	return nil, nil
}

func discoverOpenAIModels(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	// LiteLLM's OpenAI-compatible /models route can intentionally include the
	// provider's built-in model catalog (for example when infer_model_from_keys
	// is enabled), not just the deployments in model_list. Its stable
	// /model/info route is the authoritative configured deployment list, so use
	// it before falling back to the standard OpenAI catalog.
	if endpoint.ProviderType == "openai-compatible" {
		if models, err := discoverLiteLLMModels(ctx, endpoint); err == nil && len(models) > 0 {
			return normalizeModels(models, endpoint.ChatModel), nil
		}
	}
	var payload struct {
		Data []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := requestModelCatalog(ctx, endpoint, "/models", &payload); err != nil {
		return nil, err
	}
	models := make([]ChatModel, 0, len(payload.Data))
	for _, item := range payload.Data {
		models = append(models, ChatModel{ID: item.ID, Name: item.Name, OwnedBy: item.OwnedBy})
	}
	return normalizeModels(models, endpoint.ChatModel), nil
}

func discoverLiteLLMModels(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	var payload struct {
		Data []struct {
			ModelName string `json:"model_name"`
			ID        string `json:"id"`
			ModelInfo struct {
				ID   string `json:"id"`
				Mode string `json:"mode"`
			} `json:"model_info"`
		} `json:"data"`
	}
	// LiteLLM serves /model/info from the proxy root while many users enter an
	// OpenAI-compatible base URL ending in /v1. Try the configured path first,
	// then the proxy root, so discovery never silently falls back to a broad
	// /models catalog containing upstream provider models.
	candidates := []Endpoint{endpoint}
	base := strings.TrimRight(endpoint.BaseURL, "/")
	if strings.HasSuffix(base, "/v1") {
		root := endpoint
		root.BaseURL = strings.TrimSuffix(base, "/v1")
		candidates = append(candidates, root)
	}
	var lastErr error
	for _, candidate := range candidates {
		payload = struct {
			Data []struct {
				ModelName string `json:"model_name"`
				ID        string `json:"id"`
				ModelInfo struct {
					ID   string `json:"id"`
					Mode string `json:"mode"`
				} `json:"model_info"`
			} `json:"data"`
		}{}
		if err := requestModelCatalog(ctx, candidate, "/model/info", &payload); err != nil {
			lastErr = err
			continue
		}
		models := make([]ChatModel, 0, len(payload.Data))
		for _, item := range payload.Data {
			// LiteLLM may expose embedding/audio entries alongside chat entries.
			// Keep chat/completion/responses (and entries without mode metadata),
			// because those are the model IDs accepted by our chat transport.
			switch strings.ToLower(strings.TrimSpace(item.ModelInfo.Mode)) {
			case "embedding", "image_generation", "moderation", "rerank", "audio_transcription", "audio_speech":
				continue
			}
			id := firstNonEmpty(item.ModelName, item.ID, item.ModelInfo.ID)
			if id != "" {
				models = append(models, ChatModel{ID: id, OwnedBy: "litellm"})
			}
		}
		if len(models) > 0 {
			return models, nil
		}
		lastErr = fmt.Errorf("LiteLLM returned no configured chat models")
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("LiteLLM model discovery failed")
	}
	return nil, lastErr
}

func discoverOllamaModels(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	var payload struct {
		Models []struct {
			Name  string `json:"name"`
			Model string `json:"model"`
		} `json:"models"`
	}
	if err := requestModelCatalog(ctx, endpoint, "/api/tags", &payload); err != nil {
		return nil, err
	}
	models := make([]ChatModel, 0, len(payload.Models))
	for _, item := range payload.Models {
		id := firstNonEmpty(item.Name, item.Model)
		models = append(models, ChatModel{ID: id, Name: item.Name})
	}
	return normalizeModels(models, endpoint.ChatModel), nil
}

func discoverGeminiModels(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	var payload struct {
		Models []struct {
			Name                       string   `json:"name"`
			DisplayName                string   `json:"displayName"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if err := requestModelCatalog(ctx, endpoint, "/v1beta/models", &payload); err != nil {
		return nil, err
	}
	models := make([]ChatModel, 0, len(payload.Models))
	for _, item := range payload.Models {
		if len(item.SupportedGenerationMethods) > 0 && !contains(item.SupportedGenerationMethods, "generateContent") {
			continue
		}
		id := strings.TrimPrefix(item.Name, "models/")
		models = append(models, ChatModel{ID: id, Name: item.DisplayName})
	}
	return normalizeModels(models, endpoint.ChatModel), nil
}

func discoverAnthropicModels(ctx context.Context, endpoint Endpoint) ([]ChatModel, error) {
	var payload struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := requestModelCatalog(ctx, endpoint, "/v1/models", &payload); err != nil {
		return nil, err
	}
	models := make([]ChatModel, 0, len(payload.Data))
	for _, item := range payload.Data {
		models = append(models, ChatModel{ID: item.ID, Name: item.DisplayName, OwnedBy: "anthropic"})
	}
	return normalizeModels(models, endpoint.ChatModel), nil
}

func requestModelCatalog(ctx context.Context, endpoint Endpoint, suffix string, target any) error {
	requestURL := joinURL(endpoint, suffix)
	parsed, err := url.Parse(requestURL)
	if err != nil {
		return err
	}
	if endpoint.ProviderType == "gemini" && strings.TrimSpace(endpoint.Credential) != "" {
		query := parsed.Query()
		query.Set("key", endpoint.Credential)
		parsed.RawQuery = query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	switch endpoint.ProviderType {
	case "openai", "openai-compatible":
		if endpoint.Credential != "" {
			request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
		}
	case "anthropic":
		request.Header.Set("anthropic-version", firstNonEmpty(endpoint.APIVersion, "2023-06-01"))
		if endpoint.Credential != "" {
			request.Header.Set("x-api-key", endpoint.Credential)
		}
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds, endpoint.AllowPrivate)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return responseError(response)
	}
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		return fmt.Errorf("decode provider model catalog: %w", err)
	}
	return nil
}

func normalizeModels(models []ChatModel, configured string) []ChatModel {
	byID := make(map[string]ChatModel, len(models)+1)
	for _, model := range models {
		model.ID = strings.TrimSpace(model.ID)
		if model.ID == "" {
			continue
		}
		if existing, ok := byID[model.ID]; ok {
			if existing.Name == "" {
				existing.Name = model.Name
			}
			if existing.OwnedBy == "" {
				existing.OwnedBy = model.OwnedBy
			}
			byID[model.ID] = existing
			continue
		}
		byID[model.ID] = model
	}
	if configured = strings.TrimSpace(configured); configured != "" {
		if _, ok := byID[configured]; !ok {
			byID[configured] = ChatModel{ID: configured, Name: "Configured model"}
		}
	}
	result := make([]ChatModel, 0, len(byID))
	for _, model := range byID {
		result = append(result, model)
	}
	sort.Slice(result, func(i, j int) bool {
		return strings.ToLower(result[i].ID) < strings.ToLower(result[j].ID)
	})
	return result
}

func configuredModelFallback(endpoint Endpoint, fallback string) []ChatModel {
	return normalizeModels(nil, firstNonEmpty(endpoint.ChatModel, fallback))
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
