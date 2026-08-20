package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
)

const videoTranscriptionJobType = "video_transcription"

const (
	videoProcessingURLLifetime   = 24 * time.Hour
	videoJobLeaseDuration        = 10 * time.Minute
	videoJobLeaseRenewInterval   = 30 * time.Second
	videoRealtimeSessionDuration = 45 * time.Minute
)

var errVideoTranscriptionCancelled = errors.New("video transcription was cancelled")
var errVideoTranscriptionPermanent = errors.New("permanent video transcription error")

type videoUploadRecord struct {
	model         models.TranscriptionVideoUpload
	storageDriver string
	storageKey    string
	multipartID   string
}

type videoAudioChunk struct {
	index         int
	offsetBytes   int64
	lengthBytes   int64
	startOffsetMs int64
	endOffsetMs   int64
}

type videoTranscriptionEvent struct {
	chunkIndex    int
	sequence      int
	startOffsetMs int64
	endOffsetMs   int64
	text          string
	rawText       string
}

type videoChunkStreamResult struct {
	events []videoTranscriptionEvent
	err    error
}

type videoJobPayload struct {
	UploadID  string `json:"uploadId"`
	RetryFrom string `json:"retryFrom,omitempty"`
}

const (
	videoRetryStepTranscription = "transcription"
	videoRetryStepDiarization   = "diarization"
	videoRetryStepGrammar       = "grammar"
	videoRetryStepFinalization  = "finalization"
)

func normalizeVideoRetryStep(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case videoRetryStepTranscription:
		return videoRetryStepTranscription
	case videoRetryStepDiarization:
		return videoRetryStepDiarization
	case videoRetryStepGrammar:
		return videoRetryStepGrammar
	case videoRetryStepFinalization:
		return videoRetryStepFinalization
	default:
		return ""
	}
}

func videoRetryStage(retryFrom string) string {
	switch normalizeVideoRetryStep(retryFrom) {
	case videoRetryStepDiarization:
		return "diarizing"
	case videoRetryStepGrammar:
		return "polishing"
	case videoRetryStepFinalization:
		return "finalizing"
	default:
		return "starting"
	}
}

func (m *TranscriptionManager) startVideoWorker(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := m.processVideoJob(ctx); err != nil && !errors.Is(err, errVideoTranscriptionCancelled) && ctx.Err() == nil {
					slog.Warn("video transcription job failed", "error", err)
				}
			}
		}
	}()
}

func (m *TranscriptionManager) processVideoJob(ctx context.Context) error {
	transaction, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	_, _ = transaction.ExecContext(ctx, `
		UPDATE transcription_jobs
		SET status = 'queued', lease_until = NULL, run_after = now(), updated_at = now()
		WHERE job_type = $1 AND status = 'processing' AND (lease_until IS NULL OR lease_until < now())`, videoTranscriptionJobType)

	var jobID, sessionID uuid.UUID
	var uploadIDValue string
	var payload []byte
	var attempts, maxAttempts int
	err = transaction.QueryRowContext(ctx, `
		SELECT j.id, j.session_id, j.payload, j.attempts, j.max_attempts,
		       j.payload->>'uploadId'
		FROM transcription_jobs j
		WHERE j.job_type = $1 AND j.status = 'queued' AND j.run_after <= now()
		ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1`, videoTranscriptionJobType).Scan(&jobID, &sessionID, &payload, &attempts, &maxAttempts, &uploadIDValue)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	uploadID, parseErr := uuid.Parse(uploadIDValue)
	if parseErr != nil {
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'failed', error_message = 'invalid video transcription job upload id', updated_at = now() WHERE id = $1`, jobID)
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1 AND status = 'processing'`, sessionID)
		if err := transaction.Commit(); err != nil {
			return err
		}
		m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
		return nil
	}
	if attempts >= maxAttempts {
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'failed', lease_until = NULL, error_message = 'maximum retry attempts exceeded', updated_at = now() WHERE id = $1`, jobID)
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'failed', stage = 'failed', error_message = 'maximum retry attempts exceeded', updated_at = now() WHERE id = $1`, uploadID)
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1 AND status = 'processing'`, sessionID)
		if err := transaction.Commit(); err != nil {
			return err
		}
		if err := m.failVideoPipeline(ctx, uploadID, "maximum retry attempts exceeded"); err != nil {
			slog.Warn("could not persist video pipeline failure", "uploadId", uploadID, "error", err)
		}
		m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
		m.broadcastVideoProgress(uploadID, "failed", 0, "failed", "maximum retry attempts exceeded")
		return nil
	}
	var uploadStatus string
	if err := transaction.QueryRowContext(ctx, `SELECT status FROM transcription_video_uploads WHERE id = $1 FOR UPDATE`, uploadID).Scan(&uploadStatus); err != nil {
		return err
	}
	if uploadStatus == "cancelled" {
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', updated_at = now() WHERE id = $1`, jobID)
		return transaction.Commit()
	}
	if uploadStatus == "completed" {
		_, _ = transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'completed', updated_at = now() WHERE id = $1`, jobID)
		return transaction.Commit()
	}
	var parsed videoJobPayload
	payloadErr := json.Unmarshal(payload, &parsed)
	retryFrom := normalizeVideoRetryStep(parsed.RetryFrom)
	if payloadErr == nil && parsed.UploadID == "" {
		payloadErr = fmt.Errorf("invalid video transcription job payload")
	}
	if payloadErr == nil && parsed.UploadID != uploadID.String() {
		payloadErr = fmt.Errorf("video transcription job payload does not match upload")
	}
	if payloadErr == nil && strings.TrimSpace(parsed.RetryFrom) != "" && retryFrom == "" {
		payloadErr = fmt.Errorf("unsupported video retry step %q", parsed.RetryFrom)
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'processing', attempts = attempts + 1, lease_until = now() + $2 * interval '1 second', updated_at = now() WHERE id = $1`, jobID, int64(videoJobLeaseDuration/time.Second)); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'processing', stage = $2, error_message = NULL, updated_at = now() WHERE id = $1`, uploadID, videoRetryStage(retryFrom)); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return err
	}
	if err := m.advanceVideoPipeline(ctx, uploadID, videoRetryStage(retryFrom), ""); err != nil {
		slog.Warn("could not persist video pipeline start", "uploadId", uploadID, "error", err)
	}
	if payloadErr != nil {
		return m.finishVideoJob(ctx, jobID, uploadID, fmt.Errorf("%w: %v", errVideoTranscriptionPermanent, payloadErr))
	}
	processingErr := m.transcribeVideo(ctx, jobID, uploadID, retryFrom)
	return m.finishVideoJob(ctx, jobID, uploadID, processingErr)
}

func (m *TranscriptionManager) finishVideoJob(ctx context.Context, jobID, uploadID uuid.UUID, processingErr error) error {
	var uploadStatus string
	var sessionID uuid.UUID
	if err := m.DB.QueryRowContext(ctx, `SELECT status, session_id FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&uploadStatus, &sessionID); err == nil && uploadStatus == "cancelled" {
		if err := m.cancelVideoPipeline(ctx, uploadID); err != nil {
			slog.Warn("could not persist cancelled video pipeline", "uploadId", uploadID, "error", err)
		}
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', lease_until = NULL, error_message = NULL, updated_at = now() WHERE id = $1`, jobID)
		return errVideoTranscriptionCancelled
	}
	if processingErr == nil {
		_, err := m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'completed', lease_until = NULL, error_message = NULL, updated_at = now() WHERE id = $1`, jobID)
		if err != nil {
			return err
		}
		result, err := m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'completed', progress = 100, stage = 'completed', error_message = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1 AND status <> 'cancelled'`, uploadID)
		if err != nil {
			return err
		}
		if affected, err := result.RowsAffected(); err != nil {
			return err
		} else if affected != 1 {
			_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', lease_until = NULL, error_message = NULL, updated_at = now() WHERE id = $1`, jobID)
			return errVideoTranscriptionCancelled
		}
		if err := m.completeVideoPipeline(ctx, uploadID); err != nil {
			slog.Warn("could not persist completed video pipeline", "uploadId", uploadID, "error", err)
		}
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'completed', ended_at = COALESCE(ended_at, now()), join_code_hash = NULL, join_code_expires_at = NULL, updated_at = now() WHERE id = $1`, sessionID)
		m.broadcast(sessionID, "transcription.session", ginData{"status": "completed"})
		m.broadcastVideoProgress(uploadID, "completed", 100, "completed", "")
		return nil
	}
	if errors.Is(processingErr, errVideoTranscriptionCancelled) {
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', lease_until = NULL, error_message = NULL, updated_at = now() WHERE id = $1`, jobID)
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'cancelled', stage = 'cancelled', error_message = NULL, updated_at = now() WHERE id = $1`, uploadID)
		if err := m.cancelVideoPipeline(ctx, uploadID); err != nil {
			slog.Warn("could not persist cancelled video pipeline", "uploadId", uploadID, "error", err)
		}
		m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
		m.broadcastVideoProgress(uploadID, "cancelled", 0, "cancelled", "")
		return processingErr
	}
	if ctx.Err() != nil {
		return processingErr
	}
	var attempts, maxAttempts int
	if errors.Is(processingErr, errVideoTranscriptionPermanent) {
		attempts = 1
		maxAttempts = 1
	} else if err := m.DB.QueryRowContext(ctx, `SELECT attempts, max_attempts FROM transcription_jobs WHERE id = $1`, jobID).Scan(&attempts, &maxAttempts); err != nil {
		return err
	}
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	if attempts < maxAttempts {
		delay := time.Duration(attempts*10) * time.Second
		retryFrom := m.videoRetryStepFromStoredPipeline(ctx, uploadID)
		switch retryFrom {
		case videoRetryStepTranscription:
			// A transcription attempt can have left partial or overlapping rows.
			// Rebuild that stage, but leave later-stage data untouched until the
			// stage is reached again.
			_, _ = m.DB.ExecContext(ctx, `DELETE FROM transcription_segments WHERE session_id = $1 AND source_id IS NULL`, sessionID)
			_, _ = m.DB.ExecContext(ctx, `DELETE FROM transcription_speakers WHERE session_id = $1`, sessionID)
		case videoRetryStepDiarization:
			// The transcript is already valid; only speaker assignments need to be
			// recomputed.
			_, _ = m.DB.ExecContext(ctx, `DELETE FROM transcription_speakers WHERE session_id = $1`, sessionID)
		case videoRetryStepGrammar:
			// Keep the verbatim transcript and speakers, but do not reuse a partial
			// polished result from the failed attempt.
			_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_segments SET polished_text = NULL, updated_at = now() WHERE session_id = $1 AND source_id IS NULL`, sessionID)
		}
		retryPayload, _ := json.Marshal(videoJobPayload{UploadID: uploadID.String(), RetryFrom: retryFrom})
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET payload = $2, status = 'queued', lease_until = NULL, run_after = now() + $3 * interval '1 second', error_message = $4, updated_at = now() WHERE id = $1`, jobID, retryPayload, int64(delay/time.Second), processingErr.Error())
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'queued', stage = 'retrying', error_message = $2, updated_at = now() WHERE id = $1`, uploadID, processingErr.Error())
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'processing', polish_status = CASE WHEN $2 = 'transcription' THEN CASE WHEN grammar_endpoint_id IS NULL THEN 'not_requested' ELSE 'queued' END WHEN $2 = 'grammar' THEN 'queued' ELSE polish_status END, ended_at = NULL, updated_at = now() WHERE id = $1`, sessionID, retryFrom)
		if err := m.retryVideoPipelineFrom(ctx, uploadID, retryFrom, processingErr.Error()); err != nil {
			slog.Warn("could not persist retrying video pipeline", "uploadId", uploadID, "error", err)
		}
		m.broadcast(sessionID, "transcription.session", ginData{"status": "processing"})
		m.broadcastVideoProgress(uploadID, "queued", 0, "retrying", processingErr.Error())
		return processingErr
	}
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'failed', lease_until = NULL, error_message = $2, updated_at = now() WHERE id = $1`, jobID, processingErr.Error())
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'failed', stage = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, uploadID, processingErr.Error())
	if err := m.failVideoPipeline(ctx, uploadID, processingErr.Error()); err != nil {
		slog.Warn("could not persist failed video pipeline", "uploadId", uploadID, "error", err)
	}
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1`, sessionID)
	m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
	m.broadcastVideoProgress(uploadID, "failed", 0, "failed", processingErr.Error())
	return processingErr
}

func (m *TranscriptionManager) videoRetryStepFromStoredPipeline(ctx context.Context, uploadID uuid.UUID) string {
	var raw []byte
	if err := m.DB.QueryRowContext(ctx, `SELECT pipeline_steps FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&raw); err != nil {
		return videoRetryStepTranscription
	}
	return videoRetryStepForPipeline(decodeVideoPipeline(raw))
}

func (m *TranscriptionManager) queueVideoTranscription(ctx context.Context, uploadID uuid.UUID) (uuid.UUID, models.TranscriptionVideoUpload, error) {
	transaction, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	defer transaction.Rollback()
	var sessionID uuid.UUID
	var status string
	if err := transaction.QueryRowContext(ctx, `SELECT session_id, status FROM transcription_video_uploads WHERE id = $1 FOR UPDATE`, uploadID).Scan(&sessionID, &status); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if status == "queued" || status == "processing" || status == "completed" {
		var jobID uuid.UUID
		_ = transaction.QueryRowContext(ctx, `SELECT id FROM transcription_jobs WHERE job_type = $1 AND payload->>'uploadId' = $2 ORDER BY created_at DESC LIMIT 1`, videoTranscriptionJobType, uploadID.String()).Scan(&jobID)
		if err := transaction.Commit(); err != nil {
			return uuid.Nil, models.TranscriptionVideoUpload{}, err
		}
		upload, err := loadVideoUpload(ctx, m.DB, uploadID)
		return jobID, upload, err
	}
	if status != "uploading" && status != "uploaded" {
		return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("video upload is %s", status)
	}
	payload, _ := json.Marshal(videoJobPayload{UploadID: uploadID.String()})
	jobID := uuid.New()
	if _, err := transaction.ExecContext(ctx, `INSERT INTO transcription_jobs (id, session_id, job_type, payload) VALUES ($1, $2, $3, $4)`, jobID, sessionID, videoTranscriptionJobType, payload); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'queued', progress = 0, stage = 'queued', bytes = expected_bytes, error_message = NULL, updated_at = now() WHERE id = $1`, uploadID); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'processing', polish_status = CASE WHEN grammar_endpoint_id IS NULL THEN 'not_requested' ELSE 'queued' END, started_at = COALESCE(started_at, now()), ended_at = NULL, join_code_hash = NULL, join_code_expires_at = NULL, updated_at = now() WHERE id = $1`, sessionID); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if err := m.advanceVideoPipeline(ctx, uploadID, "queued", ""); err != nil {
		slog.Warn("could not persist queued video pipeline", "uploadId", uploadID, "error", err)
	}
	m.broadcast(sessionID, "transcription.session", ginData{"status": "processing"})
	upload, err := loadVideoUpload(ctx, m.DB, uploadID)
	return jobID, upload, err
}

func (m *TranscriptionManager) retryVideoJob(ctx context.Context, uploadID uuid.UUID, requestedStep string) (uuid.UUID, models.TranscriptionVideoUpload, error) {
	explicitStep := strings.TrimSpace(requestedStep) != ""
	retryFrom := normalizeVideoRetryStep(requestedStep)
	if explicitStep && retryFrom == "" {
		return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("unsupported video retry step %q", requestedStep)
	}
	if retryFrom == "" {
		retryFrom = m.videoRetryStepFromStoredPipeline(ctx, uploadID)
		if retryFrom == "" {
			retryFrom = videoRetryStepTranscription
		}
	}

	transaction, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	defer transaction.Rollback()
	var sessionID uuid.UUID
	var status string
	var expectedBytes, bytesUploaded int64
	if err := transaction.QueryRowContext(ctx, `SELECT session_id, status, expected_bytes, bytes FROM transcription_video_uploads WHERE id = $1 FOR UPDATE`, uploadID).Scan(&sessionID, &status, &expectedBytes, &bytesUploaded); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	var diarizationEndpoint, grammarEndpoint uuid.NullUUID
	var transcriptCount int64
	if err := transaction.QueryRowContext(ctx, `
		SELECT diarization_endpoint_id, grammar_endpoint_id,
		       (SELECT COUNT(*) FROM transcription_segments WHERE session_id = $1 AND source_id IS NULL AND canonical = TRUE)
		FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&diarizationEndpoint, &grammarEndpoint, &transcriptCount); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	sourceReady := expectedBytes > 0 && bytesUploaded >= expectedBytes
	if retryFrom == videoRetryStepTranscription {
		if explicitStep && !sourceReady {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("transcription can only be retried after the video upload has finished")
		}
		if status != "failed" && !(status == "cancelled" && sourceReady) {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("only failed video uploads or completed cancelled uploads can be retried")
		}
	} else {
		if !sourceReady {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("processing steps can only be retried after the video upload has finished")
		}
		if status != "failed" && status != "cancelled" && status != "completed" {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("video processing is currently %s", status)
		}
		if retryFrom == videoRetryStepDiarization && !diarizationEndpoint.Valid {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("speaker separation is not configured for this video")
		}
		if retryFrom == videoRetryStepGrammar && !grammarEndpoint.Valid {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("grammar polish is not configured for this video")
		}
		if transcriptCount == 0 {
			return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("%s cannot be retried before a transcript exists", retryFrom)
		}
	}

	switch retryFrom {
	case videoRetryStepTranscription:
		if _, err := transaction.ExecContext(ctx, `DELETE FROM transcription_segments WHERE session_id = $1 AND source_id IS NULL`, sessionID); err != nil {
			return uuid.Nil, models.TranscriptionVideoUpload{}, err
		}
		if _, err := transaction.ExecContext(ctx, `DELETE FROM transcription_speakers WHERE session_id = $1`, sessionID); err != nil {
			return uuid.Nil, models.TranscriptionVideoUpload{}, err
		}
	case videoRetryStepDiarization:
		if _, err := transaction.ExecContext(ctx, `DELETE FROM transcription_speakers WHERE session_id = $1`, sessionID); err != nil {
			return uuid.Nil, models.TranscriptionVideoUpload{}, err
		}
		if _, err := transaction.ExecContext(ctx, `UPDATE transcription_segments SET polished_text = NULL, updated_at = now() WHERE session_id = $1 AND source_id IS NULL`, sessionID); err != nil {
			return uuid.Nil, models.TranscriptionVideoUpload{}, err
		}
	case videoRetryStepGrammar:
		if _, err := transaction.ExecContext(ctx, `UPDATE transcription_segments SET polished_text = NULL, updated_at = now() WHERE session_id = $1 AND source_id IS NULL`, sessionID); err != nil {
			return uuid.Nil, models.TranscriptionVideoUpload{}, err
		}
	}

	payload, _ := json.Marshal(videoJobPayload{UploadID: uploadID.String(), RetryFrom: retryFrom})
	jobID := uuid.New()
	if _, err := transaction.ExecContext(ctx, `INSERT INTO transcription_jobs (id, session_id, job_type, payload) VALUES ($1, $2, $3, $4)`, jobID, sessionID, videoTranscriptionJobType, payload); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'queued', progress = 0, stage = 'queued', duration_ms = CASE WHEN $2 = 'transcription' THEN 0 ELSE duration_ms END, error_message = NULL, updated_at = now() WHERE id = $1`, uploadID, retryFrom); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'processing', polish_status = CASE WHEN $2 = 'transcription' THEN CASE WHEN grammar_endpoint_id IS NULL THEN 'not_requested' ELSE 'queued' END WHEN $2 IN ('diarization', 'grammar') THEN CASE WHEN grammar_endpoint_id IS NULL THEN polish_status ELSE 'queued' END ELSE polish_status END, started_at = COALESCE(started_at, now()), ended_at = NULL, updated_at = now() WHERE id = $1`, sessionID, retryFrom); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if err := m.retryVideoPipelineFrom(ctx, uploadID, retryFrom, ""); err != nil {
		slog.Warn("could not persist manually retried video pipeline", "uploadId", uploadID, "error", err)
	}
	m.broadcast(sessionID, "transcription.session", ginData{"status": "processing"})
	upload, err := loadVideoUpload(ctx, m.DB, uploadID)
	return jobID, upload, err
}

func (m *TranscriptionManager) cancelVideoJob(ctx context.Context, uploadID uuid.UUID) error {
	transaction, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var sessionID uuid.UUID
	var status, stage string
	if err := transaction.QueryRowContext(ctx, `SELECT session_id, status, stage FROM transcription_video_uploads WHERE id = $1 FOR UPDATE`, uploadID).Scan(&sessionID, &status, &stage); err != nil {
		return err
	}
	if status == "completed" || status == "cancelled" {
		return transaction.Commit()
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'cancelled', stage = 'cancelled', error_message = NULL, updated_at = now() WHERE id = $1`, uploadID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', lease_until = NULL, updated_at = now() WHERE job_type = $1 AND payload->>'uploadId' = $2 AND status IN ('queued', 'processing')`, videoTranscriptionJobType, uploadID.String()); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1 AND status = 'processing'`, sessionID); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return err
	}
	if err := m.cancelVideoPipelineAtStage(ctx, uploadID, stage); err != nil {
		slog.Warn("could not persist cancelled video pipeline", "uploadId", uploadID, "error", err)
	}
	m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
	m.broadcastVideoProgress(uploadID, "cancelled", 0, "cancelled", "")
	return nil
}

func (m *TranscriptionManager) transcribeVideo(ctx context.Context, jobID, uploadID uuid.UUID, retryFrom string) error {
	jobCtx, cancelJob := m.videoJobContext(ctx, jobID)
	defer cancelJob()
	retryFrom = normalizeVideoRetryStep(retryFrom)
	if retryFrom == "" {
		retryFrom = videoRetryStepTranscription
	}
	if retryFrom == videoRetryStepFinalization {
		return m.updateVideoProgress(jobCtx, uploadID, 99, "finalizing", "")
	}
	record, err := loadVideoUploadRecord(jobCtx, m.DB, uploadID)
	if err != nil {
		return err
	}
	if record.storageDriver != "s3" {
		return fmt.Errorf("%w: video upload storage driver %q is not supported", errVideoTranscriptionPermanent, record.storageDriver)
	}
	var sessionEndpoint uuid.UUID
	var diarizationEndpoint, grammarEndpoint uuid.NullUUID
	var language string
	if err := m.DB.QueryRowContext(jobCtx, `SELECT transcription_endpoint_id, diarization_endpoint_id, grammar_endpoint_id, language FROM transcription_sessions WHERE id = $1`, record.model.SessionID).Scan(&sessionEndpoint, &diarizationEndpoint, &grammarEndpoint, &language); err != nil {
		return err
	}
	shouldTranscribe := retryFrom == videoRetryStepTranscription
	shouldDiarize := diarizationEndpoint.Valid &&
		(retryFrom == videoRetryStepTranscription || retryFrom == videoRetryStepDiarization)
	shouldPolish := grammarEndpoint.Valid &&
		(retryFrom == videoRetryStepTranscription || retryFrom == videoRetryStepDiarization || retryFrom == videoRetryStepGrammar)
	if m.app == nil && (shouldTranscribe || shouldDiarize || shouldPolish) {
		return fmt.Errorf("%w: transcription manager is not attached to the app", errVideoTranscriptionPermanent)
	}
	var endpoint provider.Endpoint
	var mode string
	if shouldTranscribe {
		endpoint, err = m.app.providerEndpoint(jobCtx, sessionEndpoint)
		if err != nil {
			return err
		}
		mode = transcriptionMode(endpoint)
		if mode == "" {
			return fmt.Errorf("%w: provider %s does not support a compatible transcription transport", errVideoTranscriptionPermanent, endpoint.ProviderType)
		}
	}
	var storage *s3Storage
	needsMedia := shouldTranscribe || retryFrom == videoRetryStepDiarization
	if needsMedia {
		storage, err = newS3Storage(m.Config)
		if err != nil {
			return err
		}
	}
	var durationMs int64 = record.model.DurationMs
	var videoURL string
	if needsMedia {
		// Keep the media seekable. Piping a large MP4 through one S3 response can
		// make ffmpeg lose the input when it needs to seek or when realtime
		// transcription applies backpressure to the decoder.
		videoURL = storage.presignURL(http.MethodGet, record.storageKey, nil, videoProcessingURLLifetime)
		duration, probeErr := probeVideoDuration(jobCtx, videoURL)
		if probeErr != nil {
			return probeErr
		}
		maxDuration := time.Duration(m.Config.Transcription.VideoMaxDurationHours) * time.Hour
		if maxDuration > 0 && time.Duration(duration*float64(time.Second)) > maxDuration {
			return fmt.Errorf("%w: video duration exceeds the %d-hour limit", errVideoTranscriptionPermanent, m.Config.Transcription.VideoMaxDurationHours)
		}
		durationMs = int64(duration * 1000)
		if _, err := m.DB.ExecContext(jobCtx, `UPDATE transcription_video_uploads SET duration_ms = $2, updated_at = now() WHERE id = $1`, uploadID, durationMs); err != nil {
			return err
		}
	}
	if shouldTranscribe {
		if err := m.updateVideoProgress(jobCtx, uploadID, 1, "extracting", ""); err != nil {
			return err
		}
		if err := m.transcribeVideoAudio(jobCtx, uploadID, record.model.SessionID, endpoint, mode, language, videoURL, durationMs); err != nil {
			return err
		}
	}
	if shouldDiarize {
		if err := m.updateVideoProgress(jobCtx, uploadID, 86, "diarizing", ""); err != nil {
			return err
		}
		if err := m.diarizeVideoAudio(jobCtx, uploadID, record.model.SessionID, record.storageKey, diarizationEndpoint.UUID, language, durationMs, storage); err != nil {
			if errors.Is(err, errVideoTranscriptionCancelled) || jobCtx.Err() != nil {
				return err
			}
			message := fmt.Errorf("speaker diarization failed: %w", err)
			m.broadcast(record.model.SessionID, "transcription.diarization-error", ginData{
				"message": message.Error(),
				"fatal":   true,
			})
			return message
		}
	}
	if shouldPolish {
		if err := m.updateVideoProgress(jobCtx, uploadID, 95, "polishing", ""); err != nil {
			return err
		}
		if err := m.polishVideoTranscript(jobCtx, uploadID, record.model.SessionID, grammarEndpoint.UUID); err != nil {
			if errors.Is(err, errVideoTranscriptionCancelled) || jobCtx.Err() != nil {
				return err
			}
			m.broadcast(record.model.SessionID, "transcription.polish-error", ginData{"message": err.Error()})
			return err
		}
	}
	if err := m.updateVideoProgress(jobCtx, uploadID, 99, "finalizing", ""); err != nil {
		return err
	}
	return nil
}

func (m *TranscriptionManager) transcribeVideoAudio(ctx context.Context, uploadID, sessionID uuid.UUID, endpoint provider.Endpoint, mode, language, videoURL string, durationMs int64) error {
	chunkMs := m.Config.Transcription.VideoTranscriptionChunkMs
	workers := m.Config.Transcription.VideoTranscriptionWorkers
	if chunkMs <= 0 {
		chunkMs = 10 * 60 * 1000
	}
	if workers <= 0 {
		workers = 3
	}
	if durationMs > int64(chunkMs) && workers > 1 {
		return m.transcribeVideoAudioParallel(ctx, uploadID, sessionID, endpoint, mode, language, videoURL, durationMs, chunkMs, m.Config.Transcription.VideoTranscriptionOverlapMs, workers)
	}
	return m.transcribeVideoAudioSequential(ctx, uploadID, sessionID, endpoint, mode, language, videoURL, durationMs)
}

func (m *TranscriptionManager) transcribeVideoAudioSequential(ctx context.Context, uploadID, sessionID uuid.UUID, endpoint provider.Endpoint, mode, language, videoURL string, durationMs int64) error {
	processCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := m.openVideoTranscriptionStream(processCtx, endpoint, mode, language)
	if err != nil {
		return err
	}

	var processedPCM atomic.Int64
	providerEvents := m.consumeVideoTranscriptionEvents(processCtx, stream, sessionID, &processedPCM, cancel)
	defer func() {
		if stream == nil || providerEvents == nil {
			return
		}
		cancel()
		stream.Close()
		<-providerEvents
	}()

	ffmpeg := exec.CommandContext(processCtx, "ffmpeg", ffmpegVideoAudioArgs(videoURL)...)
	var stderr bytes.Buffer
	ffmpeg.Stderr = &stderr
	stdout, err := ffmpeg.StdoutPipe()
	if err != nil {
		return err
	}
	if err := ffmpeg.Start(); err != nil {
		return fmt.Errorf("start ffmpeg: %w", err)
	}
	buffer := make([]byte, 64*1024)
	lastProgress := time.Now()
	lastStatusCheck := time.Now()
	audioStartedAt := time.Now()
	nextRealtimeSessionAt := int64(videoRealtimeSessionDuration / time.Millisecond)
	for {
		read, readErr := stdout.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			processed := int64(len(chunk)) * 1000 / (16000 * 2)
			processedPCM.Add(processed)
			if err := stream.SendPCM(processCtx, chunk, 16000); err != nil {
				cancel()
				_ = ffmpeg.Wait()
				return err
			}
			if mode == "realtime" {
				target := audioStartedAt.Add(time.Duration(processedPCM.Load()) * time.Millisecond)
				if delay := time.Until(target); delay > 0 {
					select {
					case <-time.After(delay):
					case <-processCtx.Done():
						cancel()
						_ = ffmpeg.Wait()
						return processCtx.Err()
					}
				}
			}
			if mode == "realtime" && processedPCM.Load() >= nextRealtimeSessionAt {
				if err := waitForVideoTranscriptionStream(processCtx, stream, providerEvents, true); err != nil {
					stream = nil
					providerEvents = nil
					return err
				}
				stream = nil
				providerEvents = nil
				stream, err = m.openVideoTranscriptionStream(processCtx, endpoint, mode, language)
				if err != nil {
					return err
				}
				providerEvents = m.consumeVideoTranscriptionEvents(processCtx, stream, sessionID, &processedPCM, cancel)
				nextRealtimeSessionAt += int64(videoRealtimeSessionDuration / time.Millisecond)
			}
			if time.Since(lastProgress) >= time.Second {
				progress := 5
				if durationMs > 0 {
					progress = int(minInt64(95, maxInt64(5, processedPCM.Load()*90/durationMs)))
				}
				_ = m.updateVideoProgress(processCtx, uploadID, progress, "transcribing", "")
				lastProgress = time.Now()
			}
			if time.Since(lastStatusCheck) >= time.Second {
				var status string
				if statusErr := m.DB.QueryRowContext(processCtx, `SELECT status FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&status); statusErr != nil {
					cancel()
					_ = ffmpeg.Wait()
					return statusErr
				}
				if status == "cancelled" {
					cancel()
					_ = ffmpeg.Wait()
					return errVideoTranscriptionCancelled
				}
				lastStatusCheck = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			cancel()
			_ = ffmpeg.Wait()
			return readErr
		}
	}
	if err := ffmpeg.Wait(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("ffmpeg could not extract audio: %s", message)
	}
	if err := waitForVideoTranscriptionStream(processCtx, stream, providerEvents, mode == "realtime"); err != nil {
		stream = nil
		providerEvents = nil
		if errors.Is(err, context.Canceled) && ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, errVideoTranscriptionCancelled) {
			return errVideoTranscriptionCancelled
		}
		return err
	}
	stream = nil
	providerEvents = nil
	return nil
}

func (m *TranscriptionManager) transcribeVideoAudioParallel(ctx context.Context, uploadID, sessionID uuid.UUID, endpoint provider.Endpoint, mode, language, videoURL string, durationMs int64, chunkMs, overlapMs, workerCount int) error {
	if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
		return err
	}
	if chunkMs <= 0 {
		chunkMs = 10 * 60 * 1000
	}
	if overlapMs <= 0 || overlapMs >= chunkMs {
		overlapMs = 5 * 1000
	}
	if workerCount <= 0 {
		workerCount = 3
	}
	parallelProgress := models.TranscriptionVideoParallelProgress{
		Strategy:        "parallel",
		Phase:           "preparing",
		ChunkDurationMs: int64(chunkMs),
		OverlapMs:       int64(overlapMs),
		WorkerCount:     workerCount,
	}
	_ = m.updateVideoParallelProgress(ctx, uploadID, parallelProgress)
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	statusCtx, cancelStatus := context.WithCancel(ctx)
	defer cancelStatus()
	statusErrors := make(chan error, 1)
	go m.watchVideoUploadStatus(statusCtx, uploadID, cancelWorkers, statusErrors)

	audioFile, audioBytes, err := extractVideoAudioPCM(workerCtx, videoURL)
	if err != nil {
		return selectVideoTranscriptionError(ctx, statusErrors, err)
	}
	defer func() {
		name := audioFile.Name()
		_ = audioFile.Close()
		_ = os.Remove(name)
	}()
	chunks := buildVideoAudioChunks(audioBytes, chunkMs, overlapMs)
	if len(chunks) == 0 {
		return selectVideoTranscriptionError(ctx, statusErrors, nil)
	}
	parallelProgress.SliceCount = len(chunks)
	if workerCount > len(chunks) {
		workerCount = len(chunks)
	}
	if workerCount < 1 {
		workerCount = 1
	}
	parallelProgress.WorkerCount = workerCount
	parallelProgress.Phase = "transcribing"
	_ = m.updateVideoParallelProgress(ctx, uploadID, parallelProgress)

	jobs := make(chan videoAudioChunk, len(chunks))
	results := make(chan videoChunkStreamResult, len(chunks))
	previewEvents := make(chan videoTranscriptionEvent)
	for _, chunk := range chunks {
		jobs <- chunk
	}
	close(jobs)

	var workers sync.WaitGroup
	workers.Add(workerCount)
	for index := 0; index < workerCount; index++ {
		go func() {
			defer workers.Done()
			for chunk := range jobs {
				var result videoChunkStreamResult
				if workerCtx.Err() != nil {
					result.err = workerCtx.Err()
				} else if statusErr := m.ensureVideoUploadActive(ctx, uploadID); statusErr != nil {
					result.err = statusErr
					cancelWorkers()
				} else {
					result.events, result.err = m.transcribeVideoChunk(workerCtx, audioFile, chunk, endpoint, mode, language, previewEvents)
					if result.err != nil && !errors.Is(result.err, context.Canceled) {
						cancelWorkers()
					}
				}
				results <- result
			}
		}()
	}

	allEvents := make([]videoTranscriptionEvent, 0)
	var firstErr, firstNonCancellationErr error
	completed := 0
	finished := 0
	lastPreviewPersist := time.Time{}
	previewDirty := false
	for finished < len(chunks) {
		select {
		case previewEvent := <-previewEvents:
			appendVideoPreviewSegments(&parallelProgress, []videoTranscriptionEvent{previewEvent})
			previewDirty = true
			if lastPreviewPersist.IsZero() || time.Since(lastPreviewPersist) >= time.Second {
				if err := m.updateVideoParallelProgress(ctx, uploadID, parallelProgress); err == nil {
					lastPreviewPersist = time.Now()
					previewDirty = false
				}
			}
		case result := <-results:
			if result.err != nil {
				if firstErr == nil {
					firstErr = result.err
				}
				if !errors.Is(result.err, context.Canceled) && firstNonCancellationErr == nil {
					firstNonCancellationErr = result.err
				}
			} else {
				allEvents = append(allEvents, result.events...)
				completed++
			}
			finished++
			parallelProgress.CompletedSlices = completed
			if err := m.updateVideoParallelProgress(ctx, uploadID, parallelProgress); err == nil {
				lastPreviewPersist = time.Now()
				previewDirty = false
			}
			progress := 5 + int(int64(finished)*80/int64(len(chunks)))
			_ = m.updateVideoProgress(ctx, uploadID, progress, "transcribing", "")
		}
	}
	if previewDirty {
		_ = m.updateVideoParallelProgress(ctx, uploadID, parallelProgress)
	}
	workers.Wait()
	if err := selectVideoTranscriptionError(ctx, statusErrors, nil); err != nil {
		return err
	}
	if firstNonCancellationErr != nil {
		return firstNonCancellationErr
	}
	if firstErr != nil {
		return firstErr
	}
	if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
		return err
	}

	parallelProgress.CompletedSlices = len(chunks)
	parallelProgress.Phase = "fusing"
	_ = m.updateVideoParallelProgress(ctx, uploadID, parallelProgress)
	_ = m.updateVideoProgress(ctx, uploadID, 85, "fusing", "")
	lastStatusCheck := time.Now()
	for _, event := range mergeVideoTranscriptionEvents(allEvents) {
		if time.Since(lastStatusCheck) >= time.Second {
			if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
				return err
			}
			lastStatusCheck = time.Now()
		}
		segment, persistErr := m.app.persistTranscriptionSegmentWithRaw(ctx, sessionID, uuid.Nil, event.text, event.rawText, event.startOffsetMs, event.endOffsetMs)
		if persistErr != nil {
			return persistErr
		}
		m.broadcast(sessionID, "transcription.final", ginData{"sourceId": uuid.Nil, "segment": segment})
	}
	parallelProgress.Phase = "complete"
	parallelProgress.PreviewSegments = nil
	_ = m.updateVideoParallelProgress(ctx, uploadID, parallelProgress)
	return nil
}

func extractVideoAudioPCM(ctx context.Context, videoURL string) (*os.File, int64, error) {
	audioFile, err := os.CreateTemp("", "justai-video-transcription-*.pcm")
	if err != nil {
		return nil, 0, fmt.Errorf("create temporary audio file: %w", err)
	}
	keepFile := false
	defer func() {
		if keepFile {
			return
		}
		_ = audioFile.Close()
		_ = os.Remove(audioFile.Name())
	}()

	command := exec.CommandContext(ctx, "ffmpeg", ffmpegVideoAudioArgs(videoURL)...)
	var stderr bytes.Buffer
	command.Stdout = audioFile
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, 0, fmt.Errorf("ffmpeg could not extract audio: %s", message)
	}
	info, err := audioFile.Stat()
	if err != nil {
		return nil, 0, fmt.Errorf("inspect extracted audio: %w", err)
	}
	audioBytes := info.Size()
	if audioBytes%2 != 0 {
		audioBytes--
		if err := audioFile.Truncate(audioBytes); err != nil {
			return nil, 0, fmt.Errorf("align extracted audio: %w", err)
		}
	}
	keepFile = true
	return audioFile, audioBytes, nil
}

func buildVideoAudioChunks(audioBytes int64, chunkMs, overlapMs int) []videoAudioChunk {
	if audioBytes <= 0 {
		return nil
	}
	if chunkMs <= 0 {
		chunkMs = 10 * 60 * 1000
	}
	if overlapMs <= 0 || overlapMs >= chunkMs {
		overlapMs = 5 * 1000
	}
	chunkBytes := int64(chunkMs) * videoAudioBytesPerMs
	overlapBytes := int64(overlapMs) * videoAudioBytesPerMs
	advanceBytes := chunkBytes - overlapBytes
	if chunkBytes < 2 || advanceBytes < 2 {
		return nil
	}
	if audioBytes%2 != 0 {
		audioBytes--
	}

	chunks := make([]videoAudioChunk, 0, int((audioBytes+advanceBytes-1)/advanceBytes))
	for offset, index := int64(0), 0; offset < audioBytes; index++ {
		length := minInt64(chunkBytes, audioBytes-offset)
		// The preceding chunk already contains its overlap. Avoid creating a
		// nearly empty final request when it is fully covered by that overlap.
		if len(chunks) > 0 && length <= overlapBytes {
			break
		}
		chunks = append(chunks, videoAudioChunk{
			index:         index,
			offsetBytes:   offset,
			lengthBytes:   length,
			startOffsetMs: offset / videoAudioBytesPerMs,
			endOffsetMs:   (offset + length) / videoAudioBytesPerMs,
		})
		if offset+length >= audioBytes {
			break
		}
		offset += advanceBytes
	}
	return chunks
}

func (m *TranscriptionManager) watchVideoUploadStatus(ctx context.Context, uploadID uuid.UUID, cancel context.CancelFunc, result chan<- error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := m.ensureVideoUploadActive(ctx, uploadID); err != nil {
				select {
				case result <- err:
				default:
				}
				cancel()
				return
			}
		}
	}
}

func selectVideoTranscriptionError(ctx context.Context, statusErrors <-chan error, fallback error) error {
	select {
	case err := <-statusErrors:
		if err != nil {
			return err
		}
	default:
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fallback
}

func (m *TranscriptionManager) transcribeVideoChunk(ctx context.Context, audioFile *os.File, chunk videoAudioChunk, endpoint provider.Endpoint, mode, language string, previewEvents chan<- videoTranscriptionEvent) ([]videoTranscriptionEvent, error) {
	audio := make([]byte, int(chunk.lengthBytes))
	read, err := audioFile.ReadAt(audio, chunk.offsetBytes)
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("read audio slice %d: %w", chunk.index, err)
	}
	if read != len(audio) {
		return nil, fmt.Errorf("read audio slice %d: got %d bytes, want %d", chunk.index, read, len(audio))
	}

	processCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := m.openVideoTranscriptionStream(processCtx, endpoint, mode, language)
	if err != nil {
		return nil, err
	}
	var processedPCM atomic.Int64
	providerEvents := collectVideoChunkEvents(stream, &processedPCM, cancel, func(event videoTranscriptionEvent) {
		normalizedEvent, ok := normalizeVideoChunkEvent(event, chunk)
		if !ok || previewEvents == nil {
			return
		}
		select {
		case previewEvents <- normalizedEvent:
		case <-processCtx.Done():
		}
	})
	audioStartedAt := time.Now()
	for offset := 0; offset < len(audio); {
		end := offset + 64*1024
		if end > len(audio) {
			end = len(audio)
		}
		piece := audio[offset:end]
		if err := stream.SendPCM(processCtx, piece, 16000); err != nil {
			cancel()
			stream.Close()
			result := <-providerEvents
			if result.err != nil && !errors.Is(result.err, context.Canceled) {
				return nil, result.err
			}
			return nil, err
		}
		processedPCM.Add(int64(len(piece)) / videoAudioBytesPerMs)
		offset = end
		if mode == "realtime" {
			target := audioStartedAt.Add(time.Duration(processedPCM.Load()) * time.Millisecond)
			if delay := time.Until(target); delay > 0 {
				select {
				case <-time.After(delay):
				case <-processCtx.Done():
					cancel()
					stream.Close()
					result := <-providerEvents
					if result.err != nil && !errors.Is(result.err, context.Canceled) {
						return nil, result.err
					}
					return nil, processCtx.Err()
				}
			}
		}
	}

	result := waitForVideoTranscriptionChunkStream(processCtx, stream, providerEvents, mode == "realtime")
	if result.err != nil {
		return nil, result.err
	}
	normalizedEvents := make([]videoTranscriptionEvent, 0, len(result.events))
	for index, event := range result.events {
		event.chunkIndex = chunk.index
		event.sequence = index
		normalizedEvent, ok := normalizeVideoChunkEvent(event, chunk)
		if !ok {
			continue
		}
		event.startOffsetMs = normalizedEvent.startOffsetMs
		event.endOffsetMs = normalizedEvent.endOffsetMs
		normalizedEvents = append(normalizedEvents, event)
	}
	return normalizedEvents, nil
}

func normalizeVideoChunkEvent(event videoTranscriptionEvent, chunk videoAudioChunk) (videoTranscriptionEvent, bool) {
	localStart := maxInt64(0, event.startOffsetMs)
	localEnd := maxInt64(localStart+250, event.endOffsetMs)
	chunkDurationMs := chunk.endOffsetMs - chunk.startOffsetMs
	if chunkDurationMs > 0 && localEnd > chunkDurationMs {
		localEnd = chunkDurationMs
	}
	if localEnd <= localStart {
		return videoTranscriptionEvent{}, false
	}
	event.startOffsetMs = chunk.startOffsetMs + localStart
	event.endOffsetMs = chunk.startOffsetMs + localEnd
	return event, true
}

func collectVideoChunkEvents(stream provider.TranscriptionStream, processedPCM *atomic.Int64, cancel context.CancelFunc, onEvent func(videoTranscriptionEvent)) <-chan videoChunkStreamResult {
	result := make(chan videoChunkStreamResult, 1)
	go func() {
		var eventResult videoChunkStreamResult
		for event := range stream.Events() {
			if event.Err != nil {
				if eventResult.err == nil {
					eventResult.err = event.Err
				}
				cancel()
				continue
			}
			rawTextValue := event.RawText
			if strings.TrimSpace(rawTextValue) == "" {
				rawTextValue = event.Text
			}
			rawTextValue = provider.CleanTranscriptText(rawTextValue)
			textValue := provider.CleanTranscriptText(event.Text)
			textValue = provider.SanitizeTranscriptRepetition(textValue)
			if textValue == "" || isTranscriptionProtocolPayload(textValue) || event.Kind != "final" {
				continue
			}
			endOffset := processedPCM.Load()
			startOffset := maxInt64(0, endOffset-3000)
			if event.EndOffsetMs > 0 {
				startOffset = maxInt64(0, event.StartOffsetMs)
				endOffset = event.EndOffsetMs
			}
			if endOffset <= startOffset {
				endOffset = startOffset + 250
			}
			transcriptionEvent := videoTranscriptionEvent{
				startOffsetMs: startOffset,
				endOffsetMs:   endOffset,
				text:          textValue,
				rawText:       rawTextValue,
			}
			if onEvent != nil {
				onEvent(transcriptionEvent)
			}
			eventResult.events = append(eventResult.events, transcriptionEvent)
		}
		result <- eventResult
	}()
	return result
}

func waitForVideoTranscriptionChunkStream(ctx context.Context, stream provider.TranscriptionStream, events <-chan videoChunkStreamResult, realtime bool) videoChunkStreamResult {
	if err := stream.Commit(); err != nil {
		stream.Close()
		result := <-events
		if result.err == nil || errors.Is(result.err, context.Canceled) {
			result.err = err
		}
		return result
	}
	if realtime {
		select {
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
		}
	}
	stream.Close()
	return <-events
}

const videoParallelPreviewLimit = 12

func appendVideoPreviewSegments(progress *models.TranscriptionVideoParallelProgress, events []videoTranscriptionEvent) {
	if progress == nil || len(events) == 0 {
		return
	}
	preview := append([]models.TranscriptionVideoPreviewSegment(nil), progress.PreviewSegments...)
	for _, event := range events {
		text := strings.TrimSpace(event.text)
		if text == "" {
			continue
		}
		preview = append(preview, models.TranscriptionVideoPreviewSegment{
			StartOffsetMs: event.startOffsetMs,
			EndOffsetMs:   event.endOffsetMs,
			Text:          text,
		})
	}
	sort.SliceStable(preview, func(left, right int) bool {
		if preview[left].StartOffsetMs != preview[right].StartOffsetMs {
			return preview[left].StartOffsetMs < preview[right].StartOffsetMs
		}
		return preview[left].EndOffsetMs < preview[right].EndOffsetMs
	})
	if len(preview) > videoParallelPreviewLimit {
		preview = preview[len(preview)-videoParallelPreviewLimit:]
	}
	progress.PreviewSegments = preview
}

func mergeVideoTranscriptionEvents(events []videoTranscriptionEvent) []videoTranscriptionEvent {
	sort.SliceStable(events, func(left, right int) bool {
		if events[left].startOffsetMs != events[right].startOffsetMs {
			return events[left].startOffsetMs < events[right].startOffsetMs
		}
		if events[left].endOffsetMs != events[right].endOffsetMs {
			return events[left].endOffsetMs < events[right].endOffsetMs
		}
		if events[left].chunkIndex != events[right].chunkIndex {
			return events[left].chunkIndex < events[right].chunkIndex
		}
		return events[left].sequence < events[right].sequence
	})
	merged := make([]videoTranscriptionEvent, 0, len(events))
	for _, event := range events {
		event.text = strings.TrimSpace(event.text)
		if event.text == "" {
			continue
		}
		if strings.TrimSpace(event.rawText) == "" {
			event.rawText = event.text
		}
		if len(merged) > 0 {
			discard := false
			for index := len(merged) - 1; index >= 0; index-- {
				previous := &merged[index]
				if event.startOffsetMs > previous.endOffsetMs+1500 {
					continue
				}
				if transcriptionTextsMatch(previous.text, event.text) {
					discard = true
					break
				}
				novel := strings.TrimSpace(provider.RemoveTranscriptOverlap(previous.text, event.text))
				if novel != event.text {
					event.text = novel
					if event.text == "" || transcriptionTextsMatch(previous.text, event.text) {
						discard = true
					}
					break
				}
			}
			if discard {
				continue
			}
		}
		merged = append(merged, event)
	}
	return merged
}

func (m *TranscriptionManager) openVideoTranscriptionStream(ctx context.Context, endpoint provider.Endpoint, mode, language string) (provider.TranscriptionStream, error) {
	if mode == "chunked" {
		return provider.OpenChunked(ctx, endpoint, endpoint.TranscriptionModel, language, provider.ChunkedOptions{
			Window:         time.Duration(m.Config.Transcription.StreamingChunkMs) * time.Millisecond,
			Overlap:        time.Duration(m.Config.Transcription.StreamingOverlapMs) * time.Millisecond,
			PromptMaxChars: m.Config.Transcription.StreamingPromptChars,
			DisablePrompt:  true,
		})
	}
	return provider.OpenRealtime(ctx, endpoint, endpoint.TranscriptionModel, language)
}

func (m *TranscriptionManager) consumeVideoTranscriptionEvents(ctx context.Context, stream provider.TranscriptionStream, sessionID uuid.UUID, processedPCM *atomic.Int64, cancel context.CancelFunc) <-chan error {
	result := make(chan error, 1)
	go func() {
		var eventErr error
		for event := range stream.Events() {
			if event.Err != nil {
				if eventErr == nil {
					eventErr = event.Err
				}
				cancel()
				continue
			}
			rawTextValue := event.RawText
			if strings.TrimSpace(rawTextValue) == "" {
				rawTextValue = event.Text
			}
			rawTextValue = provider.CleanTranscriptText(rawTextValue)
			textValue := provider.CleanTranscriptText(event.Text)
			textValue = provider.SanitizeTranscriptRepetition(textValue)
			if textValue == "" || isTranscriptionProtocolPayload(textValue) || event.Kind != "final" {
				continue
			}
			endOffset := processedPCM.Load()
			startOffset := maxInt64(0, endOffset-3000)
			if event.EndOffsetMs > 0 {
				startOffset = maxInt64(0, event.StartOffsetMs)
				endOffset = event.EndOffsetMs
			}
			segment, persistErr := m.app.persistTranscriptionSegmentWithRaw(ctx, sessionID, uuid.Nil, textValue, rawTextValue, startOffset, endOffset)
			if persistErr != nil {
				if eventErr == nil {
					eventErr = persistErr
					cancel()
				}
				continue
			}
			m.broadcast(sessionID, "transcription.final", ginData{"sourceId": uuid.Nil, "segment": segment})
		}
		result <- eventErr
	}()
	return result
}

func waitForVideoTranscriptionStream(ctx context.Context, stream provider.TranscriptionStream, events <-chan error, realtime bool) error {
	if err := stream.Commit(); err != nil {
		stream.Close()
		<-events
		return err
	}
	if realtime {
		select {
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
		}
	}
	stream.Close()
	return <-events
}

func (m *TranscriptionManager) videoJobContext(ctx context.Context, jobID uuid.UUID) (context.Context, context.CancelFunc) {
	jobCtx, cancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(videoJobLeaseRenewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-jobCtx.Done():
				return
			case <-ticker.C:
				if err := m.renewVideoJobLease(jobCtx, jobID); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	return jobCtx, cancel
}

func (m *TranscriptionManager) renewVideoJobLease(ctx context.Context, jobID uuid.UUID) error {
	result, err := m.DB.ExecContext(ctx, `
		UPDATE transcription_jobs
		SET lease_until = now() + $2 * interval '1 second', updated_at = now()
		WHERE id = $1 AND status = 'processing'`, jobID, int64(videoJobLeaseDuration/time.Second))
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("video transcription job lease was lost")
	}
	return nil
}

func probeVideoDuration(ctx context.Context, videoURL string) (float64, error) {
	command := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "-i", videoURL)
	output, err := command.Output()
	if err != nil {
		return 0, fmt.Errorf("ffprobe could not inspect the video: %w", err)
	}
	duration, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("video duration could not be determined")
	}
	return duration, nil
}

func ffmpegVideoAudioArgs(videoURL string) []string {
	return []string{
		"-hide_banner",
		"-loglevel",
		"error",
		"-err_detect",
		"ignore_err",
		"-fflags",
		"+discardcorrupt",
		"-i",
		videoURL,
		"-map",
		"0:a:0?",
		"-vn",
		"-sn",
		"-dn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-f",
		"s16le",
		"pipe:1",
	}
}

func (m *TranscriptionManager) updateVideoProgress(ctx context.Context, uploadID uuid.UUID, progress int, stage, errorMessage string) error {
	progress = int(minInt64(99, maxInt64(0, int64(progress))))
	if err := m.advanceVideoPipeline(ctx, uploadID, stage, errorMessage); err != nil {
		slog.Warn("could not persist video pipeline progress", "uploadId", uploadID, "stage", stage, "error", err)
	}
	_, err := m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET progress = $2, stage = $3, error_message = NULLIF($4, ''), updated_at = now() WHERE id = $1 AND status NOT IN ('cancelled', 'completed')`, uploadID, progress, stage, errorMessage)
	if err == nil {
		m.broadcastVideoProgress(uploadID, "processing", progress, stage, errorMessage)
	}
	return err
}

func (m *TranscriptionManager) broadcastVideoProgress(uploadID uuid.UUID, status string, progress int, stage, errorMessage string) {
	if m.app == nil {
		return
	}
	var sessionID uuid.UUID
	if err := m.DB.QueryRow(`SELECT session_id FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&sessionID); err != nil {
		return
	}
	m.broadcast(sessionID, "transcription.video.progress", ginData{
		"uploadId": uploadID,
		"status":   status,
		"progress": progress,
		"stage":    stage,
		"error":    errorMessage,
	})
}

func loadVideoUploadRecord(ctx context.Context, db *sql.DB, id uuid.UUID) (videoUploadRecord, error) {
	var record videoUploadRecord
	var errorMessage string
	var pipelineRaw []byte
	err := db.QueryRowContext(ctx, `
		SELECT id, session_id, file_name, mime_type, expected_bytes, bytes, part_size, part_count,
		       status, progress, stage, duration_ms, COALESCE(error_message, ''), created_at,
		       updated_at, completed_at, expires_at, pipeline_steps, storage_driver, storage_key, multipart_upload_id
		FROM transcription_video_uploads WHERE id = $1`, id).Scan(
		&record.model.ID, &record.model.SessionID, &record.model.FileName, &record.model.MimeType,
		&record.model.ExpectedBytes, &record.model.Bytes, &record.model.PartSize, &record.model.PartCount,
		&record.model.Status, &record.model.Progress, &record.model.Stage, &record.model.DurationMs,
		&errorMessage, &record.model.CreatedAt, &record.model.UpdatedAt, &record.model.CompletedAt,
		&record.model.ExpiresAt, &pipelineRaw, &record.storageDriver, &record.storageKey, &record.multipartID,
	)
	record.model.Error = errorMessage
	record.model.Pipeline = decodeVideoPipeline(pipelineRaw)
	return record, err
}

func (m *TranscriptionManager) expireVideoUploads(ctx context.Context) {
	rows, err := m.DB.QueryContext(ctx, `SELECT id, storage_driver, storage_key, multipart_upload_id, status FROM transcription_video_uploads WHERE expires_at IS NOT NULL AND expires_at <= now()`)
	if err != nil {
		return
	}
	type expiredUpload struct {
		id, driver, key, multipartID, status string
	}
	var expired []expiredUpload
	for rows.Next() {
		var item expiredUpload
		if rows.Scan(&item.id, &item.driver, &item.key, &item.multipartID, &item.status) == nil {
			expired = append(expired, item)
		}
	}
	_ = rows.Close()
	for _, item := range expired {
		storage, storageErr := newS3Storage(m.Config)
		if storageErr != nil {
			continue
		}
		if item.status == "uploading" {
			if err := storage.abortMultipart(ctx, item.key, item.multipartID); err != nil {
				continue
			}
		} else if err := storage.delete(ctx, item.key); err != nil {
			continue
		}
		if item.status == "completed" {
			_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET expires_at = NULL, updated_at = now() WHERE id = $1`, item.id)
			continue
		}
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', lease_until = NULL, updated_at = now() WHERE job_type = $1 AND payload->>'uploadId' = $2 AND status IN ('queued', 'processing')`, videoTranscriptionJobType, item.id)
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = (SELECT session_id FROM transcription_video_uploads WHERE id = $1) AND status = 'processing'`, item.id)
		_, _ = m.DB.ExecContext(ctx, `DELETE FROM transcription_video_uploads WHERE id = $1`, item.id)
	}
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
