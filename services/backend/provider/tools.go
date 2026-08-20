package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ToolDefinition is the provider-neutral tool shape used by the voice turn
// runner. Parameters must be a JSON Schema object supplied by MCP.
type ToolDefinition struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

type ToolCall struct {
	ID        string
	Name      string
	Arguments string
}

type ToolMessage struct {
	Role         string
	Content      string
	ContentParts []MessageContentPart
	ToolCallID   string
	ToolCalls    []ToolCall
}

type ToolChatOptions struct {
	Messages []ToolMessage
	Tools    []ToolDefinition
	Model    string
	OnUsage  UsageFunc
}

type ToolChatEvent struct {
	Delta     string
	ToolCalls []ToolCall
}

// SupportsToolCalling reports the provider transports implemented by the
// normalized tool-call adapter. OpenAI-compatible gateways must explicitly
// advertise the capability because not every gateway exposes function calls.
func SupportsToolCalling(endpoint Endpoint) bool {
	if endpoint.ProviderType == "openai" {
		// Native OpenAI supports tools by default for legacy endpoint records,
		// while an explicit false flag remains an intentional opt-out.
		if enabled, declared := endpoint.Capabilities["tool-calling"]; declared {
			return enabled
		}
		return true
	}
	return endpoint.ProviderType == "openai-compatible" && endpoint.Capabilities["tool-calling"]
}

// StreamChatWithTools streams an OpenAI Chat Completions response and
// normalizes streamed text and tool calls for the server turn runner.
func StreamChatWithTools(ctx context.Context, endpoint Endpoint, options ToolChatOptions, onEvent func(ToolChatEvent) error) error {
	if !SupportsToolCalling(endpoint) {
		return fmt.Errorf("provider %s does not expose compatible tool calling", endpoint.ProviderType)
	}

	messages := make([]map[string]any, 0, len(options.Messages))
	for _, message := range options.Messages {
		content := openAIMessageContent(Message{Content: message.Content, ContentParts: message.ContentParts})
		// OpenAI-compatible gateways commonly expect an assistant tool-call
		// message to have a JSON null content value. Sending an empty string (or
		// pre-tool narration) is accepted by some gateways but makes others
		// return an empty follow-up after the tool result. The narration was
		// already streamed to the user, so it does not need to be replayed here.
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			content = nil
		}
		item := map[string]any{
			"role":    message.Role,
			"content": content,
		}
		if message.ToolCallID != "" {
			item["tool_call_id"] = message.ToolCallID
		}
		if len(message.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(message.ToolCalls))
			for _, call := range message.ToolCalls {
				calls = append(calls, map[string]any{
					"id":   call.ID,
					"type": "function",
					"function": map[string]any{
						"name":      call.Name,
						"arguments": call.Arguments,
					},
				})
			}
			item["tool_calls"] = calls
		}
		messages = append(messages, item)
	}

	tools := make([]map[string]any, 0, len(options.Tools))
	for _, tool := range options.Tools {
		parameters := tool.Parameters
		if len(parameters) == 0 {
			parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  json.RawMessage(parameters),
			},
		})
	}

	payload := map[string]any{
		"model":       firstNonEmpty(options.Model, endpoint.ChatModel, "gpt-4o-mini"),
		"messages":    messages,
		"tools":       tools,
		"tool_choice": "auto",
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

	type accumulator struct {
		ID        string
		Name      string
		Arguments strings.Builder
	}
	type toolCallChunk struct {
		Index    int    `json:"index"`
		ID       string `json:"id"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	accumulators := map[int]*accumulator{}
	seenContent := false
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
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
					Content   json.RawMessage `json:"content"`
					ToolCalls []toolCallChunk `json:"tool_calls"`
				} `json:"delta"`
				Message struct {
					Content   json.RawMessage `json:"content"`
					ToolCalls []toolCallChunk `json:"tool_calls"`
				} `json:"message"`
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
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]
		content := choice.Delta.Content
		toolCalls := choice.Delta.ToolCalls
		// A few OpenAI-compatible gateways ignore stream=true and return a
		// normal Chat Completions message. Accept that shape as well so the
		// post-tool assistant response is not silently discarded.
		if len(content) == 0 && len(toolCalls) == 0 {
			content = choice.Message.Content
			toolCalls = choice.Message.ToolCalls
		}
		if text := openAIStreamText(content); text != "" {
			seenContent = true
			if err := onEvent(ToolChatEvent{Delta: text}); err != nil {
				return err
			}
		}
		for _, call := range toolCalls {
			item := accumulators[call.Index]
			if item == nil {
				item = &accumulator{}
				accumulators[call.Index] = item
			}
			if call.ID != "" {
				item.ID = call.ID
			}
			if call.Function.Name != "" {
				item.Name = call.Function.Name
			}
			item.Arguments.WriteString(call.Function.Arguments)
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(accumulators) == 0 {
		if !seenContent {
			return fmt.Errorf("provider returned no chat content or tool calls")
		}
		return nil
	}
	indices := make([]int, 0, len(accumulators))
	for index := range accumulators {
		indices = append(indices, index)
	}
	for left := 0; left < len(indices); left++ {
		for right := left + 1; right < len(indices); right++ {
			if indices[right] < indices[left] {
				indices[left], indices[right] = indices[right], indices[left]
			}
		}
	}
	calls := make([]ToolCall, 0, len(indices))
	for _, index := range indices {
		item := accumulators[index]
		calls = append(calls, ToolCall{ID: item.ID, Name: item.Name, Arguments: item.Arguments.String()})
	}
	return onEvent(ToolChatEvent{ToolCalls: calls})
}

// openAIStreamText normalizes the string and content-array variants returned
// by OpenAI-compatible gateways. The array form is common when a gateway uses
// multimodal message serialization even for a text-only response.
func openAIStreamText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var result strings.Builder
		for _, part := range parts {
			result.WriteString(part.Text)
		}
		return result.String()
	}
	var part struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &part) == nil {
		return part.Text
	}
	return ""
}

// SynthesizeSpeech uses the OpenAI-compatible audio speech contract and keeps
// provider credentials on the backend.
func SynthesizeSpeech(ctx context.Context, endpoint Endpoint, text, voice string) ([]byte, string, error) {
	if endpoint.ProviderType != "openai" && endpoint.ProviderType != "openai-compatible" {
		return nil, "", fmt.Errorf("provider %s does not expose compatible text to speech", endpoint.ProviderType)
	}
	payload := map[string]any{
		"model":           firstNonEmpty(endpoint.SpeechModel, "gpt-4o-mini-tts"),
		"voice":           firstNonEmpty(voice, "alloy"),
		"input":           text,
		"response_format": "mp3",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/audio/speech"), bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, "", responseError(response)
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "audio/mpeg"
	}
	data := make([]byte, 0, 64*1024)
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			data = append(data, buffer[:count]...)
			if len(data) > 12*1024*1024 {
				return nil, "", fmt.Errorf("speech response is too large")
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, "", readErr
		}
	}
	return data, contentType, nil
}
