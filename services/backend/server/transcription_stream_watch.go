package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"justai-backend/provider"
	"justai-backend/speechdetect"
)

const (
	watchRetryDelay            = 10 * time.Second
	watchAttemptMax            = 5 * time.Minute
	watchUnreachableAlertAfter = 10 * time.Minute
	watchHeartbeat             = time.Minute
	planRefreshEvery           = 10 * time.Minute
)

// errLiveSilence ends a capture after a long stretch without speech.
var errLiveSilence = fmt.Errorf("%w: no speech for the configured time", errTranscriptionStreamEnded)

// silenceGuard ends a capture once the programme has returned to music or silence.
// It is armed only after it has heard speech in this capture: if the detector
// never recognised speech on this stream (noisy or unusual audio) it cannot be
// trusted to end the capture, and the schedule's end time applies instead.
type silenceGuard struct {
	gate      *speechdetect.Gate
	stopAfter time.Duration
}

func newSilenceGuard(stopAfter time.Duration) *silenceGuard {
	return &silenceGuard{gate: speechdetect.NewGate(true), stopAfter: stopAfter}
}

// feed returns true when capture should stop.
func (g *silenceGuard) feed(pcm []byte) bool {
	g.gate.Feed(pcm)
	return g.gate.SpeechSeen() && g.gate.NonSpeechFor() >= g.stopAfter
}

// setStreamAlert records a heads-up on the source and tells open sessions.
func (m *TranscriptionManager) setStreamAlert(sessionID, sourceID uuid.UUID, kind, message string) {
	result, err := m.DB.Exec(`UPDATE transcription_stream_sources SET alert = $2, alerted_at = now(), updated_at = now() WHERE source_id = $1 AND alert <> $2`, sourceID, message)
	if err != nil {
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return
	}
	liveStreamEvents.inc(kind)
	m.broadcast(sessionID, "transcription.stream", ginData{"sourceId": sourceID, "alert": message})
}

type watchState struct {
	status     string
	end        *time.Time
	fallbackAt *time.Time
}

func (m *TranscriptionManager) loadWatchState(ctx context.Context, sourceID uuid.UUID) (watchState, error) {
	var state watchState
	var end, fallback *time.Time
	if err := m.DB.QueryRowContext(ctx, `SELECT status, scheduled_end_at, plan_fallback_at FROM transcription_stream_sources WHERE source_id = $1`, sourceID).Scan(&state.status, &end, &fallback); err != nil {
		return state, err
	}
	state.end, state.fallbackAt = end, fallback
	return state, nil
}

// watchForLiveSpeech keeps a lightweight listener on the stream until speech is
// heard, then promotes the source to a normal capture. No transcription provider
// is involved while watching and the session clock has not started.
func (m *TranscriptionManager) watchForLiveSpeech(ctx context.Context, sessionID, sourceID uuid.UUID, streamURL string) error {
	liveStreamEvents.watching.Add(1)
	defer liveStreamEvents.watching.Add(-1)
	m.setStreamStatus(sessionID, sourceID, "watching", "", false)
	var unreachableSince time.Time
	var unreachableAlerted bool
	lastBeat := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				m.watchMissed(sessionID, sourceID)
				return errTranscriptionStreamStopped
			}
			return err
		}
		state, err := m.loadWatchState(ctx, sourceID)
		if err != nil {
			return err
		}
		if state.status != "watching" {
			return errTranscriptionStreamStopped
		}
		now := time.Now()
		if state.end != nil && !now.Before(*state.end) {
			m.watchMissed(sessionID, sourceID)
			return errTranscriptionStreamStopped
		}
		if state.fallbackAt != nil && !now.Before(*state.fallbackAt) {
			return m.claimWatchedStream(ctx, sessionID, sourceID, "fallback_start", "Capture started at the planned time because speech could not be confirmed. Check the transcript.")
		}
		deadline := now.Add(watchAttemptMax)
		for _, limit := range []*time.Time{state.end, state.fallbackAt} {
			if limit != nil && limit.Before(deadline) {
				deadline = *limit
			}
		}
		attemptCtx, cancel := context.WithDeadline(ctx, deadline)
		live, probeErr := m.probeForSpeech(attemptCtx, streamURL)
		cancel()
		if live {
			return m.claimWatchedStream(ctx, sessionID, sourceID, "speech_start", "")
		}
		if probeErr != nil && ctx.Err() == nil && !errors.Is(probeErr, context.DeadlineExceeded) {
			if unreachableSince.IsZero() {
				unreachableSince = time.Now()
			}
			if !unreachableAlerted && time.Since(unreachableSince) >= watchUnreachableAlertAfter {
				unreachableAlerted = true
				m.setStreamAlert(sessionID, sourceID, "stream_unreachable", "The livestream has been unreachable for a while; JustAI keeps trying until the watch window ends.")
			}
			if err := waitTranscriptionStreamReconnect(ctx, int(watchRetryDelay/time.Second)); err != nil {
				return err
			}
		} else {
			unreachableSince, unreachableAlerted = time.Time{}, false
		}
		if time.Since(lastBeat) >= watchHeartbeat {
			lastBeat = time.Now()
			m.setStreamStatus(sessionID, sourceID, "watching", "", false)
		}
	}
}

// probeForSpeech listens until the gate hears speech. It returns an error when the
// stream cannot be opened or ends, and (false, nil) when the attempt deadline passes.
func (m *TranscriptionManager) probeForSpeech(ctx context.Context, streamURL string) (bool, error) {
	resolved, err := resolveLiveStream(ctx, streamURL, m.Config.AllowPrivate)
	if err != nil {
		return false, err
	}
	mediaURL, _ := url.Parse(resolved.URL)
	scheme := ""
	if mediaURL != nil {
		scheme = mediaURL.Scheme
	}
	decoder, err := openLivePCM(ctx, resolved.URL, scheme)
	if err != nil {
		return false, err
	}
	defer decoder.Close()
	gate := speechdetect.NewGate(false)
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := decoder.reader.Read(buffer)
		if n > 0 {
			gate.Feed(buffer[:n])
			if gate.Open() {
				return true, nil
			}
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			if readErr == io.EOF {
				return false, fmt.Errorf("the livestream ended while watching")
			}
			return false, readErr
		}
	}
}

func (m *TranscriptionManager) claimWatchedStream(ctx context.Context, sessionID, sourceID uuid.UUID, event, alert string) error {
	result, err := m.DB.ExecContext(context.WithoutCancel(ctx), `UPDATE transcription_stream_sources SET status = 'pending', alert = CASE WHEN $2 <> '' THEN $2 ELSE alert END, alerted_at = CASE WHEN $2 <> '' THEN now() ELSE alerted_at END, updated_at = now() WHERE source_id = $1 AND status = 'watching'`, sourceID, alert)
	if err != nil {
		return err
	}
	if claimed, _ := result.RowsAffected(); claimed == 0 {
		return errTranscriptionStreamStopped
	}
	liveStreamEvents.inc(event)
	m.app.activateTranscriptionIngressSession(sessionID)
	if alert != "" {
		m.broadcast(sessionID, "transcription.stream", ginData{"sourceId": sourceID, "alert": alert})
	}
	return nil
}

func (m *TranscriptionManager) watchMissed(sessionID, sourceID uuid.UUID) {
	message := "No live speech was detected before the watch window ended, so nothing was captured. Check the broadcaster's schedule and create a new capture."
	m.setStreamAlert(sessionID, sourceID, "watch_missed", message)
	m.setStreamStatus(sessionID, sourceID, "failed", message, false)
}

// refreshFollowedPlans re-reads the published plan for sources that follow it and
// moves their watch window when the broadcaster rescheduled the session.
func (m *TranscriptionManager) refreshFollowedPlans(ctx context.Context) {
	if time.Since(m.lastPlanRefresh) < planRefreshEvery {
		return
	}
	rows, err := m.DB.QueryContext(ctx, `
		SELECT source.session_id, stream.source_id, stream.plan_key, stream.status, stream.scheduled_start_at, stream.scheduled_end_at, stream.plan_fallback_at
		FROM transcription_stream_sources stream
		JOIN transcription_sources source ON source.id = stream.source_id
		WHERE stream.plan_follow AND stream.plan_key <> '' AND stream.status IN ('scheduled', 'watching')`)
	if err != nil {
		return
	}
	type followed struct {
		sessionID, sourceID uuid.UUID
		key, status         string
		start, end, fb      *time.Time
	}
	var items []followed
	for rows.Next() {
		var f followed
		if rows.Scan(&f.sessionID, &f.sourceID, &f.key, &f.status, &f.start, &f.end, &f.fb) == nil {
			items = append(items, f)
		}
	}
	_ = rows.Close()
	if len(items) == 0 {
		return
	}
	m.lastPlanRefresh = time.Now()
	fetchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	plan, err := fetchBundestagPlan(fetchCtx, provider.SafeHTTPClient(15*time.Second, m.Config.AllowPrivate))
	if err != nil {
		liveStreamEvents.inc("plan_fetch_failed")
		return
	}
	berlin, _ := time.LoadLocation("Europe/Berlin")
	for _, f := range items {
		var found *planSession
		for i := range plan {
			if plan[i].Key == f.key {
				found = &plan[i]
			}
		}
		if found == nil {
			m.setStreamAlert(f.sessionID, f.sourceID, "plan_missing", "This session is no longer listed in the Bundestag plan. It may have been cancelled or renamed; check the schedule.")
			continue
		}
		start, end, fallback := found.WindowStartAt, found.WindowEndAt, found.FallbackAt
		if f.status == "watching" && f.start != nil {
			start = *f.start // the window is already open
		}
		changed := f.start == nil || f.end == nil || f.fb == nil || absDuration(f.start.Sub(start)) > time.Minute || absDuration(f.end.Sub(end)) > time.Minute || absDuration(f.fb.Sub(fallback)) > time.Minute
		if !changed {
			continue
		}
		if _, err := m.DB.ExecContext(ctx, `UPDATE transcription_stream_sources SET scheduled_start_at = $2, scheduled_end_at = $3, plan_fallback_at = $4, updated_at = now() WHERE source_id = $1 AND status IN ('scheduled', 'watching')`, f.sourceID, start, end, fallback); err != nil {
			continue
		}
		m.setStreamAlert(f.sessionID, f.sourceID, "plan_changed", fmt.Sprintf("Schedule updated from the Bundestag plan: %s starts %s (Berlin time).", strings.TrimSpace(found.Title), found.StartAt.In(berlin).Format("02.01. 15:04")))
	}
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// refreshTopicPlans moves the planned slots of agenda items when the published plan
// changes. Topics that are already open or finished keep their state.
func (m *TranscriptionManager) refreshTopicPlans(ctx context.Context) {
	if time.Since(m.lastTopicRefresh) < 15*time.Minute {
		return
	}
	rows, err := m.DB.QueryContext(ctx, `
		SELECT DISTINCT topic.session_id, split_part(topic.topic_key, '-', 1)
		FROM transcription_topics topic
		JOIN transcription_sessions session ON session.id = topic.session_id
		WHERE topic.status = 'planned' AND session.status IN ('waiting', 'live', 'paused')`)
	if err != nil {
		return
	}
	type pair struct {
		session uuid.UUID
		sitting int
	}
	var pairs []pair
	for rows.Next() {
		var p pair
		var prefix string
		if rows.Scan(&p.session, &prefix) == nil {
			if n, convErr := strconv.Atoi(strings.TrimPrefix(prefix, "s")); convErr == nil {
				p.sitting = n
				pairs = append(pairs, p)
			}
		}
	}
	_ = rows.Close()
	if len(pairs) == 0 {
		return
	}
	m.lastTopicRefresh = time.Now()
	fetchCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	items, err := fetchBundestagAblaufplan(fetchCtx, provider.SafeHTTPClient(20*time.Second, m.Config.AllowPrivate))
	if err != nil {
		liveStreamEvents.inc("plan_fetch_failed")
		return
	}
	for _, p := range pairs {
		if forSitting := plenaryItemsForSession(items, p.sitting); len(forSitting) > 0 {
			_ = syncTopics(ctx, m.DB, p.session, uuid.Nil, forSitting)
		}
	}
}
