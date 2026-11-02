package server

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"

	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/middleware"
	"justai-backend/models"
)

// Endpoint logos reuse the MCP icon pipeline: strict type allowlist (no SVG),
// decoded and re-encoded to a bounded size, stored in the database.

func endpointLogoURL(id uuid.UUID, version int64) string {
	return fmt.Sprintf("/api/v1/endpoints/%s/logo?v=%d", id, version)
}

// attachEndpointLogos sets LogoURL on every endpoint that has an uploaded logo.
func (a *App) attachEndpointLogos(c context.Context, items []models.Endpoint) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, len(items))
	for i, item := range items {
		ids[i] = item.ID.String()
	}
	rows, err := a.DB.QueryContext(c, `SELECT endpoint_id::text, extract(epoch FROM updated_at)::bigint FROM endpoint_logos WHERE endpoint_id::text = ANY($1)`, pq.Array(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	versions := map[string]int64{}
	for rows.Next() {
		var id string
		var version int64
		if err := rows.Scan(&id, &version); err != nil {
			return err
		}
		versions[id] = version
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range items {
		if version, ok := versions[items[i].ID.String()]; ok {
			items[i].LogoURL = endpointLogoURL(items[i].ID, version)
		}
	}
	return nil
}

func (a *App) manageableEndpoint(c *gin.Context) (models.Endpoint, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpoint id"))
		return models.Endpoint{}, false
	}
	current, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
		return models.Endpoint{}, false
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	if err := a.canManageEndpoint(c, current, principal, organizationID, middleware.GetOrganizationRole(c)); err != nil {
		writeError(c, http.StatusForbidden, err)
		return models.Endpoint{}, false
	}
	return current, true
}

func (a *App) uploadEndpointLogo(c *gin.Context) {
	current, ok := a.manageableEndpoint(c)
	if !ok {
		return
	}
	fileHeader, err := c.FormFile("logo")
	if err != nil || fileHeader.Size <= 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a logo file is required"))
		return
	}
	if fileHeader.Size > maxMCPServerIconUploadBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("logos are limited to 2 MB"))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxMCPServerIconUploadBytes+1))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if len(data) == 0 || len(data) > maxMCPServerIconUploadBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("logos must be between 1 byte and 2 MB"))
		return
	}
	mimeType := mimetype.Detect(data).String()
	if !allowedMCPServerIconTypes[mimeType] {
		writeError(c, http.StatusUnsupportedMediaType, fmt.Errorf("use a PNG, JPEG, GIF, WebP, or ICO image"))
		return
	}
	normalizedData, normalizedMimeType, err := normalizeMCPServerIcon(data, mimeType)
	if err != nil {
		writeError(c, http.StatusUnprocessableEntity, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `INSERT INTO endpoint_logos (endpoint_id, mime_type, image_data, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (endpoint_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, image_data = EXCLUDED.image_data, updated_at = now()`, current.ID, normalizedMimeType, normalizedData); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getEndpoint(c, current.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (a *App) deleteEndpointLogo(c *gin.Context) {
	current, ok := a.manageableEndpoint(c)
	if !ok {
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM endpoint_logos WHERE endpoint_id = $1`, current.ID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	item, err := a.getEndpoint(c, current.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

// serveEndpointLogo is outside the organization group because <img> requests
// cannot send X-Organization-ID; access follows the endpoint's own scope.
func (a *App) serveEndpointLogo(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpoint id"))
		return
	}
	principal, ok := middleware.GetPrincipal(c)
	if !ok {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("authentication required"))
		return
	}
	var scopeType string
	var scopeID sql.NullString
	if err := a.DB.QueryRowContext(c, `SELECT scope_type, scope_id FROM endpoint_settings WHERE id = $1`, id).Scan(&scopeType, &scopeID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint logo not found"))
		return
	}
	allowed := principal.PlatformAdmin || scopeType == "global"
	if !allowed {
		switch scopeType {
		case "user":
			allowed = scopeID.Valid && scopeID.String == principal.UserID.String()
		case "organization":
			if scopeID.Valid {
				_ = a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = $1::uuid AND user_id = $2)`, scopeID.String, principal.UserID).Scan(&allowed)
			}
		}
	}
	if !allowed {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint logo not found"))
		return
	}
	var mimeType string
	var data []byte
	err = a.DB.QueryRowContext(c, `SELECT mime_type, image_data FROM endpoint_logos WHERE endpoint_id = $1`, id).Scan(&mimeType, &data)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint logo not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "private, max-age=86400")
	c.Data(http.StatusOK, mimeType, data)
}

func (a *App) uploadPlatformEndpointLogo(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.uploadEndpointLogo(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.endpoint.logo_updated", "endpoint", &id, nil)
		}
	}
}

func (a *App) deletePlatformEndpointLogo(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.deleteEndpointLogo(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.endpoint.logo_deleted", "endpoint", &id, nil)
		}
	}
}
