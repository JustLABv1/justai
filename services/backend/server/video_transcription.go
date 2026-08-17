package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
)

const videoTranscriptionJobType = "video_transcription"

var errVideoTranscriptionCancelled = errors.New("video transcription was cancelled")
var errVideoTranscriptionPermanent = errors.New("permanent video transcription error")

type videoUploadRecord struct {
	model         models.TranscriptionVideoUpload
	storageDriver string
	storageKey    string
	multipartID   string
}

type videoJobPayload struct {
	UploadID string `json:"uploadId"`
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
				_ = m.processVideoJob(ctx)
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
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'processing', attempts = attempts + 1, lease_until = now() + interval '2 minutes', updated_at = now() WHERE id = $1`, jobID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'processing', stage = 'starting', error_message = NULL, updated_at = now() WHERE id = $1`, uploadID); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return err
	}

	var parsed videoJobPayload
	if err := json.Unmarshal(payload, &parsed); err != nil || parsed.UploadID == "" {
		return m.finishVideoJob(ctx, jobID, uploadID, fmt.Errorf("%w: invalid video transcription job payload", errVideoTranscriptionPermanent))
	}
	if parsed.UploadID != uploadID.String() {
		return m.finishVideoJob(ctx, jobID, uploadID, fmt.Errorf("%w: video transcription job payload does not match upload", errVideoTranscriptionPermanent))
	}
	processingErr := m.transcribeVideo(ctx, jobID, uploadID)
	return m.finishVideoJob(ctx, jobID, uploadID, processingErr)
}

func (m *TranscriptionManager) finishVideoJob(ctx context.Context, jobID, uploadID uuid.UUID, processingErr error) error {
	var uploadStatus string
	var sessionID uuid.UUID
	if err := m.DB.QueryRowContext(ctx, `SELECT status, session_id FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&uploadStatus, &sessionID); err == nil && uploadStatus == "cancelled" {
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
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'completed', ended_at = COALESCE(ended_at, now()), join_code_hash = NULL, join_code_expires_at = NULL, updated_at = now() WHERE id = $1`, sessionID)
		m.broadcast(sessionID, "transcription.session", ginData{"status": "completed"})
		m.broadcastVideoProgress(uploadID, "completed", 100, "completed", "")
		return nil
	}
	if errors.Is(processingErr, errVideoTranscriptionCancelled) {
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'cancelled', lease_until = NULL, error_message = NULL, updated_at = now() WHERE id = $1`, jobID)
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'cancelled', stage = 'cancelled', error_message = NULL, updated_at = now() WHERE id = $1`, uploadID)
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
		_, _ = m.DB.ExecContext(ctx, `DELETE FROM transcription_segments WHERE session_id = $1 AND source_id IS NULL`, sessionID)
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'queued', lease_until = NULL, run_after = now() + $2 * interval '1 second', error_message = $3, updated_at = now() WHERE id = $1`, jobID, int64(delay/time.Second), processingErr.Error())
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'queued', stage = 'retrying', error_message = $2, updated_at = now() WHERE id = $1`, uploadID, processingErr.Error())
		m.broadcast(sessionID, "transcription.session", ginData{"status": "processing"})
		m.broadcastVideoProgress(uploadID, "queued", 0, "retrying", processingErr.Error())
		return processingErr
	}
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_jobs SET status = 'failed', lease_until = NULL, error_message = $2, updated_at = now() WHERE id = $1`, jobID, processingErr.Error())
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'failed', stage = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, uploadID, processingErr.Error())
	_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1`, sessionID)
	m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
	m.broadcastVideoProgress(uploadID, "failed", 0, "failed", processingErr.Error())
	return processingErr
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
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'processing', started_at = COALESCE(started_at, now()), ended_at = NULL, join_code_hash = NULL, join_code_expires_at = NULL, updated_at = now() WHERE id = $1`, sessionID); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	m.broadcast(sessionID, "transcription.session", ginData{"status": "processing"})
	upload, err := loadVideoUpload(ctx, m.DB, uploadID)
	return jobID, upload, err
}

func (m *TranscriptionManager) retryVideoJob(ctx context.Context, uploadID uuid.UUID) (uuid.UUID, models.TranscriptionVideoUpload, error) {
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
	if status != "failed" {
		return uuid.Nil, models.TranscriptionVideoUpload{}, fmt.Errorf("only failed video uploads can be retried")
	}
	_, _ = transaction.ExecContext(ctx, `DELETE FROM transcription_segments WHERE session_id = $1 AND source_id IS NULL`, sessionID)
	payload, _ := json.Marshal(videoJobPayload{UploadID: uploadID.String()})
	jobID := uuid.New()
	if _, err := transaction.ExecContext(ctx, `INSERT INTO transcription_jobs (id, session_id, job_type, payload) VALUES ($1, $2, $3, $4)`, jobID, sessionID, videoTranscriptionJobType, payload); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_video_uploads SET status = 'queued', progress = 0, stage = 'queued', duration_ms = 0, error_message = NULL, updated_at = now() WHERE id = $1`, uploadID); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE transcription_sessions SET status = 'processing', started_at = COALESCE(started_at, now()), ended_at = NULL, updated_at = now() WHERE id = $1`, sessionID); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, models.TranscriptionVideoUpload{}, err
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
	var status string
	if err := transaction.QueryRowContext(ctx, `SELECT session_id, status FROM transcription_video_uploads WHERE id = $1 FOR UPDATE`, uploadID).Scan(&sessionID, &status); err != nil {
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
	m.broadcast(sessionID, "transcription.session", ginData{"status": "failed"})
	m.broadcastVideoProgress(uploadID, "cancelled", 0, "cancelled", "")
	return nil
}

func (m *TranscriptionManager) transcribeVideo(ctx context.Context, jobID, uploadID uuid.UUID) error {
	jobCtx, cancelJob := m.videoJobContext(ctx, jobID)
	defer cancelJob()
	record, err := loadVideoUploadRecord(jobCtx, m.DB, uploadID)
	if err != nil {
		return err
	}
	if record.storageDriver != "s3" {
		return fmt.Errorf("%w: video upload storage driver %q is not supported", errVideoTranscriptionPermanent, record.storageDriver)
	}
	var sessionEndpoint uuid.UUID
	var language string
	if err := m.DB.QueryRowContext(jobCtx, `SELECT transcription_endpoint_id, language FROM transcription_sessions WHERE id = $1`, record.model.SessionID).Scan(&sessionEndpoint, &language); err != nil {
		return err
	}
	if m.app == nil {
		return fmt.Errorf("%w: transcription manager is not attached to the app", errVideoTranscriptionPermanent)
	}
	endpoint, err := m.app.providerEndpoint(jobCtx, sessionEndpoint)
	if err != nil {
		return err
	}
	mode := transcriptionMode(endpoint)
	if mode == "" {
		return fmt.Errorf("%w: provider %s does not support a compatible transcription transport", errVideoTranscriptionPermanent, endpoint.ProviderType)
	}
	storage, err := newS3Storage(m.Config)
	if err != nil {
		return err
	}
	probeInput, err := storage.get(jobCtx, record.storageKey)
	if err != nil {
		return err
	}
	duration, err := probeVideoDuration(jobCtx, probeInput)
	if err != nil {
		return err
	}
	maxDuration := time.Duration(m.Config.Transcription.VideoMaxDurationHours) * time.Hour
	if maxDuration > 0 && time.Duration(duration*float64(time.Second)) > maxDuration {
		return fmt.Errorf("%w: video duration exceeds the %d-hour limit", errVideoTranscriptionPermanent, m.Config.Transcription.VideoMaxDurationHours)
	}
	durationMs := int64(duration * 1000)
	if _, err := m.DB.ExecContext(jobCtx, `UPDATE transcription_video_uploads SET duration_ms = $2, stage = 'extracting', progress = 1, updated_at = now() WHERE id = $1`, uploadID, durationMs); err != nil {
		return err
	}
	m.broadcastVideoProgress(uploadID, "processing", 1, "extracting", "")

	processCtx, cancel := context.WithCancel(jobCtx)
	defer cancel()
	var stream provider.TranscriptionStream
	if mode == "chunked" {
		stream, err = provider.OpenChunked(processCtx, endpoint, endpoint.TranscriptionModel, language, provider.ChunkedOptions{
			Window:         time.Duration(m.Config.Transcription.StreamingChunkMs) * time.Millisecond,
			Overlap:        time.Duration(m.Config.Transcription.StreamingOverlapMs) * time.Millisecond,
			PromptMaxChars: m.Config.Transcription.StreamingPromptChars,
		})
	} else {
		stream, err = provider.OpenRealtime(processCtx, endpoint, endpoint.TranscriptionModel, language)
	}
	if err != nil {
		return err
	}
	defer stream.Close()

	var processedPCM atomic.Int64
	providerEvents := make(chan error, 1)
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
			textValue := provider.CleanTranscriptText(event.Text)
			if textValue == "" || isTranscriptionProtocolPayload(textValue) || event.Kind != "final" {
				continue
			}
			endOffset := processedPCM.Load()
			startOffset := maxInt64(0, endOffset-3000)
			if event.EndOffsetMs > 0 {
				startOffset = maxInt64(0, event.StartOffsetMs)
				endOffset = event.EndOffsetMs
			}
			segment, persistErr := m.app.persistTranscriptionSegment(processCtx, record.model.SessionID, uuid.Nil, textValue, startOffset, endOffset)
			if persistErr != nil {
				if eventErr == nil {
					eventErr = persistErr
					cancel()
				}
				continue
			}
			m.broadcast(record.model.SessionID, "transcription.final", ginData{"sourceId": uuid.Nil, "segment": segment})
		}
		providerEvents <- eventErr
	}()

	input, err := storage.get(processCtx, record.storageKey)
	if err != nil {
		return err
	}
	ffmpeg := exec.CommandContext(processCtx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
	ffmpeg.Stdin = input
	var stderr bytes.Buffer
	ffmpeg.Stderr = &stderr
	stdout, err := ffmpeg.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return err
	}
	if err := ffmpeg.Start(); err != nil {
		_ = input.Close()
		return fmt.Errorf("start ffmpeg: %w", err)
	}
	buffer := make([]byte, 64*1024)
	lastProgress := time.Now()
	lastStatusCheck := time.Now()
	audioStartedAt := time.Now()
	for {
		read, readErr := stdout.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			processed := int64(len(chunk)) * 1000 / (16000 * 2)
			processedPCM.Add(processed)
			if err := stream.SendPCM(processCtx, chunk, 16000); err != nil {
				cancel()
				_ = input.Close()
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
						_ = input.Close()
						_ = ffmpeg.Wait()
						return processCtx.Err()
					}
				}
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
					_ = input.Close()
					_ = ffmpeg.Wait()
					return statusErr
				}
				if status == "cancelled" {
					cancel()
					_ = input.Close()
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
			_ = input.Close()
			_ = ffmpeg.Wait()
			return readErr
		}
	}
	_ = input.Close()
	if err := ffmpeg.Wait(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("ffmpeg could not extract audio: %s", message)
	}
	if err := stream.Commit(); err != nil {
		return err
	}
	if mode == "realtime" {
		select {
		case <-time.After(3 * time.Second):
		case <-processCtx.Done():
		}
	}
	stream.Close()
	if err := <-providerEvents; err != nil {
		if errors.Is(err, context.Canceled) && ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, errVideoTranscriptionCancelled) {
			return errVideoTranscriptionCancelled
		}
		return err
	}
	if err := m.updateVideoProgress(jobCtx, uploadID, 99, "finalizing", ""); err != nil {
		return err
	}
	return nil
}

func (m *TranscriptionManager) videoJobContext(ctx context.Context, jobID uuid.UUID) (context.Context, context.CancelFunc) {
	jobCtx, cancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
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
		SET lease_until = now() + interval '2 minutes', updated_at = now()
		WHERE id = $1 AND status = 'processing'`, jobID)
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

func probeVideoDuration(ctx context.Context, input io.ReadCloser) (float64, error) {
	defer input.Close()
	command := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "-i", "pipe:0")
	command.Stdin = input
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

func (m *TranscriptionManager) updateVideoProgress(ctx context.Context, uploadID uuid.UUID, progress int, stage, errorMessage string) error {
	progress = int(minInt64(99, maxInt64(0, int64(progress))))
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
	err := db.QueryRowContext(ctx, `
		SELECT id, session_id, file_name, mime_type, expected_bytes, bytes, part_size, part_count,
		       status, progress, stage, duration_ms, COALESCE(error_message, ''), created_at,
		       updated_at, completed_at, expires_at, storage_driver, storage_key, multipart_upload_id
		FROM transcription_video_uploads WHERE id = $1`, id).Scan(
		&record.model.ID, &record.model.SessionID, &record.model.FileName, &record.model.MimeType,
		&record.model.ExpectedBytes, &record.model.Bytes, &record.model.PartSize, &record.model.PartCount,
		&record.model.Status, &record.model.Progress, &record.model.Stage, &record.model.DurationMs,
		&errorMessage, &record.model.CreatedAt, &record.model.UpdatedAt, &record.model.CompletedAt,
		&record.model.ExpiresAt, &record.storageDriver, &record.storageKey, &record.multipartID,
	)
	record.model.Error = errorMessage
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
