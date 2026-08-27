package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
)

type videoUploadInitRequest struct {
	FileName  string `json:"fileName"`
	MimeType  string `json:"mimeType"`
	FileBytes int64  `json:"fileBytes"`
}

type videoUploadPart struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
	SizeBytes  int64  `json:"sizeBytes,omitempty"`
}

type videoUploadCompleteRequest struct {
	Parts []videoUploadPart `json:"parts"`
}

type videoUploadPartURL struct {
	PartNumber int    `json:"partNumber"`
	URL        string `json:"url"`
}

type videoUploadResponse struct {
	Upload        models.TranscriptionVideoUpload `json:"upload"`
	PartURLs      []videoUploadPartURL            `json:"partUrls,omitempty"`
	UploadedParts []videoUploadPart               `json:"uploadedParts,omitempty"`
	JobID         *uuid.UUID                      `json:"jobId,omitempty"`
}

const videoPlaybackURLLifetime = 24 * time.Hour

func (a *App) initVideoTranscriptionUpload(c *gin.Context) {
	if a.Config.Transcription.StorageDriver != "s3" {
		writeError(c, http.StatusServiceUnavailable, fmt.Errorf("video uploads require S3-compatible transcription storage"))
		return
	}
	var request videoUploadInitRequest
	if !decodeJSON(c, &request) {
		return
	}
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
	var sessionStatus string
	if err := a.DB.QueryRowContext(c, `SELECT status FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&sessionStatus); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if sessionStatus != "waiting" && sessionStatus != "failed" {
		writeError(c, http.StatusConflict, fmt.Errorf("video uploads can only be started for a waiting or failed session"))
		return
	}
	fileName := filepath.Base(strings.TrimSpace(request.FileName))
	if !validVideoFileName(fileName) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a supported video file name is required"))
		return
	}
	if request.FileBytes <= 0 || request.FileBytes > a.Config.Transcription.VideoUploadMaxBytes {
		writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("video files are limited to %s", formatBytes(a.Config.Transcription.VideoUploadMaxBytes)))
		return
	}
	mimeType := strings.TrimSpace(request.MimeType)
	if !validVideoMimeType(fileName, mimeType) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("only supported video files can be transcribed"))
		return
	}
	partSize := a.Config.Transcription.VideoUploadPartBytes
	partCount64 := (request.FileBytes-1)/partSize + 1
	if partCount64 <= 0 || partCount64 > 10000 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("video upload would require too many multipart parts"))
		return
	}
	partCount := int(partCount64)
	storage, err := newS3Storage(a.Config)
	if err != nil {
		writeError(c, http.StatusServiceUnavailable, err)
		return
	}
	uploadID := uuid.New()
	storageKey := "transcription-video/" + sessionID.String() + "/" + uploadID.String()
	multipartID, err := storage.initiateMultipart(c, storageKey, mimeType)
	if err != nil {
		writeError(c, http.StatusBadGateway, fmt.Errorf("could not initialize video storage: %w", err))
		return
	}
	expiresAt := time.Now().Add(time.Duration(a.Config.Transcription.AudioRetentionDays) * 24 * time.Hour)
	pipelineStartedAt := time.Now().UTC()
	pipelineJSON, _ := json.Marshal(initialVideoPipeline(pipelineStartedAt))
	var upload models.TranscriptionVideoUpload
	var pipelineRaw []byte
	err = a.DB.QueryRowContext(c, `
		INSERT INTO transcription_video_uploads
			(id, session_id, storage_driver, storage_key, multipart_upload_id, file_name, mime_type, expected_bytes, part_size, part_count, expires_at, pipeline_steps)
		VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, session_id, file_name, mime_type, expected_bytes, bytes, part_size, part_count, status, progress, stage, duration_ms, COALESCE(error_message, ''), created_at, updated_at, completed_at, expires_at, pipeline_steps`,
		uploadID, sessionID, storageKey, multipartID, fileName, mimeType, request.FileBytes, partSize, partCount, expiresAt, pipelineJSON,
	).Scan(&upload.ID, &upload.SessionID, &upload.FileName, &upload.MimeType, &upload.ExpectedBytes, &upload.Bytes, &upload.PartSize, &upload.PartCount, &upload.Status, &upload.Progress, &upload.Stage, &upload.DurationMs, &upload.Error, &upload.CreatedAt, &upload.UpdatedAt, &upload.CompletedAt, &upload.ExpiresAt, &pipelineRaw)
	if err != nil {
		_ = storage.abortMultipart(c, storageKey, multipartID)
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	upload.Pipeline = decodeVideoPipeline(pipelineRaw)
	c.JSON(http.StatusCreated, videoUploadResponse{Upload: upload, PartURLs: a.videoUploadPartURLs(uploadID, partCount)})
}

func (a *App) getVideoTranscriptionUpload(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	upload, err := a.authorizedVideoUpload(c, uploadID)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	response := videoUploadResponse{Upload: upload.model}
	a.attachVideoPlaybackURL(c, &response.Upload)
	if upload.model.Status == "uploading" {
		response.PartURLs = a.videoUploadPartURLs(upload.model.ID, upload.model.PartCount)
		response.UploadedParts, err = a.loadPersistedVideoUploadParts(c, upload.model.ID)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	c.JSON(http.StatusOK, response)
}

var errVideoUploadNotWritable = errors.New("video upload is no longer accepting parts")

// uploadVideoTranscriptionPart receives one raw video part on the same origin
// as the API and forwards it directly to S3. It intentionally requires a
// Content-Length so both the API and S3 can enforce the exact part boundary
// without buffering or accepting an ambiguous chunked request.
func (a *App) uploadVideoTranscriptionPart(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	partNumber, err := strconv.Atoi(c.Param("partNumber"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload part number"))
		return
	}
	record, err := a.authorizedVideoUpload(c, uploadID)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	if record.model.Status != "uploading" {
		writeError(c, http.StatusConflict, fmt.Errorf("video upload is %s", record.model.Status))
		return
	}
	if record.model.ExpiresAt != nil && !record.model.ExpiresAt.After(time.Now()) {
		writeError(c, http.StatusGone, fmt.Errorf("video upload has expired"))
		return
	}
	expectedBytes, ok := expectedVideoUploadPartBytes(record.model.ExpectedBytes, record.model.PartSize, record.model.PartCount, partNumber)
	if !ok {
		writeError(c, http.StatusBadRequest, fmt.Errorf("part number must be between 1 and %d", record.model.PartCount))
		return
	}
	if c.Request.ContentLength < 0 {
		writeError(c, http.StatusLengthRequired, fmt.Errorf("Content-Length is required for video upload parts"))
		return
	}
	if c.Request.ContentLength != expectedBytes {
		if c.Request.ContentLength > record.model.PartSize {
			writeError(c, http.StatusRequestEntityTooLarge, fmt.Errorf("video upload part is limited to %s", formatBytes(record.model.PartSize)))
			return
		}
		writeError(c, http.StatusBadRequest, fmt.Errorf("part %d must contain exactly %d bytes", partNumber, expectedBytes))
		return
	}
	contentType := strings.TrimSpace(c.GetHeader("Content-Type"))
	if !validVideoPartContentType(record.model.MimeType, contentType) {
		writeError(c, http.StatusUnsupportedMediaType, fmt.Errorf("video upload part has an invalid content type"))
		return
	}
	storage, err := newS3Storage(a.Config)
	if err != nil {
		writeError(c, http.StatusServiceUnavailable, err)
		return
	}
	partResult, err := storage.uploadMultipartPart(c.Request.Context(), record.storageKey, record.multipartID, partNumber, c.Request.Body, expectedBytes, contentType)
	if err != nil {
		// A disconnected client cancels the S3 request through the shared
		// request context. There is no response to write and no DB state to
		// roll back because the part is only recorded after S3 acknowledges it.
		if c.Request.Context().Err() != nil {
			return
		}
		status := videoUploadS3ErrorStatus(err)
		writeError(c, status, fmt.Errorf("could not upload video part: %w", err))
		return
	}
	updated, err := a.persistVideoUploadPart(c.Request.Context(), record, partResult)
	if err != nil {
		if errors.Is(err, errVideoUploadNotWritable) {
			writeError(c, http.StatusConflict, err)
			return
		}
		// S3 has already accepted this part. The DB write is deliberately
		// idempotent, so the client can retry the same request safely and
		// recover the part metadata without uploading the whole video again.
		c.Header("Retry-After", "1")
		writeError(c, http.StatusServiceUnavailable, fmt.Errorf("video part was stored but could not be recorded; retry this part: %w", err))
		return
	}
	c.Header("ETag", partResult.ETag)
	c.JSON(http.StatusOK, gin.H{
		"partNumber": partResult.PartNumber,
		"etag":       partResult.ETag,
		"sizeBytes":  partResult.SizeBytes,
		"upload":     updated,
	})
}

func (a *App) getVideoTranscriptionPlayback(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	record, err := a.authorizedVideoUpload(c, uploadID)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	if record.model.Status == "uploading" {
		writeError(c, http.StatusConflict, fmt.Errorf("video upload is still in progress"))
		return
	}
	if record.model.Status == "cancelled" && !videoUploadHasCompleteObject(record.model) {
		writeError(c, http.StatusGone, fmt.Errorf("video upload was cancelled"))
		return
	}
	urlValue, expiresAt, err := a.videoPlaybackURL(c, record)
	if err != nil {
		writeError(c, http.StatusServiceUnavailable, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"url": urlValue, "expiresAt": expiresAt})
}

func (a *App) completeVideoTranscriptionUpload(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	upload, err := a.authorizedVideoUpload(c, uploadID)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request videoUploadCompleteRequest
	if !decodeJSON(c, &request) {
		return
	}
	if upload.model.Status == "queued" || upload.model.Status == "processing" || upload.model.Status == "completed" {
		a.attachVideoPlaybackURL(c, &upload.model)
		c.JSON(http.StatusAccepted, videoUploadResponse{Upload: upload.model})
		return
	}
	if upload.model.Status != "uploading" && upload.model.Status != "uploaded" {
		writeError(c, http.StatusConflict, fmt.Errorf("video upload is %s", upload.model.Status))
		return
	}
	if upload.model.Status == "uploading" {
		parts, err := a.videoUploadPartsForCompletion(c, upload, request.Parts)
		if err != nil {
			if errors.Is(err, errVideoUploadPartsIncomplete) {
				writeError(c, http.StatusBadRequest, err)
			} else {
				writeError(c, http.StatusInternalServerError, err)
			}
			return
		}
		storage, err := newS3Storage(a.Config)
		if err != nil {
			writeError(c, http.StatusServiceUnavailable, err)
			return
		}
		s3Parts := make([]s3MultipartPart, 0, len(parts))
		for _, part := range parts {
			s3Parts = append(s3Parts, s3MultipartPart{PartNumber: part.PartNumber, ETag: part.ETag})
		}
		if err := storage.completeMultipartAndVerify(c, upload.storageKey, upload.multipartID, s3Parts, upload.model.ExpectedBytes); err != nil {
			writeError(c, http.StatusBadGateway, fmt.Errorf("could not complete video upload: %w", err))
			return
		}
		result, err := a.DB.ExecContext(c, `UPDATE transcription_video_uploads SET status = 'uploaded', bytes = expected_bytes, progress = 100, stage = 'uploaded', updated_at = now() WHERE id = $1 AND status = 'uploading'`, uploadID)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		rowsAffected, err := result.RowsAffected()
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if rowsAffected == 0 {
			current, loadErr := loadVideoUpload(c, a.DB, uploadID)
			if loadErr != nil {
				writeError(c, http.StatusInternalServerError, loadErr)
				return
			}
			if current.Status == "cancelled" {
				_ = storage.delete(c, upload.storageKey)
				writeError(c, http.StatusConflict, fmt.Errorf("video upload was cancelled while completion was in progress"))
				return
			}
			if current.Status != "uploaded" && current.Status != "queued" && current.Status != "processing" && current.Status != "completed" {
				writeError(c, http.StatusConflict, fmt.Errorf("video upload is %s", current.Status))
				return
			}
		} else {
			_ = a.Live.advanceVideoPipeline(c, uploadID, "uploaded", "")
		}
	}
	jobID, updated, err := a.Live.queueVideoTranscription(c, uploadID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_ = attachVideoWorkerStatus(c, a.DB, &updated, a.Config)
	a.attachVideoPlaybackURL(c, &updated)
	c.JSON(http.StatusAccepted, videoUploadResponse{Upload: updated, JobID: &jobID})
}

func (a *App) retryVideoTranscription(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	if _, err := a.authorizedVideoUpload(c, uploadID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	jobID, upload, err := a.Live.retryVideoJob(c, uploadID, c.Query("step"))
	if err != nil {
		writeError(c, http.StatusConflict, err)
		return
	}
	_ = attachVideoWorkerStatus(c, a.DB, &upload, a.Config)
	a.attachVideoPlaybackURL(c, &upload)
	c.JSON(http.StatusAccepted, videoUploadResponse{Upload: upload, JobID: &jobID})
}

func (a *App) skipVideoTranscription(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	rawStep := strings.TrimSpace(c.Query("step"))
	step := normalizeVideoRetryStep(rawStep)
	if rawStep != "" && step != videoRetryStepDiarization {
		writeError(c, http.StatusBadRequest, fmt.Errorf("only speaker separation can currently be skipped"))
		return
	}
	if _, err := a.authorizedVideoUpload(c, uploadID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	upload, err := a.Live.skipVideoDiarization(c, uploadID)
	if err != nil {
		writeError(c, http.StatusConflict, err)
		return
	}
	_ = attachVideoWorkerStatus(c, a.DB, &upload, a.Config)
	a.attachVideoPlaybackURL(c, &upload)
	c.JSON(http.StatusAccepted, videoUploadResponse{Upload: upload})
}

func (a *App) cancelVideoTranscription(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid video upload id"))
		return
	}
	upload, err := a.authorizedVideoUpload(c, uploadID)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	if upload.model.Status == "completed" || upload.model.Status == "cancelled" {
		c.JSON(http.StatusOK, gin.H{"upload": upload.model})
		return
	}
	if err := a.Live.cancelVideoJob(c, uploadID); err != nil {
		writeError(c, http.StatusConflict, err)
		return
	}
	if storage, storageErr := newS3Storage(a.Config); storageErr == nil {
		if upload.model.Status == "uploading" {
			_ = storage.abortMultipart(c, upload.storageKey, upload.multipartID)
		}
	}
	updated, err := loadVideoUpload(c, a.DB, uploadID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_ = attachVideoWorkerStatus(c, a.DB, &updated, a.Config)
	a.attachVideoPlaybackURL(c, &updated)
	c.JSON(http.StatusOK, gin.H{"upload": updated})
}

func (a *App) authorizedVideoUpload(c *gin.Context, id uuid.UUID) (videoUploadRecord, error) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	record, err := loadVideoUploadRecord(c, a.DB, id)
	if err != nil {
		return videoUploadRecord{}, err
	}
	if err := a.authorizeTranscriptionSession(c, record.model.SessionID, principal.UserID, organizationID); err != nil {
		return videoUploadRecord{}, err
	}
	_ = attachVideoWorkerStatus(c, a.DB, &record.model, a.Config)
	return record, nil
}

func (a *App) attachVideoPlaybackURL(ctx context.Context, upload *models.TranscriptionVideoUpload) {
	if upload == nil || upload.PlaybackURL != "" || upload.Status == "uploading" || (upload.Status == "cancelled" && !videoUploadHasCompleteObject(*upload)) {
		return
	}
	record, err := loadVideoUploadRecord(ctx, a.DB, upload.ID)
	if err != nil {
		return
	}
	urlValue, _, err := a.videoPlaybackURL(ctx, record)
	if err == nil {
		upload.PlaybackURL = urlValue
	}
}

func videoUploadHasCompleteObject(upload models.TranscriptionVideoUpload) bool {
	return upload.ExpectedBytes > 0 && upload.Bytes >= upload.ExpectedBytes
}

func (a *App) videoPlaybackURL(ctx context.Context, record videoUploadRecord) (string, time.Time, error) {
	if record.storageDriver != "s3" || strings.TrimSpace(record.storageKey) == "" {
		return "", time.Time{}, fmt.Errorf("video playback is not available for this storage driver")
	}
	storage, err := newS3Storage(a.Config)
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt := time.Now().UTC().Add(videoPlaybackURLLifetime)
	return storage.presignURL(http.MethodGet, record.storageKey, nil, videoPlaybackURLLifetime), expiresAt, nil
}

func (a *App) videoUploadPartURLs(uploadID uuid.UUID, partCount int) []videoUploadPartURL {
	result := make([]videoUploadPartURL, 0, partCount)
	for part := 1; part <= partCount; part++ {
		result = append(result, videoUploadPartURL{
			PartNumber: part,
			URL:        fmt.Sprintf("/api/v1/transcription/video-uploads/%s/parts/%d", uploadID, part),
		})
	}
	return result
}

func expectedVideoUploadPartBytes(expectedBytes, partSize int64, partCount, partNumber int) (int64, bool) {
	if expectedBytes <= 0 || partSize <= 0 || partCount <= 0 || partNumber < 1 || partNumber > partCount {
		return 0, false
	}
	partBytes := partSize
	if remaining := expectedBytes - int64(partNumber-1)*partSize; remaining < partBytes {
		partBytes = remaining
	}
	return partBytes, partBytes > 0
}

func validVideoPartContentType(expected, actual string) bool {
	actual = strings.TrimSpace(actual)
	if actual == "" {
		return false
	}
	actualMediaType, _, err := mime.ParseMediaType(actual)
	if err != nil {
		return false
	}
	actualMediaType = strings.ToLower(actualMediaType)
	expectedMediaType, _, err := mime.ParseMediaType(strings.TrimSpace(expected))
	if err != nil {
		expectedMediaType = strings.ToLower(strings.TrimSpace(strings.SplitN(expected, ";", 2)[0]))
	}
	if actualMediaType == "application/octet-stream" {
		return true
	}
	if expectedMediaType == "" || expectedMediaType == "application/octet-stream" {
		return strings.HasPrefix(actualMediaType, "video/")
	}
	return actualMediaType == strings.ToLower(expectedMediaType)
}

func (a *App) persistVideoUploadPart(ctx context.Context, record videoUploadRecord, part s3MultipartUploadResult) (models.TranscriptionVideoUpload, error) {
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return models.TranscriptionVideoUpload{}, err
	}
	defer transaction.Rollback()
	var status string
	var expiresAt sql.NullTime
	if err := transaction.QueryRowContext(ctx, `SELECT status, expires_at FROM transcription_video_uploads WHERE id = $1 FOR UPDATE`, record.model.ID).Scan(&status, &expiresAt); err != nil {
		return models.TranscriptionVideoUpload{}, err
	}
	if status != "uploading" || (expiresAt.Valid && !expiresAt.Time.After(time.Now())) {
		return models.TranscriptionVideoUpload{}, fmt.Errorf("%w: upload is %s", errVideoUploadNotWritable, status)
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO transcription_video_upload_parts (upload_id, part_number, etag, size_bytes)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = EXCLUDED.etag, size_bytes = EXCLUDED.size_bytes, updated_at = now()`,
		record.model.ID, part.PartNumber, part.ETag, part.SizeBytes); err != nil {
		return models.TranscriptionVideoUpload{}, err
	}
	var bytesUploaded int64
	var progress int
	var updatedAt time.Time
	if err := transaction.QueryRowContext(ctx, `
		UPDATE transcription_video_uploads
		SET bytes = COALESCE((SELECT SUM(size_bytes) FROM transcription_video_upload_parts WHERE upload_id = $1), 0),
		    progress = LEAST(99, (COALESCE((SELECT SUM(size_bytes) FROM transcription_video_upload_parts WHERE upload_id = $1), 0) * 100 / expected_bytes)::INTEGER),
		    updated_at = now()
		WHERE id = $1 AND status = 'uploading'
		RETURNING bytes, progress, updated_at`, record.model.ID).Scan(&bytesUploaded, &progress, &updatedAt); err != nil {
		return models.TranscriptionVideoUpload{}, err
	}
	if err := transaction.Commit(); err != nil {
		return models.TranscriptionVideoUpload{}, err
	}
	updated := record.model
	updated.Bytes = bytesUploaded
	updated.Progress = progress
	updated.UpdatedAt = updatedAt
	return updated, nil
}

var errVideoUploadPartsIncomplete = errors.New("video upload parts are incomplete")

func (a *App) loadPersistedVideoUploadParts(ctx context.Context, uploadID uuid.UUID) ([]videoUploadPart, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT part_number, etag, size_bytes FROM transcription_video_upload_parts WHERE upload_id = $1 ORDER BY part_number`, uploadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := make([]videoUploadPart, 0)
	for rows.Next() {
		var part videoUploadPart
		if err := rows.Scan(&part.PartNumber, &part.ETag, &part.SizeBytes); err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return parts, nil
}

func (a *App) videoUploadPartsForCompletion(ctx context.Context, record videoUploadRecord, requested []videoUploadPart) ([]videoUploadPart, error) {
	parts, err := a.loadPersistedVideoUploadParts(ctx, record.model.ID)
	if err != nil {
		return nil, err
	}
	if len(parts) == 0 {
		normalized, normalizeErr := normalizeVideoUploadParts(requested, record.model.PartCount)
		if normalizeErr != nil {
			return nil, fmt.Errorf("%w: %v", errVideoUploadPartsIncomplete, normalizeErr)
		}
		return normalized, nil
	}
	var total int64
	for _, part := range parts {
		total += part.SizeBytes
	}
	if len(parts) != record.model.PartCount || total != record.model.ExpectedBytes {
		return nil, fmt.Errorf("%w: all uploaded parts must be present with the declared total size", errVideoUploadPartsIncomplete)
	}
	normalized, normalizeErr := normalizeVideoUploadParts(parts, record.model.PartCount)
	if normalizeErr != nil {
		return nil, fmt.Errorf("%w: %v", errVideoUploadPartsIncomplete, normalizeErr)
	}
	return normalized, nil
}

func videoUploadS3ErrorStatus(err error) int {
	var storageErr *s3ResponseError
	if !errors.As(err, &storageErr) {
		return http.StatusBadGateway
	}
	switch storageErr.status {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusConflict:
		return http.StatusConflict
	case http.StatusUnauthorized, http.StatusForbidden:
		return http.StatusFailedDependency
	case http.StatusTooManyRequests:
		return http.StatusTooManyRequests
	default:
		return http.StatusBadGateway
	}
}

func normalizeVideoUploadParts(parts []videoUploadPart, partCount int) ([]videoUploadPart, error) {
	if len(parts) != partCount {
		return nil, fmt.Errorf("all %d uploaded parts are required", partCount)
	}
	result := append([]videoUploadPart(nil), parts...)
	sort.Slice(result, func(left, right int) bool { return result[left].PartNumber < result[right].PartNumber })
	for index, part := range result {
		if part.PartNumber != index+1 || strings.TrimSpace(part.ETag) == "" || len(part.ETag) > 256 {
			return nil, fmt.Errorf("uploaded parts must contain each part number from 1 to %d and a valid ETag", partCount)
		}
	}
	return result, nil
}

func validVideoFileName(fileName string) bool {
	if fileName == "" || fileName == "." || len(fileName) > 255 {
		return false
	}
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".wmv":
		return true
	default:
		return false
	}
}

func validVideoMimeType(fileName, value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if strings.HasPrefix(value, "video/") {
		return true
	}
	if value == "" || value == "application/octet-stream" {
		return validVideoFileName(fileName)
	}
	return false
}

func formatBytes(value int64) string {
	if value >= 1024*1024*1024 {
		return fmt.Sprintf("%d GB", value/(1024*1024*1024))
	}
	return fmt.Sprintf("%d MB", value/(1024*1024))
}

func loadVideoUpload(ctx context.Context, db *sql.DB, id uuid.UUID) (models.TranscriptionVideoUpload, error) {
	var item models.TranscriptionVideoUpload
	var pipelineRaw []byte
	err := db.QueryRowContext(ctx, `
		SELECT id, session_id, file_name, mime_type, expected_bytes, bytes, part_size, part_count,
		       status, progress, stage, duration_ms, COALESCE(error_message, ''), created_at,
		       updated_at, completed_at, expires_at, pipeline_steps
		FROM transcription_video_uploads WHERE id = $1`, id).Scan(
		&item.ID, &item.SessionID, &item.FileName, &item.MimeType, &item.ExpectedBytes,
		&item.Bytes, &item.PartSize, &item.PartCount, &item.Status, &item.Progress,
		&item.Stage, &item.DurationMs, &item.Error, &item.CreatedAt, &item.UpdatedAt,
		&item.CompletedAt, &item.ExpiresAt, &pipelineRaw,
	)
	if err == nil {
		item.Pipeline = decodeVideoPipeline(pipelineRaw)
	}
	return item, err
}

func loadLatestVideoUpload(ctx context.Context, db *sql.DB, sessionID uuid.UUID) (*models.TranscriptionVideoUpload, error) {
	var item models.TranscriptionVideoUpload
	var errorMessage string
	var pipelineRaw []byte
	err := db.QueryRowContext(ctx, `
		SELECT id, session_id, file_name, mime_type, expected_bytes, bytes, part_size, part_count,
		       status, progress, stage, duration_ms, COALESCE(error_message, ''), created_at,
		       updated_at, completed_at, expires_at, pipeline_steps
		FROM transcription_video_uploads WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(
		&item.ID, &item.SessionID, &item.FileName, &item.MimeType, &item.ExpectedBytes,
		&item.Bytes, &item.PartSize, &item.PartCount, &item.Status, &item.Progress,
		&item.Stage, &item.DurationMs, &errorMessage, &item.CreatedAt, &item.UpdatedAt,
		&item.CompletedAt, &item.ExpiresAt, &pipelineRaw,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.Error = errorMessage
	item.Pipeline = decodeVideoPipeline(pipelineRaw)
	return &item, nil
}
