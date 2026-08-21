package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type RealtimeEvent struct {
	Kind          string
	Text          string
	RawText       string
	Err           error
	StartOffsetMs int64
	EndOffsetMs   int64
}

// DefaultPCMVoiceThreshold is deliberately conservative: samples below this
// RMS level are treated as microphone silence. Sending long runs of digital
// silence to Whisper-style endpoints can produce fabricated phrases, so both
// capture clients and the backend use this threshold as a final audio gate.
const DefaultPCMVoiceThreshold = 0.01

// PCM16RMS returns the normalized root-mean-square level of mono PCM16 audio.
func PCM16RMS(pcm []byte) float64 {
	if len(pcm) < 2 {
		return 0
	}
	var total float64
	samples := 0
	for index := 0; index+1 < len(pcm); index += 2 {
		value := float64(int16(binary.LittleEndian.Uint16(pcm[index:index+2]))) / 32768
		total += value * value
		samples++
	}
	if samples == 0 {
		return 0
	}
	return math.Sqrt(total / float64(samples))
}

// PCM16HasSpeech reports whether a PCM16 window has enough energy to send to
// a transcription provider. It is not speaker detection; it is only a
// defense against muted microphones and long stretches of room silence.
func PCM16HasSpeech(pcm []byte) bool {
	return PCM16RMS(pcm) >= DefaultPCMVoiceThreshold
}

// PCM16HasSustainedSpeech requires several adjacent 20 ms frames above the
// voice threshold. A single click, breath, or microphone pop should not be
// enough to make a Whisper rolling window request.
func PCM16HasSustainedSpeech(pcm []byte) bool {
	const frameBytes = 640 // 20 ms of mono PCM16 at 16 kHz
	availableFrames := len(pcm) / frameBytes
	if availableFrames == 0 {
		return false
	}
	requiredFrames := 4 // 80 ms of continuous audio
	if availableFrames < requiredFrames {
		requiredFrames = availableFrames
	}
	consecutiveFrames := 0
	for offset := 0; offset+frameBytes <= len(pcm); offset += frameBytes {
		if PCM16HasSpeech(pcm[offset : offset+frameBytes]) {
			consecutiveFrames++
			if consecutiveFrames >= requiredFrames {
				return true
			}
			continue
		}
		consecutiveFrames = 0
	}
	return false
}

type RealtimeStream struct {
	provider  string
	inputRate int
	vllm      bool
	conn      *websocket.Conn
	writeMu   sync.Mutex
	events    chan RealtimeEvent
	closeMu   sync.Once
	closed    chan struct{}
}

func (s *RealtimeStream) ForwardSilence() bool {
	// Native OpenAI and Gemini use provider-side VAD. vLLM/Voxtral and chunked
	// Whisper use explicit turn commits instead, so their silence stays local.
	return !s.vllm && (s.provider == "openai" || s.provider == "gemini")
}

func OpenRealtime(ctx context.Context, endpoint Endpoint, model, language string) (*RealtimeStream, error) {
	model = firstNonEmpty(model, endpoint.TranscriptionModel)
	if model == "" {
		switch endpoint.ProviderType {
		case "gemini":
			model = "gemini-2.5-flash-live-preview"
		default:
			model = "gpt-live-transcribe"
		}
	}

	inputRate := 24000
	vllmRealtime := endpoint.ProviderType == "openai-compatible" && strings.Contains(strings.ToLower(model), "voxtral")
	if endpoint.ProviderType == "gemini" || vllmRealtime {
		// vLLM's OpenAI-compatible realtime endpoint (including Voxtral)
		// requires mono PCM16 at 16 kHz. Native OpenAI realtime transcription
		// continues to use its 24 kHz input format.
		inputRate = 16000
	}
	stream := &RealtimeStream{provider: endpoint.ProviderType, inputRate: inputRate, vllm: vllmRealtime, events: make(chan RealtimeEvent, 32), closed: make(chan struct{})}
	connection, err := dialRealtime(ctx, endpoint, model)
	if err != nil {
		return nil, err
	}
	stream.conn = connection
	if err := stream.configure(model, language); err != nil {
		_ = connection.Close()
		return nil, err
	}
	if vllmRealtime {
		// vLLM uses an empty non-final commit to complete the session
		// handshake before the first audio buffer is appended. Without this,
		// some releases keep the socket open but never start transcription.
		if err := stream.CommitTurn(); err != nil {
			_ = connection.Close()
			return nil, err
		}
	}
	go stream.readEvents()
	go stream.keepAlive()
	return stream, nil
}

func (s *RealtimeStream) SendPCM(ctx context.Context, pcm []byte, sampleRate int) error {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
	if sampleRate <= 0 {
		sampleRate = s.inputRate
	}
	if sampleRate != s.inputRate {
		pcm = resamplePCM16(pcm, sampleRate, s.inputRate)
	}
	encoded := base64.StdEncoding.EncodeToString(pcm)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.provider == "gemini" {
		return s.conn.WriteJSON(map[string]any{"realtimeInput": map[string]any{"audio": map[string]any{"data": encoded, "mimeType": "audio/pcm;rate=16000"}}})
	}
	return s.conn.WriteJSON(map[string]any{"type": "input_audio_buffer.append", "audio": encoded})
}

// ResamplePCM16 converts mono, signed little-endian PCM16 to the requested
// sample rate. Capture clients may run at different browser-native rates, but
// rolling diarization uses a stable 16 kHz representation.
func ResamplePCM16(pcm []byte, sourceRate, targetRate int) []byte {
	return resamplePCM16(pcm, sourceRate, targetRate)
}

func (s *RealtimeStream) Commit() error {
	return s.commit(true)
}

// CommitTurn closes the current speech segment while keeping the realtime
// connection open for the next utterance. This is required by vLLM/Voxtral,
// which does not run server-side VAD for transcription sessions.
func (s *RealtimeStream) CommitTurn() error {
	if !s.vllm {
		return nil
	}
	return s.commit(false)
}

func (s *RealtimeStream) commit(final bool) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.provider == "gemini" {
		return s.conn.WriteJSON(map[string]any{"realtimeInput": map[string]any{"audioStreamEnd": true}})
	}
	message := map[string]any{"type": "input_audio_buffer.commit"}
	if s.vllm {
		// vLLM uses the final flag to distinguish an utterance boundary from
		// the end of the whole audio input. Native OpenAI realtime does not
		// define this field, so keep its original payload unchanged.
		message["final"] = final
	}
	return s.conn.WriteJSON(message)
}

func (s *RealtimeStream) Events() <-chan RealtimeEvent {
	return s.events
}

func (s *RealtimeStream) Close() {
	s.closeMu.Do(func() {
		close(s.closed)
		_ = s.conn.Close()
	})
}

// keepAlive prevents a proxy or load balancer from expiring a realtime
// transcription tunnel while the user is listening between utterances. Audio
// is intentionally gated on speech, so without a control-frame heartbeat an
// otherwise healthy session can look idle to the upstream service.
func (s *RealtimeStream) keepAlive() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.writeMu.Lock()
			err := s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			s.writeMu.Unlock()
			if err != nil {
				return
			}
		case <-s.closed:
			return
		}
	}
}

func (s *RealtimeStream) configure(model, language string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.provider == "gemini" {
		setup := map[string]any{
			"model":                   "models/" + model,
			"generationConfig":        map[string]any{"responseModalities": []string{"TEXT"}},
			"inputAudioTranscription": map[string]any{},
		}
		if language != "" && language != "auto" {
			setup["systemInstruction"] = map[string]any{"parts": []map[string]string{{"text": "Transcribe the input audio in " + language + ". Do not answer or add commentary."}}}
		}
		return s.conn.WriteJSON(map[string]any{"setup": setup})
	}
	if s.vllm {
		// vLLM's OpenAI-compatible realtime API uses a flat session.update
		// payload. The nested OpenAI transcription-session shape is rejected or
		// ignored by vLLM and leaves the connection listening forever.
		return s.conn.WriteJSON(map[string]any{
			"type":  "session.update",
			"model": model,
		})
	}
	input := map[string]any{
		"format":        map[string]any{"type": "audio/pcm", "rate": s.inputRate},
		"transcription": map[string]any{"model": model},
	}
	if model == "gpt-realtime-whisper" {
		input["turn_detection"] = nil
	} else {
		input["turn_detection"] = map[string]any{
			"type":                "server_vad",
			"threshold":           0.45,
			"prefix_padding_ms":   300,
			"silence_duration_ms": 700,
		}
	}
	session := map[string]any{
		"type":  "transcription",
		"audio": map[string]any{"input": input},
	}
	transcription := input["transcription"].(map[string]any)
	if language != "" && language != "auto" {
		if model == "gpt-live-transcribe" || model == "gpt-transcribe" {
			transcription["languages"] = []string{language}
		} else {
			transcription["language"] = language
		}
	}
	return s.conn.WriteJSON(map[string]any{"type": "session.update", "session": session})
}

func (s *RealtimeStream) readEvents() {
	defer close(s.events)
	for {
		messageType, payload, err := s.conn.ReadMessage()
		if err != nil {
			if closeErr, ok := err.(*websocket.CloseError); ok {
				if closeErr.Code != websocket.CloseNormalClosure && closeErr.Code != websocket.CloseGoingAway {
					s.events <- RealtimeEvent{Kind: "error", Err: fmt.Errorf("provider websocket closed (%d): %s", closeErr.Code, closeErr.Text)}
				}
				return
			}
			if !strings.Contains(strings.ToLower(err.Error()), "close") {
				s.events <- RealtimeEvent{Kind: "error", Err: err}
			}
			return
		}
		if messageType != websocket.TextMessage {
			continue
		}
		if event := parseRealtimeEvent(s.provider, payload); event.Kind != "" {
			s.events <- event
		}
	}
}

func parseRealtimeEvent(providerName string, payload []byte) RealtimeEvent {
	if providerName == "gemini" {
		var event struct {
			ServerContent struct {
				InputTranscription *struct {
					Text string `json:"text"`
				} `json:"inputTranscription"`
				TurnComplete bool `json:"turnComplete"`
			} `json:"serverContent"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(payload, &event) != nil {
			return RealtimeEvent{}
		}
		if event.Error != nil {
			return RealtimeEvent{Kind: "error", Err: fmt.Errorf("gemini transcription: %s", event.Error.Message)}
		}
		if event.ServerContent.InputTranscription != nil && event.ServerContent.InputTranscription.Text != "" {
			kind := "partial"
			if event.ServerContent.TurnComplete {
				kind = "final"
			}
			return RealtimeEvent{Kind: kind, Text: event.ServerContent.InputTranscription.Text}
		}
		return RealtimeEvent{}
	}
	var event struct {
		Type       string `json:"type"`
		Delta      string `json:"delta"`
		Transcript string `json:"transcript"`
		Text       string `json:"text"`
		Error      *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return RealtimeEvent{}
	}
	if event.Error != nil || strings.HasSuffix(event.Type, ".failed") {
		message := "OpenAI transcription failed"
		if event.Error != nil && event.Error.Message != "" {
			message = event.Error.Message
		}
		return RealtimeEvent{Kind: "error", Err: fmt.Errorf("%s", message)}
	}
	textValue := firstNonEmpty(event.Delta, event.Transcript, event.Text)
	switch event.Type {
	case "transcription.delta":
		return RealtimeEvent{Kind: "partial", Text: textValue}
	case "transcription.done":
		return RealtimeEvent{Kind: "final", Text: textValue}
	case "conversation.item.input_audio_transcription.delta":
		return RealtimeEvent{Kind: "partial", Text: textValue}
	case "conversation.item.input_audio_transcription.completed":
		return RealtimeEvent{Kind: "final", Text: textValue}
	default:
		return RealtimeEvent{}
	}
}

func dialRealtime(ctx context.Context, endpoint Endpoint, model string) (*websocket.Conn, error) {
	base, err := url.Parse(endpoint.BaseURL)
	if err != nil {
		return nil, err
	}
	if base.Scheme == "https" {
		base.Scheme = "wss"
	} else if base.Scheme == "http" {
		base.Scheme = "ws"
	}
	if endpoint.ProviderType == "gemini" {
		base.Path = strings.TrimRight(base.Path, "/") + "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
		query := base.Query()
		query.Set("key", endpoint.Credential)
		base.RawQuery = query.Encode()
		connection, _, err := websocket.DefaultDialer.DialContext(ctx, base.String(), nil)
		return connection, err
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/realtime"
	query := base.Query()
	query.Set("model", model)
	base.RawQuery = query.Encode()
	header := http.Header{}
	if endpoint.Credential != "" {
		header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	header.Set("OpenAI-Beta", "realtime=v1")
	connection, _, err := websocket.DefaultDialer.DialContext(ctx, base.String(), header)
	return connection, err
}

type DiarizationSegment struct {
	Speaker string  `json:"speaker"`
	Text    string  `json:"text"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
}

// DiarizeMediaURL runs a whole-file diarization request against providers
// whose native API accepts media URLs. pyannote is intentionally separate from
// Diarize: it is a PyTorch pipeline, not an OpenAI-compatible transcription
// endpoint, and its speaker labels must be generated consistently for the
// complete recording rather than independently for rolling windows.
func DiarizeMediaURL(ctx context.Context, endpoint Endpoint, mediaURL, language string) ([]DiarizationSegment, error) {
	if endpoint.ProviderType != "pyannote" {
		return nil, fmt.Errorf("provider %s does not expose whole-file diarization", endpoint.ProviderType)
	}
	if strings.TrimSpace(mediaURL) == "" {
		return nil, fmt.Errorf("diarization media URL is empty")
	}
	payload := map[string]any{
		"media_url": mediaURL,
	}
	if model := strings.TrimSpace(endpoint.DiarizationModel); model != "" {
		payload["model"] = model
	}
	if language != "" && language != "auto" {
		// The current pyannote pipeline is language agnostic. Keep this field in
		// the request contract so a future service can use it without requiring
		// another backend adapter.
		payload["language"] = language
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/v1/diarize"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	var result struct {
		Segments []DiarizationSegment `json:"segments"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("pyannote returned invalid diarization JSON: %w", err)
	}
	return result.Segments, nil
}

func Diarize(ctx context.Context, endpoint Endpoint, pcm []byte, language string) ([]DiarizationSegment, error) {
	if len(pcm) == 0 {
		return nil, nil
	}
	if endpoint.ProviderType == "gemini" {
		return diarizeGemini(ctx, endpoint, pcm, language)
	}
	if endpoint.ProviderType != "openai" && endpoint.ProviderType != "openai-compatible" {
		return nil, fmt.Errorf("provider %s does not expose diarization", endpoint.ProviderType)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return nil, err
	}
	if _, err := file.Write(wavPCM16(pcm, 16000, 1)); err != nil {
		return nil, err
	}
	model := firstNonEmpty(endpoint.DiarizationModel, "gpt-4o-transcribe-diarize")
	_ = writer.WriteField("model", model)
	_ = writer.WriteField("response_format", "diarized_json")
	_ = writer.WriteField("chunking_strategy", "auto")
	if language != "" && language != "auto" {
		_ = writer.WriteField("language", language)
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(endpoint, "/audio/transcriptions"), &body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Credential)
	}
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	var result struct {
		Segments []DiarizationSegment `json:"segments"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result.Segments, nil
}

func diarizeGemini(ctx context.Context, endpoint Endpoint, pcm []byte, language string) ([]DiarizationSegment, error) {
	prompt := "Return only JSON with a segments array. Transcribe this audio with timestamps in seconds and assign anonymous speaker labels Speaker 1, Speaker 2, etc."
	if language != "" && language != "auto" {
		prompt += " The spoken language is " + language + "."
	}
	payload := map[string]any{"contents": []any{map[string]any{"parts": []any{
		map[string]any{"inlineData": map[string]string{"mimeType": "audio/wav", "data": base64.StdEncoding.EncodeToString(wavPCM16(pcm, 16000, 1))}},
		map[string]string{"text": prompt},
	}}}, "generationConfig": map[string]any{"responseMimeType": "application/json"}}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	model := firstNonEmpty(endpoint.DiarizationModel, endpoint.ChatModel, "gemini-2.5-flash")
	requestURL := joinURL(endpoint, "/v1beta/models/"+url.PathEscape(model)+":generateContent")
	parsed, err := url.Parse(requestURL)
	if err != nil {
		return nil, err
	}
	query := parsed.Query()
	query.Set("key", endpoint.Credential)
	parsed.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := doRequest(request, endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, responseError(response)
	}
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("gemini returned no diarization")
	}
	var parsedResult struct {
		Segments []DiarizationSegment `json:"segments"`
	}
	textValue := strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text)
	textValue = strings.TrimPrefix(textValue, "```")
	textValue = strings.TrimSuffix(textValue, "```")
	if err := json.Unmarshal([]byte(strings.TrimSpace(textValue)), &parsedResult); err != nil {
		return nil, err
	}
	return parsedResult.Segments, nil
}

func wavPCM16(pcm []byte, sampleRate, channels int) []byte {
	dataLength := len(pcm)
	buffer := bytes.NewBuffer(make([]byte, 0, dataLength+44))
	buffer.WriteString("RIFF")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(dataLength+36))
	buffer.WriteString("WAVEfmt ")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(16))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(1))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(channels))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(sampleRate))
	byteRate := sampleRate * channels * 2
	_ = binary.Write(buffer, binary.LittleEndian, uint32(byteRate))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(channels*2))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(16))
	buffer.WriteString("data")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(dataLength))
	_, _ = buffer.Write(pcm)
	return buffer.Bytes()
}

func resamplePCM16(pcm []byte, sourceRate, targetRate int) []byte {
	if sourceRate <= 0 || targetRate <= 0 || sourceRate == targetRate || len(pcm) < 2 {
		return pcm
	}
	sourceSamples := len(pcm) / 2
	targetSamples := int(math.Round(float64(sourceSamples) * float64(targetRate) / float64(sourceRate)))
	if targetSamples <= 0 {
		return nil
	}
	output := make([]byte, targetSamples*2)
	for index := 0; index < targetSamples; index++ {
		position := float64(index) * float64(sourceRate) / float64(targetRate)
		left := int(position)
		if left >= sourceSamples {
			left = sourceSamples - 1
		}
		right := left + 1
		if right >= sourceSamples {
			right = left
		}
		fraction := position - float64(left)
		leftValue := int16(binary.LittleEndian.Uint16(pcm[left*2:]))
		rightValue := int16(binary.LittleEndian.Uint16(pcm[right*2:]))
		value := int16(math.Round(float64(leftValue) + (float64(rightValue)-float64(leftValue))*fraction))
		binary.LittleEndian.PutUint16(output[index*2:], uint16(value))
	}
	return output
}
