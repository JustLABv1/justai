package server

import (
	"bytes"
	"context"
	"encoding/json"
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
	if len(frames) != 4 {
		t.Fatalf("want four samples: %+v", frames)
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
	if len(frames) != 2 {
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
	data, err := extractSpeakerCaptionFrame(context.Background(), server.URL+"/fixture.mp4", 500)
	if err != nil {
		t.Fatal(err)
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "jpeg" || config.Width != 960 || config.Height != 270 {
		t.Fatalf("unexpected crop: %+v %s %v", config, format, err)
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
