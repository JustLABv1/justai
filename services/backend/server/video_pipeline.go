package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
)

var videoPipelineKeys = [...]string{
	"upload",
	"transcription",
	"diarization",
	"grammar",
	"finalization",
}

func initialVideoPipeline(now time.Time) []models.TranscriptionVideoPipelineStep {
	steps := make([]models.TranscriptionVideoPipelineStep, 0, len(videoPipelineKeys))
	for index, key := range videoPipelineKeys {
		status := "pending"
		var startedAt *time.Time
		if index == 0 {
			status = "active"
			startedAt = timePointer(now)
		}
		steps = append(steps, models.TranscriptionVideoPipelineStep{
			Key:       key,
			Status:    status,
			StartedAt: startedAt,
		})
	}
	return steps
}

func decodeVideoPipeline(raw []byte) []models.TranscriptionVideoPipelineStep {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var decoded []models.TranscriptionVideoPipelineStep
	if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded) == 0 {
		return nil
	}
	byKey := make(map[string]models.TranscriptionVideoPipelineStep, len(decoded))
	for _, step := range decoded {
		byKey[step.Key] = step
	}
	steps := make([]models.TranscriptionVideoPipelineStep, 0, len(videoPipelineKeys))
	for _, key := range videoPipelineKeys {
		step, ok := byKey[key]
		if !ok {
			step = models.TranscriptionVideoPipelineStep{Key: key, Status: "pending"}
		}
		step.Key = key
		steps = append(steps, step)
	}
	return steps
}

func encodeVideoPipeline(steps []models.TranscriptionVideoPipelineStep) ([]byte, error) {
	return json.Marshal(steps)
}

func videoPipelineKeyForStage(stage string) string {
	switch stage {
	case "starting", "extracting", "transcribing", "fusing", "processing":
		return "transcription"
	case "diarizing":
		return "diarization"
	case "polishing":
		return "grammar"
	case "finalizing":
		return "finalization"
	default:
		return ""
	}
}

func videoRetryStepForPipelineKey(key string) string {
	switch key {
	case "upload", "transcription":
		return videoRetryStepTranscription
	case "diarization":
		return videoRetryStepDiarization
	case "grammar":
		return videoRetryStepGrammar
	case "finalization":
		return videoRetryStepFinalization
	default:
		return ""
	}
}

func videoRetryStepForPipeline(steps []models.TranscriptionVideoPipelineStep) string {
	// Prefer the latest active step because progress updates can briefly leave
	// more than one stage active while a worker and a status write race.
	for index := len(steps) - 1; index >= 0; index-- {
		step := steps[index]
		if step.Status != "active" && step.Status != "retrying" && step.Status != "failed" {
			continue
		}
		if retryStep := videoRetryStepForPipelineKey(step.Key); retryStep != "" {
			return retryStep
		}
	}
	// A failure can happen between a database write and the corresponding
	// pipeline update. In that case the next pending stage is the safest place
	// to resume without discarding already completed work.
	for _, step := range steps {
		if step.Status != "pending" {
			continue
		}
		if retryStep := videoRetryStepForPipelineKey(step.Key); retryStep != "" {
			return retryStep
		}
	}
	return videoRetryStepTranscription
}

func applyVideoPipelineStage(steps []models.TranscriptionVideoPipelineStep, stage, errorMessage string, now time.Time) []models.TranscriptionVideoPipelineStep {
	steps = normalizeVideoPipeline(steps, now)
	switch stage {
	case "uploading":
		activateVideoPipelineStep(&steps[0], now)
	case "uploaded", "queued":
		completeVideoPipelineStep(&steps[0], now)
	case "retrying":
		retryVideoPipelineStep(steps, now, errorMessage)
	case "failed":
		failVideoPipelineStep(steps, now, errorMessage)
	case "cancelled":
		cancelVideoPipelineStep(steps, now)
	case "completed":
		completeVideoPipeline(steps, now)
	default:
		key := videoPipelineKeyForStage(stage)
		if key == "" {
			return steps
		}
		activateVideoPipelineAt(steps, key, now)
	}
	return steps
}

func normalizeVideoPipeline(steps []models.TranscriptionVideoPipelineStep, now time.Time) []models.TranscriptionVideoPipelineStep {
	if len(steps) == 0 {
		return initialVideoPipeline(now)
	}
	byKey := make(map[string]models.TranscriptionVideoPipelineStep, len(steps))
	for _, step := range steps {
		byKey[step.Key] = step
	}
	result := make([]models.TranscriptionVideoPipelineStep, 0, len(videoPipelineKeys))
	for _, key := range videoPipelineKeys {
		step, ok := byKey[key]
		if !ok {
			step = models.TranscriptionVideoPipelineStep{Key: key, Status: "pending"}
		}
		step.Key = key
		result = append(result, step)
	}
	return result
}

func activateVideoPipelineAt(steps []models.TranscriptionVideoPipelineStep, key string, now time.Time) {
	target := videoPipelineIndex(key)
	if target < 0 {
		return
	}
	for index := 0; index < target; index++ {
		step := &steps[index]
		if step.Status == "completed" || step.Status == "failed" || step.Status == "cancelled" || step.Status == "skipped" {
			continue
		}
		if isOptionalVideoPipelineStep(step.Key) && step.Status == "pending" {
			skipVideoPipelineStep(step)
			continue
		}
		completeVideoPipelineStep(step, now)
	}
	activateVideoPipelineStep(&steps[target], now)
}

func completeVideoPipeline(steps []models.TranscriptionVideoPipelineStep, now time.Time) {
	uploadCompletedAt := now
	if transcriptionStartedAt := videoPipelineStepStartedAt(steps, "transcription"); transcriptionStartedAt != nil {
		uploadCompletedAt = *transcriptionStartedAt
	}
	for index := range steps {
		step := &steps[index]
		if step.Key == "upload" && step.Status != "completed" && step.Status != "failed" && step.Status != "cancelled" {
			completeVideoPipelineStepAt(step, uploadCompletedAt)
			continue
		}
		if step.Key == "finalization" {
			completeVideoPipelineStep(step, now)
			continue
		}
		if step.Status == "completed" || step.Status == "failed" || step.Status == "cancelled" || step.Status == "skipped" {
			continue
		}
		if isOptionalVideoPipelineStep(step.Key) {
			skipVideoPipelineStep(step)
			continue
		}
		completeVideoPipelineStep(step, now)
	}
}

func failVideoPipelineStep(steps []models.TranscriptionVideoPipelineStep, now time.Time, errorMessage string) {
	index := -1
	for current := range steps {
		if steps[current].Status == "active" || steps[current].Status == "retrying" {
			index = current
		}
	}
	if index < 0 {
		for current := len(steps) - 1; current >= 0; current-- {
			if steps[current].Status == "failed" {
				index = current
				break
			}
		}
	}
	if index < 0 {
		for current := range steps {
			if steps[current].Status == "pending" {
				index = current
				break
			}
		}
	}
	if index < 0 {
		index = 1
	}
	step := &steps[index]
	if step.StartedAt == nil {
		step.StartedAt = timePointer(now)
	}
	step.Status = "failed"
	step.CompletedAt = timePointer(now)
	step.DurationMs = elapsedVideoPipelineStep(step, now)
	step.Error = errorMessage
}

func cancelVideoPipelineStep(steps []models.TranscriptionVideoPipelineStep, now time.Time) {
	index := -1
	for current := range steps {
		if steps[current].Key == "transcription" &&
			steps[current].Status != "completed" &&
			steps[current].Status != "failed" &&
			steps[current].Status != "cancelled" &&
			steps[current].Parallel != nil {
			// Parallel progress is written before every coarse stage update. If
			// the latter loses a read/modify/write race, it is stronger evidence
			// of the active work than a stale upload status.
			index = current
			break
		}
	}
	if index >= 0 {
		cancelVideoPipelineStepAt(steps, index, now)
		return
	}
	for current := range steps {
		if steps[current].Status != "active" && steps[current].Status != "retrying" {
			continue
		}
		// A stale pipeline can briefly expose more than one active step while
		// the worker and the cancel request race. The latest active step is the
		// one that should receive the cancellation.
		index = current
	}
	// Cancellation can be persisted by both the request handler and the
	// worker finishing the in-flight job. Once there is no active step left,
	// leave the pending steps untouched so the second write is idempotent.
	if index < 0 {
		return
	}
	cancelVideoPipelineStepAt(steps, index, now)
}

func cancelVideoPipelineStepForKey(steps []models.TranscriptionVideoPipelineStep, key string, now time.Time) bool {
	index := videoPipelineIndex(key)
	if index < 0 {
		return false
	}
	step := &steps[index]
	if step.Status == "completed" || step.Status == "failed" || step.Status == "cancelled" {
		return false
	}
	cancelVideoPipelineStepAt(steps, index, now)
	return true
}

func cancelVideoPipelineStepAt(steps []models.TranscriptionVideoPipelineStep, index int, now time.Time) {
	for previous := 0; previous < index; previous++ {
		step := &steps[previous]
		if step.Status == "completed" || step.Status == "failed" || step.Status == "cancelled" {
			continue
		}
		if isOptionalVideoPipelineStep(step.Key) {
			skipVideoPipelineStep(step)
			continue
		}
		completeVideoPipelineStepAt(step, now)
	}
	step := &steps[index]
	if step.StartedAt == nil {
		step.StartedAt = timePointer(now)
	}
	step.Status = "cancelled"
	step.CompletedAt = timePointer(now)
	step.DurationMs = elapsedVideoPipelineStep(step, now)
}

func videoPipelineCancellationKey(stage string) string {
	switch stage {
	case "uploading":
		return "upload"
	case "uploaded", "queued", "retrying", "starting", "extracting", "transcribing", "fusing", "processing":
		return "transcription"
	default:
		return ""
	}
}

func retryVideoPipelineStep(steps []models.TranscriptionVideoPipelineStep, now time.Time, errorMessage string) {
	index := -1
	for current := range steps {
		if steps[current].Status == "active" || steps[current].Status == "failed" {
			index = current
		}
	}
	if index < 0 {
		index = videoPipelineIndex("transcription")
	}
	step := &steps[index]
	step.Status = "retrying"
	step.StartedAt = nil
	step.CompletedAt = nil
	step.DurationMs = 0
	step.Parallel = nil
	if errorMessage != "" {
		step.Error = errorMessage
	}
}

func retryVideoPipelineStepFrom(steps []models.TranscriptionVideoPipelineStep, key, errorMessage string) {
	index := videoPipelineIndex(key)
	if index < 0 {
		return
	}
	for current := index; current < len(steps); current++ {
		step := &steps[current]
		step.Status = "pending"
		step.StartedAt = nil
		step.CompletedAt = nil
		step.DurationMs = 0
		step.Error = ""
		if current == index {
			step.Status = "retrying"
			step.Error = errorMessage
		}
		step.Parallel = nil
	}
}

func activateVideoPipelineStep(step *models.TranscriptionVideoPipelineStep, now time.Time) {
	if step.Status != "active" || step.StartedAt == nil {
		step.StartedAt = timePointer(now)
	}
	step.Status = "active"
	step.CompletedAt = nil
	step.DurationMs = 0
	step.Error = ""
}

func completeVideoPipelineStep(step *models.TranscriptionVideoPipelineStep, now time.Time) {
	completeVideoPipelineStepAt(step, now)
}

func completeVideoPipelineStepAt(step *models.TranscriptionVideoPipelineStep, completedAt time.Time) {
	if step.Status == "completed" {
		return
	}
	if step.StartedAt == nil {
		step.StartedAt = timePointer(completedAt)
	}
	step.Status = "completed"
	step.CompletedAt = timePointer(completedAt)
	step.DurationMs = elapsedVideoPipelineStep(step, completedAt)
	step.Error = ""
}

func skipVideoPipelineStep(step *models.TranscriptionVideoPipelineStep) {
	step.Status = "skipped"
	step.StartedAt = nil
	step.CompletedAt = nil
	step.DurationMs = 0
	step.Error = ""
}

func markVideoPipelineStep(steps []models.TranscriptionVideoPipelineStep, key, status, errorMessage string, now time.Time) {
	index := videoPipelineIndex(key)
	if index < 0 {
		return
	}
	step := &steps[index]
	switch status {
	case "completed":
		completeVideoPipelineStep(step, now)
	case "failed":
		if step.StartedAt == nil {
			step.StartedAt = timePointer(now)
		}
		step.Status = "failed"
		step.CompletedAt = timePointer(now)
		step.DurationMs = elapsedVideoPipelineStep(step, now)
		step.Error = errorMessage
	case "active":
		activateVideoPipelineStep(step, now)
	}
}

func elapsedVideoPipelineStep(step *models.TranscriptionVideoPipelineStep, now time.Time) int64 {
	if step.StartedAt == nil {
		return 0
	}
	end := now
	if step.CompletedAt != nil {
		end = *step.CompletedAt
	}
	if end.Before(*step.StartedAt) {
		return 0
	}
	return end.Sub(*step.StartedAt).Milliseconds()
}

func isOptionalVideoPipelineStep(key string) bool {
	return key == "diarization" || key == "grammar"
}

func videoPipelineIndex(key string) int {
	for index, candidate := range videoPipelineKeys {
		if candidate == key {
			return index
		}
	}
	return -1
}

func videoPipelineStepStartedAt(steps []models.TranscriptionVideoPipelineStep, key string) *time.Time {
	for index := range steps {
		if steps[index].Key != key || steps[index].StartedAt == nil {
			continue
		}
		return steps[index].StartedAt
	}
	return nil
}

func timePointer(value time.Time) *time.Time {
	copy := value
	return &copy
}

func (m *TranscriptionManager) updateStoredVideoPipeline(ctx context.Context, uploadID uuid.UUID, allowTerminal bool, mutate func([]models.TranscriptionVideoPipelineStep)) error {
	var raw []byte
	if err := m.DB.QueryRowContext(ctx, `SELECT pipeline_steps FROM transcription_video_uploads WHERE id = $1`, uploadID).Scan(&raw); err != nil {
		return err
	}
	now := time.Now().UTC()
	steps := decodeVideoPipeline(raw)
	if len(steps) == 0 {
		steps = initialVideoPipeline(now)
	}
	mutate(steps)
	pipeline, err := encodeVideoPipeline(steps)
	if err != nil {
		return err
	}
	query := `UPDATE transcription_video_uploads SET pipeline_steps = $2, updated_at = now() WHERE id = $1`
	if !allowTerminal {
		query += ` AND status NOT IN ('cancelled', 'completed')`
	}
	if _, err := m.DB.ExecContext(ctx, query, uploadID, pipeline); err != nil {
		return err
	}
	return nil
}

func (m *TranscriptionManager) advanceVideoPipeline(ctx context.Context, uploadID uuid.UUID, stage, errorMessage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) {
		applyVideoPipelineStage(steps, stage, errorMessage, now)
	})
}

func (m *TranscriptionManager) updateVideoParallelProgress(ctx context.Context, uploadID uuid.UUID, progress models.TranscriptionVideoParallelProgress) error {
	return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) {
		index := videoPipelineIndex("transcription")
		if index < 0 {
			return
		}
		value := progress
		steps[index].Parallel = &value
	})
}

func (m *TranscriptionManager) completeVideoPipeline(ctx context.Context, uploadID uuid.UUID) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, true, func(steps []models.TranscriptionVideoPipelineStep) {
		completeVideoPipeline(steps, now)
	})
}

func (m *TranscriptionManager) failVideoPipeline(ctx context.Context, uploadID uuid.UUID, errorMessage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, true, func(steps []models.TranscriptionVideoPipelineStep) {
		failVideoPipelineStep(steps, now, errorMessage)
	})
}

func (m *TranscriptionManager) cancelVideoPipeline(ctx context.Context, uploadID uuid.UUID) error {
	return m.cancelVideoPipelineAtStage(ctx, uploadID, "")
}

func (m *TranscriptionManager) cancelVideoPipelineAtStage(ctx context.Context, uploadID uuid.UUID, stage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, true, func(steps []models.TranscriptionVideoPipelineStep) {
		if key := videoPipelineCancellationKey(stage); key != "" && cancelVideoPipelineStepForKey(steps, key, now) {
			return
		}
		cancelVideoPipelineStep(steps, now)
	})
}

func (m *TranscriptionManager) retryVideoPipeline(ctx context.Context, uploadID uuid.UUID, errorMessage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) {
		retryVideoPipelineStep(steps, now, errorMessage)
	})
}

func (m *TranscriptionManager) retryVideoPipelineFrom(ctx context.Context, uploadID uuid.UUID, key, errorMessage string) error {
	return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) {
		retryVideoPipelineStepFrom(steps, key, errorMessage)
	})
}

func (m *TranscriptionManager) skipVideoPipelineStep(ctx context.Context, uploadID uuid.UUID, key string) error {
	return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) {
		index := videoPipelineIndex(key)
		if index >= 0 && index < len(steps) {
			skipVideoPipelineStep(&steps[index])
		}
	})
}

func (m *TranscriptionManager) finishVideoPipelineStep(ctx context.Context, uploadID uuid.UUID, key, status, errorMessage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, true, func(steps []models.TranscriptionVideoPipelineStep) {
		markVideoPipelineStep(steps, key, status, errorMessage, now)
	})
}
