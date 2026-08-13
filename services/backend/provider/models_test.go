package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDiscoverOpenAICompatibleModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v1/model/info" || request.URL.Path == "/model/info" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		if request.Method != http.MethodGet || request.URL.Path != "/v1/models" {
			t.Fatalf("unexpected model request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("missing authorization header")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":[{"id":"zeta","owned_by":"team"},{"id":"alpha"}]}`))
	}))
	defer server.Close()

	models, err := DiscoverChatModels(context.Background(), Endpoint{
		ProviderType: "openai-compatible",
		BaseURL:      server.URL + "/v1",
		Credential:   "secret",
		ChatModel:    "configured-model",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 3 || models[0].ID != "alpha" || models[1].ID != "configured-model" || models[2].ID != "zeta" {
		t.Fatalf("unexpected models: %+v", models)
	}
}

func TestDiscoverOpenAICompatibleModelsUsesLiteLLMConfiguredAliases(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/model/info" {
			t.Fatalf("unexpected LiteLLM model path: %s", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":[{"model_name":"local-gemma","litellm_params":{"model":"openai/gemma-3-27b-it"},"model_info":{"mode":"chat"}},{"model_name":"local-embedder","model_info":{"mode":"embedding"}}]}`))
	}))
	defer server.Close()

	models, err := DiscoverChatModels(context.Background(), Endpoint{
		ProviderType: "openai-compatible",
		BaseURL:      server.URL + "/v1",
		ChatModel:    "local-gemma",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "local-gemma" {
		t.Fatalf("expected only configured LiteLLM chat alias, got %+v", models)
	}
}

func TestDiscoverOpenAICompatibleModelsTriesLiteLLMProxyRoot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/model/info":
			writer.WriteHeader(http.StatusNotFound)
		case "/model/info":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"data":[{"model_name":"local-gemma","model_info":{"mode":"chat"}}]}`))
		default:
			t.Fatalf("unexpected LiteLLM model path: %s", request.URL.Path)
		}
	}))
	defer server.Close()

	models, err := DiscoverChatModels(context.Background(), Endpoint{
		ProviderType: "openai-compatible",
		BaseURL:      server.URL + "/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "local-gemma" {
		t.Fatalf("expected configured LiteLLM proxy-root alias, got %+v", models)
	}
}

func TestDiscoverOllamaModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/tags" {
			t.Fatalf("unexpected model path: %s", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"models":[{"name":"llama3.2:latest","model":"llama3.2:latest"}]}`))
	}))
	defer server.Close()

	models, err := DiscoverChatModels(context.Background(), Endpoint{
		ProviderType: "ollama",
		BaseURL:      server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "llama3.2:latest" {
		t.Fatalf("unexpected models: %+v", models)
	}
}

func TestDiscoverGeminiModelsFiltersNonGenerationModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1beta/models" || request.URL.Query().Get("key") != "secret" {
			t.Fatalf("unexpected Gemini model request: %s", request.URL.String())
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"models":[{"name":"models/gemini-2.5-flash","displayName":"Gemini Flash","supportedGenerationMethods":["generateContent"]},{"name":"models/embedding-001","supportedGenerationMethods":["embedContent"]}]}`))
	}))
	defer server.Close()

	models, err := DiscoverChatModels(context.Background(), Endpoint{
		ProviderType: "gemini",
		BaseURL:      server.URL,
		Credential:   "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "gemini-2.5-flash" || models[0].Name != "Gemini Flash" {
		t.Fatalf("unexpected models: %+v", models)
	}
}
