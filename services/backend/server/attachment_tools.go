package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"justai-backend/provider"
)

func attachmentReadTools() []provider.ToolDefinition {
	return []provider.ToolDefinition{
		{Name: "list_attachments", Description: "List document attachments in this conversation before processing a batch of receipts or filling a template. Do not rely on search snippets for complete documents. Read each relevant document using read_attachment until nextOffset is null. Images must be inspected through the vision content in the conversation; the searchable image text is only a placeholder.", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)},
		{Name: "read_attachment", Description: "Read extracted attachment text in order, without relevance filtering. offset is a zero-based character offset; repeat with nextOffset until null. If content is missing or the source is not ready, ask for readable input instead of inventing data. Only documents attached to this conversation are accessible.", Parameters: json.RawMessage(`{"type":"object","properties":{"sourceId":{"type":"string"},"offset":{"type":"integer","minimum":0}},"required":["sourceId"],"additionalProperties":false}`)},
	}
}
func isAttachmentReadTool(name string) bool {
	return name == "list_attachments" || name == "read_attachment"
}

const attachmentReadScope = ` FROM conversation_knowledge_sources cks JOIN conversations c ON c.id=cks.conversation_id JOIN knowledge_sources ks ON ks.id=cks.source_id WHERE c.id=$1 AND c.user_id=$2 AND c.organization_id=$3 AND ((ks.scope_type='user' AND ks.scope_id=$2) OR (ks.scope_type='organization' AND ks.scope_id=$3))`

func (a *App) readAttachmentTool(ctx context.Context, userID, orgID, conversationID uuid.UUID, name string, args map[string]any) (json.RawMessage, error) {
	if conversationID == uuid.Nil {
		return nil, fmt.Errorf("this run has no conversation attachments")
	}
	if name == "list_attachments" {
		rows, err := a.DB.QueryContext(ctx, `SELECT ks.id,ks.title,COALESCE(ks.mime_type,''),ks.status,char_length(COALESCE(ks.content,''))`+attachmentReadScope+` ORDER BY ks.created_at,ks.id LIMIT 201`, conversationID, userID, orgID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id uuid.UUID
			var title, mime, status string
			var length int
			if err = rows.Scan(&id, &title, &mime, &status, &length); err != nil {
				return nil, err
			}
			items = append(items, map[string]any{"sourceId": id, "title": title, "mimeType": mime, "status": status, "characters": length})
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		if len(items) > 200 {
			return nil, fmt.Errorf("more than 200 attachments; use a separate conversation for this batch")
		}
		return json.Marshal(map[string]any{"attachments": items})
	}
	sourceID, err := uuid.Parse(stringToolArgument(args, "sourceId"))
	if err != nil {
		return nil, fmt.Errorf("invalid source id")
	}
	offset := intToolArgument(args, "offset", 0)
	if offset < 0 || offset > 16*1024*1024 {
		return nil, fmt.Errorf("invalid offset")
	}
	var content, title, mime, status string
	var length int
	err = a.DB.QueryRowContext(ctx, `SELECT ks.title,COALESCE(ks.mime_type,''),ks.status,char_length(COALESCE(ks.content,'')),substring(COALESCE(ks.content,'') FROM $5 FOR 16000)`+attachmentReadScope+` AND ks.id=$4`, conversationID, userID, orgID, sourceID, offset+1).Scan(&title, &mime, &status, &length, &content)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("attachment not found in this conversation")
	}
	if err != nil {
		return nil, err
	}
	var next *int
	if offset+16000 < length {
		v := offset + 16000
		next = &v
	}
	return json.Marshal(map[string]any{"sourceId": sourceID, "title": title, "mimeType": mime, "status": status, "content": content, "characters": length, "offset": offset, "nextOffset": next})
}
