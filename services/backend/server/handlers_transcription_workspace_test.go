package server

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/models"
)

func TestTranscriptWorkspaceExportArtifacts(t *testing.T) {
	rows := []transcriptionExportRow{{
		SegmentID:     uuid.New(),
		Speaker:       "Anna Müller",
		Text:          "Eine überprüfte Zeile mit Zeitstempel.",
		StartOffsetMs: 1250,
		EndOffsetMs:   4250,
	}}

	pdf := buildTranscriptPDF("Sitzung 03", rows, nil)
	if !bytes.HasPrefix(pdf, []byte("%PDF-1.4")) {
		t.Fatalf("PDF does not start with a PDF header")
	}
	if path := os.Getenv("JUSTAI_TRANSCRIPT_PDF_VERIFY_PATH"); path != "" {
		if err := os.WriteFile(path, pdf, 0o600); err != nil {
			t.Fatalf("write PDF verification artifact: %v", err)
		}
	}

	docx := buildTranscriptDOCX("Sitzung 03", rows, nil)
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

	pdf := buildTranscriptPDF("Sitzung 02", rows, nil)
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

func TestTranscriptionInsightLanguagePrompt(t *testing.T) {
	if normalized, ok := normalizeTranscriptionInsightLanguage("de-DE"); !ok || normalized != "de" {
		t.Fatalf("expected de-DE to normalize to de, got %q (valid=%v)", normalized, ok)
	}
	prompt := transcriptionInsightSystemPrompt("de", "en")
	if !strings.Contains(prompt, "German") || !strings.Contains(prompt, "Do not write the insights in another language") {
		t.Fatalf("language instruction is missing from prompt: %s", prompt)
	}
	autoPrompt := transcriptionInsightSystemPrompt("auto", "de")
	if !strings.Contains(autoPrompt, "German") {
		t.Fatalf("auto language prompt did not follow the transcript language: %s", autoPrompt)
	}
	if !strings.Contains(prompt, "absolute offsets") {
		t.Fatalf("insight prompt does not require absolute timestamps: %s", prompt)
	}
}

func TestTranscriptionInsightChunkingPreservesFullTranscript(t *testing.T) {
	rows := make([]transcriptionExportRow, 0, 400)
	for index := 0; index < 400; index++ {
		rows = append(rows, transcriptionExportRow{
			SegmentID:     uuid.New(),
			Text:          fmt.Sprintf("utterance-%03d %s", index, strings.Repeat("text ", 40)),
			StartOffsetMs: int64(index * 20000),
			EndOffsetMs:   int64(index*20000 + 15000),
		})
	}

	chunks := splitTranscriptionInsightRows(rows)
	if len(chunks) < 2 {
		t.Fatalf("expected the transcript to be split into multiple windows, got %d", len(chunks))
	}
	seen := make([]transcriptionExportRow, 0, len(rows))
	for index, chunk := range chunks {
		if len(chunk.Rows) == 0 {
			t.Fatalf("chunk %d is empty", index)
		}
		seen = append(seen, chunk.Rows...)
		input := buildTranscriptionInsightChunkInput("Long video", "de", chunk, index+1, len(chunks))
		if !strings.Contains(input, chunk.Rows[0].Text) || !strings.Contains(input, chunk.Rows[len(chunk.Rows)-1].Text) {
			t.Fatalf("chunk %d input dropped a boundary transcript row", index)
		}
	}
	if len(seen) != len(rows) {
		t.Fatalf("chunking changed the number of transcript rows: got %d, want %d", len(seen), len(rows))
	}
	for index := range rows {
		if seen[index].SegmentID != rows[index].SegmentID || seen[index].Text != rows[index].Text {
			t.Fatalf("chunking changed transcript row %d", index)
		}
	}
}

func TestTranscriptionInsightChapterMergeKeepsTimeline(t *testing.T) {
	analyses := []transcriptionInsightChunkAnalysis{
		{
			Response: transcriptionInsightResponse{Chapters: []models.TranscriptionInsightChapter{
				{Title: "Opening", Summary: "Start", StartOffsetMs: 0},
				{Title: "Budget", Summary: "Numbers", StartOffsetMs: 900000},
			}},
		},
		{
			Response: transcriptionInsightResponse{Chapters: []models.TranscriptionInsightChapter{
				{Title: "Budget", Summary: "Duplicate boundary", StartOffsetMs: 905000},
				{Title: "Closing", Summary: "End", StartOffsetMs: 7200000},
			}},
		},
	}

	chapters := mergeTranscriptionInsightChapters(analyses)
	if len(chapters) != 3 {
		t.Fatalf("expected duplicate boundary chapters to merge, got %d: %+v", len(chapters), chapters)
	}
	if chapters[0].StartOffsetMs != 0 || chapters[1].StartOffsetMs != 900000 || chapters[2].StartOffsetMs != 7200000 {
		t.Fatalf("chapters are not ordered by absolute timestamp: %+v", chapters)
	}
}

func TestTranscriptInsightExportFormatting(t *testing.T) {
	insights := &models.TranscriptionInsights{
		Status:   "completed",
		Language: "de",
		Summary:  "Eine kurze Zusammenfassung.",
		Chapters: []models.TranscriptionInsightChapter{{Title: "Einleitung", Summary: "Der Anfang", StartOffsetMs: 0}},
		Topics:   []string{"Haushalt"},
		ActionItems: []string{
			"Zahlen prüfen",
		},
	}
	rows := []transcriptionExportRow{{Text: "Der Transkripttext.", StartOffsetMs: 0, EndOffsetMs: 2000}}

	plainText := transcriptionPlainText(rows, insights)
	if !strings.Contains(plainText, "AI INSIGHTS") || !strings.Contains(plainText, "Eine kurze Zusammenfassung.") {
		t.Fatalf("plain text export does not contain insights: %s", plainText)
	}
	markdown := transcriptionMarkdown("Sitzung 02", rows, insights)
	if !strings.Contains(markdown, "## AI insights") || !strings.Contains(markdown, "Zahlen prüfen") {
		t.Fatalf("markdown export does not contain insights: %s", markdown)
	}
	pdf := buildTranscriptPDF("Sitzung 02", rows, insights)
	if !bytes.Contains(pdf, []byte("AI insights")) {
		t.Fatal("PDF export does not contain the insights section")
	}
	if path := os.Getenv("JUSTAI_TRANSCRIPT_PDF_INSIGHTS_VERIFY_PATH"); path != "" {
		if err := os.WriteFile(path, pdf, 0o600); err != nil {
			t.Fatalf("write PDF insights artifact: %v", err)
		}
	}
	docx := buildTranscriptDOCX("Sitzung 02", rows, insights)
	archive, err := zip.NewReader(bytes.NewReader(docx), int64(len(docx)))
	if err != nil {
		t.Fatalf("DOCX with insights is not a ZIP package: %v", err)
	}
	var document bytes.Buffer
	for _, file := range archive.File {
		if file.Name != "word/document.xml" {
			continue
		}
		reader, openErr := file.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		_, _ = document.ReadFrom(reader)
		_ = reader.Close()
	}
	if !strings.Contains(document.String(), "AI insights") || !strings.Contains(document.String(), "Eine kurze Zusammenfassung.") {
		t.Fatalf("DOCX export does not contain insights: %s", document.String())
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
