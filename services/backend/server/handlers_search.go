package server

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

type universalSearchResult struct {
	Kind           string     `json:"kind"`
	ID             uuid.UUID  `json:"id"`
	Title          string     `json:"title"`
	Snippet        string     `json:"snippet"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	ConversationID *uuid.UUID `json:"conversationId,omitempty"`
	SessionID      *uuid.UUID `json:"sessionId,omitempty"`
}

func (a *App) universalSearch(c *gin.Context) {
	principal, ok := middleware.GetPrincipal(c)
	organizationID, orgOK := middleware.GetOrganizationID(c)
	if !ok || !orgOK || organizationID == uuid.Nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("organization context is required"))
		return
	}
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		c.JSON(http.StatusOK, gin.H{"results": []universalSearchResult{}})
		return
	}
	limit := 30
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &limit); err != nil {
			limit = 30
		}
	}
	if limit < 5 {
		limit = 5
	}
	if limit > 50 {
		limit = 50
	}
	perKind := (limit + 4) / 5
	scope := strings.ToLower(strings.TrimSpace(c.Query("scope")))
	if scope == "" {
		scope = "all"
	}
	allowedScopes := map[string]bool{"all": true, "conversations": true, "notes": true, "knowledge": true, "transcripts": true, "projects": true}
	if !allowedScopes[scope] {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid search scope"))
		return
	}
	pattern := "%" + strings.ToLower(query) + "%"
	results := make([]universalSearchResult, 0, limit)
	appendResults := func(values []universalSearchResult) {
		if len(results) >= limit {
			return
		}
		remaining := limit - len(results)
		if len(values) > remaining {
			values = values[:remaining]
		}
		results = append(results, values...)
	}

	if scope == "all" || scope == "conversations" {
		rows, err := a.DB.QueryContext(c, `
			SELECT c.id, c.title,
			       COALESCE((SELECT left(m.content, 280) FROM messages m WHERE m.conversation_id = c.id AND lower(m.content) LIKE $1 ORDER BY m.created_at DESC LIMIT 1), left(c.title, 280)),
			       c.updated_at
			FROM conversations c
			WHERE c.organization_id = $2
			  AND (c.user_id = $3 OR c.visibility = 'workspace')
			  AND (lower(c.title) LIKE $1 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND lower(m.content) LIKE $1))
			ORDER BY c.updated_at DESC
			LIMIT $4`, pattern, organizationID, principal.UserID, perKind)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		items := make([]universalSearchResult, 0, perKind)
		for rows.Next() {
			var item universalSearchResult
			item.Kind = "conversation"
			if err := rows.Scan(&item.ID, &item.Title, &item.Snippet, &item.UpdatedAt); err != nil {
				_ = rows.Close()
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			item.ConversationID = &item.ID
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_ = rows.Close()
		appendResults(items)
	}

	if scope == "all" || scope == "notes" {
		rows, err := a.DB.QueryContext(c, `
			SELECT n.id, n.title, left(n.content, 280), n.updated_at
			FROM notes n
			WHERE n.organization_id = $2
			  AND (n.user_id = $3 OR n.visibility = 'workspace')
			  AND (lower(n.title) LIKE $1 OR lower(n.content) LIKE $1)
			ORDER BY n.updated_at DESC
			LIMIT $4`, pattern, organizationID, principal.UserID, perKind)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		items := make([]universalSearchResult, 0, perKind)
		for rows.Next() {
			var item universalSearchResult
			item.Kind = "note"
			if err := rows.Scan(&item.ID, &item.Title, &item.Snippet, &item.UpdatedAt); err != nil {
				_ = rows.Close()
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_ = rows.Close()
		appendResults(items)
	}

	if scope == "all" || scope == "knowledge" {
		rows, err := a.DB.QueryContext(c, `
			SELECT ks.id, ks.title,
			       COALESCE(NULLIF(left(ks.content, 280), ''), left(COALESCE(chunk.content, ''), 280)),
			       ks.updated_at
			FROM knowledge_sources ks
			LEFT JOIN LATERAL (
				SELECT kc.content
				FROM knowledge_chunks kc
				WHERE kc.source_id = ks.id AND lower(kc.content) LIKE $1
				ORDER BY kc.chunk_index
				LIMIT 1
			) chunk ON TRUE
			WHERE ((ks.scope_type = 'organization' AND ks.scope_id = $2) OR (ks.scope_type = 'user' AND ks.scope_id = $3))
			  AND (lower(ks.title) LIKE $1 OR lower(ks.content) LIKE $1 OR EXISTS (SELECT 1 FROM knowledge_chunks kc WHERE kc.source_id = ks.id AND lower(kc.content) LIKE $1))
			ORDER BY ks.updated_at DESC
			LIMIT $4`, pattern, organizationID, principal.UserID, perKind)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		items := make([]universalSearchResult, 0, perKind)
		for rows.Next() {
			var item universalSearchResult
			item.Kind = "knowledge"
			if err := rows.Scan(&item.ID, &item.Title, &item.Snippet, &item.UpdatedAt); err != nil {
				_ = rows.Close()
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_ = rows.Close()
		appendResults(items)
	}

	if scope == "all" || scope == "transcripts" {
		rows, err := a.DB.QueryContext(c, `
			SELECT s.id, s.title,
			       COALESCE((SELECT left(seg.text, 280) FROM transcription_segments seg WHERE seg.session_id = s.id AND lower(seg.text) LIKE $1 ORDER BY seg.start_offset_ms LIMIT 1), s.title),
			       s.updated_at
			FROM transcription_sessions s
			WHERE s.user_id = $3 AND s.organization_id = $2
			  AND (lower(s.title) LIKE $1 OR EXISTS (SELECT 1 FROM transcription_segments seg WHERE seg.session_id = s.id AND lower(seg.text) LIKE $1))
			ORDER BY s.updated_at DESC
			LIMIT $4`, pattern, organizationID, principal.UserID, perKind)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		items := make([]universalSearchResult, 0, perKind)
		for rows.Next() {
			var item universalSearchResult
			item.Kind = "transcript"
			if err := rows.Scan(&item.ID, &item.Title, &item.Snippet, &item.UpdatedAt); err != nil {
				_ = rows.Close()
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			item.SessionID = &item.ID
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_ = rows.Close()
		appendResults(items)
	}

	if scope == "all" || scope == "projects" {
		rows, err := a.DB.QueryContext(c, `
			SELECT id, name, left(description, 280), updated_at
			FROM workspace_projects
			WHERE organization_id = $2 AND (user_id = $3 OR visibility = 'workspace')
			  AND (lower(name) LIKE $1 OR lower(description) LIKE $1)
			ORDER BY updated_at DESC
			LIMIT $4`, pattern, organizationID, principal.UserID, perKind)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		items := make([]universalSearchResult, 0, perKind)
		for rows.Next() {
			var item universalSearchResult
			item.Kind = "project"
			if err := rows.Scan(&item.ID, &item.Title, &item.Snippet, &item.UpdatedAt); err != nil {
				_ = rows.Close()
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_ = rows.Close()
		appendResults(items)
	}

	c.JSON(http.StatusOK, gin.H{"results": results})
}
