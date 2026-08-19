package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/repository"
)

const repositoryImportTimeout = 5 * time.Minute

type repositoryContextRequest struct {
	URL         string `json:"url"`
	Ref         string `json:"ref"`
	AccessToken string `json:"accessToken"`
}

type repositoryContextExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// attachUserRepositories makes a newly created conversation inherit the
// user's repository library. It only creates mappings; the repository rows,
// files, and ingestion jobs remain shared and are never re-fetched.
func attachUserRepositories(ctx context.Context, execer repositoryContextExecer, conversationID, userID uuid.UUID) error {
	if _, err := execer.ExecContext(ctx, `
		INSERT INTO conversation_repository_contexts (conversation_id, context_id, added_by, context_scope)
		SELECT $1, rc.id, $2, 'persistent'
		FROM repository_contexts rc
		WHERE rc.scope_type = 'user'
		  AND rc.scope_id = $2
		  AND NOT (rc.status = 'failed' AND rc.file_count = 0)
		ON CONFLICT (conversation_id, context_id) DO NOTHING`, conversationID, userID); err != nil {
		return err
	}
	_, err := execer.ExecContext(ctx, `
		INSERT INTO conversation_knowledge_sources (conversation_id, source_id, added_by, context_scope)
		SELECT $1, rcf.source_id, $2, 'persistent'
		FROM repository_contexts rc
		JOIN repository_context_files rcf ON rcf.context_id = rc.id
		WHERE rc.scope_type = 'user'
		  AND rc.scope_id = $2
		  AND NOT (rc.status = 'failed' AND rc.file_count = 0)
		ON CONFLICT (conversation_id, source_id) DO UPDATE SET context_scope = 'persistent'`, conversationID, userID)
	return err
}

func (a *App) createRepositoryContext(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	var repositoryStorageReady bool
	if err := a.DB.QueryRowContext(c, `
		SELECT to_regclass('public.repository_contexts') IS NOT NULL
		   AND to_regclass('public.repository_context_files') IS NOT NULL
		   AND to_regclass('public.conversation_repository_contexts') IS NOT NULL`).Scan(&repositoryStorageReady); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !repositoryStorageReady {
		writeError(c, http.StatusServiceUnavailable, fmt.Errorf("repository storage is not initialized; restart the backend to apply database migrations"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	var request repositoryContextRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.URL = strings.TrimSpace(request.URL)
	request.Ref = strings.TrimSpace(request.Ref)
	request.AccessToken = strings.TrimSpace(request.AccessToken)
	if len(request.AccessToken) > 4096 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("access token is too long"))
		return
	}
	spec, err := repository.ParseURL(request.URL, request.Ref)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var encryptedToken []byte
	if request.AccessToken != "" {
		encryptedToken, err = a.Secrets.Encrypt(request.AccessToken)
		if err != nil {
			writeError(c, http.StatusInternalServerError, fmt.Errorf("repository credential could not be protected"))
			return
		}
	}
	title := spec.ProjectPath
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var repositoryID uuid.UUID
	var repositoryStatus string
	var repositoryFileCount int
	err = transaction.QueryRowContext(c, `
		INSERT INTO repository_contexts
			(id, conversation_id, scope_type, scope_id, provider, repository_url, owner, repository, ref, title, encrypted_credential, created_by)
		VALUES ($1, NULL, 'user', $2, $3, $4, $5, $6, $7, $8, $9, $2)
		ON CONFLICT (scope_type, scope_id, provider, repository_url, ref) DO UPDATE
		SET encrypted_credential = CASE
				WHEN EXCLUDED.encrypted_credential IS NOT NULL
				THEN EXCLUDED.encrypted_credential
				ELSE repository_contexts.encrypted_credential
			END,
			status = CASE
				WHEN repository_contexts.status = 'failed' AND repository_contexts.file_count = 0 THEN 'queued'
				ELSE repository_contexts.status
			END,
			error_message = CASE
				WHEN repository_contexts.status = 'failed' AND repository_contexts.file_count = 0 THEN NULL
				ELSE repository_contexts.error_message
			END,
			updated_at = now()
		RETURNING id, status, file_count`,
		uuid.New(), principal.UserID, string(spec.Provider), spec.RepositoryURL, spec.Owner, spec.Repository, spec.Ref, title, encryptedToken,
	).Scan(&repositoryID, &repositoryStatus, &repositoryFileCount)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `
		INSERT INTO conversation_repository_contexts (conversation_id, context_id, added_by, context_scope)
		VALUES ($1, $2, $3, 'persistent')
		ON CONFLICT (conversation_id, context_id) DO UPDATE SET context_scope = 'persistent'`, conversationID, repositoryID, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `
		INSERT INTO conversation_knowledge_sources (conversation_id, source_id, added_by, context_scope)
		SELECT $1, rcf.source_id, $2, 'persistent'
		FROM repository_context_files rcf
		WHERE rcf.context_id = $3
		ON CONFLICT (conversation_id, source_id) DO UPDATE SET context_scope = 'persistent'`, conversationID, principal.UserID, repositoryID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}

	// Provider reads can involve one request per file. Return the context
	// immediately and let the bounded background import populate Knowledge/RAG.
	if repositoryFileCount == 0 && repositoryStatus == "queued" {
		go a.populateRepository(repositoryID)
	}
	item, err := a.getRepositoryContext(c, conversationID, repositoryID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (a *App) populateRepository(repositoryID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), repositoryImportTimeout)
	defer cancel()
	if a.repositoryImportSlots != nil {
		select {
		case a.repositoryImportSlots <- struct{}{}:
		case <-ctx.Done():
			return
		}
		defer func() { <-a.repositoryImportSlots }()
	}
	var provider, repositoryURL, ref string
	var encryptedToken []byte
	claim, err := a.DB.ExecContext(ctx, `UPDATE repository_contexts SET status = 'processing', updated_at = now() WHERE id = $1 AND status = 'queued' AND file_count = 0`, repositoryID)
	if err != nil {
		logRepositoryImportError(repositoryID, "claim repository context", "", err)
		return
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed != 1 {
		if err != nil {
			logRepositoryImportError(repositoryID, "claim repository context", "", err)
		}
		return
	}
	if err := a.DB.QueryRowContext(ctx, `SELECT provider, repository_url, ref, encrypted_credential FROM repository_contexts WHERE id = $1`, repositoryID).Scan(&provider, &repositoryURL, &ref, &encryptedToken); err != nil {
		a.markRepositoryImportFailed(repositoryID, "load repository context", "", err)
		return
	}
	accessToken := ""
	if len(encryptedToken) > 0 {
		accessToken, err = a.Secrets.Decrypt(encryptedToken)
		if err != nil {
			a.markRepositoryFailed(repositoryID, "repository credential could not be decrypted")
			return
		}
	}
	spec, err := repository.ParseURL(repositoryURL, ref)
	if err != nil || string(spec.Provider) != provider {
		a.markRepositoryFailed(repositoryID, "repository context is invalid")
		return
	}
	snapshot, err := repository.NewClientWithLimits(repository.Limits{
		MaxFiles: a.Config.RepositoryMaxFiles,
	}).Fetch(ctx, spec, accessToken)
	if err != nil {
		a.markRepositoryFailed(repositoryID, err.Error())
		return
	}
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		a.markRepositoryImportFailed(repositoryID, "begin repository import transaction", "", err)
		return
	}
	defer transaction.Rollback()
	failTransaction := func(operation, path string, cause error) {
		_ = transaction.Rollback()
		a.markRepositoryImportFailed(repositoryID, operation, path, cause)
	}
	var userID uuid.UUID
	if err := transaction.QueryRowContext(ctx, `SELECT scope_id FROM repository_contexts WHERE id = $1 FOR UPDATE`, repositoryID).Scan(&userID); err != nil {
		failTransaction("load repository context for import", "", err)
		return
	}
	if len(snapshot.Files) == 0 {
		_, _ = transaction.ExecContext(ctx, `UPDATE repository_contexts SET status = 'failed', error_message = 'repository contains no supported text files', updated_at = now() WHERE id = $1`, repositoryID)
		_ = transaction.Commit()
		return
	}
	for _, file := range snapshot.Files {
		sourceID := uuid.New()
		jobID := uuid.New()
		title := spec.ProjectPath + " · " + file.Path
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO knowledge_sources
				(id, scope_type, scope_id, conversation_id, title, source_type, source_url, mime_type, content, content_hash, created_by)
			VALUES ($1, 'user', $2, NULL, $3, 'repository', $4, 'text/plain', $5, $6, $2)`,
			sourceID, userID, title, file.URL, file.Content, file.Hash,
		); err != nil {
			failTransaction("store repository file", file.Path, err)
			return
		}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO ingestion_jobs (id, source_id) VALUES ($1, $2)`, jobID, sourceID); err != nil {
			failTransaction("create repository indexing job", file.Path, err)
			return
		}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO repository_context_files (context_id, source_id, path, size_bytes, content_hash) VALUES ($1, $2, $3, $4, $5)`, repositoryID, sourceID, file.Path, file.Size, file.Hash); err != nil {
			failTransaction("store repository file metadata", file.Path, err)
			return
		}
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO conversation_knowledge_sources (conversation_id, source_id, added_by, context_scope)
		SELECT crc.conversation_id, rcf.source_id, COALESCE(crc.added_by, $2), 'persistent'
		FROM conversation_repository_contexts crc
		JOIN repository_context_files rcf ON rcf.context_id = crc.context_id
		WHERE crc.context_id = $1
		ON CONFLICT (conversation_id, source_id) DO UPDATE SET context_scope = 'persistent'`, repositoryID, userID); err != nil {
		failTransaction("store repository context mapping", "", err)
		return
	}
	if _, err := transaction.ExecContext(ctx, `
		UPDATE repository_contexts
		SET status = 'processing', resolved_ref = NULLIF($2, ''), file_count = $3,
			skipped_file_count = $4, total_bytes = $5, error_message = NULL, updated_at = now()
		WHERE id = $1`, repositoryID, snapshot.ResolvedRef, len(snapshot.Files), snapshot.SkippedFileCount, snapshot.TotalBytes); err != nil {
		failTransaction("finalize repository context", "", err)
		return
	}
	if err := transaction.Commit(); err != nil {
		a.markRepositoryImportFailed(repositoryID, "commit repository import", "", err)
	}
}

func (a *App) markRepositoryImportFailed(repositoryID uuid.UUID, operation, path string, cause error) {
	logRepositoryImportError(repositoryID, operation, path, cause)
	a.markRepositoryFailed(repositoryID, repositoryFailureMessage(operation, cause))
}

func logRepositoryImportError(repositoryID uuid.UUID, operation, path string, cause error) {
	if cause == nil {
		return
	}
	args := []any{
		"repositoryId", repositoryID,
		"operation", operation,
	}
	if path != "" {
		args = append(args, "path", path)
	}
	var postgresError *pq.Error
	if errors.As(cause, &postgresError) {
		args = append(args, "sqlState", string(postgresError.Code))
		if postgresError.Constraint != "" {
			args = append(args, "constraint", postgresError.Constraint)
		}
	}
	args = append(args, "error", cause)
	slog.Error("repository import database operation failed", args...)
}

func repositoryFailureMessage(operation string, cause error) string {
	var postgresError *pq.Error
	if errors.As(cause, &postgresError) {
		switch string(postgresError.Code) {
		case "42P01", "42703":
			return "repository storage is out of date. Restart the backend to apply database migrations, then try again"
		case "23505":
			return "repository returned duplicate file metadata. Try a narrower ref or try again"
		case "23503":
			return "repository file metadata could not be linked to the imported file. Try again"
		}
	}
	switch operation {
	case "store repository file metadata":
		return "repository file metadata could not be stored. Check the backend logs and try again"
	case "store repository file":
		return "repository file could not be stored. Check the backend logs and try again"
	case "create repository indexing job":
		return "repository indexing job could not be created. Check the backend logs and try again"
	case "store repository context mapping":
		return "repository context mapping could not be stored. Check the backend logs and try again"
	case "finalize repository context", "commit repository import":
		return "repository context could not be finalized. Check the backend logs and try again"
	default:
		return "repository import could not be completed. Check the backend logs and try again"
	}
}

func (a *App) markRepositoryFailed(repositoryID uuid.UUID, message string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = a.DB.ExecContext(ctx, `UPDATE repository_contexts SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, repositoryID, message)
}

// StartRepositoryWorker recovers queued imports after a backend restart. The
// request handler also starts an import immediately, while this small queue
// keeps a successful 202 response from leaving a repository stranded if the
// process exits between creating the row and starting its goroutine.
func (a *App) StartRepositoryWorker(ctx context.Context) {
	go func() {
		a.repairPopulatedRepositoryContexts(ctx)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				repositoryID, ok := a.nextRepositoryImport(ctx)
				if ok {
					go a.populateRepository(repositoryID)
				}
			}
		}
	}()
}

func (a *App) repairPopulatedRepositoryContexts(ctx context.Context) {
	_, err := a.DB.ExecContext(ctx, `
		UPDATE repository_contexts rc
		SET status = 'processing', error_message = NULL, updated_at = now()
		WHERE rc.status = 'failed'
		  AND rc.file_count > 0
		  AND rc.file_count = (
			SELECT COUNT(*)
			FROM repository_context_files rcf
			WHERE rcf.context_id = rc.id
		  )
		  AND rc.file_count = (
			SELECT COUNT(*)
			FROM repository_context_files rcf
			JOIN knowledge_sources ks ON ks.id = rcf.source_id
			WHERE rcf.context_id = rc.id
		  )
		  AND NOT EXISTS (
			SELECT 1
			FROM repository_context_files rcf
			JOIN knowledge_sources ks ON ks.id = rcf.source_id
			WHERE rcf.context_id = rc.id AND ks.status = 'failed'
		  )`)
	if err != nil {
		slog.Error("repository context repair failed", "error", err)
	}
}

func (a *App) nextRepositoryImport(ctx context.Context) (uuid.UUID, bool) {
	transaction, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, false
	}
	defer transaction.Rollback()
	// A process can die after claiming a row. Imports are bounded to five
	// minutes, so a ten-minute stale processing row is safe to retry.
	_, _ = transaction.ExecContext(ctx, `UPDATE repository_contexts SET status = 'queued', updated_at = now() WHERE status = 'processing' AND file_count = 0 AND updated_at < now() - interval '10 minutes'`)
	var repositoryID uuid.UUID
	if err := transaction.QueryRowContext(ctx, `SELECT id FROM repository_contexts WHERE status = 'queued' AND file_count = 0 ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&repositoryID); err != nil {
		if err == sql.ErrNoRows {
			return uuid.Nil, false
		}
		return uuid.Nil, false
	}
	if err := transaction.Commit(); err != nil {
		return uuid.Nil, false
	}
	return repositoryID, true
}

func (a *App) loadConversationRepositories(c *gin.Context, conversationID uuid.UUID, result *models.ConversationContext) error {
	rows, err := a.DB.QueryContext(c, repositoryContextQuery+` WHERE crc.conversation_id = $1 ORDER BY crc.created_at`, conversationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanRepositoryContext(rows)
		if err != nil {
			return err
		}
		result.Repositories = append(result.Repositories, item)
	}
	return rows.Err()
}

func (a *App) listUserRepositoryContexts(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	rows, err := a.DB.QueryContext(c, repositoryLibraryContextQuery, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	result := make([]models.RepositoryContext, 0)
	for rows.Next() {
		item, scanErr := scanRepositoryContext(rows)
		if scanErr != nil {
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"repositories": result})
}

func (a *App) getRepositoryContext(ctx context.Context, conversationID, repositoryID uuid.UUID) (models.RepositoryContext, error) {
	row := a.DB.QueryRowContext(ctx, repositoryContextQuery+` WHERE crc.conversation_id = $1 AND rc.id = $2`, conversationID, repositoryID)
	return scanRepositoryContext(row)
}

const repositoryContextQuery = `
	SELECT rc.id, rc.conversation_id, rc.scope_type, rc.scope_id, rc.provider,
	       rc.repository_url, rc.owner, rc.repository, rc.ref,
	       COALESCE(rc.resolved_ref, ''), rc.title, crc.context_scope,
	       CASE
	         WHEN rc.status = 'failed' THEN 'failed'
	         WHEN COALESCE(stats.file_count, 0) = 0 THEN rc.status
	         WHEN stats.failed_count > 0 THEN 'failed'
	         WHEN stats.ready_count = stats.file_count THEN 'ready'
	         ELSE 'processing'
	       END,
	       COALESCE(rc.error_message, CASE WHEN COALESCE(stats.failed_count, 0) > 0 THEN 'One or more repository files failed to index' ELSE '' END),
	       COALESCE(stats.file_count, 0), COALESCE(stats.ready_count, 0),
	       rc.skipped_file_count, rc.total_bytes,
	       CASE WHEN COALESCE(stats.file_count, 0) = 0 THEN 0 ELSE COALESCE(stats.progress, 0) END,
	       rc.created_at, rc.updated_at
	FROM repository_contexts rc
	JOIN conversation_repository_contexts crc ON crc.context_id = rc.id
	LEFT JOIN LATERAL (
		SELECT COUNT(*)::int AS file_count,
		       COUNT(*) FILTER (WHERE ks.status = 'ready')::int AS ready_count,
		       COUNT(*) FILTER (WHERE ks.status = 'failed')::int AS failed_count,
		       ROUND(AVG(COALESCE(ij.progress, 0)))::int AS progress
		FROM repository_context_files rcf
		JOIN knowledge_sources ks ON ks.id = rcf.source_id
		LEFT JOIN LATERAL (
			SELECT progress
			FROM ingestion_jobs
			WHERE source_id = ks.id
			ORDER BY created_at DESC, id DESC
			LIMIT 1
		) ij ON TRUE
		WHERE rcf.context_id = rc.id
	) stats ON TRUE`

const repositoryLibraryContextQuery = `
	SELECT rc.id, rc.conversation_id, rc.scope_type, rc.scope_id, rc.provider,
	       rc.repository_url, rc.owner, rc.repository, rc.ref,
	       COALESCE(rc.resolved_ref, ''), rc.title, 'persistent',
	       CASE
	         WHEN rc.status = 'failed' THEN 'failed'
	         WHEN COALESCE(stats.file_count, 0) = 0 THEN rc.status
	         WHEN stats.failed_count > 0 THEN 'failed'
	         WHEN stats.ready_count = stats.file_count THEN 'ready'
	         ELSE 'processing'
	       END,
	       COALESCE(rc.error_message, CASE WHEN COALESCE(stats.failed_count, 0) > 0 THEN 'One or more repository files failed to index' ELSE '' END),
	       COALESCE(stats.file_count, 0), COALESCE(stats.ready_count, 0),
	       rc.skipped_file_count, rc.total_bytes,
	       CASE WHEN COALESCE(stats.file_count, 0) = 0 THEN 0 ELSE COALESCE(stats.progress, 0) END,
	       rc.created_at, rc.updated_at
	FROM repository_contexts rc
	LEFT JOIN LATERAL (
		SELECT COUNT(*)::int AS file_count,
		       COUNT(*) FILTER (WHERE ks.status = 'ready')::int AS ready_count,
		       COUNT(*) FILTER (WHERE ks.status = 'failed')::int AS failed_count,
		       ROUND(AVG(COALESCE(ij.progress, 0)))::int AS progress
		FROM repository_context_files rcf
		JOIN knowledge_sources ks ON ks.id = rcf.source_id
		LEFT JOIN LATERAL (
			SELECT progress
			FROM ingestion_jobs
			WHERE source_id = ks.id
			ORDER BY created_at DESC, id DESC
			LIMIT 1
		) ij ON TRUE
		WHERE rcf.context_id = rc.id
	) stats ON TRUE
	WHERE rc.scope_type = 'user' AND rc.scope_id = $1
	ORDER BY rc.updated_at DESC, rc.created_at DESC`

func scanRepositoryContext(scanner interface{ Scan(dest ...any) error }) (models.RepositoryContext, error) {
	var item models.RepositoryContext
	var conversationID sql.NullString
	if err := scanner.Scan(
		&item.ID, &conversationID, &item.ScopeType, &item.ScopeID,
		&item.Provider, &item.RepositoryURL, &item.Owner, &item.Repository,
		&item.Ref, &item.ResolvedRef, &item.Title, &item.ContextScope,
		&item.Status, &item.Error, &item.FileCount, &item.ReadyFileCount,
		&item.SkippedFileCount, &item.TotalBytes, &item.Progress,
		&item.CreatedAt, &item.UpdatedAt,
	); err != nil {
		return item, err
	}
	item.ConversationID = parseOptionalUUIDString(conversationID.String)
	return item, nil
}

func (a *App) deleteRepositoryContext(c *gin.Context) {
	conversationID, err := a.authorizeConversation(c, c.Param("id"))
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}
	repositoryID, err := uuid.Parse(c.Param("repositoryId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid repository context id"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var available bool
	if err := transaction.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM repository_contexts rc JOIN conversation_repository_contexts crc ON crc.context_id = rc.id WHERE rc.id = $1 AND crc.conversation_id = $2 AND rc.scope_type = 'user' AND rc.scope_id = $3)`, repositoryID, conversationID, principal.UserID).Scan(&available); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !available {
		writeError(c, http.StatusNotFound, fmt.Errorf("repository context not found"))
		return
	}
	if _, err := transaction.ExecContext(c, `
		DELETE FROM conversation_knowledge_sources cks
		USING repository_context_files rcf
		WHERE cks.conversation_id = $1
		  AND cks.source_id = rcf.source_id
		  AND rcf.context_id = $2`, conversationID, repositoryID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if _, err := transaction.ExecContext(c, `DELETE FROM conversation_repository_contexts WHERE conversation_id = $1 AND context_id = $2`, conversationID, repositoryID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}
