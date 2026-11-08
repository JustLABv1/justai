package server

import (
	"encoding/json"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestLiveLibraryFiltersAndScopesProcessingFailures(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, org, id := uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	scope := `(?s)WITH recordings AS .*s.user_id=\$1 AND s.organization_id=\$2 AND s.archived_at IS NULL.*NOT EXISTS.*transcription_video_uploads.*`
	mock.ExpectQuery(scope+`SELECT COUNT\(\*\)`).WithArgs(user, org, "%debate%").WillReturnRows(sqlmock.NewRows([]string{"all", "pending", "completed", "failed", "open", "done"}).AddRow(20, 2, 15, 3, 18, 2))
	mock.ExpectQuery(scope+`SELECT id,title,state,stage.*AND state='failed'.*ORDER BY created_at DESC,id DESC LIMIT \$4 OFFSET \$5`).WithArgs(user, org, "%debate%", 12, 0).WillReturnRows(sqlmock.NewRows([]string{"id", "title", "state", "stage", "language", "duration", "summary", "created", "updated", "done_at"}).AddRow(id, "Debate", "failed", "diarization", "de", 240000, true, now, now, nil))
	c, w := videoLibraryTestContext("/?status=failed&query=debate&page=99", user, org)
	(&App{DB: db}).listLiveTranscriptionLibrary(c)
	var response struct {
		Items       []videoTranscriptionLibraryItem
		Total, Page int
		Counts      map[string]int
	}
	if err = json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || response.Total != 3 || response.Page != 1 || len(response.Items) != 1 || response.Items[0].Status != "failed" || response.Items[0].Stage != "diarization" || response.Counts["pending"] != 2 {
		t.Fatalf("unexpected response: %d %s", w.Code, w.Body.String())
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
func TestLiveLibraryRejectsInvalidFilters(t *testing.T) {
	for _, url := range []string{"/?status=cancelled", "/?status=invalid", "/?page=0"} {
		c, w := videoLibraryTestContext(url, uuid.New(), uuid.New())
		(&App{}).listLiveTranscriptionLibrary(c)
		if w.Code != 400 {
			t.Fatalf("accepted %s: %d", url, w.Code)
		}
	}
}
