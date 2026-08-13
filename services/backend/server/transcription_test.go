package server

import (
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
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

func TestDecodeTranscriptionSourceIDsFromJSONB(t *testing.T) {
	sourceID := uuid.New()
	values, err := decodeTranscriptionSourceIDs([]byte(`["` + sourceID.String() + `"]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values[0] != sourceID {
		t.Fatalf("unexpected source IDs: %+v", values)
	}
	empty, err := decodeTranscriptionSourceIDs([]byte(`[]`))
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("unexpected empty source IDs: %+v, err=%v", empty, err)
	}
}

func TestIsTranscriptionProtocolPayload(t *testing.T) {
	if !isTranscriptionProtocolPayload(`data: {"object":"transcription.chunk","choices":[{"delta":{"content":""}}]}`) {
		t.Fatal("expected provider protocol payload to be recognized")
	}
	if isTranscriptionProtocolPayload("The room transcript is ready.") {
		t.Fatal("ordinary transcript text was incorrectly filtered")
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

func TestTranscriptionModeKeepsRealtimeAndChunkedTransportsDistinct(t *testing.T) {
	if got := transcriptionMode(provider.Endpoint{ProviderType: "openai", Capabilities: map[string]bool{}}); got != "realtime" {
		t.Fatalf("native OpenAI should use realtime mode, got %q", got)
	}
	if got := transcriptionMode(provider.Endpoint{ProviderType: "openai-compatible", Capabilities: map[string]bool{"realtime-transcription": true}}); got != "realtime" {
		t.Fatalf("explicit realtime capability should use realtime mode, got %q", got)
	}
	if got := transcriptionMode(provider.Endpoint{ProviderType: "openai-compatible", TranscriptionModel: "whisper-large-v3-turbo", Capabilities: map[string]bool{"transcription": true, "realtime-transcription": true}}); got != "chunked" {
		t.Fatalf("legacy Whisper endpoint should use chunked mode, got %q", got)
	}
	if got := transcriptionMode(provider.Endpoint{ProviderType: "openai-compatible", TranscriptionModel: "whisper-large-v3-turbo", Capabilities: map[string]bool{"realtime-transcription": true}}); got != "chunked" {
		t.Fatalf("Whisper should override a stale realtime-only capability, got %q", got)
	}
	if got := transcriptionMode(provider.Endpoint{ProviderType: "openai-compatible", Capabilities: map[string]bool{"chunked-transcription": true, "realtime-transcription": true}}); got != "chunked" {
		t.Fatalf("explicit chunked capability should take precedence, got %q", got)
	}
	if got := transcriptionMode(provider.Endpoint{ProviderType: "openai-compatible", Capabilities: map[string]bool{"transcription": true}}); got != "chunked" {
		t.Fatalf("legacy transcription capability should use chunked mode, got %q", got)
	}

	endpoint := models.Endpoint{ProviderType: "openai-compatible", Capabilities: json.RawMessage(`{"chunked-transcription":true}`)}
	if !endpointSupportsModel(endpoint, "transcription") {
		t.Fatal("chunked endpoint should satisfy generic transcription capability")
	}
}
