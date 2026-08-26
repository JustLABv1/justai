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

func parseGeneratedPDFArguments(arguments map[string]any) (content, title, filename string, err error) {
	content = strings.ToValidUTF8(strings.TrimSpace(stringToolArgument(arguments, "content")), "\uFFFD")
	if content == "" || len([]byte(content)) > maxGeneratedPDFContentBytes {
		return "", "", "", fmt.Errorf("PDF content between 1 and %d bytes is required", maxGeneratedPDFContentBytes)
	}
	rawTitle := strings.TrimSpace(stringToolArgument(arguments, "title"))
	if len([]rune(rawTitle)) > maxGeneratedPDFTitleRunes {
		return "", "", "", fmt.Errorf("PDF title must be at most %d characters", maxGeneratedPDFTitleRunes)
	}
	rawFilename := strings.TrimSpace(stringToolArgument(arguments, "filename"))
	if len([]rune(rawFilename)) > 256 {
		return "", "", "", fmt.Errorf("PDF filename must be at most 256 characters")
	}
	title = normalizeGeneratedPDFTitle(rawTitle, content)
	filename = generatedPDFOutputFilename(rawFilename, title)
	return content, title, filename, nil
}

func (a *App) createPDFForChat(ctx context.Context, userID, organizationID uuid.UUID, arguments map[string]any) (models.GeneratedPDF, error) {
	content, title, filename, err := parseGeneratedPDFArguments(arguments)
	if err != nil {
		return models.GeneratedPDF{}, err
	}
	data, err := renderGeneratedPDF(title, content)
	if err != nil {
		return models.GeneratedPDF{}, err
	}
	return a.storeGeneratedPDF(ctx, userID, organizationID, title, filename, data)
}

func (a *App) storeGeneratedPDF(ctx context.Context, userID, organizationID uuid.UUID, title, filename string, data []byte) (models.GeneratedPDF, error) {
	verified, err := validateGeneratedPDF(data)
	if err != nil {
		return models.GeneratedPDF{}, err
	}
	title = normalizeGeneratedPDFTitle(title, "")
	filename = generatedPDFOutputFilename(filename, title)
	var item models.GeneratedPDF
	err = a.DB.QueryRowContext(ctx, `
		INSERT INTO generated_pdfs (user_id, organization_id, title, filename, mime_type, size_bytes, pdf_data)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, title, filename, mime_type, size_bytes, created_at
	`, userID, organizationID, title, filename, generatedPDFMimeType, int64(len(verified)), verified).Scan(
		&item.ID, &item.Title, &item.Filename, &item.MimeType, &item.Size, &item.CreatedAt,
	)
	if err != nil {
		return models.GeneratedPDF{}, err
	}
	item.URL = "/api/v1/pdfs/" + item.ID.String()
	return item, nil
}

func formatGeneratedPDFContentDisposition(filename string) string {
	filename = sanitizeGeneratedPDFFilename(filename)
	return mime.FormatMediaType("attachment", map[string]string{"filename": filename})
}

func (a *App) serveGeneratedPDF(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid PDF id"))
		return
	}
	var data []byte
	var filename string
	err = a.DB.QueryRowContext(c, `
		SELECT pdf_data, filename
		FROM generated_pdfs
		WHERE id = $1 AND user_id = $2 AND organization_id = $3
	`, id, principal.UserID, organizationID).Scan(&data, &filename)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("PDF not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := validateGeneratedPDF(data); err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("stored PDF is invalid: %w", err))
		return
	}
	c.Header("Content-Disposition", formatGeneratedPDFContentDisposition(filename))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, no-store")
	c.Header("Pragma", "no-cache")
	c.Header("Content-Length", strconv.Itoa(len(data)))
	c.Data(http.StatusOK, generatedPDFMimeType, data)
}
