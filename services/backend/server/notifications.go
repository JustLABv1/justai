package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/middleware"
)

// Notifications tell the owner of a live transcript and the people it is shared with
// when a topic is finished and when the whole transcript is done. Each one is listed
// in the app and, where set up, sent by e-mail and browser push. Every user can turn
// them off per transcript.

// notificationInterval also bounds how late a reminder can arrive.
const notificationInterval = 15 * time.Second

// notificationTopicSettle lets a finished topic get its own transcript and, when one is
// written, its summary before it is announced.
const notificationTopicSettle = 90 * time.Second

type notificationItem struct {
	ID        uuid.UUID  `json:"id"`
	Kind      string     `json:"kind"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Link      string     `json:"link"`
	SessionID *uuid.UUID `json:"sessionId,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	ReadAt    *time.Time `json:"readAt,omitempty"`
}

// notificationEvent is one thing to announce, before it is put into each recipient's
// language.
type notificationEvent struct {
	Kind           string
	OrganizationID uuid.UUID
	// SessionID is the transcript the event is about; its mutes apply, and its readers
	// hear about results. Nil for events that are not about a transcript.
	SessionID uuid.UUID
	// OwnerOnly: problems go to the owner, who can act on them, not to every reader.
	OwnerOnly bool
	// UserID addresses one person directly (a reminder); no session rules apply.
	UserID       uuid.UUID
	DedupeKey    string
	Link         string // path in the app
	Topic        string
	SessionTitle string
	HasSummary   bool
	TopicCount   int
	Minutes      int
	Message      string // a reminder's text
}

func notificationTexts(locale string, event notificationEvent) (title, body, linkLabel string) {
	german := strings.HasPrefix(strings.ToLower(locale), "de")
	switch event.Kind {
	case "topic_done":
		if german {
			title = "„" + event.Topic + "“ ist fertig"
			body = event.SessionTitle + ": Das Transkript dieses Themas ist bereit."
			if event.HasSummary {
				body = event.SessionTitle + ": Transkript und Zusammenfassung dieses Themas sind bereit."
			}
			return title, body, "Thema öffnen"
		}
		title = "“" + event.Topic + "” is finished"
		body = event.SessionTitle + ": the transcript of this topic is ready."
		if event.HasSummary {
			body = event.SessionTitle + ": the transcript and summary of this topic are ready."
		}
		return title, body, "Open topic"
	case "reminder":
		if german {
			return "Erinnerung", event.Message, "Chat öffnen"
		}
		return "Reminder", event.Message, "Open chat"
	case "capture_aborted", "stream_unreachable", "watch_missed", "topic_missed", "plan_missing", "stream_outage", "stream_recovered", "transcription_failed", "processing_failed":
		return problemTexts(german, event)
	default:
		if german {
			title = "„" + event.SessionTitle + "“ ist abgeschlossen"
			body = "Die Live-Transkription ist beendet und fertig bearbeitet."
			if event.TopicCount == 1 {
				body += " 1 Thema wurde aufgenommen."
			} else if event.TopicCount > 1 {
				body += fmt.Sprintf(" %d Themen wurden aufgenommen.", event.TopicCount)
			}
			return title, body, "Transkript öffnen"
		}
		title = "“" + event.SessionTitle + "” is complete"
		body = "The live transcription has ended and is fully processed."
		if event.TopicCount == 1 {
			body += " 1 topic was recorded."
		} else if event.TopicCount > 1 {
			body += fmt.Sprintf(" %d topics were recorded.", event.TopicCount)
		}
		return title, body, "Open transcript"
	}
}

// problemTexts describe what went wrong during a transcription and what happens next.
func problemTexts(german bool, event notificationEvent) (title, body, linkLabel string) {
	name := event.SessionTitle
	type text struct{ title, body string }
	var de, en text
	switch event.Kind {
	case "capture_aborted":
		de = text{"Aufnahme abgebrochen: „" + name + "“", "Der Stream kam nicht zurück, die Aufnahme wurde beendet. Was bis dahin transkribiert wurde, bleibt erhalten."}
		en = text{"Capture stopped: “" + name + "”", "The stream did not come back, so the capture ended. What was transcribed until then is kept."}
	case "stream_unreachable":
		de = text{"„" + name + "“: Stream nicht erreichbar", "Der Livestream ist seit einiger Zeit nicht erreichbar. JustAI versucht es weiter, bis das Zeitfenster endet."}
		en = text{"“" + name + "”: stream unreachable", "The livestream has been unreachable for a while. JustAI keeps trying until the watch window ends."}
	case "watch_missed":
		de = text{"„" + name + "“: keine Übertragung gefunden", "Im geplanten Zeitfenster kam keine Übertragung zustande, es wurde nichts aufgenommen."}
		en = text{"“" + name + "”: no broadcast found", "No broadcast started within the planned window, so nothing was recorded."}
	case "topic_missed":
		de = text{"„" + name + "“: ausgewähltes Thema verpasst", "Ein ausgewähltes Thema wurde aufgerufen, bevor die Aufnahme lief. Die übrigen Themen werden weiter aufgenommen."}
		en = text{"“" + name + "”: selected topic missed", "A selected topic was called up before the capture was running. The remaining topics are still recorded."}
	case "plan_missing":
		de = text{"„" + name + "“ steht nicht mehr im Plan", "Die Sitzung ist nicht mehr im Bundestagsplan. Sie wurde vielleicht abgesagt oder umbenannt; prüfe den Zeitplan."}
		en = text{"“" + name + "” is no longer in the plan", "The sitting is no longer in the Bundestag plan. It may have been cancelled or renamed; check the schedule."}
	case "stream_outage":
		de = text{"„" + name + "“: Stream unterbrochen", fmt.Sprintf("Seit %d Minuten kommt nichts an. JustAI verbindet sich automatisch neu.", event.Minutes)}
		en = text{"“" + name + "”: stream interrupted", fmt.Sprintf("Nothing has arrived for %d minutes. JustAI reconnects automatically.", event.Minutes)}
	case "stream_recovered":
		de = text{"„" + name + "“: Stream wieder da", fmt.Sprintf("Die Aufnahme läuft weiter. Die Unterbrechung dauerte etwa %d Minuten.", event.Minutes)}
		en = text{"“" + name + "”: stream is back", fmt.Sprintf("The capture continues. The interruption lasted about %d minutes.", event.Minutes)}
	case "transcription_failed":
		de = text{"Transkription fehlgeschlagen: „" + name + "“", "Die Verarbeitung ist fehlgeschlagen. Öffne die Transkription für Details."}
		en = text{"Transcription failed: “" + name + "”", "Processing failed. Open the transcription for details."}
	default: // processing_failed
		de = text{"Nachbearbeitung fehlgeschlagen: „" + name + "“", "Sprechererkennung oder Glättung ist fehlgeschlagen. Das Transkript bleibt erhalten; du kannst den Schritt wiederholen oder überspringen."}
		en = text{"Post-processing failed: “" + name + "”", "Speaker detection or polishing failed. The transcript is kept; you can retry or skip the step."}
	}
	if german {
		return de.title, de.body, "Transkription öffnen"
	}
	return en.title, en.body, "Open transcription"
}

func (m *TranscriptionManager) notificationLoop(ctx context.Context) {
	ticker := time.NewTicker(notificationInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if m.app == nil {
			continue
		}
		for _, event := range m.app.claimNotificationEvents(ctx) {
			m.app.notify(ctx, event)
		}
		for _, event := range m.app.claimProblemEvents(ctx) {
			m.app.notify(ctx, event)
		}
		for _, event := range m.app.claimDueReminders(ctx) {
			m.app.notify(ctx, event)
		}
	}
}

// claimNotificationEvents marks finished topics and transcripts as announced and
// returns them. Claiming first keeps several backend replicas from sending twice.
func (a *App) claimNotificationEvents(ctx context.Context) []notificationEvent {
	var events []notificationEvent
	topics, err := a.DB.QueryContext(ctx, `UPDATE transcription_topics t SET notified_at = now()
		FROM transcription_sessions s
		WHERE s.id = t.session_id AND t.status = 'done' AND t.notified_at IS NULL AND t.detected_by <> 'missed'
		AND t.transcript_session_id IS NOT NULL AND t.summary_status <> 'processing'
		AND t.updated_at < now() - $1 * interval '1 second' AND t.updated_at > now() - interval '2 days'
		RETURNING t.id, t.session_id, s.organization_id, s.title, t.title, t.transcript_session_id, t.summary_status = 'completed'`, notificationTopicSettle.Seconds())
	if err == nil {
		for topics.Next() {
			var id, transcript uuid.UUID
			event := notificationEvent{Kind: "topic_done"}
			if topics.Scan(&id, &event.SessionID, &event.OrganizationID, &event.SessionTitle, &event.Topic, &transcript, &event.HasSummary) == nil {
				event.DedupeKey = "topic_done:" + id.String()
				event.Link = "/live-transcription/" + transcript.String()
				events = append(events, event)
			}
		}
		topics.Close()
	}
	// A transcript is done once capture ended, nothing is running and post-processing
	// finished. Topic transcripts are announced as topics; recordings made by hand
	// without readers are not announced, since their owner was there.
	sessions, err := a.DB.QueryContext(ctx, `UPDATE transcription_sessions s SET done_notified_at = now()
		WHERE s.status = 'completed' AND s.done_notified_at IS NULL
		AND s.ended_at < now() - interval '1 minute' AND s.ended_at > now() - interval '2 days'
		AND NOT EXISTS (SELECT 1 FROM transcription_video_uploads v WHERE v.session_id = s.id)
		AND NOT EXISTS (SELECT 1 FROM transcription_topics c WHERE c.transcript_session_id = s.id)
		AND NOT EXISTS (SELECT 1 FROM transcription_live_processing p WHERE p.session_id = s.id AND p.status IN ('queued', 'processing'))
		AND NOT EXISTS (SELECT 1 FROM transcription_topics t WHERE t.session_id = s.id AND t.status = 'active')
		AND (EXISTS (SELECT 1 FROM transcription_readers r WHERE r.session_id = s.id)
			OR EXISTS (SELECT 1 FROM transcription_sources src WHERE src.session_id = s.id AND src.kind = 'stream'))
		RETURNING s.id, s.organization_id, s.title,
			(SELECT COUNT(*) FROM transcription_topics t WHERE t.session_id = s.id AND t.status = 'done' AND t.detected_by <> 'missed' AND t.transcript_session_id IS NOT NULL)`)
	if err == nil {
		for sessions.Next() {
			event := notificationEvent{Kind: "transcript_done"}
			if sessions.Scan(&event.SessionID, &event.OrganizationID, &event.SessionTitle, &event.TopicCount) == nil {
				event.DedupeKey = "transcript_done:" + event.SessionID.String()
				event.Link = "/live-transcription/" + event.SessionID.String()
				events = append(events, event)
			}
		}
		sessions.Close()
	}
	return events
}

type notificationRecipient struct {
	UserID       uuid.UUID
	Email        string
	EmailEnabled bool
	Locale       string
}

// notificationRecipients: a directly addressed user; else the owner of the session
// and, unless OwnerOnly, its readers, leaving out whoever muted the session.
func (a *App) notificationRecipients(ctx context.Context, event notificationEvent) ([]notificationRecipient, error) {
	query := `SELECT u.id, u.email, COALESCE(ns.email_enabled, TRUE), COALESCE(ns.locale, 'en')
		FROM users u LEFT JOIN notification_settings ns ON ns.user_id = u.id
		WHERE u.status = 'active'
		AND (u.id = (SELECT user_id FROM transcription_sessions WHERE id = $1) OR (NOT $2 AND u.id IN (SELECT user_id FROM transcription_readers WHERE session_id = $1)))
		AND NOT EXISTS (SELECT 1 FROM transcription_notification_mutes mu WHERE mu.session_id = $1 AND mu.user_id = u.id)`
	args := []any{event.SessionID, event.OwnerOnly}
	if event.UserID != uuid.Nil {
		query = `SELECT u.id, u.email, COALESCE(ns.email_enabled, TRUE), COALESCE(ns.locale, 'en')
			FROM users u LEFT JOIN notification_settings ns ON ns.user_id = u.id WHERE u.status = 'active' AND u.id = $1`
		args = []any{event.UserID}
	}
	rows, err := a.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []notificationRecipient
	for rows.Next() {
		var r notificationRecipient
		if err := rows.Scan(&r.UserID, &r.Email, &r.EmailEnabled, &r.Locale); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// notify lists the event for each recipient and sends it by e-mail and push.
func (a *App) notify(ctx context.Context, event notificationEvent) {
	recipients, err := a.notificationRecipients(ctx, event)
	if err != nil {
		slog.Warn("notification recipients failed", "sessionId", event.SessionID, "error", err)
		return
	}
	session := uuid.NullUUID{UUID: event.SessionID, Valid: event.SessionID != uuid.Nil}
	for _, recipient := range recipients {
		title, body, linkLabel := notificationTexts(recipient.Locale, event)
		var id uuid.UUID
		err := a.DB.QueryRowContext(ctx, `INSERT INTO notifications (user_id, organization_id, kind, title, body, link, session_id, dedupe_key)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
			recipient.UserID, event.OrganizationID, event.Kind, title, body, event.Link, session, event.DedupeKey).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			continue // announced before
		}
		if err != nil {
			slog.Warn("storing a notification failed", "userId", recipient.UserID, "error", err)
			continue
		}
		liveStreamEvents.inc("notification_" + event.Kind)
		a.deliverNotification(ctx, recipient, id, event.Kind, title, body, linkLabel, event.Link)
	}
}

// publicLink turns an app path into the address people open.
func (a *App) publicLink(ctx context.Context, path string) string {
	return a.effectivePublicURL(ctx) + path
}

// pushSubject is the contact a push service may use (RFC 8292): the sender address,
// else the public address when it is https.
func (a *App) pushSubject(ctx context.Context) string {
	if from := a.effectiveSMTP(ctx).From; from != "" {
		if address, err := mail.ParseAddress(from); err == nil {
			return "mailto:" + address.Address
		}
	}
	if link := a.publicLink(ctx, ""); strings.HasPrefix(link, "https://") {
		return link
	}
	return "mailto:notifications@justai.invalid"
}

func (a *App) deliverNotification(ctx context.Context, recipient notificationRecipient, id uuid.UUID, kind, title, body, linkLabel, path string) {
	link := a.publicLink(ctx, path)
	if smtp := a.effectiveSMTP(ctx); smtp.Host != "" && recipient.EmailEnabled && recipient.Email != "" {
		if err := sendMail(smtp, mailMessage{To: recipient.Email, Subject: title, Text: body, LinkLabel: linkLabel, Link: link}); err != nil {
			slog.Warn("notification e-mail failed", "notificationId", id, "error", err)
		}
	}
	a.pushToUser(ctx, recipient.UserID, map[string]string{"title": title, "body": body, "url": link, "tag": id.String()})
	a.deliverWebhooks(ctx, recipient.UserID, webhookMessage{ID: id.String(), Type: kind, Title: title, Body: body, URL: link, LinkLabel: linkLabel, CreatedAt: time.Now().UTC()})
}

// pushToUser sends a message to every browser the user subscribed. It returns how
// many browsers accepted it.
func (a *App) pushToUser(ctx context.Context, userID uuid.UUID, message map[string]string) int {
	rows, err := a.DB.QueryContext(ctx, `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, userID)
	if err != nil {
		return 0
	}
	type target struct {
		id  uuid.UUID
		sub pushSubscription
	}
	var targets []target
	for rows.Next() {
		var t target
		if rows.Scan(&t.id, &t.sub.Endpoint, &t.sub.P256dh, &t.sub.Auth) == nil {
			targets = append(targets, t)
		}
	}
	rows.Close()
	if len(targets) == 0 {
		return 0
	}
	keys, err := a.loadVAPIDKeys(ctx)
	if err != nil {
		slog.Warn("push keys unavailable", "error", err)
		return 0
	}
	payload, _ := json.Marshal(message)
	subject := a.pushSubject(ctx)
	sent := 0
	for _, t := range targets {
		err := sendWebPush(ctx, keys, subject, t.sub, payload)
		switch {
		case err == nil:
			sent++
			_, _ = a.DB.ExecContext(ctx, `UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1`, t.id)
		case errors.Is(err, errPushGone):
			_, _ = a.DB.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, t.id)
		default:
			slog.Warn("push failed", "subscriptionId", t.id, "error", err)
			// A browser that keeps failing is dropped after a while.
			_, _ = a.DB.ExecContext(ctx, `WITH failed AS (UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1 RETURNING id, failure_count)
				DELETE FROM push_subscriptions p USING failed WHERE p.id = failed.id AND failed.failure_count >= 20`, t.id)
		}
	}
	return sent
}

// ---- HTTP ----

func (a *App) listNotifications(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, kind, title, body, link, session_id, created_at, read_at FROM notifications
		WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 50`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	items := []notificationItem{}
	for rows.Next() {
		var item notificationItem
		var session uuid.NullUUID
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.Body, &item.Link, &session, &item.CreatedAt, &item.ReadAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if session.Valid {
			item.SessionID = &session.UUID
		}
		items = append(items, item)
	}
	var unread int
	_ = a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND organization_id = $2 AND read_at IS NULL`, principal.UserID, organizationID).Scan(&unread)
	c.JSON(http.StatusOK, gin.H{"items": items, "unread": unread})
}

// markNotificationsRead: {"ids": [...]} or {"all": true}.
func (a *App) markNotificationsRead(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	var request struct {
		IDs []uuid.UUID `json:"ids"`
		All bool        `json:"all"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || (!request.All && len(request.IDs) == 0) || len(request.IDs) > 200 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("send ids or all"))
		return
	}
	ids := make([]string, 0, len(request.IDs))
	for _, id := range request.IDs {
		ids = append(ids, id.String())
	}
	if _, err := a.DB.ExecContext(c, `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND organization_id = $2 AND read_at IS NULL AND ($3 OR id = ANY($4::uuid[]))`,
		principal.UserID, organizationID, request.All, pq.Array(ids)); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) notificationSettings(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	if c.Request.Method == http.MethodPut {
		var request struct {
			EmailEnabled *bool   `json:"emailEnabled"`
			Locale       *string `json:"locale"`
			TimeZone     *string `json:"timeZone"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		locale := ""
		if request.Locale != nil {
			locale = strings.ToLower(strings.TrimSpace(*request.Locale))
			if locale != "de" && locale != "en" {
				writeError(c, http.StatusBadRequest, fmt.Errorf("locale must be de or en"))
				return
			}
		}
		zone := ""
		if request.TimeZone != nil {
			zone = strings.TrimSpace(*request.TimeZone)
			if _, err := time.LoadLocation(zone); err != nil || zone == "" || zone == "Local" || len(zone) > 64 {
				writeError(c, http.StatusBadRequest, fmt.Errorf("unknown time zone"))
				return
			}
		}
		if _, err := a.DB.ExecContext(c, `INSERT INTO notification_settings (user_id, email_enabled, locale, timezone) VALUES ($1, COALESCE($2, TRUE), COALESCE(NULLIF($3, ''), 'en'), COALESCE(NULLIF($4, ''), 'UTC'))
			ON CONFLICT (user_id) DO UPDATE SET email_enabled = COALESCE($2, notification_settings.email_enabled), locale = COALESCE(NULLIF($3, ''), notification_settings.locale), timezone = COALESCE(NULLIF($4, ''), notification_settings.timezone), updated_at = now()`,
			principal.UserID, request.EmailEnabled, locale, zone); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	emailEnabled := true
	_ = a.DB.QueryRowContext(c, `SELECT email_enabled FROM notification_settings WHERE user_id = $1`, principal.UserID).Scan(&emailEnabled)
	response := gin.H{"emailEnabled": emailEnabled, "emailAvailable": a.effectiveSMTP(c).Host != ""}
	if keys, err := a.loadVAPIDKeys(c); err == nil {
		response["vapidPublicKey"] = keys.publicB64
	}
	c.JSON(http.StatusOK, response)
}

// pushSubscriptions: POST stores a browser's subscription, DELETE removes it.
func (a *App) pushSubscriptions(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var request struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || !validPushEndpoint(request.Endpoint) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid push subscription"))
		return
	}
	if c.Request.Method == http.MethodDelete {
		_, _ = a.DB.ExecContext(c, `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, request.Endpoint, principal.UserID)
		c.Status(http.StatusNoContent)
		return
	}
	p256dh, errKey := decodeB64(request.Keys.P256dh)
	auth, errAuth := decodeB64(request.Keys.Auth)
	if errKey != nil || errAuth != nil || len(p256dh) != 65 || len(auth) != 16 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid push subscription keys"))
		return
	}
	// One browser belongs to whoever subscribed last on it.
	if _, err := a.DB.ExecContext(c, `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, failure_count = 0`,
		principal.UserID, request.Endpoint, request.Keys.P256dh, request.Keys.Auth); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// testNotification sends a test message to the user's browsers and e-mail.
func (a *App) testNotification(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var email, locale string
	emailEnabled := true
	_ = a.DB.QueryRowContext(c, `SELECT u.email, COALESCE(ns.email_enabled, TRUE), COALESCE(ns.locale, 'en') FROM users u LEFT JOIN notification_settings ns ON ns.user_id = u.id WHERE u.id = $1`, principal.UserID).Scan(&email, &emailEnabled, &locale)
	title, body := "JustAI test notification", "Notifications reach you here."
	if strings.HasPrefix(locale, "de") {
		title, body = "JustAI-Testbenachrichtigung", "Benachrichtigungen kommen hier an."
	}
	pushed := a.pushToUser(c, principal.UserID, map[string]string{"title": title, "body": body, "url": a.publicLink(c, "/"), "tag": "justai-test"})
	linkLabel := "Open JustAI"
	if strings.HasPrefix(locale, "de") {
		linkLabel = "JustAI öffnen"
	}
	hooked := a.deliverWebhooks(c, principal.UserID, webhookMessage{ID: uuid.NewString(), Type: "test", Title: title, Body: body, URL: a.publicLink(c, "/"), LinkLabel: linkLabel, CreatedAt: time.Now().UTC()})
	emailed, emailError := false, ""
	if smtp := a.effectiveSMTP(c); smtp.Host != "" && emailEnabled && email != "" {
		if err := sendMail(smtp, mailMessage{To: email, Subject: title, Text: body}); err != nil {
			emailError = err.Error()
		} else {
			emailed = true
		}
	}
	c.JSON(http.StatusOK, gin.H{"pushed": pushed, "webhooks": hooked, "emailed": emailed, "emailError": emailError})
}

// sessionNotifications: GET or PUT {"muted": bool} for one transcript.
func (a *App) sessionNotifications(c *gin.Context) {
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
	if c.Request.Method == http.MethodPut {
		var request struct {
			Muted bool `json:"muted"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		query := `DELETE FROM transcription_notification_mutes WHERE session_id = $1 AND user_id = $2`
		if request.Muted {
			query = `INSERT INTO transcription_notification_mutes (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`
		}
		if _, err := a.DB.ExecContext(c, query, sessionID, principal.UserID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	var muted bool
	_ = a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_notification_mutes WHERE session_id = $1 AND user_id = $2)`, sessionID, principal.UserID).Scan(&muted)
	c.JSON(http.StatusOK, gin.H{"muted": muted})
}
