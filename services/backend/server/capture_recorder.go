package server

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// captureRecorder keeps a server-side WAV recording of a capture client that records
// nothing itself: a meeting bot. Speaker separation after the session needs a
// recording; browsers upload their own, livestreams are recorded by their worker.
//
// The recording must line up with the transcript's offsets, which count from the
// session's first audio frame. So every frame is written (silent ones too, and zeros
// while the session is paused), and a source that starts later is padded with silence
// up to its first frame's offset.
type captureRecorder struct {
	m         *TranscriptionManager
	ctx       context.Context
	sessionID uuid.UUID
	sourceID  uuid.UUID
	id        uuid.UUID
	part      int
	buffer    []byte
	started   bool
	failed    bool
}

const (
	// captureRecorderFlushBytes writes about one second of 16 kHz PCM16 per part.
	captureRecorderFlushBytes = 32_000
	// captureRecorderMaxPadding bounds the silence written before a late source.
	captureRecorderMaxPadding = time.Hour
)

// newCaptureRecorder returns a recorder for meeting-bot sources of sessions that
// record audio, and nil otherwise. A nil recorder ignores every call.
func (m *TranscriptionManager) newCaptureRecorder(ctx context.Context, sessionID, sourceID uuid.UUID) *captureRecorder {
	var recordAudio bool
	var kind string
	if err := m.DB.QueryRowContext(ctx, `SELECT session.record_audio, source.kind FROM transcription_sources source JOIN transcription_sessions session ON session.id = source.session_id WHERE source.id = $1 AND session.id = $2`, sourceID, sessionID).Scan(&recordAudio, &kind); err != nil {
		return nil
	}
	if !recordAudio || kind != "meeting-bot" {
		return nil
	}
	return &captureRecorder{m: m, ctx: context.WithoutCancel(ctx), sessionID: sessionID, sourceID: sourceID}
}

// write appends 16 kHz PCM16 audio captured at captureTimestamp (Unix ms).
func (r *captureRecorder) write(pcm16 []byte, captureTimestamp int64) {
	if r == nil || r.failed || len(pcm16) == 0 {
		return
	}
	if !r.started {
		r.started = true
		recording, err := r.m.startRecording(r.ctx, r.sessionID, r.sourceID, "audio/wav")
		if err == nil {
			err = r.m.appendRecording(r.ctx, recording.ID, 0, liveStreamWAVHeader())
		}
		if err != nil {
			r.fail(err)
			return
		}
		r.id, r.part = recording.ID, 1
		if offset := r.m.captureOffset(r.sessionID, r.sourceID, captureTimestamp); offset > 0 {
			offset = min(offset, captureRecorderMaxPadding.Milliseconds())
			r.buffer = make([]byte, offset*32) // 32 bytes per millisecond
		}
	}
	r.buffer = append(r.buffer, pcm16...)
	if len(r.buffer) >= captureRecorderFlushBytes {
		r.flush()
	}
}

// silence keeps the timeline while audio is not recorded (a paused session).
func (r *captureRecorder) silence(bytes int, captureTimestamp int64) {
	if r == nil || bytes <= 0 {
		return
	}
	r.write(make([]byte, bytes-bytes%2), captureTimestamp)
}

func (r *captureRecorder) flush() {
	if r == nil || r.failed || r.id == uuid.Nil || len(r.buffer) == 0 {
		return
	}
	if err := r.m.appendRecording(r.ctx, r.id, r.part, r.buffer); err != nil {
		r.fail(err)
		return
	}
	r.part++
	r.buffer = r.buffer[:0]
}

func (r *captureRecorder) fail(err error) {
	r.failed = true
	slog.Warn("meeting bot recording failed", "sessionId", r.sessionID, "sourceId", r.sourceID, "error", err)
	r.m.broadcast(r.sessionID, "error", ginData{"sourceId": r.sourceID, "message": "source recording failed: " + err.Error()})
}

// close writes what is buffered and completes the recording.
func (r *captureRecorder) close() {
	if r == nil || r.id == uuid.Nil {
		return
	}
	r.flush()
	if err := r.m.completeRecording(r.ctx, r.id); err != nil {
		slog.Warn("meeting bot recording could not be completed", "sessionId", r.sessionID, "sourceId", r.sourceID, "error", err)
	}
}
