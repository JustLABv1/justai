package server

import (
	"testing"
)

func TestInferEndpointKind(t *testing.T) {
	tests := []struct {
		name         string
		providerType string
		capabilities map[string]bool
		want         string
	}{
		{name: "chat defaults to llm", capabilities: map[string]bool{"chat": true}, want: "llm"},
		{name: "diarization only uses diarization lane", capabilities: map[string]bool{"diarization": true}, want: "diarization"},
		{name: "dual capability stays llm", capabilities: map[string]bool{"chat": true, "diarization": true}, want: "llm"},
		{name: "pyannote is always diarization", providerType: "pyannote", capabilities: map[string]bool{"chat": true}, want: "diarization"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := inferEndpointKind(testCase.providerType, testCase.capabilities); got != testCase.want {
				t.Fatalf("inferEndpointKind() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestValidateEndpointKind(t *testing.T) {
	valid := []struct {
		name         string
		kind         string
		providerType string
		capabilities map[string]bool
	}{
		{name: "llm", kind: "llm", capabilities: map[string]bool{"chat": true}},
		{name: "diarization", kind: "diarization", providerType: "pyannote", capabilities: map[string]bool{"diarization": true}},
		{name: "dual purpose", kind: "diarization", providerType: "openai-compatible", capabilities: map[string]bool{"chat": true, "diarization": true}},
	}
	for _, testCase := range valid {
		t.Run(testCase.name, func(t *testing.T) {
			if err := validateEndpointKind(testCase.kind, testCase.providerType, testCase.capabilities); err != nil {
				t.Fatalf("validateEndpointKind() error = %v", err)
			}
		})
	}

	invalid := []struct {
		name         string
		kind         string
		providerType string
		capabilities map[string]bool
	}{
		{name: "llm without chat", kind: "llm", capabilities: map[string]bool{"diarization": true}},
		{name: "diarization without diarization", kind: "diarization", capabilities: map[string]bool{"chat": true}},
		{name: "pyannote chat lane", kind: "llm", providerType: "pyannote", capabilities: map[string]bool{"chat": true, "diarization": true}},
		{name: "unknown lane", kind: "other", capabilities: map[string]bool{"chat": true}},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			if err := validateEndpointKind(testCase.kind, testCase.providerType, testCase.capabilities); err == nil {
				t.Fatal("validateEndpointKind() expected an error")
			}
		})
	}
}
