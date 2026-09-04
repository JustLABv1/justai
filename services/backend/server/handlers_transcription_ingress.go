package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/auth"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

const (
	transcriptionBotProtocol = "justai-transcription-v1"
	transcriptionBotWSSPath  = "/api/v1/ws/transcription"
)

type transcriptionStreamSourceRequest struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type transcriptionBotSourceRequest struct {
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	MeetingURL string `json:"meetingUrl"`
}

func (a *App) createTranscriptionStreamSource(c *gin.Context) {
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
	if err := a.ensureTranscriptionIngressSession(c, sessionID); err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "no longer live") {
			status = http.StatusConflict
		}
		writeError(c, status, err)
		return
	}
	var request transcriptionStreamSourceRequest
	if !decodeJSON(c, &request) {
		return
	}
	streamURL := strings.TrimSpace(request.URL)
	if len(streamURL) == 0 || len(streamURL) > 16*1024 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a live stream URL between 1 and 16 KB is required"))
		return
	}
	if err := provider.ValidateMediaSourceURL(streamURL, a.Config.AllowPrivate); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	parsedURL, _ := url.Parse(streamURL)
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = "Live stream"
	}
	if len(name) > 200 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("source name must be 200 characters or fewer"))
		return
	}
	encryptedURL, err := a.Secrets.Encrypt(streamURL)
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
	source, err := createIngressTranscriptionSource(c, transaction, sessionID, name, "stream", "")
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "already in this room") {
			status = http.StatusConflict
		}
		writeError(c, status, err)
		return
	}
	stream := models.TranscriptionStreamSource{
		SourceID: source.ID,
		Protocol: strings.ToLower(parsedURL.Scheme),
		Status:   "pending",
	}
	source.Protocol = stream.Protocol
	source.TransportStatus = stream.Status
	if _, err := transaction.ExecContext(c, `INSERT INTO transcription_stream_sources (source_id, url_ciphertext, protocol) VALUES ($1, $2, $3)`, source.ID, encryptedURL, stream.Protocol); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.activateTranscriptionIngressSession(sessionID)
	a.Live.startStreamSource(sessionID, source.ID)
	c.JSON(http.StatusCreated, gin.H{"source": source, "stream": stream})
}

func (a *App) stopTranscriptionStreamSource(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sourceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT source.session_id FROM transcription_sources source JOIN transcription_stream_sources stream ON stream.source_id = source.id JOIN transcription_sessions session ON session.id = source.session_id WHERE source.id = $1 AND session.user_id = $2 AND session.organization_id = $3`, sourceID, principal.UserID, organizationID).Scan(&sessionID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("live stream source not found"))
		return
	}
	a.Live.stopStreamSource(sourceID)
	a.Live.closeSource(sessionID, sourceID)
	_, _ = a.DB.ExecContext(c, `UPDATE transcription_stream_sources SET status = 'stopped', last_error = '', updated_at = now() WHERE source_id = $1`, sourceID)
	a.Live.markSource(sessionID, sourceID, "stopped")
	a.Live.broadcast(sessionID, "transcription.stream", ginData{"sourceId": sourceID, "status": "stopped"})
	c.Status(http.StatusNoContent)
}

func (a *App) createTranscriptionBotSource(c *gin.Context) {
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
	if err := a.ensureTranscriptionIngressSession(c, sessionID); err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "no longer live") {
			status = http.StatusConflict
		}
		writeError(c, status, err)
		return
	}
	var request transcriptionBotSourceRequest
	if !decodeJSON(c, &request) {
		return
	}
	platform := normalizeBotPlatform(request.Platform)
	if platform == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("platform must be generic, zoom, google-meet, or microsoft-teams"))
		return
	}
	meetingURL := strings.TrimSpace(request.MeetingURL)
	if meetingURL != "" {
		if len(meetingURL) > 16*1024 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("meeting URL must be 16 KB or fewer"))
			return
		}
		if err := provider.ValidateRequestURL(meetingURL, false); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("meeting URL is invalid: %w", err))
			return
		}
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = botPlatformName(platform) + " bot"
	}
	if len(name) > 200 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("source name must be 200 characters or fewer"))
		return
	}
	botToken, tokenHash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var encryptedMeetingURL []byte
	if meetingURL != "" {
		encryptedMeetingURL, err = a.Secrets.Encrypt(meetingURL)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	source, err := createIngressTranscriptionSource(c, transaction, sessionID, name, "meeting-bot", "")
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "already in this room") {
			status = http.StatusConflict
		}
		writeError(c, status, err)
		return
	}
	bot := models.TranscriptionBotSource{SourceID: source.ID, Platform: platform, Status: "pending"}
	source.Platform = bot.Platform
	source.TransportStatus = bot.Status
	if _, err := transaction.ExecContext(c, `INSERT INTO transcription_bot_sources (source_id, platform, meeting_url_ciphertext, ingest_token_hash) VALUES ($1, $2, $3, $4)`, source.ID, platform, encryptedMeetingURL, tokenHash); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.activateTranscriptionIngressSession(sessionID)
	c.JSON(http.StatusCreated, gin.H{
		"source":        source,
		"bot":           bot,
		"token":         botToken,
		"meetingUrl":    meetingURL,
		"protocol":      transcriptionBotProtocol,
		"ticketPath":    "/api/v1/transcription/bot-sources/" + source.ID.String() + "/tickets",
		"websocketPath": transcriptionBotWSSPath,
		"warning":       "Store this ingest token now. It will not be shown again.",
	})
}

func (a *App) rotateTranscriptionBotSourceToken(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sourceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT source.session_id FROM transcription_sources source JOIN transcription_bot_sources bot ON bot.source_id = source.id JOIN transcription_sessions session ON session.id = source.session_id WHERE source.id = $1 AND session.user_id = $2 AND session.organization_id = $3`, sourceID, principal.UserID, organizationID).Scan(&sessionID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("meeting bot source not found"))
		return
	}
	token, tokenHash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE transcription_bot_sources SET ingest_token_hash = $2, updated_at = now() WHERE source_id = $1`, sourceID, tokenHash); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"sourceId":      sourceID,
		"token":         token,
		"protocol":      transcriptionBotProtocol,
		"ticketPath":    "/api/v1/transcription/bot-sources/" + sourceID.String() + "/tickets",
		"websocketPath": transcriptionBotWSSPath,
		"warning":       "Store this ingest token now. It will not be shown again.",
	})
}

func (a *App) stopTranscriptionBotSource(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sourceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	var sessionID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT source.session_id FROM transcription_sources source JOIN transcription_bot_sources bot ON bot.source_id = source.id JOIN transcription_sessions session ON session.id = source.session_id WHERE source.id = $1 AND session.user_id = $2 AND session.organization_id = $3`, sourceID, principal.UserID, organizationID).Scan(&sessionID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("meeting bot source not found"))
		return
	}
	a.Live.stopStreamSource(sourceID)
	a.Live.closeSource(sessionID, sourceID)
	_, _ = a.DB.ExecContext(c, `UPDATE transcription_bot_sources SET status = 'stopped', updated_at = now() WHERE source_id = $1`, sourceID)
	a.Live.markSource(sessionID, sourceID, "stopped")
	a.Live.broadcast(sessionID, "transcription.bot", ginData{"sourceId": sourceID, "status": "stopped"})
	c.Status(http.StatusNoContent)
}

// createTranscriptionBotWSTicket is intentionally bearer-authenticated rather
// than cookie-authenticated. Platform adapters and desktop meeting bridges can
// exchange their durable source token for a short-lived, one-use WebSocket
// ticket without receiving a user's JustAI session cookie.
func (a *App) createTranscriptionBotWSTicket(c *gin.Context) {
	token := bearerToken(c.GetHeader("Authorization"))
	if token == "" {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("bot ingest token is required"))
		return
	}
	sourceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var sessionID, userID, organizationID uuid.UUID
	var sessionStatus string
	err = transaction.QueryRowContext(c, `SELECT source.session_id, session.user_id, session.organization_id, session.status FROM transcription_sources source JOIN transcription_bot_sources bot ON bot.source_id = source.id JOIN transcription_sessions session ON session.id = source.session_id WHERE source.id = $1 AND bot.ingest_token_hash = $2 AND bot.status <> 'stopped' AND session.status IN ('waiting', 'live', 'paused') FOR UPDATE`, sourceID, hashToken(token)).Scan(&sessionID, &userID, &organizationID, &sessionStatus)
	if err != nil {
		writeError(c, http.StatusUnauthorized, fmt.Errorf("invalid or revoked bot ingest token"))
		return
	}
	ticket, ticketHash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	expiresAt := time.Now().Add(2 * time.Minute)
	if _, err := transaction.ExecContext(c, `INSERT INTO ws_tickets (token_hash, user_id, organization_id, kind, session_id, source_id, expires_at) VALUES ($1, $2, $3, 'transcription-capture', $4, $5, $6)`, ticketHash, userID, organizationID, sessionID, sourceID, expiresAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `UPDATE transcription_bot_sources SET status = 'pending', updated_at = now() WHERE source_id = $1`, sourceID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if sessionStatus == "waiting" {
		if _, err := transaction.ExecContext(c, `UPDATE transcription_sessions SET status = 'live', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`, sessionID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if sessionStatus == "waiting" {
		a.Live.broadcast(sessionID, "transcription.session", ginData{"status": "live"})
	}
	c.JSON(http.StatusCreated, gin.H{"ticket": ticket, "expiresAt": expiresAt, "kind": "transcription-capture", "protocol": transcriptionBotProtocol, "websocketPath": transcriptionBotWSSPath})
}

func createIngressTranscriptionSource(ctx context.Context, transaction *sql.Tx, sessionID uuid.UUID, name, kind, deviceLabel string) (models.TranscriptionSource, error) {
	if err := lockTranscriptionSourceName(ctx, transaction, sessionID, name); err != nil {
		return models.TranscriptionSource{}, err
	}
	taken, err := transcriptionSourceNameTaken(ctx, transaction, sessionID, name, uuid.Nil)
	if err != nil {
		return models.TranscriptionSource{}, err
	}
	if taken {
		return models.TranscriptionSource{}, fmt.Errorf("a source with that name is already in this room")
	}
	var source models.TranscriptionSource
	err = transaction.QueryRowContext(ctx, `INSERT INTO transcription_sources (session_id, name, kind, device_label) VALUES ($1, $2, $3, $4) RETURNING id, session_id, name, kind, device_label, status, clock_offset_ms, connected_at, last_seen_at`, sessionID, name, kind, deviceLabel).Scan(&source.ID, &source.SessionID, &source.Name, &source.Kind, &source.DeviceLabel, &source.Status, &source.ClockOffsetMs, &source.ConnectedAt, &source.LastSeenAt)
	return source, err
}

func (a *App) activateTranscriptionIngressSession(sessionID uuid.UUID) {
	result, err := a.DB.Exec(`UPDATE transcription_sessions SET status = 'live', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND status = 'waiting'`, sessionID)
	if err != nil {
		return
	}
	if count, err := result.RowsAffected(); err == nil && count > 0 {
		a.Live.broadcast(sessionID, "transcription.session", ginData{"status": "live"})
	}
}

func (a *App) ensureTranscriptionIngressSession(ctx context.Context, sessionID uuid.UUID) error {
	var status string
	if err := a.DB.QueryRowContext(ctx, `SELECT status FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&status); err != nil {
		return err
	}
	switch status {
	case "waiting", "live", "paused":
		return nil
	default:
		return fmt.Errorf("transcription session is no longer live")
	}
}

func normalizeBotPlatform(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "generic", "custom":
		return "generic"
	case "zoom":
		return "zoom"
	case "google-meet", "google meet", "meet":
		return "google-meet"
	case "microsoft-teams", "microsoft teams", "teams":
		return "microsoft-teams"
	default:
		return ""
	}
}

func botPlatformName(platform string) string {
	switch platform {
	case "zoom":
		return "Zoom"
	case "google-meet":
		return "Google Meet"
	case "microsoft-teams":
		return "Microsoft Teams"
	default:
		return "Meeting"
	}
}

func bearerToken(header string) string {
	value := strings.TrimSpace(header)
	if len(value) < len("Bearer ") || !strings.EqualFold(value[:len("Bearer ")], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(value[len("Bearer "):])
}
