package server

import (
	"database/sql"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/rag"
)

type knowledgeRequest struct {
	Title      string `json:"title"`
	SourceType string `json:"sourceType"`
	SourceURL  string `json:"sourceUrl"`
	Content    string `json:"content"`
	ScopeType  string `json:"scopeType"`
}

func (a *App) listKnowledgeSources(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	result, err := rag.ListSources(c, a.DB, organizationID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"sources": result})
}

func (a *App) createKnowledgeSource(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	if strings.Contains(strings.ToLower(c.GetHeader("Content-Type")), "multipart/form-data") {
		a.createUploadedSource(c, principal.UserID, organizationID)
		return
	}
	var request knowledgeRequest
	if !decodeJSON(c, &request) {
		return
	}
	scopeType := request.ScopeType
	if scopeType == "" {
		scopeType = "organization"
	}
	scopeID := organizationID
	if scopeType == "user" {
		scopeID = principal.UserID
	} else if scopeType != "organization" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("scopeType must be organization or user"))
		return
	}
	if scopeType == "organization" {
		role := middleware.GetOrganizationRole(c)
		if role != "owner" && role != "admin" && !principal.PlatformAdmin {
			writeError(c, http.StatusForbidden, fmt.Errorf("organization knowledge sources require owner or admin access"))
			return
		}
	}
	item, err := rag.NewSource(c, a.DB, scopeType, scopeID, principal.UserID, strings.TrimSpace(request.Title), request.SourceType, strings.TrimSpace(request.SourceURL), "text/plain", request.Content)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (a *App) createUploadedSource(c *gin.Context, userID, organizationID uuid.UUID) {
	fileHeader, err := c.FormFile("file")
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("file is required"))
		return
	}
	if fileHeader.Size > 25*1024*1024 {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("files are limited to 25 MB"))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	defer file.Close()
	body, err := readUpload(file, fileHeader.Size)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	mimeType := fileHeader.Header.Get("Content-Type")
	content, err := rag.ExtractUploadContext(c, fileHeader.Filename, mimeType, body)
	if err != nil {
		writeError(c, http.StatusUnprocessableEntity, err)
		return
	}
	if strings.TrimSpace(content) == "" {
		writeError(c, http.StatusUnprocessableEntity, fmt.Errorf("attachment contains no readable text"))
		return
	}
	title := c.PostForm("title")
	if title == "" {
		title = fileHeader.Filename
	}
	scopeType := c.PostForm("scopeType")
	if scopeType == "" {
		scopeType = "organization"
	}
	scopeID := organizationID
	if scopeType == "user" {
		scopeID = userID
	} else if scopeType != "organization" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("scopeType must be organization or user"))
		return
	}
	if scopeType == "organization" {
		principal, _ := middleware.GetPrincipal(c)
		role := middleware.GetOrganizationRole(c)
		if role != "owner" && role != "admin" && !principal.PlatformAdmin {
			writeError(c, http.StatusForbidden, fmt.Errorf("organization knowledge sources require owner or admin access"))
			return
		}
	}
	item, err := rag.NewSource(c, a.DB, scopeType, scopeID, userID, title, "upload", "", mimeType, content)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func readUpload(file multipart.File, size int64) ([]byte, error) {
	return io.ReadAll(io.LimitReader(file, size))
}

func (a *App) reindexKnowledgeSource(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	if err := a.authorizeSource(c, id); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	// Serialize reindex requests for a source. This makes the active-job check
	// deterministic and turns concurrent clicks into a safe reset of the same
	// queued job instead of a partial unique-index failure.
	var lockedSource uuid.UUID
	if err := transaction.QueryRowContext(c, `SELECT id FROM knowledge_sources WHERE id = $1 FOR UPDATE`, id).Scan(&lockedSource); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("source not found"))
		return
	}
	if _, err := transaction.ExecContext(c, `UPDATE knowledge_sources SET status = 'queued', error_message = NULL, updated_at = now() WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var activeStatus string
	activeErr := transaction.QueryRowContext(c, `SELECT status FROM ingestion_jobs WHERE source_id = $1 AND status IN ('queued', 'processing') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, id).Scan(&activeStatus)
	if activeErr == nil && activeStatus == "processing" {
		writeError(c, http.StatusConflict, fmt.Errorf("source is currently indexing; wait for the active job to finish"))
		return
	}
	if activeErr != nil && activeErr != sql.ErrNoRows {
		writeError(c, http.StatusInternalServerError, activeErr)
		return
	}
	if activeErr == nil {
		_, err = transaction.ExecContext(c, `UPDATE ingestion_jobs SET status = 'queued', attempts = 0, lease_until = NULL, stage = 'queued', progress = 0, error_message = NULL, run_after = now(), updated_at = now() WHERE source_id = $1 AND status = 'queued'`, id)
	} else {
		_, err = transaction.ExecContext(c, `INSERT INTO ingestion_jobs (source_id) VALUES ($1)`, id)
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := rag.GetSource(c, a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (a *App) deleteKnowledgeSource(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	if err := a.authorizeSource(c, id); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM knowledge_sources WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) authorizeSource(c *gin.Context, id uuid.UUID) error {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	var scopeType string
	var scopeID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM knowledge_sources WHERE id = $1`, id).Scan(&scopeType, &scopeID); err != nil {
		return fmt.Errorf("source not found")
	}
	if scopeType == "organization" && scopeID == organizationID {
		role := middleware.GetOrganizationRole(c)
		principal, _ := middleware.GetPrincipal(c)
		if role != "owner" && role != "admin" && !principal.PlatformAdmin {
			return fmt.Errorf("organization knowledge sources require owner or admin access")
		}
		return nil
	}
	if scopeType == "user" && scopeID == principal.UserID {
		return nil
	}
	return fmt.Errorf("source belongs to another scope")
}
