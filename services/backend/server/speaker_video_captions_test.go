package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/models"
	"justai-backend/provider"
)

func TestSpeakerCaptionSamplingBoundedAndExclusive(t *testing.T) {
	var speakers []models.TranscriptionSpeaker
	var segments []models.TranscriptionSegment
	for n := 0; n < 40; n++ {
		id := uuid.New()
		speakers = append(speakers, models.TranscriptionSpeaker{ID: id, Label: id.String()})
		for turn := 0; turn < 2; turn++ {
			start := int64(n*500000 + turn*120000)
			segments = append(segments, models.TranscriptionSegment{SpeakerID: &id, StartOffsetMs: start, EndOffsetMs: start + 60000})
		}
	}
	frames := planSpeakerCaptionFrames(segments, speakers, 48)
	if len(frames) != 48 {
		t.Fatalf("budget not enforced: %d", len(frames))
	}
	for i := 0; i < 40; i++ {
		if frames[i].SpeakerID != speakers[i].ID {
			t.Fatal("first pass must cover every speaker before second sample")
		}
	}
	protected := speakers[0]
	protected.DisplayName = "Manual"
	protected.NameSource = "manual"
	if got := planSpeakerCaptionFrames(segments, []models.TranscriptionSpeaker{protected}, 24); len(got) != 0 {
		t.Fatal("manual name sampled")
	}
	f := frames[0]
	other := speakers[1].ID
	overlap := append(segments, models.TranscriptionSegment{SpeakerID: &other, StartOffsetMs: f.OffsetMs - 100, EndOffsetMs: f.OffsetMs + 100})
	if captionFrameMatchesSpeaker(f, overlap) {
		t.Fatal("overlap is ambiguous")
	}
	unknown := append(segments, models.TranscriptionSegment{StartOffsetMs: f.OffsetMs - 100, EndOffsetMs: f.OffsetMs + 100})
	if captionFrameMatchesSpeaker(f, unknown) {
		t.Fatal("unassigned audio is ambiguous")
	}
	if got := planSpeakerCaptionFrames(segments, speakers, 49); len(got) != 0 {
		t.Fatal("invalid budget accepted")
	}
}
func TestSpeakerCaptionDecodeRequiresLiteralName(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want string
	}{
		{`{"name":"Markus Frohnmaier","caption":"Markus Frohnmaier, AfD","confidence":0.99}`, "Markus Frohnmaier"},
		{"```json\n{\"name\":\"Anna Müller\",\"caption\":\"Anna Müller · SPD\",\"confidence\":0.95}\n```", "Anna Müller"},
		{`{"name":"Guess","caption":"Deutscher Bundestag","confidence":1}`, ""},
		{`{"name":"Anna","caption":"Annabelle","confidence":1}`, ""},
		{`{"name":"Anna","caption":"Anna","confidence":0.7}`, ""},
		{`{"name":"Anna","caption":"Anna and Ben","confidence":1,"ambiguous":true}`, ""},
		{`{"name":"!!","caption":"!!","confidence":1}`, ""},
	} {
		got, err := decodeSpeakerCaption(tc.raw)
		if err != nil || got.Name != tc.want {
			t.Errorf("%s: %+v %v", tc.raw, got, err)
		}
	}
	if _, err := decodeSpeakerCaption("not JSON"); err == nil {
		t.Fatal("malformed output accepted")
	}
}
func TestSpeakerCaptionVotingAndManualProtection(t *testing.T) {
	id := uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "SPEAKER_00"}}
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 20000}, {SpeakerID: &id, StartOffsetMs: 30000, EndOffsetMs: 50000}}
	frames := planSpeakerCaptionFrames(segments, speakers, 24)
	if len(frames) < 4 || len(frames) > 24 {
		t.Fatalf("expected broader bounded samples: %+v", frames)
	}
	var observations []speakerCaptionObservation
	for i := range frames {
		observations = append(observations, speakerCaptionObservation{FrameIndex: i, Name: "Anna Müller", Caption: "Anna Müller, SPD", Confidence: .98})
	}
	for _, count := range []int{1, 2, 3, 4} {
		result := resolveSpeakerCaptionResults(frames, observations[:count], speakers, segments, true)
		if len(result) != 1 || result[0].Applied != (count >= 3) {
			t.Fatalf("count %d: %+v", count, result)
		}
	}
	if got := resolveSpeakerCaptionResults(frames, observations, speakers, segments, false); got[0].Applied {
		t.Fatal("opt-in ignored")
	}
	observations[3].Name = "Ben Weber"
	observations[3].Caption = "Ben Weber"
	got := resolveSpeakerCaptionResults(frames, observations, speakers, segments, true)
	if len(got) != 1 || got[0].Applied || !got[0].Conflict {
		t.Fatalf("conflict applied: %+v", got)
	}
	speakers[0].DisplayName = "User choice"
	speakers[0].NameSource = "manual"
	if got := resolveSpeakerCaptionResults(frames, observations, speakers, segments, true); len(got) != 0 {
		t.Fatal("manual name overwritten")
	}
	speakers[0].DisplayName = ""
	segments[0].SpeakerID = nil
	segments[1].SpeakerID = nil
	if got := resolveSpeakerCaptionResults(frames, observations, speakers, segments, true); len(got) != 0 {
		t.Fatal("stale audio assignment used")
	}
}
func TestSpeakerCaptionOneTurnCannotAutoApply(t *testing.T) {
	id := uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}}
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 6 * 60 * 60 * 1000}}
	frames := planSpeakerCaptionFrames(segments, speakers, 48)
	if len(frames) < 4 || len(frames) > 48 {
		t.Fatalf("six hours must not grow the budget: %d", len(frames))
	}
	observations := []speakerCaptionObservation{{FrameIndex: 0, Name: "Anna", Confidence: 1}, {FrameIndex: 1, Name: "Anna", Confidence: 1}}
	got := resolveSpeakerCaptionResults(frames, observations, speakers, segments, true)
	if len(got) != 1 || got[0].Applied {
		t.Fatalf("single turn auto applied: %+v", got)
	}
}
func TestSpeakerCaptionFinishFencesCancelledWorkerAndManualRename(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "manual rename"}[active], func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			a := &App{DB: db}
			id, session, token, speaker := uuid.New(), uuid.New(), uuid.New(), uuid.New()
			mock.ExpectBegin()
			mock.ExpectQuery("SELECT status='processing'").WithArgs(id, token).WillReturnRows(sqlmock.NewRows([]string{"active"}).AddRow(active))
			if !active {
				mock.ExpectRollback()
			} else {
				mock.ExpectExec("UPDATE transcription_speakers SET display_name=.*AND merged_into IS NULL AND \\(display_name='' OR name_source='ai'\\)").WithArgs(speaker, session, "Anna", .92, "proof").WillReturnResult(sqlmock.NewResult(0, 0))
				mock.ExpectExec("UPDATE transcription_speaker_caption_runs SET status='completed'").WithArgs(id, token, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectCommit()
			}
			results := []speakerCaptionResult{{SpeakerID: speaker, Name: "Anna", Confidence: .92, Evidence: "proof", Applied: true}}
			err = a.finishSpeakerCaptionRun(context.Background(), id, session, token, results)
			if active && (err != nil || results[0].Applied) {
				t.Fatalf("manual rename race: %+v %v", results, err)
			}
			if !active && err == nil {
				t.Fatal("cancelled job committed")
			}
			if err = mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestSpeakerCaptionVisionTransport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		encoded, _ := json.Marshal(body)
		if !bytes.Contains(encoded, []byte("data:image/jpeg;base64,")) || body["model"] != "vision-test" {
			t.Errorf("missing image/model: %s", encoded)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		output := `{"name":"Anna Müller","caption":"Anna Müller, SPD","confidence":0.99}`
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": output}}}})
		w.Write([]byte("data: " + string(chunk) + "\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	var data bytes.Buffer
	jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, 32, 16)), nil)
	got, err := readSpeakerCaption(context.Background(), provider.Endpoint{ProviderType: "openai-compatible", BaseURL: server.URL, ChatModel: "vision-test", AllowPrivate: true}, data.Bytes())
	if err != nil || got.Name != "Anna Müller" {
		t.Fatalf("vision transport: %+v %v", got, err)
	}
}
func TestSpeakerCaptionFFmpegExtraction(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("FFmpeg not installed")
	}
	file := filepath.Join(t.TempDir(), "fixture.mp4")
	command := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:d=2", "-c:v", "mpeg4", "-y", file)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create video: %s %v", output, err)
	}
	server := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(file))))
	defer server.Close()
	for _, tc := range []struct {
		view          string
		width, height int
	}{{"", 960, 270}, {"sharp", 1440, 405}, {"full", 1440, 810}} {
		data, err := extractSpeakerCaptionView(context.Background(), server.URL+"/fixture.mp4", 500, tc.view)
		if err != nil {
			t.Fatal(err)
		}
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || format != "jpeg" || config.Width != tc.width || config.Height != tc.height {
			t.Fatalf("%s: unexpected image: %+v %s %v", tc.view, config, format, err)
		}
	}
}

func TestSpeakerCaptionUnauthorizedRunDoesNotLoadEvidence(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS (SELECT 1 FROM transcription_sessions WHERE id = $1 AND user_id = $2 AND organization_id = $3)`)).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	// Exercise the authorization helper with Gin's normal handler parameters.
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("GET", "/", nil)
	c.Params = gin.Params{{Key: "id", Value: uuid.NewString()}, {Key: "runId", Value: uuid.NewString()}, {Key: "frameIndex", Value: "0"}}
	a := &App{DB: db}
	a.speakerCaptionImage(c)
	if recorder.Code != 404 {
		t.Fatalf("want 404, got %d", recorder.Code)
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSpeakerCaptionOutputLimitAlsoAppliesToIOCopy(t *testing.T) {
	buffer := &captionLimitedBuffer{limit: 32}
	if _, err := io.Copy(buffer, strings.NewReader(strings.Repeat("x", 10000))); err == nil || buffer.Len() != 32 {
		t.Fatalf("output limit bypassed: %d %v", buffer.Len(), err)
	}
	diagnostic := &captionLimitedBuffer{limit: 32, discard: true}
	if n, err := io.Copy(diagnostic, strings.NewReader(strings.Repeat("x", 10000))); err != nil || n != 10000 || diagnostic.Len() != 32 {
		t.Fatalf("diagnostic cap: %d %d %v", n, diagnostic.Len(), err)
	}
}

func TestSpeakerCaptionSameNameOnDifferentAudioLabelsNeedsReview(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: a, Label: "A"}, {ID: b, Label: "B"}}
	segments := []models.TranscriptionSegment{{SpeakerID: &a, StartOffsetMs: 0, EndOffsetMs: 20000}, {SpeakerID: &a, StartOffsetMs: 30000, EndOffsetMs: 50000}, {SpeakerID: &b, StartOffsetMs: 60000, EndOffsetMs: 80000}, {SpeakerID: &b, StartOffsetMs: 90000, EndOffsetMs: 110000}}
	frames := planSpeakerCaptionFrames(segments, speakers, 24)
	var observations []speakerCaptionObservation
	for i := range frames {
		observations = append(observations, speakerCaptionObservation{FrameIndex: i, Name: "Anna", Caption: "Anna", Confidence: 1})
	}
	results := resolveSpeakerCaptionResults(frames, observations, speakers, segments, true)
	if len(results) == 0 {
		t.Fatal("expected a review suggestion")
	}
	for _, result := range results {
		if result.Applied || !result.Conflict || result.Confidence > 0.6 {
			t.Fatalf("ambiguous audio mapping: %+v", result)
		}
	}
}

func TestSpeakerCaptionSamplingCoversFirstShortAndLaterTurns(t *testing.T) {
	id := uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}}
	segments := []models.TranscriptionSegment{
		{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 4000},
		{SpeakerID: &id, StartOffsetMs: 10000, EndOffsetMs: 60000},
		{SpeakerID: &id, StartOffsetMs: 70000, EndOffsetMs: 120000},
		{SpeakerID: &id, StartOffsetMs: 130000, EndOffsetMs: 150000},
	}
	frames := planSpeakerCaptionFrames(segments, speakers, 24)
	seen := map[int64]bool{}
	for _, frame := range frames {
		seen[frame.TurnStartMs] = true
		if !captionFrameMatchesSpeaker(frame, segments) {
			t.Fatal("unsafe sample")
		}
	}
	for _, start := range []int64{0, 10000, 70000, 130000} {
		if !seen[start] {
			t.Fatalf("missed turn %d", start)
		}
	}
	if frames[0].TurnStartMs != 0 {
		t.Fatal("first appearance not prioritized")
	}
}

func TestSpeakerCaptionRetriesUseViewsThenNearbyAndStayBounded(t *testing.T) {
	id := uuid.New()
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 20000}}
	first := speakerCaptionFrame{SpeakerID: id, OffsetMs: 6000, TurnStartMs: 0, TurnEndMs: 20000}
	frames := []speakerCaptionFrame{first}
	frame := first
	for _, view := range []string{"sharp", "full", "", "full"} {
		next, ok := nextSpeakerCaptionRetry(frame, speakerCaptionObservation{Reason: "no_caption"}, frames, segments)
		if !ok || next.View != view || !captionFrameMatchesSpeaker(next, segments) {
			t.Fatalf("invalid retry: %+v %v", next, ok)
		}
		frames = append(frames, next)
		frame = next
	}
	if _, ok := nextSpeakerCaptionRetry(frame, speakerCaptionObservation{}, frames, segments); ok {
		t.Fatal("retry limit exceeded")
	}
	if _, ok := nextSpeakerCaptionRetry(first, speakerCaptionObservation{Name: "Anna", Confidence: .99}, nil, segments); ok {
		t.Fatal("clear reading retried")
	}
	if _, ok := nextSpeakerCaptionRetry(first, speakerCaptionObservation{Error: "provider failed"}, nil, segments); ok {
		t.Fatal("provider failure retried as missing caption")
	}
}

func TestSpeakerCaptionAlternateViewsDoNotInflateConfidence(t *testing.T) {
	id := uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}}
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 20000}, {SpeakerID: &id, StartOffsetMs: 30000, EndOffsetMs: 50000}}
	frames := []speakerCaptionFrame{
		{SpeakerID: id, OffsetMs: 6000, TurnStartMs: 0, TurnEndMs: 20000},
		{SpeakerID: id, OffsetMs: 6000, TurnStartMs: 0, TurnEndMs: 20000, View: "sharp"},
		{SpeakerID: id, OffsetMs: 6000, TurnStartMs: 0, TurnEndMs: 20000, View: "full"},
		{SpeakerID: id, OffsetMs: 36000, TurnStartMs: 30000, TurnEndMs: 50000},
	}
	var observations []speakerCaptionObservation
	for i := range frames {
		observations = append(observations, speakerCaptionObservation{FrameIndex: i, Name: "Anna", Caption: "Anna", Confidence: .99})
	}
	results := resolveSpeakerCaptionResults(frames, observations, speakers, segments, true)
	if len(results) != 1 || results[0].Applied || len(results[0].FrameIndices) != 2 {
		t.Fatalf("alternate views counted as independent evidence: %+v", results)
	}
}

func TestSpeakerCaptionManualPositionRequiresExclusiveUnprotectedSpeaker(t *testing.T) {
	id, other := uuid.New(), uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}}
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 20000}}
	frame, err := planManualSpeakerCaptionFrame(8000, segments, speakers)
	if err != nil || frame.OffsetMs != 8000 || !frame.Manual {
		t.Fatalf("manual scan: %+v %v", frame, err)
	}
	for _, offset := range []int64{-1, 22000} {
		if _, err := planManualSpeakerCaptionFrame(offset, segments, speakers); err == nil {
			t.Fatal("invalid timestamp accepted")
		}
	}
	overlap := append(segments, models.TranscriptionSegment{SpeakerID: &other, StartOffsetMs: 7000, EndOffsetMs: 9000})
	if _, err := planManualSpeakerCaptionFrame(8000, overlap, speakers); err == nil {
		t.Fatal("overlapping speakers accepted")
	}
	speakers[0].DisplayName = "Chosen"
	speakers[0].NameSource = "manual"
	if _, err := planManualSpeakerCaptionFrame(8000, segments, speakers); err == nil {
		t.Fatal("manual name overwritten")
	}
}

func TestSpeakerCaptionMissReasonsAndUnsampledCoverage(t *testing.T) {
	id, other := uuid.New(), uuid.New()
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}, {ID: other, Label: "B"}}
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 20000}, {SpeakerID: &other, StartOffsetMs: 30000, EndOffsetMs: 50000}}
	frames := planSpeakerCaptionFrames(segments, speakers[:1], 1)
	for _, tc := range []struct{ raw, reason string }{
		{`{"name":"","caption":"","confidence":0}`, "no_caption"},
		{`{"name":"Anna","caption":"Anna","confidence":0.7}`, "uncertain_text"},
		{`{"name":"Anna","caption":"Anna and Ben","confidence":1,"ambiguous":true}`, "conflicting_names"},
	} {
		o, err := decodeSpeakerCaption(tc.raw)
		if err != nil {
			t.Fatal(err)
		}
		results := captionResultsWithCoverage(frames, []speakerCaptionObservation{o}, speakers, segments, true)
		if len(results) != 2 || results[0].Reason != tc.reason || results[1].Reason != "not_sampled" || results[0].Name != "" || results[0].Applied {
			t.Fatalf("wrong diagnostic: %+v", results)
		}
	}
}

func TestSpeakerCaptionAdaptiveQueueResumesAndHonorsTotalBudget(t *testing.T) {
	id := uuid.New()
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 60000}}
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}}
	run := speakerCaptionRun{FrameBudget: 12, Frames: planInitialSpeakerCaptionFrames(segments, speakers, 12)}
	// Simulate a worker disappearing immediately after its first durable checkpoint.
	var saved []byte
	calls := 0
	stop := fmt.Errorf("worker stopped")
	err := analyzeSpeakerCaptionFrames(context.Background(), &run, segments, func(frame speakerCaptionFrame) (speakerCaptionObservation, error) {
		calls++
		return speakerCaptionObservation{Reason: "no_caption"}, nil
	}, func() error { saved, _ = json.Marshal(run); return stop })
	if err != stop || calls != 1 {
		t.Fatalf("checkpoint failure did not stop: %v %d", err, calls)
	}
	var resumed speakerCaptionRun
	if err := json.Unmarshal(saved, &resumed); err != nil {
		t.Fatal(err)
	}
	views := map[string]bool{}
	checkpoints := 0
	err = analyzeSpeakerCaptionFrames(context.Background(), &resumed, segments, func(frame speakerCaptionFrame) (speakerCaptionObservation, error) {
		calls++
		views[frame.View] = true
		return speakerCaptionObservation{Reason: "no_caption"}, nil
	}, func() error {
		checkpoints++
		if len(resumed.Observations) > 12 || len(resumed.Frames) > 12 {
			t.Fatal("budget exceeded")
		}
		return nil
	})
	if err != nil || calls != 12 || checkpoints != 11 || !views["sharp"] || !views["full"] {
		t.Fatalf("adaptive queue: calls=%d checkpoints=%d views=%v err=%v", calls, checkpoints, views, err)
	}
}

func TestSpeakerCaptionAdaptiveQueueStopsOnCancellationAndProviderErrors(t *testing.T) {
	id := uuid.New()
	segments := []models.TranscriptionSegment{{SpeakerID: &id, StartOffsetMs: 0, EndOffsetMs: 60000}}
	speakers := []models.TranscriptionSpeaker{{ID: id, Label: "A"}}
	run := speakerCaptionRun{FrameBudget: 24, Frames: planInitialSpeakerCaptionFrames(segments, speakers, 24)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	analyze := func(frame speakerCaptionFrame) (speakerCaptionObservation, error) {
		calls++
		return speakerCaptionObservation{}, fmt.Errorf("unavailable")
	}
	if err := analyzeSpeakerCaptionFrames(ctx, &run, segments, analyze, func() error { return nil }); err != context.Canceled || calls != 0 {
		t.Fatal("cancelled job continued")
	}
	if err := analyzeSpeakerCaptionFrames(context.Background(), &run, segments, analyze, func() error { return nil }); err == nil || calls != 3 {
		t.Fatalf("provider circuit breaker: %d %v", calls, err)
	}
}

func TestSpeakerCaptionInitialPlanCoversSpeakersBeforeReservingRetries(t *testing.T) {
	var speakers []models.TranscriptionSpeaker
	var segments []models.TranscriptionSegment
	for i := 0; i < 20; i++ {
		id := uuid.New()
		speakers = append(speakers, models.TranscriptionSpeaker{ID: id, Label: id.String()})
		segments = append(segments, models.TranscriptionSegment{SpeakerID: &id, StartOffsetMs: int64(i * 30000), EndOffsetMs: int64(i*30000 + 20000)})
	}
	frames := planInitialSpeakerCaptionFrames(segments, speakers, 24)
	seen := map[uuid.UUID]bool{}
	for _, frame := range frames {
		seen[frame.SpeakerID] = true
	}
	if len(seen) != 20 || len(frames) != 20 {
		t.Fatalf("coverage sacrificed for retries: %d speakers %d frames", len(seen), len(frames))
	}
}

func TestSpeakerCaptionDiagnosticsDoNotClearExistingSuggestions(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := &App{DB: db}
	run, session, token, speaker := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT status='processing'").WithArgs(run, token).WillReturnRows(sqlmock.NewRows([]string{"active"}).AddRow(true))
	// No speaker UPDATE is allowed for a diagnostic without a recognized name.
	mock.ExpectExec("UPDATE transcription_speaker_caption_runs SET status='completed'").WithArgs(run, token, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := app.finishSpeakerCaptionRun(context.Background(), run, session, token, []speakerCaptionResult{{SpeakerID: speaker, Reason: "no_caption"}}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
