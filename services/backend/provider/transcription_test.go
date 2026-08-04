package provider

import (
	"encoding/json"
	"testing"
)

func TestParseRealtimeEventOpenAI(t *testing.T) {
	partial := parseRealtimeEvent("openai", []byte(`{"type":"conversation.item.input_audio_transcription.delta","delta":"hello"}`))
	if partial.Kind != "partial" || partial.Text != "hello" {
		t.Fatalf("unexpected partial event: %+v", partial)
	}
	final := parseRealtimeEvent("openai", []byte(`{"type":"conversation.item.input_audio_transcription.completed","transcript":"hello world"}`))
	if final.Kind != "final" || final.Text != "hello world" {
		t.Fatalf("unexpected final event: %+v", final)
	}
}

func TestParseRealtimeEventGemini(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"serverContent": map[string]any{
			"inputTranscription": map[string]string{"text": "guten morgen"},
			"turnComplete":       true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	event := parseRealtimeEvent("gemini", payload)
	if event.Kind != "final" || event.Text != "guten morgen" {
		t.Fatalf("unexpected Gemini event: %+v", event)
	}
}

func TestResamplePCM16(t *testing.T) {
	input := []byte{0, 0, 0xff, 0x7f, 0, 0x80, 0xff, 0xff}
	output := ResamplePCM16(input, 16000, 8000)
	if len(output) != 4 {
		t.Fatalf("expected two output samples, got %d bytes", len(output))
	}
	if got := ResamplePCM16(input, 16000, 16000); len(got) != len(input) {
		t.Fatalf("same-rate resampling changed length")
	}
}
