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
	case "starting", "extracting", "transcribing", "processing":
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
		if step.Status == "completed" || step.Status == "failed" || step.Status == "cancelled" {
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
		if step.Status == "completed" || step.Status == "failed" || step.Status == "cancelled" {
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
	for index := range steps {
		if steps[index].Status != "active" && steps[index].Status != "retrying" {
			continue
		}
		step := &steps[index]
		if step.StartedAt == nil {
			step.StartedAt = timePointer(now)
		}
		step.Status = "cancelled"
		step.CompletedAt = timePointer(now)
		step.DurationMs = elapsedVideoPipelineStep(step, now)
		return
	}
	for index := 1; index < len(steps); index++ {
		if steps[index].Status != "pending" {
			continue
		}
		step := &steps[index]
		step.Status = "cancelled"
		step.CompletedAt = timePointer(now)
		return
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
	if errorMessage != "" {
		step.Error = errorMessage
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
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, true, func(steps []models.TranscriptionVideoPipelineStep) {
		cancelVideoPipelineStep(steps, now)
	})
}

func (m *TranscriptionManager) retryVideoPipeline(ctx context.Context, uploadID uuid.UUID, errorMessage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, false, func(steps []models.TranscriptionVideoPipelineStep) {
		retryVideoPipelineStep(steps, now, errorMessage)
	})
}

func (m *TranscriptionManager) finishVideoPipelineStep(ctx context.Context, uploadID uuid.UUID, key, status, errorMessage string) error {
	now := time.Now().UTC()
	return m.updateStoredVideoPipeline(ctx, uploadID, true, func(steps []models.TranscriptionVideoPipelineStep) {
		markVideoPipelineStep(steps, key, status, errorMessage, now)
	})
}
