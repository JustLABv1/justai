package server

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"justai-backend/provider"
)

func agentFileTool() provider.ToolDefinition {
	parameters, _ := json.Marshal(map[string]any{"type": "object", "properties": map[string]any{"format": map[string]any{"type": "string", "enum": []string{"pdf", "md", "txt", "json", "csv", "html"}}, "filename": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}, "content": map[string]any{"type": "string"}}, "required": []string{"format", "content"}})
	return provider.ToolDefinition{Name: "justai_create_file", Description: "Create a downloadable file attached to this run. Use for requested reports or exports. Supports pdf (Markdown content), md, txt, json, csv, html. Does not publish or save to knowledge storage; the user chooses that separately.", Parameters: parameters}
}

func validAgentOutputFormat(format string) bool {
	switch format {
	case "", "pdf", "md", "txt", "json", "csv", "html":
		return true
	}
	return false
}

func makeAgentFile(arguments map[string]any) (a2aArtifact, error) {
	format := stringToolArgument(arguments, "format")
	content := stringToolArgument(arguments, "content")
	if format == "" || !validAgentOutputFormat(format) {
		return a2aArtifact{}, fmt.Errorf("unsupported output format")
	}
	if strings.TrimSpace(content) == "" || len(content) > maxGeneratedPDFContentBytes {
		return a2aArtifact{}, fmt.Errorf("file content must contain 1 to %d bytes", maxGeneratedPDFContentBytes)
	}
	title := normalizeGeneratedPDFTitle(stringToolArgument(arguments, "title"), content)
	name := safeDownloadName(stringToolArgument(arguments, "filename"))
	name = strings.TrimSuffix(name, "."+format)
	if name == "artifact" {
		name = "output"
	}
	name = truncateAgentText(name, 100) + "." + format
	data := []byte(content)
	mimeType := map[string]string{"pdf": "application/pdf", "md": "text/markdown", "txt": "text/plain", "json": "application/json", "csv": "text/csv", "html": "text/html"}[format]
	switch format {
	case "pdf":
		var err error
		data, err = renderGeneratedPDF(title, content)
		if err != nil {
			return a2aArtifact{}, err
		}
		if _, err = validateGeneratedPDF(data); err != nil {
			return a2aArtifact{}, err
		}
	case "json":
		var formatted bytes.Buffer
		if err := json.Indent(&formatted, data, "", "  "); err != nil {
			return a2aArtifact{}, fmt.Errorf("content must be valid JSON: %w", err)
		}
		data = formatted.Bytes()
	case "csv":
		reader := csv.NewReader(strings.NewReader(content))
		for {
			_, err := reader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				return a2aArtifact{}, fmt.Errorf("content must be valid CSV: %w", err)
			}
		}
	}
	if len(data) > maxA2AArtifactBytes {
		return a2aArtifact{}, fmt.Errorf("file exceeds 8 MB")
	}
	return a2aArtifact{Name: name, Kind: "file", MimeType: mimeType, Content: data, Metadata: map[string]any{"format": format, "title": title}}, nil
}
