package server

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/lib/pq"
	"log/slog"
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
	transcriptionBotProtocol   = "justai-transcription-sse-v1"
	transcriptionBotStreamPath = "/api/v1/streams/transcription"
)

type transcriptionStreamSourceRequest struct {
	Name             string     `json:"name"`
	URL              string     `json:"url"`
	ScheduledStartAt *time.Time `json:"scheduledStartAt"`
	ScheduledEndAt   *time.Time `json:"scheduledEndAt"`
	// Watch window: StartMode "when_live" listens from ScheduledStartAt until speech is
	// heard (and until ScheduledEndAt); SilenceStopSeconds ends a capture after that long without speech.
	StartMode          string `json:"startMode"`
	SilenceStopSeconds int    `json:"silenceStopSeconds"`
	PlanFollow         bool   `json:"planFollow"`
	PlanKey            string `json:"planKey"`
	// TopicsSessionNo loads the agenda items of that Bundestag sitting as topics, so they
	// can be read as soon as each one is finished.
	TopicsSessionNo int `json:"topicsSessionNo"`
	// CaptureScope "topics" records only around the agenda items in TopicKeys and
	// pauses in between; "all" (default) records the whole sitting.
	CaptureScope string   `json:"captureScope"`
	TopicKeys    []string `json:"topicKeys"`
}

const defaultLiveStreamReconnectGraceSeconds = 15 * 60

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
	if _, err := resolveLiveStream(c, streamURL, a.Config.AllowPrivate); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	parsedURL, _ := url.Parse(streamURL)
	now := time.Now().UTC()
	startMode, modeErr := normalizeStartMode(request.StartMode)
	if modeErr != nil {
		writeError(c, http.StatusBadRequest, modeErr)
		return
	}
	captureScope := "all"
	var sittingItems, selectedItems []planItem
	if request.CaptureScope == "topics" {
		// The capture window is derived from the selected items, not from the form.
		if request.TopicsSessionNo <= 0 || !isBundestagPlanURL(streamURL) || len(request.TopicKeys) == 0 || len(request.TopicKeys) > 50 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("choose at least one topic of a Bundestag sitting to record only selected topics"))
			return
		}
		items, agendaErr := a.cachedAblaufplan(c)
		if agendaErr != nil {
			writeError(c, http.StatusBadGateway, fmt.Errorf("the agenda of the sitting could not be loaded: %w", agendaErr))
			return
		}
		sittingItems = plenaryItemsForSession(items, request.TopicsSessionNo)
		wanted := map[string]bool{}
		for _, key := range request.TopicKeys {
			wanted[key] = true
		}
		for _, it := range sittingItems {
			if wanted[it.Key] {
				selectedItems = append(selectedItems, it)
			}
		}
		if len(selectedItems) != len(wanted) {
			writeError(c, http.StatusBadRequest, fmt.Errorf("a selected topic is no longer on the agenda of this sitting"))
			return
		}
		windowStart, windowEnd := topicCapturePlan(selectedItems, now)
		request.ScheduledStartAt, request.ScheduledEndAt = &windowStart, &windowEnd
		startMode, request.PlanFollow, request.PlanKey = "at_time", false, ""
		captureScope = "topics"
	} else if request.CaptureScope != "" && request.CaptureScope != "all" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("capture scope must be all or topics"))
		return
	}
	requestedStart := request.ScheduledStartAt
	if startMode == "when_live" && requestedStart == nil {
		requestedStart = &now // watch from now
	}
	scheduledStartAt, scheduledEndAt, scheduleErr := validateTranscriptionStreamSchedule(requestedStart, request.ScheduledEndAt, now)
	if scheduleErr != nil {
		writeError(c, http.StatusBadRequest, scheduleErr)
		return
	}
	watch, watchErr := a.prepareStreamWatch(c, streamURL, startMode, request.SilenceStopSeconds, request.PlanFollow, request.PlanKey, scheduledEndAt, scheduledStartAt)
	if watchErr != nil {
		writeError(c, http.StatusBadRequest, watchErr)
		return
	}
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
		SourceID:              source.ID,
		Protocol:              strings.ToLower(parsedURL.Scheme),
		Status:                "pending",
		ScheduledStartAt:      scheduledStartAt,
		ScheduledEndAt:        scheduledEndAt,
		ReconnectGraceSeconds: defaultLiveStreamReconnectGraceSeconds,
	}
	if scheduledStartAt != nil {
		stream.Status = "scheduled"
	}
	source.Protocol = stream.Protocol
	source.TransportStatus = stream.Status
	source.ScheduledStartAt = scheduledStartAt
	source.ScheduledEndAt = scheduledEndAt
	source.StartMode, source.SilenceStopSeconds, source.PlanFollow, source.PlanKey = watch.StartMode, watch.SilenceStopSeconds, watch.PlanFollow, watch.PlanKey
	if _, err := transaction.ExecContext(c, `INSERT INTO transcription_stream_sources (source_id, url_ciphertext, protocol, status, scheduled_start_at, scheduled_end_at, reconnect_grace_seconds, start_mode, silence_stop_seconds, plan_follow, plan_key, plan_fallback_at, capture_scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, source.ID, encryptedURL, stream.Protocol, stream.Status, scheduledStartAt, scheduledEndAt, stream.ReconnectGraceSeconds, watch.StartMode, watch.SilenceStopSeconds, watch.PlanFollow, watch.PlanKey, watch.FallbackAt, captureScope); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if scheduledStartAt == nil {
		a.activateTranscriptionIngressSession(sessionID)
		a.Live.startStreamSource(sessionID, source.ID)
	}
	if captureScope == "topics" {
		// The selected items are the user's topics: recorded, and announced when finished.
		if err := syncTopics(c, a.DB, sessionID, source.ID, sittingItems); err == nil {
			_, _ = a.DB.ExecContext(c, `UPDATE transcription_topics SET starred = (topic_key = ANY($2)), updated_at = now() WHERE session_id = $1`, sessionID, pq.Array(request.TopicKeys))
		}
	} else if request.TopicsSessionNo > 0 && isBundestagPlanURL(streamURL) {
		// Best effort: the capture works without topics, and they can be loaded later.
		if _, topicsErr := a.loadSittingTopics(c, sessionID, source.ID, request.TopicsSessionNo); topicsErr != nil {
			slog.Warn("agenda items could not be loaded", "sessionId", sessionID, "error", topicsErr)
			a.Live.setStreamAlert(sessionID, source.ID, "topics_unavailable", "The agenda items of the sitting could not be loaded. You can load them again from the topics list.")
		}
	}
	c.JSON(http.StatusCreated, gin.H{"source": source, "stream": stream})
}

func validateTranscriptionStreamSchedule(startAt, endAt *time.Time, now time.Time) (*time.Time, *time.Time, error) {
	var start, end *time.Time
	if startAt != nil {
		value := startAt.UTC()
		if value.Before(now.UTC().Add(-time.Minute)) {
			return nil, nil, fmt.Errorf("scheduled start must be in the future")
		}
		start = &value
	}
	if endAt != nil {
		if start == nil {
			return nil, nil, fmt.Errorf("scheduled end requires a scheduled start")
		}
		value := endAt.UTC()
		if !value.After(*start) {
			return nil, nil, fmt.Errorf("scheduled end must be after scheduled start")
		}
		end = &value
	}
	return start, end, nil
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
		"source":     source,
		"bot":        bot,
		"token":      botToken,
		"meetingUrl": meetingURL,
		"protocol":   transcriptionBotProtocol,
		"ticketPath": "/api/v1/transcription/bot-sources/" + source.ID.String() + "/tickets",
		"streamPath": transcriptionBotStreamPath,
		"warning":    "Store this ingest token now. It will not be shown again.",
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
		"sourceId":   sourceID,
		"token":      token,
		"protocol":   transcriptionBotProtocol,
		"ticketPath": "/api/v1/transcription/bot-sources/" + sourceID.String() + "/tickets",
		"streamPath": transcriptionBotStreamPath,
		"warning":    "Store this ingest token now. It will not be shown again.",
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

// createTranscriptionBotStreamTicket is intentionally bearer-authenticated rather
// than cookie-authenticated. Platform adapters and desktop meeting bridges can
// exchange their durable source token for a short-lived, one-use stream
// ticket without receiving a user's JustAI session cookie.
func (a *App) createTranscriptionBotStreamTicket(c *gin.Context) {
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
	if _, err := transaction.ExecContext(c, `INSERT INTO stream_tickets (token_hash, user_id, organization_id, kind, session_id, source_id, expires_at) VALUES ($1, $2, $3, 'transcription-capture', $4, $5, $6)`, ticketHash, userID, organizationID, sessionID, sourceID, expiresAt); err != nil {
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
	c.JSON(http.StatusCreated, gin.H{"ticket": ticket, "expiresAt": expiresAt, "kind": "transcription-capture", "protocol": transcriptionBotProtocol, "streamPath": transcriptionBotStreamPath})
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
