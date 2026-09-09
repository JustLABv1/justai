package server

import (
	"justai-backend/rag"
	"strings"
	"testing"
)

func TestAgentFileFormats(t *testing.T) {
	cases := []struct{ format, content, mime string }{
		{"pdf", "# Report\n\nRevenue increased by 20 percent.", "application/pdf"},
		{"md", "# Report", "text/markdown"}, {"txt", "Report", "text/plain"},
		{"json", `{"revenue":120}`, "application/json"},
		{"csv", "name,value\nrevenue,120\n", "text/csv"},
		{"html", "<h1>Report</h1><p>Revenue increased.</p>", "text/html"},
	}
	for _, item := range cases {
		t.Run(item.format, func(t *testing.T) {
			file, err := makeAgentFile(map[string]any{"format": item.format, "content": item.content, "filename": "../report\r\n"})
			if err != nil {
				t.Fatal(err)
			}
			if file.MimeType != item.mime || !strings.HasSuffix(file.Name, "."+item.format) || strings.ContainsAny(file.Name, "/\r\n") {
				t.Fatalf("invalid file metadata: %#v", file)
			}
			if item.format == "pdf" {
				if _, err := validateGeneratedPDF(file.Content); err != nil {
					t.Fatal(err)
				}
			}
			if item.format != "pdf" {
				text, err := rag.ExtractUpload(file.Name, file.MimeType, file.Content)
				if err != nil || strings.TrimSpace(text) == "" {
					t.Fatalf("knowledge extraction failed: %v", err)
				}
			}
		})
	}
}

func TestAgentFileRejectsInvalidContent(t *testing.T) {
	for _, args := range []map[string]any{
		{"format": "exe", "content": "x"}, {"format": "pdf", "content": " "},
		{"format": "txt", "content": strings.Repeat("x", maxGeneratedPDFContentBytes+1)},
		{"format": "json", "content": "```json\n{}\n```"},
		{"format": "csv", "content": "a,b\n1,2,3"},
	} {
		if _, err := makeAgentFile(args); err == nil {
			t.Fatalf("expected invalid content to fail for %s", args["format"])
		}
	}
}
