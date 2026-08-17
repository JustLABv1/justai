package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Endpoint struct {
	ProviderType       string
	BaseURL            string
	APIPath            string
	APIVersion         string
	Credential         string
	ChatModel          string
	VisionModel        string
	ImageModel         string
	EmbeddingModel     string
	TranscriptionModel string
	DiarizationModel   string
	SpeechModel        string
	Capabilities       map[string]bool
	TimeoutSeconds     int
	MaxOutputTokens    int
	Temperature        float64
}

type Message struct {
	Role         string
	Content      string
	ContentParts []MessageContentPart
}

type MessageContentPart struct {
	Type     string
	Text     string
	ImageURL *MessageImageURL
}

type MessageImageURL struct {
	URL    string
	Detail string
}

type ChatOptions struct {
	Messages []Message
	Model    string
	OnUsage  UsageFunc
}

type DeltaFunc func(string) error

// Usage is provider-reported token accounting. Providers are allowed to omit
// it, so zero values mean "not supplied" rather than zero-cost execution.
type Usage struct {
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
}

type UsageFunc func(Usage)

func Embed(ctx context.Context, endpoint Endpoint, input string) ([]float64, error) {
	if strings.TrimSpace(input) == "" {
		return nil, fmt.Errorf("embedding input is empty")
	}
	switch endpoint.ProviderType {
	case "openai", "openai-compatible":
		return embedOpenAI(ctx, endpoint, input)
	case "ollama":
		return embedOllama(ctx, endpoint, input)
	case "gemini":
		return embedGemini(ctx, endpoint, input)
	default:
		return nil, fmt.Errorf("provider %s does not expose an embedding adapter", endpoint.ProviderType)
	}
}

func StreamChat(ctx context.Context, endpoint Endpoint, options ChatOptions, onDelta DeltaFunc) error {
	if endpoint.ProviderType == "mock" {
		for _, chunk := range []string{"JustAI is ready. ", "Connect an endpoint to stream responses from OpenAI, Gemini, Anthropic, Ollama, or any OpenAI-compatible gateway."} {
			if err := onDelta(chunk); err != nil {
				return err
			}
			time.Sleep(20 * time.Millisecond)
		}
		return nil
	}
	switch endpoint.ProviderType {
	case "openai", "openai-compatible":
		return streamOpenAI(ctx, endpoint, options, onDelta)
	case "ollama":
		return streamOllama(ctx, endpoint, options, onDelta)
	case "gemini":
		return chatGemini(ctx, endpoint, options, onDelta)
	case "anthropic":
		return chatAnthropic(ctx, endpoint, options, onDelta)
	default:
		return fmt.Errorf("unsupported provider: %s", endpoint.ProviderType)
	}
}

// SupportsVision is deliberately capability-driven. Native providers may
// support image input, but an endpoint must explicitly opt in so a gateway
// configured with a text-only model never receives an image part by accident.
func SupportsVision(endpoint Endpoint) bool {
	return endpoint.Capabilities["vision"] || endpoint.Capabilities["multimodal"]
}

func Test(ctx context.Context, endpoint Endpoint) error {
	seen := false
	err := StreamChat(ctx, endpoint, ChatOptions{Messages: []Message{{Role: "user", Content: "Reply with the word ready."}}}, func(_ string) error {
		seen = true
		return nil
	})
	if err != nil {
		return err
	}
	if !seen {
		return fmt.Errorf("provider returned no content")
	}
	return nil
}

func streamOpenAI(ctx context.Context, endpoint Endpoint, options ChatOptions, onDelta DeltaFunc) error {
	messages := make([]map[string]any, 0, len(options.Messages))
	for _, message := range options.Messages {
		messages = append(messages, map[string]any{
			"role":    message.Role,
			"content": openAIMessageContent(message),
		})
	}
	payload := map[string]any{
		"model":       firstNonEmpty(options.Model, endpoint.ChatModel, "gpt-4o-mini"),
		"messages":    messages,
		"stream":      true,
		"temperature": endpoint.Temperature,
		"max_tokens":  endpoint.MaxOutputTokens,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/chat/completions"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return responseError(response)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	seenContent := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line == "data: [DONE]" {
			continue
		}
		if strings.HasPrefix(line, "data:") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
				TotalTokens      int64 `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil && options.OnUsage != nil {
			options.OnUsage(Usage{InputTokens: chunk.Usage.PromptTokens, OutputTokens: chunk.Usage.CompletionTokens, TotalTokens: chunk.Usage.TotalTokens})
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			seenContent = true
			if err := onDelta(chunk.Choices[0].Delta.Content); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !seenContent {
		return fmt.Errorf("provider returned no chat content")
	}
	return nil
}

func embedOpenAI(ctx context.Context, endpoint Endpoint, input string) ([]float64, error) {
	payload := map[string]any{"model": firstNonEmpty(endpoint.EmbeddingModel, "text-embedding-3-small"), "input": input}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/embeddings"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	var result struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	if len(result.Data) == 0 || len(result.Data[0].Embedding) == 0 {
		return nil, fmt.Errorf("embedding provider returned no vector")
	}
	return result.Data[0].Embedding, nil
}

func embedOllama(ctx context.Context, endpoint Endpoint, input string) ([]float64, error) {
	payload := map[string]any{"model": firstNonEmpty(endpoint.EmbeddingModel, endpoint.ChatModel, "nomic-embed-text"), "prompt": input}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/api/embeddings"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	var result struct {
		Embedding []float64 `json:"embedding"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	if len(result.Embedding) == 0 {
		return nil, fmt.Errorf("ollama returned no vector")
	}
	return result.Embedding, nil
}

func embedGemini(ctx context.Context, endpoint Endpoint, input string) ([]float64, error) {
	payload := map[string]any{"content": map[string]any{"parts": []map[string]string{{"text": input}}}}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	model := firstNonEmpty(endpoint.EmbeddingModel, "text-embedding-004")
	requestURL := joinURL(endpoint, "/v1beta/models/"+url.PathEscape(model)+":embedContent")
	parsed, err := url.Parse(requestURL)
	if err != nil {
		return nil, err
	}
	query := parsed.Query()
	query.Set("key", endpoint.Credential)
	parsed.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	var result struct {
		Embedding struct {
			Values []float64 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	if len(result.Embedding.Values) == 0 {
		return nil, fmt.Errorf("gemini returned no vector")
	}
	return result.Embedding.Values, nil
}

func streamOllama(ctx context.Context, endpoint Endpoint, options ChatOptions, onDelta DeltaFunc) error {
	messages := make([]map[string]any, 0, len(options.Messages))
	for _, message := range options.Messages {
		item := map[string]any{"role": message.Role, "content": message.Content}
		if len(message.ContentParts) > 0 {
			images := make([]string, 0, len(message.ContentParts))
			for _, part := range message.ContentParts {
				if part.ImageURL == nil {
					continue
				}
				if _, data, err := decodeImageDataURL(part.ImageURL.URL); err == nil {
					images = append(images, data)
				}
			}
			if len(images) > 0 {
				item["images"] = images
			}
		}
		messages = append(messages, item)
	}
	payload := map[string]any{
		"model":    firstNonEmpty(options.Model, endpoint.ChatModel, "llama3.2"),
		"messages": messages,
		"stream":   true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/api/chat"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return responseError(response)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		var chunk struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			continue
		}
		if chunk.Message.Content != "" {
			if err := onDelta(chunk.Message.Content); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func chatGemini(ctx context.Context, endpoint Endpoint, options ChatOptions, onDelta DeltaFunc) error {
	contents := make([]map[string]any, 0, len(options.Messages))
	for _, message := range options.Messages {
		role := "user"
		if message.Role == "assistant" {
			role = "model"
		}
		contents = append(contents, map[string]any{"role": role, "parts": geminiMessageParts(message)})
	}
	payload := map[string]any{
		"contents": contents,
		"generationConfig": map[string]any{
			"temperature":     endpoint.Temperature,
			"maxOutputTokens": endpoint.MaxOutputTokens,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	model := firstNonEmpty(options.Model, endpoint.ChatModel, "gemini-2.5-flash")
	requestURL := joinURL(endpoint, "/v1beta/models/"+url.PathEscape(model)+":generateContent")
	parsed, err := url.Parse(requestURL)
	if err != nil {
		return err
	}
	query := parsed.Query()
	query.Set("key", endpoint.Credential)
	parsed.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return responseError(response)
	}
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return err
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return fmt.Errorf("gemini returned no content")
	}
	return onDelta(result.Candidates[0].Content.Parts[0].Text)
}

func chatAnthropic(ctx context.Context, endpoint Endpoint, options ChatOptions, onDelta DeltaFunc) error {
	messages := make([]map[string]any, 0, len(options.Messages))
	for _, message := range options.Messages {
		messages = append(messages, map[string]any{
			"role":    message.Role,
			"content": anthropicMessageContent(message),
		})
	}
	payload := map[string]any{
		"model":       firstNonEmpty(options.Model, endpoint.ChatModel, "claude-3-5-haiku-latest"),
		"messages":    messages,
		"max_tokens":  endpoint.MaxOutputTokens,
		"temperature": endpoint.Temperature,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/v1/messages"), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("anthropic-version", firstNonEmpty(endpoint.APIVersion, "2023-06-01"))
	if endpoint.Credential != "" {
		request.Header.Set("x-api-key", endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return responseError(response)
	}
	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return err
	}
	if len(result.Content) == 0 {
		return fmt.Errorf("anthropic returned no content")
	}
	return onDelta(result.Content[0].Text)
}

func openAIMessageContent(message Message) any {
	if len(message.ContentParts) == 0 {
		return message.Content
	}
	parts := make([]map[string]any, 0, len(message.ContentParts)+1)
	if strings.TrimSpace(message.Content) != "" {
		parts = append(parts, map[string]any{"type": "text", "text": message.Content})
	}
	for _, part := range message.ContentParts {
		switch part.Type {
		case "text":
			if strings.TrimSpace(part.Text) != "" {
				parts = append(parts, map[string]any{"type": "text", "text": part.Text})
			}
		case "image_url":
			if part.ImageURL != nil && part.ImageURL.URL != "" {
				imageURL := map[string]any{"url": part.ImageURL.URL}
				if part.ImageURL.Detail != "" {
					imageURL["detail"] = part.ImageURL.Detail
				}
				parts = append(parts, map[string]any{"type": "image_url", "image_url": imageURL})
			}
		}
	}
	return parts
}

func geminiMessageParts(message Message) []map[string]any {
	parts := make([]map[string]any, 0, len(message.ContentParts)+1)
	if strings.TrimSpace(message.Content) != "" {
		parts = append(parts, map[string]any{"text": message.Content})
	}
	for _, part := range message.ContentParts {
		switch part.Type {
		case "text":
			if strings.TrimSpace(part.Text) != "" {
				parts = append(parts, map[string]any{"text": part.Text})
			}
		case "image_url":
			if part.ImageURL == nil {
				continue
			}
			mimeType, data, err := decodeImageDataURL(part.ImageURL.URL)
			if err == nil {
				parts = append(parts, map[string]any{"inline_data": map[string]string{"mime_type": mimeType, "data": data}})
			}
		}
	}
	return parts
}

func anthropicMessageContent(message Message) any {
	if len(message.ContentParts) == 0 {
		return message.Content
	}
	parts := make([]map[string]any, 0, len(message.ContentParts)+1)
	if strings.TrimSpace(message.Content) != "" {
		parts = append(parts, map[string]any{"type": "text", "text": message.Content})
	}
	for _, part := range message.ContentParts {
		switch part.Type {
		case "text":
			if strings.TrimSpace(part.Text) != "" {
				parts = append(parts, map[string]any{"type": "text", "text": part.Text})
			}
		case "image_url":
			if part.ImageURL == nil {
				continue
			}
			mediaType, data, err := decodeImageDataURL(part.ImageURL.URL)
			if err == nil {
				parts = append(parts, map[string]any{
					"type":   "image",
					"source": map[string]string{"type": "base64", "media_type": mediaType, "data": data},
				})
			}
		}
	}
	return parts
}

func decodeImageDataURL(value string) (string, string, error) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", fmt.Errorf("image must be a data URL")
	}
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasSuffix(header, ";base64") {
		return "", "", fmt.Errorf("image data URL must be base64 encoded")
	}
	mimeType := strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64"), ";")
	if !strings.HasPrefix(mimeType, "image/") {
		return "", "", fmt.Errorf("image data URL has an invalid MIME type")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", fmt.Errorf("image data URL is invalid: %w", err)
	}
	return mimeType, base64.StdEncoding.EncodeToString(data), nil
}

func doRequest(request *http.Request, timeoutSeconds int) (*http.Response, error) {
	timeout := time.Duration(timeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	return client.Do(request)
}

func responseError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	return fmt.Errorf("provider request failed (%d): %s", response.StatusCode, strings.TrimSpace(string(body)))
}

func joinURL(endpoint Endpoint, suffix string) string {
	base := strings.TrimRight(endpoint.BaseURL, "/")
	path := strings.Trim(endpoint.APIPath, "/")
	if path != "" && !strings.HasSuffix(base, "/"+path) {
		base += "/" + path
	}
	return base + "/" + strings.TrimLeft(suffix, "/")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
