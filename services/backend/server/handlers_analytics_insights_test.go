package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

func insightContext(query string, admin bool) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/insights"+query, nil)
	c.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New(), PlatformAdmin: admin})
	return c, recorder
}

func TestAnalyticsInsightsRequiresPlatformAdmin(t *testing.T) {
	c, r := insightContext("", false)
	(&App{}).getPlatformAnalyticsInsights(c)
	if r.Code != http.StatusForbidden {
		t.Fatalf("status %d", r.Code)
	}
}

func TestAnalyticsInsightsValidatesFiltersBeforeQuery(t *testing.T) {
	for _, query := range []string{"?userId=bad", "?organizationId=bad", "?serverId=bad", "?category=unknown", "?outcome=unknown", "?days=999", "?from=2026-11-03&to=2026-11-01"} {
		t.Run(query, func(t *testing.T) {
			c, r := insightContext(query, true)
			(&App{}).getPlatformAnalyticsInsights(c)
			if r.Code != http.StatusBadRequest {
				t.Fatalf("status %d body %s", r.Code, r.Body.String())
			}
		})
	}
}

func TestAnalyticsInsightsBindsScopeAndReturnsEmptyPageTotal(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	org, user, server := uuid.New(), uuid.New(), uuid.New()
	payload := `{"summary":{"activeUsers":2,"mcpCalls":3},"daily":[],"users":[],"workspaces":[],"tools":[],"activity":{"items":[],"total":3}}`
	mock.ExpectQuery(regexp.QuoteMeta(analyticsInsightsSQL)).WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), org, user, "mcp", "failed", "calendar", server.String(), 25, 50, "YYYY-MM-DD").WillReturnRows(sqlmock.NewRows([]string{"jsonb_build_object"}).AddRow([]byte(payload)))
	c, r := insightContext("?organizationId="+org.String()+"&userId="+user.String()+"&serverId="+server.String()+"&category=mcp&outcome=failed&search=calendar&page=3&pageSize=25", true)
	(&App{DB: db}).getPlatformAnalyticsInsights(c)
	if r.Code != http.StatusOK {
		t.Fatalf("status %d: %s", r.Code, r.Body.String())
	}
	var result struct {
		Page     int
		PageSize int
		Activity struct {
			Total int
			Items []any
		}
		Period map[string]string
	}
	if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Page != 3 || result.PageSize != 25 || result.Activity.Total != 3 || len(result.Activity.Items) != 0 || result.Period["from"] == "" {
		t.Fatalf("unexpected result %+v", result)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAnalyticsBucketAndMinutesRange(t *testing.T) {
	for span, want := range map[time.Duration]string{5 * time.Minute: "minute", 2 * time.Hour: "minute", 5 * time.Hour: "hour", 72 * time.Hour: "hour", 73 * time.Hour: "day"} {
		if got, _ := analyticsBucket(span); got != want {
			t.Fatalf("span %s: got %s want %s", span, got, want)
		}
	}
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/?minutes=30&days=90", nil)
	start, end, err := analyticsRange(c)
	if d := end.Sub(start); err != nil || d < 29*time.Minute || d > 31*time.Minute {
		t.Fatalf("unexpected range %v %v %v", start, end, err)
	}
	c, _ = gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/?minutes=0", nil)
	if _, _, err := analyticsRange(c); err == nil {
		t.Fatal("expected error for minutes=0")
	}
}
