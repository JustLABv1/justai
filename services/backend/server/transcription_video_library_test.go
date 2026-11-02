package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

func videoLibraryTestContext(path string, user, organization uuid.UUID) (*gin.Context, *httptest.ResponseRecorder) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", path, nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: user})
	c.Set(middleware.OrgIDKey, organization)
	return c, w
}

func TestVideoLibraryPaginationUsesCurrentUserAndWorkspace(t *testing.T) {
	for _, test := range []struct {
		name, url           string
		total, page, offset int
	}{
		{"second page", "/?page=2&pageSize=12&query=Budget", 25, 2, 12},
		{"out of range is clamped", "/?page=9223372036854775807&pageSize=12&query=Budget", 25, 3, 24},
	} {
		t.Run(test.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			user, organization, id := uuid.New(), uuid.New(), uuid.New()
			now := time.Now().UTC()
			// Both queries must carry ownership, tenant and archive restrictions; only the
			// latest upload can contribute a card, and the order has a stable ID tie-breaker.
			scope := `(?s)FROM transcription_sessions s.*JOIN LATERAL.*WHERE s.user_id=\$1 AND s.organization_id=\$2 AND s.archived_at IS NULL`
			mock.ExpectQuery(`SELECT COUNT\(\*\)`+`.*`+scope).WithArgs(user, organization, "%Budget%").WillReturnRows(sqlmock.NewRows([]string{"total", "pending", "completed", "failed", "cancelled"}).AddRow(test.total, 0, test.total, 0, 0))
			mock.ExpectQuery(`(?s)SELECT s.id,s.title,video.file_name.*`+scope+`.*ORDER BY s.created_at DESC,s.id DESC LIMIT \$4 OFFSET \$5`).WithArgs(user, organization, "%Budget%", 12, test.offset).WillReturnRows(sqlmock.NewRows([]string{"id", "title", "file_name", "status", "language", "duration_ms", "has_summary", "created_at", "updated_at", "stage", "thumbnail_upload_id"}).AddRow(id, "Budget debate", "budget.mp4", "completed", "de", 240000, true, now, now, "completed", id.String()))
			c, w := videoLibraryTestContext(test.url, user, organization)
			(&App{DB: db}).listVideoTranscriptionLibrary(c)
			if w.Code != 200 {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			var response struct {
				Items    []videoTranscriptionLibraryItem `json:"items"`
				Total    int                             `json:"total"`
				Page     int                             `json:"page"`
				PageSize int                             `json:"pageSize"`
			}
			if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Total != 25 || response.Page != test.page || response.PageSize != 12 || len(response.Items) != 1 || response.Items[0].ID != id || !response.Items[0].HasSummary {
				t.Fatalf("unexpected page: %+v", response)
			}
			if err = mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestVideoLibraryEmptyResultIsAnEmptyPage(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org := uuid.New(), uuid.New()
	mock.ExpectQuery(`SELECT COUNT\(\*\)`).WithArgs(user, org, "").WillReturnRows(sqlmock.NewRows([]string{"total", "pending", "completed", "failed", "cancelled"}).AddRow(0, 0, 0, 0, 0))
	c, w := videoLibraryTestContext("/?page=20", user, org)
	(&App{DB: db}).listVideoTranscriptionLibrary(c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"items":[]`) || !strings.Contains(w.Body.String(), `"page":1`) {
		t.Fatalf("unexpected empty page: %d %s", w.Code, w.Body.String())
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestVideoLibraryRejectsInvalidPaginationAndOversizedSearch(t *testing.T) {
	for _, url := range []string{"/?status=invalid", "/?page=0", "/?page=-2", "/?page=no", "/?pageSize=0", "/?pageSize=49", "/?pageSize=no", "/?query=" + strings.Repeat("a", 201)} {
		c, w := videoLibraryTestContext(url, uuid.New(), uuid.New())
		(&App{}).listVideoTranscriptionLibrary(c)
		if w.Code != 400 {
			t.Fatalf("accepted invalid URL %q: %d", url, w.Code)
		}
	}
}

func TestVideoLibrarySearchTreatsWildcardsLiterally(t *testing.T) {
	if got := literalVideoLibraryPattern(`100%_budget\draft`); got != `%100\%\_budget\\draft%` {
		t.Fatalf("wildcards were not escaped: %q", got)
	}
}

func TestVideoLibraryFailedFilterUsesScopedCounts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, id := uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	mock.ExpectQuery(`SELECT COUNT\(\*\)`).WithArgs(user, org, "").WillReturnRows(sqlmock.NewRows([]string{"all", "pending", "completed", "failed", "cancelled"}).AddRow(20, 3, 12, 4, 1))
	mock.ExpectQuery(`(?s)SELECT s.id.*AND video.status='failed'.*LIMIT \$4 OFFSET \$5`).WithArgs(user, org, "", 12, 0).WillReturnRows(sqlmock.NewRows([]string{"id", "title", "file_name", "status", "language", "duration_ms", "has_summary", "created_at", "updated_at", "stage", "thumbnail_upload_id"}).AddRow(id, "Failed recording", "video.mp4", "failed", "de", 1000, false, now, now, "diarizing", ""))
	c, w := videoLibraryTestContext("/?status=failed", user, org)
	(&App{DB: db}).listVideoTranscriptionLibrary(c)
	var response struct {
		Total  int
		Counts map[string]int
		Items  []videoTranscriptionLibraryItem
	}
	if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || response.Total != 4 || response.Counts["pending"] != 3 || len(response.Items) != 1 || response.Items[0].Stage != "diarizing" {
		t.Fatalf("unexpected filtered response %d: %s", w.Code, w.Body.String())
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
