package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type videoCaptionOptions struct {
	EndpointID  uuid.UUID `json:"endpointId"`
	Model       string    `json:"model"`
	FrameBudget int       `json:"frameBudget"`
	AutoApply   bool      `json:"autoApply"`
}

func (a *App) validateVideoCaptionOptions(ctx context.Context, options *videoCaptionOptions, principal middleware.Principal, org, session uuid.UUID) error {
	if options == nil {
		return nil
	}
	if options.FrameBudget == 0 {
		options.FrameBudget = 24
	}
	if options.FrameBudget < 1 || options.FrameBudget > captionMaxFrames || len(options.Model) > 200 {
		return fmt.Errorf("choose a caption image budget between 1 and 48 and a valid model")
	}
	metadata, err := a.getEndpoint(ctx, options.EndpointID)
	if err != nil {
		return fmt.Errorf("vision endpoint not found")
	}
	if err = a.canUseEndpoint(metadata, principal, org); err != nil {
		return err
	}
	endpoint, err := a.providerEndpoint(ctx, options.EndpointID)
	if err != nil || !provider.SupportsVision(endpoint) {
		return fmt.Errorf("choose an enabled vision endpoint for speaker names")
	}
	options.Model = firstNonEmptyString(options.Model, endpoint.VisionModel, endpoint.ChatModel)
	if options.Model == "" {
		return fmt.Errorf("a caption vision model is required")
	}
	var enabled bool
	if err = a.DB.QueryRowContext(ctx, `SELECT diarization_endpoint_id IS NOT NULL FROM transcription_sessions WHERE id=$1`, session).Scan(&enabled); err != nil {
		return err
	}
	if !enabled {
		return fmt.Errorf("enable speaker separation before reading speaker name captions")
	}
	return nil
}

// Link the durable caption job before waiting, so a restarted video worker
// resumes the same analysis without charging for already completed images.
func (m *TranscriptionManager) processVideoCaptionStep(ctx context.Context, uploadID, sessionID uuid.UUID) error {
	var raw []byte
	var linked uuid.NullUUID
	if err := m.DB.QueryRowContext(ctx, `SELECT caption_options,caption_run_id FROM transcription_video_uploads WHERE id=$1`, uploadID).Scan(&raw, &linked); err != nil {
		return err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var options videoCaptionOptions
	if err := json.Unmarshal(raw, &options); err != nil {
		return fmt.Errorf("invalid saved caption analysis settings")
	}
	if m.app == nil {
		return fmt.Errorf("caption analysis worker is unavailable")
	}
	if err := m.updateVideoProgress(ctx, uploadID, 93, "naming_speakers", ""); err != nil {
		return err
	}
	if !linked.Valid {
		speakers, err := loadTranscriptionSpeakers(ctx, m.DB, sessionID)
		if err != nil {
			return err
		}
		segments, err := loadTranscriptionSegments(ctx, m.DB, sessionID)
		if err != nil {
			return err
		}
		frames := planSpeakerCaptionFrames(segments, speakers, options.FrameBudget)
		if len(frames) == 0 {
			return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) []models.TranscriptionVideoPipelineStep {
				skipVideoPipelineStep(&steps[videoPipelineIndex("speaker_names")])
				return steps
			})
		}
		encoded, _ := json.Marshal(frames)
		tx, err := m.DB.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		var status string
		if err = tx.QueryRowContext(ctx, `SELECT caption_run_id,status FROM transcription_video_uploads WHERE id=$1 FOR UPDATE`, uploadID).Scan(&linked, &status); err != nil {
			return err
		}
		if status == "cancelled" {
			return errVideoTranscriptionCancelled
		}
		if !linked.Valid {
			id := uuid.New()
			_, err = tx.ExecContext(ctx, `INSERT INTO transcription_speaker_caption_runs(id,session_id,upload_id,endpoint_id,requested_by,organization_id,model,auto_apply,frame_budget,frames) SELECT $1,id,$3,$4,user_id,organization_id,$5,$6,$7,$8 FROM transcription_sessions WHERE id=$2`, id, sessionID, uploadID, options.EndpointID, options.Model, options.AutoApply, options.FrameBudget, encoded)
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `UPDATE transcription_video_uploads SET caption_run_id=$2 WHERE id=$1`, uploadID, id); err != nil {
				return err
			}
			linked = uuid.NullUUID{UUID: id, Valid: true}
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
			return err
		}
		run, err := scanSpeakerCaptionRun(m.DB.QueryRowContext(ctx, `SELECT `+captionRunColumns+` FROM transcription_speaker_caption_runs WHERE id=$1 AND upload_id=$2`, linked.UUID, uploadID))
		if err != nil {
			return err
		}
		if err = m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) []models.TranscriptionVideoPipelineStep {
			step := &steps[videoPipelineIndex("speaker_names")]
			step.Parallel = &models.TranscriptionVideoParallelProgress{Strategy: "speaker-captions", Phase: run.Status, SliceCount: len(run.Frames), CompletedSlices: len(run.Observations)}
			if run.Status == "completed" {
				markVideoPipelineStep(steps, "speaker_names", "completed", "", time.Now().UTC())
			}
			return steps
		}); err != nil {
			return err
		}
		switch run.Status {
		case "completed":
			return nil
		case "failed", "cancelled":
			return fmt.Errorf("speaker name captions: %s", firstNonEmptyString(run.ErrorMessage, "analysis was cancelled; retry speaker names to continue"))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Restarting an earlier stage invalidates old speaker labels. Retrying names
// creates a fresh job, while pod restarts inside the names stage keep its link.
func resetVideoCaptionRun(ctx context.Context, tx *sql.Tx, uploadID uuid.UUID) error {
	if _, err := tx.ExecContext(ctx, `UPDATE transcription_speaker_caption_runs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE upload_id=$1 AND status IN ('queued','processing')`, uploadID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE transcription_video_uploads SET caption_run_id=NULL WHERE id=$1`, uploadID)
	return err
}
