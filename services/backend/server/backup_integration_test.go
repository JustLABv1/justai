package server

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	"justai-backend/database"
)

// backupTestDatabase creates a migrated scratch database next to the one in
// JUSTAI_DATABASE_URL. A restore empties every table, so these tests never
// touch the configured database itself.
func backupTestDatabase(t *testing.T, ctx context.Context) *sql.DB {
	t.Helper()
	base := os.Getenv("JUSTAI_DATABASE_URL")
	if base == "" {
		t.Skip("JUSTAI_DATABASE_URL is not configured")
	}
	admin, err := sql.Open("postgres", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	name := "justai_backup_test_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	if _, err := admin.ExecContext(ctx, `CREATE DATABASE `+name); err != nil {
		t.Skipf("cannot create a scratch database: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(`DROP DATABASE IF EXISTS ` + name + ` WITH (FORCE)`) })
	parsed, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	db, err := database.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.RunMigrations(ctx, db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestBackupRoundTripIntegration(t *testing.T) {
	ctx := context.Background()
	source := backupTestDatabase(t, ctx)
	target := backupTestDatabase(t, ctx)

	userID, orgID, sourceID := uuid.New(), uuid.New(), uuid.New()
	seed := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, email, display_name) VALUES ($1, 'ada@example.com', 'Ada')`, []any{userID}},
		{`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lab', 'lab')`, []any{orgID}},
		// The insert trigger on conversations derives rows the backup already
		// contains; restoring must not run it a second time.
		{`INSERT INTO conversations (user_id, organization_id, title) VALUES ($1, $2, 'Hello')`, []any{userID, orgID}},
		{`INSERT INTO user_avatars (user_id, mime_type, image_data) VALUES ($1, 'image/png', '\x89504e470d0a00ff'::bytea)`, []any{userID}},
		// A stored JSON null is not SQL NULL and must survive the round trip.
		{`INSERT INTO audit_events (user_id, action, resource_type, details) VALUES ($1, 'a', 'b', 'null'::jsonb), ($1, 'c', 'd', '{"nested":[1,"x",null]}')`, []any{userID}},
		{`INSERT INTO knowledge_sources (id, scope_type, scope_id, title, source_type) VALUES ($1, 'user', $2, 'Doc', 'text')`, []any{sourceID, userID}},
		{`INSERT INTO knowledge_chunks (source_id, chunk_index, title, content, embedding, embedding_dimension) VALUES ($1, 0, 'T', 'searchable words', '[0.5,-1,2.25]', 3)`, []any{sourceID}},
	}
	for _, statement := range seed {
		if _, err := source.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("%s: %v", statement.query, err)
		}
	}
	// Target data that the restore must replace completely.
	if _, err := target.ExecContext(ctx, `INSERT INTO users (email, display_name) VALUES ('other@example.com', 'Other')`); err != nil {
		t.Fatal(err)
	}

	sourceFiles := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sourceFiles, "recording"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceFiles, "recording", "part-00000000"), []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	key := []byte("0123456789abcdef0123456789abcdef")
	var archive bytes.Buffer
	manifest, err := writeBackupArchive(ctx, source, map[string]backupFileStore{backupDriverLocal: localBackupStore{root: sourceFiles}}, backupExportOptions{IncludeFiles: true, CreatedBy: "ada@example.com", EncryptionKey: key}, &archive)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range manifest.Tables {
		if table.Name == "user_sessions" || table.Name == "schema_migrations" || table.Name == "backup_restore_jobs" {
			t.Fatalf("%s must not be exported", table.Name)
		}
	}
	archivePath := filepath.Join(t.TempDir(), "backup.zip")
	if err := os.WriteFile(archivePath, archive.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	targetFiles := t.TempDir()
	stores := map[string]backupFileStore{backupDriverLocal: localBackupStore{root: targetFiles}}
	inspection, err := inspectBackupArchive(ctx, target, stores, key, archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if inspection.Summary.Schema != "current" || !inspection.Summary.EncryptionKeyOK || inspection.Summary.FileCount != 1 || len(inspection.Warnings) != 0 {
		t.Fatalf("unexpected inspection: %+v %v", inspection.Summary, inspection.Warnings)
	}
	if other, err := inspectBackupArchive(ctx, target, stores, []byte("another key"), archivePath); err != nil || other.Summary.EncryptionKeyOK || len(other.Warnings) != 1 {
		t.Fatalf("a different encryption key must warn: %+v %v %v", other.Summary, other.Warnings, err)
	}

	reader, err := zip.NewReader(bytes.NewReader(archive.Bytes()), int64(archive.Len()))
	if err != nil {
		t.Fatal(err)
	}
	progress := &backupRestoreProgress{}
	if err := restoreBackupDatabase(ctx, target, reader, inspection.Manifest, progress, func() {}); err != nil {
		t.Fatal(err)
	}
	if err := restoreBackupFiles(ctx, reader, stores, progress, func() {}); err != nil {
		t.Fatal(err)
	}

	again := bytes.Buffer{}
	if _, err := writeBackupArchive(ctx, target, nil, backupExportOptions{EncryptionKey: key}, &again); err != nil {
		t.Fatal(err)
	}
	restored, err := zip.NewReader(bytes.NewReader(again.Bytes()), int64(again.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range manifest.Tables {
		if before, after := backupEntryLines(t, reader, table.Entry), backupEntryLines(t, restored, table.Entry); before != after {
			t.Errorf("table %s changed in the round trip:\n%s\n---\n%s", table.Name, before, after)
		}
	}

	var jsonNulls, users, enabledTriggers int
	var searchable bool
	if err := target.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE details = 'null'::jsonb`).Scan(&jsonNulls); err != nil || jsonNulls != 1 {
		t.Fatalf("JSON null rows = %d, %v", jsonNulls, err)
	}
	if err := target.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&users); err != nil || users != 1 {
		t.Fatalf("users = %d, %v", users, err)
	}
	if err := target.QueryRowContext(ctx, `SELECT search_vector @@ plainto_tsquery('simple', 'searchable') FROM knowledge_chunks`).Scan(&searchable); err != nil || !searchable {
		t.Fatalf("generated search vector was not rebuilt: %v", err)
	}
	if err := target.QueryRowContext(ctx, `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'`).Scan(&enabledTriggers); err != nil || enabledTriggers != 0 {
		t.Fatalf("%d triggers remain disabled (%v)", enabledTriggers, err)
	}
	if _, err := target.ExecContext(ctx, `INSERT INTO audit_events (action, resource_type) VALUES ('after', 'restore')`); err != nil {
		t.Fatalf("sequences were not advanced: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(targetFiles, "recording", "part-00000000")); err != nil || string(data) != "audio" {
		t.Fatalf("stored file was not restored: %q %v", data, err)
	}
}

func TestBackupInspectionRejectsDamagedArchivesIntegration(t *testing.T) {
	ctx := context.Background()
	db := backupTestDatabase(t, ctx)
	key := []byte("key")
	var archive bytes.Buffer
	if _, err := writeBackupArchive(ctx, db, nil, backupExportOptions{EncryptionKey: key}, &archive); err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	check := func(name string, data []byte, want string) {
		t.Helper()
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := inspectBackupArchive(ctx, db, nil, key, path)
		var validation *backupValidationError
		if !errors.As(err, &validation) || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: got %v, want validation error containing %q", name, err, want)
		}
	}
	check("truncated.zip", archive.Bytes()[:archive.Len()/2], "not a JustAI backup")

	// Same archive with an extra migration this instance does not know.
	newer := rewriteBackupManifest(t, archive.Bytes(), func(manifest string) string {
		return strings.Replace(manifest, `"migrations": [`, `"migrations": ["999_future.sql", `, 1)
	})
	check("newer.zip", newer, "newer JustAI version")

	wrongCount := rewriteBackupManifest(t, archive.Bytes(), func(manifest string) string {
		return strings.Replace(manifest, `"name": "users",`+"\n      \"entry\": \"db/users.ndjson\",", `"name": "users",`+"\n      \"entry\": \"db/missing.ndjson\",", 1)
	})
	check("missing-table.zip", wrongCount, "missing from the archive")
}

func rewriteBackupManifest(t *testing.T, data []byte, change func(string) string) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, file := range reader.File {
		source, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, _ := io.ReadAll(source)
		_ = source.Close()
		if file.Name == backupManifestEntry {
			content = []byte(change(string(content)))
		}
		target, err := writer.Create(file.Name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = target.Write(content)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func backupEntryLines(t *testing.T, archive *zip.Reader, name string) string {
	t.Helper()
	file, err := archive.Open(name)
	if err != nil {
		t.Fatal(fmt.Errorf("%s: %w", name, err))
	}
	defer file.Close()
	data, _ := io.ReadAll(file)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}
