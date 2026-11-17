package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/middleware"
)

// A topic subscription keeps keywords such as "Digitales" or "Haushalt". Whenever the
// Bundestag publishes the planned course of a sitting week, JustAI picks the agenda
// items that match and schedules a "selected topics only" capture per sitting, with the
// settings and stream link of the session the subscription was made from.

const topicSubscriptionInterval = 30 * time.Minute

type topicSubscription struct {
	ID            uuid.UUID                  `json:"id"`
	Name          string                     `json:"name"`
	Keywords      []string                   `json:"keywords"`
	SourceName    string                     `json:"sourceName"`
	Enabled       bool                       `json:"enabled"`
	LastCheckedAt *time.Time                 `json:"lastCheckedAt,omitempty"`
	LastError     string                     `json:"lastError,omitempty"`
	CreatedAt     time.Time                  `json:"createdAt"`
	Sittings      []topicSubscriptionSitting `json:"sittings"`
}

type topicSubscriptionSitting struct {
	SittingNo    int        `json:"sittingNo"`
	SessionID    *uuid.UUID `json:"sessionId,omitempty"`
	SessionTitle string     `json:"sessionTitle,omitempty"`
	TopicCount   int        `json:"topicCount"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// normalizeKeywords trims, de-duplicates and bounds the keywords of a subscription.
func normalizeKeywords(values []string) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.Join(strings.Fields(value), " ")
		if value == "" || seen[foldKeyword(value)] {
			continue
		}
		if len([]rune(value)) < 3 || len([]rune(value)) > 80 {
			return nil, fmt.Errorf("keywords must be between 3 and 80 characters")
		}
		seen[foldKeyword(value)] = true
		out = append(out, value)
	}
	if len(out) == 0 || len(out) > 20 {
		return nil, fmt.Errorf("enter between 1 and 20 keywords")
	}
	return out, nil
}

var keywordFolder = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss")

func foldKeyword(value string) string {
	return keywordFolder.Replace(strings.ToLower(value))
}

// matchSubscriptionItems returns the items whose label, title or note contains one of
// the keywords (case and umlaut spelling ignored).
func matchSubscriptionItems(items []planItem, keywords []string) []planItem {
	var out []planItem
	for _, item := range items {
		haystack := foldKeyword(item.Label + " " + item.Title + " " + item.Note)
		for _, keyword := range keywords {
			if strings.Contains(haystack, foldKeyword(keyword)) {
				out = append(out, item)
				break
			}
		}
	}
	return out
}

// upcomingSittingMatches groups the matching items per sitting, keeping only sittings
// whose capture would still start in the future.
func upcomingSittingMatches(items []planItem, keywords []string, now time.Time) map[int][]planItem {
	out := map[int][]planItem{}
	for _, item := range matchSubscriptionItems(items, keywords) {
		out[item.SessionNo] = append(out[item.SessionNo], item)
	}
	for sitting, matched := range out {
		if start, _ := topicCapturePlan(matched, now); !start.After(now.Add(5 * time.Minute)) {
			delete(out, sitting)
		}
	}
	return out
}

// ---- background ----

var (
	topicSubscriptionsRunning atomic.Bool
	topicSubscriptionsLast    struct {
		sync.Mutex
		at time.Time
	}
)

// runTopicSubscriptionsSoon checks the subscriptions every half hour, in the background.
func (a *App) runTopicSubscriptionsSoon(force bool) {
	topicSubscriptionsLast.Lock()
	due := force || time.Since(topicSubscriptionsLast.at) >= topicSubscriptionInterval
	if due {
		topicSubscriptionsLast.at = time.Now()
	}
	topicSubscriptionsLast.Unlock()
	if !due || !topicSubscriptionsRunning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer topicSubscriptionsRunning.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		a.runTopicSubscriptions(ctx)
	}()
}

type subscriptionRow struct {
	id, userID, organizationID                                  uuid.UUID
	name, sourceName, language                                  string
	keywords                                                    []string
	urlCiphertext                                               []byte
	transcriptionEndpoint, diarizationEndpoint, grammarEndpoint uuid.NullUUID
	transcriptionModel, diarizationModel, grammarModel          sql.NullString
	recordAudio                                                 bool
}

func (a *App) runTopicSubscriptions(ctx context.Context) {
	if a.DB == nil {
		return
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id, user_id, organization_id, name, keywords, url_ciphertext, source_name, transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, transcription_model, diarization_model, grammar_model, language, record_audio FROM transcription_topic_subscriptions WHERE enabled`)
	if err != nil {
		return
	}
	var subs []subscriptionRow
	for rows.Next() {
		var s subscriptionRow
		if err := rows.Scan(&s.id, &s.userID, &s.organizationID, &s.name, pq.Array(&s.keywords), &s.urlCiphertext, &s.sourceName, &s.transcriptionEndpoint, &s.diarizationEndpoint, &s.grammarEndpoint, &s.transcriptionModel, &s.diarizationModel, &s.grammarModel, &s.language, &s.recordAudio); err == nil {
			subs = append(subs, s)
		}
	}
	rows.Close()
	if len(subs) == 0 {
		return
	}
	items, err := a.cachedAblaufplan(ctx)
	if err != nil {
		liveStreamEvents.inc("subscription_plan_failed")
		_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_topic_subscriptions SET last_checked_at = now(), last_error = $1 WHERE enabled`, "The Bundestag plan could not be loaded.")
		return
	}
	for _, sub := range subs {
		a.applyTopicSubscription(ctx, sub, items)
	}
}

func (a *App) applyTopicSubscription(ctx context.Context, sub subscriptionRow, items []planItem) {
	now := time.Now().UTC()
	matches := upcomingSittingMatches(items, sub.keywords, now)
	sittings := make([]int, 0, len(matches))
	for sitting := range matches {
		sittings = append(sittings, sitting)
	}
	sort.Ints(sittings)
	lastError := ""
	for _, sitting := range sittings {
		// Claim the sitting first, so it is never scheduled twice.
		claim, err := a.DB.ExecContext(ctx, `INSERT INTO transcription_topic_subscription_sittings (subscription_id, sitting_no, topic_count) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, sub.id, sitting, len(matches[sitting]))
		if err != nil {
			lastError = err.Error()
			continue
		}
		if claimed, _ := claim.RowsAffected(); claimed == 0 {
			continue
		}
		sessionID, err := a.scheduleSubscriptionCapture(ctx, sub, plenaryItemsForSession(items, sitting), matches[sitting], now)
		if err != nil {
			slog.Warn("topic subscription could not schedule a capture", "subscriptionId", sub.id, "sitting", sitting, "error", err)
			_, _ = a.DB.ExecContext(ctx, `DELETE FROM transcription_topic_subscription_sittings WHERE subscription_id = $1 AND sitting_no = $2`, sub.id, sitting)
			lastError = err.Error()
			continue
		}
		liveStreamEvents.inc("subscription_scheduled")
		_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_topic_subscription_sittings SET session_id = $3 WHERE subscription_id = $1 AND sitting_no = $2`, sub.id, sitting, sessionID)
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_topic_subscriptions SET last_checked_at = now(), last_error = $2 WHERE id = $1`, sub.id, lastError)
}

// scheduleSubscriptionCapture creates a session with a stream source that records only
// the selected items of one sitting.
func (a *App) scheduleSubscriptionCapture(ctx context.Context, sub subscriptionRow, sittingItems, selected []planItem, now time.Time) (uuid.UUID, error) {
	if !sub.transcriptionEndpoint.Valid {
		return uuid.Nil, fmt.Errorf("the transcription endpoint of this subscription no longer exists")
	}
	streamURL, err := a.Secrets.Decrypt(sub.urlCiphertext)
	if err != nil {
		return uuid.Nil, fmt.Errorf("the stream link could not be read")
	}
	parsedURL, err := url.Parse(streamURL)
	if err != nil {
		return uuid.Nil, fmt.Errorf("the stream link is invalid")
	}
	start, end := topicCapturePlan(selected, now)
	berlin, _ := time.LoadLocation("Europe/Berlin")
	if berlin == nil {
		berlin = time.UTC
	}
	title := fmt.Sprintf("%s · %d. Sitzung (%s)", sub.name, selected[0].SessionNo, selected[0].StartAt.In(berlin).Format("02.01."))
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, err
	}
	defer transaction.Rollback()
	var sessionID uuid.UUID
	if err := transaction.QueryRowContext(ctx, `
		INSERT INTO transcription_sessions (user_id, organization_id, title, transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, transcription_model, diarization_model, grammar_model, language, record_audio, polish_status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $6::uuid IS NULL THEN 'not_requested' ELSE 'queued' END)
		RETURNING id`, sub.userID, sub.organizationID, title, sub.transcriptionEndpoint, sub.diarizationEndpoint, sub.grammarEndpoint, sub.transcriptionModel, sub.diarizationModel, sub.grammarModel, sub.language, sub.recordAudio).Scan(&sessionID); err != nil {
		return uuid.Nil, err
	}
	if sub.diarizationEndpoint.Valid || sub.grammarEndpoint.Valid {
		if _, err := transaction.ExecContext(ctx, `INSERT INTO transcription_live_processing (session_id, diarization_status, polish_status) VALUES ($1, CASE WHEN $2 THEN 'queued' ELSE 'skipped' END, CASE WHEN $3 THEN 'queued' ELSE 'skipped' END)`, sessionID, sub.diarizationEndpoint.Valid, sub.grammarEndpoint.Valid); err != nil {
			return uuid.Nil, err
		}
	}
	source, err := createIngressTranscriptionSource(ctx, transaction, sessionID, firstNonEmptyString(sub.sourceName, "Live stream"), "stream", "")
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO transcription_stream_sources (source_id, url_ciphertext, protocol, status, scheduled_start_at, scheduled_end_at, reconnect_grace_seconds, start_mode, silence_stop_seconds, plan_follow, plan_key, capture_scope) VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, 'at_time', 0, FALSE, '', 'topics')`, source.ID, sub.urlCiphertext, strings.ToLower(parsedURL.Scheme), start, end, defaultLiveStreamReconnectGraceSeconds); err != nil {
		return uuid.Nil, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, err
	}
	keys := make([]string, len(selected))
	for i, item := range selected {
		keys[i] = item.Key
	}
	if _, err := syncTopics(ctx, a.DB, sessionID, source.ID, sittingItems); err != nil {
		return sessionID, nil // the capture is scheduled; topics are refreshed with the plan
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE transcription_topics SET starred = (topic_key = ANY($2)), updated_at = now() WHERE session_id = $1`, sessionID, pq.Array(keys))
	return sessionID, nil
}

// ---- HTTP ----

func (a *App) loadTopicSubscriptions(ctx context.Context, userID, organizationID uuid.UUID) ([]topicSubscription, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT id, name, keywords, source_name, enabled, last_checked_at, last_error, created_at FROM transcription_topic_subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at`, userID, organizationID)
	if err != nil {
		return nil, err
	}
	out := []topicSubscription{}
	index := map[uuid.UUID]int{}
	for rows.Next() {
		var s topicSubscription
		if err := rows.Scan(&s.ID, &s.Name, pq.Array(&s.Keywords), &s.SourceName, &s.Enabled, &s.LastCheckedAt, &s.LastError, &s.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		s.Sittings = []topicSubscriptionSitting{}
		index[s.ID] = len(out)
		out = append(out, s)
	}
	rows.Close()
	if len(out) == 0 {
		return out, nil
	}
	sittingRows, err := a.DB.QueryContext(ctx, `SELECT st.subscription_id, st.sitting_no, s.id, COALESCE(s.title, ''), st.topic_count, st.created_at FROM transcription_topic_subscription_sittings st JOIN transcription_topic_subscriptions sub ON sub.id = st.subscription_id LEFT JOIN transcription_sessions s ON s.id = st.session_id AND s.archived_at IS NULL WHERE sub.user_id = $1 AND sub.organization_id = $2 ORDER BY st.sitting_no DESC`, userID, organizationID)
	if err != nil {
		return nil, err
	}
	defer sittingRows.Close()
	for sittingRows.Next() {
		var subscriptionID uuid.UUID
		var sitting topicSubscriptionSitting
		var sessionID uuid.NullUUID
		if err := sittingRows.Scan(&subscriptionID, &sitting.SittingNo, &sessionID, &sitting.SessionTitle, &sitting.TopicCount, &sitting.CreatedAt); err != nil {
			return nil, err
		}
		if sessionID.Valid {
			sitting.SessionID = &sessionID.UUID
		}
		if i, ok := index[subscriptionID]; ok && len(out[i].Sittings) < 10 {
			out[i].Sittings = append(out[i].Sittings, sitting)
		}
	}
	return out, sittingRows.Err()
}

func (a *App) listTopicSubscriptions(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	subs, err := a.loadTopicSubscriptions(c, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"subscriptions": subs})
}

// createTopicSubscription copies the settings and stream link of a session whose
// stream follows the Bundestag.
func (a *App) createTopicSubscription(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	var request struct {
		SessionID uuid.UUID `json:"sessionId"`
		Name      string    `json:"name"`
		Keywords  []string  `json:"keywords"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if err := a.authorizeTranscriptionSession(c, request.SessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	keywords, err := normalizeKeywords(request.Keywords)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	name := strings.Join(strings.Fields(request.Name), " ")
	if name == "" {
		name = "Bundestag · " + keywords[0]
	}
	if len([]rune(name)) > 120 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("the name must be 120 characters or fewer"))
		return
	}
	var count int
	_ = a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM transcription_topic_subscriptions WHERE user_id = $1`, principal.UserID).Scan(&count)
	if count >= 20 {
		writeError(c, http.StatusConflict, fmt.Errorf("you can keep up to 20 topic subscriptions"))
		return
	}
	var ciphertext []byte
	var sourceName string
	err = a.DB.QueryRowContext(c, `SELECT stream.url_ciphertext, source.name FROM transcription_stream_sources stream JOIN transcription_sources source ON source.id = stream.source_id WHERE source.session_id = $1 ORDER BY source.created_at LIMIT 1`, request.SessionID).Scan(&ciphertext, &sourceName)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("this session has no live stream to subscribe to"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	streamURL, err := a.Secrets.Decrypt(ciphertext)
	if err != nil || !isBundestagPlanURL(streamURL) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("topic subscriptions need a Bundestag live stream"))
		return
	}
	var id uuid.UUID
	if err := a.DB.QueryRowContext(c, `
		INSERT INTO transcription_topic_subscriptions (user_id, organization_id, name, keywords, url_ciphertext, source_name, transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, transcription_model, diarization_model, grammar_model, language, record_audio)
		SELECT $1, $2, $3, $4, $5, $6, transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, transcription_model, diarization_model, grammar_model, language, record_audio
		FROM transcription_sessions WHERE id = $7
		RETURNING id`, principal.UserID, organizationID, name, pq.Array(keywords), ciphertext, sourceName, request.SessionID).Scan(&id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// The current sitting is already being recorded by the session this was made from.
	for _, sitting := range a.sessionSittings(c, request.SessionID) {
		_, _ = a.DB.ExecContext(c, `INSERT INTO transcription_topic_subscription_sittings (subscription_id, sitting_no, session_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, id, sitting, request.SessionID)
	}
	a.runTopicSubscriptionsSoon(true)
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// sessionSittings returns the sitting numbers whose agenda items a session holds.
func (a *App) sessionSittings(ctx context.Context, sessionID uuid.UUID) []int {
	rows, err := a.DB.QueryContext(ctx, `SELECT DISTINCT substring(topic_key from '^s([0-9]+)-')::int FROM transcription_topics WHERE session_id = $1 AND topic_key ~ '^s[0-9]+-'`, sessionID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var n int
		if rows.Scan(&n) == nil {
			out = append(out, n)
		}
	}
	return out
}

func (a *App) updateTopicSubscription(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid subscription id"))
		return
	}
	var request struct {
		Name     *string   `json:"name"`
		Keywords *[]string `json:"keywords"`
		Enabled  *bool     `json:"enabled"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	var keywords any
	if request.Keywords != nil {
		normalized, err := normalizeKeywords(*request.Keywords)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		keywords = pq.Array(normalized)
	}
	var name any
	if request.Name != nil {
		trimmed := strings.Join(strings.Fields(*request.Name), " ")
		if trimmed == "" || len([]rune(trimmed)) > 120 {
			writeError(c, http.StatusBadRequest, fmt.Errorf("the name must be between 1 and 120 characters"))
			return
		}
		name = trimmed
	}
	result, err := a.DB.ExecContext(c, `UPDATE transcription_topic_subscriptions SET name = COALESCE($4, name), keywords = COALESCE($5, keywords), enabled = COALESCE($6, enabled), last_error = '', updated_at = now() WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID, name, keywords, request.Enabled)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("subscription not found"))
		return
	}
	a.runTopicSubscriptionsSoon(true)
	c.Status(http.StatusNoContent)
}

// deleteTopicSubscription stops future captures; sessions already scheduled stay.
func (a *App) deleteTopicSubscription(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid subscription id"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM transcription_topic_subscriptions WHERE id = $1 AND user_id = $2 AND organization_id = $3`, id, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// previewTopicSubscription lists the upcoming agenda items the keywords would pick.
func (a *App) previewTopicSubscription(c *gin.Context) {
	var request struct {
		Keywords []string `json:"keywords"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	keywords, err := normalizeKeywords(request.Keywords)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	items, err := a.cachedAblaufplan(c)
	if err != nil {
		writeError(c, http.StatusBadGateway, fmt.Errorf("the Bundestag plan could not be loaded"))
		return
	}
	now := time.Now().UTC()
	matched := []planItem{}
	for _, item := range matchSubscriptionItems(items, keywords) {
		if item.EndAt.After(now) {
			matched = append(matched, item)
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": matched})
}
