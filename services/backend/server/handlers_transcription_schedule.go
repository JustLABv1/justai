package server

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/provider"
)

const maxWatchWindow = 48 * time.Hour

// streamWatchOptions is the validated watch-window configuration of a stream source.
type streamWatchOptions struct {
	StartMode          string
	SilenceStopSeconds int
	PlanFollow         bool
	PlanKey            string
	FallbackAt         *time.Time
}

func normalizeStartMode(mode string) (string, error) {
	switch mode {
	case "", "at_time":
		return "at_time", nil
	case "when_live":
		return "when_live", nil
	}
	return "", fmt.Errorf("start mode must be at_time or when_live")
}

// prepareStreamWatch validates the watch options against the schedule and, for sources
// that follow the Bundestag plan, confirms the session exists and derives the fallback start.
func (a *App) prepareStreamWatch(ctx context.Context, streamURL, mode string, silenceStopSeconds int, planFollow bool, planKey string, end *time.Time, start *time.Time) (streamWatchOptions, error) {
	opts := streamWatchOptions{StartMode: mode, SilenceStopSeconds: silenceStopSeconds}
	if silenceStopSeconds != 0 && (silenceStopSeconds < 120 || silenceStopSeconds > 14400) {
		return opts, fmt.Errorf("the silence limit must be between 2 minutes and 4 hours")
	}
	if mode == "when_live" {
		if start == nil || end == nil {
			return opts, fmt.Errorf("a watch window needs a start and an end time")
		}
		if end.Sub(*start) > maxWatchWindow {
			return opts, fmt.Errorf("a watch window can be at most 48 hours long")
		}
	}
	if !planFollow {
		return opts, nil
	}
	if mode != "when_live" {
		return opts, fmt.Errorf("following the programme plan requires starting when the stream goes live")
	}
	if planKey == "" || len(planKey) > 200 {
		return opts, fmt.Errorf("choose a session from the programme plan")
	}
	if !isBundestagLiveURL(streamURL) {
		return opts, fmt.Errorf("a programme plan is only available for the Bundestag live page")
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	plan, err := fetchBundestagPlan(fetchCtx, provider.SafeHTTPClient(15*time.Second, a.Config.AllowPrivate))
	if err != nil {
		return opts, fmt.Errorf("the Bundestag plan could not be checked: %w", err)
	}
	for i := range plan {
		if plan[i].Key == planKey {
			fallback := plan[i].FallbackAt
			opts.PlanFollow, opts.PlanKey, opts.FallbackAt = true, planKey, &fallback
			return opts, nil
		}
	}
	return opts, fmt.Errorf("this session is not listed in the Bundestag plan")
}

type transcriptionStreamScheduleRequest struct {
	ScheduledStartAt   *time.Time `json:"scheduledStartAt"`
	ScheduledEndAt     *time.Time `json:"scheduledEndAt"`
	StartMode          string     `json:"startMode"`
	SilenceStopSeconds int        `json:"silenceStopSeconds"`
	PlanFollow         bool       `json:"planFollow"`
	PlanKey            string     `json:"planKey"`
}

// updateTranscriptionStreamSchedule reschedules a capture that has not started yet,
// or adjusts the end and silence limit of one that is already watching.
func (a *App) updateTranscriptionStreamSchedule(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sourceID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source id"))
		return
	}
	var request transcriptionStreamScheduleRequest
	if !decodeJSON(c, &request) {
		return
	}
	var sessionID uuid.UUID
	var status, currentMode string
	var currentStart *time.Time
	var ciphertext []byte
	if err := a.DB.QueryRowContext(c, `SELECT source.session_id, stream.status, stream.start_mode, stream.scheduled_start_at, stream.url_ciphertext FROM transcription_sources source JOIN transcription_stream_sources stream ON stream.source_id = source.id JOIN transcription_sessions session ON session.id = source.session_id WHERE source.id = $1 AND session.user_id = $2 AND session.organization_id = $3`, sourceID, principal.UserID, organizationID).Scan(&sessionID, &status, &currentMode, &currentStart, &ciphertext); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("live stream source not found"))
		return
	}
	if status != "scheduled" && status != "watching" {
		writeError(c, http.StatusConflict, fmt.Errorf("the schedule can only be changed before capture has started"))
		return
	}
	streamURL, err := a.Secrets.Decrypt(ciphertext)
	if err != nil {
		writeError(c, http.StatusInternalServerError, fmt.Errorf("live stream URL could not be decrypted"))
		return
	}
	mode, err := normalizeStartMode(request.StartMode)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	now := time.Now().UTC()
	startIn := request.ScheduledStartAt
	if status == "watching" {
		// The window is already open: keep its start and the watch mode.
		if mode != "when_live" {
			writeError(c, http.StatusConflict, fmt.Errorf("a source that is already watching cannot switch to a fixed start time"))
			return
		}
		startIn = currentStart
	} else if mode == "when_live" && startIn == nil {
		startIn = &now
	}
	var start, end *time.Time
	if status == "watching" {
		start = startIn
		if request.ScheduledEndAt == nil || !request.ScheduledEndAt.After(now) {
			writeError(c, http.StatusBadRequest, fmt.Errorf("the watch window must end in the future"))
			return
		}
		value := request.ScheduledEndAt.UTC()
		end = &value
	} else if start, end, err = validateTranscriptionStreamSchedule(startIn, request.ScheduledEndAt, now); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	opts, err := a.prepareStreamWatch(c, streamURL, mode, request.SilenceStopSeconds, request.PlanFollow, request.PlanKey, end, start)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE transcription_stream_sources SET scheduled_start_at = $2, scheduled_end_at = $3, start_mode = $4, silence_stop_seconds = $5, plan_follow = $6, plan_key = $7, plan_fallback_at = $8, alert = '', updated_at = now() WHERE source_id = $1 AND status IN ('scheduled', 'watching')`, sourceID, start, end, opts.StartMode, opts.SilenceStopSeconds, opts.PlanFollow, opts.PlanKey, opts.FallbackAt)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		writeError(c, http.StatusConflict, fmt.Errorf("the capture started while the schedule was being changed"))
		return
	}
	a.Live.broadcastSource(sessionID, sourceID)
	c.Status(http.StatusNoContent)
}
