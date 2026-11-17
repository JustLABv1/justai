package server

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

// A view link lets people without an account follow a session read-only: the live
// transcript, speakers and agenda items with their summaries. A session has at most one
// active link; creating a new one turns the old one off.

type transcriptionViewLink struct {
	Token     string    `json:"token"`
	CreatedAt time.Time `json:"createdAt"`
}

func hashViewToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (a *App) authorizedSessionParam(c *gin.Context) (uuid.UUID, bool) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return uuid.Nil, false
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return uuid.Nil, false
	}
	return sessionID, true
}

func (a *App) getTranscriptionViewLink(c *gin.Context) {
	sessionID, ok := a.authorizedSessionParam(c)
	if !ok {
		return
	}
	var ciphertext []byte
	var link transcriptionViewLink
	err := a.DB.QueryRowContext(c, `SELECT token_ciphertext, created_at FROM transcription_view_links WHERE session_id = $1 AND revoked_at IS NULL`, sessionID).Scan(&ciphertext, &link.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusOK, gin.H{"link": nil})
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if link.Token, err = a.Secrets.Decrypt(ciphertext); err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("the view link could not be read"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"link": link})
}

func (a *App) createTranscriptionViewLink(c *gin.Context) {
	sessionID, ok := a.authorizedSessionParam(c)
	if !ok {
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	ciphertext, err := a.Secrets.Encrypt(token)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(c, `UPDATE transcription_view_links SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, sessionID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	link := transcriptionViewLink{Token: token}
	if err := transaction.QueryRowContext(c, `INSERT INTO transcription_view_links (session_id, token_hash, token_ciphertext, created_by) VALUES ($1, $2, $3, $4) RETURNING created_at`, sessionID, hashViewToken(token), ciphertext, principal.UserID).Scan(&link.CreatedAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"link": link})
}

func (a *App) revokeTranscriptionViewLink(c *gin.Context) {
	sessionID, ok := a.authorizedSessionParam(c)
	if !ok {
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE transcription_view_links SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, sessionID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

type publicViewSegment struct {
	ID            uuid.UUID  `json:"id"`
	SpeakerID     *uuid.UUID `json:"speakerId,omitempty"`
	Text          string     `json:"text"`
	StartOffsetMs int64      `json:"startOffsetMs"`
	EndOffsetMs   int64      `json:"endOffsetMs"`
}

type publicViewSpeaker struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

type publicViewSource struct {
	Kind             string     `json:"kind"`
	Name             string     `json:"name"`
	TransportStatus  string     `json:"transportStatus,omitempty"`
	ScheduledStartAt *time.Time `json:"scheduledStartAt,omitempty"`
	ScheduledEndAt   *time.Time `json:"scheduledEndAt,omitempty"`
	InterruptedAt    *time.Time `json:"interruptedAt,omitempty"`
	CaptureScope     string     `json:"captureScope,omitempty"`
}

type publicViewTopic struct {
	ID              uuid.UUID  `json:"id"`
	Label           string     `json:"label"`
	Title           string     `json:"title"`
	Status          string     `json:"status"`
	Starred         bool       `json:"starred"`
	Missed          bool       `json:"missed,omitempty"`
	PlannedStartAt  *time.Time `json:"plannedStartAt,omitempty"`
	StartedOffsetMs *int64     `json:"startedOffsetMs,omitempty"`
	EndedOffsetMs   *int64     `json:"endedOffsetMs,omitempty"`
	Summary         string     `json:"summary,omitempty"`
}

// getTranscriptionView is public: GET /transcription/view/:token[?afterOffset=ms]. With
// afterOffset only newer lines are returned, so viewers can poll cheaply.
func (a *App) getTranscriptionView(c *gin.Context) {
	token := strings.TrimSpace(c.Param("token"))
	if len(token) < 16 || len(token) > 128 {
		writeError(c, http.StatusNotFound, fmt.Errorf("this link is not valid"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT link.session_id FROM transcription_view_links link JOIN transcription_sessions s ON s.id = link.session_id WHERE link.token_hash = $1 AND link.revoked_at IS NULL AND s.archived_at IS NULL`, hashViewToken(token)).Scan(&sessionID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("this link is not valid or was turned off"))
		return
	}
	afterOffset := int64(-1)
	if raw := c.Query("afterOffset"); raw != "" {
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil {
			afterOffset = value
		}
	}
	var session struct {
		Title     string     `json:"title"`
		Status    string     `json:"status"`
		Language  string     `json:"language"`
		StartedAt *time.Time `json:"startedAt,omitempty"`
		EndedAt   *time.Time `json:"endedAt,omitempty"`
	}
	if err := a.DB.QueryRowContext(c, `SELECT title, status, language, started_at, ended_at FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&session.Title, &session.Status, &session.Language, &session.StartedAt, &session.EndedAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, speaker_id, COALESCE(NULLIF(edited_text, ''), NULLIF(polished_text, ''), text), start_offset_ms, end_offset_ms FROM transcription_segments WHERE session_id = $1 AND canonical = TRUE AND start_offset_ms > $2 ORDER BY start_offset_ms, created_at LIMIT 20000`, sessionID, afterOffset)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	segments := []publicViewSegment{}
	for rows.Next() {
		var segment publicViewSegment
		if err := rows.Scan(&segment.ID, &segment.SpeakerID, &segment.Text, &segment.StartOffsetMs, &segment.EndOffsetMs); err != nil {
			rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		segments = append(segments, segment)
	}
	rows.Close()
	speakerRows, err := loadTranscriptionSpeakers(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	speakers := make([]publicViewSpeaker, 0, len(speakerRows))
	for _, speaker := range speakerRows {
		speakers = append(speakers, publicViewSpeaker{ID: speaker.ID, Name: firstNonEmptyString(speaker.DisplayName, speaker.Label), Color: speaker.Color})
	}
	sourceRows, err := loadTranscriptionSources(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	sources := make([]publicViewSource, 0, len(sourceRows))
	for _, source := range sourceRows {
		sources = append(sources, publicViewSource{Kind: source.Kind, Name: source.Name, TransportStatus: source.TransportStatus, ScheduledStartAt: source.ScheduledStartAt, ScheduledEndAt: source.ScheduledEndAt, InterruptedAt: source.InterruptedAt, CaptureScope: source.CaptureScope})
	}
	topicRows, err := loadTopics(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	topics := make([]publicViewTopic, 0, len(topicRows))
	for _, topic := range topicRows {
		item := publicViewTopic{ID: topic.ID, Label: topic.Label, Title: topic.Title, Status: topic.Status, Starred: topic.Starred, Missed: topic.DetectedBy == "missed", PlannedStartAt: topic.PlannedStartAt, StartedOffsetMs: topic.StartedOffsetMs, EndedOffsetMs: topic.EndedOffsetMs}
		if topic.SummaryStatus == "completed" {
			item.Summary = topic.Summary
		}
		topics = append(topics, item)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"session": session, "segments": segments, "speakers": speakers, "sources": sources, "topics": topics, "complete": afterOffset < 0})
}
