package server

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

type videoTranscriptionLibraryItem struct {
	ID           uuid.UUID `json:"id"`
	ThumbnailURL string    `json:"thumbnailUrl,omitempty"`
	Title        string    `json:"title"`
	FileName     string    `json:"fileName"`
	Status       string    `json:"status"`
	Stage        string    `json:"stage"`
	Language     string    `json:"language"`
	DurationMs   int64     `json:"durationMs"`
	HasSummary   bool      `json:"hasSummary"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func videoLibraryPageValues(c *gin.Context) (int, int, error) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		return 0, 0, fmt.Errorf("invalid page")
	}
	size, err := strconv.Atoi(c.DefaultQuery("pageSize", "12"))
	if err != nil || size < 1 || size > 48 {
		return 0, 0, fmt.Errorf("page size must be between 1 and 48")
	}
	return page, size, nil
}

func literalVideoLibraryPattern(query string) string {
	if query == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query) + "%"
}

func (a *App) listVideoTranscriptionLibrary(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	page, pageSize, err := videoLibraryPageValues(c)
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
	conditions := map[string]string{"all": "", "pending": " AND video.status IN ('uploading','uploaded','queued','processing')", "completed": " AND video.status='completed'", "failed": " AND video.status='failed'", "cancelled": " AND video.status='cancelled'"}
	condition, valid := conditions[filter]
	if !valid {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid status filter"))
		return
	}
	pattern := literalVideoLibraryPattern(query)
	// Match the sidebar's ownership and archive policy. Joining only the latest upload
	// keeps multiple upload attempts from duplicating a session in the library.
	from := ` FROM transcription_sessions s
 JOIN LATERAL (SELECT id,file_name,status,stage,duration_ms,expected_bytes,bytes,expires_at FROM transcription_video_uploads WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) video ON TRUE
 WHERE s.user_id=$1 AND s.organization_id=$2 AND s.archived_at IS NULL
 AND ($3='' OR s.title ILIKE $3 OR video.file_name ILIKE $3)`
	var all, pending, completed, failed, cancelled int
	if err = a.DB.QueryRowContext(c, `SELECT COUNT(*), COUNT(*) FILTER (WHERE video.status IN ('uploading','uploaded','queued','processing')), COUNT(*) FILTER (WHERE video.status='completed'), COUNT(*) FILTER (WHERE video.status='failed'), COUNT(*) FILTER (WHERE video.status='cancelled')`+from, principal.UserID, organizationID, pattern).Scan(&all, &pending, &completed, &failed, &cancelled); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	counts := map[string]int{"all": all, "pending": pending, "completed": completed, "failed": failed, "cancelled": cancelled}
	total := counts[filter]
	pageCount := max(1, (total+pageSize-1)/pageSize)
	page = min(page, pageCount)
	items := make([]videoTranscriptionLibraryItem, 0)
	if total > 0 {
		rows, queryErr := a.DB.QueryContext(c, `SELECT s.id,s.title,video.file_name,video.status,s.language,video.duration_ms,
 EXISTS(SELECT 1 FROM transcription_insights insights WHERE insights.session_id=s.id AND insights.status='completed'),s.created_at,s.updated_at,video.stage,
 CASE WHEN video.duration_ms>0 AND video.expected_bytes>0 AND video.bytes>=video.expected_bytes AND video.status<>'uploading' AND (video.expires_at IS NULL OR video.expires_at>now()) THEN video.id::text ELSE '' END`+from+condition+` ORDER BY s.created_at DESC,s.id DESC LIMIT $4 OFFSET $5`, principal.UserID, organizationID, pattern, pageSize, (page-1)*pageSize)
		if queryErr != nil {
			writeError(c, http.StatusInternalServerError, queryErr)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var item videoTranscriptionLibraryItem
			var thumbnailUploadID string
			if err = rows.Scan(&item.ID, &item.Title, &item.FileName, &item.Status, &item.Language, &item.DurationMs, &item.HasSummary, &item.CreatedAt, &item.UpdatedAt, &item.Stage, &thumbnailUploadID); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			if thumbnailUploadID != "" {
				item.ThumbnailURL = "/api/v1/transcription/video-uploads/" + thumbnailUploadID + "/thumbnail"
			}
			items = append(items, item)
		}
		if err = rows.Err(); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total, "page": page, "pageSize": pageSize, "counts": counts})
}
