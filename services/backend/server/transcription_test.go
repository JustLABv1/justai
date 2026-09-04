package server

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
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

func TestTranscriptionIngressNormalizesBotPlatformsAndBearerTokens(t *testing.T) {
	for input, expected := range map[string]string{
		"":                "generic",
		"custom":          "generic",
		"zoom":            "zoom",
		"google meet":     "google-meet",
		"teams":           "microsoft-teams",
		"microsoft-teams": "microsoft-teams",
	} {
		if got := normalizeBotPlatform(input); got != expected {
			t.Fatalf("normalizeBotPlatform(%q) = %q, want %q", input, got, expected)
		}
	}
	if normalizeBotPlatform("skype") != "" {
		t.Fatal("unsupported meeting platform should be rejected")
	}
	if bearerToken("Bearer bot-secret") != "bot-secret" {
		t.Fatal("bearer token was not extracted")
	}
	if bearerToken("Basic bot-secret") != "" || bearerToken("Bearer") != "" {
		t.Fatal("malformed authorization header was accepted")
	}
}

func TestLiveStreamFFmpegArgsKeepInputAsOneArgument(t *testing.T) {
	streamURL := "https://example.com/live/playlist.m3u8?token=one%20two"
	args := ffmpegLiveAudioArgs(streamURL, "https")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-reconnect 1") || !strings.Contains(joined, "-ar 16000") {
		t.Fatalf("live stream FFmpeg args are missing reconnect/audio settings: %s", joined)
	}
	for index, value := range args {
		if value == streamURL {
			if index == 0 || args[index-1] != "-i" {
				t.Fatalf("stream URL was not kept as the input argument: %#v", args)
			}
			return
		}
	}
	t.Fatalf("stream URL was not present in FFmpeg args: %#v", args)
}

func TestRedactTranscriptionStreamErrorRemovesMediaURLSecrets(t *testing.T) {
	message := redactTranscriptionStreamError(fmt.Errorf("decoder failed url=https://media.example.test/live.m3u8?token=secret"), "https://media.example.test/live.m3u8?token=secret")
	if strings.Contains(message, "token=secret") {
		t.Fatalf("stream credential leaked in diagnostic: %q", message)
	}
	if !strings.Contains(message, "https://media.example.test/live.m3u8") {
		t.Fatalf("expected safe media path in diagnostic: %q", message)
	}
}

func TestLiveStreamWAVHeaderUsesMono16KPCM(t *testing.T) {
	header := liveStreamWAVHeader()
	if len(header) != 44 || string(header[:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		t.Fatalf("unexpected WAV header: %q", header)
	}
	if got := binary.LittleEndian.Uint32(header[24:28]); got != 16000 {
		t.Fatalf("sample rate = %d, want 16000", got)
	}
	if got := binary.LittleEndian.Uint16(header[22:24]); got != 1 {
		t.Fatalf("channels = %d, want mono", got)
	}
	if got := binary.LittleEndian.Uint16(header[34:36]); got != 16 {
		t.Fatalf("bits per sample = %d, want 16", got)
	}
}

func TestPyannoteSupportsWholeFileDiarizationOnly(t *testing.T) {
	modelEndpoint := models.Endpoint{
		ProviderType: "pyannote",
		Capabilities: json.RawMessage(`{"diarization":true}`),
	}
	if !endpointSupportsModel(modelEndpoint, "diarization") {
		t.Fatal("pyannote should satisfy diarization endpoint selection")
	}
	providerEndpoint := provider.Endpoint{
		ProviderType: "pyannote",
		Capabilities: map[string]bool{"diarization": true},
	}
	if !endpointSupports(providerEndpoint, "diarization") {
		t.Fatal("pyannote should support backend diarization")
	}
	if endpointSupports(providerEndpoint, "chat") {
		t.Fatal("pyannote must not be treated as a chat endpoint")
	}
}
