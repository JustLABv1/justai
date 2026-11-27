package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type liveProcessing struct {
	Status            string `json:"status"`
	Stage             string `json:"stage"`
	DiarizationStatus string `json:"diarizationStatus"`
	PolishStatus      string `json:"polishStatus"`
	Error             string `json:"error,omitempty"`
}

func loadLiveProcessing(ctx context.Context, db *sql.DB, id uuid.UUID) (*liveProcessing, error) {
	var p liveProcessing
	err := db.QueryRowContext(ctx, `SELECT status, stage, diarization_status, polish_status, error_message FROM transcription_live_processing WHERE session_id=$1`, id).Scan(&p.Status, &p.Stage, &p.DiarizationStatus, &p.PolishStatus, &p.Error)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &p, err
}

// Persisted jobs survive restarts. A lease exceeds the bounded processing
// timeout so a second worker cannot concurrently label the same transcript.
func (m *TranscriptionManager) liveProcessingLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		// If capture stopped during a restart, all committed audio parts remain
		// usable. Seal orphan recordings only after the capture has been terminal
		// for a minute, allowing normal final uploads to finish first.
		_, _ = m.DB.ExecContext(ctx, `UPDATE transcription_recordings r SET completed_at=now() FROM transcription_sessions s WHERE r.session_id=s.id AND s.status='completed' AND s.ended_at<now()-interval '1 minute' AND r.completed_at IS NULL`)
		var id uuid.UUID
		err := m.DB.QueryRowContext(ctx, `UPDATE transcription_live_processing SET status='processing', lease_until=now()+interval '35 minutes',updated_at=now()
   WHERE session_id=(SELECT p.session_id FROM transcription_live_processing p JOIN transcription_sessions s ON s.id=p.session_id
    WHERE s.status='completed' AND NOT EXISTS (SELECT 1 FROM transcription_video_uploads v WHERE v.session_id=s.id) AND s.started_at IS NOT NULL
     AND (p.status='queued' OR (p.status='processing' AND p.lease_until<now()))
     AND NOT EXISTS (SELECT 1 FROM transcription_recordings r WHERE r.session_id=s.id AND r.completed_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM transcription_stream_sources st JOIN transcription_sources src ON src.id=st.source_id WHERE src.session_id=s.id AND st.status NOT IN ('stopped','failed'))
     AND s.ended_at < now()-interval '5 seconds'
    ORDER BY p.updated_at FOR UPDATE OF p SKIP LOCKED LIMIT 1)
   RETURNING session_id`).Scan(&id)
		if err != nil {
			continue
		}
		workCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		err = m.processLiveTranscript(workCtx, id)
		cancel()
		if ctx.Err() != nil {
			_, _ = m.DB.Exec(`UPDATE transcription_live_processing SET status='queued',lease_until=NULL,updated_at=now() WHERE session_id=$1`, id)
			return
		}
		if err != nil {
			_, _ = m.DB.Exec(`UPDATE transcription_live_processing SET status='failed',error_message=$2,diarization_status=CASE WHEN stage='diarization' THEN 'failed' ELSE diarization_status END,polish_status=CASE WHEN stage='grammar' THEN 'failed' ELSE polish_status END,lease_until=NULL,updated_at=now() WHERE session_id=$1`, id, err.Error())
		}
		m.broadcast(id, "transcription.processing", ginData{"refresh": true})
	}
}

func (m *TranscriptionManager) setLiveProcessingStage(ctx context.Context, id uuid.UUID, stage string) error {
	result, err := m.DB.ExecContext(ctx, `UPDATE transcription_live_processing SET stage=$2,diarization_status=CASE WHEN $2='diarization' THEN 'processing' ELSE diarization_status END,polish_status=CASE WHEN $2='grammar' THEN 'processing' ELSE polish_status END,error_message='',updated_at=now() WHERE session_id=$1 AND status='processing'`, id, stage)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("processing was interrupted")
	}
	m.broadcast(id, "transcription.processing", ginData{"refresh": true})
	return nil
}

func (m *TranscriptionManager) processLiveTranscript(ctx context.Context, id uuid.UUID) error {
	p, err := loadLiveProcessing(ctx, m.DB, id)
	if err != nil {
		return err
	}
	var diarizationID uuid.NullUUID
	var model, language string
	if err = m.DB.QueryRowContext(ctx, `SELECT diarization_endpoint_id,COALESCE(diarization_model,''),language FROM transcription_sessions WHERE id=$1`, id).Scan(&diarizationID, &model, &language); err != nil {
		return err
	}
	if diarizationID.Valid && p.DiarizationStatus != "completed" && p.DiarizationStatus != "skipped" {
		if err = m.setLiveProcessingStage(ctx, id, "diarization"); err != nil {
			return err
		}
		endpoint, err := m.app.providerEndpoint(ctx, diarizationID.UUID)
		if err != nil {
			return err
		}
		endpoint.DiarizationModel = firstNonEmptyString(model, endpoint.DiarizationModel)
		if err = m.diarizeLiveRecordings(ctx, id, endpoint, language); err != nil {
			return err
		}
		// In a Bundestag sitting the chair names every speaker; carry those names over.
		if nameErr := m.nameSpeakersFromAnnouncements(ctx, id); nameErr != nil {
			slog.Warn("speakers could not be named from the announcements", "sessionId", id, "error", nameErr)
		}
		if _, err = m.DB.ExecContext(ctx, `UPDATE transcription_live_processing SET diarization_status='completed',updated_at=now() WHERE session_id=$1`, id); err != nil {
			return err
		}
	}
	if p.PolishStatus != "completed" && p.PolishStatus != "skipped" {
		if err = m.setLiveProcessingStage(ctx, id, "grammar"); err != nil {
			return err
		}
		if err = m.polishTranscriptionSession(ctx, id); err != nil {
			return err
		}
		if _, err = m.DB.ExecContext(ctx, `UPDATE transcription_live_processing SET polish_status='completed',updated_at=now() WHERE session_id=$1`, id); err != nil {
			return err
		}
	}
	_, err = m.DB.ExecContext(ctx, `UPDATE transcription_live_processing SET status='completed',stage='completed',error_message='',lease_until=NULL,updated_at=now() WHERE session_id=$1`, id)
	if err == nil && m.app != nil {
		m.app.refreshTopicTranscripts(ctx, id)
	}
	return err
}

func (m *TranscriptionManager) diarizeLiveRecordings(ctx context.Context, id uuid.UUID, endpoint provider.Endpoint, language string) error {
	recordings, err := loadTranscriptionRecordings(ctx, m.DB, id)
	if err != nil {
		return err
	}
	groups := map[uuid.UUID][]models.TranscriptionRecording{}
	sourceOrder := []uuid.UUID{}
	for _, r := range recordings {
		if r.CompletedAt != nil && r.Bytes > 44 {
			if _, exists := groups[r.SourceID]; !exists {
				sourceOrder = append(sourceOrder, r.SourceID)
			}
			groups[r.SourceID] = append(groups[r.SourceID], r)
		}
	}
	if len(groups) == 0 {
		return fmt.Errorf("speaker separation requires a completed audio recording")
	}
	segments, err := loadTranscriptionSegments(ctx, m.DB, id)
	if err != nil {
		return err
	}
	// One unreadable recording (for example an empty part left behind by an
	// interrupted capture) must not discard speaker separation for the rest.
	var audioErr error
	diarizedSources := 0
	for sourceIndex, sourceID := range sourceOrder {
		recordings := groups[sourceID]
		file, err := os.CreateTemp("", "justai-live-diarization-*.wav")
		if err != nil {
			return err
		}
		file.Close()
		err = func() error {
			defer os.Remove(file.Name())
			output, err := os.OpenFile(file.Name(), os.O_RDWR, 0600)
			if err != nil {
				return err
			}
			defer output.Close()
			if _, err = output.Write(liveStreamWAVHeader()); err != nil {
				return err
			}
			for _, r := range recordings {
				written, decodeErr := m.decodeRecordingPCM(ctx, r.ID, output)
				if decodeErr != nil {
					if ctx.Err() != nil {
						return ctx.Err()
					}
					// Partially decoded audio is still aligned with its segments,
					// so it stays; only the failure is recorded.
					slog.Warn("live recording skipped for speaker separation", "sessionId", id, "recordingId", r.ID, "decodedBytes", written, "error", decodeErr)
					audioErr = decodeErr
				}
			}
			stat, err := output.Stat()
			if err != nil {
				return err
			}
			if stat.Size() <= 44 {
				return errLiveSourceWithoutAudio
			}
			if err = finalizeLiveWAV(output, stat.Size()); err != nil {
				return err
			}
			var turns []provider.DiarizationSegment
			if endpoint.ProviderType == "pyannote" {
				storage, err := newS3Storage(m.Config)
				if err != nil {
					return fmt.Errorf("whole-recording speaker separation requires configured S3 processing storage: %w", err)
				}
				prefix := "transcription-processing/" + id.String() + "/"
				if err = storage.deletePrefix(ctx, prefix); err != nil {
					return err
				}
				key := prefix + uuid.NewString() + ".wav"
				if _, err = output.Seek(0, 0); err != nil {
					return err
				}
				hash := sha256.New()
				if _, err = io.Copy(hash, output); err != nil {
					return err
				}
				output.Seek(0, 0)
				response, err := storage.requestReader(ctx, http.MethodPut, key, nil, output, stat.Size(), "audio/wav", fmt.Sprintf("%x", hash.Sum(nil)))
				if err != nil {
					return err
				}
				err = readS3Response(response)
				response.Body.Close()
				if err != nil {
					return err
				}
				defer func() {
					cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					defer cancel()
					_ = storage.delete(cleanup, key)
				}()
				turns, err = provider.DiarizeMediaURL(ctx, endpoint, storage.presignProcessingURL(http.MethodGet, key, nil, videoProcessingURLLifetime), language)
				if err != nil {
					return err
				}
			} else {
				output.Seek(44, 0)
				buffer := make([]byte, 60*16000*2)
				offset := float64(0)
				for {
					n, readErr := io.ReadFull(output, buffer)
					if n > 0 {
						part, err := provider.Diarize(ctx, endpoint, buffer[:n], language)
						if err != nil {
							return err
						}
						for _, turn := range part {
							turn.Start += offset
							turn.End += offset
							turns = append(turns, turn)
						}
						offset += float64(n) / 32000
					}
					if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
						break
					}
					if readErr != nil {
						return readErr
					}
				}
			}
			// Prefix source-local labels so simultaneous sources do not get merged.
			for i := range turns {
				turns[i].Speaker = fmt.Sprintf("Source %d · %s", sourceIndex+1, turns[i].Speaker)
			}
			selected := []models.TranscriptionSegment{}
			for _, segment := range segments {
				if segment.SourceID != nil && *segment.SourceID == sourceID {
					segment.SourceID = nil
					selected = append(selected, segment)
				}
			}
			return m.applyVideoDiarizationTurns(ctx, id, selected, turns)
		}()
		if errors.Is(err, errLiveSourceWithoutAudio) {
			slog.Warn("source has no decodable audio for speaker separation", "sessionId", id, "sourceId", sourceID)
			continue
		}
		if err != nil {
			return err
		}
		diarizedSources++
	}
	if diarizedSources == 0 {
		if audioErr != nil {
			return audioErr
		}
		return fmt.Errorf("audio recording contains no samples")
	}
	return nil
}

var (
	errLiveSourceWithoutAudio = errors.New("source recording contains no decodable audio")
	errRecordingWithoutData   = errors.New("the stored recording contains no audio data; its parts may be missing from storage")
)

// decodeRecordingPCM streams one stored recording through ffmpeg and appends
// 16 kHz mono s16le samples to output. It returns how many PCM bytes were
// written, even on failure, so callers can keep partially decoded audio.
func (m *TranscriptionManager) decodeRecordingPCM(ctx context.Context, recordingID uuid.UUID, output io.Writer) (int64, error) {
	reader, _, err := m.recordingReader(ctx, recordingID)
	if err != nil {
		return 0, fmt.Errorf("recorded audio could not be opened: %w", err)
	}
	defer reader.Close()
	return decodePCMStream(ctx, reader, output)
}

func decodePCMStream(ctx context.Context, reader io.Reader, output io.Writer) (int64, error) {
	// ffmpeg reports empty input only as a generic "invalid data" exit status
	// (183), so check for data up front to name the real problem.
	buffered := bufio.NewReaderSize(reader, 64*1024)
	source := &trackingReader{reader: buffered}
	if _, err := buffered.Peek(1); err != nil {
		if errors.Is(err, io.EOF) {
			return 0, errRecordingWithoutData
		}
		return 0, fmt.Errorf("recorded audio could not be read: %w", err)
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 0, err
	}
	written := &countingWriter{writer: output}
	stderr := &cappedBuffer{limit: 4096}
	cmd.Stdout = written
	cmd.Stderr = stderr
	if err = cmd.Start(); err != nil {
		return 0, fmt.Errorf("ffmpeg could not be started: %w", err)
	}
	copied := make(chan struct{})
	go func() {
		defer close(copied)
		// Write errors only mean ffmpeg exited early; Wait reports why.
		_, _ = io.Copy(stdin, source)
		_ = stdin.Close()
	}()
	waitErr := cmd.Wait()
	<-copied
	// A storage or decryption failure would otherwise surface only as
	// ffmpeg's reaction to truncated input.
	if source.err != nil {
		return written.n, fmt.Errorf("recorded audio could not be read: %w", source.err)
	}
	if waitErr != nil {
		if detail := lastLine(stderr.String()); detail != "" {
			return written.n, fmt.Errorf("recorded audio could not be decoded: %s (%w)", detail, waitErr)
		}
		return written.n, fmt.Errorf("recorded audio could not be decoded: %w", waitErr)
	}
	return written.n, nil
}

type trackingReader struct {
	reader io.Reader
	err    error
}

func (r *trackingReader) Read(target []byte) (int, error) {
	n, err := r.reader.Read(target)
	if err != nil && !errors.Is(err, io.EOF) && r.err == nil {
		r.err = err
	}
	return n, err
}

type countingWriter struct {
	writer io.Writer
	n      int64
}

func (w *countingWriter) Write(data []byte) (int, error) {
	n, err := w.writer.Write(data)
	w.n += int64(n)
	return n, err
}

type cappedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	if room := b.limit - b.Len(); room > 0 {
		if len(data) > room {
			_, _ = b.Buffer.Write(data[:room])
		} else {
			_, _ = b.Buffer.Write(data)
		}
	}
	return len(data), nil
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func (a *App) controlLiveProcessing(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, 400, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	if err = a.authorizeTranscriptionSession(c, id, principal.UserID, organizationID); err != nil {
		writeError(c, 404, err)
		return
	}
	action := c.Query("action")
	var result sql.Result
	if action == "skip" {
		result, err = a.DB.ExecContext(c, `UPDATE transcription_live_processing SET status='queued',failure_notified_at=NULL,diarization_status=CASE WHEN stage='diarization' THEN 'skipped' ELSE diarization_status END,polish_status=CASE WHEN stage='grammar' THEN 'skipped' ELSE polish_status END,error_message='',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND status='failed'`, id)
	} else if action == "retry" {
		result, err = a.DB.ExecContext(c, `UPDATE transcription_live_processing SET status='queued',failure_notified_at=NULL,error_message='',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND status='failed'`, id)
	} else {
		writeError(c, 400, fmt.Errorf("choose retry or skip"))
		return
	}
	if err != nil {
		writeError(c, 500, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		writeError(c, 409, fmt.Errorf("only failed processing steps can be retried or skipped"))
		return
	}
	if action == "skip" {
		_, _ = a.DB.ExecContext(c, `UPDATE transcription_sessions SET polish_status='not_requested',updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM transcription_live_processing WHERE session_id=$1 AND stage='grammar' AND polish_status='skipped')`, id)
	}
	p, err := loadLiveProcessing(c, a.DB, id)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, gin.H{"liveProcessing": p})
}

func finalizeLiveWAV(file *os.File, size int64) error {
	if size <= 44 || size > int64(^uint32(0)) {
		return fmt.Errorf("recorded WAV size is invalid")
	}
	header := liveStreamWAVHeader()
	binary.LittleEndian.PutUint32(header[4:8], uint32(size-8))
	binary.LittleEndian.PutUint32(header[40:44], uint32(size-44))
	_, err := file.WriteAt(header, 0)
	return err
}

func (a *App) configureLiveProcessing(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, 400, err)
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	org, _ := middleware.GetOrganizationID(c)
	if err = a.authorizeTranscriptionSession(c, id, principal.UserID, org); err != nil {
		writeError(c, 404, err)
		return
	}
	var request struct {
		DiarizationEndpoint string `json:"diarizationEndpointId"`
		GrammarEndpoint     string `json:"grammarEndpointId"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	diarizationID, grammarID := uuid.Nil, uuid.Nil
	if request.DiarizationEndpoint != "" {
		diarizationID, err = a.resolveTranscriptionEndpoint(c, principal.UserID, org, request.DiarizationEndpoint, "diarization")
		if err != nil {
			writeError(c, 400, err)
			return
		}
		endpoint, err := a.getEndpoint(c, diarizationID)
		if err != nil {
			writeError(c, 400, err)
			return
		}
		if endpoint.ProviderType == "pyannote" {
			if _, err = newS3Storage(a.Config); err != nil {
				writeError(c, 400, fmt.Errorf("whole-recording speaker separation requires configured S3 processing storage"))
				return
			}
		}
	}
	if request.GrammarEndpoint != "" {
		grammarID, err = a.resolveTranscriptionEndpoint(c, principal.UserID, org, request.GrammarEndpoint, "chat")
		if err != nil {
			writeError(c, 400, err)
			return
		}
	}
	tx, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(c, `UPDATE transcription_sessions SET diarization_endpoint_id=NULLIF($2,'00000000-0000-0000-0000-000000000000'::uuid),grammar_endpoint_id=NULLIF($3,'00000000-0000-0000-0000-000000000000'::uuid),diarization_model=NULL,grammar_model=NULL,record_audio=CASE WHEN $2<>'00000000-0000-0000-0000-000000000000'::uuid THEN true ELSE record_audio END,polish_status=CASE WHEN $3='00000000-0000-0000-0000-000000000000'::uuid THEN 'not_requested' ELSE 'queued' END,updated_at=now() WHERE id=$1 AND status='waiting' AND started_at IS NULL AND NOT EXISTS(SELECT 1 FROM transcription_video_uploads WHERE session_id=$1)`, id, diarizationID, grammarID)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		writeError(c, 409, fmt.Errorf("processing settings can only be changed before capture starts"))
		return
	}
	if diarizationID != uuid.Nil || grammarID != uuid.Nil {
		_, err = tx.ExecContext(c, `INSERT INTO transcription_live_processing(session_id,diarization_status,polish_status) VALUES($1,CASE WHEN $2 THEN 'queued' ELSE 'skipped' END,CASE WHEN $3 THEN 'queued' ELSE 'skipped' END) ON CONFLICT(session_id) DO UPDATE SET status='queued',stage='recording',diarization_status=EXCLUDED.diarization_status,polish_status=EXCLUDED.polish_status,error_message='',updated_at=now()`, id, diarizationID != uuid.Nil, grammarID != uuid.Nil)
	} else {
		_, err = tx.ExecContext(c, `DELETE FROM transcription_live_processing WHERE session_id=$1`, id)
	}
	if err != nil {
		writeError(c, 500, err)
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(c, 500, err)
		return
	}
	snapshot, err := a.transcriptionSnapshot(c, id)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, snapshot)
}
