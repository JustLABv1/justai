package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
)

type transcriptionSummaryStandard struct {
	Name         string `json:"name"`
	Format       string `json:"format"`
	Instructions string `json:"instructions"`
	Summary      bool   `json:"summary"`
	Chapters     bool   `json:"chapters"`
	Topics       bool   `json:"topics"`
	ActionItems  bool   `json:"actionItems"`
	BoldSpeakers bool   `json:"boldSpeakers"`
}

func (a *App) getTranscriptionSummaryStandard(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var data []byte
	err := a.DB.QueryRowContext(c, `SELECT settings FROM transcription_summary_standards WHERE user_id=$1`, principal.UserID).Scan(&data)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusOK, gin.H{"standard": nil})
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var standard transcriptionSummaryStandard
	if err := json.Unmarshal(data, &standard); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"standard": standard})
}

func (a *App) saveTranscriptionSummaryStandard(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var standard transcriptionSummaryStandard
	if !decodeJSON(c, &standard) {
		return
	}
	standard.Name = strings.TrimSpace(standard.Name)
	standard.Instructions = strings.TrimSpace(standard.Instructions)
	if len(standard.Name) > 120 || len(standard.Instructions) > 4000 || (!standard.Summary && !standard.Chapters && !standard.Topics && !standard.ActionItems) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("choose at least one section and keep the standard name under 120 bytes and instructions under 4000 bytes"))
		return
	}
	switch standard.Format {
	case "pdf", "docx", "md", "txt", "json":
	default:
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported summary standard format"))
		return
	}
	data, err := json.Marshal(standard)
	if err == nil {
		_, err = a.DB.ExecContext(c, `INSERT INTO transcription_summary_standards(user_id,settings) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET settings=$2,updated_at=now()`, principal.UserID, string(data))
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"standard": standard})
}

func (a *App) deleteTranscriptionSummaryStandard(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `DELETE FROM transcription_summary_standards WHERE user_id=$1`, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}
