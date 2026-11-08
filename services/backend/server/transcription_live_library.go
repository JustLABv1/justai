package server

import (
	"fmt"
	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
	"net/http"
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
	// Processing can continue after capture has ended; expose its state rather than
	// calling an unfinished or failed final transcript ready.
	base := ` WITH recordings AS (
 SELECT s.*, CASE WHEN s.status='completed' AND p.status='failed' THEN 'failed'
 WHEN s.status='completed' AND p.status IN ('queued','processing') THEN 'processing'
 ELSE s.status END state, COALESCE(p.stage,'') stage
 FROM transcription_sessions s LEFT JOIN transcription_live_processing p ON p.session_id=s.id
 WHERE s.user_id=$1 AND s.organization_id=$2 AND s.archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM transcription_video_uploads v WHERE v.session_id=s.id)
 AND ($3='' OR s.title ILIKE $3)) `
	pattern := literalVideoLibraryPattern(query)
	var all, pending, completed, failed, open, done int
	err = a.DB.QueryRowContext(c, base+`SELECT COUNT(*),COUNT(*) FILTER(WHERE state IN ('waiting','live','paused','processing')),COUNT(*) FILTER(WHERE state='completed'),COUNT(*) FILTER(WHERE state='failed'),COUNT(*) FILTER(WHERE done_at IS NULL),COUNT(*) FILTER(WHERE done_at IS NOT NULL) FROM recordings`, principal.UserID, org, pattern).Scan(&all, &pending, &completed, &failed, &open, &done)
	if err != nil {
		writeError(c, 500, err)
		return
	}
	counts := map[string]int{"all": all, "pending": pending, "completed": completed, "failed": failed, "cancelled": 0, "open": open, "done": done}
	total := counts[filter]
	page = min(page, max(1, (total+size-1)/size))
	items := make([]videoTranscriptionLibraryItem, 0)
	if total > 0 {
		rows, e := a.DB.QueryContext(c, base+`SELECT id,title,state,stage,language,
 CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL THEN GREATEST(0,EXTRACT(EPOCH FROM (ended_at-started_at))*1000)::bigint ELSE 0 END,
 EXISTS(SELECT 1 FROM transcription_insights i WHERE i.session_id=recordings.id AND i.status='completed'),created_at,updated_at,done_at
 FROM recordings WHERE TRUE`+condition+` ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`, principal.UserID, org, pattern, size, (page-1)*size)
		if e != nil {
			writeError(c, 500, e)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var item videoTranscriptionLibraryItem
			if e = rows.Scan(&item.ID, &item.Title, &item.Status, &item.Stage, &item.Language, &item.DurationMs, &item.HasSummary, &item.CreatedAt, &item.UpdatedAt, &item.DoneAt); e != nil {
				writeError(c, 500, e)
				return
			}
			items = append(items, item)
		}
		if e = rows.Err(); e != nil {
			writeError(c, 500, e)
			return
		}
	}
	c.JSON(200, gin.H{"items": items, "total": total, "page": page, "pageSize": size, "counts": counts})
}
