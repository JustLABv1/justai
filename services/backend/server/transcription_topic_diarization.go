package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
)

// topicDiarizationTimeout bounds speaker separation of one agenda item.
const topicDiarizationTimeout = 30 * time.Minute

// topicDiarizationMinAudioMs skips items too short to tell voices apart.
const topicDiarizationMinAudioMs = 5_000

var topicDiarizations sync.Map

var errPCMRangeComplete = errors.New("the requested audio range is complete")

// pcmRangeWriter keeps the bytes [skip, skip+remaining) of a PCM stream written
// across several recordings and reports errPCMRangeComplete once it has them all.
type pcmRangeWriter struct {
	writer    io.Writer
	skip      int64
	remaining int64
}

func (w *pcmRangeWriter) Write(data []byte) (int, error) {
	n := len(data)
	if w.skip > 0 {
		k := min(w.skip, int64(len(data)))
		w.skip -= k
		data = data[k:]
	}
	if len(data) > 0 && w.remaining > 0 {
		k := min(w.remaining, int64(len(data)))
		if _, err := w.writer.Write(data[:k]); err != nil {
			return 0, err
		}
		w.remaining -= k
	}
	if w.remaining == 0 {
		return n, errPCMRangeComplete
	}
	return n, nil
}

// diarizeTopicTranscriptLater separates the speakers of a finished topic's own
// transcript in the background, once per topic at a time.
func (m *TranscriptionManager) diarizeTopicTranscriptLater(sessionID, topicID uuid.UUID) {
	if _, running := topicDiarizations.LoadOrStore(topicID, struct{}{}); running {
		return
	}
	go func() {
		defer topicDiarizations.Delete(topicID)
		ctx, cancel := context.WithTimeout(context.Background(), topicDiarizationTimeout)
		defer cancel()
		if err := m.diarizeTopicTranscript(ctx, topicID); err != nil {
			slog.Warn("topic speaker separation failed", "sessionId", sessionID, "topicId", topicID, "error", err)
			return
		}
		m.broadcastTopic(sessionID, topicID)
	}()
}

// diarizeTopicTranscript gives a finished topic's own transcript its speakers right
// away. The sitting itself is separated only once capture ends, which can be hours
// after an agenda item finished. The audio of the item is cut from the sitting's
// recording, separated, and its voices are named from the chair's announcements.
//
// The copy stays "untouched" afterwards, so the final processing of the sitting can
// still replace it with the sitting-wide result (consistent voices across items).
func (m *TranscriptionManager) diarizeTopicTranscript(ctx context.Context, topicID uuid.UUID) error {
	var (
		parentID         uuid.UUID
		sourceID, copyID uuid.NullUUID
		start, end       sql.NullInt64
		syncedAt         sql.NullTime
	)
	err := m.DB.QueryRowContext(ctx, `SELECT session_id, source_id, started_offset_ms, ended_offset_ms, transcript_session_id, transcript_synced_at
		FROM transcription_topics WHERE id = $1 AND status = 'done' AND detected_by <> 'missed'`, topicID).
		Scan(&parentID, &sourceID, &start, &end, &copyID, &syncedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !copyID.Valid || !syncedAt.Valid || !start.Valid || !end.Valid || end.Int64-start.Int64 < topicDiarizationMinAudioMs {
		return nil
	}

	// Only when speaker separation was asked for and the sitting has not done it yet;
	// afterwards the copy is rebuilt from the sitting's own result.
	var (
		diarizationID   uuid.NullUUID
		model, language string
		pending         bool
	)
	if err := m.DB.QueryRowContext(ctx, `SELECT s.diarization_endpoint_id, COALESCE(s.diarization_model, ''), s.language,
		COALESCE(p.diarization_status IN ('queued', 'failed'), FALSE)
		FROM transcription_sessions s LEFT JOIN transcription_live_processing p ON p.session_id = s.id WHERE s.id = $1`, parentID).
		Scan(&diarizationID, &model, &language, &pending); err != nil {
		return err
	}
	if !diarizationID.Valid || !pending {
		return nil
	}
	if touched, err := m.topicTranscriptTouched(ctx, copyID.UUID, syncedAt.Time); err != nil || touched {
		return err
	}

	recordings, err := loadTranscriptionRecordings(ctx, m.DB, parentID)
	if err != nil {
		return err
	}
	// The recording of one source is cut; a topic over several sources waits for the
	// sitting's processing, which keeps their voices apart.
	var audioSource uuid.UUID
	for _, r := range recordings {
		if sourceID.Valid && r.SourceID != sourceID.UUID {
			continue
		}
		if audioSource == uuid.Nil {
			audioSource = r.SourceID
		} else if r.SourceID != audioSource {
			return nil
		}
	}
	if audioSource == uuid.Nil {
		return nil
	}

	endpoint, err := m.app.providerEndpoint(ctx, diarizationID.UUID)
	if err != nil {
		return err
	}
	endpoint.DiarizationModel = firstNonEmptyString(model, endpoint.DiarizationModel)

	file, err := os.CreateTemp("", "justai-topic-diarization-*.wav")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(liveStreamWAVHeader()); err != nil {
		return err
	}
	// The recordings of a source continue each other; segment offsets count the same
	// 16 kHz mono samples (32 bytes per millisecond).
	want := (end.Int64 - start.Int64) * 32
	cut := &pcmRangeWriter{writer: file, skip: start.Int64 * 32, remaining: want}
	for _, r := range recordings {
		if r.SourceID != audioSource {
			continue
		}
		if _, err := m.decodeRecordingPCM(ctx, r.ID, cut); err != nil {
			if cut.remaining == 0 {
				break
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Warn("recording skipped for topic speaker separation", "topicId", topicID, "recordingId", r.ID, "error", err)
		}
		if cut.remaining == 0 {
			break
		}
	}
	got := want - cut.remaining
	if got < topicDiarizationMinAudioMs*32 {
		return fmt.Errorf("the recording holds too little audio for this topic")
	}
	size := 44 + got
	if err := finalizeLiveWAV(file, size); err != nil {
		return err
	}
	turns, err := m.diarizeWAVFile(ctx, copyID.UUID, endpoint, file, size, language)
	if err != nil {
		return err
	}

	// Somebody may have started working on the copy meanwhile.
	if touched, err := m.topicTranscriptTouched(ctx, copyID.UUID, syncedAt.Time); err != nil || touched {
		return err
	}
	segments, err := loadTranscriptionSegments(ctx, m.DB, copyID.UUID)
	if err != nil {
		return err
	}
	for i := range segments {
		segments[i].SourceID = nil
	}
	if err := m.applyVideoDiarizationTurns(ctx, copyID.UUID, segments, turns); err != nil {
		return err
	}
	if err := m.nameSpeakersFromTurns(ctx, copyID.UUID); err != nil {
		slog.Warn("topic speakers could not be named from the announcements", "topicId", topicID, "error", err)
	}
	if _, err := m.DB.ExecContext(ctx, `DELETE FROM transcription_speakers sp WHERE sp.session_id = $1 AND sp.name_source <> 'manual'
		AND NOT EXISTS (SELECT 1 FROM transcription_segments seg WHERE seg.speaker_id = sp.id)`, copyID.UUID); err != nil {
		return err
	}
	// Separation is not an edit: the copy may still be rebuilt from the sitting.
	_, err = m.DB.ExecContext(ctx, `UPDATE transcription_topics SET transcript_synced_at = clock_timestamp() WHERE id = $1 AND transcript_synced_at = $2`, topicID, syncedAt.Time)
	return err
}

// topicTranscriptTouched: has anybody worked on a topic's transcript since it was copied?
func (m *TranscriptionManager) topicTranscriptTouched(ctx context.Context, copyID uuid.UUID, syncedAt time.Time) (bool, error) {
	var touched bool
	err := m.DB.QueryRowContext(ctx, topicTranscriptTouchedQuery, copyID, syncedAt).Scan(&touched)
	return touched, err
}
