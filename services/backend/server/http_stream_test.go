package server

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func readSSEBlock(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var lines []string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE block: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return strings.Join(lines, "\n")
		}
		lines = append(lines, line)
	}
}

func TestHTTPStreamConnectionCarriesJSONOutput(t *testing.T) {
	connection := newHTTPStreamConnection(uuid.New(), uuid.New())
	defer connection.Close()
	value := map[string]any{"type": "session.ready", "sequence": float64(1)}
	if err := connection.WriteJSON(value); err != nil {
		t.Fatalf("write JSON: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal((<-connection.out).payload, &decoded); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	if decoded["type"] != "session.ready" {
		t.Fatalf("unexpected event: %#v", decoded)
	}
}

func TestHTTPStreamAudioExpandsBatchedFrames(t *testing.T) {
	gin.SetMode(gin.TestMode)
	app := &App{httpStreams: make(map[uuid.UUID]*httpStreamConnection)}
	connection := newHTTPStreamConnection(uuid.Nil, uuid.Nil)
	app.registerHTTPStream(connection)
	defer app.unregisterHTTPStream(connection)

	frames := [][]byte{bytes.Repeat([]byte{1}, 17), bytes.Repeat([]byte{2}, 21)}
	var body bytes.Buffer
	for _, frame := range frames {
		if err := binary.Write(&body, binary.BigEndian, uint32(len(frame))); err != nil {
			t.Fatal(err)
		}
		_, _ = body.Write(frame)
	}

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Params = gin.Params{{Key: "streamId", Value: connection.id.String()}}
	context.Request = httptest.NewRequest(http.MethodPost, "/audio", &body)
	context.Request.Header.Set("Content-Type", "application/octet-stream")
	context.Request.Header.Set("X-Stream-Token", connection.uploadToken)
	app.writeHTTPStreamAudio(context)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", recorder.Code, recorder.Body.String())
	}
	for index, expected := range frames {
		messageType, payload, err := connection.ReadMessage()
		if err != nil {
			t.Fatalf("read frame %d: %v", index, err)
		}
		if messageType != streamBinaryMessage || !bytes.Equal(payload, expected) {
			t.Fatalf("unexpected frame %d: type=%d payload=%v", index, messageType, payload)
		}
	}
}

func TestHTTPStreamAudioDeduplicatesRetriedBatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	app := &App{httpStreams: make(map[uuid.UUID]*httpStreamConnection)}
	connection := newHTTPStreamConnection(uuid.Nil, uuid.Nil)
	app.registerHTTPStream(connection)
	defer app.unregisterHTTPStream(connection)
	frame := bytes.Repeat([]byte{3}, 21)
	var body bytes.Buffer
	_ = binary.Write(&body, binary.BigEndian, uint32(len(frame)))
	_, _ = body.Write(frame)
	post := func(sequence string, data []byte) int {
		recorder := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(recorder)
		context.Params = gin.Params{{Key: "streamId", Value: connection.id.String()}}
		context.Request = httptest.NewRequest(http.MethodPost, "/audio", bytes.NewReader(data))
		context.Request.Header.Set("Content-Type", "application/octet-stream")
		context.Request.Header.Set("X-Stream-Token", connection.uploadToken)
		context.Request.Header.Set("X-Audio-Batch-Sequence", sequence)
		app.writeHTTPStreamAudio(context)
		return recorder.Code
	}
	if status := post("2", body.Bytes()); status != http.StatusConflict {
		t.Fatalf("expected out-of-order batch rejected, got %d", status)
	}
	if status := post("1", body.Bytes()); status != http.StatusAccepted {
		t.Fatalf("expected first batch accepted, got %d", status)
	}
	if status := post("1", body.Bytes()); status != http.StatusNoContent {
		t.Fatalf("expected retried batch deduplicated, got %d", status)
	}
	if queued := len(connection.in); queued != 1 {
		t.Fatalf("expected one queued batch, got %d", queued)
	}
	messageType, payload, err := connection.ReadMessage()
	if err != nil || messageType != streamBinaryMessage || !bytes.Equal(payload, frame) {
		t.Fatalf("unexpected audio frame: type=%d payload=%v error=%v", messageType, payload, err)
	}
	if status := post("2", append(body.Bytes(), []byte{0, 0, 0}...)); status != http.StatusBadRequest {
		t.Fatalf("expected invalid batch rejected before enqueue, got %d", status)
	}
	if status := post("2", body.Bytes()); status != http.StatusAccepted {
		t.Fatalf("expected valid next batch accepted, got %d", status)
	}
}

func TestHTTPStreamRejectsMissingUploadToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	app := &App{httpStreams: make(map[uuid.UUID]*httpStreamConnection)}
	connection := newHTTPStreamConnection(uuid.Nil, uuid.Nil)
	app.registerHTTPStream(connection)
	defer app.unregisterHTTPStream(connection)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Params = gin.Params{{Key: "streamId", Value: connection.id.String()}}
	context.Request = httptest.NewRequest(http.MethodPost, "/events", bytes.NewBufferString(`{"type":"ping","transportSequence":1}`))
	context.Request.Header.Set("Content-Type", "application/json")
	app.writeHTTPStreamEvent(context)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected hidden 404 for missing upload token, got %d", recorder.Code)
	}
}

func TestHTTPStreamDeduplicatesControls(t *testing.T) {
	gin.SetMode(gin.TestMode)
	app := &App{httpStreams: make(map[uuid.UUID]*httpStreamConnection)}
	connection := newHTTPStreamConnection(uuid.Nil, uuid.Nil)
	app.registerHTTPStream(connection)
	defer app.unregisterHTTPStream(connection)
	post := func(sequence int) int {
		recorder := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(recorder)
		context.Params = gin.Params{{Key: "streamId", Value: connection.id.String()}}
		payload, _ := json.Marshal(map[string]any{"type": "ping", "transportSequence": sequence})
		context.Request = httptest.NewRequest(http.MethodPost, "/events", bytes.NewReader(payload))
		context.Request.Header.Set("Content-Type", "application/json")
		context.Request.Header.Set("X-Stream-Token", connection.uploadToken)
		app.writeHTTPStreamEvent(context)
		return recorder.Code
	}
	if status := post(1); status != http.StatusAccepted {
		t.Fatalf("expected first control accepted, got %d", status)
	}
	if status := post(1); status != http.StatusNoContent {
		t.Fatalf("expected duplicate control ignored, got %d", status)
	}
}

func TestHTTPStreamSSEHandshakeAndReplay(t *testing.T) {
	gin.SetMode(gin.TestMode)
	connection := newHTTPStreamConnection(uuid.Nil, uuid.Nil)
	defer connection.Close()
	if err := connection.WriteJSON(map[string]any{"type": "message.delta", "data": map[string]string{"delta": "hello"}}); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.GET("/stream", func(c *gin.Context) { serveSSE(c, connection) })
	server := httptest.NewServer(router)
	defer server.Close()
	response, err := http.Get(server.URL + "/stream?resume=" + connection.resumeToken + "&lastEventId=0")
	if err != nil {
		t.Fatalf("open SSE: %v", err)
	}
	defer response.Body.Close()
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("unexpected content type %q", contentType)
	}
	reader := bufio.NewReader(response.Body)
	ready := readSSEBlock(t, reader)
	if !strings.Contains(ready, `"type":"transport.resumed"`) || !strings.Contains(ready, connection.uploadToken) {
		t.Fatalf("unexpected ready event: %s", ready)
	}
	replayed := readSSEBlock(t, reader)
	if !strings.Contains(replayed, "id: 1") || !strings.Contains(replayed, "message.delta") {
		t.Fatalf("unexpected replay event: %s", replayed)
	}
}
