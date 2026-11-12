package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// mcpResultImageMimeTypes lists the raster formats an MCP tool may return
// inline. SVG is deliberately excluded because it can carry script.
var mcpResultImageMimeTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

var mcpDataURIImagePattern = regexp.MustCompile(`!?\[[^\]]*\]\(data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)\)|data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)`)

const mcpResultImageNote = "The image was generated and is already displayed to the user in the chat. Do not repeat, embed, or describe its data; just refer to it."

// persistMCPResultImages replaces base64 image content blocks in an MCP tool
// result with stored image references. The raw base64 would otherwise be sent
// to the model as text (wasting context and never rendering) and be saved in
// the message history. The returned result carries a /api/v1/images/<id> URL
// the chat UI renders as an image card.
func (a *App) persistMCPResultImages(ctx context.Context, userID, organizationID uuid.UUID, toolName string, result json.RawMessage) json.RawMessage {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(result, &envelope) != nil {
		return result
	}
	var content []map[string]any
	if json.Unmarshal(envelope["content"], &content) != nil {
		return result
	}
	changed := false
	var extracted []map[string]any
	for index, block := range content {
		if block["type"] == "text" {
			// Some servers return the image inline as a markdown data URI.
			text, _ := block["text"].(string)
			if !strings.Contains(text, "data:image/") {
				continue
			}
			block["text"] = mcpDataURIImagePattern.ReplaceAllStringFunc(text, func(match string) string {
				parts := mcpDataURIImagePattern.FindStringSubmatch(match)
				mimeType, payload := parts[1], parts[2]
				if payload == "" {
					mimeType, payload = parts[3], parts[4]
				}
				extracted = append(extracted, a.storeMCPResultImage(ctx, userID, organizationID, toolName, payload, mimeType))
				return ""
			})
			changed = true
			continue
		}
		if block["type"] != "image" {
			continue
		}
		encoded, _ := block["data"].(string)
		if encoded == "" {
			continue
		}
		declared, _ := block["mimeType"].(string)
		content[index] = a.storeMCPResultImage(ctx, userID, organizationID, toolName, encoded, declared)
		changed = true
	}
	if !changed {
		return result
	}
	content = append(content, extracted...)
	rewritten, err := json.Marshal(content)
	if err != nil {
		return result
	}
	envelope["content"] = rewritten
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return result
	}
	return encoded
}

// storeMCPResultImage validates and stores one base64 image and returns the
// content block that replaces it.
func (a *App) storeMCPResultImage(ctx context.Context, userID, organizationID uuid.UUID, toolName, encoded, declared string) map[string]any {
	replacement := map[string]any{"type": "image"}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	mimeType := http.DetectContentType(data)
	if i := strings.Index(mimeType, ";"); i >= 0 {
		mimeType = mimeType[:i]
	}
	if err != nil || len(data) == 0 || len(data) > maxGeneratedImageBytes || !mcpResultImageMimeTypes[mimeType] {
		replacement["error"] = "The returned image could not be displayed (unsupported or oversized data)."
		if declared != "" {
			replacement["mimeType"] = declared
		}
		return replacement
	}
	var id uuid.UUID
	if err := a.DB.QueryRowContext(ctx, `INSERT INTO generated_images (user_id, organization_id, endpoint_id, prompt, mode, mime_type, image_data) VALUES ($1, $2, NULL, $3, 'generate', $4, $5) RETURNING id`, userID, organizationID, "MCP tool "+toolName, mimeType, data).Scan(&id); err != nil {
		replacement["error"] = "The returned image could not be stored."
		return replacement
	}
	replacement["id"] = id
	replacement["url"] = "/api/v1/images/" + id.String()
	replacement["mimeType"] = mimeType
	replacement["note"] = mcpResultImageNote
	return replacement
}
