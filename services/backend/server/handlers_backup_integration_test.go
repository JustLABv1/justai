package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/config"
	"justai-backend/middleware"
)

func TestBackupRestoreHTTPFlowIntegration(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	source := backupTestDatabase(t, ctx)
	target := backupTestDatabase(t, ctx)
	if _, err := source.ExecContext(ctx, `INSERT INTO users (email, display_name, is_platform_admin) VALUES ('root@example.com', 'Root', true)`); err != nil {
		t.Fatal(err)
	}
	router := func(app *App, admin bool) *gin.Engine {
		engine := gin.New()
		engine.Use(func(c *gin.Context) {
			c.Set(middleware.PrincipalKey, middleware.Principal{UserID: uuid.New(), Email: "root@example.com", PlatformAdmin: admin})
		})
		engine.GET("/admin/backup", app.getBackupOverview)
		engine.GET("/admin/backup/export", app.exportBackup)
		engine.POST("/admin/backup/restores", app.createBackupRestore)
		engine.GET("/admin/backup/restores/:id", app.getBackupRestore)
		engine.PUT("/admin/backup/restores/:id/chunks", app.uploadBackupRestoreChunk)
		engine.POST("/admin/backup/restores/:id/start", app.startBackupRestore)
		engine.GET("/status/:id", app.getBackupRestoreStatus)
		return engine
	}
	sourceApp := &App{Config: config.Config{EncryptionKey: []byte("0123456789abcdef0123456789abcdef"), BackupStagingPath: t.TempDir()}, DB: source}
	sourceApp.Config.Transcription.LocalStoragePath = t.TempDir()
	targetApp := &App{Config: config.Config{EncryptionKey: []byte("0123456789abcdef0123456789abcdef"), BackupStagingPath: t.TempDir()}, DB: target}
	targetApp.Config.Transcription.LocalStoragePath = t.TempDir()

	do := func(engine *gin.Engine, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		return recorder
	}

	if response := do(router(sourceApp, false), http.MethodGet, "/admin/backup/export", nil, nil); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin export = %d", response.Code)
	}
	exported := do(router(sourceApp, true), http.MethodGet, "/admin/backup/export?files=false", nil, nil)
	if exported.Code != http.StatusOK || exported.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("export = %d %s", exported.Code, exported.Body.String())
	}
	archive := exported.Body.Bytes()

	engine := router(targetApp, true)
	created := do(engine, http.MethodPost, "/admin/backup/restores", []byte(fmt.Sprintf(`{"fileName":"b.zip","size":%d}`, len(archive))), map[string]string{"Content-Type": "application/json"})
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Restore backupRestoreJob `json:"restore"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &createdBody)
	id := createdBody.Restore.ID
	skipped := do(engine, http.MethodPut, fmt.Sprintf("/admin/backup/restores/%s/chunks?offset=%d", id, backupChunkBytes), archive, nil)
	var conflict struct {
		Details struct {
			ReceivedBytes *int64 `json:"receivedBytes"`
		} `json:"details"`
	}
	_ = json.Unmarshal(skipped.Body.Bytes(), &conflict)
	if skipped.Code != http.StatusConflict || conflict.Details.ReceivedBytes == nil || *conflict.Details.ReceivedBytes != 0 {
		t.Fatalf("skipping ahead = %d %s; the client resumes from details.receivedBytes", skipped.Code, skipped.Body.String())
	}
	if response := do(engine, http.MethodPut, fmt.Sprintf("/admin/backup/restores/%s/chunks?offset=0", id), archive[:len(archive)-1], nil); response.Code != http.StatusBadRequest {
		t.Fatalf("short final chunk = %d", response.Code)
	}
	if response := do(engine, http.MethodPut, fmt.Sprintf("/admin/backup/restores/%s/chunks?offset=0", id), archive, nil); response.Code != http.StatusOK {
		t.Fatalf("upload = %d %s", response.Code, response.Body.String())
	}
	waitFor := func(read func() string, want string) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			status := read()
			if status == want {
				return
			}
			if time.Now().After(deadline) || status == backupJobInvalid || status == backupJobFailed {
				t.Fatalf("status %q, want %q", status, want)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	waitFor(func() string {
		var body struct {
			Restore backupRestoreJob `json:"restore"`
		}
		_ = json.Unmarshal(do(engine, http.MethodGet, "/admin/backup/restores/"+id.String(), nil, nil).Body.Bytes(), &body)
		return body.Restore.Status
	}, backupJobReady)

	if response := do(engine, http.MethodPost, "/admin/backup/restores/"+id.String()+"/start", []byte(`{"confirmation":"yes"}`), map[string]string{"Content-Type": "application/json"}); response.Code != http.StatusBadRequest {
		t.Fatalf("restore without confirmation = %d", response.Code)
	}
	started := do(engine, http.MethodPost, "/admin/backup/restores/"+id.String()+"/start", []byte(`{"confirmation":"RESTORE"}`), map[string]string{"Content-Type": "application/json"})
	if started.Code != http.StatusAccepted {
		t.Fatalf("start = %d %s", started.Code, started.Body.String())
	}
	var startedBody struct {
		StatusToken string `json:"statusToken"`
	}
	_ = json.Unmarshal(started.Body.Bytes(), &startedBody)
	if response := do(engine, http.MethodGet, "/status/"+id.String(), nil, map[string]string{"X-Restore-Token": "wrong"}); response.Code != http.StatusNotFound {
		t.Fatalf("wrong token = %d", response.Code)
	}
	waitFor(func() string {
		var body struct {
			Restore struct {
				Status string `json:"status"`
				Error  string `json:"error"`
			} `json:"restore"`
		}
		response := do(engine, http.MethodGet, "/status/"+id.String(), nil, map[string]string{"X-Restore-Token": startedBody.StatusToken})
		_ = json.Unmarshal(response.Body.Bytes(), &body)
		if body.Restore.Error != "" {
			t.Logf("restore error: %s", body.Restore.Error)
		}
		return body.Restore.Status
	}, backupJobCompleted)

	var email string
	if err := target.QueryRowContext(ctx, `SELECT email FROM users`).Scan(&email); err != nil || email != "root@example.com" {
		t.Fatalf("restored users: %q %v", email, err)
	}
	var restoredEvents int
	if err := target.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE action = 'platform.backup.restored'`).Scan(&restoredEvents); err != nil || restoredEvents != 1 {
		t.Fatalf("restore audit events = %d %v", restoredEvents, err)
	}
}
