package server

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

// Backups are uploaded in chunks so they pass the general request size limit
// and the body limits of the reverse proxies in front of the backend.
const (
	backupChunkBytes       int64 = 16 * 1024 * 1024
	backupMaxArchiveBytes  int64 = 1 << 40 // 1 TiB, a sanity bound only
	backupStaleJobAfter          = 15 * time.Minute
	backupAbandonedJobTTL        = 24 * time.Hour
	backupRestoreConfirm         = "RESTORE"
	backupProgressInterval       = time.Second
)

const (
	backupJobUploading  = "uploading"
	backupJobValidating = "validating"
	backupJobReady      = "ready"
	backupJobInvalid    = "invalid"
	backupJobRestoring  = "restoring"
	backupJobCompleted  = "completed"
	backupJobFailed     = "failed"
)

// backupJobs serializes chunk writes and tracks which jobs this process is
// working on, so a job left behind by a restarted backend can be recognized.
var backupJobs = struct {
	sync.Mutex
	running map[uuid.UUID]bool
}{running: make(map[uuid.UUID]bool)}

func (a *App) backupStagingDir() string {
	if path := strings.TrimSpace(a.Config.BackupStagingPath); path != "" {
		return path
	}
	return filepath.Join(os.TempDir(), "justai-backups")
}

type backupFileStats struct {
	Driver string `json:"driver"`
	Count  int64  `json:"count"`
	Bytes  int64  `json:"bytes"`
	Error  string `json:"error,omitempty"`
}

func (a *App) getBackupOverview(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	var databaseBytes int64
	var rows float64
	var tables int
	if err := a.DB.QueryRowContext(c, `
		SELECT pg_database_size(current_database()),
		       COALESCE(SUM(GREATEST(c.reltuples, 0)), 0),
		       COUNT(*)
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r'`).Scan(&databaseBytes, &rows, &tables); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	stores := a.backupFileStores()
	files := make([]backupFileStats, 0, len(stores))
	for _, driver := range sortedBackupDrivers(stores) {
		stats := backupFileStats{Driver: driver}
		ctx, cancel := context.WithTimeout(c, 20*time.Second)
		err := stores[driver].List(ctx, func(object backupObject) error {
			stats.Count++
			stats.Bytes += object.Size
			return nil
		})
		cancel()
		if err != nil {
			stats.Error = "Stored files could not be listed."
			slog.Warn("backup overview could not list files", "driver", driver, "error", err)
		}
		files = append(files, stats)
	}
	a.discardIdleBackupRestores(c, false)
	jobs, err := a.listBackupRestoreJobs(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"database": gin.H{
			"bytes":         databaseBytes,
			"estimatedRows": int64(rows),
			"tables":        tables,
		},
		"storageDriver":      a.Config.Transcription.StorageDriver,
		"files":              files,
		"excludedTables":     backupExcludedTables,
		"chunkBytes":         backupChunkBytes,
		"restoreConfirm":     backupRestoreConfirm,
		"restores":           jobs,
		"encryptionKeyCheck": backupEncryptionKeyCheck(a.Config.EncryptionKey),
	})
}

func (a *App) exportBackup(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	includeFiles := c.Query("files") != "false"
	filename := "justai-backup-" + time.Now().UTC().Format("20060102-150405") + ".zip"
	if !includeFiles {
		filename = "justai-backup-" + time.Now().UTC().Format("20060102-150405") + "-database.zip"
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Status(http.StatusOK)
	manifest, err := writeBackupArchive(c.Request.Context(), a.DB, a.backupFileStores(), backupExportOptions{
		IncludeFiles:  includeFiles,
		CreatedBy:     principal.Email,
		EncryptionKey: a.Config.EncryptionKey,
	}, c.Writer)
	var tableRows int64
	for _, table := range manifest.Tables {
		tableRows += table.Rows
	}
	var fileCount, fileBytes int64
	for _, group := range manifest.Files {
		fileCount += group.Count
		fileBytes += group.Bytes
	}
	details := gin.H{"includeFiles": includeFiles, "tables": len(manifest.Tables), "rows": tableRows, "files": fileCount, "fileBytes": fileBytes}
	if err != nil {
		// The status line is already sent. Without a manifest the partial
		// archive is rejected on import, so the failure cannot go unnoticed.
		slog.Error("backup export failed", "error", err)
		details["error"] = "export aborted"
		a.writePlatformAuditOutcome(c, "platform.backup.exported", "platform_backup", nil, details, "failure")
		return
	}
	a.writePlatformAuditOutcome(c, "platform.backup.exported", "platform_backup", nil, details, "success")
}

type backupRestoreJob struct {
	ID            uuid.UUID             `json:"id"`
	Status        string                `json:"status"`
	FileName      string                `json:"fileName"`
	ExpectedBytes int64                 `json:"expectedBytes"`
	ReceivedBytes int64                 `json:"receivedBytes"`
	CreatedBy     string                `json:"createdBy"`
	Summary       json.RawMessage       `json:"summary"`
	Warnings      []backupWarning       `json:"warnings"`
	Progress      backupRestoreProgress `json:"progress"`
	Error         string                `json:"error,omitempty"`
	CreatedAt     time.Time             `json:"createdAt"`
	UpdatedAt     time.Time             `json:"updatedAt"`
	StartedAt     *time.Time            `json:"startedAt,omitempty"`
	FinishedAt    *time.Time            `json:"finishedAt,omitempty"`
	stagingPath   string
}

const backupJobColumns = `id, status, file_name, expected_bytes, received_bytes, created_by_email, summary, warnings, progress, error, created_at, updated_at, started_at, finished_at, staging_path`

func scanBackupRestoreJob(row interface{ Scan(...any) error }) (backupRestoreJob, error) {
	var job backupRestoreJob
	var warnings, progress []byte
	err := row.Scan(&job.ID, &job.Status, &job.FileName, &job.ExpectedBytes, &job.ReceivedBytes, &job.CreatedBy, &job.Summary, &warnings, &progress, &job.Error, &job.CreatedAt, &job.UpdatedAt, &job.StartedAt, &job.FinishedAt, &job.stagingPath)
	if err != nil {
		return job, err
	}
	job.Warnings = make([]backupWarning, 0)
	_ = json.Unmarshal(warnings, &job.Warnings)
	_ = json.Unmarshal(progress, &job.Progress)
	return job, nil
}

// loadBackupRestoreJob also settles jobs whose worker died with a previous
// backend process: their transaction was rolled back, so they failed.
func (a *App) loadBackupRestoreJob(ctx context.Context, id uuid.UUID) (backupRestoreJob, error) {
	job, err := scanBackupRestoreJob(a.DB.QueryRowContext(ctx, `SELECT `+backupJobColumns+` FROM backup_restore_jobs WHERE id = $1`, id))
	if err != nil {
		return job, err
	}
	return a.settleStaleBackupJob(ctx, job), nil
}

func (a *App) settleStaleBackupJob(ctx context.Context, job backupRestoreJob) backupRestoreJob {
	if job.Status != backupJobValidating && job.Status != backupJobRestoring {
		return job
	}
	backupJobs.Lock()
	running := backupJobs.running[job.ID]
	backupJobs.Unlock()
	if running || time.Since(job.UpdatedAt) < backupStaleJobAfter {
		return job
	}
	message := "The backend stopped while this job was running. No data was changed by an unfinished database restore; start it again."
	if job.Status == backupJobRestoring && job.Progress.Phase == "files" {
		message = "The backend stopped while stored files were being restored. The database was restored; start the restore again to copy the remaining files."
	}
	if _, err := a.DB.ExecContext(ctx, `UPDATE backup_restore_jobs SET status = $2, error = $3, finished_at = now(), updated_at = now() WHERE id = $1 AND status = $4`, job.ID, backupJobFailed, message, job.Status); err == nil {
		job.Status = backupJobFailed
		job.Error = message
	}
	return job
}

func (a *App) listBackupRestoreJobs(ctx context.Context) ([]backupRestoreJob, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT `+backupJobColumns+` FROM backup_restore_jobs ORDER BY created_at DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := make([]backupRestoreJob, 0)
	for rows.Next() {
		job, err := scanBackupRestoreJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range jobs {
		jobs[index] = a.settleStaleBackupJob(ctx, jobs[index])
	}
	return jobs, nil
}

func backupJobID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "invalid restore id"))
		return uuid.Nil, false
	}
	return id, true
}

func (a *App) writeBackupJobLookupError(c *gin.Context, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeError(c, http.StatusNotFound, publicError("not_found", "restore not found"))
		return
	}
	writeError(c, http.StatusInternalServerError, err)
}

func (a *App) createBackupRestore(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	var request struct {
		FileName string `json:"fileName"`
		Size     int64  `json:"size"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.Size <= 0 || request.Size > backupMaxArchiveBytes {
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "backup size is invalid"))
		return
	}
	fileName := filepath.Base(strings.TrimSpace(request.FileName))
	if len(fileName) > 255 {
		fileName = fileName[:255]
	}
	var active int
	if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM backup_restore_jobs WHERE status = $1`, backupJobRestoring).Scan(&active); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if active > 0 {
		writeError(c, http.StatusConflict, publicError("restore_running", "a restore is already running"))
		return
	}
	a.discardIdleBackupRestores(c, true)

	directory := a.backupStagingDir()
	if err := os.MkdirAll(directory, 0o700); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	id := uuid.New()
	stagingPath := filepath.Join(directory, "restore-"+id.String()+".zip")
	file, err := os.OpenFile(stagingPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_ = file.Close()
	principal, _ := middleware.GetPrincipal(c)
	job, err := scanBackupRestoreJob(a.DB.QueryRowContext(c, `
		INSERT INTO backup_restore_jobs (id, created_by, created_by_email, status, file_name, expected_bytes, staging_path)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+backupJobColumns, id, principal.UserID, principal.Email, backupJobUploading, fileName, request.Size, stagingPath))
	if err != nil {
		_ = os.Remove(stagingPath)
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"restore": job, "chunkBytes": backupChunkBytes})
}

// discardIdleBackupRestores removes staged uploads that were never restored.
// Untouched for a day, any job expires, including a paused upload. With all
// set (a new upload starts), every idle job goes: only one is staged at a time.
func (a *App) discardIdleBackupRestores(ctx context.Context, all bool) {
	cutoff := time.Now().Add(-backupAbandonedJobTTL)
	if all {
		cutoff = time.Now().Add(time.Hour)
	}
	rows, err := a.DB.QueryContext(ctx, `
		SELECT id, staging_path FROM backup_restore_jobs
		WHERE status <> $1 AND updated_at < $2`,
		backupJobRestoring, cutoff)
	if err != nil {
		return
	}
	type staged struct {
		id   uuid.UUID
		path string
	}
	items := make([]staged, 0)
	for rows.Next() {
		var item staged
		if rows.Scan(&item.id, &item.path) == nil {
			items = append(items, item)
		}
	}
	_ = rows.Close()
	for _, item := range items {
		backupJobs.Lock()
		running := backupJobs.running[item.id]
		backupJobs.Unlock()
		if running {
			continue
		}
		_ = os.Remove(item.path)
		_, _ = a.DB.ExecContext(ctx, `DELETE FROM backup_restore_jobs WHERE id = $1 AND status <> $2`, item.id, backupJobRestoring)
	}
}

func (a *App) uploadBackupRestoreChunk(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, ok := backupJobID(c)
	if !ok {
		return
	}
	offset, err := strconv.ParseInt(c.Query("offset"), 10, 64)
	if err != nil || offset < 0 {
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "offset is invalid"))
		return
	}
	backupJobs.Lock()
	defer backupJobs.Unlock()
	job, err := a.loadBackupRestoreJob(c, id)
	if err != nil {
		a.writeBackupJobLookupError(c, err)
		return
	}
	if job.Status != backupJobUploading {
		writeError(c, http.StatusConflict, publicError("invalid_state", "the upload is already complete"))
		return
	}
	// A retried chunk may rewrite data that already arrived, but the upload
	// cannot skip ahead and leave a hole.
	if offset > job.ReceivedBytes || offset%backupChunkBytes != 0 {
		// The client resumes from receivedBytes, e.g. after a lost response.
		c.JSON(http.StatusConflict, gin.H{"error": "unexpected offset", "code": "unexpected_offset", "details": gin.H{"receivedBytes": job.ReceivedBytes}})
		return
	}
	file, err := os.OpenFile(job.stagingPath, os.O_WRONLY, 0o600)
	if err != nil {
		writeError(c, http.StatusGone, publicError("staging_missing", "the staged upload is not available on this backend; start the upload again"))
		return
	}
	defer file.Close()
	if err := file.Truncate(offset); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	limit := min(backupChunkBytes, job.ExpectedBytes-offset)
	written, err := io.Copy(file, io.LimitReader(c.Request.Body, limit+1))
	if err != nil {
		writeError(c, http.StatusBadRequest, publicError("upload_failed", "the chunk could not be received"))
		return
	}
	if written > limit {
		_ = file.Truncate(offset)
		writeError(c, http.StatusRequestEntityTooLarge, publicError("chunk_too_large", "the chunk is larger than expected"))
		return
	}
	if written != limit {
		_ = file.Truncate(offset)
		writeError(c, http.StatusBadRequest, publicError("chunk_incomplete", "the chunk is shorter than expected"))
		return
	}
	if err := file.Sync(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	received := offset + written
	status := backupJobUploading
	if received == job.ExpectedBytes {
		status = backupJobValidating
	}
	if _, err := a.DB.ExecContext(c, `UPDATE backup_restore_jobs SET received_bytes = $2, status = $3, updated_at = now() WHERE id = $1`, id, received, status); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if status == backupJobValidating {
		backupJobs.running[id] = true
		go a.validateBackupRestore(id, job.stagingPath)
	}
	job.ReceivedBytes = received
	job.Status = status
	c.JSON(http.StatusOK, gin.H{"restore": job})
}

func (a *App) validateBackupRestore(id uuid.UUID, stagingPath string) {
	defer func() {
		backupJobs.Lock()
		delete(backupJobs.running, id)
		backupJobs.Unlock()
	}()
	ctx := context.Background()
	inspection, err := inspectBackupArchive(ctx, a.DB, a.backupFileStores(), a.Config.EncryptionKey, stagingPath)
	if err != nil {
		message := "The backup could not be checked."
		var validation *backupValidationError
		if errors.As(err, &validation) {
			message = validation.Error()
		} else {
			slog.Error("backup validation failed", "restore", id, "error", err)
		}
		_, _ = a.DB.ExecContext(ctx, `UPDATE backup_restore_jobs SET status = $2, error = $3, updated_at = now() WHERE id = $1`, id, backupJobInvalid, message)
		return
	}
	_, _ = a.DB.ExecContext(ctx, `UPDATE backup_restore_jobs SET status = $2, summary = $3, warnings = $4, manifest = $5, updated_at = now() WHERE id = $1`,
		id, backupJobReady, jsonRaw(inspection.Summary), jsonRaw(inspection.Warnings), jsonRaw(inspection.Manifest))
}

func (a *App) getBackupRestore(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, ok := backupJobID(c)
	if !ok {
		return
	}
	job, err := a.loadBackupRestoreJob(c, id)
	if err != nil {
		a.writeBackupJobLookupError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"restore": job})
}

func (a *App) deleteBackupRestore(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, ok := backupJobID(c)
	if !ok {
		return
	}
	backupJobs.Lock()
	defer backupJobs.Unlock()
	if backupJobs.running[id] {
		writeError(c, http.StatusConflict, publicError("restore_running", "this backup is still being processed"))
		return
	}
	job, err := a.loadBackupRestoreJob(c, id)
	if err != nil {
		a.writeBackupJobLookupError(c, err)
		return
	}
	if job.Status == backupJobRestoring {
		writeError(c, http.StatusConflict, publicError("restore_running", "a running restore cannot be discarded"))
		return
	}
	_ = os.Remove(job.stagingPath)
	if _, err := a.DB.ExecContext(c, `DELETE FROM backup_restore_jobs WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) startBackupRestore(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, ok := backupJobID(c)
	if !ok {
		return
	}
	var request struct {
		Confirmation string `json:"confirmation"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.Confirmation) != backupRestoreConfirm {
		writeError(c, http.StatusBadRequest, publicError("confirmation_required", "type "+backupRestoreConfirm+" to confirm the restore"))
		return
	}
	backupJobs.Lock()
	defer backupJobs.Unlock()
	job, err := a.loadBackupRestoreJob(c, id)
	if err != nil {
		a.writeBackupJobLookupError(c, err)
		return
	}
	// A failed restore can be retried from the same staged archive.
	if job.Status != backupJobReady && job.Status != backupJobFailed {
		writeError(c, http.StatusConflict, publicError("invalid_state", "this backup is not ready to restore"))
		return
	}
	if _, err := os.Stat(job.stagingPath); err != nil {
		writeError(c, http.StatusGone, publicError("staging_missing", "the staged upload is not available on this backend; upload the backup again"))
		return
	}
	var manifestJSON []byte
	if err := a.DB.QueryRowContext(c, `SELECT manifest FROM backup_restore_jobs WHERE id = $1`, id).Scan(&manifestJSON); err != nil || len(manifestJSON) == 0 {
		writeError(c, http.StatusConflict, publicError("invalid_state", "this backup has not been checked"))
		return
	}
	var manifest backupManifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	statusToken := base64.RawURLEncoding.EncodeToString(token)
	tokenHash := sha256.Sum256([]byte(statusToken))
	result, err := a.DB.ExecContext(c, `UPDATE backup_restore_jobs SET status = $2, status_token_hash = $3, error = '', progress = '{}'::jsonb, started_at = now(), finished_at = NULL, updated_at = now() WHERE id = $1 AND status = $4`, id, backupJobRestoring, tokenHash[:], job.Status)
	if err != nil || rowsAffected(result) != 1 {
		writeError(c, http.StatusConflict, publicError("invalid_state", "this backup is not ready to restore"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	// Written before the restore: afterwards the audit log is the backup's.
	a.writePlatformAuditOutcome(c, "platform.backup.restore_started", "platform_backup", &id, gin.H{"fileName": job.FileName, "createdAt": manifest.CreatedAt}, "success")
	backupJobs.running[id] = true
	go a.runBackupRestore(id, job.stagingPath, manifest, principal.Email)
	job.Status = backupJobRestoring
	c.JSON(http.StatusAccepted, gin.H{"restore": job, "statusToken": statusToken})
}

func (a *App) runBackupRestore(id uuid.UUID, stagingPath string, manifest backupManifest, actor string) {
	defer func() {
		backupJobs.Lock()
		delete(backupJobs.running, id)
		backupJobs.Unlock()
	}()
	ctx := context.Background()
	progress := &backupRestoreProgress{Phase: "database", TablesTotal: len(manifest.Tables)}
	for _, table := range manifest.Tables {
		progress.RowsTotal += table.Rows
	}
	for _, group := range manifest.Files {
		progress.FilesTotal += group.Count
		progress.BytesTotal += group.Bytes
	}
	var lastReport time.Time
	report := func(force bool) {
		if !force && time.Since(lastReport) < backupProgressInterval {
			return
		}
		lastReport = time.Now()
		_, _ = a.DB.ExecContext(ctx, `UPDATE backup_restore_jobs SET progress = $2, updated_at = now() WHERE id = $1`, id, jsonRaw(progress))
	}
	fail := func(err error) {
		slog.Error("backup restore failed", "restore", id, "phase", progress.Phase, "error", err)
		message := "The restore failed: " + err.Error()
		if progress.Phase == "database" || progress.Phase == "constraints" {
			message += " Nothing was changed."
		}
		_, _ = a.DB.ExecContext(ctx, `UPDATE backup_restore_jobs SET status = $2, error = $3, progress = $4, finished_at = now(), updated_at = now() WHERE id = $1`, id, backupJobFailed, message, jsonRaw(progress))
	}
	report(true)
	archive, err := zip.OpenReader(stagingPath)
	if err != nil {
		fail(err)
		return
	}
	defer archive.Close()
	if err := restoreBackupDatabase(ctx, a.DB, &archive.Reader, manifest, progress, func() { report(false) }); err != nil {
		fail(err)
		return
	}
	progress.Phase = "files"
	report(true)
	if err := restoreBackupFiles(ctx, &archive.Reader, a.backupFileStores(), progress, func() { report(false) }); err != nil {
		fail(err)
		return
	}
	progress.Phase = "done"
	_, _ = a.DB.ExecContext(ctx, `UPDATE backup_restore_jobs SET status = $2, progress = $3, finished_at = now(), updated_at = now() WHERE id = $1`, id, backupJobCompleted, jsonRaw(progress))
	_ = archive.Close()
	_ = os.Remove(stagingPath)
	// The restored audit log has no record of the restore itself.
	_, _ = a.DB.ExecContext(ctx, `INSERT INTO audit_events (action, resource_type, resource_id, details) VALUES ('platform.backup.restored', 'platform_backup', $1, $2)`,
		id, jsonRaw(gin.H{"actor": actor, "backupCreatedAt": manifest.CreatedAt, "backupCreatedBy": manifest.CreatedBy, "rows": progress.RowsTotal, "files": progress.FilesTotal}))
	slog.Info("backup restore completed", "restore", id, "rows", progress.RowsTotal, "files", progress.FilesTotal)
}

// getBackupRestoreStatus lets the administrator follow a restore after it has
// replaced their session. The unguessable token returned when the restore
// started is the only credential, and only progress is exposed.
func (a *App) getBackupRestoreStatus(c *gin.Context) {
	id, ok := backupJobID(c)
	if !ok {
		return
	}
	token := c.GetHeader("X-Restore-Token")
	var hash []byte
	err := a.DB.QueryRowContext(c, `SELECT status_token_hash FROM backup_restore_jobs WHERE id = $1`, id).Scan(&hash)
	expected := sha256.Sum256([]byte(token))
	if err != nil || token == "" || len(hash) != len(expected) || subtle.ConstantTimeCompare(hash, expected[:]) != 1 {
		writeError(c, http.StatusNotFound, publicError("not_found", "restore not found"))
		return
	}
	job, err := a.loadBackupRestoreJob(c, id)
	if err != nil {
		a.writeBackupJobLookupError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"restore": gin.H{
		"id":         job.ID,
		"status":     job.Status,
		"progress":   job.Progress,
		"error":      job.Error,
		"startedAt":  job.StartedAt,
		"finishedAt": job.FinishedAt,
	}})
}
