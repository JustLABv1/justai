package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/provider"
)

// Only metadata is retained. Evidence images are re-extracted on demand from
// the authorized source; image bytes and signed URLs are never stored.
type speakerCaptionRun struct {
	ID             uuid.UUID                   `json:"id"`
	SessionID      uuid.UUID                   `json:"sessionId"`
	UploadID       uuid.UUID                   `json:"uploadId"`
	EndpointID     uuid.UUID                   `json:"endpointId"`
	RequestedBy    uuid.UUID                   `json:"-"`
	OrganizationID uuid.UUID                   `json:"-"`
	Model          string                      `json:"model"`
	AutoApply      bool                        `json:"autoApply"`
	FrameBudget    int                         `json:"frameBudget"`
	Status         string                      `json:"status"`
	Frames         []speakerCaptionFrame       `json:"frames"`
	Observations   []speakerCaptionObservation `json:"observations"`
	Results        []speakerCaptionResult      `json:"results"`
	ErrorMessage   string                      `json:"errorMessage,omitempty"`
	CreatedAt      time.Time                   `json:"createdAt"`
	UpdatedAt      time.Time                   `json:"updatedAt"`
}

const captionRunColumns = `id, session_id, upload_id, endpoint_id, requested_by, organization_id, model, auto_apply, frame_budget, status, frames, observations, results, error_message, created_at, updated_at`

type captionRowScanner interface{ Scan(...any) error }

func scanSpeakerCaptionRun(row captionRowScanner) (speakerCaptionRun, error) {
	var r speakerCaptionRun
	var frames, observations, results []byte
	err := row.Scan(&r.ID, &r.SessionID, &r.UploadID, &r.EndpointID, &r.RequestedBy, &r.OrganizationID, &r.Model, &r.AutoApply, &r.FrameBudget, &r.Status, &frames, &observations, &results, &r.ErrorMessage, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(frames, &r.Frames); err != nil {
		return r, err
	}
	if err = json.Unmarshal(observations, &r.Observations); err != nil {
		return r, err
	}
	err = json.Unmarshal(results, &r.Results)
	return r, err
}
func (a *App) captionSession(c *gin.Context) (uuid.UUID, bool) {
	principal, _ := middleware.GetPrincipal(c)
	org, _ := middleware.GetOrganizationID(c)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, 400, fmt.Errorf("invalid session id"))
		return uuid.Nil, false
	}
	if err = a.authorizeTranscriptionSession(c, id, principal.UserID, org); err != nil {
		writeError(c, 404, fmt.Errorf("session not found"))
		return uuid.Nil, false
	}
	return id, true
}
func (a *App) captionRun(c *gin.Context) (speakerCaptionRun, bool) {
	sessionID, ok := a.captionSession(c)
	if !ok {
		return speakerCaptionRun{}, false
	}
	id, err := uuid.Parse(c.Param("runId"))
	if err != nil {
		writeError(c, 400, fmt.Errorf("invalid analysis id"))
		return speakerCaptionRun{}, false
	}
	r, err := scanSpeakerCaptionRun(a.DB.QueryRowContext(c, `SELECT `+captionRunColumns+` FROM transcription_speaker_caption_runs WHERE id=$1 AND session_id=$2`, id, sessionID))
	if err != nil {
		writeError(c, 404, fmt.Errorf("analysis not found"))
		return r, false
	}
	return r, true
}
func (a *App) latestSpeakerCaptionRun(c *gin.Context) {
	id, ok := a.captionSession(c)
	if !ok {
		return
	}
	r, err := scanSpeakerCaptionRun(a.DB.QueryRowContext(c, `SELECT `+captionRunColumns+` FROM transcription_speaker_caption_runs WHERE session_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, id))
	if err == sql.ErrNoRows {
		c.JSON(200, gin.H{"run": nil})
		return
	}
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, gin.H{"run": r})
}
func (a *App) getSpeakerCaptionRun(c *gin.Context) {
	if r, ok := a.captionRun(c); ok {
		c.JSON(200, gin.H{"run": r})
	}
}
func (a *App) cancelSpeakerCaptionRun(c *gin.Context) {
	r, ok := a.captionRun(c)
	if !ok {
		return
	}
	_, err := a.DB.ExecContext(c, `UPDATE transcription_speaker_caption_runs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('queued','processing')`, r.ID)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.Status(204)
}
func (a *App) speakerCaptionSource(ctx context.Context, uploadID uuid.UUID) (string, error) {
	record, err := loadVideoUploadRecord(ctx, a.DB, uploadID)
	if err != nil || !videoUploadHasCompleteObject(record.model) || (record.model.ExpiresAt != nil && !record.model.ExpiresAt.After(time.Now())) {
		return "", fmt.Errorf("source video is unavailable or expired")
	}
	storage, err := newS3Storage(a.Config)
	if err != nil {
		return "", fmt.Errorf("video storage is unavailable")
	}
	return storage.presignProcessingURL(http.MethodGet, record.storageKey, nil, videoProcessingURLLifetime), nil
}
func (a *App) speakerCaptionImage(c *gin.Context) {
	r, ok := a.captionRun(c)
	if !ok {
		return
	}
	index, err := strconv.Atoi(c.Param("frameIndex"))
	if err != nil || index < 0 || index >= len(r.Frames) || index >= len(r.Observations) {
		writeError(c, 404, fmt.Errorf("analyzed image not found"))
		return
	}
	url, err := a.speakerCaptionSource(c, r.UploadID)
	if err != nil {
		writeError(c, 410, err)
		return
	}
	data, err := extractSpeakerCaptionFrame(c, url, r.Frames[index].OffsetMs)
	if err != nil {
		writeError(c, 502, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(200, "image/jpeg", data)
}
func (a *App) createSpeakerCaptionRun(c *gin.Context) {
	id, ok := a.captionSession(c)
	if !ok {
		return
	}
	var request struct {
		EndpointID  uuid.UUID `json:"endpointId"`
		Model       string    `json:"model"`
		FrameBudget int       `json:"frameBudget"`
		AutoApply   bool      `json:"autoApply"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.FrameBudget == 0 {
		request.FrameBudget = 24
	}
	if request.FrameBudget < 1 || request.FrameBudget > captionMaxFrames || len(request.Model) > 200 {
		writeError(c, 400, fmt.Errorf("choose a frame budget between 1 and 48 and a valid model"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	org, _ := middleware.GetOrganizationID(c)
	metadata, err := a.getEndpoint(c, request.EndpointID)
	if err != nil {
		writeError(c, 404, fmt.Errorf("endpoint not found"))
		return
	}
	if err = a.canUseEndpoint(metadata, principal, org); err != nil {
		writeError(c, 403, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, request.EndpointID)
	if err != nil || !provider.SupportsVision(endpoint) {
		writeError(c, 400, fmt.Errorf("choose an enabled vision endpoint"))
		return
	}
	model := firstNonEmptyString(strings.TrimSpace(request.Model), endpoint.VisionModel, endpoint.ChatModel)
	if model == "" {
		writeError(c, 400, fmt.Errorf("a vision model is required"))
		return
	}
	upload, err := loadLatestVideoUpload(c, a.DB, id)
	if err != nil || upload == nil || upload.Status != "completed" {
		writeError(c, 400, fmt.Errorf("wait until video transcription and speaker assignment are complete"))
		return
	}
	if _, err = a.speakerCaptionSource(c, upload.ID); err != nil {
		writeError(c, 410, err)
		return
	}
	speakers, err := loadTranscriptionSpeakers(c, a.DB, id)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	segments, err := loadTranscriptionSegments(c, a.DB, id)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	frames := planSpeakerCaptionFrames(segments, speakers, request.FrameBudget)
	if len(frames) == 0 {
		writeError(c, 400, fmt.Errorf("no unnamed speakers with a clear speech turn of at least eight seconds are available"))
		return
	}
	encoded, _ := json.Marshal(frames)
	runID := uuid.New()
	result, err := a.DB.ExecContext(c, `INSERT INTO transcription_speaker_caption_runs (id,session_id,upload_id,endpoint_id,requested_by,organization_id,model,auto_apply,frame_budget,frames) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (session_id) WHERE status IN ('queued','processing') DO NOTHING`, runID, id, upload.ID, request.EndpointID, principal.UserID, org, model, request.AutoApply, request.FrameBudget, encoded)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		writeError(c, 409, fmt.Errorf("a name caption analysis is already running for this video"))
		return
	}
	r, err := scanSpeakerCaptionRun(a.DB.QueryRowContext(c, `SELECT `+captionRunColumns+` FROM transcription_speaker_caption_runs WHERE id=$1`, runID))
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(202, gin.H{"run": r})
}

// A database lease and advisory lock bound concurrency across replicas. Saved
// observations survive restarts; a token fences all progress and final writes.
func (a *App) claimSpeakerCaptionRun(ctx context.Context) (speakerCaptionRun, uuid.UUID, error) {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return speakerCaptionRun{}, uuid.Nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(735917602)`); err != nil {
		return speakerCaptionRun{}, uuid.Nil, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE transcription_speaker_caption_runs SET status='failed',error_message='Analysis interrupted repeatedly. Please start a new analysis.',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=3`)
	if err != nil {
		return speakerCaptionRun{}, uuid.Nil, err
	}
	token := uuid.New()
	r, err := scanSpeakerCaptionRun(tx.QueryRowContext(ctx, `UPDATE transcription_speaker_caption_runs SET status='processing',lease_token=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM transcription_speaker_caption_runs WHERE (status='queued' OR (status='processing' AND lease_until<now())) AND NOT EXISTS (SELECT 1 FROM transcription_speaker_caption_runs WHERE status='processing' AND lease_until>=now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING `+captionRunColumns, token))
	if err == sql.ErrNoRows {
		if commitErr := tx.Commit(); commitErr != nil {
			return r, token, commitErr
		}
		return r, token, err
	}
	if err != nil {
		return r, token, err
	}
	return r, token, tx.Commit()
}
func (a *App) startSpeakerCaptionWorker(ctx context.Context) {
	a.markWorkerStarted("speaker-captions")
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		busy := make(chan struct{}, 1)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.markWorkerHeartbeat("speaker-captions")
				select {
				case busy <- struct{}{}:
				default:
					continue
				}
				r, token, err := a.claimSpeakerCaptionRun(ctx)
				if err != nil {
					<-busy
					continue
				}
				go func() { defer func() { <-busy }(); a.processSpeakerCaptionRun(ctx, r, token) }()
			}
		}
	}()
}
func (a *App) processSpeakerCaptionRun(root context.Context, r speakerCaptionRun, token uuid.UUID) {
	ctx, cancel := context.WithTimeout(root, time.Duration(len(r.Frames))*65*time.Second+time.Minute)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				result, err := a.DB.ExecContext(ctx, `UPDATE transcription_speaker_caption_runs SET lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='processing'`, r.ID, token)
				if err != nil {
					cancel()
					return
				}
				n, _ := result.RowsAffected()
				if n != 1 {
					cancel()
					return
				}
			}
		}
	}()
	err := a.runSpeakerCaptionAnalysis(ctx, &r, token)
	if root.Err() != nil {
		return
	}
	if err != nil {
		failureCtx, stop := context.WithTimeout(root, 5*time.Second)
		defer stop()
		message := err.Error()
		if ctx.Err() != nil {
			message = "Analysis timed out or lost its worker lease. Please retry."
		}
		_, _ = a.DB.ExecContext(failureCtx, `UPDATE transcription_speaker_caption_runs SET status='failed',error_message=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='processing'`, r.ID, token, message)
	}
}
func (a *App) runSpeakerCaptionAnalysis(ctx context.Context, r *speakerCaptionRun, token uuid.UUID) error {
	if err := a.authorizeTranscriptionSession(ctx, r.SessionID, r.RequestedBy, r.OrganizationID); err != nil {
		return fmt.Errorf("session access is no longer available")
	}
	principal := middleware.Principal{UserID: r.RequestedBy}
	if err := a.DB.QueryRowContext(ctx, `SELECT is_platform_admin FROM users WHERE id=$1 AND status='active' AND EXISTS (SELECT 1 FROM organization_members WHERE user_id=$1 AND organization_id=$2)`, r.RequestedBy, r.OrganizationID).Scan(&principal.PlatformAdmin); err != nil {
		return fmt.Errorf("user or organization access is no longer available")
	}
	metadata, err := a.getEndpoint(ctx, r.EndpointID)
	if err != nil {
		return fmt.Errorf("vision endpoint is no longer available")
	}
	if err = a.canUseEndpoint(metadata, principal, r.OrganizationID); err != nil {
		return fmt.Errorf("vision endpoint access is no longer available")
	}
	endpoint, err := a.providerEndpoint(ctx, r.EndpointID)
	if err != nil || !provider.SupportsVision(endpoint) {
		return fmt.Errorf("vision endpoint is no longer available")
	}
	endpoint.ChatModel = r.Model
	endpoint.MaxOutputTokens = 512
	url, err := a.speakerCaptionSource(ctx, r.UploadID)
	if err != nil {
		return err
	}
	failures := 0
	for index := len(r.Observations); index < len(r.Frames); index++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		image, readErr := extractSpeakerCaptionFrame(ctx, url, r.Frames[index].OffsetMs)
		var observation speakerCaptionObservation
		if readErr == nil {
			observation, readErr = readSpeakerCaption(ctx, endpoint, image)
		}
		observation.FrameIndex = index
		if readErr != nil {
			observation.Error = readErr.Error()
			failures++
		} else {
			failures = 0
		}
		r.Observations = append(r.Observations, observation)
		encoded, _ := json.Marshal(r.Observations)
		result, err := a.DB.ExecContext(ctx, `UPDATE transcription_speaker_caption_runs SET observations=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='processing'`, r.ID, token, encoded)
		if err != nil {
			return fmt.Errorf("could not save analysis progress")
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return fmt.Errorf("analysis was cancelled")
		}
		if failures >= 3 {
			return fmt.Errorf("three consecutive images could not be analyzed; check source video and vision endpoint")
		}
	}
	successful := false
	for _, o := range r.Observations {
		if o.Error == "" {
			successful = true
		}
	}
	if !successful {
		return fmt.Errorf("no images could be analyzed; check source video and vision endpoint")
	}
	speakers, err := loadTranscriptionSpeakers(ctx, a.DB, r.SessionID)
	if err != nil {
		return fmt.Errorf("could not load speakers")
	}
	segments, err := loadTranscriptionSegments(ctx, a.DB, r.SessionID)
	if err != nil {
		return fmt.Errorf("could not load speech turns")
	}
	return a.finishSpeakerCaptionRun(ctx, r.ID, r.SessionID, token, resolveSpeakerCaptionResults(r.Frames, r.Observations, speakers, segments, r.AutoApply))
}
func (a *App) finishSpeakerCaptionRun(ctx context.Context, id, sessionID, token uuid.UUID, results []speakerCaptionResult) error {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("could not save caption results")
	}
	defer tx.Rollback()
	var active bool
	err = tx.QueryRowContext(ctx, `SELECT status='processing' AND lease_token=$2 AND lease_until>now() FROM transcription_speaker_caption_runs WHERE id=$1 FOR UPDATE`, id, token).Scan(&active)
	if err != nil || !active {
		return fmt.Errorf("analysis lease is no longer active")
	}
	for i := range results {
		r := &results[i]
		query := `UPDATE transcription_speakers SET suggested_name=$3,suggestion_confidence=$4,suggestion_evidence=$5,updated_at=now() WHERE id=$1 AND session_id=$2 AND merged_into IS NULL AND (display_name='' OR name_source='ai')`
		if r.Applied {
			query = `UPDATE transcription_speakers SET display_name=$3,name_source='ai',suggested_name='',suggestion_confidence=$4,suggestion_evidence=$5,updated_at=now() WHERE id=$1 AND session_id=$2 AND merged_into IS NULL AND (display_name='' OR name_source='ai')`
		}
		result, err := tx.ExecContext(ctx, query, r.SpeakerID, sessionID, r.Name, r.Confidence, r.Evidence)
		if err != nil {
			return fmt.Errorf("could not save speaker names")
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			r.Applied = false
		}
	}
	encoded, _ := json.Marshal(results)
	if results == nil {
		encoded = []byte("[]")
	}
	_, err = tx.ExecContext(ctx, `UPDATE transcription_speaker_caption_runs SET status='completed',results=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`, id, token, encoded)
	if err != nil {
		return fmt.Errorf("could not complete analysis")
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("could not complete analysis")
	}
	if a.Live != nil {
		for _, r := range results {
			if r.Applied {
				a.Live.broadcast(sessionID, "transcription.speaker", ginData{"speakerId": r.SpeakerID, "displayName": r.Name})
			}
		}
	}
	return nil
}
