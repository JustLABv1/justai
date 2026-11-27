package server

import (
	"bytes"
	"errors"
	"testing"
)

func TestPCMRangeWriterCutsAcrossWrites(t *testing.T) {
	var out bytes.Buffer
	w := &pcmRangeWriter{writer: &out, skip: 3, remaining: 4}
	if n, err := w.Write([]byte{0, 1}); n != 2 || err != nil {
		t.Fatalf("first write = %d, %v", n, err)
	}
	if n, err := w.Write([]byte{2, 3, 4}); n != 3 || err != nil {
		t.Fatalf("second write = %d, %v", n, err)
	}
	n, err := w.Write([]byte{5, 6, 7, 8})
	if n != 4 || !errors.Is(err, errPCMRangeComplete) {
		t.Fatalf("third write = %d, %v", n, err)
	}
	if got := out.Bytes(); !bytes.Equal(got, []byte{3, 4, 5, 6}) {
		t.Fatalf("kept %v", got)
	}
}
