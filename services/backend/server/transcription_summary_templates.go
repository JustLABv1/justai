package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

type transcriptionSummaryTemplateSettings struct {
	transcriptionSummaryStandard
	ExclusionRules string `json:"exclusionRules"`
}
type transcriptionSummaryTemplate struct {
	transcriptionSummaryTemplateSettings
	ID        uuid.UUID `json:"id"`
	UpdatedAt time.Time `json:"updatedAt"`
	CanEdit   bool      `json:"canEdit"`
}

func validateSummaryTemplate(settings *transcriptionSummaryTemplateSettings) error {
	settings.Name = strings.TrimSpace(settings.Name)
	settings.Instructions = strings.TrimSpace(settings.Instructions)
	settings.ExclusionRules = strings.TrimSpace(settings.ExclusionRules)
	if settings.Name == "" || len(settings.Name) > 120 || len(settings.Instructions) > 4000 || len(settings.ExclusionRules) > 6000 {
		return fmt.Errorf("provide a template name (up to 120 bytes), instructions (up to 4000 bytes), and rules (up to 6000 bytes)")
	}
	if !settings.Summary && !settings.Chapters && !settings.Topics && !settings.ActionItems {
		return fmt.Errorf("choose at least one summary section")
	}
	switch settings.Format {
	case "pdf", "docx", "md", "txt", "json":
		return nil
	}
	return fmt.Errorf("unsupported template export format")
}

func summaryTemplateAdmin(c *gin.Context) bool {
	principal, _ := middleware.GetPrincipal(c)
	role := c.GetString(middleware.OrgRoleKey)
	return principal.PlatformAdmin || role == "owner" || role == "admin"
}

func (a *App) loadSummaryTemplate(c *gin.Context, id uuid.UUID) (transcriptionSummaryTemplate, error) {
	organizationID, _ := middleware.GetOrganizationID(c)
	principal, _ := middleware.GetPrincipal(c)
	var item transcriptionSummaryTemplate
	var creator uuid.NullUUID
	var settings []byte
	err := a.DB.QueryRowContext(c, `SELECT id, created_by, settings, updated_at FROM transcription_summary_templates WHERE id=$1 AND organization_id=$2`, id, organizationID).Scan(&item.ID, &creator, &settings, &item.UpdatedAt)
	if err != nil {
		return item, err
	}
	err = json.Unmarshal(settings, &item.transcriptionSummaryTemplateSettings)
	item.CanEdit = summaryTemplateAdmin(c) || (creator.Valid && creator.UUID == principal.UserID)
	return item, err
}

func (a *App) listTranscriptionSummaryTemplates(c *gin.Context) {
	organizationID, _ := middleware.GetOrganizationID(c)
	principal, _ := middleware.GetPrincipal(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, created_by, settings, updated_at FROM transcription_summary_templates WHERE organization_id=$1 ORDER BY lower(settings->>'name'),id`, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := make([]transcriptionSummaryTemplate, 0)
	for rows.Next() {
		var item transcriptionSummaryTemplate
		var creator uuid.NullUUID
		var settings []byte
		if err = rows.Scan(&item.ID, &creator, &settings, &item.UpdatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if err = json.Unmarshal(settings, &item.transcriptionSummaryTemplateSettings); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item.CanEdit = summaryTemplateAdmin(c) || (creator.Valid && creator.UUID == principal.UserID)
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// Release the result set before the second query (also works with a one-connection pool).
	rows.Close()
	var selected uuid.NullUUID
	err = a.DB.QueryRowContext(c, `SELECT template_id FROM transcription_summary_template_choices WHERE organization_id=$1 AND user_id=$2`, organizationID, principal.UserID).Scan(&selected)
	if err != nil && err != sql.ErrNoRows {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	choice := ""
	if selected.Valid {
		choice = selected.UUID.String()
	}
	c.JSON(http.StatusOK, gin.H{"templates": items, "selectedTemplateId": choice})
}

func (a *App) saveTranscriptionSummaryTemplate(c *gin.Context) {
	organizationID, _ := middleware.GetOrganizationID(c)
	principal, _ := middleware.GetPrincipal(c)
	var request struct {
		transcriptionSummaryTemplateSettings
		Revision string `json:"revision"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if err := validateSummaryTemplate(&request.transcriptionSummaryTemplateSettings); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	data, err := json.Marshal(request.transcriptionSummaryTemplateSettings)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	id := uuid.New()
	var updated time.Time
	if c.Request.Method == http.MethodPost {
		err = a.DB.QueryRowContext(c, `INSERT INTO transcription_summary_templates(id,organization_id,created_by,settings) VALUES($1,$2,$3,$4) RETURNING updated_at`, id, organizationID, principal.UserID, string(data)).Scan(&updated)
	} else {
		id, err = uuid.Parse(c.Param("templateId"))
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid template id"))
			return
		}
		revision, parseErr := time.Parse(time.RFC3339Nano, request.Revision)
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("reopen the template before saving changes"))
			return
		}
		// Scope authorization and concurrency checks in the mutation itself.
		err = a.DB.QueryRowContext(c, `UPDATE transcription_summary_templates SET settings=$3,updated_at=now() WHERE id=$1 AND organization_id=$2 AND (created_by=$4 OR $5) AND updated_at=$6 RETURNING updated_at`, id, organizationID, string(data), principal.UserID, summaryTemplateAdmin(c), revision).Scan(&updated)
	}
	if err == sql.ErrNoRows {
		writeError(c, http.StatusConflict, fmt.Errorf("the template changed or you cannot edit it; reload and try again"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"template": transcriptionSummaryTemplate{transcriptionSummaryTemplateSettings: request.transcriptionSummaryTemplateSettings, ID: id, UpdatedAt: updated, CanEdit: true}})
}

func (a *App) deleteTranscriptionSummaryTemplate(c *gin.Context) {
	organizationID, _ := middleware.GetOrganizationID(c)
	principal, _ := middleware.GetPrincipal(c)
	id, err := uuid.Parse(c.Param("templateId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid template id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM transcription_summary_templates WHERE id=$1 AND organization_id=$2 AND (created_by=$3 OR $4)`, id, organizationID, principal.UserID, summaryTemplateAdmin(c))
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("template not found or you cannot edit it"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) chooseTranscriptionSummaryTemplate(c *gin.Context) {
	organizationID, _ := middleware.GetOrganizationID(c)
	principal, _ := middleware.GetPrincipal(c)
	var request struct {
		TemplateID string `json:"templateId"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	var value any
	if request.TemplateID != "" {
		id, err := uuid.Parse(request.TemplateID)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid template id"))
			return
		}
		if _, err = a.loadSummaryTemplate(c, id); err != nil {
			writeError(c, http.StatusNotFound, fmt.Errorf("template not found"))
			return
		}
		value = id
	}
	_, err := a.DB.ExecContext(c, `INSERT INTO transcription_summary_template_choices(organization_id,user_id,template_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,user_id) DO UPDATE SET template_id=$3`, organizationID, principal.UserID, value)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}
