package server

import (
	"bytes"
	"fmt"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/signintech/gopdf"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/goregular"
)

const (
	generatedPDFMimeType = "application/pdf"

	// Keep model-generated documents useful for reports while bounding both the
	// renderer's work and the size of a single row in generated_pdfs.
	maxGeneratedPDFContentBytes  = 512 * 1024
	maxGeneratedPDFBytes         = 10 * 1024 * 1024
	maxGeneratedPDFTitleRunes    = 160
	maxGeneratedPDFFilenameBytes = 120

	// JSON escapes can roughly double a content string in the fallback action
	// protocol. Leave room for the action envelope while keeping a hard cap.
	maxGeneratedPDFFallbackActionBytes = maxGeneratedPDFContentBytes*2 + 64*1024
)

const (
	generatedPDFRegularFont = "JustAI-Go-Regular"
	generatedPDFBoldFont    = "JustAI-Go-Bold"
	generatedPDFMonoFont    = "JustAI-Go-Mono"
	generatedPDFPageWidth   = 595.0
	generatedPDFPageHeight  = 842.0
	generatedPDFMarginLeft  = 56.0
	generatedPDFMarginRight = 56.0
	generatedPDFPageTop     = 96.0
	generatedPDFPageBottom  = 786.0
)

type generatedPDFBlock struct {
	kind   string
	level  int
	text   string
	marker string
	rows   [][]string
}

func renderGeneratedPDF(title, content string) ([]byte, error) {
	content = strings.ToValidUTF8(content, "\uFFFD")

	pdf := &gopdf.GoPdf{}
	pdf.Start(gopdf.Config{Unit: gopdf.UnitPT, PageSize: *gopdf.PageSizeA4})
	fontOption := gopdf.TtfOption{
		OnGlyphNotFoundSubstitute: func(r rune) rune { return '?' },
	}
	if err := pdf.AddTTFFontDataWithOption(generatedPDFRegularFont, goregular.TTF, fontOption); err != nil {
		return nil, fmt.Errorf("load PDF regular font: %w", err)
	}
	if err := pdf.AddTTFFontDataWithOption(generatedPDFBoldFont, gobold.TTF, fontOption); err != nil {
		return nil, fmt.Errorf("load PDF bold font: %w", err)
	}
	if err := pdf.AddTTFFontDataWithOption(generatedPDFMonoFont, gomono.TTF, fontOption); err != nil {
		return nil, fmt.Errorf("load PDF mono font: %w", err)
	}
	if err := pdf.SetFont(generatedPDFRegularFont, "", 11); err != nil {
		return nil, fmt.Errorf("set PDF body font: %w", err)
	}

	blocks := parseGeneratedPDFBlocks(content)
	pageNumber := 0
	currentY := 0.0
	startPage := func() error {
		if pageNumber > 0 {
			drawGeneratedPDFFooter(pdf, pageNumber)
		}
		pdf.AddPage()
		pageNumber++
		var err error
		currentY, err = drawGeneratedPDFHeader(pdf, title, pageNumber)
		return err
	}
	if err := startPage(); err != nil {
		return nil, err
	}

	setStyle := func(font string, size float64, r, g, b uint8) error {
		if err := pdf.SetFont(font, "", size); err != nil {
			return err
		}
		pdf.SetTextColor(r, g, b)
		return nil
	}

	writeWrapped := func(text string, x, width, lineHeight, spaceAfter float64, font string, size float64, r, g, b uint8) error {
		if err := setStyle(font, size, r, g, b); err != nil {
			return err
		}
		text, err := generatedPDFText(pdf, text)
		if err != nil {
			return err
		}
		lines, err := pdf.SplitTextWithWordWrap(text, width)
		if err != nil {
			return err
		}
		if len(lines) == 0 {
			return nil
		}
		for _, line := range lines {
			if currentY+lineHeight > generatedPDFPageBottom {
				if err := startPage(); err != nil {
					return err
				}
				if err := setStyle(font, size, r, g, b); err != nil {
					return err
				}
			}
			pdf.SetXY(x, currentY)
			if err := pdf.Cell(&gopdf.Rect{W: width, H: lineHeight}, line); err != nil {
				return err
			}
			currentY += lineHeight
		}
		currentY += spaceAfter
		return nil
	}

	writeListItem := func(block generatedPDFBlock) error {
		if err := setStyle(generatedPDFRegularFont, 11, 45, 55, 72); err != nil {
			return err
		}
		text, err := generatedPDFText(pdf, generatedPDFPlainText(block.text))
		if err != nil {
			return err
		}
		lines, err := pdf.SplitTextWithWordWrap(text, generatedPDFPageWidth-generatedPDFMarginLeft-generatedPDFMarginRight-24)
		if err != nil {
			return err
		}
		if len(lines) == 0 {
			return nil
		}
		const lineHeight = 16.5
		const markerWidth = 22.0
		for index, line := range lines {
			if currentY+lineHeight > generatedPDFPageBottom {
				if err := startPage(); err != nil {
					return err
				}
				if err := setStyle(generatedPDFRegularFont, 11, 45, 55, 72); err != nil {
					return err
				}
			}
			if index == 0 {
				pdf.SetXY(generatedPDFMarginLeft, currentY)
				if err := pdf.Cell(&gopdf.Rect{W: markerWidth, H: lineHeight}, block.marker); err != nil {
					return err
				}
			}
			pdf.SetXY(generatedPDFMarginLeft+markerWidth, currentY)
			if err := pdf.Cell(&gopdf.Rect{W: generatedPDFPageWidth - generatedPDFMarginLeft - generatedPDFMarginRight - markerWidth, H: lineHeight}, line); err != nil {
				return err
			}
			currentY += lineHeight
		}
		currentY += 3
		return nil
	}

	writeRule := func() error {
		if currentY+12 > generatedPDFPageBottom {
			return startPage()
		}
		currentY += 5
		pdf.SetStrokeColor(203, 213, 225)
		pdf.SetLineWidth(0.7)
		pdf.Line(generatedPDFMarginLeft, currentY, generatedPDFPageWidth-generatedPDFMarginRight, currentY)
		currentY += 7
		return nil
	}

	writeTable := func(rows [][]string) error {
		if len(rows) == 0 || len(rows[0]) == 0 {
			return nil
		}
		columnCount := len(rows[0])
		if columnCount > 5 {
			return writeWrapped(strings.Join(rows[0], " | "), generatedPDFMarginLeft, generatedPDFPageWidth-generatedPDFMarginLeft-generatedPDFMarginRight, 16.5, 5, generatedPDFRegularFont, 11, 45, 55, 72)
		}
		width := generatedPDFPageWidth - generatedPDFMarginLeft - generatedPDFMarginRight
		columnWidth := width / float64(columnCount)
		const cellPadding = 5.0
		const lineHeight = 13.5

		for rowIndex, row := range rows {
			for len(row) < columnCount {
				row = append(row, "")
			}
			font := generatedPDFRegularFont
			if rowIndex == 0 {
				font = generatedPDFBoldFont
			}
			if err := setStyle(font, 9.5, 45, 55, 72); err != nil {
				return err
			}
			cellLines := make([][]string, columnCount)
			rowHeight := 22.0
			for columnIndex := 0; columnIndex < columnCount; columnIndex++ {
				text, err := generatedPDFText(pdf, generatedPDFPlainText(row[columnIndex]))
				if err != nil {
					return err
				}
				lines, err := pdf.SplitTextWithWordWrap(text, columnWidth-cellPadding*2)
				if err != nil {
					return err
				}
				if len(lines) == 0 {
					lines = []string{""}
				}
				cellLines[columnIndex] = lines
				height := float64(len(lines))*lineHeight + cellPadding*2
				if height > rowHeight {
					rowHeight = height
				}
			}
			if currentY+rowHeight > generatedPDFPageBottom {
				if err := startPage(); err != nil {
					return err
				}
			}
			if rowIndex == 0 {
				pdf.SetFillColor(241, 245, 249)
				pdf.RectFromUpperLeftWithStyle(generatedPDFMarginLeft, currentY, width, rowHeight, "F")
			}
			pdf.SetStrokeColor(203, 213, 225)
			pdf.SetLineWidth(0.45)
			pdf.RectFromUpperLeftWithStyle(generatedPDFMarginLeft, currentY, width, rowHeight, "D")
			for columnIndex := 1; columnIndex < columnCount; columnIndex++ {
				x := generatedPDFMarginLeft + float64(columnIndex)*columnWidth
				pdf.Line(x, currentY, x, currentY+rowHeight)
			}
			if err := setStyle(font, 9.5, 45, 55, 72); err != nil {
				return err
			}
			for columnIndex, lines := range cellLines {
				x := generatedPDFMarginLeft + float64(columnIndex)*columnWidth + cellPadding
				for lineIndex, line := range lines {
					pdf.SetXY(x, currentY+cellPadding+float64(lineIndex)*lineHeight)
					if err := pdf.Cell(&gopdf.Rect{W: columnWidth - cellPadding*2, H: lineHeight}, line); err != nil {
						return err
					}
				}
			}
			currentY += rowHeight
		}
		currentY += 8
		return nil
	}

	for _, block := range blocks {
		switch block.kind {
		case "spacer":
			if currentY+10 > generatedPDFPageBottom {
				if err := startPage(); err != nil {
					return nil, err
				}
			} else {
				currentY += 10
			}
		case "heading":
			size := 14.0
			lineHeight := 20.0
			before := 13.0
			if block.level == 1 {
				size = 20
				lineHeight = 27
				before = 8
			} else if block.level == 2 {
				size = 16
				lineHeight = 22
			}
			currentY += before
			if err := writeWrapped(generatedPDFPlainText(block.text), generatedPDFMarginLeft, generatedPDFPageWidth-generatedPDFMarginLeft-generatedPDFMarginRight, lineHeight, 7, generatedPDFBoldFont, size, 31, 41, 55); err != nil {
				return nil, err
			}
		case "unordered", "ordered":
			if err := writeListItem(block); err != nil {
				return nil, err
			}
		case "rule":
			if err := writeRule(); err != nil {
				return nil, err
			}
		case "table":
			if err := writeTable(block.rows); err != nil {
				return nil, err
			}
		case "code":
			currentY += 3
			if err := writeWrapped(block.text, generatedPDFMarginLeft+10, generatedPDFPageWidth-generatedPDFMarginLeft-generatedPDFMarginRight-20, 14.5, 7, generatedPDFMonoFont, 9.5, 45, 55, 72); err != nil {
				return nil, err
			}
		default:
			currentY += 5
			if err := writeWrapped(generatedPDFPlainText(block.text), generatedPDFMarginLeft, generatedPDFPageWidth-generatedPDFMarginLeft-generatedPDFMarginRight, 16.5, 5, generatedPDFRegularFont, 11, 45, 55, 72); err != nil {
				return nil, err
			}
		}
	}

	drawGeneratedPDFFooter(pdf, pageNumber)
	var output bytes.Buffer
	if _, err := pdf.WriteTo(&output); err != nil {
		return nil, fmt.Errorf("write PDF: %w", err)
	}
	return output.Bytes(), nil
}

func drawGeneratedPDFHeader(pdf *gopdf.GoPdf, title string, pageNumber int) (float64, error) {
	headerWidth := generatedPDFPageWidth - generatedPDFMarginLeft - generatedPDFMarginRight
	if pageNumber == 1 {
		if err := pdf.SetFont(generatedPDFBoldFont, "", 20); err != nil {
			return 0, err
		}
		pdf.SetTextColor(31, 41, 55)
		safeTitle, err := generatedPDFText(pdf, generatedPDFPlainText(title))
		if err != nil {
			return 0, err
		}
		titleLines, err := pdf.SplitTextWithWordWrap(safeTitle, headerWidth)
		if err != nil {
			return 0, err
		}
		if len(titleLines) == 0 {
			titleLines = []string{"Generated document"}
		}
		for index, line := range titleLines {
			pdf.SetXY(generatedPDFMarginLeft, 44+float64(index)*25)
			if err := pdf.Cell(&gopdf.Rect{W: headerWidth, H: 27}, line); err != nil {
				return 0, err
			}
		}
		dividerY := 79 + float64(len(titleLines)-1)*25
		pdf.SetStrokeColor(203, 213, 225)
		pdf.SetLineWidth(0.8)
		pdf.Line(generatedPDFMarginLeft, dividerY, generatedPDFPageWidth-generatedPDFMarginRight, dividerY)
		return dividerY + 17, nil
	}

	if err := pdf.SetFont(generatedPDFRegularFont, "", 9); err != nil {
		return 0, err
	}
	pdf.SetTextColor(100, 116, 139)
	safeTitle, err := generatedPDFText(pdf, generatedPDFPlainText(title))
	if err != nil {
		return 0, err
	}
	titleLines, err := pdf.SplitTextWithWordWrap(safeTitle, headerWidth)
	if err != nil {
		return 0, err
	}
	if len(titleLines) > 0 {
		safeTitle = titleLines[0]
	}
	pdf.SetXY(generatedPDFMarginLeft, 38)
	if err := pdf.Cell(&gopdf.Rect{W: headerWidth, H: 14}, safeTitle); err != nil {
		return 0, err
	}
	pdf.SetStrokeColor(226, 232, 240)
	pdf.SetLineWidth(0.6)
	pdf.Line(generatedPDFMarginLeft, 60, generatedPDFPageWidth-generatedPDFMarginRight, 60)
	return 76, nil
}

func drawGeneratedPDFFooter(pdf *gopdf.GoPdf, pageNumber int) {
	if err := pdf.SetFont(generatedPDFRegularFont, "", 9); err != nil {
		return
	}
	pdf.SetTextColor(100, 116, 139)
	pdf.SetStrokeColor(226, 232, 240)
	pdf.SetLineWidth(0.6)
	pdf.Line(generatedPDFMarginLeft, generatedPDFPageHeight-52, generatedPDFPageWidth-generatedPDFMarginRight, generatedPDFPageHeight-52)
	pdf.SetXY(generatedPDFMarginLeft, generatedPDFPageHeight-42)
	_ = pdf.Cell(&gopdf.Rect{W: generatedPDFPageWidth - generatedPDFMarginLeft - generatedPDFMarginRight, H: 14}, fmt.Sprintf("Page %d", pageNumber))
}

func generatedPDFText(pdf *gopdf.GoPdf, raw string) (string, error) {
	raw = strings.ToValidUTF8(raw, "\uFFFD")
	var builder strings.Builder
	for _, r := range raw {
		switch r {
		case '\u00a0', '\t':
			r = ' '
		case '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212':
			r = '-'
		case '\u2018', '\u2019', '\u201a', '\uff07':
			r = '\''
		case '\u201c', '\u201d', '\u201e', '\uff02':
			r = '"'
		case '\u2026':
			builder.WriteString("...")
			continue
		default:
			if unicode.IsSpace(r) && r != ' ' {
				r = ' '
			}
			if unicode.IsControl(r) {
				r = ' '
			}
		}
		hasGlyph, err := pdf.IsCurrFontContainGlyph(r)
		if err != nil {
			return "", err
		}
		if !hasGlyph {
			// The bundled report fonts deliberately do not ship emoji glyphs. Drop
			// pictographs rather than showing noisy question marks in headings.
			if unicode.Is(unicode.So, r) || unicode.Is(unicode.Sk, r) || r == '\ufe0f' {
				continue
			}
			r = '?'
		}
		builder.WriteRune(r)
	}
	return builder.String(), nil
}

func parseGeneratedPDFBlocks(content string) []generatedPDFBlock {
	content = strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(content, "\n")
	blocks := make([]generatedPDFBlock, 0, len(lines))
	paragraph := make([]string, 0, 4)
	flushParagraph := func() {
		if len(paragraph) == 0 {
			return
		}
		blocks = append(blocks, generatedPDFBlock{kind: "paragraph", text: strings.Join(paragraph, " ")})
		paragraph = paragraph[:0]
	}
	appendSpacer := func() {
		if len(blocks) == 0 || blocks[len(blocks)-1].kind == "spacer" {
			return
		}
		blocks = append(blocks, generatedPDFBlock{kind: "spacer"})
	}

	for index := 0; index < len(lines); index++ {
		rawLine := lines[index]
		line := strings.TrimSpace(rawLine)
		if line == "" {
			flushParagraph()
			appendSpacer()
			continue
		}
		if strings.HasPrefix(line, "```") {
			flushParagraph()
			codeLines := make([]string, 0, 4)
			for index++; index < len(lines); index++ {
				if strings.HasPrefix(strings.TrimSpace(lines[index]), "```") {
					break
				}
				codeLines = append(codeLines, strings.TrimRight(lines[index], " \t"))
			}
			if len(codeLines) > 0 {
				blocks = append(blocks, generatedPDFBlock{kind: "code", text: strings.Join(codeLines, "\n")})
			}
			continue
		}
		if generatedPDFRule(line) {
			flushParagraph()
			blocks = append(blocks, generatedPDFBlock{kind: "rule"})
			continue
		}
		if index+1 < len(lines) && generatedPDFTableDivider(strings.TrimSpace(lines[index+1])) {
			if header, ok := generatedPDFTableRow(line); ok {
				flushParagraph()
				rows := [][]string{header}
				index += 2
				for index < len(lines) {
					row, ok := generatedPDFTableRow(strings.TrimSpace(lines[index]))
					if !ok || len(row) != len(header) {
						break
					}
					rows = append(rows, row)
					index++
				}
				index--
				blocks = append(blocks, generatedPDFBlock{kind: "table", rows: rows})
				continue
			}
		}
		if level, heading, ok := generatedPDFHeading(line); ok {
			flushParagraph()
			blocks = append(blocks, generatedPDFBlock{kind: "heading", level: level, text: heading})
			continue
		}
		if kind, marker, item, ok := generatedPDFListItem(line); ok {
			flushParagraph()
			blocks = append(blocks, generatedPDFBlock{kind: kind, marker: marker, text: item})
			continue
		}
		paragraph = append(paragraph, line)
	}
	flushParagraph()
	for len(blocks) > 0 && blocks[len(blocks)-1].kind == "spacer" {
		blocks = blocks[:len(blocks)-1]
	}
	return blocks
}

func generatedPDFRule(line string) bool {
	line = strings.ReplaceAll(strings.TrimSpace(line), " ", "")
	if len(line) < 3 {
		return false
	}
	marker := line[0]
	if marker != '-' && marker != '*' && marker != '_' {
		return false
	}
	for index := 1; index < len(line); index++ {
		if line[index] != marker {
			return false
		}
	}
	return true
}

func generatedPDFTableDivider(line string) bool {
	row, ok := generatedPDFTableRow(line)
	if !ok || len(row) == 0 {
		return false
	}
	for _, cell := range row {
		cell = strings.TrimSpace(cell)
		cell = strings.Trim(cell, ":")
		if len(cell) < 3 || strings.Trim(cell, "-") != "" {
			return false
		}
	}
	return true
}

func generatedPDFTableRow(line string) ([]string, bool) {
	if !strings.Contains(line, "|") {
		return nil, false
	}
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	parts := strings.Split(line, "|")
	if len(parts) < 2 {
		return nil, false
	}
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
	}
	return parts, true
}

// generatedPDFPlainText keeps the renderer intentionally small while accepting
// the Markdown shapes assistants commonly emit in reports. Block-level Markdown
// is handled by parseGeneratedPDFBlocks; this removes inline markers so they are
// never leaked verbatim into the document.
func generatedPDFPlainText(raw string) string {
	replacer := strings.NewReplacer(
		"**", "",
		"__", "",
		"~~", "",
		"`", "",
	)
	raw = replacer.Replace(raw)
	if strings.HasPrefix(raw, "> ") {
		raw = strings.TrimSpace(strings.TrimPrefix(raw, ">"))
	}
	return raw
}

func generatedPDFHeading(line string) (int, string, bool) {
	level := 0
	for level < len(line) && line[level] == '#' {
		level++
	}
	if level == 0 || level > 4 || level >= len(line) || line[level] != ' ' {
		return 0, "", false
	}
	text := strings.TrimSpace(line[level:])
	if text == "" {
		return 0, "", false
	}
	return level, text, true
}

func generatedPDFListItem(line string) (kind, marker, text string, ok bool) {
	if len(line) >= 2 && (line[0] == '-' || line[0] == '*' || line[0] == '+') && line[1] == ' ' {
		return "unordered", "-", strings.TrimSpace(line[2:]), strings.TrimSpace(line[2:]) != ""
	}
	digitEnd := 0
	for digitEnd < len(line) && line[digitEnd] >= '0' && line[digitEnd] <= '9' {
		digitEnd++
	}
	if digitEnd == 0 || digitEnd >= len(line) || (line[digitEnd] != '.' && line[digitEnd] != ')') || digitEnd+1 >= len(line) || line[digitEnd+1] != ' ' {
		return "", "", "", false
	}
	text = strings.TrimSpace(line[digitEnd+2:])
	if text == "" {
		return "", "", "", false
	}
	return "ordered", line[:digitEnd+1], text, true
}

func validateGeneratedPDF(data []byte) ([]byte, error) {
	if len(data) == 0 || len(data) > maxGeneratedPDFBytes {
		return nil, fmt.Errorf("generated PDF is empty or too large")
	}
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		return nil, fmt.Errorf("generated PDF has an invalid header")
	}
	if !bytes.Contains(data, []byte("startxref")) || !bytes.Contains(data, []byte("%%EOF")) {
		return nil, fmt.Errorf("generated PDF is incomplete")
	}
	if countGeneratedPDFPages(data) == 0 {
		return nil, fmt.Errorf("generated PDF contains no pages")
	}
	return data, nil
}

func countGeneratedPDFPages(data []byte) int {
	const marker = "/Type /Page"
	count := 0
	for offset := 0; offset < len(data); {
		index := bytes.Index(data[offset:], []byte(marker))
		if index < 0 {
			break
		}
		index += offset
		end := index + len(marker)
		if end == len(data) || !((data[end] >= 'A' && data[end] <= 'Z') || (data[end] >= 'a' && data[end] <= 'z')) {
			count++
		}
		offset = end
	}
	return count
}

func sanitizeGeneratedPDFFilename(raw string) string {
	raw = strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	base := path.Base(raw)
	if strings.EqualFold(path.Ext(base), ".pdf") {
		base = strings.TrimSuffix(base, path.Ext(base))
	}
	var builder strings.Builder
	lastSeparator := false
	for _, r := range base {
		allowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.'
		if allowed {
			builder.WriteRune(r)
			lastSeparator = false
			continue
		}
		if unicode.IsSpace(r) || unicode.IsLetter(r) || unicode.IsDigit(r) {
			if !lastSeparator && builder.Len() > 0 {
				builder.WriteByte('-')
			}
			lastSeparator = true
		}
	}
	base = strings.Trim(builder.String(), ".-_ ")
	base = strings.ReplaceAll(base, "..", ".")
	if base == "" {
		base = "generated-document"
	}
	for len([]byte(base))+len(".pdf") > maxGeneratedPDFFilenameBytes {
		_, size := utf8.DecodeLastRuneInString(base)
		if size <= 0 || size > len(base) {
			break
		}
		base = base[:len(base)-size]
	}
	base = strings.Trim(base, ".-_ ")
	if base == "" {
		base = "generated-document"
	}
	return base + ".pdf"
}

func generatedPDFTitleFromContent(content string) string {
	for _, block := range parseGeneratedPDFBlocks(content) {
		if block.kind != "heading" && block.kind != "paragraph" {
			continue
		}
		title := strings.TrimSpace(generatedPDFPlainText(block.text))
		if title == "" {
			continue
		}
		runes := []rune(title)
		if len(runes) > 80 {
			title = string(runes[:80])
		}
		return title
	}
	return "Generated document"
}

func normalizeGeneratedPDFTitle(raw, content string) string {
	title := strings.ToValidUTF8(strings.TrimSpace(raw), "\uFFFD")
	if title == "" {
		title = generatedPDFTitleFromContent(content)
	}
	if len([]rune(title)) > maxGeneratedPDFTitleRunes {
		title = string([]rune(title)[:maxGeneratedPDFTitleRunes])
	}
	return strings.TrimSpace(title)
}

func generatedPDFOutputFilename(raw, title string) string {
	if strings.TrimSpace(raw) == "" {
		raw = title
	}
	return sanitizeGeneratedPDFFilename(raw)
}
