package server

import (
	"testing"
	"time"

	"justai-backend/models"
)

func TestVideoPipelineTracksStagesAndDurations(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)

	steps = applyVideoPipelineStage(steps, "extracting", "", started.Add(2*time.Second))
	if got := steps[0].Status; got != "completed" {
		t.Fatalf("upload status = %q, want completed", got)
	}
	if got := steps[0].DurationMs; got != 2000 {
		t.Fatalf("upload duration = %d, want 2000", got)
	}
	if got := steps[1].Status; got != "active" {
		t.Fatalf("transcription status = %q, want active", got)
	}

	steps = applyVideoPipelineStage(steps, "polishing", "", started.Add(7*time.Second))
	if got := steps[1].Status; got != "completed" {
		t.Fatalf("transcription status = %q, want completed", got)
	}
	if got := steps[2].Status; got != "skipped" {
		t.Fatalf("diarization status = %q, want skipped", got)
	}
	if got := steps[3].Status; got != "active" {
		t.Fatalf("grammar status = %q, want active", got)
	}

	markVideoPipelineStep(steps, "grammar", "completed", "", started.Add(9*time.Second))
	steps = applyVideoPipelineStage(steps, "finalizing", "", started.Add(9*time.Second))
	completeVideoPipeline(steps, started.Add(10*time.Second))
	if got := steps[3].Status; got != "completed" {
		t.Fatalf("grammar status = %q, want completed", got)
	}
	if got := steps[4].Status; got != "completed" {
		t.Fatalf("finalization status = %q, want completed", got)
	}
	if got := steps[4].DurationMs; got != 1000 {
		t.Fatalf("finalization duration = %d, want 1000", got)
	}
}

func TestVideoPipelinePreservesOptionalFailureOnCompletion(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps = applyVideoPipelineStage(steps, "polishing", "", started.Add(time.Second))
	markVideoPipelineStep(steps, "grammar", "failed", "grammar unavailable", started.Add(2*time.Second))
	steps = applyVideoPipelineStage(steps, "finalizing", "", started.Add(3*time.Second))
	completeVideoPipeline(steps, started.Add(4*time.Second))

	if got := steps[3].Status; got != "failed" {
		t.Fatalf("grammar status = %q, want failed", got)
	}
	if got := steps[3].Error; got != "grammar unavailable" {
		t.Fatalf("grammar error = %q, want preserved error", got)
	}
	if got := steps[4].Status; got != "completed" {
		t.Fatalf("finalization status = %q, want completed", got)
	}
}

func TestVideoPipelineDoesNotChargeProcessingTimeToUpload(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	transcriptionStarted := started.Add(2 * time.Second)
	steps[1].StartedAt = timePointer(transcriptionStarted)
	steps[1].Status = "active"

	completeVideoPipeline(steps, started.Add(10*time.Second))

	if got := steps[0].DurationMs; got != 2000 {
		t.Fatalf("upload duration = %d, want 2000", got)
	}
	if got := steps[0].CompletedAt; got == nil || !got.Equal(transcriptionStarted) {
		t.Fatalf("upload completedAt = %v, want %v", got, transcriptionStarted)
	}
}

func TestVideoPipelineCancellationIsIdempotent(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps = applyVideoPipelineStage(steps, "starting", "", started.Add(time.Second))

	cancelledAt := started.Add(2 * time.Second)
	cancelVideoPipelineStep(steps, cancelledAt)
	first := append([]models.TranscriptionVideoPipelineStep(nil), steps...)
	cancelVideoPipelineStep(steps, cancelledAt.Add(time.Second))

	for index := range steps {
		if steps[index].Status != first[index].Status {
			t.Fatalf("step %q changed after repeated cancellation: %q -> %q", steps[index].Key, first[index].Status, steps[index].Status)
		}
	}
	if steps[0].Status != "completed" || steps[1].Status != "cancelled" {
		t.Fatalf("unexpected cancellation state: %+v", steps)
	}
	if steps[2].Status != "pending" || steps[3].Status != "pending" || steps[4].Status != "pending" {
		t.Fatalf("repeated cancellation should not cancel pending steps: %+v", steps)
	}
}

func TestVideoPipelineCancellationTargetsLatestActiveStep(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps[1].Status = "active"
	steps[1].StartedAt = timePointer(started.Add(time.Second))

	cancelVideoPipelineStep(steps, started.Add(2*time.Second))

	if steps[0].Status != "completed" || steps[1].Status != "cancelled" {
		t.Fatalf("cancellation should target the latest active step: %+v", steps)
	}
}

func TestVideoPipelineCancellationRepairsStaleParallelState(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps[1].Parallel = &models.TranscriptionVideoParallelProgress{
		Strategy:    "parallel",
		Phase:       "transcribing",
		WorkerCount: 3,
		SliceCount:  14,
	}

	cancelVideoPipelineStep(steps, started.Add(2*time.Second))

	if steps[0].Status != "completed" || steps[1].Status != "cancelled" {
		t.Fatalf("stale parallel state should cancel transcription after upload: %+v", steps)
	}
	if steps[2].Status != "pending" || steps[3].Status != "pending" || steps[4].Status != "pending" {
		t.Fatalf("downstream steps should remain pending: %+v", steps)
	}
}

func TestVideoPipelineTracksParallelFusionPhase(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps = applyVideoPipelineStage(steps, "extracting", "", started.Add(time.Second))
	steps[1].Parallel = &models.TranscriptionVideoParallelProgress{
		Strategy:        "parallel",
		Phase:           "transcribing",
		ChunkDurationMs: 600000,
		OverlapMs:       5000,
		WorkerCount:     3,
		SliceCount:      13,
		CompletedSlices: 8,
	}
	steps = applyVideoPipelineStage(steps, "fusing", "", started.Add(2*time.Second))

	if steps[1].Status != "active" {
		t.Fatalf("transcription status = %q, want active during fusion", steps[1].Status)
	}
	if steps[1].Parallel == nil || steps[1].Parallel.CompletedSlices != 8 {
		t.Fatalf("parallel progress was not preserved: %+v", steps[1].Parallel)
	}
	encoded, err := encodeVideoPipeline(steps)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeVideoPipeline(encoded)
	if decoded[1].Parallel == nil || decoded[1].Parallel.WorkerCount != 3 {
		t.Fatalf("parallel progress did not survive JSON storage: %+v", decoded[1].Parallel)
	}
}
