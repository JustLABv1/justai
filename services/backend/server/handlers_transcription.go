package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"justai-backend/auth"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type transcriptionSessionRequest struct {
	Title                 string `json:"title"`
	TranscriptionEndpoint string `json:"transcriptionEndpointId"`
	DiarizationEndpoint   string `json:"diarizationEndpointId"`
	Language              string `json:"language"`
	RecordAudio           bool   `json:"recordAudio"`
}

type transcriptionSourceRequest struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	DeviceLabel string `json:"deviceLabel"`
}

type transcriptionJoinRequest struct {
	Code        string `json:"code"`
	SourceName  string `json:"sourceName"`
	DeviceLabel string `json:"deviceLabel"`
}

type transcriptionSpeakerMergeRequest struct {
	SourceID string `json:"sourceId"`
	TargetID string `json:"targetId"`
}

type transcriptionRecordingRequest struct {
	SessionID string `json:"sessionId"`
	SourceID  string `json:"sourceId"`
	MimeType  string `json:"mimeType"`
}

type transcriptionTicketInfo struct {
	UserID         uuid.UUID
	OrganizationID uuid.UUID
	SessionID      uuid.UUID
	SourceID       uuid.UUID
	Kind           string
}

func (a *App) listTranscriptionSessions(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	archiveFilter := "s.archived_at IS NULL"
	if strings.EqualFold(strings.TrimSpace(c.Query("archived")), "true") {
		archiveFilter = "s.archived_at IS NOT NULL"
	}
	rows, err := a.DB.QueryContext(c, `
		SELECT s.id, s.user_id, s.organization_id, s.title, s.status,
		       s.transcription_endpoint_id, s.diarization_endpoint_id, s.language,
		       s.record_audio, s.started_at, s.ended_at, s.created_at, s.updated_at, s.archived_at,
		       (SELECT COUNT(*) FROM transcription_sources src WHERE src.session_id = s.id),
		       (SELECT COUNT(*) FROM transcription_segments seg WHERE seg.session_id = s.id AND seg.canonical = TRUE)
		FROM transcription_sessions s
		WHERE s.user_id = $1 AND s.organization_id = $2 AND `+archiveFilter+`
		ORDER BY s.updated_at DESC`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := make([]models.TranscriptionSession, 0)
	for rows.Next() {
		item, err := scanTranscriptionSession(rows)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": result})
}

func (a *App) createTranscriptionSession(c *gin.Context) {
	var request transcriptionSessionRequest
	if !decodeJSON(c, &request) {
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	transcriptionEndpoint, err := a.resolveTranscriptionEndpoint(c, principal.UserID, organizationID, request.TranscriptionEndpoint, "transcription")
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	diarizationEndpoint := uuid.Nil
	if request.DiarizationEndpoint != "" {
		diarizationEndpoint, err = a.resolveTranscriptionEndpoint(c, principal.UserID, organizationID, request.DiarizationEndpoint, "diarization")
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}
	if request.Language == "" {
		request.Language = "auto"
	}
	if strings.TrimSpace(request.Title) == "" {
		request.Title = "Live session"
	}
	code, codeHash, err := newJoinCode()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	expiresAt := time.Now().Add(10 * time.Minute)
	var item models.TranscriptionSession
	var transcriptionEndpointID, diarizationEndpointID uuid.NullUUID
	err = a.DB.QueryRowContext(c, `
		INSERT INTO transcription_sessions (user_id, organization_id, title, transcription_endpoint_id, diarization_endpoint_id, language, record_audio, join_code_hash, join_code_expires_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, '00000000-0000-0000-0000-000000000000'::uuid), $6, $7, $8, $9)
		RETURNING id, user_id, organization_id, title, status, transcription_endpoint_id, diarization_endpoint_id, language, record_audio, started_at, ended_at, created_at, updated_at`, principal.UserID, organizationID, request.Title, transcriptionEndpoint, diarizationEndpoint, request.Language, request.RecordAudio, codeHash, expiresAt).Scan(&item.ID, &item.UserID, &item.OrganizationID, &item.Title, &item.Status, &transcriptionEndpointID, &diarizationEndpointID, &item.Language, &item.RecordAudio, &item.StartedAt, &item.EndedAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if transcriptionEndpointID.Valid {
		item.TranscriptionEndpoint = &transcriptionEndpointID.UUID
	}
	if diarizationEndpointID.Valid {
		item.DiarizationEndpoint = &diarizationEndpointID.UUID
	}
	item.JoinCode = code
	c.JSON(http.StatusCreated, gin.H{"session": item, "joinCode": code})
}

func (a *App) getTranscriptionSession(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	snapshot, err := a.transcriptionSnapshot(c, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, snapshot)
}

func (a *App) updateTranscriptionSession(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request struct {
		Title    string `json:"title"`
		Archived *bool  `json:"archived"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	title := strings.TrimSpace(request.Title)
	if title == "" && request.Archived == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("title or archived is required"))
		return
	}
	if request.Archived == nil {
		_, err = a.DB.ExecContext(c, `UPDATE transcription_sessions SET title = $2, updated_at = now() WHERE id = $1`, id, title)
	} else if title == "" {
		_, err = a.DB.ExecContext(c, `UPDATE transcription_sessions SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`, id, *request.Archived)
	} else {
		_, err = a.DB.ExecContext(c, `UPDATE transcription_sessions SET title = $2, archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`, id, title, *request.Archived)
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": mustTranscriptionSession(c, a, id)})
}

func (a *App) deleteTranscriptionSession(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	// Read recording ids before touching object storage, then close the query
	// before issuing more database work. Keeping rows open while deleting files
	// can exhaust the small production pool when a session has many recordings.
	var recordingIDs []uuid.UUID
	if rows, queryErr := a.DB.QueryContext(c, `SELECT id FROM transcription_recordings WHERE session_id = $1`, id); queryErr == nil {
		for rows.Next() {
			var recordingID uuid.UUID
			if rows.Scan(&recordingID) == nil {
				recordingIDs = append(recordingIDs, recordingID)
			}
		}
		_ = rows.Close()
	}
	for _, recordingID := range recordingIDs {
		_ = a.Live.deleteRecording(c, recordingID)
	}
	a.Live.clearPCMForSession(id)
	// Stop active capture/viewer sockets before deleting the session. This
	// prevents a late websocket frame from recreating state after cleanup.
	a.Live.closeSession(id)
	_, err = a.DB.ExecContext(c, `DELETE FROM transcription_sessions WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) pauseTranscriptionSession(c *gin.Context) {
	a.setTranscriptionSessionStatus(c, "paused")
}

func (a *App) resumeTranscriptionSession(c *gin.Context) {
	a.setTranscriptionSessionStatus(c, "live")
}

func (a *App) stopTranscriptionSession(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	a.Live.flushPCMForSession(id)
	now := time.Now().UTC()
	_, err = a.DB.ExecContext(c, `UPDATE transcription_sessions SET status = 'completed', ended_at = COALESCE(ended_at, $2), updated_at = $2, join_code_hash = NULL, join_code_expires_at = NULL WHERE id = $1`, id, now)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.broadcast(id, "transcription.session", ginData{"status": "completed", "endedAt": now})
	a.Live.closeSession(id)
	c.JSON(http.StatusOK, gin.H{"session": mustTranscriptionSession(c, a, id)})
}

func (a *App) setTranscriptionSessionStatus(c *gin.Context, status string) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	if status != "paused" && status != "live" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported transcription session transition"))
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var currentStatus string
	if err := transaction.QueryRowContext(c, `SELECT status FROM transcription_sessions WHERE id = $1 FOR UPDATE`, id).Scan(&currentStatus); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("transcription session not found"))
		return
	}
	if currentStatus == "completed" || currentStatus == "processing" || currentStatus == "failed" {
		writeError(c, http.StatusConflict, fmt.Errorf("transcription session is no longer live"))
		return
	}
	if status == "paused" && currentStatus != "live" && currentStatus != "paused" {
		writeError(c, http.StatusConflict, fmt.Errorf("only a live transcription session can be paused"))
		return
	}
	if _, err := transaction.ExecContext(c, `UPDATE transcription_sessions SET status = $2, started_at = CASE WHEN $2 = 'live' THEN COALESCE(started_at, now()) ELSE started_at END, updated_at = now() WHERE id = $1`, id, status); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.broadcast(id, "transcription.session", ginData{"status": status})
	c.JSON(http.StatusOK, gin.H{"session": mustTranscriptionSession(c, a, id)})
}

func (a *App) createTranscriptionSource(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionSourceRequest
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.Name) == "" {
		request.Name = "This device"
	}
	if request.Kind == "" {
		request.Kind = "browser"
	}
	var source models.TranscriptionSource
	err = a.DB.QueryRowContext(c, `INSERT INTO transcription_sources (session_id, name, kind, device_label) VALUES ($1, $2, $3, $4) RETURNING id, session_id, name, kind, device_label, status, clock_offset_ms, connected_at, last_seen_at`, sessionID, strings.TrimSpace(request.Name), request.Kind, request.DeviceLabel).Scan(&source.ID, &source.SessionID, &source.Name, &source.Kind, &source.DeviceLabel, &source.Status, &source.ClockOffsetMs, &source.ConnectedAt, &source.LastSeenAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"source": source})
}

func (a *App) rotateTranscriptionJoinCode(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	code, codeHash, err := newJoinCode()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	expiresAt := time.Now().Add(10 * time.Minute)
	if _, err := a.DB.ExecContext(c, `UPDATE transcription_sessions SET join_code_hash = $2, join_code_expires_at = $3, updated_at = now() WHERE id = $1`, sessionID, codeHash, expiresAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"joinCode": code, "expiresAt": expiresAt})
}

func (a *App) listTranscriptionJoinRequests(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, source_name, device_label, status, source_id, expires_at, created_at FROM transcription_join_requests WHERE session_id = $1 AND status IN ('pending', 'approved') ORDER BY created_at DESC`, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := make([]ginData, 0)
	for rows.Next() {
		var id uuid.UUID
		var sourceName, deviceLabel, status string
		var sourceID uuid.NullUUID
		var expiresAt, createdAt time.Time
		if err := rows.Scan(&id, &sourceName, &deviceLabel, &status, &sourceID, &expiresAt, &createdAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, ginData{"id": id, "sourceName": sourceName, "deviceLabel": deviceLabel, "status": status, "sourceId": nullableUUIDValue(sourceID), "expiresAt": expiresAt, "createdAt": createdAt})
	}
	c.JSON(http.StatusOK, gin.H{"requests": result})
}

func (a *App) approveTranscriptionJoinRequest(c *gin.Context) {
	a.setJoinRequestStatus(c, "approved")
}

func (a *App) denyTranscriptionJoinRequest(c *gin.Context) {
	a.setJoinRequestStatus(c, "denied")
}

func (a *App) setJoinRequestStatus(c *gin.Context, status string) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	requestID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid join request id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT session_id FROM transcription_join_requests WHERE id = $1`, requestID).Scan(&sessionID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("join request not found"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var sessionStatus string
	if err := transaction.QueryRowContext(c, `SELECT status FROM transcription_sessions WHERE id = $1 FOR UPDATE`, sessionID).Scan(&sessionStatus); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("transcription session not found"))
		return
	}
	if sessionStatus == "completed" || sessionStatus == "processing" {
		writeError(c, http.StatusConflict, fmt.Errorf("transcription session is no longer accepting join requests"))
		return
	}
	var currentStatus, sourceName, deviceLabel string
	var sourceID uuid.NullUUID
	var requestExpiresAt time.Time
	if err := transaction.QueryRowContext(c, `SELECT status, source_name, device_label, source_id, expires_at FROM transcription_join_requests WHERE id = $1 FOR UPDATE`, requestID).Scan(&currentStatus, &sourceName, &deviceLabel, &sourceID, &requestExpiresAt); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("join request not found"))
		return
	}
	if currentStatus != "pending" {
		c.JSON(http.StatusOK, gin.H{"status": currentStatus})
		return
	}
	if !requestExpiresAt.After(time.Now()) {
		if _, err := transaction.ExecContext(c, `UPDATE transcription_join_requests SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'pending'`, requestID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if err := transaction.Commit(); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusGone, gin.H{"status": "expired"})
		return
	}
	if status == "approved" && !sourceID.Valid {
		if err := transaction.QueryRowContext(c, `INSERT INTO transcription_sources (session_id, name, kind, device_label, status) VALUES ($1, $2, 'browser', $3, 'pending') RETURNING id`, sessionID, strings.TrimSpace(sourceName), strings.TrimSpace(deviceLabel)).Scan(&sourceID.UUID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		sourceID.Valid = true
	}
	var updateErr error
	if sourceID.Valid {
		_, updateErr = transaction.ExecContext(c, `UPDATE transcription_join_requests SET status = $2, source_id = $3, updated_at = now() WHERE id = $1 AND status = 'pending'`, requestID, status, sourceID.UUID)
	} else {
		_, updateErr = transaction.ExecContext(c, `UPDATE transcription_join_requests SET status = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`, requestID, status)
	}
	if updateErr != nil {
		writeError(c, http.StatusInternalServerError, updateErr)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.broadcast(sessionID, "transcription.join-request", ginData{"requestId": requestID, "status": status})
	c.JSON(http.StatusOK, gin.H{"status": status})
}

func (a *App) renameTranscriptionSpeaker(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	speakerID, err := uuid.Parse(c.Param("speakerId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid speaker id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	displayName := strings.TrimSpace(request.DisplayName)
	if displayName == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("display name is required"))
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE transcription_speakers SET display_name = $3, updated_at = now() WHERE id = $1 AND session_id = $2`, speakerID, sessionID, displayName)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		writeError(c, http.StatusNotFound, fmt.Errorf("speaker not found"))
		return
	}
	a.Live.broadcast(sessionID, "transcription.speaker", ginData{"speakerId": speakerID, "displayName": displayName})
	c.Status(http.StatusNoContent)
}

func (a *App) mergeTranscriptionSpeakers(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionSpeakerMergeRequest
	if !decodeJSON(c, &request) {
		return
	}
	sourceID, sourceErr := uuid.Parse(request.SourceID)
	targetID, targetErr := uuid.Parse(request.TargetID)
	if sourceErr != nil || targetErr != nil || sourceID == targetID {
		writeError(c, http.StatusBadRequest, fmt.Errorf("sourceId and targetId must be different speakers"))
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var exists int
	if err := transaction.QueryRowContext(c, `SELECT COUNT(*) FROM transcription_speakers WHERE session_id = $1 AND id IN ($2, $3)`, sessionID, sourceID, targetID).Scan(&exists); err != nil || exists != 2 {
		writeError(c, http.StatusNotFound, fmt.Errorf("speakers not found"))
		return
	}
	if _, err := transaction.ExecContext(c, `UPDATE transcription_speakers SET merged_into = $3, updated_at = now() WHERE session_id = $1 AND id = $2`, sessionID, sourceID, targetID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `UPDATE transcription_segments SET speaker_id = $3, updated_at = now() WHERE session_id = $1 AND speaker_id = $2`, sessionID, sourceID, targetID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.broadcast(sessionID, "transcription.speaker.merged", ginData{"sourceId": sourceID, "targetId": targetID})
	c.Status(http.StatusNoContent)
}

func (a *App) createTranscriptionJoinRequest(c *gin.Context) {
	if a.Live != nil && !a.Live.allowJoin(c.ClientIP()) {
		writeError(c, http.StatusTooManyRequests, fmt.Errorf("too many join attempts; try again later"))
		return
	}
	var request transcriptionJoinRequest
	if !decodeJSON(c, &request) {
		return
	}
	codeHash := hashToken(strings.ToUpper(strings.TrimSpace(request.Code)))
	var sessionID uuid.UUID
	var title, status string
	if err := a.DB.QueryRowContext(c, `SELECT id, title, status FROM transcription_sessions WHERE join_code_hash = $1 AND join_code_expires_at > now() AND status IN ('waiting', 'live', 'paused')`, codeHash).Scan(&sessionID, &title, &status); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("room code is invalid or expired"))
		return
	}
	if strings.TrimSpace(request.SourceName) == "" {
		request.SourceName = "Room microphone"
	}
	pollToken, pollHash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	requestID := uuid.New()
	expiresAt := time.Now().Add(10 * time.Minute)
	if _, err := a.DB.ExecContext(c, `INSERT INTO transcription_join_requests (id, session_id, request_hash, source_name, device_label, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`, requestID, sessionID, pollHash, strings.TrimSpace(request.SourceName), strings.TrimSpace(request.DeviceLabel), expiresAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.broadcast(sessionID, "transcription.join-request", ginData{"requestId": requestID, "sourceName": strings.TrimSpace(request.SourceName), "status": "pending"})
	c.JSON(http.StatusCreated, gin.H{"requestId": requestID, "pollToken": pollToken, "sessionTitle": title, "sessionStatus": status, "expiresAt": expiresAt})
}

func (a *App) getTranscriptionJoinRequest(c *gin.Context) {
	requestID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid join request id"))
		return
	}
	token := c.Query("token")
	if token == "" {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("poll token is required"))
		return
	}
	var storedHash, status, sourceName, deviceLabel string
	var sessionID uuid.UUID
	var sourceID uuid.NullUUID
	var expiresAt time.Time
	var grantHash sql.NullString
	var encryptedGrant []byte
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	err = transaction.QueryRowContext(c, `SELECT request_hash, session_id, source_name, device_label, status, source_id, expires_at, grant_hash, grant_token_encrypted FROM transcription_join_requests WHERE id = $1 FOR UPDATE`, requestID).Scan(&storedHash, &sessionID, &sourceName, &deviceLabel, &status, &sourceID, &expiresAt, &grantHash, &encryptedGrant)
	if err != nil || storedHash != hashToken(token) || expiresAt.Before(time.Now()) {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid or expired poll token"))
		return
	}
	result := ginData{"requestId": requestID, "sessionId": sessionID, "sourceName": sourceName, "deviceLabel": deviceLabel, "status": status, "sourceId": nullableUUIDValue(sourceID), "expiresAt": expiresAt}
	if status == "approved" && sourceID.Valid {
		var sessionStatus string
		if err := transaction.QueryRowContext(c, `SELECT status FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&sessionStatus); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if sessionStatus == "completed" || sessionStatus == "processing" {
			status = "expired"
			result["status"] = status
			_, _ = transaction.ExecContext(c, `UPDATE transcription_join_requests SET status = 'expired', grant_hash = NULL, grant_token_encrypted = NULL, updated_at = now() WHERE id = $1`, requestID)
		} else {
			var grant string
			if len(encryptedGrant) > 0 {
				grant, err = a.Secrets.Decrypt(encryptedGrant)
				if err != nil {
					writeError(c, http.StatusInternalServerError, fmt.Errorf("could not recover capture grant"))
					return
				}
			} else {
				grant, grantHashValue, tokenErr := auth.NewOpaqueToken()
				if tokenErr != nil {
					writeError(c, http.StatusInternalServerError, tokenErr)
					return
				}
				encryptedGrant, err = a.Secrets.Encrypt(grant)
				if err != nil {
					writeError(c, http.StatusInternalServerError, err)
					return
				}
				if _, err := transaction.ExecContext(c, `UPDATE transcription_join_requests SET grant_hash = $2, grant_token_encrypted = $3, updated_at = now() WHERE id = $1 AND status = 'approved'`, requestID, grantHashValue, encryptedGrant); err != nil {
					writeError(c, http.StatusInternalServerError, err)
					return
				}
			}
			result["captureGrant"] = grant
		}
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (a *App) createCaptureWSTicket(c *gin.Context) {
	grant := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	if grant == "" {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("capture grant is required"))
		return
	}
	grantHash := hashToken(grant)
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var requestID, sessionID, sourceID, userID, organizationID uuid.UUID
	var expiresAt time.Time
	err = transaction.QueryRowContext(c, `SELECT jr.id, jr.session_id, jr.source_id, s.user_id, s.organization_id, jr.expires_at FROM transcription_join_requests jr JOIN transcription_sessions s ON s.id = jr.session_id WHERE jr.grant_hash = $1 AND jr.status = 'approved' AND s.status IN ('waiting', 'live', 'paused') AND jr.expires_at > now() FOR UPDATE`, grantHash).Scan(&requestID, &sessionID, &sourceID, &userID, &organizationID, &expiresAt)
	if err != nil {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid or expired capture grant"))
		return
	}
	value, hash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	ticketExpires := time.Now().Add(2 * time.Minute)
	if _, err := transaction.ExecContext(c, `UPDATE transcription_join_requests SET grant_hash = NULL, grant_token_encrypted = NULL, updated_at = now() WHERE id = $1`, requestID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `INSERT INTO ws_tickets (token_hash, user_id, organization_id, kind, session_id, source_id, expires_at) VALUES ($1, $2, $3, 'transcription-capture', $4, $5, $6)`, hash, userID, organizationID, sessionID, sourceID, ticketExpires); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ticket": value, "expiresAt": ticketExpires, "kind": "transcription-capture"})
}

func (a *App) transcriptionWebSocket(c *gin.Context) {
	info, err := a.consumeTranscriptionTicket(c, c.Query("ticket"))
	if err != nil {
		writeError(c, http.StatusUnauthorized, err)
		return
	}
	connection, err := a.upgradeWebSocket(c)
	if err != nil {
		return
	}
	defer connection.Close()
	a.runRoomTranscriptionSocket(c, connection, info)
}

func (a *App) runRoomTranscriptionSocket(ctx *gin.Context, connection *websocket.Conn, info transcriptionTicketInfo) {
	client := &transcriptionClient{connection: connection, role: info.Kind, sourceID: info.SourceID}
	a.Live.register(info.SessionID, client)
	defer a.Live.unregister(info.SessionID, client)
	if info.Kind == "transcription-viewer" || info.Kind == "transcription" {
		snapshot, err := a.transcriptionSnapshot(ctx, info.SessionID)
		if err != nil {
			_ = a.Live.send(client, "error", ginData{"message": err.Error()})
			return
		}
		_ = a.Live.send(client, "transcription.snapshot", snapshot)
		for {
			messageType, payload, err := connection.ReadMessage()
			if err != nil {
				return
			}
			if messageType == websocket.TextMessage {
				var event struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(payload, &event) == nil && event.Type == "ping" {
					_ = a.Live.send(client, "pong", ginData{"serverTime": time.Now().UnixMilli()})
				}
			}
		}
	}

	var sessionEndpoint uuid.UUID
	var language, sessionStatus string
	if err := a.DB.QueryRowContext(ctx, `SELECT transcription_endpoint_id, language, status FROM transcription_sessions WHERE id = $1`, info.SessionID).Scan(&sessionEndpoint, &language, &sessionStatus); err != nil {
		_ = a.Live.send(client, "error", ginData{"message": "transcription session is not configured"})
		return
	}
	if sessionStatus == "completed" || sessionStatus == "processing" {
		_ = a.Live.send(client, "error", ginData{"message": "transcription session is no longer live"})
		return
	}
	endpoint, err := a.providerEndpoint(ctx, sessionEndpoint)
	if err != nil {
		_ = a.Live.send(client, "error", ginData{"message": "transcription endpoint could not be loaded: " + err.Error()})
		return
	}
	mode := transcriptionMode(endpoint)
	if mode == "" {
		_ = a.Live.send(client, "error", ginData{"message": fmt.Sprintf("provider %s does not support a compatible transcription transport", endpoint.ProviderType)})
		return
	}
	var stream provider.TranscriptionStream
	if mode == "chunked" {
		stream, err = provider.OpenChunked(ctx, endpoint, endpoint.TranscriptionModel, language, provider.ChunkedOptions{
			Window:         time.Duration(a.Config.Transcription.StreamingChunkMs) * time.Millisecond,
			Overlap:        time.Duration(a.Config.Transcription.StreamingOverlapMs) * time.Millisecond,
			PromptMaxChars: a.Config.Transcription.StreamingPromptChars,
		})
	} else {
		stream, err = provider.OpenRealtime(ctx, endpoint, endpoint.TranscriptionModel, language)
	}
	if err != nil {
		_ = a.Live.send(client, "error", ginData{"message": "transcription provider connection failed: " + err.Error()})
		return
	}
	a.Live.markSource(info.SessionID, info.SourceID, "connected")
	started := time.Now()
	var latestCaptureOffset atomic.Int64
	_ = a.Live.send(client, "transcription.ready", ginData{"sessionId": info.SessionID, "sourceId": info.SourceID, "provider": endpoint.ProviderType, "model": endpoint.TranscriptionModel, "mode": mode})
	providerDone := make(chan struct{})
	voiceActive := false
	lastVoiceAt := time.Time{}
	const voiceHangover = 650 * time.Millisecond
	lastStatusCheck := time.Now()
	go func() {
		defer close(providerDone)
		for event := range stream.Events() {
			if event.Err != nil {
				a.Live.broadcast(info.SessionID, "error", ginData{"sourceId": info.SourceID, "message": event.Err.Error()})
				_ = connection.Close()
				return
			}
			event.Text = provider.CleanTranscriptText(event.Text)
			if event.Text == "" {
				continue
			}
			if isTranscriptionProtocolPayload(event.Text) {
				continue
			}
			if event.Kind == "partial" {
				a.Live.broadcast(info.SessionID, "transcription.partial", ginData{"sourceId": info.SourceID, "text": event.Text})
				continue
			}
			if event.Kind == "final" {
				offset := latestCaptureOffset.Load()
				if offset <= 0 {
					offset = time.Since(started).Milliseconds()
				}
				startOffset := maxInt64(0, offset-3000)
				endOffset := offset
				if event.EndOffsetMs > 0 {
					startOffset = maxInt64(0, event.StartOffsetMs)
					endOffset = event.EndOffsetMs
				}
				segment, persistErr := a.persistTranscriptionSegment(ctx, info.SessionID, info.SourceID, strings.TrimSpace(event.Text), startOffset, endOffset)
				if persistErr != nil {
					a.Live.broadcast(info.SessionID, "error", ginData{"sourceId": info.SourceID, "message": "could not persist transcript: " + persistErr.Error()})
					continue
				}
				a.Live.broadcast(info.SessionID, "transcription.final", ginData{"sourceId": info.SourceID, "segment": segment})
			}
		}
	}()
	defer func() {
		stream.Close()
		<-providerDone
		a.Live.markSource(info.SessionID, info.SourceID, "disconnected")
		a.Live.flushPCM(info.SessionID, info.SourceID)
		a.Live.clearPCM(info.SourceID)
	}()

	for {
		messageType, payload, err := connection.ReadMessage()
		if err != nil {
			return
		}
		if messageType == websocket.TextMessage {
			var event struct {
				Type  string  `json:"type"`
				Level float64 `json:"level"`
			}
			if json.Unmarshal(payload, &event) != nil {
				continue
			}
			switch event.Type {
			case "source.level":
				a.Live.updateSourceLevel(info.SessionID, info.SourceID, event.Level)
			case "transcription.stop":
				if err := stream.Commit(); err != nil {
					a.Live.broadcast(info.SessionID, "error", ginData{"sourceId": info.SourceID, "message": "transcription finalization failed: " + err.Error()})
				}
				return
			case "ping":
				_ = a.Live.send(client, "pong", ginData{"serverTime": time.Now().UnixMilli()})
			}
			continue
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		if time.Since(lastStatusCheck) >= time.Second {
			if err := a.DB.QueryRowContext(ctx, `SELECT status FROM transcription_sessions WHERE id = $1`, info.SessionID).Scan(&sessionStatus); err != nil {
				return
			}
			lastStatusCheck = time.Now()
			if sessionStatus == "completed" || sessionStatus == "processing" {
				return
			}
		}
		if sessionStatus == "paused" {
			continue
		}
		frame := parseAudioFrame(payload)
		pcm := frame.PCM
		if len(pcm) == 0 {
			continue
		}
		pcm16 := provider.ResamplePCM16(pcm, frame.SampleRate, 16000)
		hasSpeech := provider.PCM16HasSpeech(pcm16)
		if hasSpeech {
			voiceActive = true
			lastVoiceAt = time.Now()
		} else if !voiceActive || time.Since(lastVoiceAt) > voiceHangover {
			voiceActive = false
			continue
		}
		if err := stream.SendPCM(ctx, pcm, frame.SampleRate); err != nil {
			a.Live.broadcast(info.SessionID, "error", ginData{"sourceId": info.SourceID, "message": fmt.Sprintf("transcription audio transport failed (%s): %v", mode, err)})
			return
		}
		if frame.CaptureTimestamp > 0 {
			latestCaptureOffset.Store(a.Live.captureOffset(info.SessionID, info.SourceID, frame.CaptureTimestamp))
		}
		a.Live.appendPCM(info.SessionID, info.SourceID, pcm16)
	}
}

func (a *App) processDiarizationWindow(sessionID, sourceID uuid.UUID, startOffset int64, pcm []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var endpointID uuid.NullUUID
	var language string
	if err := a.DB.QueryRowContext(ctx, `SELECT diarization_endpoint_id, language FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&endpointID, &language); err != nil || !endpointID.Valid {
		return
	}
	endpoint, err := a.providerEndpoint(ctx, endpointID.UUID)
	if err != nil || !endpointSupports(endpoint, "diarization") {
		return
	}
	segments, err := provider.Diarize(ctx, endpoint, pcm, language)
	if err != nil {
		a.Live.broadcast(sessionID, "transcription.diarization-error", ginData{"message": err.Error()})
		return
	}
	for _, item := range segments {
		if strings.TrimSpace(item.Text) == "" || strings.TrimSpace(item.Speaker) == "" {
			continue
		}
		speakerID, err := a.ensureTranscriptionSpeaker(ctx, sessionID, item.Speaker)
		if err != nil {
			continue
		}
		start := startOffset + int64(item.Start*1000)
		end := startOffset + int64(item.End*1000)
		var segmentID uuid.UUID
		err = a.DB.QueryRowContext(ctx, `SELECT id FROM transcription_segments WHERE session_id = $1 AND source_id = $2 AND start_offset_ms <= $4 AND end_offset_ms >= $3 ORDER BY ABS(start_offset_ms - $3) LIMIT 1`, sessionID, sourceID, start, end).Scan(&segmentID)
		if err == nil {
			_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_segments SET speaker_id = $2, updated_at = now() WHERE id = $1`, segmentID, speakerID)
			a.Live.broadcast(sessionID, "transcription.segment.updated", ginData{"segmentId": segmentID, "speakerId": speakerID})
			continue
		}
		segment, err := a.persistTranscriptionSegmentWithSpeaker(ctx, sessionID, sourceID, speakerID, strings.TrimSpace(item.Text), start, end)
		if err == nil {
			a.Live.broadcast(sessionID, "transcription.final", ginData{"sourceId": sourceID, "segment": segment, "fromDiarization": true})
		}
	}
}

func (a *App) persistTranscriptionSegment(ctx context.Context, sessionID, sourceID uuid.UUID, text string, start, end int64) (models.TranscriptionSegment, error) {
	return a.persistTranscriptionSegmentWithSpeaker(ctx, sessionID, sourceID, uuid.Nil, text, start, end)
}

func (a *App) persistTranscriptionSegmentWithSpeaker(ctx context.Context, sessionID, sourceID, speakerID uuid.UUID, text string, start, end int64) (models.TranscriptionSegment, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return models.TranscriptionSegment{}, fmt.Errorf("transcript segment is empty")
	}
	if existing, merged, err := a.mergeTranscriptionSegment(ctx, sessionID, sourceID, speakerID, text, start, end); err != nil {
		return models.TranscriptionSegment{}, err
	} else if merged {
		return existing, nil
	}
	var segment models.TranscriptionSegment
	var sourceValue, speakerValue uuid.NullUUID
	if sourceID != uuid.Nil {
		sourceValue.Valid = true
		sourceValue.UUID = sourceID
	}
	if speakerID != uuid.Nil {
		speakerValue.Valid = true
		speakerValue.UUID = speakerID
	}
	heardBy := []uuid.UUID{}
	if sourceID != uuid.Nil {
		heardBy = append(heardBy, sourceID)
	}
	heardJSON, _ := json.Marshal(heardBy)
	var heard []byte
	err := a.DB.QueryRowContext(ctx, `INSERT INTO transcription_segments (session_id, source_id, speaker_id, text, start_offset_ms, end_offset_ms, canonical, heard_by_source_ids) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7) RETURNING id, session_id, source_id, speaker_id, text, start_offset_ms, end_offset_ms, confidence, signal_quality, canonical, heard_by_source_ids, created_at, updated_at`, sessionID, nullableUUIDValue(sourceValue), nullableUUIDValue(speakerValue), text, start, end, heardJSON).Scan(&segment.ID, &segment.SessionID, &sourceValue, &speakerValue, &segment.Text, &segment.StartOffsetMs, &segment.EndOffsetMs, &segment.Confidence, &segment.SignalQuality, &segment.Canonical, &heard, &segment.CreatedAt, &segment.UpdatedAt)
	if err != nil {
		return segment, err
	}
	segment.HeardBySourceIDs, err = decodeTranscriptionSourceIDs(heard)
	if err != nil {
		return segment, err
	}
	if sourceValue.Valid {
		segment.SourceID = &sourceValue.UUID
	}
	if speakerValue.Valid {
		segment.SpeakerID = &speakerValue.UUID
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = CASE WHEN status = 'waiting' THEN 'live' ELSE status END, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`, sessionID)
	return segment, nil
}

func (a *App) mergeTranscriptionSegment(ctx context.Context, sessionID, sourceID, speakerID uuid.UUID, text string, start, end int64) (models.TranscriptionSegment, bool, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT id, session_id, source_id, speaker_id, text, start_offset_ms, end_offset_ms, confidence, signal_quality, canonical, heard_by_source_ids, created_at, updated_at FROM transcription_segments WHERE session_id = $1 AND canonical = TRUE AND start_offset_ms <= $2 AND end_offset_ms >= $3 ORDER BY ABS(start_offset_ms - $4) LIMIT 24`, sessionID, end+1500, start-1500, start)
	if err != nil {
		return models.TranscriptionSegment{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var item models.TranscriptionSegment
		var sourceValue, speakerValue uuid.NullUUID
		var heard []byte
		if err := rows.Scan(&item.ID, &item.SessionID, &sourceValue, &speakerValue, &item.Text, &item.StartOffsetMs, &item.EndOffsetMs, &item.Confidence, &item.SignalQuality, &item.Canonical, &heard, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return models.TranscriptionSegment{}, false, err
		}
		if !transcriptionTextsMatch(item.Text, text) {
			continue
		}
		if isTranscriptionProtocolPayload(item.Text) {
			continue
		}
		if sourceValue.Valid {
			item.SourceID = &sourceValue.UUID
		}
		if speakerValue.Valid {
			item.SpeakerID = &speakerValue.UUID
		}
		item.HeardBySourceIDs, err = decodeTranscriptionSourceIDs(heard)
		if err != nil {
			return models.TranscriptionSegment{}, false, err
		}
		if item.SourceID != nil && !containsUUID(item.HeardBySourceIDs, *item.SourceID) {
			item.HeardBySourceIDs = append(item.HeardBySourceIDs, *item.SourceID)
		}
		if sourceID != uuid.Nil && !containsUUID(item.HeardBySourceIDs, sourceID) {
			item.HeardBySourceIDs = append(item.HeardBySourceIDs, sourceID)
		}
		if speakerID != uuid.Nil && item.SpeakerID == nil {
			item.SpeakerID = &speakerID
		}
		heardJSON, _ := json.Marshal(item.HeardBySourceIDs)
		if _, err := a.DB.ExecContext(ctx, `UPDATE transcription_segments SET speaker_id = COALESCE(speaker_id, $2), heard_by_source_ids = $3, updated_at = now() WHERE id = $1`, item.ID, nullableUUID(item.SpeakerID), heardJSON); err != nil {
			return models.TranscriptionSegment{}, false, err
		}
		item.UpdatedAt = time.Now().UTC()
		return item, true, nil
	}
	return models.TranscriptionSegment{}, false, rows.Err()
}

func nullableUUID(value *uuid.UUID) any {
	if value == nil || *value == uuid.Nil {
		return nil
	}
	return *value
}

func containsUUID(values []uuid.UUID, target uuid.UUID) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func decodeTranscriptionSourceIDs(raw []byte) ([]uuid.UUID, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return []uuid.UUID{}, nil
	}
	var values []uuid.UUID
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("decode heard_by_source_ids: %w", err)
	}
	if values == nil {
		values = []uuid.UUID{}
	}
	return values, nil
}

func isTranscriptionProtocolPayload(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(normalized, "transcription.chunk") && strings.Contains(normalized, "choices") && strings.Contains(normalized, "delta")
}

func transcriptionTextsMatch(left, right string) bool {
	leftNormalized := normalizeTranscriptText(left)
	rightNormalized := normalizeTranscriptText(right)
	if leftNormalized == "" || rightNormalized == "" {
		return false
	}
	if leftNormalized == rightNormalized {
		return true
	}
	leftTokens := strings.Fields(leftNormalized)
	rightTokens := strings.Fields(rightNormalized)
	if len(leftTokens) < 2 || len(rightTokens) < 2 {
		return false
	}
	leftSet := make(map[string]struct{}, len(leftTokens))
	rightSet := make(map[string]struct{}, len(rightTokens))
	for _, token := range leftTokens {
		leftSet[token] = struct{}{}
	}
	for _, token := range rightTokens {
		rightSet[token] = struct{}{}
	}
	intersection := 0
	for token := range leftSet {
		if _, ok := rightSet[token]; ok {
			intersection++
		}
	}
	union := len(leftSet) + len(rightSet) - intersection
	return union > 0 && float64(intersection)/float64(union) >= 0.82
}

func normalizeTranscriptText(value string) string {
	var builder strings.Builder
	previousSpace := false
	for _, char := range strings.ToLower(value) {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			builder.WriteRune(char)
			previousSpace = false
			continue
		}
		if !previousSpace {
			builder.WriteByte(' ')
			previousSpace = true
		}
	}
	return strings.TrimSpace(builder.String())
}

func (a *App) ensureTranscriptionSpeaker(ctx context.Context, sessionID uuid.UUID, label string) (uuid.UUID, error) {
	var id uuid.UUID
	err := a.DB.QueryRowContext(ctx, `INSERT INTO transcription_speakers (session_id, label, color) VALUES ($1, $2, $3) ON CONFLICT (session_id, label) DO UPDATE SET label = EXCLUDED.label RETURNING id`, sessionID, label, speakerColor(label)).Scan(&id)
	return id, err
}

func (a *App) transcriptionSnapshot(ctx context.Context, sessionID uuid.UUID) (gin.H, error) {
	session, err := loadTranscriptionSession(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	sources, err := loadTranscriptionSources(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	speakers, err := loadTranscriptionSpeakers(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	segments, err := loadTranscriptionSegments(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	recordings, err := loadTranscriptionRecordings(ctx, a.DB, sessionID)
	if err != nil {
		return nil, err
	}
	return gin.H{"session": session, "sources": sources, "speakers": speakers, "segments": segments, "recordings": recordings}, nil
}

func (a *App) listTranscriptionRecordings(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	recordings, err := loadTranscriptionRecordings(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"recordings": recordings})
}

func (a *App) startTranscriptionRecording(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	recordingRequest := transcriptionRecordingRequest{}
	if !decodeJSON(c, &recordingRequest) {
		return
	}
	sessionID, err := uuid.Parse(recordingRequest.SessionID)
	sourceID, sourceErr := uuid.Parse(recordingRequest.SourceID)
	if err != nil || sourceErr != nil || a.authorizeTranscriptionSource(c, sessionID, sourceID, principal.UserID, organizationID) != nil {
		writeError(c, http.StatusForbidden, fmt.Errorf("session or source is not accessible"))
		return
	}
	recording, err := a.Live.startRecording(c, sessionID, sourceID, recordingRequest.MimeType)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"recording": recording})
}

func (a *App) appendTranscriptionRecordingPart(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid recording id"))
		return
	}
	part, err := strconv.Atoi(c.Param("part"))
	if err != nil || part < 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid recording part"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT session_id FROM transcription_recordings WHERE id = $1`, recordingID).Scan(&sessionID); err != nil || a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID) != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("recording not found"))
		return
	}
	const maxRecordingPartBytes = 16 * 1024 * 1024
	payload, err := io.ReadAll(io.LimitReader(c.Request.Body, maxRecordingPartBytes+1))
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if len(payload) > maxRecordingPartBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("recording parts are limited to 16 MB"))
		return
	}
	if err := a.Live.appendRecording(c, recordingID, part, payload); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) completeTranscriptionRecording(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid recording id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT session_id FROM transcription_recordings WHERE id = $1`, recordingID).Scan(&sessionID); err != nil || a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID) != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("recording not found"))
		return
	}
	if err := a.Live.completeRecording(c, recordingID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) deleteTranscriptionRecording(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid recording id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT session_id FROM transcription_recordings WHERE id = $1`, recordingID).Scan(&sessionID); err != nil || a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID) != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("recording not found"))
		return
	}
	if err := a.Live.deleteRecording(c, recordingID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) streamTranscriptionRecording(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	recordingID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid recording id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT session_id FROM transcription_recordings WHERE id = $1`, recordingID).Scan(&sessionID); err != nil || a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID) != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("recording not found"))
		return
	}
	reader, mimeType, err := a.Live.recordingReader(c, recordingID)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	defer reader.Close()
	c.Header("Content-Type", mimeType)
	c.Header("Cache-Control", "private, no-store")
	_, _ = io.Copy(c.Writer, reader)
}

func (a *App) consumeTranscriptionTicket(ctx context.Context, value string) (transcriptionTicketInfo, error) {
	if value == "" {
		return transcriptionTicketInfo{}, fmt.Errorf("websocket ticket is required")
	}
	hash := hashToken(value)
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return transcriptionTicketInfo{}, err
	}
	defer transaction.Rollback()
	var info transcriptionTicketInfo
	var ticketUser uuid.UUID
	err = transaction.QueryRowContext(ctx, `SELECT user_id, organization_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid), kind FROM ws_tickets WHERE token_hash = $1 AND kind IN ('transcription', 'transcription-viewer', 'transcription-capture') AND expires_at > now() AND used_at IS NULL FOR UPDATE`, hash).Scan(&ticketUser, &info.OrganizationID, &info.SessionID, &info.SourceID, &info.Kind)
	if err != nil {
		return transcriptionTicketInfo{}, fmt.Errorf("invalid or expired websocket ticket")
	}
	info.UserID = ticketUser
	if _, err := transaction.ExecContext(ctx, `UPDATE ws_tickets SET used_at = now() WHERE token_hash = $1`, hash); err != nil {
		return transcriptionTicketInfo{}, err
	}
	if err := transaction.Commit(); err != nil {
		return transcriptionTicketInfo{}, err
	}
	return info, nil
}

func (a *App) authorizeTranscriptionSession(ctx context.Context, sessionID, userID, organizationID uuid.UUID) error {
	var exists bool
	if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM transcription_sessions WHERE id = $1 AND user_id = $2 AND organization_id = $3)`, sessionID, userID, organizationID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("transcription session not found")
	}
	return nil
}

func (a *App) authorizeTranscriptionSource(ctx context.Context, sessionID, sourceID, userID, organizationID uuid.UUID) error {
	if err := a.authorizeTranscriptionSession(ctx, sessionID, userID, organizationID); err != nil {
		return err
	}
	var exists bool
	if err := a.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM transcription_sources WHERE id = $1 AND session_id = $2)`, sourceID, sessionID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("transcription source not found")
	}
	return nil
}

func (a *App) resolveTranscriptionEndpoint(ctx context.Context, userID, organizationID uuid.UUID, rawID, capability string) (uuid.UUID, error) {
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("invalid endpoint id")
		}
		endpoint, err := a.getEndpoint(ctx, id)
		if err != nil || !endpoint.Enabled {
			return uuid.Nil, fmt.Errorf("endpoint not found")
		}
		if !endpointSupportsModel(endpoint, capability) {
			return uuid.Nil, fmt.Errorf("endpoint does not support %s", capability)
		}
		if err := a.canUseEndpoint(endpoint, middleware.Principal{UserID: userID}, organizationID); err != nil {
			return uuid.Nil, err
		}
		return id, nil
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id, provider_type, capabilities FROM endpoint_settings WHERE enabled = TRUE AND ((scope_type = 'user' AND scope_id = $1) OR (scope_type = 'organization' AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = 'user' THEN 1 WHEN scope_type = 'organization' THEN 2 ELSE 3 END, is_default DESC, created_at`, userID, organizationID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("no endpoint with %s capability is configured", capability)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var providerType string
		var capabilities []byte
		if err := rows.Scan(&id, &providerType, &capabilities); err != nil {
			return uuid.Nil, err
		}
		candidate := models.Endpoint{ProviderType: providerType, Capabilities: capabilities}
		if endpointSupportsModel(candidate, capability) {
			return id, nil
		}
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, err
	}
	return uuid.Nil, fmt.Errorf("no endpoint with %s capability is configured", capability)
}

func endpointSupportsModel(endpoint models.Endpoint, capability string) bool {
	var capabilities map[string]bool
	if json.Unmarshal(endpoint.Capabilities, &capabilities) == nil {
		if enabled, declared := capabilities[capability]; declared {
			return enabled
		}
	}
	if capability == "transcription" {
		if enabled := capabilities["chunked-transcription"]; enabled {
			return true
		}
		if enabled := capabilities["realtime-transcription"]; enabled {
			return true
		}
		if _, declared := capabilities["chunked-transcription"]; declared {
			return false
		}
		if _, declared := capabilities["realtime-transcription"]; declared {
			return false
		}
		return endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini"
	}
	return (capability == "realtime-transcription" && (endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini")) || (capability == "diarization" && (endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini")) || (capability == "tts" && (endpoint.ProviderType == "openai" || endpoint.ProviderType == "openai-compatible"))
}

func endpointSupports(endpoint provider.Endpoint, capability string) bool {
	if endpoint.Capabilities != nil {
		if enabled, declared := endpoint.Capabilities[capability]; declared {
			return enabled
		}
	}
	if capability == "transcription" {
		return endpoint.Capabilities["realtime-transcription"] || endpoint.Capabilities["chunked-transcription"] || endpoint.Capabilities["transcription"] || endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini"
	}
	switch capability {
	case "realtime-transcription":
		return endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini"
	case "diarization":
		return endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini"
	case "tts":
		return endpoint.ProviderType == "openai" || endpoint.ProviderType == "openai-compatible"
	default:
		return false
	}
}

func transcriptionMode(endpoint provider.Endpoint) string {
	if enabled, declared := endpoint.Capabilities["chunked-transcription"]; declared && enabled {
		return "chunked"
	}
	// Whisper-style models are finite HTTP transcription models on
	// OpenAI-compatible gateways. A stale endpoint record can still have only
	// realtime-transcription enabled; do not attempt the realtime protocol for
	// a Whisper model, because it will accept the socket but never emit text.
	if endpoint.ProviderType == "openai-compatible" && strings.Contains(strings.ToLower(endpoint.TranscriptionModel), "whisper") {
		return "chunked"
	}
	if enabled, declared := endpoint.Capabilities["realtime-transcription"]; declared && enabled {
		return "realtime"
	}
	// "transcription" was the original generic capability used by the
	// endpoint form. Keep it as an HTTP/chunked alias for existing gateways.
	if enabled, declared := endpoint.Capabilities["transcription"]; declared && enabled {
		return "chunked"
	}
	// An explicit false declaration is an opt-out, including for native
	// providers whose older records used implicit capability defaults.
	if enabled, declared := endpoint.Capabilities["transcription"]; declared && !enabled {
		return ""
	}
	if enabled, declared := endpoint.Capabilities["realtime-transcription"]; declared && !enabled {
		return ""
	}
	if endpoint.ProviderType == "openai" || endpoint.ProviderType == "gemini" {
		return "realtime"
	}
	return ""
}

func loadTranscriptionSession(ctx context.Context, db *sql.DB, sessionID uuid.UUID) (models.TranscriptionSession, error) {
	row := db.QueryRowContext(ctx, `SELECT s.id, s.user_id, s.organization_id, s.title, s.status, s.transcription_endpoint_id, s.diarization_endpoint_id, s.language, s.record_audio, s.started_at, s.ended_at, s.created_at, s.updated_at, s.archived_at, (SELECT COUNT(*) FROM transcription_sources src WHERE src.session_id = s.id), (SELECT COUNT(*) FROM transcription_segments seg WHERE seg.session_id = s.id AND seg.canonical = TRUE) FROM transcription_sessions s WHERE s.id = $1`, sessionID)
	return scanTranscriptionSession(row)
}

func scanTranscriptionSession(scanner interface{ Scan(dest ...any) error }) (models.TranscriptionSession, error) {
	var item models.TranscriptionSession
	var transcriptionEndpoint, diarizationEndpoint uuid.NullUUID
	if err := scanner.Scan(&item.ID, &item.UserID, &item.OrganizationID, &item.Title, &item.Status, &transcriptionEndpoint, &diarizationEndpoint, &item.Language, &item.RecordAudio, &item.StartedAt, &item.EndedAt, &item.CreatedAt, &item.UpdatedAt, &item.ArchivedAt, &item.SourceCount, &item.SegmentCount); err != nil {
		return item, err
	}
	if transcriptionEndpoint.Valid {
		item.TranscriptionEndpoint = &transcriptionEndpoint.UUID
	}
	if diarizationEndpoint.Valid {
		item.DiarizationEndpoint = &diarizationEndpoint.UUID
	}
	return item, nil
}

func loadTranscriptionSources(ctx context.Context, db *sql.DB, sessionID uuid.UUID) ([]models.TranscriptionSource, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, session_id, name, kind, device_label, status, clock_offset_ms, connected_at, last_seen_at FROM transcription_sources WHERE session_id = $1 ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.TranscriptionSource, 0)
	for rows.Next() {
		var item models.TranscriptionSource
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Name, &item.Kind, &item.DeviceLabel, &item.Status, &item.ClockOffsetMs, &item.ConnectedAt, &item.LastSeenAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func loadTranscriptionSpeakers(ctx context.Context, db *sql.DB, sessionID uuid.UUID) ([]models.TranscriptionSpeaker, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, session_id, label, display_name, color FROM transcription_speakers WHERE session_id = $1 AND merged_into IS NULL ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.TranscriptionSpeaker, 0)
	for rows.Next() {
		var item models.TranscriptionSpeaker
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Label, &item.DisplayName, &item.Color); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func loadTranscriptionSegments(ctx context.Context, db *sql.DB, sessionID uuid.UUID) ([]models.TranscriptionSegment, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, session_id, source_id, speaker_id, text, start_offset_ms, end_offset_ms, confidence, signal_quality, canonical, heard_by_source_ids, created_at, updated_at FROM transcription_segments WHERE session_id = $1 AND canonical = TRUE ORDER BY start_offset_ms, created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.TranscriptionSegment, 0)
	for rows.Next() {
		var item models.TranscriptionSegment
		var sourceID, speakerID uuid.NullUUID
		var heard []byte
		if err := rows.Scan(&item.ID, &item.SessionID, &sourceID, &speakerID, &item.Text, &item.StartOffsetMs, &item.EndOffsetMs, &item.Confidence, &item.SignalQuality, &item.Canonical, &heard, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if sourceID.Valid {
			item.SourceID = &sourceID.UUID
		}
		if speakerID.Valid {
			item.SpeakerID = &speakerID.UUID
		}
		if isTranscriptionProtocolPayload(item.Text) {
			continue
		}
		item.HeardBySourceIDs, err = decodeTranscriptionSourceIDs(heard)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func loadTranscriptionRecordings(ctx context.Context, db *sql.DB, sessionID uuid.UUID) ([]models.TranscriptionRecording, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, session_id, source_id, mime_type, bytes, expires_at, completed_at FROM transcription_recordings WHERE session_id = $1 ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.TranscriptionRecording, 0)
	for rows.Next() {
		var item models.TranscriptionRecording
		if err := rows.Scan(&item.ID, &item.SessionID, &item.SourceID, &item.MimeType, &item.Bytes, &item.ExpiresAt, &item.CompletedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func mustTranscriptionSession(ctx context.Context, app *App, id uuid.UUID) models.TranscriptionSession {
	item, _ := loadTranscriptionSession(ctx, app.DB, id)
	return item
}

func newJoinCode() (string, string, error) {
	value := make([]byte, 5)
	if _, err := rand.Read(value); err != nil {
		return "", "", err
	}
	code := strings.TrimRight(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(value), "=")
	return code, hashToken(code), nil
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func nullableUUIDValue(value uuid.NullUUID) any {
	if !value.Valid {
		return nil
	}
	return value.UUID
}

func speakerColor(label string) string {
	colors := []string{"violet", "blue", "emerald", "amber", "rose", "cyan"}
	var sum uint32
	for _, char := range label {
		sum = sum*33 + uint32(char)
	}
	return colors[int(sum)%len(colors)]
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func (m *TranscriptionManager) clearPCMForSession(sessionID uuid.UUID) {
	rows, err := m.DB.Query(`SELECT id FROM transcription_sources WHERE session_id = $1`, sessionID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID uuid.UUID
		if rows.Scan(&sourceID) == nil {
			m.clearPCM(sourceID)
		}
	}
}

type transcriptionAudioFrame struct {
	PCM              []byte
	SampleRate       int
	CaptureTimestamp int64
	Sequence         uint32
}

func parseAudioFrame(payload []byte) transcriptionAudioFrame {
	frame := transcriptionAudioFrame{PCM: payload, SampleRate: 16000}
	if len(payload) < 13 || payload[0] != 1 {
		return frame
	}
	frame.CaptureTimestamp = int64(binary.LittleEndian.Uint64(payload[1:9]))
	frame.Sequence = binary.LittleEndian.Uint32(payload[9:13])
	if len(payload) < 17 {
		frame.PCM = payload[13:]
		return frame
	}
	rate := binary.LittleEndian.Uint32(payload[13:17])
	if rate >= 8000 && rate <= 96000 {
		frame.SampleRate = int(rate)
	}
	frame.PCM = payload[17:]
	return frame
}
