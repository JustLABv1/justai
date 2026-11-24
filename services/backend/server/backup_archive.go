package server

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/lib/pq"
)

// Instance backups are ZIP archives:
//
//	db/<table>.ndjson        one JSON object per row (deflated)
//	files/<driver>/<key>     stored objects such as recordings (not recompressed)
//	manifest.json            written last; a truncated download has none
//
// Rows are produced by row_to_json and restored with
// json_populate_recordset, so Postgres itself performs every type
// conversion (bytea, vector, arrays, jsonb, timestamps) in both directions.
const (
	backupFormat           = "justai-backup"
	backupFormatVersion    = 1
	backupManifestEntry    = "manifest.json"
	backupTablePrefix      = "db/"
	backupFilePrefix       = "files/"
	backupInsertBatchBytes = 4 * 1024 * 1024
	backupInsertBatchRows  = 500
)

// backupExcludedTables hold sessions, one-use credentials, and process state.
// None of it is meaningful on another instance or after a restore, and a
// restore empties them.
var backupExcludedTables = []string{
	"api_rate_limit_buckets",
	"mcp_oauth_states",
	"oidc_auth_states",
	"stream_tickets",
	"user_sessions",
	"worker_heartbeats",
	"ws_tickets",
}

// backupPreservedTables are never exported and never touched by a restore.
var backupPreservedTables = []string{"schema_migrations", "backup_restore_jobs"}

type backupManifest struct {
	Format             string                `json:"format"`
	FormatVersion      int                   `json:"formatVersion"`
	CreatedAt          time.Time             `json:"createdAt"`
	CreatedBy          string                `json:"createdBy"`
	Migrations         []string              `json:"migrations"`
	EncryptionKeyCheck string                `json:"encryptionKeyCheck"`
	IncludesFiles      bool                  `json:"includesFiles"`
	Tables             []backupTableManifest `json:"tables"`
	Files              []backupFileGroup     `json:"files"`
	ExcludedTables     []string              `json:"excludedTables"`
}

type backupTableManifest struct {
	Name    string   `json:"name"`
	Entry   string   `json:"entry"`
	Columns []string `json:"columns"`
	// JSONText lists json/jsonb columns exported as their text form. Embedding
	// them directly would make a stored JSON null indistinguishable from SQL
	// NULL.
	JSONText []string `json:"jsonText,omitempty"`
	Rows     int64    `json:"rows"`
}

type backupFileGroup struct {
	Driver string `json:"driver"`
	Count  int64  `json:"count"`
	Bytes  int64  `json:"bytes"`
}

type backupExportOptions struct {
	IncludeFiles  bool
	CreatedBy     string
	EncryptionKey []byte
}

// backupEncryptionKeyCheck identifies the encryption key without revealing it.
// Provider credentials and recording keys in a backup are only readable by an
// instance that uses the same key.
func backupEncryptionKeyCheck(key []byte) string {
	sum := sha256.Sum256(append([]byte("justai-backup-key-check:"), key...))
	return hex.EncodeToString(sum[:8])
}

type backupQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func backupAppliedMigrations(ctx context.Context, db backupQueryer) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, err
	}
	return scanBackupStrings(rows)
}

func scanBackupStrings(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	values := make([]string, 0)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

// backupTableNames lists the application tables in the public schema.
func backupTableNames(ctx context.Context, db backupQueryer) ([]string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
		ORDER BY c.relname`)
	if err != nil {
		return nil, err
	}
	names, err := scanBackupStrings(rows)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(names, func(name string) bool {
		return slices.Contains(backupPreservedTables, name)
	}), nil
}

type backupColumn struct {
	Name           string
	Type           string // format_type, e.g. "vector(1536)"
	JSON           bool
	Required       bool // NOT NULL without default: must come from the backup
	IdentityAlways bool
}

// backupInsertableColumns returns the columns a restore may write, in table
// order. Generated columns are recomputed by Postgres.
func backupInsertableColumns(ctx context.Context, db backupQueryer, table string) ([]backupColumn, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT a.attname, format_type(a.atttypid, a.atttypmod),
		       t.typname IN ('json', 'jsonb'),
		       a.attnotnull AND NOT a.atthasdef AND a.attidentity = '',
		       a.attidentity = 'a'
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_type t ON t.oid = a.atttypid
		WHERE n.nspname = 'public' AND c.relname = $1
		  AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
		ORDER BY a.attnum`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make([]backupColumn, 0)
	for rows.Next() {
		var column backupColumn
		if err := rows.Scan(&column.Name, &column.Type, &column.JSON, &column.Required, &column.IdentityAlways); err != nil {
			return nil, err
		}
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

func backupColumnNames(columns []backupColumn) []string {
	names := make([]string, len(columns))
	for index, column := range columns {
		names[index] = column.Name
	}
	return names
}

func quoteBackupIdentifiers(names []string) string {
	quoted := make([]string, len(names))
	for index, name := range names {
		quoted[index] = pq.QuoteIdentifier(name)
	}
	return strings.Join(quoted, ", ")
}

func backupTableIdentifier(table string) string {
	return "public." + pq.QuoteIdentifier(table)
}

// writeBackupArchive streams a complete instance backup into w. All tables are
// read from one repeatable-read snapshot so foreign keys stay consistent.
// When it returns an error the archive has no manifest and is rejected on
// import, even if the client received part of it.
func writeBackupArchive(ctx context.Context, db *sql.DB, stores map[string]backupFileStore, options backupExportOptions, w io.Writer) (backupManifest, error) {
	manifest := backupManifest{
		Format:             backupFormat,
		FormatVersion:      backupFormatVersion,
		CreatedAt:          time.Now().UTC(),
		CreatedBy:          options.CreatedBy,
		EncryptionKeyCheck: backupEncryptionKeyCheck(options.EncryptionKey),
		IncludesFiles:      options.IncludeFiles,
		Tables:             make([]backupTableManifest, 0),
		Files:              make([]backupFileGroup, 0),
		ExcludedTables:     append([]string(nil), backupExcludedTables...),
	}
	archive := zip.NewWriter(w)

	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return manifest, err
	}
	defer func() { _ = tx.Rollback() }()
	if manifest.Migrations, err = backupAppliedMigrations(ctx, tx); err != nil {
		return manifest, err
	}
	tables, err := backupTableNames(ctx, tx)
	if err != nil {
		return manifest, err
	}
	for _, table := range tables {
		if slices.Contains(backupExcludedTables, table) {
			continue
		}
		entry, err := writeBackupTable(ctx, tx, archive, table)
		if err != nil {
			return manifest, fmt.Errorf("export table %s: %w", table, err)
		}
		manifest.Tables = append(manifest.Tables, entry)
	}
	if err := tx.Commit(); err != nil {
		return manifest, err
	}

	if options.IncludeFiles {
		for _, driver := range sortedBackupDrivers(stores) {
			group, err := writeBackupFiles(ctx, archive, stores[driver])
			if err != nil {
				return manifest, fmt.Errorf("export %s files: %w", driver, err)
			}
			if group.Count > 0 {
				manifest.Files = append(manifest.Files, group)
			}
		}
	}

	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return manifest, err
	}
	writer, err := archive.CreateHeader(&zip.FileHeader{Name: backupManifestEntry, Method: zip.Deflate, Modified: manifest.CreatedAt})
	if err != nil {
		return manifest, err
	}
	if _, err := writer.Write(encoded); err != nil {
		return manifest, err
	}
	return manifest, archive.Close()
}

func sortedBackupDrivers(stores map[string]backupFileStore) []string {
	drivers := make([]string, 0, len(stores))
	for driver := range stores {
		drivers = append(drivers, driver)
	}
	sort.Strings(drivers)
	return drivers
}

func writeBackupTable(ctx context.Context, tx *sql.Tx, archive *zip.Writer, table string) (backupTableManifest, error) {
	columns, err := backupInsertableColumns(ctx, tx, table)
	if err != nil {
		return backupTableManifest{}, err
	}
	entry := backupTableManifest{Name: table, Entry: backupTablePrefix + table + ".ndjson", Columns: backupColumnNames(columns)}
	selected := make([]string, len(columns))
	for index, column := range columns {
		selected[index] = pq.QuoteIdentifier(column.Name)
		if column.JSON {
			selected[index] += "::text AS " + pq.QuoteIdentifier(column.Name)
			entry.JSONText = append(entry.JSONText, column.Name)
		}
	}
	writer, err := archive.CreateHeader(&zip.FileHeader{Name: entry.Entry, Method: zip.Deflate, Modified: time.Now().UTC()})
	if err != nil {
		return entry, err
	}
	if len(columns) == 0 {
		return entry, nil
	}
	rows, err := tx.QueryContext(ctx, fmt.Sprintf(`SELECT row_to_json(r)::text FROM (SELECT %s FROM %s) r`, strings.Join(selected, ", "), backupTableIdentifier(table)))
	if err != nil {
		return entry, err
	}
	defer rows.Close()
	buffered := bufio.NewWriterSize(writer, 256*1024)
	for rows.Next() {
		var line []byte
		if err := rows.Scan(&line); err != nil {
			return entry, err
		}
		if _, err := buffered.Write(line); err != nil {
			return entry, err
		}
		if err := buffered.WriteByte('\n'); err != nil {
			return entry, err
		}
		entry.Rows++
	}
	if err := rows.Err(); err != nil {
		return entry, err
	}
	return entry, buffered.Flush()
}

func writeBackupFiles(ctx context.Context, archive *zip.Writer, store backupFileStore) (backupFileGroup, error) {
	group := backupFileGroup{Driver: store.Driver()}
	objects := make([]backupObject, 0)
	if err := store.List(ctx, func(object backupObject) error {
		objects = append(objects, object)
		return nil
	}); err != nil {
		return group, err
	}
	for _, object := range objects {
		if _, err := cleanBackupKey(object.Key); err != nil {
			continue // not addressable by JustAI; never written by it
		}
		reader, err := store.Open(ctx, object.Key)
		if err != nil {
			if isBackupObjectGone(err) {
				continue // deleted after listing
			}
			return group, fmt.Errorf("open %s: %w", object.Key, err)
		}
		header := &zip.FileHeader{Name: backupFilePrefix + store.Driver() + "/" + object.Key, Method: zip.Store, Modified: time.Now().UTC()}
		header.SetMode(0o600)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			_ = reader.Close()
			return group, err
		}
		written, copyErr := io.Copy(writer, reader)
		_ = reader.Close()
		if copyErr != nil {
			return group, fmt.Errorf("copy %s: %w", object.Key, copyErr)
		}
		group.Count++
		group.Bytes += written
	}
	return group, nil
}

func isBackupObjectGone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || s3ErrorHasStatus(err, 404)
}

// backupInspection is what an administrator reviews before a restore.
type backupInspection struct {
	Manifest backupManifest  `json:"-"`
	Summary  backupSummary   `json:"summary"`
	Warnings []backupWarning `json:"warnings"`
}

// backupWarning is a code with values so the admin console can localize it.
type backupWarning struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Values  map[string]any `json:"values,omitempty"`
}

type backupSummary struct {
	CreatedAt        time.Time         `json:"createdAt"`
	CreatedBy        string            `json:"createdBy"`
	Schema           string            `json:"schema"` // "current" or "older"
	Tables           int               `json:"tables"`
	Rows             int64             `json:"rows"`
	IncludesFiles    bool              `json:"includesFiles"`
	Files            []backupFileGroup `json:"files"`
	FileCount        int64             `json:"fileCount"`
	FileBytes        int64             `json:"fileBytes"`
	EncryptionKeyOK  bool              `json:"encryptionKeyMatches"`
	MissingMigration int               `json:"newerMigrations"`
}

type backupValidationError struct {
	message string
}

func (e *backupValidationError) Error() string { return e.message }

func invalidBackup(format string, args ...any) error {
	return &backupValidationError{message: fmt.Sprintf(format, args...)}
}

// inspectBackupArchive reads the whole archive once. Every entry's CRC is
// verified and every table is checked against the current schema, so a
// restore only starts from an archive that can be applied completely.
func inspectBackupArchive(ctx context.Context, db *sql.DB, stores map[string]backupFileStore, encryptionKey []byte, archivePath string) (backupInspection, error) {
	inspection := backupInspection{Warnings: make([]backupWarning, 0)}
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return inspection, invalidBackup("the file is not a JustAI backup archive (%v)", err)
	}
	defer archive.Close()
	entries := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		entries[file.Name] = file
	}
	manifestFile := entries[backupManifestEntry]
	if manifestFile == nil {
		return inspection, invalidBackup("the archive has no manifest; the backup is incomplete or was not created by JustAI")
	}
	manifest, err := readBackupManifest(manifestFile)
	if err != nil {
		return inspection, err
	}
	inspection.Manifest = manifest

	current, err := backupAppliedMigrations(ctx, db)
	if err != nil {
		return inspection, err
	}
	newer := make([]string, 0)
	for _, version := range manifest.Migrations {
		if !slices.Contains(current, version) {
			newer = append(newer, version)
		}
	}
	if len(newer) > 0 {
		return inspection, invalidBackup("the backup was created by a newer JustAI version (unknown migrations: %s); upgrade this instance first", strings.Join(newer, ", "))
	}
	older := 0
	for _, version := range current {
		if !slices.Contains(manifest.Migrations, version) {
			older++
		}
	}
	summary := backupSummary{
		CreatedAt:        manifest.CreatedAt,
		CreatedBy:        manifest.CreatedBy,
		Schema:           "current",
		IncludesFiles:    manifest.IncludesFiles,
		Files:            manifest.Files,
		EncryptionKeyOK:  manifest.EncryptionKeyCheck == backupEncryptionKeyCheck(encryptionKey),
		MissingMigration: older,
	}
	if summary.Files == nil {
		summary.Files = make([]backupFileGroup, 0)
	}
	if older > 0 {
		summary.Schema = "older"
		inspection.Warnings = append(inspection.Warnings, backupWarning{Code: "older_schema", Values: map[string]any{"count": older},
			Message: fmt.Sprintf("The backup was created by an older JustAI version (%d newer migrations here). Columns added since then get their defaults; data conversions from those upgrades are not repeated.", older)})
	}
	if !summary.EncryptionKeyOK {
		inspection.Warnings = append(inspection.Warnings, backupWarning{Code: "encryption_key_mismatch",
			Message: "This instance uses a different encryption key. Stored provider credentials, MCP secrets, and recordings from the backup cannot be decrypted until JUSTAI_ENCRYPTION_KEY matches the original instance."})
	}

	currentTables, err := backupTableNames(ctx, db)
	if err != nil {
		return inspection, err
	}
	for _, table := range manifest.Tables {
		if err := ctx.Err(); err != nil {
			return inspection, err
		}
		file := entries[table.Entry]
		if file == nil || table.Entry != backupTablePrefix+table.Name+".ndjson" {
			return inspection, invalidBackup("table %s is listed in the manifest but missing from the archive", table.Name)
		}
		rows, err := countBackupRows(file)
		if err != nil {
			return inspection, invalidBackup("table %s is damaged: %v", table.Name, err)
		}
		if rows != table.Rows {
			return inspection, invalidBackup("table %s has %d rows, the manifest expects %d", table.Name, rows, table.Rows)
		}
		summary.Rows += rows
		if !slices.Contains(currentTables, table.Name) {
			if rows > 0 {
				inspection.Warnings = append(inspection.Warnings, backupWarning{Code: "table_removed", Values: map[string]any{"table": table.Name, "rows": rows},
					Message: fmt.Sprintf("Table %s no longer exists; its %d rows are skipped.", table.Name, rows)})
			}
			continue
		}
		summary.Tables++
		columns, err := backupInsertableColumns(ctx, db, table.Name)
		if err != nil {
			return inspection, err
		}
		for _, column := range columns {
			if column.Required && !slices.Contains(table.Columns, column.Name) && rows > 0 {
				return inspection, invalidBackup("table %s needs a value for %s, which the backup does not contain", table.Name, column.Name)
			}
		}
		currentNames := backupColumnNames(columns)
		dropped := make([]string, 0)
		for _, column := range table.Columns {
			if !slices.Contains(currentNames, column) {
				dropped = append(dropped, column)
			}
		}
		if len(dropped) > 0 && rows > 0 {
			inspection.Warnings = append(inspection.Warnings, backupWarning{Code: "columns_removed", Values: map[string]any{"table": table.Name, "columns": strings.Join(dropped, ", ")},
				Message: fmt.Sprintf("Table %s: columns %s no longer exist and are skipped.", table.Name, strings.Join(dropped, ", "))})
		}
	}

	fileCounts := make(map[string]int64)
	for _, file := range archive.File {
		if !strings.HasPrefix(file.Name, backupFilePrefix) {
			continue
		}
		driver, _, err := splitBackupFileEntry(file.Name)
		if err != nil {
			return inspection, invalidBackup("%v", err)
		}
		if stores[driver] == nil {
			return inspection, invalidBackup("the backup contains %s files, but %s storage is not configured on this instance", driver, driver)
		}
		if err := verifyBackupEntry(ctx, file); err != nil {
			return inspection, invalidBackup("file %s is damaged: %v", file.Name, err)
		}
		fileCounts[driver]++
		summary.FileCount++
		summary.FileBytes += int64(file.UncompressedSize64)
	}
	for _, group := range manifest.Files {
		if fileCounts[group.Driver] != group.Count {
			return inspection, invalidBackup("the archive has %d %s files, the manifest expects %d", fileCounts[group.Driver], group.Driver, group.Count)
		}
	}
	if !manifest.IncludesFiles {
		inspection.Warnings = append(inspection.Warnings, backupWarning{Code: "no_files",
			Message: "The backup contains no stored files. Recordings and uploaded videos must already exist in this instance's storage, or they will be missing."})
	}
	inspection.Summary = summary
	return inspection, nil
}

func readBackupManifest(file *zip.File) (backupManifest, error) {
	var manifest backupManifest
	reader, err := file.Open()
	if err != nil {
		return manifest, invalidBackup("the manifest cannot be read: %v", err)
	}
	defer reader.Close()
	if err := json.NewDecoder(io.LimitReader(reader, 16*1024*1024)).Decode(&manifest); err != nil {
		return manifest, invalidBackup("the manifest is not valid JSON: %v", err)
	}
	if manifest.Format != backupFormat {
		return manifest, invalidBackup("the archive is not a JustAI instance backup")
	}
	if manifest.FormatVersion < 1 || manifest.FormatVersion > backupFormatVersion {
		return manifest, invalidBackup("backup format version %d is not supported by this JustAI version", manifest.FormatVersion)
	}
	seen := make(map[string]bool, len(manifest.Tables))
	for _, table := range manifest.Tables {
		if table.Name == "" || seen[table.Name] || slices.Contains(backupPreservedTables, table.Name) || slices.Contains(backupExcludedTables, table.Name) {
			return manifest, invalidBackup("the manifest lists table %q more than once or lists a table that is never restored", table.Name)
		}
		seen[table.Name] = true
	}
	return manifest, nil
}

func splitBackupFileEntry(name string) (string, string, error) {
	rest := strings.TrimPrefix(name, backupFilePrefix)
	driver, key, ok := strings.Cut(rest, "/")
	if !ok || (driver != backupDriverLocal && driver != backupDriverS3) {
		return "", "", fmt.Errorf("unexpected archive entry %q", name)
	}
	cleaned, err := cleanBackupKey(key)
	if err != nil {
		return "", "", err
	}
	return driver, cleaned, nil
}

// countBackupRows reads a table entry to its end, which also verifies the
// entry's CRC, and checks every line is a JSON object.
func countBackupRows(file *zip.File) (int64, error) {
	reader, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer reader.Close()
	lines := bufio.NewReaderSize(reader, 256*1024)
	var rows int64
	for {
		line, err := lines.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := bytes.TrimSpace(line)
			if len(trimmed) > 0 {
				if trimmed[0] != '{' || !json.Valid(trimmed) {
					return rows, fmt.Errorf("row %d is not a JSON object", rows+1)
				}
				rows++
			}
		}
		if errors.Is(err, io.EOF) {
			return rows, nil
		}
		if err != nil {
			return rows, err
		}
	}
}

func verifyBackupEntry(ctx context.Context, file *zip.File) error {
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	_, err = io.Copy(io.Discard, contextReader{ctx: ctx, reader: reader})
	return err
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

type backupRestoreProgress struct {
	Phase        string `json:"phase"`
	CurrentTable string `json:"currentTable,omitempty"`
	TablesDone   int    `json:"tablesDone"`
	TablesTotal  int    `json:"tablesTotal"`
	RowsDone     int64  `json:"rowsDone"`
	RowsTotal    int64  `json:"rowsTotal"`
	FilesDone    int64  `json:"filesDone"`
	FilesTotal   int64  `json:"filesTotal"`
	BytesDone    int64  `json:"bytesDone"`
	BytesTotal   int64  `json:"bytesTotal"`
}

type backupForeignKey struct {
	table      string
	name       string
	definition string
}

// restoreBackupDatabase replaces every application table with the archive's
// rows in one transaction. Foreign keys are dropped and re-created (which
// validates them) so rows can load in any order, including self-references
// and cycles, without superuser rights. User triggers are disabled because
// they derive rows that the backup already contains.
func restoreBackupDatabase(ctx context.Context, db *sql.DB, archive *zip.Reader, manifest backupManifest, progress *backupRestoreProgress, report func()) error {
	entries := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		entries[file.Name] = file
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var locked bool
	if err := tx.QueryRowContext(ctx, `SELECT pg_try_advisory_xact_lock(hashtext('justai.backup_restore'))`).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return errors.New("another restore is already running")
	}
	if _, err := tx.ExecContext(ctx, `SET LOCAL lock_timeout = '60s'; SET LOCAL statement_timeout = 0`); err != nil {
		return err
	}
	tables, err := backupTableNames(ctx, tx)
	if err != nil {
		return err
	}
	if len(tables) == 0 {
		return errors.New("the database has no application tables")
	}

	foreignKeys, err := backupForeignKeys(ctx, tx)
	if err != nil {
		return err
	}
	for _, key := range foreignKeys {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s DROP CONSTRAINT %s`, backupTableIdentifier(key.table), pq.QuoteIdentifier(key.name))); err != nil {
			return fmt.Errorf("drop foreign key %s: %w", key.name, err)
		}
	}
	for _, table := range tables {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s DISABLE TRIGGER USER`, backupTableIdentifier(table))); err != nil {
			return fmt.Errorf("disable triggers on %s: %w", table, err)
		}
	}
	identifiers := make([]string, len(tables))
	for index, table := range tables {
		identifiers[index] = backupTableIdentifier(table)
	}
	if _, err := tx.ExecContext(ctx, `TRUNCATE TABLE `+strings.Join(identifiers, ", ")); err != nil {
		return fmt.Errorf("empty tables: %w", err)
	}

	for _, table := range manifest.Tables {
		if !slices.Contains(tables, table.Name) {
			continue
		}
		progress.CurrentTable = table.Name
		report()
		inserted, err := restoreBackupTable(ctx, tx, entries[table.Entry], table, func(rows int64) {
			progress.RowsDone += rows
			report()
		})
		if err != nil {
			return fmt.Errorf("restore table %s: %w", table.Name, err)
		}
		if inserted != table.Rows {
			return fmt.Errorf("restore table %s: inserted %d of %d rows", table.Name, inserted, table.Rows)
		}
		progress.TablesDone++
	}
	progress.CurrentTable = ""
	progress.Phase = "constraints"
	report()

	for _, key := range foreignKeys {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s ADD CONSTRAINT %s %s`, backupTableIdentifier(key.table), pq.QuoteIdentifier(key.name), key.definition)); err != nil {
			return fmt.Errorf("the restored data violates %s on %s: %w", key.name, key.table, err)
		}
		report()
	}
	for _, table := range tables {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s ENABLE TRIGGER USER`, backupTableIdentifier(table))); err != nil {
			return fmt.Errorf("enable triggers on %s: %w", table, err)
		}
	}
	if err := resetBackupSequences(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

func backupForeignKeys(ctx context.Context, tx *sql.Tx) ([]backupForeignKey, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
		FROM pg_constraint con
		JOIN pg_class rel ON rel.oid = con.conrelid
		JOIN pg_namespace n ON n.oid = rel.relnamespace
		WHERE con.contype = 'f' AND n.nspname = 'public'
		ORDER BY rel.relname, con.conname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := make([]backupForeignKey, 0)
	for rows.Next() {
		var key backupForeignKey
		if err := rows.Scan(&key.table, &key.name, &key.definition); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func restoreBackupTable(ctx context.Context, tx *sql.Tx, file *zip.File, table backupTableManifest, onBatch func(int64)) (int64, error) {
	columns, err := backupInsertableColumns(ctx, tx, table.Name)
	if err != nil {
		return 0, err
	}
	// json_to_recordset with an explicit column list lets Postgres parse each
	// value with the current column type; JSON columns arrive as text and are
	// cast so a stored JSON null stays a JSON null.
	names := make([]string, 0, len(columns))
	definitions := make([]string, 0, len(columns))
	values := make([]string, 0, len(columns))
	overriding := ""
	for _, column := range columns {
		if !slices.Contains(table.Columns, column.Name) {
			continue
		}
		quoted := pq.QuoteIdentifier(column.Name)
		names = append(names, column.Name)
		if slices.Contains(table.JSONText, column.Name) {
			definitions = append(definitions, quoted+" text")
			values = append(values, "r."+quoted+"::"+column.Type)
		} else {
			definitions = append(definitions, quoted+" "+column.Type)
			values = append(values, "r."+quoted)
		}
		if column.IdentityAlways {
			overriding = "OVERRIDING SYSTEM VALUE "
		}
	}
	if table.Rows == 0 {
		return 0, nil
	}
	if len(names) == 0 {
		return 0, errors.New("no backup column matches the current table")
	}
	statement := fmt.Sprintf(`INSERT INTO %s (%s) %sSELECT %s FROM json_to_recordset($1::json) AS r(%s)`,
		backupTableIdentifier(table.Name), quoteBackupIdentifiers(names), overriding, strings.Join(values, ", "), strings.Join(definitions, ", "))

	reader, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer reader.Close()
	lines := bufio.NewReaderSize(reader, 256*1024)
	var batch bytes.Buffer
	var batchRows, inserted int64
	flush := func() error {
		if batchRows == 0 {
			return nil
		}
		batch.WriteByte(']')
		result, err := tx.ExecContext(ctx, statement, batch.String())
		if err != nil {
			return err
		}
		inserted += int64(rowsAffected(result))
		onBatch(batchRows)
		batch.Reset()
		batchRows = 0
		return nil
	}
	for {
		line, readErr := lines.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			if batchRows == 0 {
				batch.WriteByte('[')
			} else {
				batch.WriteByte(',')
			}
			batch.Write(trimmed)
			batchRows++
			if batchRows >= backupInsertBatchRows || batch.Len() >= backupInsertBatchBytes {
				if err := flush(); err != nil {
					return inserted, err
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return inserted, readErr
		}
	}
	return inserted, flush()
}

// resetBackupSequences moves every column-owned sequence past the restored
// maximum so new rows do not collide with restored ids.
func resetBackupSequences(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT seq.relname, tbl.relname, att.attname
		FROM pg_class seq
		JOIN pg_namespace n ON n.oid = seq.relnamespace
		JOIN pg_depend dep ON dep.objid = seq.oid AND dep.classid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
		JOIN pg_class tbl ON tbl.oid = dep.refobjid
		JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = dep.refobjsubid
		WHERE seq.relkind = 'S' AND n.nspname = 'public'`)
	if err != nil {
		return err
	}
	type sequence struct{ name, table, column string }
	sequences := make([]sequence, 0)
	for rows.Next() {
		var item sequence
		if err := rows.Scan(&item.name, &item.table, &item.column); err != nil {
			_ = rows.Close()
			return err
		}
		sequences = append(sequences, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	for _, item := range sequences {
		if slices.Contains(backupPreservedTables, item.table) {
			continue
		}
		query := fmt.Sprintf(`SELECT setval($1::regclass, COALESCE((SELECT max(%s) FROM %s), 0) + 1, false)`, pq.QuoteIdentifier(item.column), backupTableIdentifier(item.table))
		if _, err := tx.ExecContext(ctx, query, "public."+pq.QuoteIdentifier(item.name)); err != nil {
			return fmt.Errorf("reset sequence %s: %w", item.name, err)
		}
	}
	return nil
}

// restoreBackupFiles copies stored objects into the store each one came
// from. Existing objects with the same key are replaced; objects that are not
// in the backup are left alone.
func restoreBackupFiles(ctx context.Context, archive *zip.Reader, stores map[string]backupFileStore, progress *backupRestoreProgress, report func()) error {
	lastReport := time.Now()
	for _, file := range archive.File {
		if !strings.HasPrefix(file.Name, backupFilePrefix) {
			continue
		}
		driver, key, err := splitBackupFileEntry(file.Name)
		if err != nil {
			return err
		}
		store := stores[driver]
		if store == nil {
			return fmt.Errorf("%s storage is not configured", driver)
		}
		reader, err := file.Open()
		if err != nil {
			return err
		}
		size := int64(file.UncompressedSize64)
		writeErr := store.Write(ctx, key, contextReader{ctx: ctx, reader: reader}, size)
		_ = reader.Close()
		if writeErr != nil {
			return fmt.Errorf("write %s file %s: %w", driver, key, writeErr)
		}
		progress.FilesDone++
		progress.BytesDone += size
		if time.Since(lastReport) > time.Second {
			report()
			lastReport = time.Now()
		}
	}
	report()
	return nil
}
