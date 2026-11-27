package server

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
)

// Exports per agenda item: its summary and, on request, its transcript, as Markdown or
// PDF. The session export collects every finished item of a sitting in one document.

type topicExportLabels struct {
	Summary, Transcript, NoSummary, Planned, Running, Missed string
}

func topicExportText(language string) topicExportLabels {
	if strings.HasPrefix(strings.ToLower(language), "de") {
		return topicExportLabels{"Zusammenfassung", "Transkript", "Noch keine Zusammenfassung.", "geplant", "läuft noch", "nicht aufgenommen"}
	}
	return topicExportLabels{"Summary", "Transcript", "No summary yet.", "planned", "still running", "not recorded"}
}

// topicMarkdown writes one topic; level is the heading level of its title.
func topicMarkdown(b *strings.Builder, topic models.TranscriptionTopic, rows []transcriptionExportRow, withTranscript bool, level int, text topicExportLabels) {
	heading := strings.Repeat("#", level)
	title := topic.Title
	if topic.Label != "" {
		title = topic.Label + " – " + topic.Title
	}
	fmt.Fprintf(b, "%s %s\n\n", heading, title)
	if topic.PlannedStartAt != nil {
		berlin, _ := time.LoadLocation("Europe/Berlin")
		if berlin == nil {
			berlin = time.UTC
		}
		fmt.Fprintf(b, "_%s %s_", text.Planned, topic.PlannedStartAt.In(berlin).Format("02.01.2006 15:04"))
		switch {
		case topic.Status == "active":
			fmt.Fprintf(b, " · _%s_", text.Running)
		case topic.DetectedBy == "missed":
			fmt.Fprintf(b, " · _%s_", text.Missed)
		}
		b.WriteString("\n\n")
	}
	fmt.Fprintf(b, "%s# %s\n\n", heading, text.Summary)
	if summary := strings.TrimSpace(topic.Summary); summary != "" && topic.SummaryStatus == "completed" {
		b.WriteString(summary + "\n\n")
	} else {
		b.WriteString(text.NoSummary + "\n\n")
	}
	if !withTranscript || len(rows) == 0 {
		return
	}
	fmt.Fprintf(b, "%s# %s\n\n", heading, text.Transcript)
	for _, row := range rows {
		if speaker := strings.TrimSpace(row.Speaker); speaker != "" {
			fmt.Fprintf(b, "**[%s] %s:** %s\n\n", formatTranscriptTimestamp(row.StartOffsetMs), speaker, row.Text)
		} else {
			fmt.Fprintf(b, "**[%s]** %s\n\n", formatTranscriptTimestamp(row.StartOffsetMs), row.Text)
		}
	}
}

func exportFileName(raw string) string {
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '"' || r == ':' || r < 32 {
			return '-'
		}
		return r
	}, raw))
	if name == "" {
		return "export"
	}
	if len([]rune(name)) > 120 {
		name = string([]rune(name)[:120])
	}
	return name
}

func (a *App) writeTopicExport(c *gin.Context, format, title, markdown string) {
	name := exportFileName(title)
	switch format {
	case "md":
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.md"`, name))
		c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(markdown))
	case "pdf":
		data, err := renderGeneratedPDF(title, markdown)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pdf"`, name))
		c.Data(http.StatusOK, "application/pdf", data)
	default:
		writeError(c, http.StatusBadRequest, fmt.Errorf("export format must be md or pdf"))
	}
}

func (a *App) sessionLanguage(c *gin.Context, sessionID uuid.UUID) (title, language string) {
	_ = a.DB.QueryRowContext(c, `SELECT title, language FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&title, &language)
	return title, language
}

// exportTranscriptionTopic: GET /transcription/topics/:id/export/:format[?transcript=1]
func (a *App) exportTranscriptionTopic(c *gin.Context) {
	topic, ok := a.authorizeTopic(c)
	if !ok {
		return
	}
	withTranscript := c.Query("transcript") != ""
	var rows []transcriptionExportRow
	if withTranscript && topic.StartedOffsetMs != nil {
		var err error
		if rows, err = a.topicRows(c, topic); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	_, language := a.sessionLanguage(c, topic.SessionID)
	var b strings.Builder
	topicMarkdown(&b, topic, rows, withTranscript, 1, topicExportText(language))
	a.writeTopicExport(c, c.Param("format"), firstNonEmptyString(topic.Label, topic.Title), b.String())
}

// exportTranscriptionTopics: GET /transcription/sessions/:id/topics/export/:format
// collects the finished agenda items of a session (with "only selected topics", the
// selected ones).
func (a *App) exportTranscriptionTopics(c *gin.Context) {
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
	topics, err := loadTopics(c, a.DB, sessionID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	withTranscript := c.Query("transcript") != ""
	title, language := a.sessionLanguage(c, sessionID)
	text := topicExportText(language)
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", title)
	written := 0
	for _, topic := range topics {
		if topic.StartedOffsetMs == nil || topic.DetectedBy == "missed" || !topic.Recorded {
			continue
		}
		var rows []transcriptionExportRow
		if withTranscript {
			if rows, err = a.topicRows(c, topic); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
		}
		topicMarkdown(&b, topic, rows, withTranscript, 2, text)
		written++
	}
	if written == 0 {
		writeError(c, http.StatusConflict, fmt.Errorf("no agenda item has been recorded yet"))
		return
	}
	a.writeTopicExport(c, c.Param("format"), title, b.String())
}
