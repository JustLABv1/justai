package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
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
}

type videoUploadCompleteRequest struct {
	Parts []videoUploadPart `json:"parts"`
}

type videoUploadPartURL struct {
	PartNumber int    `json:"partNumber"`
	URL        string `json:"url"`
}

type videoUploadResponse struct {
	Upload   models.TranscriptionVideoUpload `json:"upload"`
	PartURLs []videoUploadPartURL            `json:"partUrls,omitempty"`
	JobID    *uuid.UUID                      `json:"jobId,omitempty"`
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
	c.JSON(http.StatusCreated, videoUploadResponse{Upload: upload, PartURLs: a.videoUploadPartURLs(storage, storageKey, multipartID, partCount)})
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
		storage, storageErr := newS3Storage(a.Config)
		if storageErr == nil {
			response.PartURLs = a.videoUploadPartURLs(storage, upload.storageKey, upload.multipartID, upload.model.PartCount)
		}
	}
	c.JSON(http.StatusOK, response)
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
	if record.model.Status == "cancelled" {
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
		parts, err := normalizeVideoUploadParts(request.Parts, upload.model.PartCount)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
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
		if err := storage.completeMultipart(c, upload.storageKey, upload.multipartID, s3Parts); err != nil {
			writeError(c, http.StatusBadGateway, fmt.Errorf("could not complete video upload: %w", err))
			return
		}
		if _, err := a.DB.ExecContext(c, `UPDATE transcription_video_uploads SET status = 'uploaded', bytes = expected_bytes, progress = 100, stage = 'uploaded', updated_at = now() WHERE id = $1 AND status = 'uploading'`, uploadID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		_ = a.Live.advanceVideoPipeline(c, uploadID, "uploaded", "")
	}
	jobID, updated, err := a.Live.queueVideoTranscription(c, uploadID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
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
	jobID, upload, err := a.Live.retryVideoJob(c, uploadID)
	if err != nil {
		writeError(c, http.StatusConflict, err)
		return
	}
	a.attachVideoPlaybackURL(c, &upload)
	c.JSON(http.StatusAccepted, videoUploadResponse{Upload: upload, JobID: &jobID})
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
		} else {
			_ = storage.delete(c, upload.storageKey)
		}
	}
	updated, err := loadVideoUpload(c, a.DB, uploadID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
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
	return record, nil
}

func (a *App) attachVideoPlaybackURL(ctx context.Context, upload *models.TranscriptionVideoUpload) {
	if upload == nil || upload.PlaybackURL != "" || upload.Status == "uploading" || upload.Status == "cancelled" {
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

func (a *App) videoUploadPartURLs(storage *s3Storage, storageKey, multipartID string, partCount int) []videoUploadPartURL {
	result := make([]videoUploadPartURL, 0, partCount)
	for part := 1; part <= partCount; part++ {
		result = append(result, videoUploadPartURL{PartNumber: part, URL: storage.presignMultipartPart(storageKey, multipartID, part, 24*time.Hour)})
	}
	return result
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
