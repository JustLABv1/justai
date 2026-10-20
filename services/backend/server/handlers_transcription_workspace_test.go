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

	title := "89. Sitzung vom 09.07.2026. Regierungserkla\u0308rung zur aktuellen politischen Lage"
	pdf := buildTranscriptPDFLocalized(title, rows, &models.TranscriptionInsights{
		Language: "de", Status: "completed", Summary: "Die Regierung erklärt ihre Ziele.",
		Topics: []string{"Politische Lage"},
	}, "de")
	if !bytes.HasPrefix(pdf, []byte("%PDF-1.4")) {
		t.Fatalf("PDF does not start with a PDF header")
	}
	if !bytes.Contains(pdf, []byte("JustAI")) || bytes.Count(pdf, []byte("JustAI")) != 1 {
		t.Fatalf("PDF is missing JustAI branding: %s", pdf)
	}
	if bytes.Count(pdf, []byte("/Type /Page /Parent")) != 2 {
		t.Fatal("insights should start on a separate PDF page")
	}
	if !strings.Contains(pdfTextLiteral(title), "\xe4") || strings.Contains(pdfTextLiteral(title), "\xcc\x88") {
		t.Fatal("decomposed umlauts should be normalized before PDF encoding")
	}
	if !strings.Contains(transcriptionMarkdownLocalized(title, rows, &models.TranscriptionInsights{Language: "de", Status: "completed", Summary: "Zusammenfassung des Inhalts"}, "de"), "## KI-Erkenntnisse") {
		t.Fatal("German insights headings are missing")
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
		if !strings.Contains(buffer.String(), "JustAI") || !strings.Contains(buffer.String(), "w:color w:val=\"2161E3\"") {
			t.Fatalf("DOCX document is missing JustAI branding: %s", buffer.String())
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

func TestGermanInsightsOnlyExports(t *testing.T) {
	insights := &models.TranscriptionInsights{
		Language: "de", Status: "completed", Summary: "Die Sitzung behandelt Europa.",
		Topics: []string{"Europa"}, ActionItems: []string{"Bericht erstellen"},
	}
	markdown := transcriptionMarkdownLocalized("Sitzung", nil, insights, "de")
	for _, heading := range []string{"## KI-Erkenntnisse", "### Zusammenfassung", "### Themen", "### Aufgaben"} {
		if !strings.Contains(markdown, heading) {
			t.Fatalf("missing localized heading %q", heading)
		}
	}
	pdf := buildTranscriptPDFLocalized("Sitzung", nil, insights, "de")
	if bytes.Contains(pdf, []byte("No transcript text available")) || !bytes.Contains(pdf, []byte("Die Sitzung behandelt Europa")) {
		t.Fatal("insights-only PDF should contain the insights without a missing-transcript notice")
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

	pdf := buildTranscriptPDFLocalized("Sitzung 02", rows, &models.TranscriptionInsights{
		Language: "de", Status: "completed", Summary: "Zusammenfassung einer längeren Sitzung.",
	}, "de")
	pageCount := bytes.Count(pdf, []byte("/Type /Page /Parent"))
	if pageCount < 3 {
		t.Fatalf("expected a long transcript and a separate insights page, got %d page(s)", pageCount)
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
		input := buildTranscriptionInsightChunkInput("Long video", "de", chunk, index+1, len(chunks), 8*60*60*1000)
		if !strings.Contains(input, chunk.Rows[0].Text) || !strings.Contains(input, chunk.Rows[len(chunk.Rows)-1].Text) {
			t.Fatalf("chunk %d input dropped a boundary transcript row", index)
		}
		if !strings.Contains(input, "Video duration: 08:00:00") {
			t.Fatalf("chunk %d input does not include the video duration", index)
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

func TestSanitizeTranscriptionInsightChaptersKeepsChaptersWithinVideo(t *testing.T) {
	durationMs := int64(2*60*60*1000 + 9*60*1000 + 52*1000)
	chapters := sanitizeTranscriptionInsightChapters([]models.TranscriptionInsightChapter{
		{Title: "Opening", StartOffsetMs: 0},
		{Title: "Near the end", StartOffsetMs: durationMs},
		{Title: "Outside the video", StartOffsetMs: durationMs + 47*60*1000},
		{Title: "Negative", StartOffsetMs: -1},
		{Title: " ", StartOffsetMs: 1000},
	}, durationMs)

	if len(chapters) != 2 {
		t.Fatalf("expected invalid chapter timestamps to be removed, got %+v", chapters)
	}
	if chapters[0].Title != "Opening" || chapters[1].Title != "Near the end" {
		t.Fatalf("unexpected sanitized chapters: %+v", chapters)
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

func TestTranscriptionInsightSummaryStyleAcrossGenerationStages(t *testing.T) {
	for name, prompt := range map[string]string{
		"single":        transcriptionInsightSystemPrompt("de", "de"),
		"window":        transcriptionInsightChunkSystemPrompt("de", "de", 1, 3),
		"consolidation": transcriptionInsightReduceSystemPrompt("de", "de"),
	} {
		t.Run(name, func(t *testing.T) {
			for _, instruction := range []string{
				"one clearly separated prose paragraph per substantive speaker contribution",
				"Begin each paragraph with the available speaker name or label",
				`\n\n inside the JSON summary string`,
				"Do not include transcript timestamps, time ranges",
				"never infer a person's identity from their opinions",
				"Attribute opinions and disputed claims to the speaker",
			} {
				if !strings.Contains(prompt, instruction) {
					t.Errorf("missing summary instruction %q", instruction)
				}
			}
		})
	}
}

func TestTranscriptionInsightInputIncludesKnownSpeakerNames(t *testing.T) {
	speakerID := uuid.New()
	segments := []models.TranscriptionSegment{
		{ID: uuid.New(), SpeakerID: &speakerID, Text: "Wir brauchen Reformen.", StartOffsetMs: 1250, EndOffsetMs: 4000},
		{ID: uuid.New(), Text: "Eine nicht zugeordnete Aussage.", StartOffsetMs: 4000, EndOffsetMs: 6000},
	}
	speakers := []models.TranscriptionSpeaker{{ID: speakerID, Label: "SPEAKER_00", DisplayName: "Anna Müller"}}
	chunks := splitTranscriptionInsightRows(transcriptionExportRows(segments, speakers))
	input := buildTranscriptionInsightChunkInput("Debatte", "de", chunks[0], 1, 1, 6000)
	if !strings.Contains(input, "[00:00:01] Anna Müller: Wir brauchen Reformen.") {
		t.Fatalf("known speaker is missing from insight input: %s", input)
	}
	if !strings.Contains(input, "[00:00:04] Eine nicht zugeordnete Aussage.") {
		t.Fatalf("unassigned text was lost or given an invented speaker: %s", input)
	}
}

func TestFallbackTranscriptionInsightSummaryHasParagraphsWithoutTimePrefixes(t *testing.T) {
	analyses := []transcriptionInsightChunkAnalysis{
		{Chunk: transcriptionInsightChunk{StartOffsetMs: 0, EndOffsetMs: 900000}, Response: transcriptionInsightResponse{Summary: "Anna fordert Reformen.\n\nBen kritisiert den Vorschlag."}},
		{Chunk: transcriptionInsightChunk{StartOffsetMs: 900000, EndOffsetMs: 1800000}, Response: transcriptionInsightResponse{Summary: "Clara erklärt den nächsten Schritt."}},
		{Chunk: transcriptionInsightChunk{StartOffsetMs: 1800000, EndOffsetMs: 2700000}, Response: transcriptionInsightResponse{}},
	}
	want := "Anna fordert Reformen.\n\nBen kritisiert den Vorschlag.\n\nClara erklärt den nächsten Schritt."
	if got := fallbackTranscriptionInsightSummary(analyses); got != want {
		t.Fatalf("fallback should preserve separate contributions without time prefixes or placeholder prose: %q", got)
	}
}

func TestFallbackTranscriptionInsightSummaryUsesAvailableChapterText(t *testing.T) {
	got := fallbackTranscriptionInsightSummary([]transcriptionInsightChunkAnalysis{{Response: transcriptionInsightResponse{Chapters: []models.TranscriptionInsightChapter{
		{Title: "Debatte", Summary: "Anna erläutert den Vorschlag.", StartOffsetMs: 900000},
	}}}})
	if got != "Anna erläutert den Vorschlag." {
		t.Fatalf("fallback should use available source text without chapter timestamps: %q", got)
	}
}

func TestTranscriptionSummaryParagraphExports(t *testing.T) {
	first, second := "Anna fordert Reformen.", "Ben kritisiert den Vorschlag."
	insights := &models.TranscriptionInsights{Language: "de", Status: "completed", Summary: first + "\r\n \r\n" + second}
	paragraphs := transcriptionSummaryParagraphs(insights.Summary)
	if len(paragraphs) != 2 || paragraphs[0] != first || paragraphs[1] != second {
		t.Fatalf("summary paragraphs were not preserved: %#v", paragraphs)
	}

	pages := []transcriptPDFPage{{}}
	y := transcriptPDFBodyTopY
	appendTranscriptPDFInsightsLocalized(&pages, &y, insights, "de")
	var firstY, secondY float64
	for _, page := range pages {
		for _, line := range page.Lines {
			if line.Text == first {
				firstY = line.Y
			}
			if line.Text == second {
				secondY = line.Y
			}
		}
	}
	if firstY == 0 || secondY == 0 || firstY-secondY <= transcriptPDFBodyLineHeight {
		t.Fatalf("PDF summary paragraphs need visible spacing: first=%v second=%v", firstY, secondY)
	}

	docx := buildTranscriptDOCXLocalized("Debatte", nil, insights, "de")
	archive, err := zip.NewReader(bytes.NewReader(docx), int64(len(docx)))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		if file.Name != "word/document.xml" {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		var content bytes.Buffer
		_, err = content.ReadFrom(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, text := range []string{first, second} {
			if !strings.Contains(content.String(), `<w:spacing w:after="160"/></w:pPr><w:r><w:t xml:space="preserve">`+text+`</w:t></w:r></w:p>`) {
				t.Fatalf("DOCX summary contribution lacks a separate spaced paragraph: %s", text)
			}
		}
		return
	}
	t.Fatal("DOCX document.xml missing")
}

func TestDecodeTranscriptionInsightOutputPreservesSummaryParagraphs(t *testing.T) {
	decoded, err := decodeTranscriptionInsightOutput(`{"summary":"Anna fordert Reformen.\n\nBen kritisiert den Vorschlag.","chapters":[],"topics":[],"actionItems":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Summary != "Anna fordert Reformen.\n\nBen kritisiert den Vorschlag." {
		t.Fatalf("JSON summary paragraph breaks were lost: %q", decoded.Summary)
	}
}

func TestTranscriptPDFCompactInsightsHeader(t *testing.T) {
	for _, title := range []string{
		"Video transcript",
		"89. Sitzung vom 09.07.2026. Regierungserklärung zur aktuellen politischen Lage und zur europäischen Zusammenarbeit",
	} {
		t.Run(title, func(t *testing.T) {
			bodyTop := transcriptPDFFirstPageBodyTopY(title, true)
			lastTitleY := transcriptPDFTitleTopY - float64(len(transcriptPDFTitleLines(title))-1)*transcriptPDFTitleLineHeight
			if gap := lastTitleY - bodyTop; gap < 24 || gap > 36 {
				t.Fatalf("insight header should closely follow the last title line without overlap, got gap %.1f", gap)
			}
			pages := []transcriptPDFPage{{}}
			y := bodyTop
			appendTranscriptPDFInsightsLocalized(&pages, &y, &models.TranscriptionInsights{
				Language: "de", Status: "completed", Summary: "Anna erläutert den Reformvorschlag.",
			}, "de")
			if len(pages) != 1 {
				t.Fatalf("short summary should fit on its first page, got %d pages", len(pages))
			}
			var heading, language, content transcriptPDFTextLine
			for _, line := range pages[0].Lines {
				switch line.Text {
				case "KI-Erkenntnisse":
					heading = line
				case "Sprache: Deutsch":
					language = line
				case "Anna erläutert den Reformvorschlag.":
					content = line
				}
			}
			if heading.Size == 0 || heading.Size > 12 || language.Y < heading.Y-2 || language.Y > heading.Y+2 || language.X <= heading.X+200 {
				t.Fatalf("section and language should share a compact row: heading=%+v language=%+v", heading, language)
			}
			if content.Y == 0 || heading.Y-content.Y > 44 || content.Y >= pages[0].SectionRuleY {
				t.Fatalf("summary should start just below the compact section header: heading=%+v content=%+v", heading, content)
			}
		})
	}
	insights := &models.TranscriptionInsights{
		Language: "de", Status: "completed",
		Summary: "Anna Müller erläutert die Reformvorschläge und spricht sich für eine schrittweise Umsetzung aus. Sie betont, dass die Maßnahmen verständlich erklärt werden müssten.\n\nBen Schneider kritisiert den vorgesehenen Zeitplan. Er fordert, die Auswirkungen auf die betroffenen Menschen vor einer Entscheidung genauer zu prüfen.\n\nClara Weber unterstreicht die Bedeutung einer verlässlichen Finanzierung. Aus ihrer Sicht müssten die verfügbaren Mittel gezielt eingesetzt und die Ergebnisse regelmäßig überprüft werden.",
	}
	if path := os.Getenv("JUSTAI_TRANSCRIPT_PDF_COMPACT_VERIFY_PATH"); path != "" {
		if err := os.WriteFile(path, buildTranscriptPDFLocalized("Video transcript", nil, insights, "de"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
