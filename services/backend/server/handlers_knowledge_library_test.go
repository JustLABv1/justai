package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func knowledgeListTestContext(query string) *gin.Context {
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/v1/knowledge/items?"+query, nil)
	return context
}

func TestParseKnowledgeItemListOptions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	context := knowledgeListTestContext("limit=200&cursor=100&type=all&status=READY&q=%20deployment%20&ownership=personal&spaceId=personal&sort=title")
	options, err := parseKnowledgeItemListOptions(context)
	if err != nil {
		t.Fatalf("parse options: %v", err)
	}
	if options.limit != 100 || options.offset != 100 {
		t.Fatalf("unexpected pagination options: %+v", options)
	}
	if options.query != "deployment" || options.resourceType != "" || options.status != "ready" {
		t.Fatalf("unexpected filters: %+v", options)
	}
	if options.ownership != "private" || !options.personal || options.sort != "title" {
		t.Fatalf("unexpected ownership/space/sort options: %+v", options)
	}
}

func TestParseKnowledgeItemListOptionsTreatsAllStatusAsUnfiltered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	options, err := parseKnowledgeItemListOptions(knowledgeListTestContext("status=all"))
	if err != nil {
		t.Fatalf("parse all status: %v", err)
	}
	if options.status != "" {
		t.Fatalf("expected an empty status filter, got %q", options.status)
	}
}

func TestParseKnowledgeItemListOptionsAliases(t *testing.T) {
	gin.SetMode(gin.TestMode)
	spaceID := uuid.New()
	context := knowledgeListTestContext("owner=shared&spaceId=" + spaceID.String() + "&sortBy=resource_type")
	options, err := parseKnowledgeItemListOptions(context)
	if err != nil {
		t.Fatalf("parse aliases: %v", err)
	}
	if options.ownership != "workspace" || options.spaceID != spaceID || options.sort != "type" {
		t.Fatalf("unexpected aliased options: %+v", options)
	}
}

func TestParseKnowledgeItemListOptionsRejectsInvalidValues(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name  string
		query string
		code  string
	}{
		{name: "limit", query: "limit=abc", code: "invalid_limit"},
		{name: "cursor", query: "cursor=-1", code: "invalid_cursor"},
		{name: "type", query: "type=unknown", code: "invalid_type"},
		{name: "ownership", query: "ownership=team", code: "invalid_ownership"},
		{name: "space", query: "spaceId=unknown", code: "invalid_space_id"},
		{name: "sort", query: "sort=created", code: "invalid_sort"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseKnowledgeItemListOptions(knowledgeListTestContext(test.query))
			if err == nil {
				t.Fatal("expected an error")
			}
			public, ok := err.(PublicError)
			if !ok || public.Code != test.code {
				t.Fatalf("expected %s, got %T %v", test.code, err, err)
			}
		})
	}
}

func TestKnowledgeItemsWhereUsesStablePlaceholdersAndHidesRepositoryFiles(t *testing.T) {
	organizationID := uuid.New()
	userID := uuid.New()
	spaceID := uuid.New()
	where, args := knowledgeItemsWhere(knowledgeItemListOptions{
		resourceType: "source",
		status:       "ready",
		query:        "runbook",
		ownership:    "workspace",
		spaceID:      spaceID,
	}, organizationID, userID)
	if len(args) != 7 {
		t.Fatalf("expected seven query args, got %d (%v)", len(args), args)
	}
	for _, fragment := range []string{
		"ki.organization_id = $1",
		"ki.owner_id = $2",
		"hidden_repo_file.source_id = ki.resource_id",
		"ki.resource_type = $3",
		"ki.status = $4",
		"ki.title ILIKE $5",
		"ki.visibility = $6",
		"filter_space.id = $7",
	} {
		if !strings.Contains(where, fragment) {
			t.Errorf("where clause is missing %q: %s", fragment, where)
		}
	}
}

func TestKnowledgeItemsOrderBy(t *testing.T) {
	tests := map[string]string{
		"updated": "ki.updated_at DESC, ki.id DESC",
		"title":   "lower(ki.title) ASC, ki.id ASC",
		"type":    "ki.resource_type ASC, lower(ki.title) ASC, ki.id ASC",
	}
	for sortBy, expected := range tests {
		if got := knowledgeItemsOrderBy(sortBy); got != expected {
			t.Errorf("sort %q: expected %q, got %q", sortBy, expected, got)
		}
	}
}
