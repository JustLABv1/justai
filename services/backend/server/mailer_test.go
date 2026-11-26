package server

import (
	"strings"
	"testing"
	"time"
)

func TestBuildMailIsSafeMultipartUTF8(t *testing.T) {
	raw, err := buildMail("JustAI <justai@example.org>", mailMessage{
		To:        "reader@example.org",
		Subject:   "„Landwirtschaft“ ist fertig\r\nBcc: evil@example.org",
		Text:      "Transkript <b>bereit</b>",
		LinkLabel: "Thema öffnen",
		Link:      "https://justai.example.org/live-transcription/1",
	}, time.Date(2026, 11, 26, 18, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	message := string(raw)
	head, _, _ := strings.Cut(message, "\r\n\r\n")
	if strings.Contains(head, "\r\nBcc:") {
		t.Fatal("a line break in the subject injected a header")
	}
	for _, want := range []string{"Subject: =?utf-8?q?", "multipart/alternative", "text/plain; charset=utf-8", "text/html; charset=utf-8", "&lt;b&gt;bereit&lt;/b&gt;", "Auto-Submitted: auto-generated"} {
		if !strings.Contains(message, want) {
			t.Errorf("message lacks %q:\n%s", want, message)
		}
	}
	if _, err := buildMail("JustAI <justai@example.org>", mailMessage{To: "not an address"}, time.Now()); err == nil {
		t.Fatal("an invalid recipient was accepted")
	}
}
