package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"justai-backend/config"
	"justai-backend/security"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"justai-backend/provider"
)

func TestFinalizeLiveWAVHasActualSize(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "audio")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.Write(liveStreamWAVHeader())
	file.Write(make([]byte, 32000))
	if err = finalizeLiveWAV(file, 32044); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 44)
	file.ReadAt(header, 0)
	if got := binary.LittleEndian.Uint32(header[4:8]); got != 32036 {
		t.Fatalf("RIFF size %d", got)
	}
	if got := binary.LittleEndian.Uint32(header[40:44]); got != 32000 {
		t.Fatalf("data size %d", got)
	}
	if err = finalizeLiveWAV(file, 44); err == nil {
		t.Fatal("empty audio accepted")
	}
}

func TestLiveProcessingKeepsCompletedStepsOnRetry(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id := uuid.New()
	mock.ExpectQuery("SELECT status, stage, diarization_status").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"status", "stage", "diarization_status", "polish_status", "error_message"}).AddRow("processing", "diarization", "completed", "skipped", ""))
	mock.ExpectQuery("SELECT diarization_endpoint_id").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"endpoint", "model", "language"}).AddRow(uuid.New(), "", "de"))
	mock.ExpectExec("UPDATE transcription_live_processing SET status='completed'").WithArgs(id).WillReturnResult(sqlmock.NewResult(0, 1))
	manager := &TranscriptionManager{DB: db}
	if err = manager.processLiveTranscript(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLiveDiarizationFailsClearlyWithoutRecording(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id := uuid.New()
	mock.ExpectQuery("SELECT id, session_id, source_id, mime_type").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"id", "session_id", "source_id", "mime_type", "bytes", "expires_at", "completed_at"}))
	manager := &TranscriptionManager{DB: db}
	if err = manager.diarizeLiveRecordings(context.Background(), id, provider.Endpoint{}, "de"); err == nil {
		t.Fatal("missing recording accepted")
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLiveDiarizationUsesSavedAudioAndPreservesText(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required")
	}
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sessionID, sourceID, recordingID, segmentID, speakerID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	key := bytes.Repeat([]byte{7}, 32)
	box := security.NewSecretBox(bytes.Repeat([]byte{9}, 32))
	wrapped, err := box.Encrypt(base64.RawStdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	directory := filepath.Join(root, "recording")
	os.Mkdir(directory, 0700)
	wav := append(liveStreamWAVHeader(), make([]byte, 32000)...)
	binary.LittleEndian.PutUint32(wav[4:8], uint32(len(wav)-8))
	binary.LittleEndian.PutUint32(wav[40:44], 32000)
	sealed, err := sealAudioChunk(key, wav)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(directory, "part-00000000.enc"), sealed, 0600)
	var stored []byte
	var deleted, called bool
	storageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "PUT":
			stored, _ = io.ReadAll(r.Body)
			w.WriteHeader(200)
		case "DELETE":
			deleted = true
			w.WriteHeader(204)
		case "GET":
			if r.URL.Query().Get("list-type") != "" {
				io.WriteString(w, "<ListBucketResult/>")
			} else {
				w.Header().Set("Content-Type", "audio/wav")
				w.Write(stored)
			}
		}
	}))
	defer storageServer.Close()
	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/diarize" {
			t.Errorf("unexpected provider call: %s", r.URL.Path)
		}
		var request struct {
			URL string `json:"media_url"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		u, _ := url.Parse(request.URL)
		if u.Query().Get("X-Amz-Signature") == "" {
			t.Error("processing URL must be signed")
		}
		response, err := http.Get(request.URL)
		if err != nil {
			t.Error(err)
			return
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if len(body) != len(wav) || string(body[:4]) != "RIFF" {
			t.Error("provider did not receive recorded WAV")
		}
		called = true
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"segments":[{"speaker":"SPEAKER_00","start":0,"end":1}]}`)
	}))
	defer providerServer.Close()
	mock.ExpectQuery("SELECT id, session_id, source_id, mime_type").WithArgs(sessionID).WillReturnRows(sqlmock.NewRows([]string{"id", "session_id", "source_id", "mime_type", "bytes", "expires_at", "completed_at"}).AddRow(recordingID, sessionID, sourceID, "audio/wav", len(wav), nil, now))
	mock.ExpectQuery("SELECT id, session_id, source_id, speaker_id, text").WithArgs(sessionID).WillReturnRows(sqlmock.NewRows([]string{"id", "session_id", "source_id", "speaker_id", "text", "raw_text", "polished_text", "edited_text", "start_offset_ms", "end_offset_ms", "confidence", "signal_quality", "canonical", "heard_by_source_ids", "created_at", "updated_at"}).AddRow(segmentID, sessionID, sourceID, nil, "Keep these words", "Keep these words", nil, nil, 0, 1000, nil, nil, true, []byte("[]"), now, now))
	mock.ExpectQuery("SELECT storage_driver, storage_key, mime_type").WithArgs(recordingID).WillReturnRows(sqlmock.NewRows([]string{"driver", "key", "mime", "wrapped"}).AddRow("local", "recording", "audio/wav", wrapped))
	mock.ExpectQuery("INSERT INTO transcription_speakers").WithArgs(sessionID, "Source 1 · SPEAKER_00", sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(speakerID))
	mock.ExpectExec("UPDATE transcription_segments SET speaker_id").WithArgs(segmentID, speakerID, sessionID).WillReturnResult(sqlmock.NewResult(0, 1))
	cfg := config.Config{Transcription: config.TranscriptionConfig{LocalStoragePath: root, S3Endpoint: storageServer.URL, S3ProcessingEndpoint: storageServer.URL, S3Bucket: "test", S3AccessKey: "test", S3SecretKey: "test"}}
	app := &App{DB: db, Config: cfg, Secrets: box}
	manager := &TranscriptionManager{DB: db, Config: cfg, Secrets: box, app: app}
	if err = manager.diarizeLiveRecordings(context.Background(), sessionID, provider.Endpoint{ProviderType: "pyannote", BaseURL: providerServer.URL, AllowPrivate: true}, "de"); err != nil {
		t.Fatal(err)
	}
	if !called || !deleted {
		t.Fatalf("provider called=%v; temporary media deleted=%v", called, deleted)
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLiveProcessingStopsBeforePolishOnSpeakerFailure(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id, endpointID := uuid.New(), uuid.New()
	mock.ExpectQuery("SELECT status, stage, diarization_status").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"status", "stage", "diarization_status", "polish_status", "error_message"}).AddRow("processing", "recording", "queued", "queued", ""))
	mock.ExpectQuery("SELECT diarization_endpoint_id").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"endpoint", "model", "language"}).AddRow(endpointID, "", "de"))
	mock.ExpectExec("UPDATE transcription_live_processing SET stage").WithArgs(id, "diarization").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT provider_type, base_url").WithArgs(endpointID).WillReturnRows(sqlmock.NewRows([]string{"type", "url", "path", "version", "chat", "vision", "image", "embedding", "transcription", "diarization", "speech", "capabilities", "credential", "timeout", "tokens", "temperature"}).AddRow("pyannote", "http://localhost:1234", "", "", "", "", "", "", "", "", "", []byte(`{"diarization":true}`), nil, 60, 1000, 0))
	mock.ExpectQuery("SELECT id, session_id, source_id, mime_type").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"id", "session_id", "source_id", "mime_type", "bytes", "expires_at", "completed_at"}))
	app := &App{DB: db, Config: config.Config{AllowPrivate: true}}
	manager := &TranscriptionManager{DB: db, app: app}
	if err = manager.processLiveTranscript(context.Background(), id); err == nil {
		t.Fatal("missing audio should fail speaker processing")
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLiveProcessingContinuesToPolishAfterSpeakerSkip(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	id, endpointID := uuid.New(), uuid.New()
	mock.ExpectQuery("SELECT status, stage, diarization_status").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"status", "stage", "diarization_status", "polish_status", "error_message"}).AddRow("processing", "diarization", "skipped", "queued", ""))
	mock.ExpectQuery("SELECT diarization_endpoint_id").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"endpoint", "model", "language"}).AddRow(uuid.New(), "", "de"))
	mock.ExpectExec("UPDATE transcription_live_processing SET stage").WithArgs(id, "grammar").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT grammar_endpoint_id").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"endpoint", "model"}).AddRow(endpointID, ""))
	mock.ExpectQuery("SELECT provider_type, base_url").WithArgs(endpointID).WillReturnRows(sqlmock.NewRows([]string{"type", "url", "path", "version", "chat", "vision", "image", "embedding", "transcription", "diarization", "speech", "capabilities", "credential", "timeout", "tokens", "temperature"}).AddRow("mock", "http://localhost:1234", "", "", "", "", "", "", "", "", "", []byte(`{"chat":true}`), nil, 60, 1000, 0))
	mock.ExpectQuery("SELECT id, session_id, source_id, speaker_id, text").WithArgs(id).WillReturnRows(sqlmock.NewRows([]string{"id", "session_id", "source_id", "speaker_id", "text", "raw_text", "polished_text", "edited_text", "start_offset_ms", "end_offset_ms", "confidence", "signal_quality", "canonical", "heard_by_source_ids", "created_at", "updated_at"}))
	mock.ExpectExec("UPDATE transcription_sessions SET polish_status").WithArgs(id, "processing").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_segments SET polished_text = NULL").WithArgs(id).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("UPDATE transcription_sessions SET polish_status").WithArgs(id, "completed").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_live_processing SET polish_status='completed'").WithArgs(id).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE transcription_live_processing SET status='completed'").WithArgs(id).WillReturnResult(sqlmock.NewResult(0, 1))
	app := &App{DB: db}
	manager := &TranscriptionManager{DB: db, app: app}
	if err = manager.processLiveTranscript(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
