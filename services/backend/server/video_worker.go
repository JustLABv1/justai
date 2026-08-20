package server

import (
	"context"
	"database/sql"
	"math"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/models"
)

const (
	defaultVideoTranscriptionWorkerCapacity = 2
	maxVideoTranscriptionWorkerCapacity     = 16
	videoTranscriptionWorkerLockName        = "justai.video_transcription.worker_capacity"
)

func configuredVideoTranscriptionWorkerCapacity(cfg config.Config) int {
	capacity := cfg.Transcription.VideoTranscriptionWorkerCapacity
	if capacity <= 0 {
		capacity = defaultVideoTranscriptionWorkerCapacity
	}
	if capacity > maxVideoTranscriptionWorkerCapacity {
		capacity = maxVideoTranscriptionWorkerCapacity
	}
	return capacity
}

func configuredVideoTranscriptionSliceWorkers(cfg config.Config) int {
	workers := cfg.Transcription.VideoTranscriptionWorkers
	if workers <= 0 {
		workers = 3
	}
	return workers
}

func readVideoWorkerStatus(ctx context.Context, db *sql.DB, uploadID uuid.UUID, capacity, sliceWorkers int) (*models.TranscriptionVideoWorkerStatus, error) {
	if db == nil || uploadID == uuid.Nil {
		return nil, nil
	}
	if capacity <= 0 {
		capacity = defaultVideoTranscriptionWorkerCapacity
	}
	if sliceWorkers <= 0 {
		sliceWorkers = 3
	}

	var active, queued, queuePosition int
	err := db.QueryRowContext(ctx, `
		WITH current_job AS (
			SELECT id, created_at
			FROM transcription_jobs
			WHERE job_type = $1
			  AND status = 'queued'
			  AND payload->>'uploadId' = $2
			ORDER BY created_at, id
			LIMIT 1
		), counts AS (
			SELECT
				COUNT(*) FILTER (WHERE status = 'processing')::int AS active,
				COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
			FROM transcription_jobs
			WHERE job_type = $1 AND status IN ('queued', 'processing')
		)
		SELECT counts.active, counts.queued,
			COALESCE((
				SELECT COUNT(*)::int + 1
				FROM transcription_jobs queued_job, current_job
				WHERE queued_job.job_type = $1
				  AND queued_job.status = 'queued'
				  AND (queued_job.created_at, queued_job.id) < (current_job.created_at, current_job.id)
			), 0)
		FROM counts`, videoTranscriptionJobType, uploadID.String()).Scan(&active, &queued, &queuePosition)
	if err != nil {
		return nil, err
	}

	return &models.TranscriptionVideoWorkerStatus{
		Capacity:           capacity,
		Active:             active,
		Queued:             queued,
		QueuePosition:      queuePosition,
		UtilizationPercent: float64(active) / float64(capacity) * 100,
		SliceWorkersPerJob: sliceWorkers,
	}, nil
}

func attachVideoWorkerStatus(ctx context.Context, db *sql.DB, upload *models.TranscriptionVideoUpload, cfg config.Config) error {
	if upload == nil || (upload.Status != "queued" && upload.Status != "processing") {
		return nil
	}
	status, err := readVideoWorkerStatus(
		ctx,
		db,
		upload.ID,
		configuredVideoTranscriptionWorkerCapacity(cfg),
		configuredVideoTranscriptionSliceWorkers(cfg),
	)
	if err != nil {
		return err
	}
	upload.WorkerStatus = status
	return nil
}

type transcriptionWorkerAnalytics struct {
	Capacity            int                               `json:"capacity"`
	Active              int                               `json:"active"`
	Queued              int                               `json:"queued"`
	UtilizationPercent  float64                           `json:"utilizationPercent"`
	SliceWorkersPerJob  int                               `json:"sliceWorkersPerJob"`
	ActiveSliceWorkers  int                               `json:"activeSliceWorkers"`
	TotalJobs           int                               `json:"totalJobs"`
	CompletedJobs       int                               `json:"completedJobs"`
	FailedJobs          int                               `json:"failedJobs"`
	CancelledJobs       int                               `json:"cancelledJobs"`
	AudioHoursProcessed float64                           `json:"audioHoursProcessed"`
	AverageQueueWaitMs  float64                           `json:"averageQueueWaitMs"`
	P95QueueWaitMs      float64                           `json:"p95QueueWaitMs"`
	AverageProcessingMs float64                           `json:"averageProcessingMs"`
	P95ProcessingMs     float64                           `json:"p95ProcessingMs"`
	PeriodDays          int                               `json:"periodDays"`
	TimeSeries          []transcriptionWorkerAnalyticsDay `json:"timeSeries"`
}

type transcriptionWorkerAnalyticsDay struct {
	Date      string `json:"date"`
	Total     int    `json:"total"`
	Completed int    `json:"completed"`
	Failed    int    `json:"failed"`
	Cancelled int    `json:"cancelled"`
}

func (a *App) readTranscriptionWorkerAnalytics(c *gin.Context, organizationID *uuid.UUID) (transcriptionWorkerAnalytics, error) {
	start, end, err := analyticsRange(c)
	if err != nil {
		return transcriptionWorkerAnalytics{}, err
	}
	capacity := configuredVideoTranscriptionWorkerCapacity(a.Config)
	sliceWorkers := configuredVideoTranscriptionSliceWorkers(a.Config)
	var organizationArg any
	if organizationID != nil {
		organizationArg = *organizationID
	}

	var active, queued int
	if err := a.DB.QueryRowContext(c, `
		SELECT
			COUNT(*) FILTER (WHERE j.status = 'processing')::int,
			COUNT(*) FILTER (WHERE j.status = 'queued')::int
		FROM transcription_jobs j
		JOIN transcription_sessions s ON s.id = j.session_id
		WHERE j.job_type = $1
		  AND j.status IN ('queued', 'processing')
		  AND ($2::uuid IS NULL OR s.organization_id = $2::uuid)`, videoTranscriptionJobType, organizationArg).Scan(&active, &queued); err != nil {
		return transcriptionWorkerAnalytics{}, err
	}

	var analytics transcriptionWorkerAnalytics
	if err := a.DB.QueryRowContext(c, `
		SELECT
			COUNT(*)::int,
			COUNT(*) FILTER (WHERE j.status = 'completed')::int,
			COUNT(*) FILTER (WHERE j.status = 'failed')::int,
			COUNT(*) FILTER (WHERE j.status = 'cancelled')::int,
			COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(j.started_at, j.created_at) - j.created_at)) * 1000) FILTER (WHERE j.started_at IS NOT NULL), 0),
			COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (j.started_at - j.created_at)) * 1000) FILTER (WHERE j.started_at IS NOT NULL), 0),
			COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(j.completed_at, j.updated_at) - COALESCE(j.started_at, j.created_at))) * 1000) FILTER (WHERE j.status IN ('completed', 'failed', 'cancelled')), 0),
			COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(j.completed_at, j.updated_at) - COALESCE(j.started_at, j.created_at))) * 1000) FILTER (WHERE j.status IN ('completed', 'failed', 'cancelled')), 0)
		FROM transcription_jobs j
		JOIN transcription_sessions s ON s.id = j.session_id
		WHERE j.job_type = $1
		  AND j.created_at >= $2
		  AND j.created_at < $3
		  AND ($4::uuid IS NULL OR s.organization_id = $4::uuid)`, videoTranscriptionJobType, start, end, organizationArg).Scan(
		&analytics.TotalJobs,
		&analytics.CompletedJobs,
		&analytics.FailedJobs,
		&analytics.CancelledJobs,
		&analytics.AverageQueueWaitMs,
		&analytics.P95QueueWaitMs,
		&analytics.AverageProcessingMs,
		&analytics.P95ProcessingMs,
	); err != nil {
		return transcriptionWorkerAnalytics{}, err
	}

	var audioMs int64
	if err := a.DB.QueryRowContext(c, `
		SELECT COALESCE(SUM(v.duration_ms), 0)::bigint
		FROM transcription_video_uploads v
		JOIN transcription_sessions s ON s.id = v.session_id
		WHERE v.status = 'completed'
		  AND v.completed_at >= $1
		  AND v.completed_at < $2
		  AND ($3::uuid IS NULL OR s.organization_id = $3::uuid)`, start, end, organizationArg).Scan(&audioMs); err != nil {
		return transcriptionWorkerAnalytics{}, err
	}

	rows, err := a.DB.QueryContext(c, `
		SELECT
			TO_CHAR(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
			COUNT(*)::int,
			COUNT(*) FILTER (WHERE j.status = 'completed')::int,
			COUNT(*) FILTER (WHERE j.status = 'failed')::int,
			COUNT(*) FILTER (WHERE j.status = 'cancelled')::int
		FROM transcription_jobs j
		JOIN transcription_sessions s ON s.id = j.session_id
		WHERE j.job_type = $1
		  AND j.created_at >= $2
		  AND j.created_at < $3
		  AND ($4::uuid IS NULL OR s.organization_id = $4::uuid)
		GROUP BY 1
		ORDER BY 1`, videoTranscriptionJobType, start, end, organizationArg)
	if err != nil {
		return transcriptionWorkerAnalytics{}, err
	}
	defer rows.Close()
	days := make([]transcriptionWorkerAnalyticsDay, 0)
	for rows.Next() {
		var day transcriptionWorkerAnalyticsDay
		if err := rows.Scan(&day.Date, &day.Total, &day.Completed, &day.Failed, &day.Cancelled); err != nil {
			return transcriptionWorkerAnalytics{}, err
		}
		days = append(days, day)
	}
	if err := rows.Err(); err != nil {
		return transcriptionWorkerAnalytics{}, err
	}

	periodDays := int(math.Ceil(end.Sub(start).Hours() / 24))
	if periodDays < 1 {
		periodDays = 1
	}
	analytics.Capacity = capacity
	analytics.Active = active
	analytics.Queued = queued
	analytics.UtilizationPercent = float64(active) / float64(capacity) * 100
	analytics.SliceWorkersPerJob = sliceWorkers
	analytics.ActiveSliceWorkers = active * sliceWorkers
	analytics.AudioHoursProcessed = float64(audioMs) / float64(time.Hour/time.Millisecond)
	analytics.PeriodDays = periodDays
	analytics.TimeSeries = days
	return analytics, nil
}
