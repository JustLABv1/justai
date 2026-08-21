package server

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/transform"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type transcriptionSegmentUpdateRequest struct {
	EditedText *string `json:"editedText"`
	SpeakerID  *string `json:"speakerId"`
}

type transcriptionSegmentAssignmentRequest struct {
	SegmentIDs []string `json:"segmentIds"`
	SpeakerID  string   `json:"speakerId"`
}

type transcriptionAnnotationRequest struct {
	Kind          string  `json:"kind"`
	Note          string  `json:"note"`
	SegmentID     *string `json:"segmentId"`
	StartOffsetMs int64   `json:"startOffsetMs"`
	EndOffsetMs   int64   `json:"endOffsetMs"`
	Resolved      *bool   `json:"resolved"`
}

type transcriptionExportRow struct {
	SegmentID     uuid.UUID `json:"segmentId"`
	Speaker       string    `json:"speaker,omitempty"`
	Text          string    `json:"text"`
	StartOffsetMs int64     `json:"startOffsetMs"`
	EndOffsetMs   int64     `json:"endOffsetMs"`
}

type transcriptionInsightResponse struct {
	Summary     string                               `json:"summary"`
	Chapters    []models.TranscriptionInsightChapter `json:"chapters"`
	Topics      []string                             `json:"topics"`
	ActionItems []string                             `json:"actionItems"`
}

type transcriptionInsightRequest struct {
	Language string `json:"language"`
}

var transcriptionInsightLanguageLabels = map[string]string{
	"ar": "Arabic",
	"de": "German",
	"en": "English",
	"es": "Spanish",
	"fr": "French",
	"it": "Italian",
	"ja": "Japanese",
	"ko": "Korean",
	"nl": "Dutch",
	"pl": "Polish",
	"pt": "Portuguese",
	"tr": "Turkish",
	"uk": "Ukrainian",
	"zh": "Chinese",
}

func (a *App) updateTranscriptionSegment(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	segmentID, err := uuid.Parse(c.Param("segmentId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid segment id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionSegmentUpdateRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.EditedText == nil && request.SpeakerID == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("editedText or speakerId is required"))
		return
	}

	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var exists bool
	if err := transaction.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_segments WHERE id = $1 AND session_id = $2)`, segmentID, sessionID).Scan(&exists); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !exists {
		writeError(c, http.StatusNotFound, fmt.Errorf("transcription segment not found"))
		return
	}
	if request.EditedText != nil {
		editedText := strings.TrimSpace(*request.EditedText)
		var value any
		if editedText != "" {
			value = editedText
		}
		if _, err := transaction.ExecContext(c, `UPDATE transcription_segments SET edited_text = $3, updated_at = now() WHERE id = $1 AND session_id = $2`, segmentID, sessionID, value); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if request.SpeakerID != nil {
		var speakerValue any
		if strings.TrimSpace(*request.SpeakerID) != "" {
			speakerID, parseErr := uuid.Parse(strings.TrimSpace(*request.SpeakerID))
			if parseErr != nil {
				writeError(c, http.StatusBadRequest, fmt.Errorf("invalid speaker id"))
				return
			}
			var speakerExists bool
			if err := transaction.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_speakers WHERE id = $1 AND session_id = $2 AND merged_into IS NULL)`, speakerID, sessionID).Scan(&speakerExists); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			if !speakerExists {
				writeError(c, http.StatusNotFound, fmt.Errorf("speaker not found"))
				return
			}
			speakerValue = speakerID
		}
		if _, err := transaction.ExecContext(c, `UPDATE transcription_segments SET speaker_id = $3, updated_at = now() WHERE id = $1 AND session_id = $2`, segmentID, sessionID, speakerValue); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	segments, err := loadTranscriptionSegments(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	for _, segment := range segments {
		if segment.ID == segmentID {
			a.Live.broadcast(sessionID, "transcription.segment.updated", ginData{"segment": segment})
			c.JSON(http.StatusOK, gin.H{"segment": segment})
			return
		}
	}
	writeError(c, http.StatusNotFound, fmt.Errorf("transcription segment not found"))
}

func (a *App) assignTranscriptionSegments(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionSegmentAssignmentRequest
	if !decodeJSON(c, &request) {
		return
	}
	speakerID, err := uuid.Parse(request.SpeakerID)
	if err != nil || speakerID == uuid.Nil || len(request.SegmentIDs) == 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("speakerId and at least one segmentId are required"))
		return
	}
	segmentIDs := make([]uuid.UUID, 0, len(request.SegmentIDs))
	for _, value := range request.SegmentIDs {
		id, parseErr := uuid.Parse(value)
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid segment id"))
			return
		}
		segmentIDs = append(segmentIDs, id)
	}
	var speakerExists bool
	if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_speakers WHERE id = $1 AND session_id = $2 AND merged_into IS NULL)`, speakerID, sessionID).Scan(&speakerExists); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !speakerExists {
		writeError(c, http.StatusNotFound, fmt.Errorf("speaker not found"))
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE transcription_segments SET speaker_id = $3, updated_at = now() WHERE session_id = $1 AND id = ANY($2::uuid[])`, sessionID, pq.Array(segmentIDs), speakerID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.Live.broadcast(sessionID, "transcription.segments.assigned", ginData{"segmentIds": segmentIDs, "speakerId": speakerID})
	c.Status(http.StatusNoContent)
}

func (a *App) listTranscriptionAnnotations(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	annotations, err := loadTranscriptionAnnotations(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"annotations": annotations})
}

func (a *App) createTranscriptionAnnotation(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionAnnotationRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Kind = strings.ToLower(strings.TrimSpace(request.Kind))
	if request.Kind != "bookmark" && request.Kind != "comment" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("kind must be bookmark or comment"))
		return
	}
	request.Note = strings.TrimSpace(request.Note)
	if request.Kind == "comment" && request.Note == "" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a comment needs a note"))
		return
	}
	if request.StartOffsetMs < 0 || request.EndOffsetMs < request.StartOffsetMs {
		writeError(c, http.StatusBadRequest, fmt.Errorf("annotation offsets are invalid"))
		return
	}
	var segmentValue any
	if request.SegmentID != nil && strings.TrimSpace(*request.SegmentID) != "" {
		segmentID, parseErr := uuid.Parse(strings.TrimSpace(*request.SegmentID))
		if parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid segment id"))
			return
		}
		var segmentExists bool
		if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM transcription_segments WHERE id = $1 AND session_id = $2)`, segmentID, sessionID).Scan(&segmentExists); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if !segmentExists {
			writeError(c, http.StatusNotFound, fmt.Errorf("transcription segment not found"))
			return
		}
		segmentValue = segmentID
	}
	resolved := false
	if request.Resolved != nil {
		resolved = *request.Resolved
	}
	var annotation models.TranscriptionAnnotation
	var segmentID uuid.NullUUID
	if err := a.DB.QueryRowContext(c, `INSERT INTO transcription_annotations (session_id, user_id, segment_id, kind, note, start_offset_ms, end_offset_ms, resolved) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, session_id, user_id, segment_id, kind, note, start_offset_ms, end_offset_ms, resolved, created_at, updated_at`, sessionID, principal.UserID, segmentValue, request.Kind, request.Note, request.StartOffsetMs, request.EndOffsetMs, resolved).Scan(&annotation.ID, &annotation.SessionID, &annotation.UserID, &segmentID, &annotation.Kind, &annotation.Note, &annotation.StartOffsetMs, &annotation.EndOffsetMs, &annotation.Resolved, &annotation.CreatedAt, &annotation.UpdatedAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if segmentID.Valid {
		annotation.SegmentID = &segmentID.UUID
	}
	c.JSON(http.StatusCreated, gin.H{"annotation": annotation})
}

func (a *App) updateTranscriptionAnnotation(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	annotationID, err := uuid.Parse(c.Param("annotationId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid annotation id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionAnnotationRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.Note == "" && request.Resolved == nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("note or resolved is required"))
		return
	}
	var result sql.Result
	if request.Resolved != nil && request.Note != "" {
		result, err = a.DB.ExecContext(c, `UPDATE transcription_annotations SET note = $4, resolved = $5, updated_at = now() WHERE id = $1 AND session_id = $2 AND user_id = $3`, annotationID, sessionID, principal.UserID, strings.TrimSpace(request.Note), *request.Resolved)
	} else if request.Resolved != nil {
		result, err = a.DB.ExecContext(c, `UPDATE transcription_annotations SET resolved = $4, updated_at = now() WHERE id = $1 AND session_id = $2 AND user_id = $3`, annotationID, sessionID, principal.UserID, *request.Resolved)
	} else {
		result, err = a.DB.ExecContext(c, `UPDATE transcription_annotations SET note = $4, updated_at = now() WHERE id = $1 AND session_id = $2 AND user_id = $3`, annotationID, sessionID, principal.UserID, strings.TrimSpace(request.Note))
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		writeError(c, http.StatusNotFound, fmt.Errorf("annotation not found"))
		return
	}
	annotations, err := loadTranscriptionAnnotations(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	for _, annotation := range annotations {
		if annotation.ID == annotationID {
			c.JSON(http.StatusOK, gin.H{"annotation": annotation})
			return
		}
	}
	writeError(c, http.StatusNotFound, fmt.Errorf("annotation not found"))
}

func (a *App) deleteTranscriptionAnnotation(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	annotationID, err := uuid.Parse(c.Param("annotationId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid annotation id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	result, err := a.DB.ExecContext(c, `DELETE FROM transcription_annotations WHERE id = $1 AND session_id = $2 AND user_id = $3`, annotationID, sessionID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		writeError(c, http.StatusNotFound, fmt.Errorf("annotation not found"))
		return
	}
	c.Status(http.StatusNoContent)
}

func normalizeTranscriptionInsightLanguage(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || value == "auto" {
		return "auto", true
	}
	if separator := strings.IndexAny(value, "-_"); separator > 0 {
		value = value[:separator]
	}
	_, ok := transcriptionInsightLanguageLabels[value]
	return value, ok
}

func transcriptionInsightLanguageLabel(value string) string {
	value, ok := normalizeTranscriptionInsightLanguage(value)
	if !ok {
		return value
	}
	if value == "auto" {
		return "Transcript language"
	}
	return transcriptionInsightLanguageLabels[value]
}

func transcriptionInsightSystemPrompt(requestedLanguage, transcriptLanguage string) string {
	languageInstruction := "Write every natural-language field in the same language used by the transcript. If the transcript contains multiple languages, use its dominant language. Do not default to English unless the transcript is primarily English."
	if requestedLanguage != "auto" {
		languageInstruction = fmt.Sprintf("Write every natural-language field in %s. Do not write the insights in another language.", transcriptionInsightLanguageLabel(requestedLanguage))
	} else if normalizedTranscriptLanguage, ok := normalizeTranscriptionInsightLanguage(transcriptLanguage); ok && normalizedTranscriptLanguage != "auto" {
		languageInstruction = fmt.Sprintf("Write every natural-language field in %s, matching the transcript language. Do not write the insights in English unless the transcript is English.", transcriptionInsightLanguageLabel(normalizedTranscriptLanguage))
	}
	return "You are an experienced meeting and video transcript analyst. " + languageInstruction + " Return only valid JSON with this exact shape: {\"summary\":\"string\",\"chapters\":[{\"title\":\"string\",\"summary\":\"string\",\"startOffsetMs\":0}],\"topics\":[\"string\"],\"actionItems\":[\"string\"]}. Create concise, factual chapters ordered by startOffsetMs. Use only information present in the transcript. If no action items are stated, return an empty array. Keep startOffsetMs numeric and do not translate the transcript text itself. Do not use markdown fences or commentary."
}

func transcriptionExportFormatSupportsInsights(format string) bool {
	switch format {
	case "txt", "text", "md", "markdown", "docx", "pdf":
		return true
	default:
		return false
	}
}

func transcriptionExportIncludesInsights(c *gin.Context, format string) bool {
	if !transcriptionExportFormatSupportsInsights(format) {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(c.Query("includeInsights")))
	return value == "1" || value == "true" || value == "yes"
}

func (a *App) generateTranscriptionInsights(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var request transcriptionInsightRequest
	if c.Request.ContentLength != 0 && !decodeJSON(c, &request) {
		return
	}
	requestedLanguage, validLanguage := normalizeTranscriptionInsightLanguage(request.Language)
	if !validLanguage {
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported insight language %q", request.Language))
		return
	}
	var endpointID uuid.NullUUID
	var title, language string
	if err := a.DB.QueryRowContext(c, `SELECT grammar_endpoint_id, title, language FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&endpointID, &title, &language); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !endpointID.Valid {
		writeError(c, http.StatusBadRequest, fmt.Errorf("configure a grammar/chat endpoint before generating AI insights"))
		return
	}
	endpoint, err := a.providerEndpoint(c, endpointID.UUID)
	if err != nil || !endpointSupports(endpoint, "chat") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("the configured grammar endpoint does not support chat"))
		return
	}
	segments, err := loadTranscriptionSegments(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if len(segments) == 0 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("generate insights after transcript output is available"))
		return
	}
	rows := transcriptionExportRows(segments, nil)
	input := strings.Builder{}
	input.WriteString("Title: ")
	input.WriteString(title)
	input.WriteString("\nLanguage: ")
	input.WriteString(language)
	input.WriteString("\nTranscript:\n")
	for _, row := range rows {
		fmt.Fprintf(&input, "[%s] %s\n", formatTranscriptTimestamp(row.StartOffsetMs), row.Text)
		if input.Len() > 60000 {
			input.WriteString("\n[Transcript truncated after 60,000 characters.]\n")
			break
		}
	}
	if _, err := a.DB.ExecContext(c, `INSERT INTO transcription_insights (session_id, language, status, error_message, updated_at) VALUES ($1, $2, 'processing', NULL, now()) ON CONFLICT (session_id) DO UPDATE SET language = $2, status = 'processing', error_message = NULL, updated_at = now()`, sessionID, requestedLanguage); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	insightContext, cancel := context.WithTimeout(c, 2*time.Minute)
	defer cancel()
	var output strings.Builder
	systemPrompt := transcriptionInsightSystemPrompt(requestedLanguage, language)
	err = provider.StreamChat(insightContext, endpoint, provider.ChatOptions{
		Model: endpoint.ChatModel,
		Messages: []provider.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: input.String()},
		},
	}, func(delta string) error {
		output.WriteString(delta)
		return nil
	})
	if err != nil {
		_, _ = a.DB.ExecContext(c, `UPDATE transcription_insights SET status = 'failed', error_message = $2, updated_at = now() WHERE session_id = $1`, sessionID, err.Error())
		writeError(c, http.StatusBadGateway, fmt.Errorf("insight generation failed: %w", err))
		return
	}
	decoded, err := decodeTranscriptionInsightOutput(output.String())
	if err != nil {
		_, _ = a.DB.ExecContext(c, `UPDATE transcription_insights SET status = 'failed', error_message = $2, updated_at = now() WHERE session_id = $1`, sessionID, err.Error())
		writeError(c, http.StatusBadGateway, err)
		return
	}
	generatedAt := time.Now().UTC()
	chaptersJSON, _ := json.Marshal(decoded.Chapters)
	topicsJSON, _ := json.Marshal(decoded.Topics)
	actionItemsJSON, _ := json.Marshal(decoded.ActionItems)
	if _, err := a.DB.ExecContext(c, `UPDATE transcription_insights SET language = $2, status = 'completed', summary = $3, chapters = $4, topics = $5, action_items = $6, error_message = NULL, generated_at = $7, updated_at = $7 WHERE session_id = $1`, sessionID, requestedLanguage, strings.TrimSpace(decoded.Summary), chaptersJSON, topicsJSON, actionItemsJSON, generatedAt); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	insights, err := loadTranscriptionInsights(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"insights": insights})
}

func (a *App) exportTranscription(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	sessionID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if err := a.authorizeTranscriptionSession(c, sessionID, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	session, err := loadTranscriptionSession(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	segments, err := loadTranscriptionSegments(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	speakers, err := loadTranscriptionSpeakers(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	format := strings.ToLower(strings.TrimSpace(c.Param("format")))
	rows := transcriptionExportRows(segments, speakers)
	includeInsights := transcriptionExportIncludesInsights(c, format)
	var exportInsights *models.TranscriptionInsights
	if format == "json" || includeInsights {
		loadedInsights, insightErr := loadTranscriptionInsights(c, a.DB, sessionID)
		if insightErr != nil {
			writeError(c, http.StatusInternalServerError, insightErr)
			return
		}
		exportInsights = &loadedInsights
	}
	baseName := safeTranscriptExportName(session.Title)
	var data []byte
	contentType := "text/plain; charset=utf-8"
	extension := "txt"
	switch format {
	case "txt", "text":
		data = []byte(transcriptionPlainText(rows, exportInsights))
	case "md", "markdown":
		extension = "md"
		contentType = "text/markdown; charset=utf-8"
		data = []byte(transcriptionMarkdown(session.Title, rows, exportInsights))
	case "srt":
		extension = "srt"
		contentType = "application/x-subrip; charset=utf-8"
		data = []byte(transcriptionSRT(rows))
	case "vtt":
		extension = "vtt"
		contentType = "text/vtt; charset=utf-8"
		data = []byte(transcriptionVTT(rows))
	case "json":
		extension = "json"
		contentType = "application/json; charset=utf-8"
		annotations, annotationErr := loadTranscriptionAnnotations(c, a.DB, sessionID)
		if annotationErr != nil {
			writeError(c, http.StatusInternalServerError, annotationErr)
			return
		}
		data, err = json.MarshalIndent(gin.H{"session": session, "speakers": speakers, "segments": segments, "annotations": annotations, "insights": *exportInsights}, "", "  ")
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	case "docx":
		extension = "docx"
		contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		data = buildTranscriptDOCX(session.Title, rows, exportInsights)
	case "pdf":
		extension = "pdf"
		contentType = "application/pdf"
		data = buildTranscriptPDF(session.Title, rows, exportInsights)
	default:
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported export format %q", format))
		return
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.%s"`, baseName, extension))
	c.Data(http.StatusOK, contentType, data)
}

func loadTranscriptionAnnotations(ctx context.Context, db *sql.DB, sessionID uuid.UUID) ([]models.TranscriptionAnnotation, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, session_id, user_id, segment_id, kind, note, start_offset_ms, end_offset_ms, resolved, created_at, updated_at FROM transcription_annotations WHERE session_id = $1 ORDER BY start_offset_ms, created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.TranscriptionAnnotation, 0)
	for rows.Next() {
		var item models.TranscriptionAnnotation
		var segmentID uuid.NullUUID
		if err := rows.Scan(&item.ID, &item.SessionID, &item.UserID, &segmentID, &item.Kind, &item.Note, &item.StartOffsetMs, &item.EndOffsetMs, &item.Resolved, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if segmentID.Valid {
			item.SegmentID = &segmentID.UUID
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func loadTranscriptionInsights(ctx context.Context, db *sql.DB, sessionID uuid.UUID) (models.TranscriptionInsights, error) {
	item := models.TranscriptionInsights{SessionID: sessionID, Status: "idle", Language: "auto", Chapters: []models.TranscriptionInsightChapter{}, Topics: []string{}, ActionItems: []string{}}
	var chaptersJSON, topicsJSON, actionItemsJSON []byte
	var errorMessage sql.NullString
	err := db.QueryRowContext(ctx, `SELECT language, status, summary, chapters, topics, action_items, error_message, generated_at, updated_at FROM transcription_insights WHERE session_id = $1`, sessionID).Scan(&item.Language, &item.Status, &item.Summary, &chaptersJSON, &topicsJSON, &actionItemsJSON, &errorMessage, &item.GeneratedAt, &item.UpdatedAt)
	if err == sql.ErrNoRows {
		return item, nil
	}
	if err != nil {
		return item, err
	}
	item.Error = errorMessage.String
	if err := json.Unmarshal(chaptersJSON, &item.Chapters); err != nil {
		return item, err
	}
	if err := json.Unmarshal(topicsJSON, &item.Topics); err != nil {
		return item, err
	}
	if err := json.Unmarshal(actionItemsJSON, &item.ActionItems); err != nil {
		return item, err
	}
	return item, nil
}

func transcriptionExportRows(segments []models.TranscriptionSegment, speakers []models.TranscriptionSpeaker) []transcriptionExportRow {
	speakerByID := make(map[uuid.UUID]string, len(speakers))
	for _, speaker := range speakers {
		speakerByID[speaker.ID] = firstNonEmptyString(speaker.DisplayName, speaker.Label)
	}
	rows := make([]transcriptionExportRow, 0, len(segments))
	for _, segment := range segments {
		text := strings.TrimSpace(segment.Text)
		if segment.EditedText != nil && strings.TrimSpace(*segment.EditedText) != "" {
			text = strings.TrimSpace(*segment.EditedText)
		} else if segment.PolishedText != nil && strings.TrimSpace(*segment.PolishedText) != "" {
			text = strings.TrimSpace(*segment.PolishedText)
		}
		if text == "" {
			continue
		}
		row := transcriptionExportRow{SegmentID: segment.ID, Text: text, StartOffsetMs: segment.StartOffsetMs, EndOffsetMs: segment.EndOffsetMs}
		if segment.SpeakerID != nil {
			row.Speaker = speakerByID[*segment.SpeakerID]
		}
		rows = append(rows, row)
	}
	return rows
}

func transcriptionPlainText(rows []transcriptionExportRow, insights *models.TranscriptionInsights) string {
	var output strings.Builder
	for _, row := range rows {
		fmt.Fprintf(&output, "[%s]", formatTranscriptTimestamp(row.StartOffsetMs))
		if row.Speaker != "" {
			fmt.Fprintf(&output, " %s:", row.Speaker)
		}
		fmt.Fprintf(&output, " %s\n", row.Text)
	}
	appendTranscriptionPlainTextInsights(&output, insights)
	return output.String()
}

func appendTranscriptionPlainTextInsights(output *strings.Builder, insights *models.TranscriptionInsights) {
	if insights == nil {
		return
	}
	output.WriteString("\nAI INSIGHTS\n")
	fmt.Fprintf(output, "Language: %s\n", transcriptionInsightLanguageLabel(insights.Language))
	if insights.Status != "completed" {
		fmt.Fprintf(output, "Status: %s\n", insights.Status)
		if strings.TrimSpace(insights.Error) != "" {
			fmt.Fprintf(output, "Error: %s\n", strings.TrimSpace(insights.Error))
		}
		return
	}
	if strings.TrimSpace(insights.Summary) != "" {
		fmt.Fprintf(output, "\nSummary\n%s\n", strings.TrimSpace(insights.Summary))
	}
	if len(insights.Chapters) > 0 {
		output.WriteString("\nChapters\n")
		for _, chapter := range insights.Chapters {
			fmt.Fprintf(output, "[%s] %s", formatTranscriptTimestamp(chapter.StartOffsetMs), strings.TrimSpace(chapter.Title))
			if strings.TrimSpace(chapter.Summary) != "" {
				fmt.Fprintf(output, " - %s", strings.TrimSpace(chapter.Summary))
			}
			output.WriteByte('\n')
		}
	}
	if len(insights.Topics) > 0 {
		output.WriteString("\nTopics\n")
		for _, topic := range insights.Topics {
			fmt.Fprintf(output, "- %s\n", strings.TrimSpace(topic))
		}
	}
	if len(insights.ActionItems) > 0 {
		output.WriteString("\nAction items\n")
		for _, item := range insights.ActionItems {
			fmt.Fprintf(output, "- %s\n", strings.TrimSpace(item))
		}
	}
}

func transcriptionMarkdown(title string, rows []transcriptionExportRow, insights *models.TranscriptionInsights) string {
	var output strings.Builder
	fmt.Fprintf(&output, "# %s\n\n", title)
	for _, row := range rows {
		fmt.Fprintf(&output, "- **%s**", formatTranscriptTimestamp(row.StartOffsetMs))
		if row.Speaker != "" {
			fmt.Fprintf(&output, " · **%s**", row.Speaker)
		}
		fmt.Fprintf(&output, " — %s\n", strings.ReplaceAll(row.Text, "\n", " "))
	}
	appendTranscriptionMarkdownInsights(&output, insights)
	return output.String()
}

func appendTranscriptionMarkdownInsights(output *strings.Builder, insights *models.TranscriptionInsights) {
	if insights == nil {
		return
	}
	output.WriteString("\n## AI insights\n\n")
	fmt.Fprintf(output, "**Language:** %s\n\n", transcriptionInsightLanguageLabel(insights.Language))
	if insights.Status != "completed" {
		fmt.Fprintf(output, "_Status: %s_\n", insights.Status)
		if strings.TrimSpace(insights.Error) != "" {
			fmt.Fprintf(output, "\n> %s\n", strings.TrimSpace(insights.Error))
		}
		return
	}
	if strings.TrimSpace(insights.Summary) != "" {
		fmt.Fprintf(output, "### Summary\n\n%s\n\n", strings.TrimSpace(insights.Summary))
	}
	if len(insights.Chapters) > 0 {
		output.WriteString("### Chapters\n\n")
		for _, chapter := range insights.Chapters {
			fmt.Fprintf(output, "- **%s** · **%s**", formatTranscriptTimestamp(chapter.StartOffsetMs), strings.TrimSpace(chapter.Title))
			if strings.TrimSpace(chapter.Summary) != "" {
				fmt.Fprintf(output, " — %s", strings.TrimSpace(chapter.Summary))
			}
			output.WriteByte('\n')
		}
		output.WriteByte('\n')
	}
	if len(insights.Topics) > 0 {
		output.WriteString("### Topics\n\n")
		for _, topic := range insights.Topics {
			fmt.Fprintf(output, "- %s\n", strings.TrimSpace(topic))
		}
		output.WriteByte('\n')
	}
	if len(insights.ActionItems) > 0 {
		output.WriteString("### Action items\n\n")
		for _, item := range insights.ActionItems {
			fmt.Fprintf(output, "- %s\n", strings.TrimSpace(item))
		}
		output.WriteByte('\n')
	}
}

func transcriptionSRT(rows []transcriptionExportRow) string {
	var output strings.Builder
	for index, row := range rows {
		end := row.EndOffsetMs
		if end <= row.StartOffsetMs {
			end = row.StartOffsetMs + 2000
		}
		fmt.Fprintf(&output, "%d\n%s --> %s\n", index+1, formatTranscriptSRTTimestamp(row.StartOffsetMs), formatTranscriptSRTTimestamp(end))
		if row.Speaker != "" {
			fmt.Fprintf(&output, "%s: ", row.Speaker)
		}
		fmt.Fprintf(&output, "%s\n\n", row.Text)
	}
	return output.String()
}

func transcriptionVTT(rows []transcriptionExportRow) string {
	var output strings.Builder
	output.WriteString("WEBVTT\n\n")
	for _, row := range rows {
		end := row.EndOffsetMs
		if end <= row.StartOffsetMs {
			end = row.StartOffsetMs + 2000
		}
		fmt.Fprintf(&output, "%s --> %s\n", formatTranscriptVTTTimestamp(row.StartOffsetMs), formatTranscriptVTTTimestamp(end))
		if row.Speaker != "" {
			fmt.Fprintf(&output, "%s: ", row.Speaker)
		}
		fmt.Fprintf(&output, "%s\n\n", row.Text)
	}
	return output.String()
}

func formatTranscriptTimestamp(offsetMs int64) string {
	seconds := offsetMs / 1000
	return fmt.Sprintf("%02d:%02d:%02d", seconds/3600, (seconds/60)%60, seconds%60)
}

func formatTranscriptSRTTimestamp(offsetMs int64) string {
	return formatTranscriptTimestamp(offsetMs) + fmt.Sprintf(",%03d", offsetMs%1000)
}

func formatTranscriptVTTTimestamp(offsetMs int64) string {
	return formatTranscriptTimestamp(offsetMs) + fmt.Sprintf(".%03d", offsetMs%1000)
}

func safeTranscriptExportName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "transcript"
	}
	value = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) || r == '-' || r == '_' || r == ' ' {
			return r
		}
		return -1
	}, value)
	value = strings.Join(strings.Fields(value), "-")
	if value == "" {
		return "transcript"
	}
	return value
}

func buildTranscriptDOCX(title string, rows []transcriptionExportRow, insights *models.TranscriptionInsights) []byte {
	var document strings.Builder
	document.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`)
	document.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>` + html.EscapeString(title) + `</w:t></w:r></w:p>`)
	for _, row := range rows {
		text := fmt.Sprintf("[%s]", formatTranscriptTimestamp(row.StartOffsetMs))
		if row.Speaker != "" {
			text += " " + row.Speaker + ":"
		}
		text += " " + row.Text
		document.WriteString(`<w:p><w:r><w:t xml:space="preserve">` + html.EscapeString(text) + `</w:t></w:r></w:p>`)
	}
	if insights != nil {
		document.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>AI insights</w:t></w:r></w:p>`)
		document.WriteString(`<w:p><w:r><w:t xml:space="preserve">Language: ` + html.EscapeString(transcriptionInsightLanguageLabel(insights.Language)) + `</w:t></w:r></w:p>`)
		if insights.Status != "completed" {
			document.WriteString(`<w:p><w:r><w:t xml:space="preserve">Status: ` + html.EscapeString(insights.Status) + `</w:t></w:r></w:p>`)
			if strings.TrimSpace(insights.Error) != "" {
				document.WriteString(`<w:p><w:r><w:t xml:space="preserve">Error: ` + html.EscapeString(strings.TrimSpace(insights.Error)) + `</w:t></w:r></w:p>`)
			}
		} else {
			if strings.TrimSpace(insights.Summary) != "" {
				document.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Summary</w:t></w:r></w:p>`)
				document.WriteString(`<w:p><w:r><w:t xml:space="preserve">` + html.EscapeString(strings.TrimSpace(insights.Summary)) + `</w:t></w:r></w:p>`)
			}
			if len(insights.Chapters) > 0 {
				document.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Chapters</w:t></w:r></w:p>`)
				for _, chapter := range insights.Chapters {
					text := fmt.Sprintf("[%s] %s", formatTranscriptTimestamp(chapter.StartOffsetMs), strings.TrimSpace(chapter.Title))
					if strings.TrimSpace(chapter.Summary) != "" {
						text += " - " + strings.TrimSpace(chapter.Summary)
					}
					document.WriteString(`<w:p><w:r><w:t xml:space="preserve">` + html.EscapeString(text) + `</w:t></w:r></w:p>`)
				}
			}
			if len(insights.Topics) > 0 {
				document.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Topics</w:t></w:r></w:p>`)
				for _, topic := range insights.Topics {
					document.WriteString(`<w:p><w:r><w:t xml:space="preserve">- ` + html.EscapeString(strings.TrimSpace(topic)) + `</w:t></w:r></w:p>`)
				}
			}
			if len(insights.ActionItems) > 0 {
				document.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Action items</w:t></w:r></w:p>`)
				for _, item := range insights.ActionItems {
					document.WriteString(`<w:p><w:r><w:t xml:space="preserve">- ` + html.EscapeString(strings.TrimSpace(item)) + `</w:t></w:r></w:p>`)
				}
			}
		}
	}
	document.WriteString(`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   document.String(),
	}
	for name, content := range files {
		writer, err := archive.Create(name)
		if err != nil {
			return nil
		}
		_, _ = writer.Write([]byte(content))
	}
	if err := archive.Close(); err != nil {
		return nil
	}
	return output.Bytes()
}

type transcriptPDFBlock struct {
	StartOffsetMs int64
	EndOffsetMs   int64
	Speaker       string
	Text          string
}

type transcriptPDFTextLine struct {
	Text  string
	X     float64
	Y     float64
	Font  string
	Size  float64
	Color string
}

type transcriptPDFPage struct {
	Lines []transcriptPDFTextLine
}

const (
	transcriptPDFPageWidth       = 612.0
	transcriptPDFPageHeight      = 792.0
	transcriptPDFLeftMargin      = 54.0
	transcriptPDFRightMargin     = 558.0
	transcriptPDFTextX           = 118.0
	transcriptPDFBodyTopY        = 684.0
	transcriptPDFBodyBottomY     = 54.0
	transcriptPDFBodyFontSize    = 10.5
	transcriptPDFBodyLineHeight  = 15.0
	transcriptPDFParagraphGap    = 9.0
	transcriptPDFBodyLineCharMax = 84
	transcriptPDFBlockCharMax    = 720
)

func buildTranscriptPDF(title string, rows []transcriptionExportRow, insights *models.TranscriptionInsights) []byte {
	blocks := transcriptionPDFBlocks(rows)
	pages := []transcriptPDFPage{{Lines: make([]transcriptPDFTextLine, 0)}}
	currentY := transcriptPDFBodyTopY

	for _, block := range blocks {
		wrapped := wrapTranscriptPDFLine(block.Text, transcriptPDFBodyLineCharMax)
		lineCount := len(wrapped)
		if block.Speaker != "" {
			lineCount++
		}
		requiredHeight := float64(lineCount)*transcriptPDFBodyLineHeight + transcriptPDFParagraphGap
		if currentY-requiredHeight < transcriptPDFBodyBottomY && len(pages[len(pages)-1].Lines) > 0 {
			pages = append(pages, transcriptPDFPage{Lines: make([]transcriptPDFTextLine, 0)})
			currentY = transcriptPDFBodyTopY
		}

		page := &pages[len(pages)-1]
		if block.Speaker != "" {
			page.Lines = append(page.Lines,
				transcriptPDFTextLine{Text: formatTranscriptTimestamp(block.StartOffsetMs), X: transcriptPDFLeftMargin, Y: currentY, Font: "F2", Size: 8.5, Color: "0.39 0.29 0.24"},
				transcriptPDFTextLine{Text: block.Speaker, X: transcriptPDFTextX, Y: currentY, Font: "F2", Size: transcriptPDFBodyFontSize, Color: "0.16 0.14 0.13"},
			)
			currentY -= transcriptPDFBodyLineHeight
			for _, line := range wrapped {
				page.Lines = append(page.Lines, transcriptPDFTextLine{Text: line, X: transcriptPDFTextX, Y: currentY, Font: "F1", Size: transcriptPDFBodyFontSize, Color: "0.16 0.14 0.13"})
				currentY -= transcriptPDFBodyLineHeight
			}
		} else {
			for index, line := range wrapped {
				if index == 0 {
					page.Lines = append(page.Lines, transcriptPDFTextLine{Text: formatTranscriptTimestamp(block.StartOffsetMs), X: transcriptPDFLeftMargin, Y: currentY, Font: "F2", Size: 8.5, Color: "0.39 0.29 0.24"})
				}
				page.Lines = append(page.Lines, transcriptPDFTextLine{Text: line, X: transcriptPDFTextX, Y: currentY, Font: "F1", Size: transcriptPDFBodyFontSize, Color: "0.16 0.14 0.13"})
				currentY -= transcriptPDFBodyLineHeight
			}
		}
		currentY -= transcriptPDFParagraphGap
	}
	appendTranscriptPDFInsights(&pages, &currentY, insights)

	if len(blocks) == 0 {
		pages[0].Lines = append(pages[0].Lines, transcriptPDFTextLine{Text: "No transcript text available.", X: transcriptPDFTextX, Y: transcriptPDFBodyTopY, Font: "F1", Size: transcriptPDFBodyFontSize, Color: "0.42 0.40 0.39"})
	}

	return renderTranscriptPDF(title, pages)
}

func appendTranscriptPDFInsights(pages *[]transcriptPDFPage, currentY *float64, insights *models.TranscriptionInsights) {
	if insights == nil {
		return
	}
	appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "AI insights", X: transcriptPDFLeftMargin, Font: "F2", Size: 15, Color: "0.12 0.11 0.10"}, 21)
	appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "Language: " + transcriptionInsightLanguageLabel(insights.Language), X: transcriptPDFLeftMargin, Font: "F1", Size: 8.5, Color: "0.42 0.40 0.39"}, 16)
	if insights.Status != "completed" {
		appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "Status: " + insights.Status, X: transcriptPDFLeftMargin, Font: "F1", Size: transcriptPDFBodyFontSize, Color: "0.16 0.14 0.13"}, transcriptPDFBodyLineHeight)
		if strings.TrimSpace(insights.Error) != "" {
			appendTranscriptPDFWrappedFlow(pages, currentY, strings.TrimSpace(insights.Error), transcriptPDFLeftMargin, transcriptPDFBodyLineCharMax, "F1", transcriptPDFBodyFontSize, "0.16 0.14 0.13")
		}
		return
	}
	if strings.TrimSpace(insights.Summary) != "" {
		appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "Summary", X: transcriptPDFLeftMargin, Font: "F2", Size: transcriptPDFBodyFontSize, Color: "0.20 0.18 0.17"}, 17)
		appendTranscriptPDFWrappedFlow(pages, currentY, strings.TrimSpace(insights.Summary), transcriptPDFLeftMargin, transcriptPDFBodyLineCharMax, "F1", transcriptPDFBodyFontSize, "0.16 0.14 0.13")
		*currentY -= 5
	}
	if len(insights.Chapters) > 0 {
		appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "Chapters", X: transcriptPDFLeftMargin, Font: "F2", Size: transcriptPDFBodyFontSize, Color: "0.20 0.18 0.17"}, 17)
		for _, chapter := range insights.Chapters {
			text := fmt.Sprintf("[%s] %s", formatTranscriptTimestamp(chapter.StartOffsetMs), strings.TrimSpace(chapter.Title))
			if strings.TrimSpace(chapter.Summary) != "" {
				text += " - " + strings.TrimSpace(chapter.Summary)
			}
			appendTranscriptPDFWrappedFlow(pages, currentY, text, transcriptPDFLeftMargin, transcriptPDFBodyLineCharMax, "F1", transcriptPDFBodyFontSize, "0.16 0.14 0.13")
		}
		*currentY -= 5
	}
	if len(insights.Topics) > 0 {
		appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "Topics", X: transcriptPDFLeftMargin, Font: "F2", Size: transcriptPDFBodyFontSize, Color: "0.20 0.18 0.17"}, 17)
		appendTranscriptPDFWrappedFlow(pages, currentY, strings.Join(insights.Topics, ", "), transcriptPDFLeftMargin, transcriptPDFBodyLineCharMax, "F1", transcriptPDFBodyFontSize, "0.16 0.14 0.13")
		*currentY -= 5
	}
	if len(insights.ActionItems) > 0 {
		appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: "Action items", X: transcriptPDFLeftMargin, Font: "F2", Size: transcriptPDFBodyFontSize, Color: "0.20 0.18 0.17"}, 17)
		for _, item := range insights.ActionItems {
			appendTranscriptPDFWrappedFlow(pages, currentY, "- "+strings.TrimSpace(item), transcriptPDFLeftMargin, transcriptPDFBodyLineCharMax, "F1", transcriptPDFBodyFontSize, "0.16 0.14 0.13")
		}
	}
}

func appendTranscriptPDFWrappedFlow(pages *[]transcriptPDFPage, currentY *float64, text string, x float64, width int, font string, size float64, color string) {
	for _, line := range wrapTranscriptPDFLine(text, width) {
		appendTranscriptPDFFlowLine(pages, currentY, transcriptPDFTextLine{Text: line, X: x, Font: font, Size: size, Color: color}, transcriptPDFBodyLineHeight)
	}
}

func appendTranscriptPDFFlowLine(pages *[]transcriptPDFPage, currentY *float64, line transcriptPDFTextLine, lineHeight float64) {
	if *currentY-lineHeight < transcriptPDFBodyBottomY && len((*pages)[len(*pages)-1].Lines) > 0 {
		*pages = append(*pages, transcriptPDFPage{Lines: make([]transcriptPDFTextLine, 0)})
		*currentY = transcriptPDFBodyTopY
	}
	line.Y = *currentY
	page := &(*pages)[len(*pages)-1]
	page.Lines = append(page.Lines, line)
	*currentY -= lineHeight
}

func transcriptionPDFBlocks(rows []transcriptionExportRow) []transcriptPDFBlock {
	blocks := make([]transcriptPDFBlock, 0, len(rows))
	for _, row := range rows {
		text := strings.Join(strings.Fields(strings.ReplaceAll(row.Text, "\n", " ")), " ")
		if text == "" {
			continue
		}
		if len(blocks) > 0 {
			last := &blocks[len(blocks)-1]
			gap := row.StartOffsetMs - last.EndOffsetMs
			if gap < 0 {
				gap = 0
			}
			if last.Speaker == row.Speaker && gap <= 4500 && len([]rune(last.Text))+1+len([]rune(text)) <= transcriptPDFBlockCharMax {
				last.Text += " " + text
				last.EndOffsetMs = row.EndOffsetMs
				continue
			}
		}
		blocks = append(blocks, transcriptPDFBlock{StartOffsetMs: row.StartOffsetMs, EndOffsetMs: row.EndOffsetMs, Speaker: row.Speaker, Text: text})
	}
	return blocks
}

func wrapTranscriptPDFLine(value string, width int) []string {
	words := strings.Fields(value)
	if len(words) == 0 {
		return []string{""}
	}
	lines := []string{""}
	for _, word := range words {
		current := lines[len(lines)-1]
		currentWidth := len([]rune(current))
		wordWidth := len([]rune(word))
		if current == "" {
			lines[len(lines)-1] = word
		} else if currentWidth+1+wordWidth <= width {
			lines[len(lines)-1] = current + " " + word
		} else {
			lines = append(lines, word)
		}
	}
	return lines
}

func renderTranscriptPDF(title string, pages []transcriptPDFPage) []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
	}
	pageRefs := make([]int, 0, len(pages))
	for pageNumber, page := range pages {
		var content strings.Builder
		content.WriteString("0.86 0.86 0.86 RG\n0.6 w\n54 712 m 558 712 l S\n")
		if pageNumber == 0 {
			appendTranscriptPDFText(&content, transcriptPDFTextLine{Text: title, X: transcriptPDFLeftMargin, Y: 752, Font: "F2", Size: 18, Color: "0.12 0.11 0.10"})
			appendTranscriptPDFText(&content, transcriptPDFTextLine{Text: "Transcript", X: transcriptPDFLeftMargin, Y: 733, Font: "F1", Size: 9, Color: "0.42 0.40 0.39"})
		} else {
			appendTranscriptPDFText(&content, transcriptPDFTextLine{Text: title, X: transcriptPDFLeftMargin, Y: 750, Font: "F2", Size: 11, Color: "0.20 0.18 0.17"})
			appendTranscriptPDFText(&content, transcriptPDFTextLine{Text: "Transcript", X: transcriptPDFRightMargin - 54, Y: 750, Font: "F1", Size: 8.5, Color: "0.48 0.46 0.45"})
		}
		for _, line := range page.Lines {
			appendTranscriptPDFText(&content, line)
		}
		content.WriteString("0.88 0.88 0.88 RG\n0.5 w\n54 43 m 558 43 l S\n")
		appendTranscriptPDFText(&content, transcriptPDFTextLine{Text: title + " · Transcript", X: transcriptPDFLeftMargin, Y: 28, Font: "F1", Size: 8, Color: "0.48 0.46 0.45"})
		appendTranscriptPDFText(&content, transcriptPDFTextLine{Text: fmt.Sprintf("Page %d of %d", pageNumber+1, len(pages)), X: 486, Y: 28, Font: "F1", Size: 8, Color: "0.48 0.46 0.45"})

		contentObject := fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content.String()), content.String())
		objects = append(objects, contentObject)
		contentIndex := len(objects)
		pageObject := fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>", transcriptPDFPageWidth, transcriptPDFPageHeight, contentIndex)
		objects = append(objects, pageObject)
		pageRefs = append(pageRefs, len(objects))
	}
	kids := make([]string, 0, len(pageRefs))
	for _, ref := range pageRefs {
		kids = append(kids, fmt.Sprintf("%d 0 R", ref))
	}
	objects[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pageRefs))
	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xrefOffset := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for index := 1; index < len(offsets); index++ {
		fmt.Fprintf(&output, "%010d 00000 n \n", offsets[index])
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xrefOffset)
	return output.Bytes()
}

func appendTranscriptPDFText(content *strings.Builder, line transcriptPDFTextLine) {
	fmt.Fprintf(content, "BT\n/%s %.2f Tf\n%s rg\n%.2f %.2f Td\n(%s) Tj\nET\n", line.Font, line.Size, line.Color, line.X, line.Y, pdfTextLiteral(line.Text))
}

func pdfTextLiteral(value string) string {
	encoded, _, err := transform.String(charmap.Windows1252.NewEncoder(), value)
	if err != nil {
		encoded = value
	}
	var output strings.Builder
	for _, character := range []byte(encoded) {
		switch character {
		case '\\', '(', ')':
			output.WriteByte('\\')
			output.WriteByte(character)
		case '\n', '\r':
			output.WriteByte(' ')
		default:
			output.WriteByte(character)
		}
	}
	return output.String()
}

func decodeTranscriptionInsightOutput(value string) (transcriptionInsightResponse, error) {
	start := strings.Index(value, "{")
	end := strings.LastIndex(value, "}")
	if start < 0 || end <= start {
		return transcriptionInsightResponse{}, fmt.Errorf("insight endpoint returned invalid JSON")
	}
	var result transcriptionInsightResponse
	if err := json.Unmarshal([]byte(value[start:end+1]), &result); err != nil {
		return transcriptionInsightResponse{}, fmt.Errorf("insight endpoint returned invalid JSON: %w", err)
	}
	if strings.TrimSpace(result.Summary) == "" && len(result.Chapters) == 0 && len(result.Topics) == 0 && len(result.ActionItems) == 0 {
		return transcriptionInsightResponse{}, fmt.Errorf("insight endpoint returned no usable insights")
	}
	if result.Chapters == nil {
		result.Chapters = []models.TranscriptionInsightChapter{}
	}
	if result.Topics == nil {
		result.Topics = []string{}
	}
	if result.ActionItems == nil {
		result.ActionItems = []string{}
	}
	return result, nil
}
