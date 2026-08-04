package server

import (
	"encoding/binary"
	"testing"
	"time"
)

func TestParseAudioFrameSupportsVersionedAndLegacyFrames(t *testing.T) {
	pcm := []byte{1, 2, 3, 4}
	payload := make([]byte, 17+len(pcm))
	payload[0] = 1
	binary.LittleEndian.PutUint64(payload[1:9], 1234)
	binary.LittleEndian.PutUint32(payload[9:13], 7)
	binary.LittleEndian.PutUint32(payload[13:17], 48000)
	copy(payload[17:], pcm)
	frame := parseAudioFrame(payload)
	if frame.SampleRate != 48000 || frame.CaptureTimestamp != 1234 || frame.Sequence != 7 || string(frame.PCM) != string(pcm) {
		t.Fatalf("unexpected versioned frame: %+v", frame)
	}
	legacy := parseAudioFrame(append([]byte{1}, make([]byte, 12)...))
	if legacy.SampleRate != 16000 || len(legacy.PCM) != 0 {
		t.Fatalf("unexpected legacy frame: %+v", legacy)
	}
}

func TestTranscriptionTextMatchingNormalizesPunctuation(t *testing.T) {
	if !transcriptionTextsMatch("Hello, room!", " hello room ") {
		t.Fatal("expected normalized duplicate text to match")
	}
	if transcriptionTextsMatch("yes", "no") {
		t.Fatal("different short text should not match")
	}
}

func TestJoinLimiterAllowsTenAttemptsAndThenBlocks(t *testing.T) {
	manager := &TranscriptionManager{joins: make(map[string][]time.Time)}
	for index := 0; index < 10; index++ {
		if !manager.allowJoin("127.0.0.1") {
			t.Fatalf("attempt %d should be allowed", index+1)
		}
	}
	if manager.allowJoin("127.0.0.1") {
		t.Fatal("eleventh join attempt should be rate limited")
	}
	if manager.allowJoin("127.0.0.2") == false {
		t.Fatal("rate limit should be scoped to the client key")
	}
}
