package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/models"
)

const knowledgeCatalogSyncSQL = `
INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT CASE WHEN ks.scope_type = 'organization' THEN ks.scope_id ELSE member.organization_id END,
       COALESCE(created_by, CASE WHEN ks.scope_type = 'user' THEN ks.scope_id END), 'source', id, title,
       CASE WHEN scope_type = 'organization' THEN 'workspace' ELSE 'private' END,
       status, jsonb_build_object('sourceType', source_type, 'sourceUrl', COALESCE(source_url, '')),
       created_at, updated_at FROM knowledge_sources ks
LEFT JOIN LATERAL (SELECT om.organization_id FROM organization_members om WHERE om.user_id = ks.scope_id ORDER BY om.created_at LIMIT 1) member ON TRUE
WHERE ks.scope_type = 'organization' OR member.organization_id IS NOT NULL
ON CONFLICT (resource_type, resource_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, owner_id=EXCLUDED.owner_id, title=EXCLUDED.title, visibility=EXCLUDED.visibility, status=EXCLUDED.status, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at;
INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT organization_id, user_id, 'note', id, title, visibility, 'ready', '{}'::jsonb, created_at, updated_at FROM notes
ON CONFLICT (resource_type, resource_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, owner_id=EXCLUDED.owner_id, title=EXCLUDED.title, visibility=EXCLUDED.visibility, updated_at=EXCLUDED.updated_at;
INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT organization_id, user_id, 'memory', id, left(content, 160), 'private', CASE WHEN enabled THEN 'ready' ELSE 'disabled' END, jsonb_build_object('source', source, 'enabled', enabled), created_at, updated_at FROM memories
ON CONFLICT (resource_type, resource_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, owner_id=EXCLUDED.owner_id, title=EXCLUDED.title, status=EXCLUDED.status, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at;
INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT CASE WHEN rc.scope_type = 'organization' THEN rc.scope_id ELSE member.organization_id END,
       COALESCE(created_by, CASE WHEN rc.scope_type = 'user' THEN rc.scope_id END), 'repository', id, title, CASE WHEN scope_type = 'organization' THEN 'workspace' ELSE 'private' END,
       CASE
           WHEN rc.status = 'failed' THEN 'failed'
           WHEN EXISTS (
               SELECT 1 FROM repository_context_files rcf
               JOIN knowledge_sources rks ON rks.id = rcf.source_id
               WHERE rcf.context_id = rc.id AND rks.status = 'failed'
           ) THEN 'failed'
           WHEN rc.file_count > 0 AND NOT EXISTS (
               SELECT 1 FROM repository_context_files rcf
               JOIN knowledge_sources rks ON rks.id = rcf.source_id
               WHERE rcf.context_id = rc.id AND rks.status <> 'ready'
           ) THEN 'ready'
           ELSE rc.status
       END,
       jsonb_build_object('provider', provider, 'repositoryUrl', repository_url, 'ref', ref, 'fileCount', file_count, 'skippedFileCount', skipped_file_count, 'totalBytes', total_bytes, 'syncIntervalMinutes', sync_interval_minutes, 'nextSyncAt', next_sync_at), created_at, updated_at FROM repository_contexts rc
LEFT JOIN LATERAL (SELECT om.organization_id FROM organization_members om WHERE om.user_id = rc.scope_id ORDER BY om.created_at LIMIT 1) member ON TRUE
WHERE rc.scope_type = 'organization' OR member.organization_id IS NOT NULL
ON CONFLICT (resource_type, resource_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, owner_id=EXCLUDED.owner_id, title=EXCLUDED.title, visibility=EXCLUDED.visibility, status=EXCLUDED.status, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at;
INSERT INTO knowledge_items (organization_id, owner_id, resource_type, resource_id, title, visibility, status, metadata, created_at, updated_at)
SELECT organization_id, user_id, 'transcript', id, title, 'private', status, jsonb_build_object('kind', 'transcription'), created_at, updated_at FROM transcription_sessions
ON CONFLICT (resource_type, resource_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, owner_id=EXCLUDED.owner_id, title=EXCLUDED.title, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at;
DELETE FROM knowledge_items ki WHERE ki.resource_type = 'source' AND NOT EXISTS (SELECT 1 FROM knowledge_sources r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki WHERE ki.resource_type = 'note' AND NOT EXISTS (SELECT 1 FROM notes r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki WHERE ki.resource_type = 'memory' AND NOT EXISTS (SELECT 1 FROM memories r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki WHERE ki.resource_type = 'repository' AND NOT EXISTS (SELECT 1 FROM repository_contexts r WHERE r.id = ki.resource_id);
DELETE FROM knowledge_items ki WHERE ki.resource_type = 'transcript' AND NOT EXISTS (SELECT 1 FROM transcription_sessions r WHERE r.id = ki.resource_id);
INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, COALESCE(cks.added_by, c.user_id)
FROM conversation_knowledge_sources cks
JOIN conversations c ON c.id = cks.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'source' AND ki.resource_id = cks.source_id
WHERE cks.context_scope <> 'message'
  AND (p.visibility <> 'workspace' OR ki.visibility <> 'private')
ON CONFLICT DO NOTHING;
INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, COALESCE(cn.added_by, c.user_id)
FROM conversation_notes cn
JOIN conversations c ON c.id = cn.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'note' AND ki.resource_id = cn.note_id
WHERE p.visibility <> 'workspace' OR ki.visibility <> 'private'
ON CONFLICT DO NOTHING;
INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, COALESCE(crc.added_by, c.user_id)
FROM conversation_repository_contexts crc
JOIN conversations c ON c.id = crc.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'repository' AND ki.resource_id = crc.context_id
WHERE crc.context_scope <> 'message'
  AND (p.visibility <> 'workspace' OR ki.visibility <> 'private')
ON CONFLICT DO NOTHING;
INSERT INTO knowledge_space_items (space_id, item_id, added_by)
SELECT c.project_id, ki.id, c.user_id
FROM conversation_transcription_sessions cts
JOIN conversations c ON c.id = cts.conversation_id AND c.project_id IS NOT NULL
JOIN workspace_projects p ON p.id = c.project_id
JOIN knowledge_items ki ON ki.resource_type = 'transcript' AND ki.resource_id = cts.session_id
WHERE p.visibility <> 'workspace' OR ki.visibility <> 'private'
ON CONFLICT DO NOTHING;`

func (a *App) syncKnowledgeCatalog(ctx context.Context) error {
	_, err := a.DB.ExecContext(ctx, knowledgeCatalogSyncSQL)
	return err
}

func parseKnowledgeSpaceIDs(values []string) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if id, err := uuid.Parse(value); err == nil {
			result = append(result, id)
		}
	}
	return result
}

func (a *App) listKnowledgeItems(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := a.syncKnowledgeCatalog(c); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	limit := 50
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil {
			limit = parsed
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	offset := 0
	if raw := strings.TrimSpace(c.Query("cursor")); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed >= 0 {
			offset = parsed
		}
	}
	args := []any{organizationID, principal.UserID}
	where := `ki.organization_id = $1 AND (ki.visibility = 'workspace' OR ki.owner_id = $2)`
	if resourceType := strings.TrimSpace(c.Query("type")); resourceType != "" {
		switch resourceType {
		case "source", "note", "memory", "repository", "transcript":
		default:
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid knowledge item type"))
			return
		}
		where += fmt.Sprintf(" AND ki.resource_type = $%d", len(args)+1)
		args = append(args, resourceType)
	}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		where += fmt.Sprintf(" AND ki.status = $%d", len(args)+1)
		args = append(args, status)
	}
	if query := strings.TrimSpace(c.Query("q")); query != "" {
		where += fmt.Sprintf(" AND (ki.title ILIKE $%d OR ki.resource_type ILIKE $%d)", len(args)+1, len(args)+1)
		args = append(args, "%"+query+"%")
	}
	if spaceID := strings.TrimSpace(c.Query("spaceId")); spaceID != "" {
		parsed, parseErr := uuid.Parse(spaceID)
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space id"))
			return
		}
		where += fmt.Sprintf(" AND EXISTS (SELECT 1 FROM knowledge_space_items filter_ksi JOIN workspace_projects filter_space ON filter_space.id = filter_ksi.space_id WHERE filter_ksi.item_id = ki.id AND filter_space.id = $%d AND filter_space.organization_id = $1 AND (filter_space.user_id = $2 OR filter_space.visibility = 'workspace'))", len(args)+1)
		args = append(args, parsed)
	}
	args = append(args, limit+1, offset)
	rows, err := a.DB.QueryContext(c, `
		SELECT ki.id, ki.owner_id, ki.resource_type, ki.resource_id, ki.title,
		       ki.visibility, ki.status, ki.metadata, ki.created_at, ki.updated_at,
	       COALESCE(array_agg(visible_space.id::text) FILTER (WHERE visible_space.id IS NOT NULL), '{}')
	FROM knowledge_items ki
	LEFT JOIN knowledge_space_items ksi ON ksi.item_id = ki.id
	LEFT JOIN workspace_projects visible_space
	  ON visible_space.id = ksi.space_id
	 AND visible_space.organization_id = $1
	 AND (visible_space.user_id = $2 OR visible_space.visibility = 'workspace')
		WHERE `+where+`
		GROUP BY ki.id
		ORDER BY ki.updated_at DESC, ki.id DESC
		LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := make([]models.KnowledgeItem, 0, limit)
	for rows.Next() {
		var item models.KnowledgeItem
		var metadata []byte
		var spaceValues []string
		if err := rows.Scan(&item.ID, &item.OwnerID, &item.ResourceType, &item.ResourceID, &item.Title, &item.Visibility, &item.Status, &metadata, &item.CreatedAt, &item.UpdatedAt, pq.Array(&spaceValues)); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item.OrganizationID = organizationID
		item.Metadata = metadata
		item.SpaceIDs = parseKnowledgeSpaceIDs(spaceValues)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	nextCursor := ""
	if len(items) > limit {
		items = items[:limit]
		nextCursor = strconv.Itoa(offset + limit)
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "nextCursor": nextCursor})
}

func (a *App) getKnowledgeItemDetail(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := a.syncKnowledgeCatalog(c); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	itemID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid knowledge item id"))
		return
	}
	var detail models.KnowledgeItemDetail
	var metadata []byte
	var spaceValues []string
	err = a.DB.QueryRowContext(c, `
		SELECT ki.id, ki.owner_id, ki.resource_type, ki.resource_id, ki.title,
		       ki.visibility, ki.status, ki.metadata, ki.created_at, ki.updated_at,
	       COALESCE(array_agg(visible_space.id::text) FILTER (WHERE visible_space.id IS NOT NULL), '{}')
	FROM knowledge_items ki
	LEFT JOIN knowledge_space_items ksi ON ksi.item_id = ki.id
	LEFT JOIN workspace_projects visible_space
	  ON visible_space.id = ksi.space_id
	 AND visible_space.organization_id = $2
	 AND (visible_space.user_id = $3 OR visible_space.visibility = 'workspace')
		WHERE ki.id=$1 AND ki.organization_id=$2 AND (ki.visibility='workspace' OR ki.owner_id=$3)
		GROUP BY ki.id`, itemID, organizationID, principal.UserID).Scan(
		&detail.ID, &detail.OwnerID, &detail.ResourceType, &detail.ResourceID, &detail.Title,
		&detail.Visibility, &detail.Status, &metadata, &detail.CreatedAt, &detail.UpdatedAt, pq.Array(&spaceValues))
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("knowledge item not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	detail.OrganizationID = organizationID
	detail.Metadata = metadata
	detail.SpaceIDs = parseKnowledgeSpaceIDs(spaceValues)
	switch detail.ResourceType {
	case "source":
		err = a.DB.QueryRowContext(c, `SELECT COALESCE(content,''), COALESCE(source_url,''), COALESCE(mime_type,'') FROM knowledge_sources WHERE id=$1`, detail.ResourceID).Scan(&detail.Content, &detail.SourceURL, &detail.MIMEType)
	case "note":
		err = a.DB.QueryRowContext(c, `SELECT content FROM notes WHERE id=$1 AND organization_id=$2`, detail.ResourceID, organizationID).Scan(&detail.Content)
	case "memory":
		err = a.DB.QueryRowContext(c, `SELECT content FROM memories WHERE id=$1 AND organization_id=$2 AND user_id=$3`, detail.ResourceID, organizationID, principal.UserID).Scan(&detail.Content)
	case "repository":
		err = a.DB.QueryRowContext(c, `SELECT provider, repository_url, ref FROM repository_contexts WHERE id=$1`, detail.ResourceID).Scan(&detail.Provider, &detail.RepositoryURL, &detail.Ref)
		if err == nil {
			rows, filesErr := a.DB.QueryContext(c, `
				SELECT rcf.path, rcf.source_id, COALESCE(ks.status, 'missing'), rcf.size_bytes
				FROM repository_context_files rcf
				LEFT JOIN knowledge_sources ks ON ks.id = rcf.source_id
				WHERE rcf.context_id = $1
				ORDER BY rcf.path
				LIMIT 500`, detail.ResourceID)
			if filesErr != nil {
				err = filesErr
			} else {
				defer rows.Close()
				for rows.Next() {
					var file models.KnowledgeRepositoryFile
					if scanErr := rows.Scan(&file.Path, &file.SourceID, &file.Status, &file.SizeBytes); scanErr != nil {
						err = scanErr
						break
					}
					detail.Files = append(detail.Files, file)
				}
				if err == nil {
					err = rows.Err()
				}
			}
		}
	case "transcript":
		err = a.DB.QueryRowContext(c, `
		SELECT COALESCE(string_agg(
			format('[%sms–%sms] %s%s', tsg.start_offset_ms, tsg.end_offset_ms,
				CASE WHEN COALESCE(sp.display_name, sp.label, '') = '' THEN '' ELSE COALESCE(sp.display_name, sp.label, '') || ': ' END,
				tsg.text), E'\n' ORDER BY tsg.start_offset_ms), '')
		FROM transcription_segments tsg
		LEFT JOIN transcription_speakers sp ON sp.id = tsg.speaker_id
		WHERE tsg.session_id=$1 AND tsg.canonical=TRUE`, detail.ResourceID).Scan(&detail.Content)
	}
	if err != nil && err != sql.ErrNoRows {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"item": detail})
}

func (a *App) listKnowledgeSpaces(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT p.id, p.name, p.description, p.visibility, p.created_at, p.updated_at,
		       COUNT(ksi.item_id)
		FROM workspace_projects p
		LEFT JOIN knowledge_space_items ksi ON ksi.space_id = p.id
		WHERE p.organization_id = $1 AND (p.user_id = $2 OR p.visibility = 'workspace')
		GROUP BY p.id ORDER BY p.updated_at DESC, lower(p.name)`, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	spaces := make([]models.KnowledgeSpace, 0)
	for rows.Next() {
		var item models.KnowledgeSpace
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt, &item.ItemCount); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item.CanManage = true
		// The query already enforces visibility, but only owners can edit a
		// space. Read this cheaply without exposing owner IDs in the contract.
		var ownerID uuid.UUID
		if err := a.DB.QueryRowContext(c, `SELECT user_id FROM workspace_projects WHERE id = $1`, item.ID).Scan(&ownerID); err == nil {
			item.CanManage = ownerID == principal.UserID
		}
		spaces = append(spaces, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"spaces": spaces})
}

func (a *App) getKnowledgeSpace(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	spaceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space id"))
		return
	}
	var space models.KnowledgeSpace
	var ownerID uuid.UUID
	err = a.DB.QueryRowContext(c, `
		SELECT p.id, p.name, p.description, p.visibility, p.created_at, p.updated_at,
		       COUNT(ksi.item_id), p.user_id
		FROM workspace_projects p
		LEFT JOIN knowledge_space_items ksi ON ksi.space_id = p.id
		WHERE p.id=$1 AND p.organization_id=$2 AND (p.user_id=$3 OR p.visibility='workspace')
		GROUP BY p.id`, spaceID, organizationID, principal.UserID).Scan(
		&space.ID, &space.Name, &space.Description, &space.Visibility, &space.CreatedAt, &space.UpdatedAt, &space.ItemCount, &ownerID)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("space not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	space.CanManage = ownerID == principal.UserID
	c.JSON(http.StatusOK, gin.H{"space": space})
}

func (a *App) updateKnowledgeSpace(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	spaceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space id"))
		return
	}
	var request struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Visibility  *string `json:"visibility"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Name == nil && request.Description == nil && request.Visibility == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("name, description, or visibility is required"))
		return
	}
	var name, description, visibility any
	if request.Name != nil {
		value := strings.TrimSpace(*request.Name)
		if value == "" || len([]rune(value)) > 120 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("space name must contain between 1 and 120 characters"))
			return
		}
		name = value
	}
	if request.Description != nil {
		value := strings.TrimSpace(*request.Description)
		if len([]rune(value)) > 30000 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("space description is too large"))
			return
		}
		description = value
	}
	if request.Visibility != nil {
		value := strings.TrimSpace(*request.Visibility)
		if value != "private" && value != "workspace" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
			return
		}
		visibility = value
	}
	var privateItemCount int
	if request.Visibility != nil && visibility == "workspace" {
		if err := a.DB.QueryRowContext(c, `
			SELECT COUNT(*) FROM knowledge_space_items ksi
			JOIN knowledge_items ki ON ki.id=ksi.item_id
			WHERE ksi.space_id=$1 AND ki.visibility='private'`, spaceID).Scan(&privateItemCount); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if privateItemCount > 0 {
			writeError(c, http.StatusConflict, fmt.Errorf("remove private items before making this space visible to the workspace"))
			return
		}
	}
	var space models.KnowledgeSpace
	var ownerID uuid.UUID
	err = a.DB.QueryRowContext(c, `
		UPDATE workspace_projects
		SET name=COALESCE($3::text,name), description=COALESCE($4::text,description),
		    visibility=COALESCE($5::text,visibility), updated_at=now()
		WHERE id=$1 AND organization_id=$2 AND user_id=$6
		RETURNING id,name,description,visibility,created_at,updated_at,user_id`, spaceID, organizationID, name, description, visibility, principal.UserID).Scan(
		&space.ID, &space.Name, &space.Description, &space.Visibility, &space.CreatedAt, &space.UpdatedAt, &ownerID)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("space not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	space.CanManage = ownerID == principal.UserID
	c.JSON(http.StatusOK, gin.H{"space": space})
}

func (a *App) deleteKnowledgeSpace(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	spaceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM workspace_projects WHERE id=$1 AND organization_id=$2 AND user_id=$3`, spaceID, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("space not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) createKnowledgeSpace(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Visibility  string `json:"visibility"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Description = strings.TrimSpace(request.Description)
	request.Visibility = strings.TrimSpace(request.Visibility)
	if request.Name == "" || len([]rune(request.Name)) > 120 || len([]rune(request.Description)) > 30000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("space name or description is too large"))
		return
	}
	if request.Visibility == "" {
		request.Visibility = "private"
	}
	if request.Visibility != "private" && request.Visibility != "workspace" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("visibility must be private or workspace"))
		return
	}
	var item models.KnowledgeSpace
	err = a.DB.QueryRowContext(c, `INSERT INTO workspace_projects (user_id, organization_id, name, description, visibility) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,description,visibility,created_at,updated_at`, principal.UserID, organizationID, request.Name, request.Description, request.Visibility).Scan(&item.ID, &item.Name, &item.Description, &item.Visibility, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item.CanManage = true
	c.JSON(http.StatusCreated, gin.H{"space": item})
}

func (a *App) assignKnowledgeItem(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	spaceID, err := uuid.Parse(c.Param("spaceId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space id"))
		return
	}
	itemID, err := uuid.Parse(c.Param("itemId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid item id"))
		return
	}
	// Native records can be created through their legacy APIs. Synchronize the
	// canonical catalog before looking up the item so assignment works without
	// requiring a separate library refresh.
	if err := a.syncKnowledgeCatalog(c); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var spaceVisibility string
	if err := a.DB.QueryRowContext(c, `SELECT visibility FROM workspace_projects WHERE id=$1 AND organization_id=$2 AND user_id=$3`, spaceID, organizationID, principal.UserID).Scan(&spaceVisibility); err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("space not found or not manageable"))
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var itemVisibility string
	if err := a.DB.QueryRowContext(c, `SELECT visibility FROM knowledge_items WHERE id=$1 AND organization_id=$2 AND (visibility='workspace' OR owner_id=$3)`, itemID, organizationID, principal.UserID).Scan(&itemVisibility); err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("knowledge item not found"))
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if spaceVisibility == "workspace" && itemVisibility == "private" {
		writeError(c, http.StatusForbidden, fmt.Errorf("private items cannot be added to a workspace space"))
		return
	}
	_, err = a.DB.ExecContext(c, `INSERT INTO knowledge_space_items (space_id,item_id,added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, spaceID, itemID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE workspace_projects SET updated_at=now() WHERE id=$1`, spaceID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) removeKnowledgeItem(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	spaceID, spaceErr := uuid.Parse(c.Param("spaceId"))
	itemID, itemErr := uuid.Parse(c.Param("itemId"))
	if spaceErr != nil || itemErr != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space or item id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM knowledge_space_items ksi USING workspace_projects p WHERE ksi.space_id=$1 AND ksi.item_id=$2 AND p.id=ksi.space_id AND p.organization_id=$3 AND p.user_id=$4`, spaceID, itemID, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("space membership not found"))
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE workspace_projects SET updated_at=now() WHERE id=$1`, spaceID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}
