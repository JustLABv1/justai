package provider

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
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

func TestParseRealtimeEventVLLM(t *testing.T) {
	partial := parseRealtimeEvent("openai-compatible", []byte(`{"type":"transcription.delta","delta":"hello"}`))
	if partial.Kind != "partial" || partial.Text != "hello" {
		t.Fatalf("unexpected vLLM partial event: %+v", partial)
	}
	final := parseRealtimeEvent("openai-compatible", []byte(`{"type":"transcription.done","text":"hello world"}`))
	if final.Kind != "final" || final.Text != "hello world" {
		t.Fatalf("unexpected vLLM final event: %+v", final)
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

func TestDiarizeMediaURLPyannote(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/diarize" {
			t.Errorf("unexpected diarization path: %s", request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		if got := request.Header.Get("Authorization"); got != "Bearer service-token" {
			t.Errorf("unexpected authorization header: %q", got)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		var payload map[string]string
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode request body: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if payload["media_url"] != "https://media.example.test/video.mp4" {
			t.Errorf("unexpected media URL: %q", payload["media_url"])
		}
		if payload["model"] != "pyannote/speaker-diarization-3.1" {
			t.Errorf("unexpected model: %q", payload["model"])
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"segments":[{"speaker":"SPEAKER_00","start":0.25,"end":1.5}]}`))
	}))
	defer server.Close()

	segments, err := DiarizeMediaURL(context.Background(), Endpoint{
		ProviderType:     "pyannote",
		BaseURL:          server.URL,
		AllowPrivate:     true,
		Credential:       "service-token",
		DiarizationModel: "pyannote/speaker-diarization-3.1",
	}, "https://media.example.test/video.mp4", "de")
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].Speaker != "SPEAKER_00" || segments[0].Start != 0.25 || segments[0].End != 1.5 {
		t.Fatalf("unexpected diarization segments: %+v", segments)
	}
}

func TestDiarizeMediaURLReturnsProviderFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusBadGateway)
		_, _ = writer.Write([]byte(`{"detail":"could not download source media (403)"}`))
	}))
	defer server.Close()

	_, err := DiarizeMediaURL(context.Background(), Endpoint{
		ProviderType: "pyannote",
		BaseURL:      server.URL,
		AllowPrivate: true,
	}, "https://media.example.test/video.mp4", "de")
	if err == nil {
		t.Fatal("expected diarization provider failure")
	}
	if !strings.Contains(err.Error(), "502") || !strings.Contains(err.Error(), "could not download source media") {
		t.Fatalf("provider failure did not preserve status and detail: %v", err)
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

func TestPCM16VoiceGateRejectsDigitalSilence(t *testing.T) {
	if PCM16HasSpeech(make([]byte, durationBytes(250*time.Millisecond))) {
		t.Fatal("digital silence should not pass the voice gate")
	}
	pcm := make([]byte, durationBytes(250*time.Millisecond))
	for index := 0; index+1 < len(pcm); index += 2 {
		binary.LittleEndian.PutUint16(pcm[index:index+2], uint16(int16(5000)))
	}
	if !PCM16HasSpeech(pcm) {
		t.Fatal("a voiced PCM window should pass the voice gate")
	}
	if !PCM16HasSustainedSpeech(pcm) {
		t.Fatal("a sustained voiced PCM window should pass the sustained voice gate")
	}
	shortNoise := make([]byte, durationBytes(100*time.Millisecond))
	for index := 0; index+1 < durationBytes(20*time.Millisecond); index += 2 {
		binary.LittleEndian.PutUint16(shortNoise[index:index+2], uint16(int16(5000)))
	}
	if PCM16HasSustainedSpeech(shortNoise) {
		t.Fatal("a short microphone pop should not pass the sustained voice gate")
	}
}

func TestCleanTranscriptTextDropsProviderNoiseMarkers(t *testing.T) {
	for _, value := range []string{".", "...", "*disk*", "*puh*", "[BLANK_AUDIO]", "(background noise)"} {
		if got := CleanTranscriptText(value); got != "" {
			t.Fatalf("expected provider artifact %q to be discarded, got %q", value, got)
		}
	}
	for _, value := range []string{"Ja", "Nein", "Naja, da kannst du halt nix machen, ne?", "*das ist wichtig*"} {
		if got := CleanTranscriptText(value); got != value {
			t.Fatalf("expected spoken text %q to be preserved, got %q", value, got)
		}
	}
}

func TestChunkedStreamPostsWhisperAudioAndStreamsSSE(t *testing.T) {
	var requestModel string
	var requestStream string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/audio/transcriptions" {
			t.Errorf("unexpected transcription path: %s", request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		if err := request.ParseMultipartForm(2 << 20); err != nil {
			t.Errorf("parse multipart form: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		requestModel = request.FormValue("model")
		requestStream = request.FormValue("stream")
		file, _, err := request.FormFile("file")
		if err != nil {
			t.Errorf("missing audio file: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		defer file.Close()
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Errorf("test server does not support flushing")
			return
		}
		_, _ = fmt.Fprintln(writer, `data: {"choices":[{"delta":{"content":"hello "}}]}`)
		flusher.Flush()
		_, _ = fmt.Fprintln(writer, `data: {"choices":[{"delta":{"content":"world"}}]}`)
		_, _ = fmt.Fprintln(writer, "data: [DONE]")
		flusher.Flush()
	}))
	defer server.Close()

	stream, err := OpenChunked(context.Background(), Endpoint{
		ProviderType:       "openai-compatible",
		BaseURL:            server.URL + "/v1",
		AllowPrivate:       true,
		TranscriptionModel: "whisper-large-v3-turbo",
		TimeoutSeconds:     10,
	}, "", "en", ChunkedOptions{Window: 100 * time.Millisecond, Overlap: 20 * time.Millisecond, Minimum: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	var events []RealtimeEvent
	done := make(chan struct{})
	go func() {
		for event := range stream.Events() {
			events = append(events, event)
		}
		close(done)
	}()
	if err := stream.SendPCM(nil, speechPCM(80*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done

	if requestModel != "whisper-large-v3-turbo" || requestStream != "true" {
		t.Fatalf("unexpected request fields: model=%q stream=%q", requestModel, requestStream)
	}
	var partial, final *RealtimeEvent
	for index := range events {
		if events[index].Kind == "partial" {
			partial = &events[index]
		}
		if events[index].Kind == "final" {
			final = &events[index]
		}
	}
	if partial == nil || partial.Text != "hello world" {
		t.Fatalf("unexpected partial events: %+v", events)
	}
	if final == nil || final.Text != "hello world" || final.EndOffsetMs != 80 {
		t.Fatalf("unexpected final event: %+v", events)
	}
}

func TestChunkedStreamUnwrapsEmbeddedSSEFromJSONResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseMultipartForm(2 << 20); err != nil {
			t.Errorf("parse multipart form: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		embedded := `data: {"choices":[{"delta":{"content":"hello "}}]} data: {"choices":[{"delta":{"content":"world"}}]} data: [DONE]`
		payload, err := json.Marshal(map[string]string{"text": embedded})
		if err != nil {
			t.Errorf("marshal wrapped response: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	stream, err := OpenChunked(context.Background(), Endpoint{
		ProviderType:       "openai-compatible",
		BaseURL:            server.URL + "/v1",
		AllowPrivate:       true,
		TranscriptionModel: "whisper-large-v3-turbo",
		TimeoutSeconds:     10,
	}, "", "en", ChunkedOptions{Window: 100 * time.Millisecond, Overlap: 20 * time.Millisecond, Minimum: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	var events []RealtimeEvent
	done := make(chan struct{})
	go func() {
		for event := range stream.Events() {
			events = append(events, event)
		}
		close(done)
	}()
	if err := stream.SendPCM(nil, speechPCM(80*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done

	var final *RealtimeEvent
	for index := range events {
		if events[index].Kind == "final" {
			final = &events[index]
		}
		if strings.Contains(events[index].Text, "data:") {
			t.Fatalf("provider SSE metadata leaked into transcript: %+v", events[index])
		}
	}
	if final == nil || final.Text != "hello world" {
		t.Fatalf("unexpected unwrapped transcript events: %+v", events)
	}
}

func TestChunkedStreamDeduplicatesRollingWindowOverlap(t *testing.T) {
	if got := removeTranscriptOverlap("hello from the room", "the room is live"); got != "is live" {
		t.Fatalf("unexpected overlap removal: %q", got)
	}
	if got := appendTranscriptDelta("hello ", "world"); got != "hello world" {
		t.Fatalf("unexpected delta append: %q", got)
	}
}

func TestSanitizeTranscriptRepetitionKeepsNaturalRepetition(t *testing.T) {
	input := strings.TrimSpace(strings.Repeat("ich sage ", 7) + "dann sprechen wir weiter über das thema")
	if got := SanitizeTranscriptRepetition(input); got != input {
		t.Fatalf("natural repetition should remain unchanged: %q", got)
	}
}

func TestSanitizeTranscriptRepetitionCollapsesPathologicalPhraseLoop(t *testing.T) {
	input := strings.TrimSpace("Vorher " + strings.Repeat("ich sage ", 12) + "Danach geht es weiter")
	want := "Vorher ich sage ich sage Danach geht es weiter"
	if got := SanitizeTranscriptRepetition(input); got != want {
		t.Fatalf("unexpected cleaned phrase loop: %q", got)
	}
}

func TestSanitizeTranscriptRepetitionCollapsesPathologicalSingleWordLoop(t *testing.T) {
	input := strings.TrimSpace("Vorher " + strings.Repeat("krkr ", 12) + "Danach")
	want := "Vorher krkr krkr Danach"
	if got := SanitizeTranscriptRepetition(input); got != want {
		t.Fatalf("unexpected cleaned single-word loop: %q", got)
	}
}

func TestTrimTranscriptPromptStaysWithinSmallWhisperContextBudget(t *testing.T) {
	longTranscript := strings.Repeat("previous words from the room ", 100)
	prompt := trimTranscriptPrompt(longTranscript, 160)
	if len([]rune(prompt)) > 160 {
		t.Fatalf("prompt exceeds configured character budget: %d", len([]rune(prompt)))
	}
	if !strings.HasSuffix(prompt, "room") {
		t.Fatalf("prompt should preserve the newest words: %q", prompt)
	}
}

func TestChunkedStreamLimitsRollingPromptSentToProvider(t *testing.T) {
	var prompts []string
	var promptsMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseMultipartForm(2 << 20); err != nil {
			t.Errorf("parse multipart form: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		promptsMu.Lock()
		prompts = append(prompts, request.FormValue("prompt"))
		promptsMu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{"text":"one two three four five six seven eight nine ten eleven twelve"}`)
	}))
	defer server.Close()

	stream, err := OpenChunked(context.Background(), Endpoint{
		ProviderType:       "openai-compatible",
		BaseURL:            server.URL + "/v1",
		AllowPrivate:       true,
		TranscriptionModel: "whisper-large-v3-turbo",
		TimeoutSeconds:     10,
	}, "", "en", ChunkedOptions{Window: 100 * time.Millisecond, Overlap: 20 * time.Millisecond, Minimum: 50 * time.Millisecond, PromptMaxChars: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	done := make(chan struct{})
	go func() {
		for range stream.Events() {
		}
		close(done)
	}()
	if err := stream.SendPCM(nil, speechPCM(100*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.SendPCM(nil, speechPCM(80*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done

	promptsMu.Lock()
	defer promptsMu.Unlock()
	if len(prompts) != 2 {
		t.Fatalf("expected two rolling requests, got %d", len(prompts))
	}
	if prompts[0] != "" || len([]rune(prompts[1])) > 24 {
		t.Fatalf("unexpected rolling prompts: %#v", prompts)
	}
}

func TestChunkedStreamCanDisableRollingPrompt(t *testing.T) {
	var prompts []string
	var promptsMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseMultipartForm(2 << 20); err != nil {
			t.Errorf("parse multipart form: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		promptsMu.Lock()
		prompts = append(prompts, request.FormValue("prompt"))
		promptsMu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{"text":"one two three four five six seven eight nine ten eleven twelve"}`)
	}))
	defer server.Close()

	stream, err := OpenChunked(context.Background(), Endpoint{
		ProviderType:       "openai-compatible",
		BaseURL:            server.URL + "/v1",
		AllowPrivate:       true,
		TranscriptionModel: "whisper-large-v3-turbo",
		TimeoutSeconds:     10,
	}, "", "en", ChunkedOptions{
		Window:         100 * time.Millisecond,
		Overlap:        20 * time.Millisecond,
		Minimum:        50 * time.Millisecond,
		PromptMaxChars: 24,
		DisablePrompt:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	done := make(chan struct{})
	go func() {
		for range stream.Events() {
		}
		close(done)
	}()
	if err := stream.SendPCM(nil, speechPCM(100*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.SendPCM(nil, speechPCM(80*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done

	promptsMu.Lock()
	defer promptsMu.Unlock()
	if len(prompts) != 2 || prompts[0] != "" || prompts[1] != "" {
		t.Fatalf("expected rolling prompts to stay disabled: %#v", prompts)
	}
}

func TestChunkedStreamRetriesContextLimitWithoutRollingPrompt(t *testing.T) {
	var requestCount int
	var prompts []string
	var requestsMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseMultipartForm(2 << 20); err != nil {
			t.Errorf("parse multipart form: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		requestsMu.Lock()
		requestCount++
		currentRequest := requestCount
		prompts = append(prompts, request.FormValue("prompt"))
		requestsMu.Unlock()

		if currentRequest == 2 {
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = fmt.Fprint(writer, `{"error":{"message":"ContextWindowExceededError: input tokens"}}`)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if currentRequest == 1 {
			_, _ = fmt.Fprint(writer, `{"text":"context from the first window"}`)
			return
		}
		_, _ = fmt.Fprint(writer, `{"text":"next window"}`)
	}))
	defer server.Close()

	stream, err := OpenChunked(context.Background(), Endpoint{
		ProviderType:       "openai-compatible",
		BaseURL:            server.URL + "/v1",
		AllowPrivate:       true,
		TranscriptionModel: "whisper-large-v3-turbo",
		TimeoutSeconds:     10,
	}, "", "en", ChunkedOptions{Window: 100 * time.Millisecond, Overlap: 20 * time.Millisecond, Minimum: 50 * time.Millisecond, PromptMaxChars: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	done := make(chan struct{})
	go func() {
		for range stream.Events() {
		}
		close(done)
	}()
	if err := stream.SendPCM(nil, speechPCM(100*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.SendPCM(nil, speechPCM(80*time.Millisecond), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done

	requestsMu.Lock()
	defer requestsMu.Unlock()
	if requestCount != 3 || prompts[1] == "" || prompts[2] != "" {
		t.Fatalf("expected context retry without prompt, requests=%d prompts=%#v", requestCount, prompts)
	}
}

func TestChunkedStreamDoesNotRequestDigitalSilence(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{"text":"should not be returned"}`)
	}))
	defer server.Close()

	stream, err := OpenChunked(context.Background(), Endpoint{
		ProviderType:       "openai-compatible",
		BaseURL:            server.URL + "/v1",
		AllowPrivate:       true,
		TranscriptionModel: "whisper-large-v3-turbo",
		TimeoutSeconds:     10,
	}, "", "en", ChunkedOptions{Window: 100 * time.Millisecond, Overlap: 20 * time.Millisecond, Minimum: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		for range stream.Events() {
			t.Errorf("silent audio produced a transcription event")
		}
		close(done)
	}()
	if err := stream.SendPCM(nil, make([]byte, durationBytes(100*time.Millisecond)), 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done
	if requests != 0 {
		t.Fatalf("expected no provider request for silence, got %d", requests)
	}
}

func TestChunkedStreamCommitTurnFlushesShortUtterance(t *testing.T) {
	streamContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := &ChunkedStream{
		windowBytes:  durationBytes(2500 * time.Millisecond),
		overlapBytes: durationBytes(500 * time.Millisecond),
		minimumBytes: durationBytes(100 * time.Millisecond),
		ctx:          streamContext,
		cancel:       cancel,
		jobs:         make(chan chunkedAudio, 1),
		events:       make(chan RealtimeEvent, 1),
	}
	pcm := speechPCM(350 * time.Millisecond)
	if err := stream.SendPCM(nil, pcm, 16000); err != nil {
		t.Fatal(err)
	}
	if err := stream.CommitTurn(); err != nil {
		t.Fatal(err)
	}
	select {
	case job := <-stream.jobs:
		if len(job.pcm) != len(pcm) {
			t.Fatalf("expected the short utterance to be flushed intact, got %d bytes", len(job.pcm))
		}
	case <-time.After(time.Second):
		t.Fatal("short utterance was not queued at the turn boundary")
	}
	stream.bufferMu.Lock()
	remaining := len(stream.buffer)
	stream.bufferMu.Unlock()
	if remaining != 0 {
		t.Fatalf("expected the turn buffer to be empty after commit, got %d bytes", remaining)
	}
}

func speechPCM(duration time.Duration) []byte {
	pcm := make([]byte, durationBytes(duration))
	for index := 0; index+1 < len(pcm); index += 2 {
		binary.LittleEndian.PutUint16(pcm[index:index+2], uint16(int16(5000)))
	}
	return pcm
}

func TestParseHTTPTranscriptionEvent(t *testing.T) {
	value, replace, err := parseHTTPTranscriptionEvent([]byte(`{"text":"final text"}`))
	if err != nil || !replace || value != "final text" {
		t.Fatalf("unexpected JSON event: value=%q replace=%v err=%v", value, replace, err)
	}
	value, replace, err = parseHTTPTranscriptionEvent([]byte(`{"delta":"next"}`))
	if err != nil || replace || value != "next" {
		t.Fatalf("unexpected delta event: value=%q replace=%v err=%v", value, replace, err)
	}
}
