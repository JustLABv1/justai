package server

import (
	"bytes"
	"context"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/provider"
)

//go:embed templates/processor.py
var templateProcessor string

const maxTemplateBytes = 8 * 1024 * 1024

var templateProcessorSlots = make(chan struct{}, 2)

var templateMIMEs = map[string]string{
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "potx": "application/vnd.openxmlformats-officedocument.presentationml.template",
	"odt": "application/vnd.oasis.opendocument.text", "ott": "application/vnd.oasis.opendocument.text-template",
	"ods": "application/vnd.oasis.opendocument.spreadsheet", "ots": "application/vnd.oasis.opendocument.spreadsheet-template",
	"odp": "application/vnd.oasis.opendocument.presentation", "otp": "application/vnd.oasis.opendocument.presentation-template",
	"pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "csv": "text/csv", "html": "text/html", "json": "application/json", "xml": "application/xml",
}

type documentTemplate struct {
	ID           uuid.UUID       `json:"id"`
	Name         string          `json:"name"`
	Instructions string          `json:"instructions"`
	Filename     string          `json:"filename"`
	MimeType     string          `json:"mimeType"`
	Revision     int             `json:"revision"`
	Inspection   json.RawMessage `json:"inspection,omitempty"`
	UpdatedAt    time.Time       `json:"updatedAt"`
	Data         []byte          `json:"-"`
}

func runTemplateProcessor(ctx context.Context, filename string, data []byte, action string, arguments map[string]any) (json.RawMessage, error) {
	select {
	case templateProcessorSlots <- struct{}{}:
		defer func() { <-templateProcessorSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
	if _, ok := templateMIMEs[ext]; !ok {
		return nil, fmt.Errorf("unsupported template format; use DOCX, XLSX, PPTX, OpenDocument, PDF, TXT, Markdown, CSV, HTML, JSON or XML; convert legacy DOC/XLS/PPT/RTF first")
	}
	payload := map[string]any{"extension": ext, "data": base64.StdEncoding.EncodeToString(data), "action": action}
	if action == "render" {
		payload["values"] = arguments["values"]
		payload["edits"] = arguments["edits"]
		if rows, ok := arguments["rows"]; ok {
			payload["rows"] = rows
		}
		if payload["values"] == nil {
			payload["values"] = map[string]any{}
		}
		if payload["edits"] == nil {
			payload["edits"] = map[string]any{}
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	python := os.Getenv("JUSTAI_TEMPLATE_PYTHON")
	if python == "" {
		python = "python3"
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, python, "-I", "-c", templateProcessor)
	command.Stdin = bytes.NewReader(encoded)
	// The helper emits bounded JSON. Limit output even if a parser misbehaves.
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = command.Start(); err != nil {
		return nil, fmt.Errorf("document processor unavailable: %w", err)
	}
	result, readErr := io.ReadAll(io.LimitReader(stdout, 12*1024*1024+1))
	if readErr != nil || len(result) > 12*1024*1024 {
		cancel()
	}
	waitErr := command.Wait()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("document processing exceeded its limit")
	}
	if readErr != nil {
		return nil, readErr
	}
	var failure struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(result, &failure)
	if failure.Error != "" {
		return nil, fmt.Errorf("document processing: %s", failure.Error)
	}
	if waitErr != nil || !json.Valid(result) {
		return nil, fmt.Errorf("document processing failed; check the file and installed document dependencies")
	}
	return result, nil
}

func (a *App) templateList(ctx context.Context, userID, orgID uuid.UUID) ([]documentTemplate, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT id,name,instructions,filename,mime_type,revision,updated_at FROM document_templates WHERE user_id=$1 AND organization_id=$2 ORDER BY lower(name),id`, userID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []documentTemplate{}
	for rows.Next() {
		var t documentTemplate
		if err = rows.Scan(&t.ID, &t.Name, &t.Instructions, &t.Filename, &t.MimeType, &t.Revision, &t.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}
func (a *App) loadTemplate(ctx context.Context, id, userID, orgID uuid.UUID) (documentTemplate, error) {
	var t documentTemplate
	err := a.DB.QueryRowContext(ctx, `SELECT id,name,instructions,filename,mime_type,revision,inspection,updated_at,file_data FROM document_templates WHERE id=$1 AND user_id=$2 AND organization_id=$3`, id, userID, orgID).Scan(&t.ID, &t.Name, &t.Instructions, &t.Filename, &t.MimeType, &t.Revision, &t.Inspection, &t.UpdatedAt, &t.Data)
	return t, err
}
func (a *App) listDocumentTemplates(c *gin.Context) {
	p, org, err := workspaceScope(c)
	if err != nil {
		writeError(c, 400, err)
		return
	}
	items, err := a.templateList(c, p.UserID, org)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, gin.H{"templates": items})
}
func (a *App) getDocumentTemplate(c *gin.Context) {
	p, org, err := workspaceScope(c)
	if err != nil {
		writeError(c, 400, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, 400, fmt.Errorf("invalid template id"))
		return
	}
	t, err := a.loadTemplate(c, id, p.UserID, org)
	if err == sql.ErrNoRows {
		writeError(c, 404, fmt.Errorf("template not found"))
		return
	}
	if err != nil {
		writeError(c, 500, err)
		return
	}
	if strings.HasSuffix(c.Request.URL.Path, "/file") {
		c.Header("Content-Disposition", formatGeneratedFileContentDisposition(t.Filename))
		c.Header("Cache-Control", "private, no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Data(200, t.MimeType, t.Data)
		return
	}
	c.JSON(200, gin.H{"template": t})
}
func (a *App) saveDocumentTemplate(c *gin.Context) {
	p, org, err := workspaceScope(c)
	if err != nil {
		writeError(c, 400, err)
		return
	}
	var previous *documentTemplate
	if raw := c.Param("id"); raw != "" {
		id, e := uuid.Parse(raw)
		if e != nil {
			writeError(c, 400, fmt.Errorf("invalid template id"))
			return
		}
		t, e := a.loadTemplate(c, id, p.UserID, org)
		if e == sql.ErrNoRows {
			writeError(c, 404, fmt.Errorf("template not found"))
			return
		}
		if e != nil {
			writeError(c, 500, e)
			return
		}
		previous = &t
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxTemplateBytes+128*1024)
	if err = c.Request.ParseMultipartForm(maxTemplateBytes + 128*1024); err != nil {
		writeError(c, 400, fmt.Errorf("invalid upload or template exceeds 8 MB"))
		return
	}
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	name, instructions := strings.TrimSpace(c.PostForm("name")), strings.TrimSpace(c.PostForm("instructions"))
	if name == "" || utf8.RuneCountInString(name) > 120 || utf8.RuneCountInString(instructions) > 12000 {
		writeError(c, 400, fmt.Errorf("provide a name up to 120 characters and instructions up to 12000 characters"))
		return
	}
	var data []byte
	var filename, mimeType string
	var inspection json.RawMessage
	upload, header, fileErr := c.Request.FormFile("file")
	if fileErr == nil {
		defer upload.Close()
		data, err = io.ReadAll(io.LimitReader(upload, maxTemplateBytes+1))
		if err != nil || len(data) == 0 || len(data) > maxTemplateBytes {
			writeError(c, 400, fmt.Errorf("template must contain 1 byte to 8 MB"))
			return
		}
		filename = safeDownloadName(header.Filename)
		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
		mimeType = templateMIMEs[ext]
		inspection, err = runTemplateProcessor(c, filename, data, "inspect", nil)
		if err != nil {
			writeError(c, 400, err)
			return
		}
	} else if fileErr == http.ErrMissingFile && previous != nil {
		data = previous.Data
		filename = previous.Filename
		mimeType = previous.MimeType
		inspection = previous.Inspection
	} else {
		writeError(c, 400, fmt.Errorf("a template file is required"))
		return
	}
	var id uuid.UUID
	if previous == nil {
		err = a.DB.QueryRowContext(c, `INSERT INTO document_templates (user_id,organization_id,name,instructions,filename,mime_type,file_data,inspection) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, p.UserID, org, name, instructions, filename, mimeType, data, inspection).Scan(&id)
	} else {
		// Optimistic locking prevents silently replacing a template changed in another tab.
		revision := c.PostForm("revision")
		err = a.DB.QueryRowContext(c, `UPDATE document_templates SET name=$1,instructions=$2,filename=$3,mime_type=$4,file_data=$5,inspection=$6,revision=revision+1,updated_at=now() WHERE id=$7 AND user_id=$8 AND organization_id=$9 AND revision::text=$10 RETURNING id`, name, instructions, filename, mimeType, data, inspection, previous.ID, p.UserID, org, revision).Scan(&id)
	}
	if err == sql.ErrNoRows {
		writeError(c, 409, fmt.Errorf("template changed; reload before saving"))
		return
	}
	if err != nil {
		writeError(c, 500, err)
		return
	}
	c.JSON(200, gin.H{"id": id})
}
func (a *App) deleteDocumentTemplate(c *gin.Context) {
	p, org, err := workspaceScope(c)
	if err != nil {
		writeError(c, 400, err)
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, 400, fmt.Errorf("invalid template id"))
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM document_templates WHERE id=$1 AND user_id=$2 AND organization_id=$3`, id, p.UserID, org)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	count, err := result.RowsAffected()
	if err != nil {
		writeError(c, 500, err)
		return
	}
	if count == 0 {
		writeError(c, 404, fmt.Errorf("template not found"))
		return
	}
	c.Status(204)
}

func templateTools() []provider.ToolDefinition {
	return []provider.ToolDefinition{
		{Name: "list_templates", Description: "Find reusable document templates saved by this user in the current workspace. Always use this when asked to work from a saved template; do not ask the user to upload it again. If several match, ask which one. Read the chosen template before filling it.", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)},
		{Name: "read_template", Description: "Read the complete saved template, application instructions, revision, placeholders and editable targets. Target IDs are exact. readOnly targets cannot be changed. For reference PDFs use create_pdf to create a new document and explain that the original layout is not filled. Never invent missing facts: ask for required missing data.", Parameters: json.RawMessage(`{"type":"object","properties":{"templateId":{"type":"string"}},"required":["templateId"],"additionalProperties":false}`)},
		{Name: "fill_template", Description: "Fill a saved template and return a new downloadable file, preserving the original. First read_template. Provide its revision, values for {{placeholders}} (keys without braces), and/or edits mapping exact target IDs to new text/numbers/booleans. For PDF forms use edits with field names. For a variable-length table use rows mapping a tableRows ID to an array of rows (each row an array of cell values); it replaces that example row while retaining cell formatting. In XLSX you may also edit new cell addresses in an existing worksheet part (part#A1). Existing spreadsheet formulas are preserved and not evaluated here. Do not claim financial validation. Inspect all input attachments and ask for missing data before generating the final document. Never pass executable code or formulas.", Parameters: json.RawMessage(`{"type":"object","properties":{"templateId":{"type":"string"},"revision":{"type":"integer"},"values":{"type":"object","additionalProperties":{"type":["string","number","boolean"]}},"edits":{"type":"object","additionalProperties":{"type":["string","number","boolean"]}},"rows":{"type":"object","additionalProperties":{"type":"array","items":{"type":"array","items":{"type":["string","number","boolean"]}}}},"filename":{"type":"string"}},"required":["templateId","revision"],"additionalProperties":false}`)},
	}
}
func isTemplateTool(name string) bool {
	return name == "list_templates" || name == "read_template" || name == "fill_template"
}
func (a *App) templateTool(ctx context.Context, userID, org uuid.UUID, name string, args map[string]any) (json.RawMessage, *a2aArtifact, error) {
	if name == "list_templates" {
		items, err := a.templateList(ctx, userID, org)
		if err != nil {
			return nil, nil, err
		}
		data, err := json.Marshal(map[string]any{"templates": items})
		return data, nil, err
	}
	id, err := uuid.Parse(stringToolArgument(args, "templateId"))
	if err != nil {
		return nil, nil, fmt.Errorf("invalid template id")
	}
	t, err := a.loadTemplate(ctx, id, userID, org)
	if err == sql.ErrNoRows {
		return nil, nil, fmt.Errorf("template not found")
	}
	if err != nil {
		return nil, nil, err
	}
	if name == "read_template" {
		data, err := json.Marshal(t)
		return data, nil, err
	}
	if name != "fill_template" {
		return nil, nil, fmt.Errorf("unknown template tool")
	}
	revision, ok := args["revision"].(float64)
	if !ok || revision != float64(t.Revision) {
		return nil, nil, fmt.Errorf("template revision changed or missing; read_template again")
	}
	output, err := runTemplateProcessor(ctx, t.Filename, t.Data, "render", args)
	if err != nil {
		return nil, nil, err
	}
	var result struct {
		Data string `json:"data"`
	}
	if err = json.Unmarshal(output, &result); err != nil {
		return nil, nil, err
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return nil, nil, err
	}
	ext := filepath.Ext(t.Filename)
	filename := safeDownloadName(stringToolArgument(args, "filename"))
	if filename == "artifact" {
		filename = strings.TrimSuffix(t.Filename, ext) + "-filled"
	}
	filename = truncateAgentText(strings.TrimSuffix(filename, ext), 100) + ext
	artifact := a2aArtifact{Name: filename, Kind: "file", MimeType: t.MimeType, Content: data, Metadata: map[string]any{"templateId": t.ID, "templateRevision": t.Revision}}
	return nil, &artifact, nil
}
