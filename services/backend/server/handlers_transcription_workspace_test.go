package server

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"justai-backend/config"
)

func TestTranscriptWorkspaceExportArtifacts(t *testing.T) {
	rows := []transcriptionExportRow{{
		SegmentID:     uuid.New(),
		Speaker:       "Anna Müller",
		Text:          "Eine überprüfte Zeile mit Zeitstempel.",
		StartOffsetMs: 1250,
		EndOffsetMs:   4250,
	}}

	pdf := buildTranscriptPDF("Sitzung 03", rows)
	if !bytes.HasPrefix(pdf, []byte("%PDF-1.4")) {
		t.Fatalf("PDF does not start with a PDF header")
	}
	if path := os.Getenv("JUSTAI_TRANSCRIPT_PDF_VERIFY_PATH"); path != "" {
		if err := os.WriteFile(path, pdf, 0o600); err != nil {
			t.Fatalf("write PDF verification artifact: %v", err)
		}
	}

	docx := buildTranscriptDOCX("Sitzung 03", rows)
	archive, err := zip.NewReader(bytes.NewReader(docx), int64(len(docx)))
	if err != nil {
		t.Fatalf("DOCX is not a ZIP package: %v", err)
	}
	seenDocument := false
	for _, file := range archive.File {
		if file.Name != "word/document.xml" {
			continue
		}
		seenDocument = true
		reader, readErr := file.Open()
		if readErr != nil {
			t.Fatal(readErr)
		}
		buffer := new(bytes.Buffer)
		_, _ = buffer.ReadFrom(reader)
		_ = reader.Close()
		if !strings.Contains(buffer.String(), "Anna Müller") {
			t.Fatalf("DOCX document does not contain the transcript speaker")
		}
	}
	if !seenDocument {
		t.Fatal("DOCX package is missing word/document.xml")
	}
}

func TestTranscriptPDFGroupsAdjacentSegments(t *testing.T) {
	speaker := "Anna Müller"
	rows := []transcriptionExportRow{
		{Speaker: speaker, Text: "Das ist der erste Satz.", StartOffsetMs: 0, EndOffsetMs: 1800},
		{Speaker: speaker, Text: "Das ist der zweite Satz.", StartOffsetMs: 2000, EndOffsetMs: 3800},
		{Speaker: "Ben", Text: "Jetzt spricht eine andere Person.", StartOffsetMs: 4000, EndOffsetMs: 5600},
	}

	blocks := transcriptionPDFBlocks(rows)
	if len(blocks) != 2 {
		t.Fatalf("expected two readable paragraph blocks, got %d: %+v", len(blocks), blocks)
	}
	if !strings.Contains(blocks[0].Text, "Das ist der erste Satz. Das ist der zweite Satz.") {
		t.Fatalf("adjacent segments were not combined: %q", blocks[0].Text)
	}
	if blocks[1].Speaker != "Ben" {
		t.Fatalf("speaker change should start a new block: %+v", blocks[1])
	}
}

func TestTranscriptPDFPagination(t *testing.T) {
	rows := make([]transcriptionExportRow, 0, 120)
	for index := 0; index < 120; index++ {
		rows = append(rows, transcriptionExportRow{
			Text:          "Dies ist ein längerer Beispielsatz, der mehrere kurze Transkriptionssegmente zu einem lesbaren Absatz zusammenführt.",
			StartOffsetMs: int64(index * 2000),
			EndOffsetMs:   int64(index*2000 + 1800),
		})
	}

	pdf := buildTranscriptPDF("Sitzung 02", rows)
	pageCount := bytes.Count(pdf, []byte("/Type /Page /Parent"))
	if pageCount < 2 {
		t.Fatalf("expected a long transcript to paginate, got %d page(s)", pageCount)
	}
	if path := os.Getenv("JUSTAI_TRANSCRIPT_PDF_PAGINATION_VERIFY_PATH"); path != "" {
		if err := os.WriteFile(path, pdf, 0o600); err != nil {
			t.Fatalf("write PDF pagination artifact: %v", err)
		}
	}
}

func TestDecodeTranscriptionInsightOutput(t *testing.T) {
	decoded, err := decodeTranscriptionInsightOutput(`Here is the result: {"summary":"A concise summary.","chapters":[{"title":"Opening","summary":"Intro","startOffsetMs":0}],"topics":["Budget"],"actionItems":["Review figures"]}`)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Summary != "A concise summary." || len(decoded.Chapters) != 1 || decoded.Chapters[0].StartOffsetMs != 0 {
		t.Fatalf("unexpected decoded insights: %+v", decoded)
	}
}

func TestRouterRegistersTranscriptionWorkspaceRoutes(t *testing.T) {
	app := New(config.Config{}, nil)
	if app.Router() == nil {
		t.Fatal("expected a router")
	}
}
