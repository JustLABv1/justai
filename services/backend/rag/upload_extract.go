package rag

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/richardlehane/mscfb"
)

const maxExtractedDocumentBytes = 16 * 1024 * 1024

func extractArchiveXML(body []byte, wanted func(string) bool) (string, error) {
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return "", fmt.Errorf("document archive is invalid: %w", err)
	}
	files := append([]*zip.File(nil), archive.File...)
	sort.SliceStable(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	var result strings.Builder
	for _, file := range files {
		if !wanted(file.Name) || file.UncompressedSize64 > maxExtractedDocumentBytes {
			continue
		}
		reader, openErr := file.Open()
		if openErr != nil {
			return "", openErr
		}
		text, readErr := extractXMLText(io.LimitReader(reader, maxExtractedDocumentBytes+1))
		reader.Close()
		if readErr != nil {
			return "", readErr
		}
		if text != "" {
			if result.Len() > 0 {
				result.WriteString("\n\n")
			}
			result.WriteString(text)
		}
	}
	return strings.TrimSpace(result.String()), nil
}

func extractXMLText(reader io.Reader) (string, error) {
	decoder := xml.NewDecoder(reader)
	var result strings.Builder
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("XML extraction failed: %w", err)
		}
		switch value := token.(type) {
		case xml.CharData:
			text := strings.TrimSpace(string(value))
			if text != "" {
				if result.Len() > 0 {
					result.WriteByte(' ')
				}
				result.WriteString(text)
			}
		case xml.EndElement:
			switch value.Name.Local {
			case "p", "tr", "row", "si", "text:p", "h":
				result.WriteByte('\n')
			}
		}
		if result.Len() > maxExtractedDocumentBytes {
			return "", fmt.Errorf("extracted text exceeds the 16 MiB limit")
		}
	}
	return strings.TrimSpace(result.String()), nil
}

func extractOOXML(filename string, body []byte) (string, error) {
	ext := strings.ToLower(filepath.Ext(filename))
	return extractArchiveXML(body, func(name string) bool {
		name = strings.ToLower(name)
		switch ext {
		case ".docx", ".docm", ".dotx":
			return name == "word/document.xml" || strings.HasPrefix(name, "word/header") || strings.HasPrefix(name, "word/footer") || name == "word/footnotes.xml" || name == "word/endnotes.xml"
		case ".xlsx", ".xlsm", ".xltx":
			return name == "xl/sharedstrings.xml" || strings.HasPrefix(name, "xl/worksheets/sheet")
		case ".pptx", ".pptm", ".potx":
			return strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml")
		}
		return false
	})
}

func extractOpenDocument(body []byte) (string, error) {
	return extractArchiveXML(body, func(name string) bool { return strings.EqualFold(name, "content.xml") })
}

func extractEML(body []byte) (string, error) {
	message, err := mail.ReadMessage(bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("email is invalid: %w", err)
	}
	var result strings.Builder
	for _, header := range []string{"From", "To", "Cc", "Date", "Subject"} {
		if value := message.Header.Get(header); value != "" {
			fmt.Fprintf(&result, "%s: %s\n", header, value)
		}
	}
	mediaType, params, _ := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if strings.HasPrefix(mediaType, "multipart/") {
		reader := multipart.NewReader(message.Body, params["boundary"])
		for {
			part, partErr := reader.NextPart()
			if partErr == io.EOF {
				break
			}
			if partErr != nil {
				return "", partErr
			}
			partType, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
			if strings.HasPrefix(partType, "text/plain") || strings.HasPrefix(partType, "text/html") {
				data, _ := io.ReadAll(io.LimitReader(mailTransferReader(part, part.Header.Get("Content-Transfer-Encoding")), maxExtractedDocumentBytes+1))
				if strings.HasPrefix(partType, "text/html") {
					result.WriteString(cleanWebContent("text/html", data))
				} else if utf8.Valid(data) {
					result.Write(data)
				}
				result.WriteByte('\n')
			}
		}
	} else {
		data, _ := io.ReadAll(io.LimitReader(mailTransferReader(message.Body, message.Header.Get("Content-Transfer-Encoding")), maxExtractedDocumentBytes+1))
		if strings.Contains(mediaType, "html") {
			result.WriteString(cleanWebContent("text/html", data))
		} else if utf8.Valid(data) {
			result.Write(data)
		}
	}
	return strings.TrimSpace(result.String()), nil
}

func mailTransferReader(reader io.Reader, encoding string) io.Reader {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, reader)
	case "quoted-printable":
		return quotedprintable.NewReader(reader)
	default:
		return reader
	}
}

func extractMSG(body []byte) (string, error) {
	document, err := mscfb.New(bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("Outlook MSG file is invalid: %w", err)
	}
	labels := map[string]string{"0037001f": "Subject", "0037001e": "Subject", "0c1a001f": "From", "0c1a001e": "From", "5d01001f": "To", "5d01001e": "To", "0e04001f": "To", "0e04001e": "To", "1000001f": "Body", "1000001e": "Body"}
	var result strings.Builder
	for entry, nextErr := document.Next(); nextErr == nil; entry, nextErr = document.Next() {
		name := strings.ToLower(entry.Name)
		if entry.Size <= 0 || entry.Size > maxExtractedDocumentBytes {
			continue
		}
		var label string
		for tag, candidate := range labels {
			if strings.HasSuffix(name, tag) {
				label = candidate
				break
			}
		}
		if label == "" {
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(entry, maxExtractedDocumentBytes+1))
		if readErr != nil {
			continue
		}
		var value string
		if strings.HasSuffix(name, "001f") {
			if len(data)%2 != 0 {
				data = data[:len(data)-1]
			}
			units := make([]uint16, len(data)/2)
			for i := range units {
				units[i] = binary.LittleEndian.Uint16(data[i*2:])
			}
			value = string(utf16.Decode(units))
		} else {
			value = string(data)
		}
		value = strings.Trim(strings.TrimSpace(value), "\x00")
		if value != "" {
			fmt.Fprintf(&result, "%s: %s\n", label, value)
		}
	}
	if result.Len() == 0 {
		return "", fmt.Errorf("Outlook MSG contains no readable message text")
	}
	return strings.TrimSpace(result.String()), nil
}

func extractRTF(body []byte) string {
	text := string(body)
	var result strings.Builder
	for i := 0; i < len(text); i++ {
		if text[i] == '\\' {
			i++
			if i < len(text) && text[i] == '\'' && i+2 < len(text) {
				var value byte
				if _, err := fmt.Sscanf(text[i+1:i+3], "%02x", &value); err == nil {
					result.WriteByte(value)
				}
				i += 2
				continue
			}
			for i < len(text) && ((text[i] >= 'a' && text[i] <= 'z') || (text[i] >= 'A' && text[i] <= 'Z')) {
				i++
			}
			for i < len(text) && (text[i] == '-' || (text[i] >= '0' && text[i] <= '9')) {
				i++
			}
			if i < len(text) && text[i] != ' ' {
				i--
			}
			continue
		}
		if text[i] != '{' && text[i] != '}' {
			result.WriteByte(text[i])
		}
	}
	return strings.TrimSpace(result.String())
}
