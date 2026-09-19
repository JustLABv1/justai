package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
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

// httpStreamConnection gives the existing realtime session code a small,
// transport-neutral duplex pipe. The browser receives output over SSE and
// sends control/audio input over finite HTTP requests.
type httpStreamConnection struct {
	id             uuid.UUID
	userID         uuid.UUID
	organizationID uuid.UUID
	in             chan streamMessage
	out            chan []byte
	done           chan struct{}
	closeOnce      sync.Once
}

func newHTTPStreamConnection(userID, organizationID uuid.UUID) *httpStreamConnection {
	return &httpStreamConnection{
		id:             uuid.New(),
		userID:         userID,
		organizationID: organizationID,
		in:             make(chan streamMessage, 64),
		out:            make(chan []byte, 256),
		done:           make(chan struct{}),
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
	select {
	case s.out <- payload:
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
	s.closeOnce.Do(func() { close(s.done) })
	return nil
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
	a.httpStreams[connection.id] = connection
	a.httpStreamsMu.Unlock()
}

func (a *App) unregisterHTTPStream(connection *httpStreamConnection) {
	a.httpStreamsMu.Lock()
	if a.httpStreams[connection.id] == connection {
		delete(a.httpStreams, connection.id)
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
	if principal, ok := middleware.GetPrincipal(c); ok && connection.userID != uuid.Nil && principal.UserID != connection.userID {
		return nil, errors.New("stream not found")
	}
	return connection, nil
}

func (a *App) writeHTTPStreamEvent(c *gin.Context) {
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
	if err := connection.enqueue(streamTextMessage, payload); err != nil {
		writeError(c, http.StatusGone, err)
		return
	}
	c.Status(http.StatusAccepted)
	c.Writer.WriteHeaderNow()
}

func (a *App) writeHTTPStreamAudio(c *gin.Context) {
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
	c.Status(http.StatusAccepted)
	c.Writer.WriteHeaderNow()
}

func serveSSE(c *gin.Context, connection *httpStreamConnection) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		writeError(c, http.StatusInternalServerError, errors.New("streaming is not supported"))
		return
	}
	ready, _ := json.Marshal(map[string]any{"type": "transport.ready", "data": map[string]string{"streamId": connection.id.String()}})
	_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", ready)
	flusher.Flush()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case payload := <-connection.out:
			_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(c.Writer, ": keep-alive\n\n")
			flusher.Flush()
		case <-connection.done:
			return
		case <-c.Request.Context().Done():
			return
		}
	}
}
