package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

func TestUsagePeriodIsTheCalendarMonthInUTC(t *testing.T) {
	start, end := usagePeriod(time.Date(2026, time.December, 31, 23, 30, 0, 0, time.UTC))
	if !start.Equal(time.Date(2026, time.December, 1, 0, 0, 0, 0, time.UTC)) || !end.Equal(time.Date(2027, time.January, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("period = %s to %s", start, end)
	}
}

func TestUsageLimitReached(t *testing.T) {
	limit := int64(100)
	cases := []struct {
		used  int64
		limit *int64
		want  bool
	}{{99, &limit, false}, {100, &limit, true}, {500, nil, false}}
	for _, tc := range cases {
		if got := (usageSummary{TotalTokens: tc.used, MonthlyTokenLimit: tc.limit}).usageLimitReached(); got != tc.want {
			t.Fatalf("used %d limit %v: got %v", tc.used, tc.limit, got)
		}
	}
}

func TestMemberUsageLimitModes(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	orgID, userID, adminID := uuid.New(), uuid.New(), uuid.New()
	run := func(body string) int {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Params = gin.Params{{Key: "id", Value: orgID.String()}, {Key: "userId", Value: userID.String()}}
		c.Request = httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: adminID})
		c.Set(middleware.OrgIDKey, orgID)
		(&App{DB: db}).putMemberUsageLimit(c)
		return recorder.Code
	}
	mock.ExpectExec("DELETE FROM organization_member_usage_limits").WithArgs(orgID, userID).WillReturnResult(sqlmock.NewResult(0, 1))
	if code := run(`{"mode":"inherit"}`); code != http.StatusOK {
		t.Fatalf("inherit: %d", code)
	}
	mock.ExpectQuery("SELECT EXISTS").WithArgs(orgID, userID).WillReturnRows(sqlmock.NewRows([]string{"e"}).AddRow(true))
	mock.ExpectExec("INSERT INTO organization_member_usage_limits").WithArgs(orgID, userID, int64(5000), adminID).WillReturnResult(sqlmock.NewResult(0, 1))
	if code := run(`{"mode":"limit","monthlyTokenLimit":5000}`); code != http.StatusOK {
		t.Fatalf("limit: %d", code)
	}
	if code := run(`{"mode":"limit"}`); code != http.StatusBadRequest {
		t.Fatalf("limit without a value: %d", code)
	}
	if code := run(`{"mode":"nonsense"}`); code != http.StatusBadRequest {
		t.Fatalf("unknown mode: %d", code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestZeroLimitMeansNoLimit(t *testing.T) {
	if positiveLimit(sql.NullInt64{Valid: true, Int64: 0}) != nil || positiveLimit(sql.NullInt64{}) != nil {
		t.Fatal("zero or empty must not limit anyone")
	}
	if got := positiveLimit(sql.NullInt64{Valid: true, Int64: 5}); got == nil || *got != 5 {
		t.Fatalf("limit = %v", got)
	}
}

func TestUsageHistoryFillsEmptyDays(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	orgID, userID := uuid.New(), uuid.New()
	today := time.Now().UTC().Format("2006-01-02")
	mock.ExpectQuery("FROM chat_runs").WillReturnRows(sqlmock.NewRows([]string{"d", "i", "o", "t", "n"}).AddRow(today, 10, 5, 15, 2))
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
	c.Set(middleware.OrgIDKey, orgID)
	(&App{DB: db}).getMyUsageHistory(c)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d", recorder.Code)
	}
	var body struct {
		Days []usageDay `json:"days"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Days) != usageHistoryDays || body.Days[usageHistoryDays-1].TotalTokens != 15 || body.Days[0].TotalTokens != 0 {
		t.Fatalf("days = %+v", body.Days)
	}
}
