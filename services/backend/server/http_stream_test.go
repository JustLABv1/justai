package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func TestHTTPStreamConnectionCarriesJSONOutput(t *testing.T) {
	connection := newHTTPStreamConnection(uuid.New(), uuid.New())
	defer connection.Close()
	value := map[string]any{"type": "session.ready", "sequence": float64(1)}
	if err := connection.WriteJSON(value); err != nil {
		t.Fatalf("write JSON: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(<-connection.out, &decoded); err != nil {
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
