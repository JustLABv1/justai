package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"
)

// TranscriptionStream is the transport-neutral contract used by the room
// handler. Native providers implement it with a provider WebSocket, while
// Whisper-style providers use a rolling HTTP transcription request.
type TranscriptionStream interface {
	SendPCM(context.Context, []byte, int) error
	Commit() error
	Events() <-chan RealtimeEvent
	Close()
}

// TurnCommitter is implemented by transports that need an explicit boundary
// after the user's speech ends. Realtime providers send a protocol commit;
// chunked HTTP providers flush their current rolling window without closing
// the stream so the next utterance can continue on the same voice session.
type TurnCommitter interface {
	CommitTurn() error
}

// SilenceForwarder lets server-VAD realtime providers receive quiet PCM while
// speech-gated transports (Whisper chunks and vLLM/Voxtral) keep silence local.
type SilenceForwarder interface {
	ForwardSilence() bool
}

type ChunkedOptions struct {
	Window         time.Duration
	Overlap        time.Duration
	Minimum        time.Duration
	PromptMaxChars int
}

func DefaultChunkedOptions() ChunkedOptions {
	return ChunkedOptions{
		Window:         2500 * time.Millisecond,
		Overlap:        500 * time.Millisecond,
		Minimum:        250 * time.Millisecond,
		PromptMaxChars: 160,
	}
}

func (options ChunkedOptions) normalized() ChunkedOptions {
	defaults := DefaultChunkedOptions()
	if options.Window <= 0 {
		options.Window = defaults.Window
	}
	if options.Overlap <= 0 || options.Overlap >= options.Window {
		options.Overlap = defaults.Overlap
	}
	if options.Minimum <= 0 || options.Minimum >= options.Window-options.Overlap {
		options.Minimum = defaults.Minimum
	}
	if options.PromptMaxChars <= 0 {
		options.PromptMaxChars = defaults.PromptMaxChars
	}
	return options
}

type chunkedAudio struct {
	pcm           []byte
	startOffsetMs int64
	endOffsetMs   int64
	resetPrevious bool
}

// ChunkedStream keeps a short rolling audio window in memory and sends each
// window to an OpenAI-compatible /audio/transcriptions endpoint. The provider
// can stream response tokens over SSE, but input remains a sequence of finite
// audio windows because Whisper is an encoder-decoder ASR model rather than a
// stateful Realtime protocol model.
type ChunkedStream struct {
	endpoint Endpoint
	model    string
	language string

	windowBytes    int
	overlapBytes   int
	minimumBytes   int
	promptMaxChars int

	ctx    context.Context
	cancel context.CancelFunc
	jobs   chan chunkedAudio
	events chan RealtimeEvent
	wg     sync.WaitGroup

	bufferMu      sync.Mutex
	buffer        []byte
	bufferStartMs int64
	committed     bool
	closed        bool

	closeOnce      sync.Once
	closeJobsOnce  sync.Once
	commitOnce     sync.Once
	errMu          sync.Mutex
	lastErr        error
	previousText   string
	promptDisabled bool
}

func (s *ChunkedStream) ForwardSilence() bool {
	return false
}

func OpenChunked(ctx context.Context, endpoint Endpoint, model, language string, options ChunkedOptions) (*ChunkedStream, error) {
	if endpoint.ProviderType != "openai" && endpoint.ProviderType != "openai-compatible" {
		return nil, fmt.Errorf("provider %s does not expose OpenAI-compatible HTTP transcription", endpoint.ProviderType)
	}
	model = firstNonEmpty(model, endpoint.TranscriptionModel, "whisper-large-v3-turbo")
	options = options.normalized()
	streamContext, cancel := context.WithCancel(ctx)
	stream := &ChunkedStream{
		endpoint:       endpoint,
		model:          model,
		language:       language,
		windowBytes:    durationBytes(options.Window),
		overlapBytes:   durationBytes(options.Overlap),
		minimumBytes:   durationBytes(options.Minimum),
		promptMaxChars: options.PromptMaxChars,
		ctx:            streamContext,
		cancel:         cancel,
		jobs:           make(chan chunkedAudio, 4),
		events:         make(chan RealtimeEvent, 64),
	}
	if stream.overlapBytes >= stream.windowBytes {
		cancel()
		return nil, fmt.Errorf("chunk overlap must be shorter than the chunk window")
	}
	stream.wg.Add(1)
	go stream.run()
	return stream, nil
}

func durationBytes(duration time.Duration) int {
	bytes := int(duration * 16000 * 2 / time.Second)
	if bytes < 2 {
		return 2
	}
	if bytes%2 != 0 {
		bytes--
	}
	return bytes
}

func (s *ChunkedStream) SendPCM(ctx context.Context, pcm []byte, sampleRate int) error {
	if len(pcm) == 0 {
		return nil
	}
	if ctx != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
	if sampleRate <= 0 {
		sampleRate = 16000
	}
	pcm = resamplePCM16(pcm, sampleRate, 16000)
	if len(pcm)%2 != 0 {
		pcm = pcm[:len(pcm)-1]
	}

	s.bufferMu.Lock()
	if s.closed || s.committed {
		s.bufferMu.Unlock()
		return fmt.Errorf("chunked transcription stream is closed")
	}
	s.buffer = append(s.buffer, pcm...)
	jobs := make([]chunkedAudio, 0, 1)
	for len(s.buffer) >= s.windowBytes {
		jobs = append(jobs, s.takeChunkLocked(s.windowBytes, s.windowBytes-s.overlapBytes))
	}
	s.bufferMu.Unlock()

	for _, job := range jobs {
		if err := s.enqueue(job); err != nil {
			return err
		}
	}
	return nil
}

func (s *ChunkedStream) takeChunkLocked(length, advance int) chunkedAudio {
	if advance <= 0 || advance > length {
		advance = length
	}
	chunk := make([]byte, length)
	copy(chunk, s.buffer[:length])
	start := s.bufferStartMs
	s.buffer = append([]byte(nil), s.buffer[advance:]...)
	s.bufferStartMs += int64(advance/2) * 1000 / 16000
	return chunkedAudio{
		pcm:           chunk,
		startOffsetMs: start,
		endOffsetMs:   start + int64(length/2)*1000/16000,
	}
}

func (s *ChunkedStream) enqueue(job chunkedAudio) error {
	select {
	case s.jobs <- job:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *ChunkedStream) Commit() error {
	var enqueueErr error
	s.commitOnce.Do(func() {
		var job *chunkedAudio
		s.bufferMu.Lock()
		if !s.closed && len(s.buffer) >= s.minimumBytes {
			value := s.takeChunkLocked(len(s.buffer), len(s.buffer))
			value.resetPrevious = true
			job = &value
		}
		s.committed = true
		s.bufferMu.Unlock()
		if job != nil {
			enqueueErr = s.enqueue(*job)
		}
		s.closeJobs()
	})
	s.wg.Wait()
	if enqueueErr != nil {
		s.errMu.Lock()
		if s.lastErr == nil {
			s.lastErr = enqueueErr
		}
		s.errMu.Unlock()
	}
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.lastErr
}

// CommitTurn flushes a short utterance before the rolling window is full while
// keeping the stream open for the next utterance. Without this boundary,
// Whisper sessions only submit audio after the full window (normally 2.5s),
// which makes a user who speaks a short sentence appear stuck on Listening.
func (s *ChunkedStream) CommitTurn() error {
	var job *chunkedAudio
	s.bufferMu.Lock()
	if !s.closed && !s.committed && len(s.buffer) >= s.minimumBytes {
		value := s.takeChunkLocked(len(s.buffer), len(s.buffer))
		value.resetPrevious = true
		job = &value
	}
	s.bufferMu.Unlock()
	if job == nil {
		return nil
	}
	return s.enqueue(*job)
}

func (s *ChunkedStream) Events() <-chan RealtimeEvent {
	return s.events
}

func (s *ChunkedStream) Close() {
	s.closeOnce.Do(func() {
		s.bufferMu.Lock()
		s.closed = true
		s.bufferMu.Unlock()
		s.cancel()
		s.closeJobs()
	})
	s.wg.Wait()
}

func (s *ChunkedStream) closeJobs() {
	s.closeJobsOnce.Do(func() {
		close(s.jobs)
	})
}

func (s *ChunkedStream) run() {
	defer s.wg.Done()
	defer close(s.events)
	for job := range s.jobs {
		if s.ctx.Err() != nil {
			return
		}
		if err := s.transcribe(job); err != nil {
			s.errMu.Lock()
			s.lastErr = err
			s.errMu.Unlock()
			s.emit(RealtimeEvent{Kind: "error", Err: err})
		}
	}
}

func (s *ChunkedStream) emit(event RealtimeEvent) {
	select {
	case s.events <- event:
	case <-s.ctx.Done():
	}
}

func (s *ChunkedStream) transcribe(job chunkedAudio) error {
	if !PCM16HasSustainedSpeech(job.pcm) {
		return nil
	}
	if job.resetPrevious {
		// Rolling-window overlap is useful within one utterance, but carrying
		// the previous turn into a new utterance can incorrectly remove a
		// repeated opening word (for example, "hello" -> "hello again").
		s.previousText = ""
	}
	prompt := ""
	if !s.promptDisabled {
		prompt = trimTranscriptPrompt(s.previousText, s.promptMaxChars)
	}
	response, err := s.postTranscription(job, prompt)
	if err != nil {
		return err
	}
	if response.StatusCode >= 300 {
		responseErr, isContextLimit := chunkedResponseError(response)
		if !isContextLimit || prompt == "" {
			return responseErr
		}

		// Some gateways expose a much smaller decoder context than the
		// OpenAI-compatible API advertises. Disable prompt carry-over for
		// the rest of this stream and retry the audio window once.
		s.promptDisabled = true
		response, err = s.postTranscription(job, "")
		if err != nil {
			return err
		}
		if response.StatusCode >= 300 {
			responseErr, _ = chunkedResponseError(response)
			return responseErr
		}
	}
	defer response.Body.Close()

	textValue, err := s.readTranscriptionResponse(response.Body, response.Header.Get("Content-Type"), job)
	if err != nil {
		return err
	}
	textValue = CleanTranscriptText(textValue)
	if textValue == "" {
		return nil
	}
	novel := removeTranscriptOverlap(s.previousText, textValue)
	s.previousText = textValue
	if strings.TrimSpace(novel) == "" {
		return nil
	}
	event := RealtimeEvent{Kind: "final", Text: strings.TrimSpace(novel), StartOffsetMs: job.startOffsetMs, EndOffsetMs: job.endOffsetMs}
	s.emit(event)
	return nil
}

func (s *ChunkedStream) postTranscription(job chunkedAudio, prompt string) (*http.Response, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return nil, err
	}
	if _, err := file.Write(wavPCM16(job.pcm, 16000, 1)); err != nil {
		return nil, err
	}
	if err := writer.WriteField("model", s.model); err != nil {
		return nil, err
	}
	if s.language != "" && s.language != "auto" {
		if err := writer.WriteField("language", s.language); err != nil {
			return nil, err
		}
	}
	if prompt != "" {
		if err := writer.WriteField("prompt", prompt); err != nil {
			return nil, err
		}
	}
	if err := writer.WriteField("response_format", "json"); err != nil {
		return nil, err
	}
	if err := writer.WriteField("stream", "true"); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(s.ctx, http.MethodPost, joinURL(s.endpoint, "/audio/transcriptions"), &body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Accept", "text/event-stream, application/json")
	if s.endpoint.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+s.endpoint.Credential)
	}
	response, err := doRequest(request, s.endpoint.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	return response, nil
}

func chunkedResponseError(response *http.Response) (error, bool) {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	_ = response.Body.Close()
	message := strings.TrimSpace(string(body))
	errorValue := fmt.Errorf("provider request failed (%d): %s", response.StatusCode, message)
	lower := strings.ToLower(message)
	isContextLimit := strings.Contains(lower, "context") && (strings.Contains(lower, "token") || strings.Contains(lower, "window"))
	return errorValue, isContextLimit
}

func (s *ChunkedStream) readTranscriptionResponse(body io.Reader, contentType string, job chunkedAudio) (string, error) {
	streaming := strings.Contains(strings.ToLower(contentType), "text/event-stream")
	if streaming {
		return s.readSSETranscriptionResponse(body, job)
	}

	payload, err := io.ReadAll(io.LimitReader(body, 4*1024*1024))
	if err != nil {
		return "", err
	}
	if looksLikeSSEPayload(payload) {
		return s.readSSETranscriptionResponse(bytes.NewReader(payload), job)
	}
	value, replace, err := parseHTTPTranscriptionEvent(payload)
	if err != nil {
		return "", err
	}
	// A few gateways wrap their SSE body in the JSON `text` field while
	// returning application/json. Unwrap that body before it can be stored as
	// a literal transcript.
	if replace && looksLikeSSEPayload([]byte(value)) {
		return s.readSSETranscriptionResponse(strings.NewReader(value), job)
	}
	if replace {
		return value, nil
	}
	return value, nil
}

func (s *ChunkedStream) readSSETranscriptionResponse(body io.Reader, job chunkedAudio) (string, error) {
	accumulated := ""
	apply := func(value string, replace bool) {
		value = CleanTranscriptText(value)
		if value == "" {
			return
		}
		if replace {
			accumulated = value
		} else {
			accumulated = appendTranscriptDelta(accumulated, value)
		}
		novel := strings.TrimSpace(removeTranscriptOverlap(s.previousText, accumulated))
		if novel != "" {
			s.emit(RealtimeEvent{Kind: "partial", Text: novel, StartOffsetMs: job.startOffsetMs, EndOffsetMs: job.endOffsetMs})
		}
	}

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		for _, line := range splitSSEDataLine(scanner.Text()) {
			if line == "" || line == "[DONE]" {
				continue
			}
			value, replace, err := parseHTTPTranscriptionEvent([]byte(line))
			if err != nil {
				return "", err
			}
			apply(value, replace)
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return accumulated, nil
}

func looksLikeSSEPayload(payload []byte) bool {
	value := strings.TrimSpace(string(payload))
	return strings.HasPrefix(value, "data:")
}

func splitSSEDataLine(raw string) []string {
	line := strings.TrimSpace(raw)
	if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
		return nil
	}
	remainder := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	parts := strings.Split(remainder, " data:")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func parseHTTPTranscriptionEvent(payload []byte) (string, bool, error) {
	var event struct {
		Text       string `json:"text"`
		Transcript string `json:"transcript"`
		Delta      string `json:"delta"`
		Error      *struct {
			Message string `json:"message"`
		} `json:"error"`
		Choices []struct {
			Text  string `json:"text"`
			Delta struct {
				Content string `json:"content"`
				Text    string `json:"text"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		return "", false, err
	}
	if event.Error != nil && event.Error.Message != "" {
		return "", false, fmt.Errorf("transcription provider: %s", event.Error.Message)
	}
	if event.Delta != "" {
		return event.Delta, false, nil
	}
	for _, choice := range event.Choices {
		if choice.Delta.Content != "" {
			return choice.Delta.Content, false, nil
		}
		if choice.Delta.Text != "" {
			return choice.Delta.Text, false, nil
		}
		if choice.Text != "" {
			return choice.Text, true, nil
		}
	}
	if event.Text != "" {
		return event.Text, true, nil
	}
	if event.Transcript != "" {
		return event.Transcript, true, nil
	}
	return "", false, nil
}

func appendTranscriptDelta(current, delta string) string {
	if current == "" {
		return delta
	}
	if strings.HasPrefix(delta, current) {
		return delta
	}
	if strings.HasPrefix(current, delta) {
		return current
	}
	return current + delta
}

func removeTranscriptOverlap(previous, current string) string {
	previousWords := strings.Fields(previous)
	currentWords := strings.Fields(current)
	if len(previousWords) == 0 || len(currentWords) == 0 {
		return current
	}
	max := len(previousWords)
	if len(currentWords) < max {
		max = len(currentWords)
	}
	for size := max; size > 0; size-- {
		matches := true
		for index := 0; index < size; index++ {
			left := normalizeTranscriptWord(previousWords[len(previousWords)-size+index])
			right := normalizeTranscriptWord(currentWords[index])
			if left == "" || left != right {
				matches = false
				break
			}
		}
		if matches {
			return strings.Join(currentWords[size:], " ")
		}
	}
	return current
}

func normalizeTranscriptWord(value string) string {
	return strings.ToLower(strings.Trim(value, " \t\r\n.,!?;:\"'()[]{}"))
}

func trimTranscriptPrompt(value string, maxChars int) string {
	value = strings.TrimSpace(value)
	if value == "" || maxChars <= 0 {
		return ""
	}
	valueRunes := []rune(value)
	if len(valueRunes) <= maxChars {
		return value
	}

	words := strings.Fields(value)
	selected := make([]string, 0, len(words))
	selectedChars := 0
	for index := len(words) - 1; index >= 0; index-- {
		wordChars := len([]rune(words[index]))
		separatorChars := 0
		if len(selected) > 0 {
			separatorChars = 1
		}
		if selectedChars+separatorChars+wordChars > maxChars {
			break
		}
		selected = append([]string{words[index]}, selected...)
		selectedChars += separatorChars + wordChars
	}
	if len(selected) > 0 {
		return strings.Join(selected, " ")
	}
	return string(valueRunes[len(valueRunes)-maxChars:])
}
