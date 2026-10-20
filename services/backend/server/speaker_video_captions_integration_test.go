//go:build integration

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"justai-backend/config"
	"justai-backend/database"
)

// This test uses a dedicated database and synthetic media/model responses. It
// exercises the actual FFmpeg -> vision transport -> durable job -> speaker path.
func TestSpeakerCaptionDurablePipelineIntegration(t *testing.T) {
	dsn := os.Getenv("JUSTAI_CAPTION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("dedicated caption test database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = database.RunMigrations(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err = database.RunMigrations(ctx, db); err != nil {
		t.Fatal("migration restart:", err)
	}
	file := filepath.Join(t.TempDir(), "source.mp4")
	if output, err := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=55", "-r", "1", "-c:v", "mpeg4", "-y", file).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	var requests atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, file) }))
	defer media.Close()
	vision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": `{"name":"Anna Müller","caption":"Anna Müller, SPD","confidence":0.99}`}}}})
		w.Write([]byte("data: " + string(chunk) + "\n\ndata: [DONE]\n\n"))
	}))
	defer vision.Close()
	user, org, session, upload, endpoint, speaker := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	execute := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	execute(`INSERT INTO users(id,email,display_name) VALUES($1,$2,'Caption test')`, user, user.String()+"@test.invalid")
	execute(`INSERT INTO organizations(id,name,slug) VALUES($1,'Caption test',$2)`, org, org.String())
	defer db.ExecContext(context.Background(), `DELETE FROM users WHERE id=$1`, user)
	defer db.ExecContext(context.Background(), `DELETE FROM organizations WHERE id=$1`, org)
	execute(`INSERT INTO endpoint_settings(id,scope_type,provider_type,name,base_url,chat_model,vision_model,capabilities) VALUES($1,'global','openai-compatible','Caption test',$2,'test','test','{"vision":true,"chat":true}')`, endpoint, vision.URL)
	defer db.ExecContext(context.Background(), `DELETE FROM endpoint_settings WHERE id=$1`, endpoint)
	execute(`INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')`, org, user)
	execute(`INSERT INTO transcription_sessions(id,user_id,organization_id,title,status) VALUES($1,$2,$3,'Caption test','completed')`, session, user, org)
	execute(`INSERT INTO transcription_video_uploads(id,session_id,storage_driver,storage_key,multipart_upload_id,file_name,mime_type,expected_bytes,bytes,part_size,part_count,status) VALUES($1,$2,'s3',$3,'done','source.mp4','video/mp4',100,100,5242880,1,'completed')`, upload, session, upload.String())
	execute(`INSERT INTO transcription_speakers(id,session_id,label) VALUES($1,$2,'SPEAKER_00')`, speaker, session)
	for _, start := range []int64{0, 30000} {
		execute(`INSERT INTO transcription_segments(session_id,speaker_id,text,start_offset_ms,end_offset_ms) VALUES($1,$2,'Test speech',$3,$4)`, session, speaker, start, start+20000)
	}
	a := New(config.Config{AllowPrivate: true, Transcription: config.TranscriptionConfig{S3Endpoint: media.URL, S3ProcessingEndpoint: media.URL, S3Region: "test", S3Bucket: "test", S3AccessKey: "test", S3SecretKey: "test"}, EncryptionKey: []byte("caption-test-key")}, db)
	speakers, err := loadTranscriptionSpeakers(ctx, db, session)
	if err != nil {
		t.Fatal(err)
	}
	segments, err := loadTranscriptionSegments(ctx, db, session)
	if err != nil {
		t.Fatal(err)
	}
	frames := planSpeakerCaptionFrames(segments, speakers, 24)
	encoded, _ := json.Marshal(frames)
	runID := uuid.New()
	insert := func(id uuid.UUID) {
		execute(`INSERT INTO transcription_speaker_caption_runs(id,session_id,upload_id,endpoint_id,requested_by,organization_id,model,auto_apply,frame_budget,frames) VALUES($1,$2,$3,$4,$5,$6,'test',true,24,$7)`, id, session, upload, endpoint, user, org, encoded)
	}
	newContext := func(method, path, body string) (*gin.Context, *httptest.ResponseRecorder) {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(method, path, strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = gin.Params{{Key: "id", Value: session.String()}}
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
		c.Set(middleware.OrgIDKey, org)
		return c, recorder
	}
	requestBody := fmt.Sprintf(`{"endpointId":%q,"frameBudget":24,"autoApply":true}`, endpoint.String())
	c, recorder := newContext("POST", "/", requestBody)
	a.createSpeakerCaptionRun(c)
	if recorder.Code != 202 {
		t.Fatalf("create API: %d %s", recorder.Code, recorder.Body.String())
	}
	var created struct {
		Run speakerCaptionRun `json:"run"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	runID = created.Run.ID
	c, recorder = newContext("POST", "/", requestBody)
	a.createSpeakerCaptionRun(c)
	if recorder.Code != 409 {
		t.Fatalf("duplicate API: %d %s", recorder.Code, recorder.Body.String())
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO transcription_speaker_caption_runs SELECT $1,session_id,upload_id,endpoint_id,requested_by,organization_id,model,auto_apply,frame_budget,status,frames,observations,results,error_message,attempts,lease_token,lease_until,created_at,updated_at FROM transcription_speaker_caption_runs WHERE id=$2`, uuid.New(), runID); err == nil {
		t.Fatal("parallel run for same session accepted")
	}
	run, token, err := a.claimSpeakerCaptionRun(ctx)
	if err != nil || run.ID != runID {
		t.Fatalf("claim: %+v %v", run, err)
	}
	if _, _, err = a.claimSpeakerCaptionRun(ctx); err == nil {
		t.Fatal("two replicas claimed work simultaneously")
	}
	// Persist a first observation, then simulate an expired worker lease.
	first := []speakerCaptionObservation{{FrameIndex: 0, Name: "Anna Müller", Caption: "Anna Müller, SPD", Confidence: .99}}
	checkpoint, _ := json.Marshal(first)
	execute(`UPDATE transcription_speaker_caption_runs SET observations=$2,lease_until=now()-interval '1 second' WHERE id=$1`, runID, checkpoint)
	resumed, newToken, err := a.claimSpeakerCaptionRun(ctx)
	if err != nil || len(resumed.Observations) != 1 || newToken == token {
		t.Fatalf("resume: %+v %v", resumed, err)
	}
	if err = a.finishSpeakerCaptionRun(ctx, runID, session, token, nil); err == nil {
		t.Fatal("expired worker committed")
	}
	if err = a.runSpeakerCaptionAnalysis(ctx, &resumed, newToken); err != nil {
		t.Fatal(err)
	}
	var name, source, status string
	if err = db.QueryRowContext(ctx, `SELECT display_name,name_source FROM transcription_speakers WHERE id=$1`, speaker).Scan(&name, &source); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(ctx, `SELECT status FROM transcription_speaker_caption_runs WHERE id=$1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if name != "Anna Müller" || source != "ai" || status != "completed" || requests.Load() != 3 {
		t.Fatalf("pipeline result: %s %s %s, %d model requests", name, source, status, requests.Load())
	}
	c, recorder = newContext("GET", "/", "")
	c.Params = append(c.Params, gin.Param{Key: "runId", Value: runID.String()}, gin.Param{Key: "frameIndex", Value: "0"})
	a.speakerCaptionImage(c)
	if recorder.Code != 200 || recorder.Header().Get("Content-Type") != "image/jpeg" || !bytes.HasPrefix(recorder.Body.Bytes(), []byte{0xff, 0xd8}) {
		t.Fatalf("evidence API: %d %s", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	cancelID := uuid.New()
	insert(cancelID)
	c, recorder = newContext("DELETE", "/", "")
	c.Params = append(c.Params, gin.Param{Key: "runId", Value: cancelID.String()})
	a.cancelSpeakerCaptionRun(c)
	c.Writer.WriteHeaderNow()
	if recorder.Code != 204 {
		t.Fatalf("cancel API: %d", recorder.Code)
	}
	if _, _, err := a.claimSpeakerCaptionRun(ctx); err == nil {
		t.Fatal("cancelled analysis was claimed")
	}
	// Automatic upload step: queue from saved settings, wait for the independent
	// caption worker, persist measured progress, and reuse the linked completed
	// run when the video worker is restarted at the same stage.
	options := &videoCaptionOptions{EndpointID: endpoint, FrameBudget: 24, AutoApply: true}
	if err := a.validateVideoCaptionOptions(ctx, options, middleware.Principal{UserID: user}, org, session); err == nil {
		t.Fatal("caption upload options accepted without diarization")
	}
	execute(`UPDATE transcription_sessions SET diarization_endpoint_id=$2 WHERE id=$1`, session, endpoint)
	if err := a.validateVideoCaptionOptions(ctx, options, middleware.Principal{UserID: user}, org, session); err != nil {
		t.Fatal(err)
	}
	optionJSON, _ := json.Marshal(options)
	execute(`UPDATE transcription_video_uploads SET caption_options=$2,caption_run_id=NULL,status='processing',stage='diarizing' WHERE id=$1`, upload, optionJSON)
	pipelineDone := make(chan error, 1)
	go func() { pipelineDone <- a.Live.processVideoCaptionStep(ctx, upload, session) }()
	var pipelineRun speakerCaptionRun
	var pipelineToken uuid.UUID
	for {
		pipelineRun, pipelineToken, err = a.claimSpeakerCaptionRun(ctx)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		time.Sleep(10 * time.Millisecond)
	}
	a.processSpeakerCaptionRun(ctx, pipelineRun, pipelineToken)
	if err := <-pipelineDone; err != nil {
		t.Fatal(err)
	}
	before := requests.Load()
	if err := a.Live.processVideoCaptionStep(ctx, upload, session); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != before {
		t.Fatal("video worker restart repeated paid vision requests")
	}
	var pipelineJSON []byte
	if err := db.QueryRowContext(ctx, `SELECT pipeline_steps FROM transcription_video_uploads WHERE id=$1`, upload).Scan(&pipelineJSON); err != nil {
		t.Fatal(err)
	}
	steps := decodeVideoPipeline(pipelineJSON)
	names := steps[videoPipelineIndex("speaker_names")]
	if names.Status != "completed" || names.Parallel == nil || names.Parallel.CompletedSlices != 4 || names.Parallel.SliceCount != 4 {
		t.Fatalf("automatic step progress: %+v", names)
	}
	// An explicit retry starts at names and preserves ASR and diarization.
	execute(`UPDATE transcription_video_uploads SET status='completed',stage='completed' WHERE id=$1`, upload)
	_, retried, err := a.Live.retryVideoJob(ctx, upload, "speaker_names")
	if err != nil || retried.Stage != "queued" {
		t.Fatalf("names retry: stage=%s err=%v", retried.Stage, err)
	}
	var segmentCount, speakerCount int
	db.QueryRowContext(ctx, `SELECT count(*) FROM transcription_segments WHERE session_id=$1`, session).Scan(&segmentCount)
	db.QueryRowContext(ctx, `SELECT count(*) FROM transcription_speakers WHERE session_id=$1`, session).Scan(&speakerCount)
	if segmentCount != 2 || speakerCount != 1 {
		t.Fatalf("retry discarded earlier work: %d segments, %d speakers", segmentCount, speakerCount)
	}
	// A repeatedly interrupted final job must leave the queue even when there is
	// no following job to claim (the cleanup transaction still has to commit).
	retryID := uuid.New()
	insert(retryID)
	execute(`UPDATE transcription_speaker_caption_runs SET status='processing',attempts=3,lease_until=now()-interval '1 second' WHERE id=$1`, retryID)
	a.claimSpeakerCaptionRun(ctx)
	if err = db.QueryRowContext(ctx, `SELECT status FROM transcription_speaker_caption_runs WHERE id=$1`, retryID).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("retry cleanup: %s %v", status, err)
	}
}
