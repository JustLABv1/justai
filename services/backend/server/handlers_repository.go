package server

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
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

var errRepositoryProcessing = errors.New("repository is currently processing")

type repositoryContextRequest struct {
	URL             string   `json:"url"`
	Ref             string   `json:"ref"`
	AccessToken     string   `json:"accessToken"`
	IncludePatterns []string `json:"includePatterns"`
	ExcludePatterns []string `json:"excludePatterns"`
	// IncludePaths and ExcludePaths are accepted as friendly aliases for
	// clients that describe these values as path globs rather than patterns.
	IncludePaths     []string `json:"includePaths"`
	ExcludePaths     []string `json:"excludePaths"`
	MaxFileBytes     *int64   `json:"maxFileBytes"`
	MaxFileSizeBytes *int64   `json:"maxFileSizeBytes"`
	HonorGitignore   *bool    `json:"honorGitignore"`
}

type knowledgeRepositoryRequest struct {
	URL              string   `json:"url"`
	Ref              string   `json:"ref"`
	AccessToken      string   `json:"accessToken"`
	SpaceID          string   `json:"spaceId"`
	IncludePatterns  []string `json:"includePatterns"`
	ExcludePatterns  []string `json:"excludePatterns"`
	IncludePaths     []string `json:"includePaths"`
	ExcludePaths     []string `json:"excludePaths"`
	MaxFileBytes     *int64   `json:"maxFileBytes"`
	MaxFileSizeBytes *int64   `json:"maxFileSizeBytes"`
	HonorGitignore   *bool    `json:"honorGitignore"`
}

type repositoryIndexingConfig struct {
	IncludePatterns []string
	ExcludePatterns []string
	MaxFileBytes    int64
	HonorGitignore  bool
}

const maxRepositoryPatterns = 64

func repositoryConfigInput(includePatterns, includePaths, excludePatterns, excludePaths []string, maxFileBytes *int64, honorGitignore *bool) (repositoryIndexingConfig, error) {
	include := append(append([]string(nil), includePatterns...), includePaths...)
	exclude := append(append([]string(nil), excludePatterns...), excludePaths...)
	include, err := normalizeRepositoryPatterns(include, "include")
	if err != nil {
		return repositoryIndexingConfig{}, err
	}
	exclude, err = normalizeRepositoryPatterns(exclude, "exclude")
	if err != nil {
		return repositoryIndexingConfig{}, err
	}
	maxBytes := int64(repository.MaxFileBytes)
	if maxFileBytes != nil {
		maxBytes = *maxFileBytes
		if maxBytes == 0 {
			maxBytes = int64(repository.MaxFileBytes)
		}
	}
	if maxBytes < 1 || maxBytes > repository.MaxConfigurableFileBytes {
		return repositoryIndexingConfig{}, fmt.Errorf("maxFileBytes must be between 1 and %d bytes", repository.MaxConfigurableFileBytes)
	}
	honor := true
	if honorGitignore != nil {
		honor = *honorGitignore
	}
	return repositoryIndexingConfig{
		IncludePatterns: include,
		ExcludePatterns: exclude,
		MaxFileBytes:    maxBytes,
		HonorGitignore:  honor,
	}, nil
}

func repositoryMaxFileBytes(maxFileBytes, maxFileSizeBytes *int64) *int64 {
	if maxFileBytes != nil {
		return maxFileBytes
	}
	return maxFileSizeBytes
}

func normalizeRepositoryPatterns(values []string, kind string) ([]string, error) {
	if len(values) > maxRepositoryPatterns {
		return nil, fmt.Errorf("%s patterns cannot contain more than %d entries", kind, maxRepositoryPatterns)
	}
	result := make([]string, 0, len(values))
	for _, raw := range values {
		pattern := strings.TrimSpace(raw)
		if pattern == "" {
			continue
		}
		if len(pattern) > 256 || strings.ContainsAny(pattern, "\\\x00\r\n") {
			return nil, fmt.Errorf("%s pattern is invalid or too long", kind)
		}
		if strings.HasPrefix(pattern, "!") {
			return nil, fmt.Errorf("%s patterns cannot contain negation", kind)
		}
		duplicate := false
		for _, existing := range result {
			if existing == pattern {
				duplicate = true
				break
			}
		}
		if !duplicate {
			result = append(result, pattern)
		}
	}
	return result, nil
}

func repositoryConfigEqual(left, right repositoryIndexingConfig) bool {
	if left.MaxFileBytes != right.MaxFileBytes || left.HonorGitignore != right.HonorGitignore || len(left.IncludePatterns) != len(right.IncludePatterns) || len(left.ExcludePatterns) != len(right.ExcludePatterns) {
		return false
	}
	for index := range left.IncludePatterns {
		if left.IncludePatterns[index] != right.IncludePatterns[index] {
			return false
		}
	}
	for index := range left.ExcludePatterns {
		if left.ExcludePatterns[index] != right.ExcludePatterns[index] {
			return false
		}
	}
	return true
}

type repositoryContextExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// attachUserRepositories makes a newly created conversation inherit the
// user's repository library for that conversation's organization. It only
// creates mappings; repository rows, files, and ingestion jobs remain shared
// and are never re-fetched across an organization boundary.
func attachUserRepositories(ctx context.Context, execer repositoryContextExecer, conversationID, userID uuid.UUID) error {
	if _, err := execer.ExecContext(ctx, `
		INSERT INTO conversation_repository_contexts (conversation_id, context_id, added_by, context_scope)
		SELECT $1, rc.id, $2, 'persistent'
		FROM repository_contexts rc
		JOIN conversations c ON c.id = $1 AND c.user_id = $2
		JOIN knowledge_items ki ON ki.resource_type = 'repository' AND ki.resource_id = rc.id
		WHERE rc.scope_type = 'user'
		  AND rc.scope_id = $2
		  AND ki.organization_id = c.organization_id
		  AND (ki.visibility = 'workspace' OR ki.owner_id = c.user_id)
		  AND NOT (rc.status = 'failed' AND rc.file_count = 0)
		ON CONFLICT (conversation_id, context_id) DO NOTHING`, conversationID, userID); err != nil {
		return err
	}
	_, err := execer.ExecContext(ctx, `
		INSERT INTO conversation_knowledge_sources (conversation_id, source_id, added_by, context_scope)
		SELECT $1, rcf.source_id, $2, 'persistent'
		FROM repository_contexts rc
		JOIN repository_context_files rcf ON rcf.context_id = rc.id
		JOIN conversations c ON c.id = $1 AND c.user_id = $2
		JOIN knowledge_items ki ON ki.resource_type = 'source' AND ki.resource_id = rcf.source_id
		WHERE rc.scope_type = 'user'
		  AND rc.scope_id = $2
		  AND ki.organization_id = c.organization_id
		  AND (ki.visibility = 'workspace' OR ki.owner_id = c.user_id)
		  AND NOT (rc.status = 'failed' AND rc.file_count = 0)
		ON CONFLICT (conversation_id, source_id) DO UPDATE SET context_scope = 'persistent'`, conversationID, userID)
	return err
}

type repositoryUpsertResult struct {
	ID        uuid.UUID
	Status    string
	FileCount int
}

// upsertRepositoryContext centralizes repository creation for both the
// conversation attachment and Knowledge library flows. If a reconnect changes
// indexing policy, the previous snapshot is removed in the same transaction so
// the new policy can never be reported as applied while old files remain.
func (a *App) upsertRepositoryContext(ctx context.Context, transaction *sql.Tx, userID uuid.UUID, spec repository.Spec, title string, encryptedToken []byte, config repositoryIndexingConfig) (repositoryUpsertResult, error) {
	var previous repositoryIndexingConfig
	var previousID uuid.UUID
	previousErr := transaction.QueryRowContext(ctx, `
		SELECT id, include_patterns, exclude_patterns, max_file_bytes, honor_gitignore
		FROM repository_contexts
		WHERE scope_type='user' AND scope_id=$1 AND provider=$2 AND repository_url=$3 AND ref=$4
		FOR UPDATE`, userID, string(spec.Provider), spec.RepositoryURL, spec.Ref).Scan(
		&previousID, pq.Array(&previous.IncludePatterns), pq.Array(&previous.ExcludePatterns), &previous.MaxFileBytes, &previous.HonorGitignore)
	if previousErr != nil && previousErr != sql.ErrNoRows {
		return repositoryUpsertResult{}, previousErr
	}

	var result repositoryUpsertResult
	err := transaction.QueryRowContext(ctx, `
		INSERT INTO repository_contexts
			(id, conversation_id, scope_type, scope_id, provider, repository_url, owner, repository, ref, title, encrypted_credential, include_patterns, exclude_patterns, max_file_bytes, honor_gitignore, created_by)
		VALUES ($1, NULL, 'user', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $2)
		ON CONFLICT (scope_type, scope_id, provider, repository_url, ref) DO UPDATE
		SET encrypted_credential = CASE
				WHEN EXCLUDED.encrypted_credential IS NOT NULL THEN EXCLUDED.encrypted_credential
				ELSE repository_contexts.encrypted_credential
			END,
			include_patterns = EXCLUDED.include_patterns,
			exclude_patterns = EXCLUDED.exclude_patterns,
			max_file_bytes = EXCLUDED.max_file_bytes,
			honor_gitignore = EXCLUDED.honor_gitignore,
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
		uuid.New(), userID, string(spec.Provider), spec.RepositoryURL, spec.Owner, spec.Repository, spec.Ref, title, encryptedToken,
		pq.Array(config.IncludePatterns), pq.Array(config.ExcludePatterns), config.MaxFileBytes, config.HonorGitignore,
	).Scan(&result.ID, &result.Status, &result.FileCount)
	if err != nil {
		return repositoryUpsertResult{}, err
	}

	if previousErr == nil && previousID == result.ID && !repositoryConfigEqual(previous, config) {
		if err := queueRepositorySyncTx(ctx, transaction, result.ID); err != nil {
			return repositoryUpsertResult{}, err
		}
		result.Status = "queued"
		result.FileCount = 0
	}
	return result, nil
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
	indexingConfig, err := repositoryConfigInput(request.IncludePatterns, request.IncludePaths, request.ExcludePatterns, request.ExcludePaths, repositoryMaxFileBytes(request.MaxFileBytes, request.MaxFileSizeBytes), request.HonorGitignore)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
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
	result, err := a.upsertRepositoryContext(c, transaction, principal.UserID, spec, title, encryptedToken, indexingConfig)
	if err != nil {
		if strings.Contains(err.Error(), "currently processing") {
			writeError(c, http.StatusConflict, err)
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	repositoryID, repositoryStatus, repositoryFileCount := result.ID, result.Status, result.FileCount
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

// createKnowledgeRepository adds a repository directly to the user's
// Knowledge library. Conversation mappings are intentionally not required;
// automatic context retrieves the indexed files through their catalog item.
func (a *App) createKnowledgeRepository(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var storageReady bool
	if err := a.DB.QueryRowContext(c, `
		SELECT to_regclass('public.repository_contexts') IS NOT NULL
		   AND to_regclass('public.repository_context_files') IS NOT NULL`).Scan(&storageReady); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !storageReady {
		writeError(c, http.StatusServiceUnavailable, fmt.Errorf("repository storage is not initialized; restart the backend to apply database migrations"))
		return
	}
	var request knowledgeRepositoryRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.URL = strings.TrimSpace(request.URL)
	request.Ref = strings.TrimSpace(request.Ref)
	request.AccessToken = strings.TrimSpace(request.AccessToken)
	indexingConfig, err := repositoryConfigInput(request.IncludePatterns, request.IncludePaths, request.ExcludePatterns, request.ExcludePaths, repositoryMaxFileBytes(request.MaxFileBytes, request.MaxFileSizeBytes), request.HonorGitignore)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
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
	var requestedSpaceID uuid.UUID
	var requestedSpaceVisibility string
	if strings.TrimSpace(request.SpaceID) != "" {
		requestedSpaceID, err = uuid.Parse(strings.TrimSpace(request.SpaceID))
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid space id"))
			return
		}
		if err := a.DB.QueryRowContext(c, `SELECT visibility FROM workspace_projects WHERE id=$1 AND organization_id=$2 AND user_id=$3`, requestedSpaceID, organizationID, principal.UserID).Scan(&requestedSpaceVisibility); err == sql.ErrNoRows {
			writeError(c, http.StatusNotFound, fmt.Errorf("space not found or not manageable"))
			return
		} else if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if requestedSpaceVisibility == "workspace" {
			writeError(c, http.StatusForbidden, fmt.Errorf("private repositories cannot be added to a workspace space"))
			return
		}
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	result, err := a.upsertRepositoryContext(c, transaction, principal.UserID, spec, spec.ProjectPath, encryptedToken, indexingConfig)
	if err != nil {
		if strings.Contains(err.Error(), "currently processing") {
			writeError(c, http.StatusConflict, err)
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	repositoryID, repositoryStatus, repositoryFileCount := result.ID, result.Status, result.FileCount
	if requestedSpaceID != uuid.Nil {
		if syncErr := a.syncKnowledgeCatalog(c); syncErr != nil {
			writeError(c, http.StatusInternalServerError, syncErr)
			return
		}
		var itemID uuid.UUID
		if err := a.DB.QueryRowContext(c, `SELECT id FROM knowledge_items WHERE resource_type='repository' AND resource_id=$1 AND organization_id=$2`, repositoryID, organizationID).Scan(&itemID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if _, err := a.DB.ExecContext(c, `INSERT INTO knowledge_space_items (space_id,item_id,added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, requestedSpaceID, itemID, principal.UserID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if repositoryFileCount == 0 && repositoryStatus == "queued" {
		go a.populateRepository(repositoryID)
	}
	c.JSON(http.StatusAccepted, gin.H{
		"repositoryId":     repositoryID,
		"status":           repositoryStatus,
		"fileCount":        repositoryFileCount,
		"includePatterns":  indexingConfig.IncludePatterns,
		"excludePatterns":  indexingConfig.ExcludePatterns,
		"maxFileBytes":     indexingConfig.MaxFileBytes,
		"maxFileSizeBytes": indexingConfig.MaxFileBytes,
		"honorGitignore":   indexingConfig.HonorGitignore,
	})
}

func (a *App) syncKnowledgeRepository(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	repositoryID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid repository id"))
		return
	}
	if err := a.queueRepositorySync(c, repositoryID, principal.UserID, organizationID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(c, http.StatusNotFound, fmt.Errorf("repository not found"))
			return
		}
		if errors.Is(err, errRepositoryProcessing) {
			c.JSON(http.StatusAccepted, gin.H{
				"repositoryId":   repositoryID,
				"status":         "processing",
				"alreadyRunning": true,
			})
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	go a.populateRepository(repositoryID)
	c.JSON(http.StatusAccepted, gin.H{"repositoryId": repositoryID, "status": "queued"})
}

func (a *App) updateKnowledgeRepositorySchedule(c *gin.Context) {
	principal, _, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	repositoryID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid repository id"))
		return
	}
	var request struct {
		IntervalMinutes int `json:"intervalMinutes"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	if request.IntervalMinutes < 0 || request.IntervalMinutes > 10080 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("intervalMinutes must be between 0 and 10080"))
		return
	}
	var nextSyncAt *time.Time
	var status string
	err = a.DB.QueryRowContext(c, `
		UPDATE repository_contexts
		SET sync_interval_minutes = $3,
		    next_sync_at = CASE WHEN $3 = 0 THEN NULL ELSE now() + ($3::double precision * interval '1 minute') END,
		    updated_at = now()
		WHERE id = $1 AND scope_type='user' AND scope_id=$2
		RETURNING status, next_sync_at`, repositoryID, principal.UserID, request.IntervalMinutes).Scan(&status, &nextSyncAt)
	if err == sql.ErrNoRows {
		writeError(c, http.StatusNotFound, fmt.Errorf("repository not found"))
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"repositoryId": repositoryID, "status": status, "intervalMinutes": request.IntervalMinutes, "nextSyncAt": nextSyncAt})
}

func (a *App) updateKnowledgeRepositoryConfig(c *gin.Context) {
	principal, _, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	repositoryID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid repository id"))
		return
	}
	var request struct {
		IncludePatterns  []string `json:"includePatterns"`
		ExcludePatterns  []string `json:"excludePatterns"`
		IncludePaths     []string `json:"includePaths"`
		ExcludePaths     []string `json:"excludePaths"`
		MaxFileBytes     *int64   `json:"maxFileBytes"`
		MaxFileSizeBytes *int64   `json:"maxFileSizeBytes"`
		HonorGitignore   *bool    `json:"honorGitignore"`
	}
	if !decodeJSON(c, &request) {
		return
	}

	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var current repositoryIndexingConfig
	if err := transaction.QueryRowContext(c, `
		SELECT include_patterns, exclude_patterns, max_file_bytes, honor_gitignore
		FROM repository_contexts
		WHERE id=$1 AND scope_type='user' AND scope_id=$2
		FOR UPDATE`, repositoryID, principal.UserID).Scan(
		pq.Array(&current.IncludePatterns), pq.Array(&current.ExcludePatterns), &current.MaxFileBytes, &current.HonorGitignore); err != nil {
		if err == sql.ErrNoRows {
			writeError(c, http.StatusNotFound, fmt.Errorf("repository not found"))
			return
		}
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	// PATCH semantics: omitted properties preserve the existing policy. Empty
	// arrays explicitly clear user patterns; safe built-in exclusions still
	// apply in the importer.
	includePatterns := current.IncludePatterns
	if request.IncludePatterns != nil || request.IncludePaths != nil {
		includePatterns = append(append([]string(nil), request.IncludePatterns...), request.IncludePaths...)
	}
	excludePatterns := current.ExcludePatterns
	if request.ExcludePatterns != nil || request.ExcludePaths != nil {
		excludePatterns = append(append([]string(nil), request.ExcludePatterns...), request.ExcludePaths...)
	}
	maxFileBytes := current.MaxFileBytes
	if requestedMaxFileBytes := repositoryMaxFileBytes(request.MaxFileBytes, request.MaxFileSizeBytes); requestedMaxFileBytes != nil {
		maxFileBytes = *requestedMaxFileBytes
	}
	honorGitignore := current.HonorGitignore
	if request.HonorGitignore != nil {
		honorGitignore = *request.HonorGitignore
	}
	updated, err := repositoryConfigInput(includePatterns, nil, excludePatterns, nil, &maxFileBytes, &honorGitignore)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	changed := !repositoryConfigEqual(current, updated)
	if changed {
		if err := queueRepositorySyncTx(c, transaction, repositoryID, principal.UserID); err != nil {
			if strings.Contains(err.Error(), "currently processing") {
				writeError(c, http.StatusConflict, err)
				return
			}
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	var status string
	var fileCount int
	if err := transaction.QueryRowContext(c, `
		UPDATE repository_contexts
		SET include_patterns=$2, exclude_patterns=$3, max_file_bytes=$4,
		    honor_gitignore=$5, updated_at=now()
		WHERE id=$1
		RETURNING status, file_count`, repositoryID, pq.Array(updated.IncludePatterns), pq.Array(updated.ExcludePatterns), updated.MaxFileBytes, updated.HonorGitignore).Scan(&status, &fileCount); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if changed {
		go a.populateRepository(repositoryID)
	}
	c.JSON(http.StatusOK, gin.H{
		"repositoryId":     repositoryID,
		"status":           status,
		"fileCount":        fileCount,
		"changed":          changed,
		"includePatterns":  updated.IncludePatterns,
		"excludePatterns":  updated.ExcludePatterns,
		"maxFileBytes":     updated.MaxFileBytes,
		"maxFileSizeBytes": updated.MaxFileBytes,
		"honorGitignore":   updated.HonorGitignore,
	})
}

func (a *App) deleteKnowledgeRepository(c *gin.Context) {
	principal, _, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	repositoryID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid repository id"))
		return
	}

	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()

	rows, err := transaction.QueryContext(c, `SELECT source_id FROM repository_context_files WHERE context_id=$1`, repositoryID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var sourceIDs []uuid.UUID
	for rows.Next() {
		var sourceID uuid.UUID
		if scanErr := rows.Scan(&sourceID); scanErr != nil {
			_ = rows.Close()
			writeError(c, http.StatusInternalServerError, scanErr)
			return
		}
		sourceIDs = append(sourceIDs, sourceID)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		_ = rows.Close()
		writeError(c, http.StatusInternalServerError, rowsErr)
		return
	}
	_ = rows.Close()

	result, err := transaction.ExecContext(c, `
		DELETE FROM repository_contexts
		WHERE id=$1 AND scope_type='user' AND scope_id=$2`, repositoryID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("repository not found"))
		return
	}

	if _, err := transaction.ExecContext(c, `DELETE FROM knowledge_items WHERE resource_type='repository' AND resource_id=$1`, repositoryID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	for _, sourceID := range sourceIDs {
		// A source can only be removed once no other repository snapshot still
		// references it. The repository context deletion above removed this
		// snapshot's file mappings via ON DELETE CASCADE.
		if _, err := transaction.ExecContext(c, `
			DELETE FROM knowledge_sources
			WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM repository_context_files WHERE source_id=$1)`, sourceID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if _, err := transaction.ExecContext(c, `
			DELETE FROM knowledge_items
			WHERE resource_type='source' AND resource_id=$1
			  AND NOT EXISTS (SELECT 1 FROM repository_context_files WHERE source_id=$1)`, sourceID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}

	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// queueRepositorySync removes the previous file snapshot atomically before a
// manual or scheduled import. The catalog repository item survives; file
// items and their memberships are replaced by the next snapshot.
func (a *App) queueRepositorySync(ctx context.Context, repositoryID, userID, organizationID uuid.UUID) error {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := queueRepositorySyncTx(ctx, tx, repositoryID, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// queueRepositorySyncTx removes a previous snapshot while the repository row
// is locked. Keeping this operation reusable lets indexing-policy updates and
// scheduled/manual syncs share exactly the same cleanup semantics.
func queueRepositorySyncTx(ctx context.Context, tx *sql.Tx, repositoryID uuid.UUID, userID ...uuid.UUID) error {
	var status string
	var updatedAt time.Time
	var query string
	var args []any
	if len(userID) > 0 && userID[0] != uuid.Nil {
		query = `SELECT status, updated_at FROM repository_contexts WHERE id=$1 AND scope_type='user' AND scope_id=$2 FOR UPDATE`
		args = []any{repositoryID, userID[0]}
	} else {
		query = `SELECT status, updated_at FROM repository_contexts WHERE id=$1 AND scope_type='user' FOR UPDATE`
		args = []any{repositoryID}
	}
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&status, &updatedAt); err != nil {
		return err
	}
	if status == "processing" && time.Since(updatedAt) < repositoryImportTimeout {
		return errRepositoryProcessing
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM knowledge_items ki
		USING repository_context_files rcf
		WHERE rcf.context_id=$1 AND ki.resource_type='source' AND ki.resource_id=rcf.source_id`, repositoryID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_sources WHERE id IN (SELECT source_id FROM repository_context_files WHERE context_id=$1)`, repositoryID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM repository_context_files WHERE context_id=$1`, repositoryID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE repository_contexts SET status='queued', file_count=0, skipped_file_count=0, total_bytes=0, resolved_ref=NULL, error_message=NULL, next_sync_at=CASE WHEN sync_interval_minutes > 0 THEN now() + (sync_interval_minutes::double precision * interval '1 minute') ELSE NULL END, updated_at=now() WHERE id=$1`, repositoryID); err != nil {
		return err
	}
	return nil
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
	var includePatterns, excludePatterns []string
	var maxFileBytes int64
	var honorGitignore bool
	if err := a.DB.QueryRowContext(ctx, `
		SELECT provider, repository_url, ref, encrypted_credential,
		       include_patterns, exclude_patterns, max_file_bytes, honor_gitignore
		FROM repository_contexts WHERE id = $1`, repositoryID).Scan(
		&provider, &repositoryURL, &ref, &encryptedToken,
		pq.Array(&includePatterns), pq.Array(&excludePatterns), &maxFileBytes, &honorGitignore); err != nil {
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
		MaxFiles:        a.Config.RepositoryMaxFiles,
		MaxFileBytes:    maxFileBytes,
		IncludePatterns: includePatterns,
		ExcludePatterns: excludePatterns,
		HonorGitignore:  &honorGitignore,
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
			skipped_file_count = $4, total_bytes = $5, error_message = NULL,
			next_sync_at = CASE WHEN sync_interval_minutes > 0 THEN now() + (sync_interval_minutes::double precision * interval '1 minute') ELSE NULL END,
			updated_at = now()
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
	a.markWorkerStarted("repository")
	go func() {
		a.repairPopulatedRepositoryContexts(ctx)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.markWorkerHeartbeat("repository")
				a.queueDueRepositorySyncs(ctx)
				repositoryID, ok := a.nextRepositoryImport(ctx)
				if ok {
					go a.populateRepository(repositoryID)
				}
			}
		}
	}()
}

func (a *App) queueDueRepositorySyncs(ctx context.Context) {
	rows, err := a.DB.QueryContext(ctx, `
		SELECT id, scope_id
		FROM repository_contexts
		WHERE scope_type = 'user' AND sync_interval_minutes > 0
		  AND next_sync_at IS NOT NULL AND next_sync_at <= now()
		  AND status <> 'processing'
		ORDER BY next_sync_at, id
		LIMIT 8`)
	if err != nil {
		return
	}
	defer rows.Close()
	type dueRepository struct{ id, userID uuid.UUID }
	due := make([]dueRepository, 0, 8)
	for rows.Next() {
		var item dueRepository
		if err := rows.Scan(&item.id, &item.userID); err == nil {
			due = append(due, item)
		}
	}
	for _, item := range due {
		if err := a.queueRepositorySync(ctx, item.id, item.userID, uuid.Nil); err == nil {
			go a.populateRepository(item.id)
		}
	}
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
	rows, err := a.DB.QueryContext(c, repositoryContextQuery+` WHERE crc.conversation_id = $1
		AND EXISTS (
			SELECT 1
			FROM conversations current_conversation
			JOIN knowledge_items repository_item
			  ON repository_item.resource_type = 'repository'
			 AND repository_item.resource_id = rc.id
			WHERE current_conversation.id = crc.conversation_id
			  AND repository_item.organization_id = current_conversation.organization_id
			  AND (repository_item.visibility = 'workspace' OR repository_item.owner_id = current_conversation.user_id)
		)
		ORDER BY crc.created_at`, conversationID)
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

func encodeRepositoryFileCursor(path string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(path))
}

func decodeRepositoryFileCursor(value string) (string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil || len(decoded) == 0 || strings.ContainsAny(string(decoded), "\x00\r\n") {
		return "", fmt.Errorf("invalid cursor")
	}
	return string(decoded), nil
}

func (a *App) listKnowledgeRepositoryFiles(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	repositoryID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid repository id"))
		return
	}
	limit := 50
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid limit"))
			return
		} else {
			limit = parsed
		}
	}
	if limit < 1 || limit > 100 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("limit must be between 1 and 100"))
		return
	}
	query := strings.TrimSpace(c.Query("q"))
	if len(query) > 256 {
		writeError(c, http.StatusBadRequest, fmt.Errorf("search query is too long"))
		return
	}
	cursor := ""
	if raw := strings.TrimSpace(c.Query("cursor")); raw != "" {
		cursor, err = decodeRepositoryFileCursor(raw)
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
	}

	// The authorization envelope follows the repository knowledge item rather
	// than exposing a raw user-owned context ID. This keeps file listings
	// consistent with the Knowledge detail endpoint and workspace visibility.
	where := `rcf.context_id=$1 AND EXISTS (
		SELECT 1
		FROM repository_contexts rc
		JOIN knowledge_items ki ON ki.resource_type='repository' AND ki.resource_id=rc.id
		WHERE rc.id=$1 AND rc.scope_type='user' AND rc.scope_id=$2
		  AND ki.organization_id=$3
		  AND (ki.visibility='workspace' OR ki.owner_id=$2)
	)`
	baseArgs := []any{repositoryID, principal.UserID, organizationID}
	if query != "" {
		where += fmt.Sprintf(" AND rcf.path ILIKE $%d", len(baseArgs)+1)
		baseArgs = append(baseArgs, "%"+query+"%")
	}
	var totalCount int
	if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM repository_context_files rcf WHERE `+where, baseArgs...).Scan(&totalCount); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	rowWhere := where
	rowArgs := append([]any(nil), baseArgs...)
	if cursor != "" {
		rowWhere += fmt.Sprintf(" AND rcf.path > $%d", len(rowArgs)+1)
		rowArgs = append(rowArgs, cursor)
	}
	rowArgs = append(rowArgs, limit+1)
	rows, err := a.DB.QueryContext(c, `
		SELECT rcf.path, rcf.source_id, COALESCE(ks.source_url,''), COALESCE(ks.status,'missing'), rcf.size_bytes
		FROM repository_context_files rcf
		LEFT JOIN knowledge_sources ks ON ks.id=rcf.source_id
		WHERE `+rowWhere+`
		ORDER BY rcf.path
		LIMIT $`+strconv.Itoa(len(rowArgs)), rowArgs...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	files := make([]models.KnowledgeRepositoryFile, 0, limit)
	for rows.Next() {
		var file models.KnowledgeRepositoryFile
		if err := rows.Scan(&file.Path, &file.SourceID, &file.URL, &file.Status, &file.SizeBytes); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	nextCursor := ""
	if len(files) > limit {
		nextCursor = encodeRepositoryFileCursor(files[limit-1].Path)
		files = files[:limit]
	}
	c.JSON(http.StatusOK, gin.H{"files": files, "nextCursor": nextCursor, "totalCount": totalCount})
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
	       rc.include_patterns, rc.exclude_patterns, rc.max_file_bytes, rc.honor_gitignore,
	       rc.sync_interval_minutes, rc.next_sync_at,
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
	       rc.include_patterns, rc.exclude_patterns, rc.max_file_bytes, rc.honor_gitignore,
	       rc.sync_interval_minutes, rc.next_sync_at,
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
		pq.Array(&item.IncludePatterns), pq.Array(&item.ExcludePatterns), &item.MaxFileBytes,
		&item.HonorGitignore, &item.SyncIntervalMinutes, &item.NextSyncAt,
		&item.CreatedAt, &item.UpdatedAt,
	); err != nil {
		return item, err
	}
	item.MaxFileSizeBytes = item.MaxFileBytes
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
