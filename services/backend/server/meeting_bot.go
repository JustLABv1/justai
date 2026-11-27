package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// The meeting-bot service (services/meeting-bot) joins browser meetings for a
// meeting-bot source when the user chose "join automatically". The backend hands it
// the source's ingest token, then follows the bot's status and tells it to leave
// when the source or the session stops.

const (
	meetingBotRequestTimeout = 15 * time.Second
	// A bot whose service cannot be reached for this long is reported as failed.
	meetingBotUnreachableAfter = 2 * time.Minute
	meetingBotWatchLimit       = 12 * time.Hour
)

// meetingBotPollEvery spaces the status checks of one bot (shorter in tests).
var meetingBotPollEvery = 5 * time.Second

// meetingBotPlatforms are the platforms the bot can join (a browser web app).
var meetingBotPlatforms = map[string]bool{"cisco-meeting-server": true, "generic": true}

// meetingBotMeetingOver are the bot's reasons for leaving on its own because the
// meeting is over for it. Its source then stops, and the session ends when no other
// source is still capturing. A bot stopped by someone ("stop requested") or one that
// failed leaves the session as it is.
var meetingBotMeetingOver = map[string]bool{
	"the meeting ended":                true,
	"no other participant for a while": true,
	"nothing was said for a while":     true,
	"maximum duration reached":         true,
}

// meetingBotActiveStatuses are reported while the bot has not finished.
var meetingBotActiveStatuses = map[string]bool{"starting": true, "connecting": true, "joining": true, "in_call": true}

// meetingBotClient never follows redirects: the service URL is operator configuration.
var meetingBotClient = &http.Client{
	Timeout: meetingBotRequestTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

var errMeetingBotNotFound = errors.New("the meeting bot service does not run this bot")

type meetingBotStatus struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

func (a *App) meetingBotEnabled() bool {
	return strings.TrimSpace(a.Config.MeetingBot.URL) != ""
}

// meetingBotAvailability: GET /transcription/meeting-bot tells the UI whether bots can
// join meetings automatically on this server.
func (a *App) meetingBotAvailability(c *gin.Context) {
	platforms := []string{}
	if a.meetingBotEnabled() {
		platforms = []string{"cisco-meeting-server", "generic"}
	}
	c.JSON(http.StatusOK, gin.H{"available": a.meetingBotEnabled(), "platforms": platforms})
}

func (a *App) meetingBotRequest(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.Config.MeetingBot.URL, "/")+path, reader)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+a.Config.MeetingBot.Token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := meetingBotClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	return response.StatusCode, payload, err
}

func meetingBotErrorText(status int, payload []byte) string {
	var decoded struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(payload, &decoded) == nil && decoded.Error != "" {
		return decoded.Error
	}
	return fmt.Sprintf("status %d", status)
}

// launchMeetingBot asks the service to join the meeting with the source's ingest token.
func (a *App) launchMeetingBot(ctx context.Context, sourceID uuid.UUID, token, platform, meetingURL, meetingID, passcode string) (meetingBotStatus, error) {
	status, payload, err := a.meetingBotRequest(ctx, http.MethodPost, "/v1/bots", map[string]string{
		"sourceId":   sourceID.String(),
		"token":      token,
		"platform":   platform,
		"meetingUrl": meetingURL,
		"meetingId":  meetingID,
		"passcode":   passcode,
	})
	if err != nil {
		return meetingBotStatus{}, fmt.Errorf("the meeting bot service is unreachable: %w", err)
	}
	if status != http.StatusOK && status != http.StatusAccepted {
		return meetingBotStatus{}, fmt.Errorf("the meeting bot service refused the bot: %s", meetingBotErrorText(status, payload))
	}
	var result meetingBotStatus
	if err := json.Unmarshal(payload, &result); err != nil || result.Status == "" {
		return meetingBotStatus{Status: "starting"}, nil
	}
	return result, nil
}

func (a *App) meetingBotStatus(ctx context.Context, sourceID uuid.UUID) (meetingBotStatus, error) {
	status, payload, err := a.meetingBotRequest(ctx, http.MethodGet, "/v1/bots/"+sourceID.String(), nil)
	if err != nil {
		return meetingBotStatus{}, err
	}
	if status == http.StatusNotFound {
		return meetingBotStatus{}, errMeetingBotNotFound
	}
	if status != http.StatusOK {
		return meetingBotStatus{}, fmt.Errorf("meeting bot status: %s", meetingBotErrorText(status, payload))
	}
	var result meetingBotStatus
	if err := json.Unmarshal(payload, &result); err != nil {
		return meetingBotStatus{}, err
	}
	return result, nil
}

// stopMeetingBot tells the bot to leave. A bot that has already gone is fine.
func (a *App) stopMeetingBot(ctx context.Context, sourceID uuid.UUID) {
	if !a.meetingBotEnabled() {
		return
	}
	status, payload, err := a.meetingBotRequest(ctx, http.MethodDelete, "/v1/bots/"+sourceID.String(), nil)
	if err != nil || (status != http.StatusAccepted && status != http.StatusNotFound) {
		slog.Warn("meeting bot could not be stopped", "sourceId", sourceID, "error", err, "response", meetingBotErrorText(status, payload))
	}
}

// stopMeetingBotsOfSession makes every automatically joined bot of a session leave.
func (a *App) stopMeetingBotsOfSession(sessionID uuid.UUID) {
	if !a.meetingBotEnabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), meetingBotRequestTimeout)
	defer cancel()
	rows, err := a.DB.QueryContext(ctx, `SELECT bot.source_id FROM transcription_bot_sources bot JOIN transcription_sources source ON source.id = bot.source_id
		WHERE source.session_id = $1 AND bot.join_status IN ('starting', 'connecting', 'joining', 'in_call')`, sessionID)
	if err != nil {
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		a.stopMeetingBot(ctx, id)
	}
}

// setMeetingBotStatus stores what the service reported and tells the session's viewers.
func (a *App) setMeetingBotStatus(sessionID, sourceID uuid.UUID, status, failure string) {
	if _, err := a.DB.Exec(`UPDATE transcription_bot_sources SET join_status = $2, join_error = $3, updated_at = now() WHERE source_id = $1`, sourceID, status, truncateRunes(failure, 500)); err != nil {
		return
	}
	a.Live.broadcast(sessionID, "transcription.bot", ginData{"sourceId": sourceID, "botJoinStatus": status, "botJoinError": failure})
}

// watchMeetingBot follows one bot until it has finished.
func (a *App) watchMeetingBot(sessionID, sourceID uuid.UUID, last string) {
	deadline := time.Now().Add(meetingBotWatchLimit)
	unreachableSince := time.Time{}
	ticker := time.NewTicker(meetingBotPollEvery)
	defer ticker.Stop()
	for range ticker.C {
		if time.Now().After(deadline) {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), meetingBotRequestTimeout)
		current, err := a.meetingBotStatus(ctx, sourceID)
		cancel()
		switch {
		case errors.Is(err, errMeetingBotNotFound):
			a.setMeetingBotStatus(sessionID, sourceID, "failed", "The meeting bot is no longer running; its service may have restarted.")
			return
		case err != nil:
			if unreachableSince.IsZero() {
				unreachableSince = time.Now()
			}
			if time.Since(unreachableSince) >= meetingBotUnreachableAfter {
				a.setMeetingBotStatus(sessionID, sourceID, "failed", "The meeting bot service is unreachable.")
				return
			}
			continue
		}
		unreachableSince = time.Time{}
		if current.Status != last {
			failure := ""
			if current.Status == "failed" {
				failure = firstNonEmptyString(current.Reason, "The meeting bot failed.")
			}
			a.setMeetingBotStatus(sessionID, sourceID, current.Status, failure)
			last = current.Status
		}
		if !meetingBotActiveStatuses[current.Status] {
			if current.Status == "ended" && meetingBotMeetingOver[current.Reason] {
				a.finishMeetingBotSource(sessionID, sourceID, current.Reason)
			}
			return
		}
	}
}

// finishMeetingBotSource stops a source whose bot left the meeting by itself and ends
// the session when that was its last capturing source, as a finished livestream does.
func (a *App) finishMeetingBotSource(sessionID, sourceID uuid.UUID, reason string) {
	now := time.Now().UTC()
	a.Live.finishTopicsAtStreamEnd(sessionID, sourceID)
	_, _ = a.DB.Exec(`UPDATE transcription_bot_sources SET status = 'stopped', updated_at = $2 WHERE source_id = $1`, sourceID, now)
	_, _ = a.DB.Exec(`UPDATE transcription_sources SET status = 'stopped', updated_at = $2 WHERE id = $1`, sourceID, now)
	a.Live.markSource(sessionID, sourceID, "stopped")
	a.Live.broadcast(sessionID, "transcription.bot", ginData{"sourceId": sourceID, "status": "stopped", "reason": reason})
	result, err := a.DB.Exec(`UPDATE transcription_sessions SET status = 'completed', ended_at = COALESCE(ended_at, $2), join_code_hash = NULL, join_code_expires_at = NULL, updated_at = $2
		WHERE id = $1 AND status IN ('waiting', 'live', 'paused')
		AND NOT EXISTS (SELECT 1 FROM transcription_sources other WHERE other.session_id = $1 AND other.id <> $3 AND other.status <> 'stopped')`, sessionID, now, sourceID)
	if err != nil {
		return
	}
	if completed, _ := result.RowsAffected(); completed > 0 {
		slog.Info("session ended with its meeting bot", "sessionId", sessionID, "reason", reason)
		a.Live.broadcast(sessionID, "transcription.session", ginData{"id": sessionID, "status": "completed", "endedAt": now})
	}
}

// resumeMeetingBotWatchers follows bots again after a backend restart.
func (a *App) resumeMeetingBotWatchers(ctx context.Context) {
	if !a.meetingBotEnabled() {
		return
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT source.session_id, bot.source_id, bot.join_status FROM transcription_bot_sources bot JOIN transcription_sources source ON source.id = bot.source_id
		WHERE bot.join_status IN ('starting', 'connecting', 'joining', 'in_call')`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var sessionID, sourceID uuid.UUID
		var status string
		if rows.Scan(&sessionID, &sourceID, &status) == nil {
			go a.watchMeetingBot(sessionID, sourceID, status)
		}
	}
}
