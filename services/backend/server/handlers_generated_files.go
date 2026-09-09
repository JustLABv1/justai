package server

import (
	"context"
	"database/sql"
	"fmt"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
)

func (a *App) createFileForChat(ctx context.Context, userID, organizationID uuid.UUID, arguments map[string]any) (models.GeneratedFile, error) {
	file, err := makeAgentFile(arguments)
	if err != nil {
		return models.GeneratedFile{}, err
	}
	title := normalizeGeneratedPDFTitle(stringToolArgument(arguments, "title"), stringToolArgument(arguments, "content"))
	return a.storeGeneratedChatFile(ctx, userID, organizationID, title, file.Name, file.MimeType, file.Content)
}

func (a *App) storeGeneratedChatFile(ctx context.Context, userID, organizationID uuid.UUID, title, filename, mimeType string, data []byte) (models.GeneratedFile, error) {
	filename = safeDownloadName(filename)
	if filename == "artifact" {
		return models.GeneratedFile{}, fmt.Errorf("file must have a filename")
	}
	if len(data) == 0 || len(data) > maxGeneratedPDFBytes {
		return models.GeneratedFile{}, fmt.Errorf("generated file must be between 1 byte and %d MB", maxGeneratedPDFBytes/(1024*1024))
	}
	if mimeType == "application/pdf" {
		verified, err := validateGeneratedPDF(data)
		if err != nil {
			return models.GeneratedFile{}, err
		}
		data = verified
	}

	var item models.GeneratedFile
	err := a.DB.QueryRowContext(ctx, `
		INSERT INTO generated_chat_files (user_id, organization_id, title, filename, mime_type, size_bytes, file_data)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, title, filename, mime_type, size_bytes, created_at
	`, userID, organizationID, title, filename, mimeType, int64(len(data)), data).Scan(
		&item.ID, &item.Title, &item.Filename, &item.MimeType, &item.Size, &item.CreatedAt,
	)
	if err != nil {
		return models.GeneratedFile{}, err
	}
	item.URL = "/api/v1/files/" + item.ID.String()
	return item, nil
}

func formatGeneratedFileContentDisposition(filename string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": safeDownloadName(filename)})
}

func (a *App) serveGeneratedChatFile(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid file id"))
		return
	}
	var data []byte
	var filename, mimeType string
	err = a.DB.QueryRowContext(c, `
		SELECT file_data, filename, mime_type
		FROM generated_chat_files
		WHERE id = $1 AND user_id = $2 AND organization_id = $3
	`, id, principal.UserID, organizationID).Scan(&data, &filename, &mimeType)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("file not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if mimeType == "application/pdf" {
		if _, err := validateGeneratedPDF(data); err != nil {
			writeError(c, http.StatusInternalServerError, fmt.Errorf("stored PDF is invalid: %w", err))
			return
		}
	}
	c.Header("Content-Disposition", formatGeneratedFileContentDisposition(filename))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, no-store")
	c.Header("Pragma", "no-cache")
	c.Header("Content-Length", strconv.Itoa(len(data)))
	c.Data(http.StatusOK, strings.TrimSpace(mimeType), data)
}
