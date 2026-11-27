package server

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
)

type failingReader struct{ err error }

func (r failingReader) Read([]byte) (int, error) { return 0, r.err }

func TestDecodePCMStreamNamesMissingAudio(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ctx := context.Background()

	if _, err := decodePCMStream(ctx, bytes.NewReader(nil), &bytes.Buffer{}); !errors.Is(err, errRecordingWithoutData) {
		t.Fatalf("empty recording: got %v", err)
	}

	storageErr := errors.New("storage unavailable")
	if _, err := decodePCMStream(ctx, failingReader{err: storageErr}, &bytes.Buffer{}); !errors.Is(err, storageErr) {
		t.Fatalf("unreadable recording: got %v", err)
	}

	_, err := decodePCMStream(ctx, strings.NewReader(strings.Repeat("not audio ", 3000)), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "could not be decoded: ") || !strings.Contains(err.Error(), "Invalid data") {
		t.Fatalf("invalid recording should include ffmpeg's reason: got %v", err)
	}

	wav := append(liveStreamWAVHeader(), make([]byte, 32000)...)
	var output bytes.Buffer
	written, err := decodePCMStream(ctx, bytes.NewReader(wav), &output)
	if err != nil || written != 32000 || output.Len() != 32000 {
		t.Fatalf("valid recording: written=%d len=%d err=%v", written, output.Len(), err)
	}
}
