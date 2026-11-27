package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/middleware"
	"justai-backend/security"
)

// fakeMeetingBotService imitates services/meeting-bot's HTTP API.
type fakeMeetingBotService struct {
	mu       sync.Mutex
	started  []map[string]string
	stopped  []string
	statuses []string // returned one after another by GET, the last one repeats
	reason   string   // reported with a final status
	gone     bool     // GET answers 404, as after a service restart
}

func (f *fakeMeetingBotService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer bot-service-token-0123" {
		http.Error(w, `{"error":"invalid service token"}`, http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/bots":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.started = append(f.started, body)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"starting"}`))
	case r.Method == http.MethodDelete:
		f.stopped = append(f.stopped, strings.TrimPrefix(r.URL.Path, "/v1/bots/"))
		f.statuses, f.reason = []string{"ended"}, "stop requested"
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"in_call"}`))
	case r.Method == http.MethodGet:
		if f.gone {
			http.Error(w, `{"error":"no bot for this source"}`, http.StatusNotFound)
			return
		}
		status := f.statuses[0]
		if len(f.statuses) > 1 {
			f.statuses = f.statuses[1:]
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": status, "reason": f.reason})
	}
}

func TestMeetingBotJoinsAndLeavesWithItsSourceIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	previous := meetingBotPollEvery
	meetingBotPollEvery = 50 * time.Millisecond
	t.Cleanup(func() { meetingBotPollEvery = previous })

	service := &fakeMeetingBotService{statuses: []string{"connecting", "joining", "in_call"}}
	server := httptest.NewServer(service)
	defer server.Close()
	a := &App{DB: db, Secrets: security.NewSecretBox(bytes.Repeat([]byte{5}, 32)), Config: config.Config{MeetingBot: config.MeetingBotConfig{URL: server.URL, Token: "bot-service-token-0123"}}}
	a.Live = &TranscriptionManager{DB: db, app: a}

	userID, orgID, sessionID := uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []string{
		`INSERT INTO users (id, email, display_name) VALUES ('` + userID.String() + `', 'ada@example.com', 'Ada')`,
		`INSERT INTO organizations (id, name, slug) VALUES ('` + orgID.String() + `', 'Lab', 'lab')`,
		`INSERT INTO transcription_sessions (id, user_id, organization_id, title, status) VALUES ('` + sessionID.String() + `', '` + userID.String() + `', '` + orgID.String() + `', 'Besprechung', 'waiting')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	call := func(handler gin.HandlerFunc, param string, body any) *httptest.ResponseRecorder {
		encoded, _ := json.Marshal(body)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(encoded))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = gin.Params{{Key: "id", Value: param}}
		c.Set(middleware.PrincipalKey, middleware.Principal{UserID: userID})
		c.Set(middleware.OrgIDKey, orgID)
		handler(c)
		c.Writer.WriteHeaderNow() // a body-less status is otherwise only written by the router
		return recorder
	}
	// An IP literal keeps the URL check from needing DNS; nothing contacts it.
	meeting := "https://1.1.1.1/meeting/123456?secret=abc"

	for name, body := range map[string]map[string]any{
		"wrong platform": {"platform": "zoom", "meetingUrl": meeting, "join": true},
		"no link":        {"platform": "cisco-meeting-server", "join": true},
	} {
		if recorder := call(a.createTranscriptionBotSource, sessionID.String(), body); recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d %s", name, recorder.Code, recorder.Body)
		}
	}

	recorder := call(a.createTranscriptionBotSource, sessionID.String(), map[string]any{
		"name": "BDBOS", "platform": "cisco-meeting-server", "meetingUrl": meeting, "join": true, "meetingId": "123456", "passcode": "7890",
	})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", recorder.Code, recorder.Body)
	}
	var created struct {
		Source  struct{ ID uuid.UUID }  `json:"source"`
		Token   string                  `json:"token"`
		BotJoin struct{ Status string } `json:"botJoin"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &created)
	if created.BotJoin.Status != "starting" {
		t.Fatalf("botJoin = %+v", created.BotJoin)
	}
	service.mu.Lock()
	launched := service.started[0]
	service.mu.Unlock()
	if launched["sourceId"] != created.Source.ID.String() || launched["token"] != created.Token || launched["meetingUrl"] != meeting ||
		launched["meetingId"] != "123456" || launched["passcode"] != "7890" || launched["platform"] != "cisco-meeting-server" {
		t.Fatalf("launch request = %v", launched)
	}
	var passcodeStored bool
	if err := db.QueryRowContext(ctx, `SELECT position('7890' in encode(meeting_url_ciphertext, 'escape')) > 0 FROM transcription_bot_sources WHERE source_id = $1`, created.Source.ID).Scan(&passcodeStored); err != nil || passcodeStored {
		t.Fatalf("the passcode must not be stored: %v %v", passcodeStored, err)
	}

	joinStatus := func() string {
		var status string
		_ = db.QueryRowContext(ctx, `SELECT join_status FROM transcription_bot_sources WHERE source_id = $1`, created.Source.ID).Scan(&status)
		return status
	}
	waitFor := func(want string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for joinStatus() != want {
			if time.Now().After(deadline) {
				t.Fatalf("join status stayed %q, want %q", joinStatus(), want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitFor("in_call")
	sources, err := loadTranscriptionSources(ctx, db, sessionID)
	if err != nil || len(sources) != 1 || sources[0].BotJoinStatus != "in_call" {
		t.Fatalf("snapshot sources = %+v, %v", sources, err)
	}

	if recorder := call(a.stopTranscriptionBotSource, created.Source.ID.String(), nil); recorder.Code != http.StatusNoContent {
		t.Fatalf("stop: %d %s", recorder.Code, recorder.Body)
	}
	waitFor("ended")
	service.mu.Lock()
	stopped := append([]string(nil), service.stopped...)
	service.mu.Unlock()
	if len(stopped) != 1 || stopped[0] != created.Source.ID.String() {
		t.Fatalf("stopped = %v", stopped)
	}

	// A bot the service no longer knows (it restarted) is reported as failed.
	service.mu.Lock()
	service.statuses, service.gone = []string{"joining"}, false
	service.mu.Unlock()
	recorder = call(a.createTranscriptionBotSource, sessionID.String(), map[string]any{"name": "Second", "platform": "generic", "meetingUrl": meeting, "join": true})
	_ = json.Unmarshal(recorder.Body.Bytes(), &created)
	waitFor("joining")
	service.mu.Lock()
	service.gone = true
	service.mu.Unlock()
	waitFor("failed")

	// Without a configured service, joining is refused and the UI is told so.
	configured := a.Config.MeetingBot
	a.Config.MeetingBot = config.MeetingBotConfig{}
	if recorder := call(a.createTranscriptionBotSource, sessionID.String(), map[string]any{"platform": "generic", "meetingUrl": meeting, "join": true}); recorder.Code != http.StatusBadRequest {
		t.Fatalf("join without a service: %d", recorder.Code)
	}
	availability := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(availability)
	a.meetingBotAvailability(c)
	if !strings.Contains(availability.Body.String(), `"available":false`) {
		t.Fatalf("availability = %s", availability.Body)
	}
	a.Config.MeetingBot = configured

	// Stopped by the user, the session stayed live.
	var sessionStatus string
	_ = db.QueryRowContext(ctx, `SELECT status FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&sessionStatus)
	if sessionStatus != "live" {
		t.Fatalf("a stopped bot must not end the session: %s", sessionStatus)
	}

	// A bot that leaves because the meeting is over ends the session when it was the
	// last source still capturing (the others were stopped or failed above).
	service.mu.Lock()
	service.statuses, service.gone, service.reason = []string{"in_call"}, false, ""
	service.mu.Unlock()
	recorder = call(a.createTranscriptionBotSource, sessionID.String(), map[string]any{"name": "Third", "platform": "cisco-meeting-server", "meetingUrl": meeting, "join": true})
	_ = json.Unmarshal(recorder.Body.Bytes(), &created)
	waitFor("in_call")
	if _, err := db.ExecContext(ctx, `UPDATE transcription_sources SET status = 'stopped' WHERE session_id = $1 AND id <> $2`, sessionID, created.Source.ID); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	service.statuses, service.reason = []string{"ended"}, "no other participant for a while"
	service.mu.Unlock()
	waitFor("ended")
	deadline := time.Now().Add(5 * time.Second)
	for sessionStatus != "completed" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		_ = db.QueryRowContext(ctx, `SELECT status FROM transcription_sessions WHERE id = $1`, sessionID).Scan(&sessionStatus)
	}
	var sourceStatus, botStatus string
	_ = db.QueryRowContext(ctx, `SELECT source.status, bot.status FROM transcription_sources source JOIN transcription_bot_sources bot ON bot.source_id = source.id WHERE source.id = $1`, created.Source.ID).Scan(&sourceStatus, &botStatus)
	if sessionStatus != "completed" || sourceStatus != "stopped" || botStatus != "stopped" {
		t.Fatalf("after the meeting: session %s, source %s, bot %s", sessionStatus, sourceStatus, botStatus)
	}
}
