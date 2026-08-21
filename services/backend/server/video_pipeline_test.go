package server

import (
	"context"
	"database/sql/driver"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"

	"justai-backend/models"
)

type videoPipelineStatusMatcher map[string]string

func (matcher videoPipelineStatusMatcher) Match(value driver.Value) bool {
	raw, ok := value.([]byte)
	if !ok {
		return false
	}
	steps := decodeVideoPipeline(raw)
	if len(steps) == 0 {
		return false
	}
	for _, step := range steps {
		if expected, exists := matcher[step.Key]; exists && step.Status != expected {
			return false
		}
	}
	return true
}

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

func TestVideoDiarizationStageIsActive(t *testing.T) {
	tests := []struct {
		stage string
		want  bool
	}{
		{stage: "diarizing", want: true},
		{stage: videoDiarizationSkipStage, want: true},
		{stage: "polishing", want: false},
		{stage: "completed", want: false},
		{stage: "", want: false},
	}

	for _, test := range tests {
		if got := videoDiarizationStageIsActive(test.stage); got != test.want {
			t.Fatalf("videoDiarizationStageIsActive(%q) = %t, want %t", test.stage, got, test.want)
		}
	}
}

func TestVideoDiarizationCancellationInterruptsRegisteredRequest(t *testing.T) {
	manager := &TranscriptionManager{}
	uploadID := uuid.New()
	requestContext, cancelRequest := context.WithCancel(context.Background())
	cleanup := manager.registerVideoDiarizationCancel(uploadID, cancelRequest)
	defer cleanup()

	if !manager.cancelVideoDiarization(uploadID) {
		t.Fatal("cancelVideoDiarization() = false, want true")
	}
	select {
	case <-requestContext.Done():
	case <-time.After(time.Second):
		t.Fatal("registered diarization request was not cancelled")
	}

	cleanup()
	if manager.cancelVideoDiarization(uploadID) {
		t.Fatal("cancelVideoDiarization() = true after cleanup, want false")
	}
}

func TestVideoRetryStepForUploadStage(t *testing.T) {
	tests := []struct {
		stage string
		want  string
	}{
		{stage: "starting", want: videoRetryStepTranscription},
		{stage: "extracting", want: videoRetryStepTranscription},
		{stage: "transcribing", want: videoRetryStepTranscription},
		{stage: "fusing", want: videoRetryStepTranscription},
		{stage: "diarizing", want: videoRetryStepDiarization},
		{stage: videoDiarizationSkipStage, want: videoRetryStepDiarization},
		{stage: "polishing", want: videoRetryStepGrammar},
		{stage: "finalizing", want: videoRetryStepFinalization},
		{stage: "retrying", want: ""},
		{stage: "completed", want: ""},
	}

	for _, test := range tests {
		if got := videoRetryStepForUploadStage(test.stage); got != test.want {
			t.Fatalf("videoRetryStepForUploadStage(%q) = %q, want %q", test.stage, got, test.want)
		}
	}
}

func TestVideoResumeStepUsesAuthoritativeProcessingStage(t *testing.T) {
	tests := []struct {
		name        string
		retryFrom   string
		uploadStage string
		want        string
	}{
		{name: "diarization skip", uploadStage: videoDiarizationSkipStage, want: videoRetryStepDiarization},
		{name: "grammar", uploadStage: "polishing", want: videoRetryStepGrammar},
		{name: "finalization", uploadStage: "finalizing", want: videoRetryStepFinalization},
		{name: "explicit boundary wins", retryFrom: videoRetryStepGrammar, uploadStage: "diarizing", want: videoRetryStepGrammar},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := videoResumeStep(test.retryFrom, test.uploadStage); got != test.want {
				t.Fatalf("videoResumeStep(%q, %q) = %q, want %q", test.retryFrom, test.uploadStage, got, test.want)
			}
		})
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

func TestVideoPipelinePreservesSkippedDiarizationWhenContinuing(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps = applyVideoPipelineStage(steps, "diarizing", "", started.Add(time.Second))

	if steps[2].Status != "active" {
		t.Fatalf("diarization status = %q, want active", steps[2].Status)
	}
	skipVideoPipelineStep(&steps[2])

	steps = applyVideoPipelineStage(steps, "polishing", "", started.Add(2*time.Second))
	if steps[2].Status != "skipped" {
		t.Fatalf("diarization status = %q, want skipped", steps[2].Status)
	}
	if steps[3].Status != "active" {
		t.Fatalf("grammar status = %q, want active", steps[3].Status)
	}
}

func TestVideoPipelineDiarizationSkipRepairsCompletedBoundaries(t *testing.T) {
	uploadStartedAt := time.Date(2026, time.August, 21, 8, 17, 57, 0, time.UTC)
	processingStartedAt := uploadStartedAt.Add(9 * time.Second)
	skippedAt := processingStartedAt.Add(32 * time.Minute)
	steps := initialVideoPipeline(uploadStartedAt)
	steps[1].Parallel = &models.TranscriptionVideoParallelProgress{
		Strategy:        "parallel",
		Phase:           "complete",
		CompletedSlices: 14,
		SliceCount:      14,
	}

	steps = applyVideoPipelineDiarizationSkip(steps, &processingStartedAt, skippedAt)

	if steps[0].Status != "completed" || steps[0].DurationMs != 9000 {
		t.Fatalf("upload boundary was not repaired: %+v", steps[0])
	}
	if steps[1].Status != "completed" || steps[1].DurationMs != int64((32*time.Minute)/time.Millisecond) {
		t.Fatalf("transcription boundary was not repaired: %+v", steps[1])
	}
	if steps[1].Parallel == nil || steps[1].Parallel.Phase != "complete" {
		t.Fatalf("parallel transcription evidence was lost: %+v", steps[1].Parallel)
	}
	if steps[2].Status != "skipped" || steps[3].Status != "pending" || steps[4].Status != "pending" {
		t.Fatalf("unexpected downstream skip state: %+v", steps)
	}
}

func TestAdvanceVideoPipelinePersistsReturnedStageProjection(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	uploadID := uuid.New()
	startedAt := time.Date(2026, time.August, 21, 8, 0, 0, 0, time.UTC)
	raw, err := encodeVideoPipeline(initialVideoPipeline(startedAt))
	if err != nil {
		t.Fatal(err)
	}
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT pipeline_steps FROM transcription_video_uploads WHERE id = $1 FOR UPDATE")).
		WithArgs(uploadID).
		WillReturnRows(sqlmock.NewRows([]string{"pipeline_steps"}).AddRow(raw))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE transcription_video_uploads SET pipeline_steps = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('cancelled', 'completed')")).
		WithArgs(uploadID, videoPipelineStatusMatcher{
			"upload":        "completed",
			"transcription": "completed",
			"diarization":   "skipped",
			"grammar":       "active",
			"finalization":  "pending",
		}).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	manager := &TranscriptionManager{DB: database}
	if err := manager.advanceVideoPipeline(context.Background(), uploadID, "polishing", ""); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestVideoPipelineFailureKeepsExistingFailedStage(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps[0].Status = "completed"
	steps[1].Status = "completed"
	steps[2].Status = "skipped"
	steps[3].Status = "failed"
	steps[3].Error = "grammar unavailable"

	failVideoPipelineStep(steps, started.Add(time.Second), "grammar unavailable")

	if steps[3].Status != "failed" || steps[4].Status != "pending" {
		t.Fatalf("failure should remain on the failed stage: %+v", steps)
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

func TestVideoRetryStepForPipelineUsesLatestActiveStage(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps[0].Status = "completed"
	steps[1].Status = "completed"
	steps[2].Status = "active"
	steps[2].StartedAt = timePointer(started.Add(time.Second))

	if got := videoRetryStepForPipeline(steps); got != videoRetryStepDiarization {
		t.Fatalf("retry step = %q, want %q", got, videoRetryStepDiarization)
	}
}

func TestVideoRetryStepForPipelineSupportsGrammarAndFinalization(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	steps[0].Status = "completed"
	steps[1].Status = "completed"
	steps[2].Status = "skipped"
	steps[3].Status = "failed"
	if got := videoRetryStepForPipeline(steps); got != videoRetryStepGrammar {
		t.Fatalf("failed grammar retry step = %q, want %q", got, videoRetryStepGrammar)
	}

	steps[3].Status = "completed"
	steps[4].Status = "active"
	if got := videoRetryStepForPipeline(steps); got != videoRetryStepFinalization {
		t.Fatalf("active finalization retry step = %q, want %q", got, videoRetryStepFinalization)
	}
	if got := videoRetryStage(videoRetryStepFinalization); got != "finalizing" {
		t.Fatalf("finalization retry stage = %q, want finalizing", got)
	}
}

func TestRetryVideoPipelineStepFromPreservesEarlierCompletedStages(t *testing.T) {
	started := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	steps := initialVideoPipeline(started)
	for index := 0; index < 2; index++ {
		completeVideoPipelineStep(&steps[index], started.Add(time.Duration(index+1)*time.Second))
	}
	steps[2].Status = "active"
	steps[2].StartedAt = timePointer(started.Add(3 * time.Second))

	retryVideoPipelineStepFrom(steps, videoRetryStepDiarization, "speaker diarization failed")

	if steps[0].Status != "completed" || steps[1].Status != "completed" {
		t.Fatalf("completed stages were reset: %+v", steps)
	}
	if steps[2].Status != "retrying" || steps[2].Error != "speaker diarization failed" {
		t.Fatalf("diarization stage was not marked for retry: %+v", steps[2])
	}
	if steps[3].Status != "pending" || steps[4].Status != "pending" {
		t.Fatalf("downstream stages were not reset: %+v", steps)
	}
}
