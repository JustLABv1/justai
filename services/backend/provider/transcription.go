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

	"github.com/gorilla/websocket"
)

type RealtimeEvent struct {
	Kind string
	Text string
	Err  error
}

type RealtimeStream struct {
	provider  string
	inputRate int
	conn      *websocket.Conn
	writeMu   sync.Mutex
	events    chan RealtimeEvent
	closeMu   sync.Once
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
	if endpoint.ProviderType == "gemini" {
		inputRate = 16000
	}
	stream := &RealtimeStream{provider: endpoint.ProviderType, inputRate: inputRate, events: make(chan RealtimeEvent, 32)}
	connection, err := dialRealtime(ctx, endpoint, model)
	if err != nil {
		return nil, err
	}
	stream.conn = connection
	if err := stream.configure(model, language); err != nil {
		_ = connection.Close()
		return nil, err
	}
	go stream.readEvents()
	return stream, nil
}

func (s *RealtimeStream) SendPCM(ctx context.Context, pcm []byte, sampleRate int) error {
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.provider == "gemini" {
		return s.conn.WriteJSON(map[string]any{"realtimeInput": map[string]any{"audioStreamEnd": true}})
	}
	return s.conn.WriteJSON(map[string]any{"type": "input_audio_buffer.commit"})
}

func (s *RealtimeStream) Events() <-chan RealtimeEvent {
	return s.events
}

func (s *RealtimeStream) Close() {
	s.closeMu.Do(func() {
		_ = s.conn.Close()
	})
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
	textValue := firstNonEmpty(event.Delta, event.Transcript)
	switch event.Type {
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
