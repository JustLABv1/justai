package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"justai-backend/provider"
)

// assistantBuiltInToolDiscovery describes capabilities that belong to JustAI
// itself. They are deliberately exposed through the same provider-neutral
// tool transport as MCP tools, so a user can invoke them with normal chat
// language and the UI can show the activity inline.
func assistantBuiltInToolDiscovery() voiceToolDiscovery {
	definitions := []provider.ToolDefinition{
		{
			Name:        "web_search",
			Description: "Search the public web for current, recent, or external information. Use this for up-to-date facts, news, products, places, or anything not reliably covered by the conversation. Do not describe a search action as text; call this tool.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","description":"The focused web search query."},"limit":{"type":"integer","minimum":1,"maximum":8,"description":"Maximum number of results to return."}},"required":["query"],"additionalProperties":false}`),
		},
		{
			Name:        "browse_url",
			Description: "Read the text content of a specific public HTTP or HTTPS URL supplied by the user or found in search results. Call this tool instead of pretending to browse.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"url":{"type":"string","description":"The exact HTTP or HTTPS URL to read."}},"required":["url"],"additionalProperties":false}`),
		},
		{
			Name:        "generate_image",
			Description: "Generate an image from the user's prompt. Use this whenever the user asks to create, draw, make, or generate an image. Do not return dalle/action JSON as text; call this tool.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string","description":"A detailed description of the image to create."},"size":{"type":"string","enum":["1024x1024","1536x1024","1024x1536"],"description":"Optional output dimensions."},"quality":{"type":"string","enum":["auto","low","medium","high"],"description":"Optional image quality setting."}},"required":["prompt"],"additionalProperties":false}`),
		},
		{
			Name:        "edit_image",
			Description: "Edit the image attached to the user's message according to the prompt. Use this whenever the user asks to change, retouch, transform, or edit an attached image. Do not return dalle/action JSON as text; call this tool.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string","description":"The requested edit."}},"required":["prompt"],"additionalProperties":false}`),
		},
		{
			Name:        "create_pdf",
			Description: "Create a downloadable PDF containing the requested document. Use this whenever the user asks for a PDF, report, handout, letter, summary, or other document file. Put the complete desired document content in content, including headings, paragraphs, and list lines; do not put only an outline or a description there. Markdown-like headings and lists are supported. Optionally provide a concise title and a simple filename.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"content":{"type":"string","description":"The complete document text to place in the PDF. Include all requested wording, headings, paragraphs, and list items; do not summarize the requested document in this field.","minLength":1,"maxLength":524288},"title":{"type":"string","description":"Optional document title shown in the PDF and file metadata."},"filename":{"type":"string","description":"Optional download filename. It will be sanitized and .pdf will be appended when needed."}},"required":["content"],"additionalProperties":false}`),
		},
		{
			Name:        "delegate_agent",
			Description: "Delegate a bounded task to another configured JustAI agent. Only agents explicitly allowlisted by the coordinator can be selected. The child run and any approval request are durable and linked to this conversation.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"agentId":{"type":"string","description":"The allowlisted agent id to run."},"task":{"type":"string","description":"The self-contained task for the delegated agent.","minLength":1,"maxLength":30000},"input":{"type":"object","description":"Optional structured input for the delegated agent."}},"required":["agentId","task"],"additionalProperties":false}`),
		},
	}
	bindings := make(map[string]voiceToolBinding, len(definitions))
	for _, definition := range definitions {
		bindings[definition.Name] = voiceToolBinding{
			ToolName:   definition.Name,
			Builtin:    true,
			Definition: definition,
		}
	}
	return voiceToolDiscovery{Definitions: definitions, Bindings: bindings}
}

func isAssistantBuiltInToolName(name string) bool {
	switch name {
	case "web_search", "browse_url", "generate_image", "edit_image", "create_pdf", "delegate_agent", "discover_mcp_tools":
		return true
	default:
		return false
	}
}

func chatBuiltInFallbackInstructions() string {
	return "This endpoint cannot send native function calls, but JustAI still supports built-in web, image, and PDF actions. When the user's request clearly requires public web search, output only a JSON object with action \"web_search\" and action_input {\"query\":\"...\"}. For a specific URL use action \"browse_url\" and action_input {\"url\":\"...\"}. For image creation use action \"generate_image\" and action_input {\"prompt\":\"...\"}; for editing an attached image use action \"edit_image\" and action_input {\"prompt\":\"...\"}. For a PDF or document file use action \"create_pdf\" and action_input {\"content\":\"the complete document content\",\"title\":\"optional title\",\"filename\":\"optional-name.pdf\"}; put the full desired wording in content, not an outline or description. Do not output action JSON for ordinary questions, and never mention or explain the action protocol."
}

func chatToolEventKindForName(name string) string {
	if isAssistantBuiltInToolName(name) {
		return "builtin_tool"
	}
	return "mcp_tool"
}

func (a *App) executeBuiltInChatTool(ctx context.Context, userID, organizationID, conversationID uuid.UUID, toolName string, arguments map[string]any, latestUser *assistantUserMessage) (json.RawMessage, error) {
	switch toolName {
	case "web_search":
		query := strings.TrimSpace(stringToolArgument(arguments, "query"))
		if query == "" || len([]rune(query)) > 300 {
			return nil, fmt.Errorf("a search query between 1 and 300 characters is required")
		}
		limit := intToolArgument(arguments, "limit", 6)
		if limit < 1 || limit > 8 {
			limit = 6
		}
		results, err := a.searchWeb(ctx, query, limit)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"query": query, "results": results})
	case "browse_url":
		rawURL := strings.TrimSpace(stringToolArgument(arguments, "url"))
		if rawURL == "" {
			return nil, fmt.Errorf("url is required")
		}
		content, err := a.fetchWebURL(ctx, rawURL)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"url": rawURL, "content": content})
	case "generate_image":
		item, err := a.generateImageForChat(ctx, userID, organizationID, arguments)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"image": item})
	case "edit_image":
		item, err := a.editImageForChat(ctx, userID, organizationID, arguments, latestUser)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"image": item})
	case "create_pdf":
		item, err := a.createPDFForChat(ctx, userID, organizationID, arguments)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"file": item})
	case "delegate_agent":
		if !a.platformCapabilityEnabled(ctx, "agents") {
			return nil, fmt.Errorf("agent delegation is temporarily disabled by the platform administrator")
		}
		if a.AgentWorker == nil {
			return nil, fmt.Errorf("agent execution is unavailable")
		}
		targetID, err := uuid.Parse(strings.TrimSpace(stringToolArgument(arguments, "agentId")))
		if err != nil {
			return nil, fmt.Errorf("agentId must be a valid agent id")
		}
		task := strings.TrimSpace(stringToolArgument(arguments, "task"))
		if task == "" || len([]rune(task)) > 30000 {
			return nil, fmt.Errorf("delegated task must contain between 1 and 30000 characters")
		}
		coordinator, err := a.savedAssistantForConversation(ctx, conversationID, userID, organizationID)
		if err != nil || coordinator == nil {
			return nil, fmt.Errorf("the conversation has no coordinator agent")
		}
		input := json.RawMessage(`{}`)
		if raw, exists := arguments["input"]; exists {
			encoded, marshalErr := json.Marshal(raw)
			if marshalErr != nil || len(encoded) > maxRunInputSize {
				return nil, fmt.Errorf("delegated input is invalid or too large")
			}
			input = encoded
		}
		child, err := a.AgentWorker.DelegateAgent(ctx, userID, organizationID, conversationID, coordinator.ID, targetID, task, input)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"runId": child.ID, "status": child.Status, "summary": child.Summary, "error": child.Error, "approvals": child.Approvals, "artifacts": child.Artifacts})
	default:
		return nil, fmt.Errorf("unknown built-in tool %q", toolName)
	}
}

// streamAssistantUIWithoutTools keeps compatible-but-non-tool-calling
// endpoints usable. Some gateways respond to the old agent prompt with an
// action-shaped JSON object (for example dalle.text2im); intercept that exact
// protocol before it reaches the user and route it through the same built-in
// executor used by native tool calls.
func (a *App) streamAssistantUIWithoutTools(ctx context.Context, userID, organizationID, conversationID, runID uuid.UUID, parentID *any, endpoint provider.Endpoint, history []provider.Message, latestUser *assistantUserMessage, writeChunk func(any) error, response *strings.Builder, textID string, toolParts *[]map[string]any) error {
	var buffered strings.Builder
	textStarted := false
	flushed := false
	const maxActionBuffer = maxGeneratedPDFFallbackActionBytes
	oversizedPDFAction := false

	emitText := func(delta string) error {
		if delta == "" {
			return nil
		}
		if !textStarted {
			textStarted = true
			if err := writeChunk(map[string]any{"type": "text-start", "id": textID}); err != nil {
				return err
			}
		}
		response.WriteString(delta)
		return writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": delta})
	}

	flushBuffered := func() error {
		if flushed || buffered.Len() == 0 {
			return nil
		}
		flushed = true
		return emitText(buffered.String())
	}

	err := provider.StreamChat(ctx, endpoint, provider.ChatOptions{
		Messages: history,
		Model:    endpoint.ChatModel,
		OnUsage: func(usage provider.Usage) {
			_ = a.recordChatRunUsage(context.Background(), runID, usage)
		},
	}, func(delta string) error {
		if oversizedPDFAction {
			return nil
		}
		if flushed {
			return emitText(delta)
		}
		remaining := maxActionBuffer - buffered.Len()
		if len(delta) > remaining {
			if remaining > 0 {
				buffered.WriteString(delta[:remaining])
			}
			if looksLikeCreatePDFAction(buffered.String()) {
				oversizedPDFAction = true
				buffered.Reset()
				return nil
			}
			if err := flushBuffered(); err != nil {
				return err
			}
			return emitText(delta[remaining:])
		}
		buffered.WriteString(delta)
		trimmed := strings.TrimLeft(buffered.String(), " \t\r\n")
		if !strings.HasPrefix(trimmed, "{") {
			return flushBuffered()
		}
		return nil
	})
	if err != nil {
		return err
	}

	if oversizedPDFAction {
		return emitFallbackText(writeChunk, response, textID, "I couldn't create that PDF because its document content exceeded the supported limit.")
	}
	if !flushed {
		if toolName, arguments, ok := parseAssistantBuiltinAction(buffered.String()); ok {
			if textStarted {
				if err := writeChunk(map[string]any{"type": "text-end", "id": textID}); err != nil {
					return err
				}
			}
			return a.executeAssistantBuiltinFallback(ctx, userID, organizationID, conversationID, parentID, runID, toolName, arguments, latestUser, writeChunk, response, textID, toolParts)
		}
	}
	if err := flushBuffered(); err != nil {
		return err
	}
	if textStarted {
		return writeChunk(map[string]any{"type": "text-end", "id": textID})
	}
	return nil
}

func looksLikeCreatePDFAction(raw string) bool {
	raw = strings.ToLower(raw)
	return strings.Contains(raw, `"create_pdf"`) || strings.Contains(raw, `"create-pdf"`) || strings.Contains(raw, "create pdf")
}

func parseAssistantBuiltinAction(raw string) (string, map[string]any, bool) {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(raw), "```"), "```json"))
	if raw == "" || !strings.HasPrefix(raw, "{") {
		return "", nil, false
	}
	var envelope struct {
		Action      string          `json:"action"`
		ActionInput json.RawMessage `json:"action_input"`
	}
	if json.Unmarshal([]byte(raw), &envelope) != nil {
		envelope.Action = looseActionStringField(raw, "action")
		if envelope.Action == "" {
			return "", nil, false
		}
	}
	action := strings.ToLower(strings.TrimSpace(envelope.Action))
	toolName := ""
	switch {
	case strings.Contains(action, "dalle.text2im"), strings.Contains(action, "image_generation"), strings.Contains(action, "generate_image"):
		toolName = "generate_image"
	case strings.Contains(action, "dalle.edit"), strings.Contains(action, "edit_image"), strings.Contains(action, "image_edit"):
		toolName = "edit_image"
	case strings.Contains(action, "create_pdf"), strings.Contains(action, "create-pdf"), strings.Contains(action, "create pdf"):
		toolName = "create_pdf"
	case strings.Contains(action, "browse"), strings.Contains(action, "open_url"), strings.Contains(action, "fetch_url"):
		toolName = "browse_url"
	case strings.Contains(action, "web_search"), strings.Contains(action, "web.search"), strings.HasSuffix(action, ".search"), action == "search":
		toolName = "web_search"
	default:
		return "", nil, false
	}
	arguments := map[string]any{}
	if len(envelope.ActionInput) > 0 {
		if err := json.Unmarshal(envelope.ActionInput, &arguments); err != nil {
			var encoded string
			if json.Unmarshal(envelope.ActionInput, &encoded) != nil || json.Unmarshal([]byte(encoded), &arguments) != nil {
				arguments = map[string]any{}
			}
		}
	}
	if len(arguments) == 0 {
		for _, key := range []string{"prompt", "description", "content", "text", "query", "q", "search_query", "url", "filename", "title", "input"} {
			if value := looseActionStringField(raw, key); value != "" {
				arguments[key] = value
			}
		}
	}
	if toolName == "generate_image" || toolName == "edit_image" {
		if _, ok := arguments["prompt"]; !ok {
			if value, ok := arguments["description"].(string); ok {
				arguments["prompt"] = value
			}
		}
	}
	if toolName == "web_search" && stringToolArgument(arguments, "query") == "" {
		if value, ok := arguments["q"].(string); ok {
			arguments["query"] = value
		} else if value, ok := arguments["search_query"].(string); ok {
			arguments["query"] = value
		}
	}
	if toolName == "browse_url" && stringToolArgument(arguments, "url") == "" {
		if value, ok := arguments["input"].(string); ok {
			arguments["url"] = value
		}
	}
	if toolName == "create_pdf" && stringToolArgument(arguments, "content") == "" {
		for _, key := range []string{"text", "description", "input", "prompt"} {
			if value, ok := arguments[key].(string); ok && strings.TrimSpace(value) != "" {
				arguments["content"] = value
				break
			}
		}
	}
	return toolName, arguments, true
}

// looseActionStringField handles the malformed nested-JSON format emitted by
// older agent prompts, where action_input is a string but its inner quotes are
// not escaped. It is only used after strict JSON parsing fails and only for
// the small set of scalar fields needed by the built-in fallback.
func looseActionStringField(raw, key string) string {
	marker := `"` + key + `"`
	start := strings.Index(raw, marker)
	if start < 0 {
		return ""
	}
	colon := strings.Index(raw[start+len(marker):], ":")
	if colon < 0 {
		return ""
	}
	valueStart := start + len(marker) + colon + 1
	for valueStart < len(raw) && (raw[valueStart] == ' ' || raw[valueStart] == '\t' || raw[valueStart] == '\r' || raw[valueStart] == '\n') {
		valueStart++
	}
	if valueStart >= len(raw) || raw[valueStart] != '"' {
		return ""
	}
	valueStart++
	var encoded strings.Builder
	for index := valueStart; index < len(raw); index++ {
		if raw[index] == '\\' && index+1 < len(raw) {
			encoded.WriteByte(raw[index])
			encoded.WriteByte(raw[index+1])
			index++
			continue
		}
		if raw[index] == '"' {
			value := encoded.String()
			if decoded, err := strconv.Unquote(`"` + value + `"`); err == nil {
				return decoded
			}
			return value
		}
		encoded.WriteByte(raw[index])
	}
	return encoded.String()
}

func (a *App) executeAssistantBuiltinFallback(ctx context.Context, userID, organizationID, conversationID uuid.UUID, parentID *any, runID uuid.UUID, toolName string, arguments map[string]any, latestUser *assistantUserMessage, writeChunk func(any) error, response *strings.Builder, textID string, toolParts *[]map[string]any) error {
	callID := "fallback-" + uuid.NewString()
	event := chatToolEvent{Kind: "builtin_tool", Status: "running", Round: 1, ToolName: toolName, CallID: callID, Arguments: arguments}
	messageRowID := a.persistChatToolEventAt(ctx, conversationID, dereferenceAssistantUIParent(parentID), event)
	if messageRowID != uuid.Nil {
		*parentID = messageRowID
	}
	*toolParts = replaceAssistantUIToolPart(*toolParts, event)
	if err := writeChunk(map[string]any{"type": "tool-input-available", "toolCallId": callID, "toolName": toolName, "input": arguments, "dynamic": true, "toolMetadata": map[string]any{"messageId": messageRowID.String()}}); err != nil {
		return err
	}
	result, callErr := a.executeBuiltInChatTool(ctx, userID, organizationID, conversationID, toolName, arguments, latestUser)
	if callErr != nil {
		event.Status = "failed"
		event.Error = callErr.Error()
		a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
		*toolParts = replaceAssistantUIToolPart(*toolParts, event)
		if err := writeChunk(map[string]any{"type": "tool-output-error", "toolCallId": callID, "errorText": callErr.Error(), "dynamic": true}); err != nil {
			return err
		}
		return emitFallbackText(writeChunk, response, textID, "I couldn't complete that tool request: "+callErr.Error())
	}
	event.Status = "completed"
	event.Result = string(result)
	event.ResultPreview = toolResultPreview(result)
	a.updateChatToolEvent(ctx, conversationID, messageRowID, event)
	*toolParts = replaceAssistantUIToolPart(*toolParts, event)
	if err := writeChunk(map[string]any{"type": "tool-output-available", "toolCallId": callID, "output": json.RawMessage(result), "dynamic": true}); err != nil {
		return err
	}
	message := "The tool completed."
	switch toolName {
	case "web_search":
		message = "I searched the web and found the results below."
	case "browse_url":
		message = "I browsed the requested URL and found the content below."
	case "generate_image":
		message = "Here is the generated image."
	case "edit_image":
		message = "Here is the edited image."
	case "create_pdf":
		message = "The PDF is ready to download."
	}
	return emitFallbackText(writeChunk, response, textID, message)
}

func emitFallbackText(writeChunk func(any) error, response *strings.Builder, textID, message string) error {
	if err := writeChunk(map[string]any{"type": "text-start", "id": textID}); err != nil {
		return err
	}
	response.WriteString(message)
	if err := writeChunk(map[string]any{"type": "text-delta", "id": textID, "delta": message}); err != nil {
		return err
	}
	return writeChunk(map[string]any{"type": "text-end", "id": textID})
}

func stringToolArgument(arguments map[string]any, key string) string {
	value, _ := arguments[key].(string)
	return value
}

func intToolArgument(arguments map[string]any, key string, fallback int) int {
	value, ok := arguments[key].(float64)
	if !ok {
		return fallback
	}
	return int(value)
}

func (a *App) searchWeb(ctx context.Context, query string, limit int) ([]webSearchResult, error) {
	requestURL := "https://html.duckduckgo.com/html/?q=" + url.QueryEscape(query)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "JustAI/0.1 web-search")
	response, err := (&http.Client{Timeout: 12 * time.Second}).Do(request)
	if err != nil {
		return nil, fmt.Errorf("web search is unavailable: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("web search returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 6*1024*1024))
	if err != nil {
		return nil, err
	}
	return parseDuckDuckGoResults(bytes.NewReader(body), limit), nil
}

func (a *App) fetchWebURL(ctx context.Context, rawURL string) (string, error) {
	if a.RAG == nil {
		return "", fmt.Errorf("URL browsing is unavailable")
	}
	content, err := a.RAG.FetchURL(ctx, rawURL)
	if err != nil {
		return "", err
	}
	if len([]rune(content)) > 12000 {
		content = string([]rune(content)[:12000]) + "…"
	}
	return content, nil
}

func (a *App) generateImageForChat(ctx context.Context, userID, organizationID uuid.UUID, arguments map[string]any) (generatedImageRecord, error) {
	prompt := strings.TrimSpace(stringToolArgument(arguments, "prompt"))
	if prompt == "" || len([]rune(prompt)) > 4000 {
		return generatedImageRecord{}, fmt.Errorf("an image prompt between 1 and 4000 characters is required")
	}
	size := strings.TrimSpace(stringToolArgument(arguments, "size"))
	if size == "" {
		size = "1024x1024"
	}
	quality := strings.TrimSpace(stringToolArgument(arguments, "quality"))
	if quality == "" {
		quality = "auto"
	}
	endpointID, err := a.resolveImageEndpoint(ctx, userID, organizationID, strings.TrimSpace(stringToolArgument(arguments, "endpointId")))
	if err != nil {
		return generatedImageRecord{}, err
	}
	endpoint, err := a.providerEndpoint(ctx, endpointID)
	if err != nil {
		return generatedImageRecord{}, err
	}
	if endpoint.ProviderType != "openai" && endpoint.ProviderType != "openai-compatible" {
		return generatedImageRecord{}, fmt.Errorf("image generation requires an OpenAI-compatible image endpoint")
	}
	body, err := json.Marshal(map[string]any{"model": imageModelForEndpoint(endpoint), "prompt": prompt, "size": size, "quality": quality, "response_format": "b64_json"})
	if err != nil {
		return generatedImageRecord{}, err
	}
	response, err := imageProviderRequest(ctx, endpoint, http.MethodPost, "/images/generations", bytes.NewReader(body), "application/json")
	if err != nil {
		return generatedImageRecord{}, err
	}
	data, mimeType, err := decodeProviderImage(ctx, response, endpoint.AllowPrivate, endpointOrigin(endpoint))
	if err != nil {
		return generatedImageRecord{}, err
	}
	item, err := a.storeGeneratedImage(ctx, userID, organizationID, endpointID, prompt, "generate", mimeType, data)
	if err != nil {
		return generatedImageRecord{}, err
	}
	return generatedImageRecord{ID: item.ID, URL: item.URL, Prompt: item.Prompt, Mode: item.Mode, MimeType: item.MimeType, CreatedAt: item.CreatedAt}, nil
}

type generatedImageRecord struct {
	ID        uuid.UUID `json:"id"`
	URL       string    `json:"url"`
	Prompt    string    `json:"prompt"`
	Mode      string    `json:"mode"`
	MimeType  string    `json:"mimeType"`
	CreatedAt any       `json:"createdAt"`
}

func (a *App) editImageForChat(ctx context.Context, userID, organizationID uuid.UUID, arguments map[string]any, latestUser *assistantUserMessage) (generatedImageRecord, error) {
	prompt := strings.TrimSpace(stringToolArgument(arguments, "prompt"))
	if prompt == "" || len([]rune(prompt)) > 4000 {
		return generatedImageRecord{}, fmt.Errorf("an edit prompt between 1 and 4000 characters is required")
	}
	data, _, filename, err := assistantUIChatImageSource(arguments, latestUser)
	if err != nil {
		return generatedImageRecord{}, err
	}
	endpointID, err := a.resolveImageEndpoint(ctx, userID, organizationID, strings.TrimSpace(stringToolArgument(arguments, "endpointId")))
	if err != nil {
		return generatedImageRecord{}, err
	}
	endpoint, err := a.providerEndpoint(ctx, endpointID)
	if err != nil {
		return generatedImageRecord{}, err
	}
	if endpoint.ProviderType != "openai" && endpoint.ProviderType != "openai-compatible" {
		return generatedImageRecord{}, fmt.Errorf("image editing requires an OpenAI-compatible image endpoint")
	}
	form := &bytes.Buffer{}
	writer := multipart.NewWriter(form)
	if err := writer.WriteField("model", imageModelForEndpoint(endpoint)); err != nil {
		return generatedImageRecord{}, err
	}
	if err := writer.WriteField("prompt", prompt); err != nil {
		return generatedImageRecord{}, err
	}
	if err := writer.WriteField("response_format", "b64_json"); err != nil {
		return generatedImageRecord{}, err
	}
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		return generatedImageRecord{}, err
	}
	if _, err := part.Write(data); err != nil {
		return generatedImageRecord{}, err
	}
	if err := writer.Close(); err != nil {
		return generatedImageRecord{}, err
	}
	response, err := imageProviderRequest(ctx, endpoint, http.MethodPost, "/images/edits", form, writer.FormDataContentType())
	if err != nil {
		return generatedImageRecord{}, err
	}
	result, resultMimeType, err := decodeProviderImage(ctx, response, endpoint.AllowPrivate, endpointOrigin(endpoint))
	if err != nil {
		return generatedImageRecord{}, err
	}
	item, err := a.storeGeneratedImage(ctx, userID, organizationID, endpointID, prompt, "edit", resultMimeType, result)
	if err != nil {
		return generatedImageRecord{}, err
	}
	return generatedImageRecord{ID: item.ID, URL: item.URL, Prompt: item.Prompt, Mode: item.Mode, MimeType: item.MimeType, CreatedAt: item.CreatedAt}, nil
}

func assistantUIChatImageSource(arguments map[string]any, latestUser *assistantUserMessage) ([]byte, string, string, error) {
	if raw, ok := arguments["image"].(string); ok && strings.TrimSpace(raw) != "" {
		return decodeAssistantUIChatImage(raw, "attached-image")
	}
	if latestUser != nil {
		for _, rawPart := range latestUser.Parts {
			var part assistantUIPart
			if json.Unmarshal(rawPart, &part) != nil {
				continue
			}
			imageURL, ok := assistantUIImageURL(part)
			if !ok {
				continue
			}
			filename := strings.TrimSpace(part.Filename)
			if filename == "" {
				filename = "attached-image"
			}
			return decodeAssistantUIChatImage(imageURL, filename)
		}
	}
	return nil, "", "", fmt.Errorf("attach an image before asking me to edit it")
}

func decodeAssistantUIChatImage(raw, filename string) ([]byte, string, string, error) {
	normalized, ok := assistantUIProviderSafeImageURL(raw)
	if !ok {
		return nil, "", "", fmt.Errorf("the attached image could not be decoded; please reattach it")
	}
	mimeType, encoded, ok := assistantUIImageDataURL(normalized)
	if !ok {
		return nil, "", "", fmt.Errorf("the attached image format is not supported")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > 15*1024*1024 {
		return nil, "", "", fmt.Errorf("images are limited to 15 MB")
	}
	if extension, _ := mime.ExtensionsByType(mimeType); len(extension) > 0 && !strings.Contains(filename, ".") {
		filename += extension[0]
	}
	return data, mimeType, filename, nil
}
