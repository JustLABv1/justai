package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

const (
	streamTextMessage   = 1
	streamBinaryMessage = 2
	streamCloseMessage  = 8
)

type streamMessage struct {
	messageType int
	payload     []byte
}

type streamOutput struct {
	id      int64
	payload []byte
}

type httpStreamMetrics struct {
	active         atomic.Int64
	uploadBytes    atomic.Int64
	audioFrames    atomic.Int64
	rejected       atomic.Int64
	controlDedupes atomic.Int64
	uploadRequests atomic.Int64
	uploadMicros   atomic.Int64
}

// httpStreamConnection gives the existing realtime session code a small,
// transport-neutral duplex pipe. The browser receives output over SSE and
// sends control/audio input over finite HTTP requests.
type httpStreamConnection struct {
	id             uuid.UUID
	userID         uuid.UUID
	organizationID uuid.UUID
	in             chan streamMessage
	out            chan streamOutput
	done           chan struct{}
	closeOnce      sync.Once
	ctx            context.Context
	cancel         context.CancelFunc
	uploadToken    string
	uploadHash     [32]byte
	controlMu      sync.Mutex
	controlSeq     int64
	rateMu         sync.Mutex
	rateStarted    time.Time
	rateBytes      int64
	outputMu       sync.Mutex
	nextOutputID   int64
	replay         []streamOutput
	resumeToken    string
	resumeHash     [32]byte
	attachMu       sync.Mutex
	attachVersion  int64
	expiresAt      time.Time
}

func newHTTPStreamConnection(userID, organizationID uuid.UUID) *httpStreamConnection {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		panic("secure stream token generation failed: " + err.Error())
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	resumeBytes := make([]byte, 32)
	if _, err := rand.Read(resumeBytes); err != nil {
		panic("secure stream resume token generation failed: " + err.Error())
	}
	resumeToken := base64.RawURLEncoding.EncodeToString(resumeBytes)
	streamContext, cancel := context.WithCancel(context.Background())
	return &httpStreamConnection{
		id:             uuid.New(),
		userID:         userID,
		organizationID: organizationID,
		in:             make(chan streamMessage, 64),
		out:            make(chan streamOutput, 256),
		done:           make(chan struct{}),
		uploadToken:    token,
		uploadHash:     sha256.Sum256([]byte(token)),
		resumeToken:    resumeToken,
		resumeHash:     sha256.Sum256([]byte(resumeToken)),
		rateStarted:    time.Now(),
		ctx:            streamContext,
		cancel:         cancel,
		expiresAt:      time.Now().Add(12 * time.Hour),
	}
}

func (s *httpStreamConnection) ReadMessage() (int, []byte, error) {
	select {
	case message := <-s.in:
		return message.messageType, message.payload, nil
	case <-s.done:
		return 0, nil, io.EOF
	}
}

func (s *httpStreamConnection) WriteJSON(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	s.outputMu.Lock()
	s.nextOutputID++
	output := streamOutput{id: s.nextOutputID, payload: payload}
	s.replay = append(s.replay, output)
	if len(s.replay) > 256 {
		s.replay = append([]streamOutput(nil), s.replay[len(s.replay)-256:]...)
	}
	s.outputMu.Unlock()
	select {
	case s.out <- output:
		return nil
	case <-s.done:
		return io.ErrClosedPipe
	case <-time.After(10 * time.Second):
		return context.DeadlineExceeded
	}
}

func (s *httpStreamConnection) SetWriteDeadline(time.Time) error  { return nil }
func (s *httpStreamConnection) SetReadDeadline(time.Time) error   { return nil }
func (s *httpStreamConnection) SetReadLimit(int64)                {}
func (s *httpStreamConnection) SetPongHandler(func(string) error) {}
func (s *httpStreamConnection) WriteControl(messageType int, _ []byte, _ time.Time) error {
	if messageType == streamCloseMessage {
		return s.Close()
	}
	return nil
}
func (s *httpStreamConnection) Close() error {
	s.closeOnce.Do(func() {
		s.cancel()
		close(s.done)
	})
	return nil
}

func (s *httpStreamConnection) attach() int64 {
	s.attachMu.Lock()
	defer s.attachMu.Unlock()
	s.attachVersion++
	return s.attachVersion
}

func (s *httpStreamConnection) closeIfDetached(version int64) {
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		s.attachMu.Lock()
		current := s.attachVersion
		s.attachMu.Unlock()
		if current == version {
			_ = s.Close()
		}
	case <-s.done:
	}
}

func (s *httpStreamConnection) enqueue(messageType int, payload []byte) error {
	select {
	case s.in <- streamMessage{messageType: messageType, payload: payload}:
		return nil
	case <-s.done:
		return io.ErrClosedPipe
	case <-time.After(5 * time.Second):
		return fmt.Errorf("stream input queue is full")
	}
}

type realtimeConnection interface {
	ReadMessage() (int, []byte, error)
	WriteJSON(any) error
	WriteControl(int, []byte, time.Time) error
	SetWriteDeadline(time.Time) error
	SetReadDeadline(time.Time) error
	SetReadLimit(int64)
	SetPongHandler(func(string) error)
	Close() error
}

func (a *App) registerHTTPStream(connection *httpStreamConnection) {
	a.httpStreamsMu.Lock()
	if a.httpStreams == nil {
		a.httpStreams = make(map[uuid.UUID]*httpStreamConnection)
	}
	if a.httpStreamResumes == nil {
		a.httpStreamResumes = make(map[[32]byte]*httpStreamConnection)
	}
	a.httpStreams[connection.id] = connection
	a.httpStreamResumes[connection.resumeHash] = connection
	a.httpStreamMetrics.active.Add(1)
	a.httpStreamsMu.Unlock()
}

func (a *App) unregisterHTTPStream(connection *httpStreamConnection) {
	a.httpStreamsMu.Lock()
	if a.httpStreams[connection.id] == connection {
		delete(a.httpStreams, connection.id)
		delete(a.httpStreamResumes, connection.resumeHash)
		a.httpStreamMetrics.active.Add(-1)
	}
	a.httpStreamsMu.Unlock()
	_ = connection.Close()
}

func (a *App) lookupHTTPStream(c *gin.Context) (*httpStreamConnection, error) {
	id, err := uuid.Parse(c.Param("streamId"))
	if err != nil {
		return nil, errors.New("invalid stream id")
	}
	a.httpStreamsMu.RLock()
	connection := a.httpStreams[id]
	a.httpStreamsMu.RUnlock()
	if connection == nil {
		return nil, errors.New("stream not found")
	}
	provided := sha256.Sum256([]byte(c.GetHeader("X-Stream-Token")))
	if subtle.ConstantTimeCompare(provided[:], connection.uploadHash[:]) != 1 {
		a.httpStreamMetrics.rejected.Add(1)
		return nil, errors.New("stream not found")
	}
	if principal, ok := middleware.GetPrincipal(c); ok && connection.userID != uuid.Nil && principal.UserID != connection.userID {
		return nil, errors.New("stream not found")
	}
	return connection, nil
}

func (a *App) lookupHTTPStreamResume(value string) *httpStreamConnection {
	provided := sha256.Sum256([]byte(value))
	a.httpStreamsMu.RLock()
	defer a.httpStreamsMu.RUnlock()
	return a.httpStreamResumes[provided]
}

func (s *httpStreamConnection) allowBytes(size int64) bool {
	const maxBytesPerSecond = 8 * 1024 * 1024
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	now := time.Now()
	if now.Sub(s.rateStarted) >= time.Second {
		s.rateStarted = now
		s.rateBytes = 0
	}
	if size < 0 || s.rateBytes+size > maxBytesPerSecond {
		return false
	}
	s.rateBytes += size
	return true
}

func (a *App) writeHTTPStreamEvent(c *gin.Context) {
	started := time.Now()
	defer func() {
		a.httpStreamMetrics.uploadRequests.Add(1)
		a.httpStreamMetrics.uploadMicros.Add(time.Since(started).Microseconds())
	}()
	if !strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "application/json") {
		writeError(c, http.StatusUnsupportedMediaType, errors.New("application/json is required"))
		return
	}
	connection, err := a.lookupHTTPStream(c)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(c.Request.Body, 256*1024))
	if err != nil || len(payload) == 0 {
		writeError(c, http.StatusBadRequest, errors.New("event body is required"))
		return
	}
	var control struct {
		TransportSequence int64 `json:"transportSequence"`
	}
	if json.Unmarshal(payload, &control) != nil || control.TransportSequence <= 0 {
		writeError(c, http.StatusBadRequest, errors.New("a positive transportSequence is required"))
		return
	}
	connection.controlMu.Lock()
	if control.TransportSequence <= connection.controlSeq {
		a.httpStreamMetrics.controlDedupes.Add(1)
		connection.controlMu.Unlock()
		c.Status(http.StatusNoContent)
		c.Writer.WriteHeaderNow()
		return
	}
	connection.controlSeq = control.TransportSequence
	connection.controlMu.Unlock()
	if err := connection.enqueue(streamTextMessage, payload); err != nil {
		writeError(c, http.StatusGone, err)
		return
	}
	c.Status(http.StatusAccepted)
	c.Writer.WriteHeaderNow()
}

func (a *App) writeHTTPStreamAudio(c *gin.Context) {
	started := time.Now()
	defer func() {
		a.httpStreamMetrics.uploadRequests.Add(1)
		a.httpStreamMetrics.uploadMicros.Add(time.Since(started).Microseconds())
	}()
	if !strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "application/octet-stream") {
		writeError(c, http.StatusUnsupportedMediaType, errors.New("application/octet-stream is required"))
		return
	}
	connection, err := a.lookupHTTPStream(c)
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(c.Request.Body, 4*1024*1024))
	if err != nil || len(payload) == 0 {
		writeError(c, http.StatusBadRequest, errors.New("audio body is required"))
		return
	}
	if !connection.allowBytes(int64(len(payload))) {
		a.httpStreamMetrics.rejected.Add(1)
		writeError(c, http.StatusTooManyRequests, errors.New("audio upload rate exceeded"))
		return
	}
	uploadSize := len(payload)
	// Binary uploads contain one or more uint32-length-prefixed frames. This
	// keeps microphone traffic efficient without requiring a long-lived upload.
	frameCount := 0
	for len(payload) > 0 {
		frameCount++
		if frameCount > 512 {
			writeError(c, http.StatusBadRequest, errors.New("audio batch contains too many frames"))
			return
		}
		if len(payload) < 4 {
			writeError(c, http.StatusBadRequest, errors.New("invalid audio batch"))
			return
		}
		length := int(binary.BigEndian.Uint32(payload[:4]))
		payload = payload[4:]
		if length < 17 || length > 2*1024*1024 || length > len(payload) {
			writeError(c, http.StatusBadRequest, errors.New("invalid audio frame length"))
			return
		}
		if err := connection.enqueue(streamBinaryMessage, append([]byte(nil), payload[:length]...)); err != nil {
			writeError(c, http.StatusGone, err)
			return
		}
		payload = payload[length:]
	}
	a.httpStreamMetrics.uploadBytes.Add(int64(uploadSize))
	a.httpStreamMetrics.audioFrames.Add(int64(frameCount))
	c.Status(http.StatusAccepted)
	c.Writer.WriteHeaderNow()
}

func (a *App) httpStreamQueueDepth() int {
	a.httpStreamsMu.RLock()
	defer a.httpStreamsMu.RUnlock()
	total := 0
	for _, connection := range a.httpStreams {
		total += len(connection.in) + len(connection.out)
	}
	return total
}

func serveSSE(c *gin.Context, connection *httpStreamConnection) {
	attachment := connection.attach()
	defer func() { go connection.closeIfDetached(attachment) }()
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		writeError(c, http.StatusInternalServerError, errors.New("streaming is not supported"))
		return
	}
	readyType := "transport.ready"
	if c.Query("resume") != "" {
		readyType = "transport.resumed"
	}
	ready, _ := json.Marshal(map[string]any{"type": readyType, "data": map[string]string{"streamId": connection.id.String(), "uploadToken": connection.uploadToken, "resumeToken": connection.resumeToken}})
	_, _ = fmt.Fprintf(c.Writer, "id: 0\ndata: %s\n\n", ready)
	lastDelivered, _ := strconv.ParseInt(firstNonEmptyString(c.Query("lastEventId"), c.GetHeader("Last-Event-ID")), 10, 64)
	connection.outputMu.Lock()
	replay := append([]streamOutput(nil), connection.replay...)
	connection.outputMu.Unlock()
	for _, output := range replay {
		if output.id > lastDelivered {
			_, _ = fmt.Fprintf(c.Writer, "id: %d\ndata: %s\n\n", output.id, output.payload)
			lastDelivered = output.id
		}
	}
	flusher.Flush()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	lifetime := time.Until(connection.expiresAt)
	if lifetime <= 0 {
		lifetime = time.Nanosecond
	}
	maximumLifetime := time.NewTimer(lifetime)
	defer maximumLifetime.Stop()
	for {
		select {
		case output := <-connection.out:
			if output.id <= lastDelivered {
				continue
			}
			_, _ = fmt.Fprintf(c.Writer, "id: %d\ndata: %s\n\n", output.id, output.payload)
			lastDelivered = output.id
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(c.Writer, ": keep-alive\n\n")
			flusher.Flush()
		case <-connection.done:
			return
		case <-maximumLifetime.C:
			_ = connection.Close()
			return
		case <-c.Request.Context().Done():
			return
		}
	}
}
