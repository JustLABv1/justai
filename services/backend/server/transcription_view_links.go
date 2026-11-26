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
	a.writeTranscriptView(c, sessionID)
}

func (a *App) getSharedTranscript(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	principal, _ := middleware.GetPrincipal(c)
	org, _ := middleware.GetOrganizationID(c)
	var allowed bool
	if err != nil || a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_sessions s WHERE s.id=$1 AND s.organization_id=$2 AND s.archived_at IS NULL AND (s.user_id=$3 OR EXISTS (SELECT 1 FROM transcription_readers r WHERE r.session_id=s.id AND r.user_id=$3 AND r.organization_id=$2)))`, id, org, principal.UserID).Scan(&allowed) != nil || !allowed {
		writeError(c, http.StatusNotFound, fmt.Errorf("transcript unavailable"))
		return
	}
	a.writeTranscriptView(c, id)
}

func (a *App) writeTranscriptView(c *gin.Context, sessionID uuid.UUID) {
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

func (a *App) transcriptionReaders(c *gin.Context) {
	id, ok := a.authorizedSessionParam(c)
	if !ok {
		return
	}
	org, _ := middleware.GetOrganizationID(c)
	principal, _ := middleware.GetPrincipal(c)
	switch c.Request.Method {
	case http.MethodPost:
		var body struct {
			Emails []string `json:"emails"`
		}
		if c.ShouldBindJSON(&body) != nil || len(body.Emails) == 0 || len(body.Emails) > 50 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("provide between 1 and 50 workspace addresses"))
			return
		}
		tx, err := a.DB.BeginTx(c, nil)
		if err != nil {
			writeError(c, 500, err)
			return
		}
		defer tx.Rollback()
		for _, email := range body.Emails {
			var userID uuid.UUID
			err = tx.QueryRowContext(c, `SELECT u.id FROM users u JOIN organization_members m ON m.user_id=u.id WHERE m.organization_id=$1 AND lower(u.email)=lower($2) AND u.status='active'`, org, strings.TrimSpace(email)).Scan(&userID)
			if errors.Is(err, sql.ErrNoRows) {
				writeError(c, 400, fmt.Errorf("address does not belong to an active workspace member"))
				return
			}
			if err != nil {
				writeError(c, 500, err)
				return
			}
			if userID != principal.UserID {
				if _, err = tx.ExecContext(c, `INSERT INTO transcription_readers(session_id,user_id,organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, id, userID, org); err != nil {
					writeError(c, 500, err)
					return
				}
			}
		}
		if err = tx.Commit(); err != nil {
			writeError(c, 500, err)
			return
		}
	case http.MethodDelete:
		reader, err := uuid.Parse(c.Param("reader"))
		if err != nil {
			writeError(c, 400, err)
			return
		}
		if _, err = a.DB.ExecContext(c, `DELETE FROM transcription_readers WHERE session_id=$1 AND user_id=$2`, id, reader); err != nil {
			writeError(c, 500, err)
			return
		}
	}
	rows, err := a.DB.QueryContext(c, `SELECT u.id,u.display_name,u.email FROM transcription_readers r JOIN users u ON u.id=r.user_id WHERE r.session_id=$1 ORDER BY u.display_name,u.email`, id)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	defer rows.Close()
	readers := []gin.H{}
	for rows.Next() {
		var uid uuid.UUID
		var name, email string
		if err := rows.Scan(&uid, &name, &email); err != nil {
			writeError(c, 500, err)
			return
		}
		readers = append(readers, gin.H{"id": uid, "name": name, "email": email})
	}
	if err := rows.Err(); err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, gin.H{"readers": readers})
}
