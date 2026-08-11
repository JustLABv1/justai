package server

import (
	"encoding/binary"
	"testing"

	"github.com/google/uuid"

	"justai-backend/provider"
)

func TestVoiceToolNamesAreProviderSafeAndUnique(t *testing.T) {
	serverID := uuid.MustParse("12345678-1234-1234-1234-123456789abc")
	existing := map[string]voiceToolBinding{}
	first := voiceToolName(serverID, "light.turn-on", existing)
	existing[first] = voiceToolBinding{ToolName: "light.turn-on"}
	second := voiceToolName(serverID, "light/turn-on", existing)
	if first == second || len(second) > 64 {
		t.Fatalf("expected unique bounded names, got %q and %q", first, second)
	}
	if first != "mcp_12345678_light_turn_on" || second != "mcp_12345678_light_turn_on_2" {
		t.Fatalf("unexpected normalized names: %q %q", first, second)
	}
}

func TestVoiceAudioFramePreservesHeaderAndPCM(t *testing.T) {
	payload := make([]byte, 17+4)
	payload[0] = 1
	binary.LittleEndian.PutUint64(payload[1:9], 1234)
	binary.LittleEndian.PutUint32(payload[9:13], 7)
	binary.LittleEndian.PutUint32(payload[13:17], 48000)
	copy(payload[17:], []byte{1, 2, 3, 4})
	frame := parseAudioFrame(payload)
	if frame.CaptureTimestamp != 1234 || frame.Sequence != 7 || frame.SampleRate != 48000 || string(frame.PCM) != string([]byte{1, 2, 3, 4}) {
		t.Fatalf("unexpected voice frame: %+v", frame)
	}
}

func TestVoiceToolCallingCapabilityIsExplicitForCompatibleProviders(t *testing.T) {
	if !provider.SupportsToolCalling(provider.Endpoint{ProviderType: "openai"}) {
		t.Fatal("native OpenAI should support tool calling")
	}
	if provider.SupportsToolCalling(provider.Endpoint{ProviderType: "openai-compatible"}) {
		t.Fatal("compatible providers must opt into tool calling")
	}
	if !provider.SupportsToolCalling(provider.Endpoint{ProviderType: "openai-compatible", Capabilities: map[string]bool{"tool-calling": true}}) {
		t.Fatal("explicit compatible tool calling capability was ignored")
	}
}
