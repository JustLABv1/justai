package server

import (
	"fmt"
	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

func (a *App) listLiveTranscriptionLibrary(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	org, _ := middleware.GetOrganizationID(c)
	page, size, err := videoLibraryPageValues(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	query := strings.TrimSpace(c.Query("query"))
	if utf8.RuneCountInString(query) > 200 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("search is limited to 200 characters"))
		return
	}
	filter := c.DefaultQuery("status", "all")
	conditions := map[string]string{"all": "", "pending": " AND state IN ('waiting','live','paused','processing')", "completed": " AND state='completed'", "failed": " AND state='failed'", "open": " AND done_at IS NULL", "done": " AND done_at IS NOT NULL"}
	condition, ok := conditions[filter]
	if !ok {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid status filter"))
		return
	}
	// Meetings and livestreams differ a lot; the list can show either.
	sourceFilters := map[string]string{"all": "TRUE", "meetings": "source_kind<>'stream'", "streams": "source_kind='stream'"}
	sourceFilter, ok := sourceFilters[c.DefaultQuery("source", "all")]
	if !ok {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid source filter"))
		return
	}
	// Processing can continue after capture has ended; expose its state rather than
	// calling an unfinished or failed final transcript ready.
	base := ` WITH recordings AS (
 SELECT s.*, CASE WHEN s.status='completed' AND p.status='failed' THEN 'failed'
 WHEN s.status='completed' AND p.status IN ('queued','processing') THEN 'processing'
 ELSE s.status END state, COALESCE(p.stage,'') stage,
 COALESCE((SELECT src.kind FROM transcription_sources src WHERE src.session_id=s.id ORDER BY src.created_at LIMIT 1),'') source_kind
 FROM transcription_sessions s LEFT JOIN transcription_live_processing p ON p.session_id=s.id
 WHERE s.user_id=$1 AND s.organization_id=$2 AND s.archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM transcription_video_uploads v WHERE v.session_id=s.id)
 AND ($3='' OR s.title ILIKE $3)) `
	pattern := literalVideoLibraryPattern(query)
	var all, pending, completed, failed, open, done, meetings, streams int
	// Status counts follow the chosen source; the source counts follow the status.
	err = a.DB.QueryRowContext(c, base+`SELECT COUNT(*) FILTER(WHERE `+sourceFilter+`),
 COUNT(*) FILTER(WHERE `+sourceFilter+` AND state IN ('waiting','live','paused','processing')),COUNT(*) FILTER(WHERE `+sourceFilter+` AND state='completed'),
 COUNT(*) FILTER(WHERE `+sourceFilter+` AND state='failed'),COUNT(*) FILTER(WHERE `+sourceFilter+` AND done_at IS NULL),COUNT(*) FILTER(WHERE `+sourceFilter+` AND done_at IS NOT NULL),
 COUNT(*) FILTER(WHERE source_kind<>'stream'`+condition+`),COUNT(*) FILTER(WHERE source_kind='stream'`+condition+`) FROM recordings`, principal.UserID, org, pattern).Scan(&all, &pending, &completed, &failed, &open, &done, &meetings, &streams)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	counts := map[string]int{"all": all, "pending": pending, "completed": completed, "failed": failed, "cancelled": 0, "open": open, "done": done, "meetings": meetings, "streams": streams}
	total := counts[filter]
	page = min(page, max(1, (total+size-1)/size))
	items := make([]videoTranscriptionLibraryItem, 0)
	if total > 0 {
		rows, e := a.DB.QueryContext(c, base+`SELECT id,title,state,stage,language,
 CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL THEN GREATEST(0,EXTRACT(EPOCH FROM (ended_at-started_at))*1000)::bigint ELSE 0 END,
 EXISTS(SELECT 1 FROM transcription_insights i WHERE i.session_id=recordings.id AND i.status='completed'),created_at,updated_at,done_at,
 COALESCE(src.kind,''),COALESCE(src.name,''),COALESCE(src.stream_status,''),COALESCE(src.end_reason,''),COALESCE(src.outage_count,0),
 (SELECT MIN(st.scheduled_start_at) FROM transcription_stream_sources st JOIN transcription_sources ss ON ss.id=st.source_id WHERE ss.session_id=recordings.id AND st.status IN ('scheduled','watching')),
 (SELECT COUNT(*) FROM transcription_topics tp WHERE tp.session_id=recordings.id AND (st_scope.scope<>'topics' OR tp.starred)),
 (SELECT COUNT(*) FROM transcription_topics tp WHERE tp.session_id=recordings.id AND tp.status='done' AND tp.detected_by<>'missed' AND (st_scope.scope<>'topics' OR tp.starred)),
 COALESCE((SELECT i.summary FROM transcription_insights i WHERE i.session_id=recordings.id AND i.status='completed'),''),
 COALESCE((SELECT string_agg(first.line,' ' ORDER BY first.start_offset_ms) FROM (SELECT COALESCE(NULLIF(seg.edited_text,''),NULLIF(seg.polished_text,''),seg.text) line,seg.start_offset_ms
   FROM transcription_segments seg WHERE seg.session_id=recordings.id AND seg.canonical ORDER BY seg.start_offset_ms LIMIT 8) first),''),
 (SELECT COUNT(DISTINCT COALESCE(sp.merged_into,sp.id)) FROM transcription_segments seg JOIN transcription_speakers sp ON sp.id=seg.speaker_id WHERE seg.session_id=recordings.id AND seg.canonical)
 FROM recordings
 LEFT JOIN LATERAL (SELECT s2.kind,s2.name,st.status stream_status,st.end_reason,st.outage_count FROM transcription_sources s2 LEFT JOIN transcription_stream_sources st ON st.source_id=s2.id WHERE s2.session_id=recordings.id ORDER BY s2.created_at LIMIT 1) src ON TRUE
 LEFT JOIN LATERAL (SELECT COALESCE(MAX(st.capture_scope),'all') scope FROM transcription_stream_sources st JOIN transcription_sources ss ON ss.id=st.source_id WHERE ss.session_id=recordings.id) st_scope ON TRUE WHERE `+sourceFilter+condition+` ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`, principal.UserID, org, pattern, size, (page-1)*size)
		if e != nil {
			writeError(c, 500, e)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var item videoTranscriptionLibraryItem
			var summary, opening string
			if e = rows.Scan(&item.ID, &item.Title, &item.Status, &item.Stage, &item.Language, &item.DurationMs, &item.HasSummary, &item.CreatedAt, &item.UpdatedAt, &item.DoneAt, &item.SourceKind, &item.SourceName, &item.StreamStatus, &item.StreamEndReason, &item.OutageCount, &item.ScheduledStartAt, &item.TopicsTotal, &item.TopicsDone, &summary, &opening, &item.SpeakerCount); e != nil {
				writeError(c, 500, e)
				return
			}
			item.Excerpt = libraryExcerpt(summary, opening)
			items = append(items, item)
		}
		if e = rows.Err(); e != nil {
			writeError(c, 500, e)
			return
		}
	}
	c.JSON(200, gin.H{"items": items, "total": total, "page": page, "pageSize": size, "counts": counts})
}

var (
	libraryMarkdownPrefix = regexp.MustCompile(`^(?:[#>*+\-]+|\d+[.)])\s*`)
	libraryMarkdownMarks  = regexp.MustCompile(`\*\*|__|[*_` + "`" + `]`)
	libraryLabelOnly      = regexp.MustCompile(`^[^.!?]{0,40}:$`)
)

// libraryExcerptRunes bounds the line a list shows under a session's title.
const libraryExcerptRunes = 200

// libraryExcerpt is one line that says what a session was about: the first sentence
// of its summary (Markdown stripped, headings and bare labels skipped), otherwise
// the transcript's first words.
func libraryExcerpt(summary, opening string) string {
	for _, line := range strings.Split(summary, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "|") || strings.HasPrefix(line, "---") {
			continue
		}
		line = strings.TrimSpace(libraryMarkdownMarks.ReplaceAllString(libraryMarkdownPrefix.ReplaceAllString(line, ""), ""))
		if line == "" || libraryLabelOnly.MatchString(line) {
			continue
		}
		return clipExcerpt(line)
	}
	return clipExcerpt(strings.Join(strings.Fields(opening), " "))
}

func clipExcerpt(value string) string {
	if utf8.RuneCountInString(value) <= libraryExcerptRunes {
		return value
	}
	runes := []rune(value)[:libraryExcerptRunes]
	if cut := strings.LastIndex(string(runes), " "); cut > libraryExcerptRunes/2 {
		return strings.TrimRight(string(runes)[:cut], " ,;:") + "…"
	}
	return string(runes) + "…"
}
