package rag

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"golang.org/x/net/html"
	"justai-backend/models"
	"justai-backend/provider"
	"justai-backend/security"
)

type Worker struct {
	db           *sql.DB
	allowPrivate bool
	secrets      *security.SecretBox
}

// DeepContextLimit is the number of grounded passages exposed to the model in
// explicit deep-context mode. The regular chat path keeps its smaller,
// low-latency retrieval window.
const DeepContextLimit = 24

const (
	defaultConversationSearchLimit = 6
	maxConversationSearchLimit     = 12
	maxDeepContextCandidateLimit   = DeepContextLimit * 2
)

func NewWorker(db *sql.DB, allowPrivate bool) *Worker {
	return &Worker{db: db, allowPrivate: allowPrivate}
}

func (w *Worker) SetSecretBox(secrets *security.SecretBox) {
	w.secrets = secrets
}

func (w *Worker) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = w.processOne(ctx)
			}
		}
	}()
}

func (w *Worker) processOne(ctx context.Context) error {
	transaction, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	// Recover a worker that died while holding a lease, then claim one job.
	// A pre-lease job from an older deployment may have a NULL lease. Treat it
	// as stale as well so an interrupted migration cannot leave a source stuck
	// in processing forever.
	_, _ = transaction.ExecContext(ctx, `
		WITH recovered AS (
			UPDATE ingestion_jobs
			SET status = 'queued', lease_until = NULL, stage = 'queued', progress = 0, run_after = now(), updated_at = now()
			WHERE status = 'processing' AND (lease_until IS NULL OR lease_until < now())
			RETURNING source_id
		)
		UPDATE knowledge_sources
		SET status = 'queued', error_message = NULL, updated_at = now()
		WHERE id IN (SELECT source_id FROM recovered)`)
	var jobID, sourceID uuid.UUID
	var attempts, maxAttempts int
	if err := transaction.QueryRowContext(ctx, `SELECT id, source_id, attempts, max_attempts FROM ingestion_jobs WHERE status = 'queued' AND run_after <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&jobID, &sourceID, &attempts, &maxAttempts); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	if attempts >= maxAttempts {
		_, _ = transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET status = 'failed', error_message = 'maximum retry attempts exceeded', updated_at = now() WHERE id = $1`, jobID)
		_, _ = transaction.ExecContext(ctx, `UPDATE knowledge_sources SET status = 'failed', error_message = 'maximum retry attempts exceeded', updated_at = now() WHERE id = $1`, sourceID)
		return transaction.Commit()
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET status = 'processing', attempts = attempts + 1, lease_until = now() + interval '2 minutes', stage = 'extracting', progress = 5, updated_at = now() WHERE id = $1`, jobID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE knowledge_sources SET status = 'processing', error_message = NULL, updated_at = now() WHERE id = $1`, sourceID); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return err
	}
	if err := w.ingest(ctx, jobID, sourceID); err != nil {
		if finishErr := w.finishIngestionFailure(jobID, sourceID, err); finishErr != nil {
			return fmt.Errorf("%w (recording ingestion failure: %v)", err, finishErr)
		}
		return err
	}
	return w.finishIngestionSuccess(jobID, sourceID)
}

func (w *Worker) finishIngestionFailure(jobID, sourceID uuid.UUID, cause error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	transaction, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, error_message = $2, lease_until = NULL, stage = CASE WHEN attempts < max_attempts THEN 'retrying' ELSE 'failed' END, run_after = now() + CASE attempts WHEN 1 THEN interval '5 seconds' WHEN 2 THEN interval '10 seconds' ELSE interval '20 seconds' END, updated_at = now() WHERE id = $1`, jobID, cause.Error()); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE knowledge_sources SET status = CASE WHEN EXISTS (SELECT 1 FROM ingestion_jobs WHERE source_id = $1 AND status = 'queued') THEN 'queued' ELSE 'failed' END, error_message = $2, updated_at = now() WHERE id = $1`, sourceID, cause.Error()); err != nil {
		return err
	}
	return transaction.Commit()
}

func (w *Worker) finishIngestionSuccess(jobID, sourceID uuid.UUID) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	transaction, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET status = 'ready', error_message = NULL, lease_until = NULL, stage = CASE WHEN stage = 'lexical-only' THEN 'lexical-only' ELSE 'ready' END, progress = 100, updated_at = now() WHERE id = $1`, jobID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE knowledge_sources SET status = 'ready', updated_at = now() WHERE id = $1`, sourceID); err != nil {
		return err
	}
	return transaction.Commit()
}

type chunkToStore struct {
	index     int
	content   string
	metadata  []byte
	embedding string
	dimension int
}

func (w *Worker) ingest(ctx context.Context, jobID, sourceID uuid.UUID) error {
	var sourceType, sourceURL, content, scopeType string
	var scopeID uuid.UUID
	if err := w.db.QueryRowContext(ctx, `SELECT source_type, COALESCE(source_url, ''), content, scope_type, scope_id FROM knowledge_sources WHERE id = $1`, sourceID).Scan(&sourceType, &sourceURL, &content, &scopeType, &scopeID); err != nil {
		return err
	}
	if sourceType == "url" {
		fetched, err := w.fetchURL(ctx, sourceURL)
		if err != nil {
			return err
		}
		content = fetched
		if _, err := w.db.ExecContext(ctx, `UPDATE knowledge_sources SET content = $2, content_hash = $3, updated_at = now() WHERE id = $1`, sourceID, content, hash(content)); err != nil {
			return err
		}
	}
	if strings.TrimSpace(content) == "" {
		return fmt.Errorf("source contains no text")
	}
	chunks := splitChunks(content, 1200, 180)
	if len(chunks) == 0 {
		return fmt.Errorf("source contains no text")
	}
	if err := w.renewLease(ctx, jobID, "chunking", 30); err != nil {
		return err
	}
	embeddingEndpoint, embeddingErr := w.embeddingEndpoint(ctx, scopeType, scopeID)
	stored := make([]chunkToStore, 0, len(chunks))
	var embeddingWarning string
	if embeddingErr != nil || embeddingEndpoint == nil {
		// A source is still useful without vectors. Keep that degradation
		// explicit in the job/source state so operators and users can tell the
		// difference between a fully indexed source and lexical-only retrieval.
		embeddingWarning = "Embedding unavailable; lexical retrieval is active"
	}
	for index, chunk := range chunks {
		progress := 30 + int(float64(index+1)*60/float64(len(chunks)))
		if err := w.renewLease(ctx, jobID, "embedding", progress); err != nil {
			return err
		}
		metadata, _ := json.Marshal(map[string]any{"jobId": jobID.String(), "chunkIndex": index})
		item := chunkToStore{index: index, content: chunk, metadata: metadata}
		if embeddingEndpoint != nil {
			if values, err := provider.Embed(ctx, *embeddingEndpoint, chunk); err == nil && len(values) > 0 {
				item.dimension = len(values)
				item.embedding = vectorLiteral(values)
			} else {
				embeddingWarning = "Embedding unavailable; lexical retrieval is active"
			}
		}
		stored = append(stored, item)
	}

	transaction, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `DELETE FROM knowledge_chunks WHERE source_id = $1`, sourceID); err != nil {
		return err
	}
	for _, item := range stored {
		if _, err := transaction.ExecContext(ctx, `INSERT INTO knowledge_chunks (source_id, chunk_index, title, content, metadata, embedding, embedding_dimension) VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::vector, NULLIF($7, 0))`, sourceID, item.index, titleForChunk(content), item.content, item.metadata, item.embedding, item.dimension); err != nil {
			return err
		}
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET stage = 'persisting', progress = 95, lease_until = now() + interval '2 minutes', updated_at = now() WHERE id = $1`, jobID); err != nil {
		return err
	}
	if embeddingWarning != "" {
		if _, err := transaction.ExecContext(ctx, `UPDATE knowledge_sources SET error_message = $2, updated_at = now() WHERE id = $1`, sourceID, embeddingWarning); err != nil {
			return err
		}
		if _, err := transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET stage = 'lexical-only' WHERE id = $1`, jobID); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

func (w *Worker) renewLease(ctx context.Context, jobID uuid.UUID, stage string, progress int) error {
	if progress < 0 {
		progress = 0
	}
	if progress > 99 {
		progress = 99
	}
	result, err := w.db.ExecContext(ctx, `UPDATE ingestion_jobs SET lease_until = now() + interval '2 minutes', stage = $2, progress = $3, updated_at = now() WHERE id = $1 AND status = 'processing'`, jobID, stage, progress)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return fmt.Errorf("ingestion lease is no longer active")
	}
	return nil
}

func (w *Worker) embeddingEndpoint(ctx context.Context, scopeType string, scopeID uuid.UUID) (*provider.Endpoint, error) {
	if w.secrets == nil {
		return nil, nil
	}
	var endpoint provider.Endpoint
	var credential []byte
	if err := w.db.QueryRowContext(ctx, `SELECT provider_type, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(embedding_model, ''), credential_ciphertext, timeout_seconds FROM endpoint_settings WHERE enabled = TRUE AND capabilities ? 'embeddings' AND embedding_model IS NOT NULL AND embedding_model <> '' AND ((scope_type = $1 AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = $1 THEN 1 ELSE 2 END, is_default DESC, created_at LIMIT 1`, scopeType, scopeID).Scan(&endpoint.ProviderType, &endpoint.BaseURL, &endpoint.APIPath, &endpoint.APIVersion, &endpoint.EmbeddingModel, &credential, &endpoint.TimeoutSeconds); err != nil {
		return nil, nil
	}
	if len(credential) > 0 {
		var err error
		endpoint.Credential, err = w.secrets.Decrypt(credential)
		if err != nil {
			return nil, err
		}
	}
	return &endpoint, nil
}

func vectorLiteral(values []float64) string {
	parts := make([]string, len(values))
	for index, value := range values {
		parts[index] = strconv.FormatFloat(value, 'f', 8, 64)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func (w *Worker) fetchURL(ctx context.Context, rawURL string) (string, error) {
	target, err := url.Parse(rawURL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" {
		return "", fmt.Errorf("only http and https URLs are supported")
	}
	if !w.allowPrivate {
		if err := validateHost(target.Hostname()); err != nil {
			return "", err
		}
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			DialContext: safeDialContext(w.allowPrivate),
		},
	}
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("source URL redirect limit exceeded")
		}
		if request.URL.Scheme != "http" && request.URL.Scheme != "https" {
			return fmt.Errorf("source redirects must use http or https")
		}
		if !w.allowPrivate {
			return validateHost(request.URL.Hostname())
		}
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "JustAI/0.1 knowledge-indexer")
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return "", fmt.Errorf("source URL returned status %d", response.StatusCode)
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if contentType != "" && !strings.HasPrefix(contentType, "text/") && contentType != "application/json" && contentType != "application/xml" {
		return "", fmt.Errorf("unsupported URL content type %q; only text, HTML, JSON, and XML are supported", contentType)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 10*1024*1024+1))
	if err != nil {
		return "", err
	}
	if len(body) > 10*1024*1024 {
		return "", fmt.Errorf("URL response exceeds the 10 MB limit")
	}
	return cleanWebContent(contentType, body), nil
}

// FetchURL exposes the same validated, public-network URL reader used by the
// knowledge indexer to interactive browsing handlers. Keeping the safety
// checks in one place prevents search previews from becoming an SSRF bypass.
func (w *Worker) FetchURL(ctx context.Context, rawURL string) (string, error) {
	return w.fetchURL(ctx, rawURL)
}

func Search(ctx context.Context, db *sql.DB, organizationID, userID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 12 {
		limit = 6
	}
	// plainto_tsquery joins every word with AND. That is too strict for a
	// conversational question such as "where is the deployment runbook?" when
	// a chunk contains only the relevant phrase. Keep the precise match first,
	// then fall back to an OR query built from safe lexical tokens.
	orQuery := lexicalOrQuery(query)
	if orQuery == "" {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
		FROM knowledge_chunks kc
		JOIN knowledge_sources ks ON ks.id = kc.source_id
		WHERE ((ks.scope_type = 'organization' AND ks.scope_id = $1) OR (ks.scope_type = 'user' AND ks.scope_id = $2))
		  AND ks.status = 'ready'
		  AND (
			to_tsvector('simple', ks.title || ' ' || kc.content) @@ plainto_tsquery('simple', $3)
			OR to_tsvector('simple', ks.title || ' ' || kc.content) @@ to_tsquery('simple', $4)
		  )
		ORDER BY GREATEST(
			ts_rank(to_tsvector('simple', ks.title || ' ' || kc.content), plainto_tsquery('simple', $3)),
			ts_rank(to_tsvector('simple', ks.title || ' ' || kc.content), to_tsquery('simple', $4))
		) DESC
		LIMIT $5`, organizationID, userID, query, orQuery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.Citation, 0, limit)
	for rows.Next() {
		var citation models.Citation
		if err := rows.Scan(&citation.SourceID, &citation.Title, &citation.ChunkIndex, &citation.Snippet); err != nil {
			return nil, err
		}
		citation.Kind = "knowledge"
		citation.ResourceID = citation.SourceID
		citation.Snippet = truncateSnippet(citation.Snippet)
		result = append(result, citation)
	}
	return result, rows.Err()
}

// Search augments the forgiving lexical search with vector similarity when an
// embedding endpoint is configured. Embeddings are optional, so an unavailable
// embedding provider never prevents a text source from being retrieved.
func (w *Worker) Search(ctx context.Context, organizationID, userID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	if w == nil || w.db == nil {
		return nil, fmt.Errorf("knowledge worker is not configured")
	}
	lexical, err := Search(ctx, w.db, organizationID, userID, query, limit)
	if err != nil {
		return nil, err
	}
	if w.secrets == nil {
		return lexical, nil
	}
	endpoint, err := w.searchEmbeddingEndpoint(ctx, organizationID, userID)
	if err != nil || endpoint == nil {
		return lexical, nil
	}
	embeddingContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	values, err := provider.Embed(embeddingContext, *endpoint, query)
	cancel()
	if err != nil || len(values) == 0 {
		return lexical, nil
	}
	semantic, err := searchByEmbedding(ctx, w.db, organizationID, userID, vectorLiteral(values), len(values), limit)
	if err != nil {
		return lexical, nil
	}
	return mergeCitations(lexical, semantic, limit), nil
}

// SearchConversation searches only persistent context. Message-scoped uploads
// must be named explicitly by the current user message so a file does not
// silently remain active for every later turn.
func SearchConversation(ctx context.Context, db *sql.DB, conversationID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	return searchConversation(ctx, db, conversationID, query, normalizeConversationSearchLimit(limit), "")
}

// SearchConversationSources searches the explicitly attached source ids for a
// message-scoped upload. The caller is responsible for authorizing the source
// ids against the current conversation before calling this method; the SQL
// still joins the conversation relation as a second isolation boundary.
func SearchConversationSources(ctx context.Context, db *sql.DB, conversationID uuid.UUID, query string, limit int, sourceIDs []uuid.UUID) ([]models.Citation, error) {
	return searchConversation(ctx, db, conversationID, query, normalizeConversationSearchLimit(limit), sourceIDsCSV(sourceIDs))
}

// SearchConversationDeepContext searches a broader persistent context window
// and spreads the final passages across source files. It is intentionally
// opt-in; ordinary chat continues to use SearchConversation's smaller window.
func SearchConversationDeepContext(ctx context.Context, db *sql.DB, conversationID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	deepContextLimit := normalizeDeepContextLimit(limit)
	candidateLimit := deepContextCandidateLimit(deepContextLimit)
	citations, err := searchConversation(ctx, db, conversationID, query, candidateLimit, "")
	if err != nil {
		return nil, err
	}
	citations = appendDeepContextCandidates(ctx, db, conversationID, citations, "", candidateLimit)
	return diversifyCitations(citations, deepContextLimit), nil
}

// SearchConversationSourcesDeepContext is the explicit-upload counterpart to
// SearchConversationDeepContext. The source allowlist remains enforced.
func SearchConversationSourcesDeepContext(ctx context.Context, db *sql.DB, conversationID uuid.UUID, query string, limit int, sourceIDs []uuid.UUID) ([]models.Citation, error) {
	deepContextLimit := normalizeDeepContextLimit(limit)
	candidateLimit := deepContextCandidateLimit(deepContextLimit)
	selectedSourceIDs := sourceIDsCSV(sourceIDs)
	citations, err := searchConversation(ctx, db, conversationID, query, candidateLimit, selectedSourceIDs)
	if err != nil {
		return nil, err
	}
	citations = appendDeepContextCandidates(ctx, db, conversationID, citations, selectedSourceIDs, candidateLimit)
	return diversifyCitations(citations, deepContextLimit), nil
}

func sourceIDsCSV(sourceIDs []uuid.UUID) string {
	values := make([]string, 0, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		if sourceID != uuid.Nil {
			values = append(values, sourceID.String())
		}
	}
	return strings.Join(values, ",")
}

func normalizeConversationSearchLimit(limit int) int {
	if limit <= 0 || limit > maxConversationSearchLimit {
		return defaultConversationSearchLimit
	}
	return limit
}

func normalizeDeepContextLimit(limit int) int {
	if limit <= 0 {
		return DeepContextLimit
	}
	if limit > DeepContextLimit {
		return DeepContextLimit
	}
	return limit
}

func deepContextCandidateLimit(limit int) int {
	limit = normalizeDeepContextLimit(limit)
	return min(limit*2, maxDeepContextCandidateLimit)
}

func searchConversation(ctx context.Context, db *sql.DB, conversationID uuid.UUID, query string, limit int, selectedSourceIDs string) ([]models.Citation, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = defaultConversationSearchLimit
	}
	if limit > maxDeepContextCandidateLimit {
		limit = maxDeepContextCandidateLimit
	}
	orQuery := lexicalOrQuery(query)
	if orQuery == "" {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
		FROM knowledge_chunks kc
		JOIN knowledge_sources ks ON ks.id = kc.source_id
		JOIN conversation_knowledge_sources cks ON cks.source_id = ks.id
		WHERE cks.conversation_id = $1 AND ks.status = 'ready'
		  AND CASE WHEN $2 = '' THEN cks.context_scope = 'persistent'
		           ELSE cks.source_id = ANY(string_to_array($2, ',')::uuid[])
		      END
		  AND (to_tsvector('simple', ks.title || ' ' || kc.content) @@ plainto_tsquery('simple', $3)
		       OR to_tsvector('simple', ks.title || ' ' || kc.content) @@ to_tsquery('simple', $4))
		ORDER BY GREATEST(ts_rank(to_tsvector('simple', ks.title || ' ' || kc.content), plainto_tsquery('simple', $3)),
		                  ts_rank(to_tsvector('simple', ks.title || ' ' || kc.content), to_tsquery('simple', $4))) DESC
		LIMIT $5`, conversationID, selectedSourceIDs, query, orQuery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.Citation, 0, limit)
	for rows.Next() {
		var citation models.Citation
		if err := rows.Scan(&citation.SourceID, &citation.Title, &citation.ChunkIndex, &citation.Snippet); err != nil {
			return nil, err
		}
		citation.Kind = "knowledge"
		citation.ResourceID = citation.SourceID
		citation.Snippet = truncateSnippet(citation.Snippet)
		result = append(result, citation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if selectedSourceIDs != "" {
		// Queries such as “summarize this file” often share no terms with the
		// document. Keep the attachment useful by falling back to its first
		// chunks instead of handing the model an empty grounding set.
		if len(result) == 0 {
			fallbackRows, fallbackErr := db.QueryContext(ctx, `
				SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
				FROM knowledge_chunks kc
				JOIN knowledge_sources ks ON ks.id = kc.source_id
				JOIN conversation_knowledge_sources cks ON cks.source_id = kc.source_id
				WHERE cks.conversation_id = $1 AND ks.status = 'ready'
				  AND cks.source_id = ANY(string_to_array($2, ',')::uuid[])
				ORDER BY cks.source_id, kc.chunk_index
				LIMIT $3`, conversationID, selectedSourceIDs, limit)
			if fallbackErr != nil {
				return nil, fallbackErr
			}
			for fallbackRows.Next() {
				var citation models.Citation
				if scanErr := fallbackRows.Scan(&citation.SourceID, &citation.Title, &citation.ChunkIndex, &citation.Snippet); scanErr != nil {
					fallbackRows.Close()
					return nil, scanErr
				}
				citation.Kind = "knowledge"
				citation.ResourceID = citation.SourceID
				citation.Snippet = truncateSnippet(citation.Snippet)
				result = append(result, citation)
			}
			if scanErr := fallbackRows.Err(); scanErr != nil {
				fallbackRows.Close()
				return nil, scanErr
			}
			fallbackRows.Close()
		}
		return result, nil
	}
	transcriptionRows, err := db.QueryContext(ctx, `
		SELECT ts.id, ts.title, tsg.start_offset_ms, tsg.end_offset_ms, tsg.text
		FROM transcription_segments tsg
		JOIN transcription_sessions ts ON ts.id = tsg.session_id
		JOIN conversation_transcription_sessions cts ON cts.session_id = ts.id
		WHERE cts.conversation_id = $1 AND tsg.canonical = TRUE
		  AND to_tsvector('simple', tsg.text) @@ to_tsquery('simple', $2)
		ORDER BY ts_rank(to_tsvector('simple', tsg.text), to_tsquery('simple', $2)) DESC
		LIMIT $3`, conversationID, orQuery, limit)
	if err != nil {
		return result, nil
	}
	defer transcriptionRows.Close()
	for transcriptionRows.Next() {
		var citation models.Citation
		var sessionID uuid.UUID
		var start, end int64
		if err := transcriptionRows.Scan(&sessionID, &citation.Title, &start, &end, &citation.Snippet); err != nil {
			return nil, err
		}
		citation.Kind = "transcription"
		citation.ResourceID = sessionID
		citation.Locator = fmt.Sprintf("%s–%s", formatMilliseconds(start), formatMilliseconds(end))
		citation.Snippet = truncateSnippet(citation.Snippet)
		result = append(result, citation)
	}
	if err := transcriptionRows.Err(); err != nil {
		return nil, err
	}
	// Keep both Knowledge and transcript matches in the candidate set, then
	// fuse their ranks so a strong transcript hit cannot be crowded out simply
	// because the Knowledge query filled the first page.
	knowledgeCount := 0
	for _, citation := range result {
		if citation.Kind == "knowledge" {
			knowledgeCount++
		}
	}
	if knowledgeCount == len(result) {
		return result, nil
	}
	knowledge := make([]models.Citation, 0, knowledgeCount)
	transcripts := make([]models.Citation, 0, len(result)-knowledgeCount)
	for _, citation := range result {
		if citation.Kind == "transcription" {
			transcripts = append(transcripts, citation)
		} else {
			knowledge = append(knowledge, citation)
		}
	}
	return mergeCitations(knowledge, transcripts, limit), nil
}

// SearchConversation adds optional vector retrieval to the conversation-scoped
// lexical search. The embedding endpoint is selected from the conversation's
// organization/user scope, while the vector query itself can only see sources
// explicitly attached to that conversation.
func (w *Worker) SearchConversation(ctx context.Context, conversationID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	return w.searchConversationMode(ctx, conversationID, query, limit, nil, false)
}

// SearchConversationDeepContext is the broader, diversified retrieval path
// used by explicit deep-context mode.
func (w *Worker) SearchConversationDeepContext(ctx context.Context, conversationID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	return w.searchConversationMode(ctx, conversationID, query, limit, nil, true)
}

// SearchConversationSources is the explicit-upload variant of
// SearchConversation. It keeps semantic retrieval inside the same source
// allowlist as lexical retrieval.
func (w *Worker) SearchConversationSources(ctx context.Context, conversationID uuid.UUID, query string, limit int, sourceIDs []uuid.UUID) ([]models.Citation, error) {
	return w.searchConversationMode(ctx, conversationID, query, limit, sourceIDs, false)
}

// SearchConversationSourcesDeepContext is the explicit-upload counterpart to
// SearchConversationDeepContext.
func (w *Worker) SearchConversationSourcesDeepContext(ctx context.Context, conversationID uuid.UUID, query string, limit int, sourceIDs []uuid.UUID) ([]models.Citation, error) {
	return w.searchConversationMode(ctx, conversationID, query, limit, sourceIDs, true)
}

func (w *Worker) searchConversationMode(ctx context.Context, conversationID uuid.UUID, query string, limit int, sourceIDs []uuid.UUID, deepContext bool) ([]models.Citation, error) {
	if w == nil || w.db == nil {
		return nil, fmt.Errorf("knowledge worker is not configured")
	}
	resultLimit := normalizeConversationSearchLimit(limit)
	retrievalLimit := resultLimit
	if deepContext {
		resultLimit = normalizeDeepContextLimit(limit)
		retrievalLimit = deepContextCandidateLimit(resultLimit)
	}
	selectedSourceIDs := sourceIDsCSV(sourceIDs)
	lexical, err := searchConversation(ctx, w.db, conversationID, query, retrievalLimit, selectedSourceIDs)
	if deepContext {
		lexical = appendDeepContextCandidates(ctx, w.db, conversationID, lexical, selectedSourceIDs, retrievalLimit)
	}
	finish := func(citations []models.Citation) []models.Citation {
		if deepContext {
			return diversifyCitations(citations, resultLimit)
		}
		return citations
	}
	if err != nil || w.secrets == nil {
		return finish(lexical), err
	}
	endpoint, err := w.conversationEmbeddingEndpoint(ctx, conversationID)
	if err != nil || endpoint == nil {
		return finish(lexical), nil
	}
	embeddingContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	values, err := provider.Embed(embeddingContext, *endpoint, query)
	cancel()
	if err != nil || len(values) == 0 {
		return finish(lexical), nil
	}
	semantic, err := searchConversationByEmbedding(ctx, w.db, conversationID, vectorLiteral(values), len(values), retrievalLimit, selectedSourceIDs)
	if err != nil {
		return finish(lexical), nil
	}
	merged := mergeCitations(lexical, semantic, retrievalLimit)
	if deepContext {
		return diversifyCitations(merged, resultLimit), nil
	}
	return merged, nil
}

func (w *Worker) conversationEmbeddingEndpoint(ctx context.Context, conversationID uuid.UUID) (*provider.Endpoint, error) {
	var endpoint provider.Endpoint
	var credential []byte
	err := w.db.QueryRowContext(ctx, `
		SELECT e.provider_type, e.base_url, COALESCE(e.api_path, ''), COALESCE(e.api_version, ''),
		       COALESCE(e.embedding_model, ''), e.credential_ciphertext, e.timeout_seconds
		FROM endpoint_settings e
		JOIN conversations c ON c.id = $1
		WHERE e.enabled = TRUE AND e.capabilities ? 'embeddings' AND e.embedding_model IS NOT NULL AND e.embedding_model <> ''
		  AND ((e.scope_type = 'organization' AND e.scope_id = c.organization_id)
		       OR (e.scope_type = 'user' AND e.scope_id = c.user_id)
		       OR e.scope_type = 'global')
		ORDER BY CASE WHEN e.scope_type = 'organization' THEN 1 WHEN e.scope_type = 'user' THEN 2 ELSE 3 END,
		         e.is_default DESC, e.created_at
		LIMIT 1`, conversationID).Scan(&endpoint.ProviderType, &endpoint.BaseURL, &endpoint.APIPath, &endpoint.APIVersion, &endpoint.EmbeddingModel, &credential, &endpoint.TimeoutSeconds)
	if err != nil {
		return nil, nil
	}
	if len(credential) > 0 {
		endpoint.Credential, err = w.secrets.Decrypt(credential)
		if err != nil {
			return nil, err
		}
	}
	return &endpoint, nil
}

func searchConversationByEmbedding(ctx context.Context, db *sql.DB, conversationID uuid.UUID, embedding string, dimension, limit int, selectedSourceIDs string) ([]models.Citation, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
		FROM knowledge_chunks kc
		JOIN knowledge_sources ks ON ks.id = kc.source_id
		JOIN conversation_knowledge_sources cks ON cks.source_id = kc.source_id
		WHERE cks.conversation_id = $1 AND ks.status = 'ready' AND kc.embedding IS NOT NULL
		  AND CASE WHEN $4 = '' THEN cks.context_scope = 'persistent'
		           ELSE cks.source_id = ANY(string_to_array($4, ',')::uuid[])
		      END
		  AND kc.embedding_dimension = $3
		ORDER BY kc.embedding <=> $2::vector
		LIMIT $5`, conversationID, embedding, dimension, selectedSourceIDs, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.Citation, 0, limit)
	for rows.Next() {
		var citation models.Citation
		if err := rows.Scan(&citation.SourceID, &citation.Title, &citation.ChunkIndex, &citation.Snippet); err != nil {
			return nil, err
		}
		citation.Kind = "knowledge"
		citation.ResourceID = citation.SourceID
		citation.Snippet = truncateSnippet(citation.Snippet)
		result = append(result, citation)
	}
	return result, rows.Err()
}

func formatMilliseconds(value int64) string {
	if value < 0 {
		value = 0
	}
	return fmt.Sprintf("%02d:%02d", value/60000, (value/1000)%60)
}

func (w *Worker) searchEmbeddingEndpoint(ctx context.Context, organizationID, userID uuid.UUID) (*provider.Endpoint, error) {
	var endpoint provider.Endpoint
	var credential []byte
	if err := w.db.QueryRowContext(ctx, `SELECT provider_type, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(embedding_model, ''), credential_ciphertext, timeout_seconds FROM endpoint_settings WHERE enabled = TRUE AND capabilities ? 'embeddings' AND embedding_model IS NOT NULL AND embedding_model <> '' AND ((scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = 'organization' THEN 1 WHEN scope_type = 'user' THEN 2 ELSE 3 END, is_default DESC, created_at LIMIT 1`, organizationID, userID).Scan(&endpoint.ProviderType, &endpoint.BaseURL, &endpoint.APIPath, &endpoint.APIVersion, &endpoint.EmbeddingModel, &credential, &endpoint.TimeoutSeconds); err != nil {
		return nil, nil
	}
	if len(credential) > 0 {
		var err error
		endpoint.Credential, err = w.secrets.Decrypt(credential)
		if err != nil {
			return nil, err
		}
	}
	return &endpoint, nil
}

func searchByEmbedding(ctx context.Context, db *sql.DB, organizationID, userID uuid.UUID, embedding string, dimension, limit int) ([]models.Citation, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
		FROM knowledge_chunks kc
		JOIN knowledge_sources ks ON ks.id = kc.source_id
		WHERE ((ks.scope_type = 'organization' AND ks.scope_id = $1) OR (ks.scope_type = 'user' AND ks.scope_id = $2))
		  AND ks.status = 'ready'
		  AND kc.embedding IS NOT NULL
		  AND kc.embedding_dimension = $3
		ORDER BY kc.embedding <=> $4::vector
		LIMIT $5`, organizationID, userID, dimension, embedding, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.Citation, 0, limit)
	for rows.Next() {
		var citation models.Citation
		if err := rows.Scan(&citation.SourceID, &citation.Title, &citation.ChunkIndex, &citation.Snippet); err != nil {
			return nil, err
		}
		citation.Kind = "knowledge"
		citation.ResourceID = citation.SourceID
		citation.Snippet = truncateSnippet(citation.Snippet)
		result = append(result, citation)
	}
	return result, rows.Err()
}

// appendDeepContextCandidates adds representative first chunks from repository
// files that did not match the query lexically. Architecture questions often
// mention concepts such as "structure" or "backend" that are absent from the
// most important entry-point files; a small representative sample makes deep
// context useful even when embeddings are unavailable.
// This supplemental query is best effort because lexical retrieval remains the
// authoritative failure path.
func appendDeepContextCandidates(ctx context.Context, db *sql.DB, conversationID uuid.UUID, citations []models.Citation, selectedSourceIDs string, limit int) []models.Citation {
	if db == nil || limit <= len(citations) {
		return citations
	}
	rows, err := db.QueryContext(ctx, `
		SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
		FROM knowledge_chunks kc
		JOIN knowledge_sources ks ON ks.id = kc.source_id
		JOIN conversation_knowledge_sources cks ON cks.source_id = kc.source_id
		WHERE cks.conversation_id = $1
		  AND ks.status = 'ready'
		  AND ks.source_type = 'repository'
		  AND kc.chunk_index = 0
		  AND CASE WHEN $2 = '' THEN cks.context_scope = 'persistent'
		           ELSE cks.source_id = ANY(string_to_array($2, ',')::uuid[])
		      END
		ORDER BY CASE
		           WHEN lower(ks.title) LIKE '%readme%' THEN 0
		           WHEN lower(ks.title) IN ('go.mod', 'package.json', 'pyproject.toml', 'cargo.toml', 'dockerfile') THEN 1
		           ELSE 2
		         END, ks.title
		LIMIT $3`, conversationID, selectedSourceIDs, limit-len(citations))
	if err != nil {
		return citations
	}
	defer rows.Close()

	result := append([]models.Citation(nil), citations...)
	seen := make(map[string]struct{}, len(citations))
	for _, citation := range citations {
		seen[citationKey(citation)] = struct{}{}
	}
	for rows.Next() {
		var citation models.Citation
		if err := rows.Scan(&citation.SourceID, &citation.Title, &citation.ChunkIndex, &citation.Snippet); err != nil {
			return citations
		}
		citation.Kind = "knowledge"
		citation.ResourceID = citation.SourceID
		citation.Snippet = truncateSnippet(citation.Snippet)
		key := citationKey(citation)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, citation)
		if len(result) >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return citations
	}
	return result
}

// diversifyCitations keeps the relevance order within each pass while making
// sure a broad deep-context result is not dominated by the first matching file.
// The first pass takes one passage per source, the second allows a second
// passage, and only then fills any remaining slots from the ranked candidates.
func diversifyCitations(citations []models.Citation, limit int) []models.Citation {
	limit = normalizeDeepContextLimit(limit)
	if len(citations) <= limit {
		return citations
	}

	result := make([]models.Citation, 0, min(limit, len(citations)))
	used := make([]bool, len(citations))
	counts := make(map[string]int)
	appendPass := func(maxPerSource int) {
		for index, citation := range citations {
			if len(result) >= limit || used[index] {
				continue
			}
			key := citationSourceKey(citation)
			if counts[key] >= maxPerSource {
				continue
			}
			used[index] = true
			counts[key]++
			result = append(result, citation)
		}
	}

	appendPass(1)
	appendPass(2)
	if len(result) < limit {
		for index, citation := range citations {
			if len(result) >= limit || used[index] {
				continue
			}
			used[index] = true
			result = append(result, citation)
		}
	}
	return result
}

func citationSourceKey(citation models.Citation) string {
	resourceID := citation.ResourceID
	if resourceID == uuid.Nil {
		resourceID = citation.SourceID
	}
	if resourceID != uuid.Nil {
		return citation.Kind + ":" + resourceID.String()
	}
	return citation.Kind + ":" + citation.Title
}

func citationKey(citation models.Citation) string {
	key := citation.ResourceID.String() + ":" + citation.SourceID.String() + ":" + strconv.Itoa(citation.ChunkIndex)
	if citation.ResourceID == uuid.Nil && citation.SourceID == uuid.Nil {
		key = citation.Title + ":" + citation.Snippet
	}
	return key
}

func mergeCitations(first, second []models.Citation, limit int) []models.Citation {
	if limit <= 0 {
		limit = defaultConversationSearchLimit
	}
	if limit > maxDeepContextCandidateLimit {
		limit = maxDeepContextCandidateLimit
	}
	type ranked struct {
		citation models.Citation
		score    float64
		order    int
	}
	rankedByKey := map[string]*ranked{}
	order := 0
	for _, citations := range [][]models.Citation{first, second} {
		for rank, citation := range citations {
			key := citationKey(citation)
			item, exists := rankedByKey[key]
			if !exists {
				item = &ranked{citation: citation, order: order}
				order++
				rankedByKey[key] = item
			}
			item.score += 1.0 / float64(60+rank+1)
		}
	}
	rankedItems := make([]*ranked, 0, len(rankedByKey))
	for _, item := range rankedByKey {
		rankedItems = append(rankedItems, item)
	}
	sort.SliceStable(rankedItems, func(i, j int) bool {
		if rankedItems[i].score == rankedItems[j].score {
			return rankedItems[i].order < rankedItems[j].order
		}
		return rankedItems[i].score > rankedItems[j].score
	})
	result := make([]models.Citation, 0, min(limit, len(rankedItems)))
	for _, item := range rankedItems {
		result = append(result, item.citation)
		if len(result) == limit {
			break
		}
	}
	return result
}

func truncateSnippet(value string) string {
	if len([]rune(value)) > 260 {
		return string([]rune(value)[:260]) + "…"
	}
	return value
}

func lexicalOrQuery(value string) string {
	seen := map[string]struct{}{}
	terms := make([]string, 0, 8)
	var builder strings.Builder
	flush := func() {
		term := builder.String()
		builder.Reset()
		if utf8.RuneCountInString(term) < 3 {
			return
		}
		if _, exists := seen[term]; exists {
			return
		}
		seen[term] = struct{}{}
		terms = append(terms, term)
	}
	for _, character := range strings.ToLower(value) {
		if unicode.IsLetter(character) || unicode.IsDigit(character) || character == '_' {
			builder.WriteRune(character)
			continue
		}
		flush()
	}
	flush()
	return strings.Join(terms, " | ")
}

func NewSource(ctx context.Context, db *sql.DB, scopeType string, scopeID, userID uuid.UUID, title, sourceType, sourceURL, mimeType, content string) (models.KnowledgeSource, error) {
	if scopeType != "organization" && scopeType != "user" {
		return models.KnowledgeSource{}, fmt.Errorf("unsupported source scope")
	}
	if sourceType != "upload" && sourceType != "url" && sourceType != "text" && sourceType != "repository" {
		return models.KnowledgeSource{}, fmt.Errorf("unsupported source type")
	}
	if sourceType == "url" {
		if sourceURL == "" {
			return models.KnowledgeSource{}, fmt.Errorf("source URL is required")
		}
		parsed, err := url.Parse(sourceURL)
		if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || len(sourceURL) > 2048 {
			return models.KnowledgeSource{}, fmt.Errorf("source URL must be a valid http or https URL under 2048 characters")
		}
	}
	if sourceType == "upload" && len(content) > 25*1024*1024 {
		return models.KnowledgeSource{}, fmt.Errorf("file sources are limited to 25 MB")
	}
	if sourceType == "text" && len(content) > 10*1024*1024 {
		return models.KnowledgeSource{}, fmt.Errorf("text sources are limited to 10 MB")
	}
	if sourceType == "repository" && len(content) > 2*1024*1024 {
		return models.KnowledgeSource{}, fmt.Errorf("repository files are limited to 2 MB")
	}
	if title == "" {
		title = "Untitled source"
	}
	sourceID := uuid.New()
	jobID := uuid.New()
	transaction, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.KnowledgeSource{}, err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `INSERT INTO knowledge_sources (id, scope_type, scope_id, title, source_type, source_url, mime_type, content, content_hash, created_by) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''), $10)`, sourceID, scopeType, scopeID, title, sourceType, sourceURL, mimeType, content, hash(content), userID); err != nil {
		return models.KnowledgeSource{}, err
	}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO ingestion_jobs (id, source_id) VALUES ($1, $2)`, jobID, sourceID); err != nil {
		return models.KnowledgeSource{}, err
	}
	if err := transaction.Commit(); err != nil {
		return models.KnowledgeSource{}, err
	}
	return GetSource(ctx, db, sourceID)
}

func GetSource(ctx context.Context, db *sql.DB, sourceID uuid.UUID) (models.KnowledgeSource, error) {
	var result models.KnowledgeSource
	var sourceURL, mimeType, errorMessage, stage sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT ks.id, ks.scope_type, ks.scope_id, ks.title, ks.source_type, COALESCE(ks.source_url, ''), COALESCE(ks.mime_type, ''), ks.status, COALESCE(ks.error_message, ''), COALESCE(ij.progress, 0), COALESCE(ij.stage, ks.status), ks.created_at, ks.updated_at FROM knowledge_sources ks LEFT JOIN LATERAL (SELECT progress, stage FROM ingestion_jobs WHERE source_id = ks.id ORDER BY created_at DESC LIMIT 1) ij ON TRUE WHERE ks.id = $1`, sourceID).Scan(&result.ID, &result.ScopeType, &result.ScopeID, &result.Title, &result.SourceType, &sourceURL, &mimeType, &result.Status, &errorMessage, &result.Progress, &stage, &result.CreatedAt, &result.UpdatedAt); err != nil {
		return result, err
	}
	result.SourceURL = sourceURL.String
	result.MimeType = mimeType.String
	result.Error = errorMessage.String
	result.Stage = stage.String
	return result, nil
}

func ListSources(ctx context.Context, db *sql.DB, organizationID, userID uuid.UUID) ([]models.KnowledgeSource, error) {
	rows, err := db.QueryContext(ctx, `SELECT ks.id, ks.scope_type, ks.scope_id, ks.title, ks.source_type, COALESCE(ks.source_url, ''), COALESCE(ks.mime_type, ''), ks.status, COALESCE(ks.error_message, ''), COALESCE(ij.progress, 0), COALESCE(ij.stage, ks.status), ks.created_at, ks.updated_at FROM knowledge_sources ks LEFT JOIN LATERAL (SELECT progress, stage FROM ingestion_jobs WHERE source_id = ks.id ORDER BY created_at DESC LIMIT 1) ij ON TRUE WHERE ks.conversation_id IS NULL AND ((ks.scope_type = 'organization' AND ks.scope_id = $1) OR (ks.scope_type = 'user' AND ks.scope_id = $2)) ORDER BY ks.created_at DESC`, organizationID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []models.KnowledgeSource{}
	for rows.Next() {
		var item models.KnowledgeSource
		var sourceURL, mimeType, errorMessage, stage sql.NullString
		if err := rows.Scan(&item.ID, &item.ScopeType, &item.ScopeID, &item.Title, &item.SourceType, &sourceURL, &mimeType, &item.Status, &errorMessage, &item.Progress, &stage, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.SourceURL, item.MimeType, item.Error = sourceURL.String, mimeType.String, errorMessage.String
		item.Stage = stage.String
		result = append(result, item)
	}
	return result, rows.Err()
}

func splitChunks(value string, maxRunes, overlap int) []string {
	words := strings.Fields(value)
	if len(words) == 0 {
		return nil
	}
	result := []string{}
	current := []string{}
	count := 0
	for _, word := range words {
		wordRunes := utf8.RuneCountInString(word) + 1
		if count+wordRunes > maxRunes && len(current) > 0 {
			result = append(result, strings.Join(current, " "))
			overlapWords := overlap / 5
			if overlapWords > len(current) {
				overlapWords = len(current)
			}
			current = append([]string(nil), current[len(current)-overlapWords:]...)
			count = utf8.RuneCountInString(strings.Join(current, " "))
		}
		current = append(current, word)
		count += wordRunes
	}
	if len(current) > 0 {
		result = append(result, strings.Join(current, " "))
	}
	return result
}

func cleanWebContent(contentType string, body []byte) string {
	if strings.Contains(strings.ToLower(contentType), "html") {
		tokenizer := html.NewTokenizer(bytes.NewReader(body))
		var text strings.Builder
		skipDepth := 0
		for {
			tokenType := tokenizer.Next()
			if tokenType == html.ErrorToken {
				break
			}
			switch tokenType {
			case html.StartTagToken:
				name, _ := tokenizer.TagName()
				if string(name) == "script" || string(name) == "style" || string(name) == "noscript" {
					skipDepth++
				}
			case html.EndTagToken:
				name, _ := tokenizer.TagName()
				if skipDepth > 0 && (string(name) == "script" || string(name) == "style" || string(name) == "noscript") {
					skipDepth--
				}
			case html.TextToken:
				if skipDepth == 0 {
					text.WriteByte(' ')
					text.WriteString(tokenizer.Token().Data)
				}
			}
		}
		body = []byte(text.String())
	}
	return strings.Join(strings.Fields(string(body)), " ")
}

func titleForChunk(content string) string {
	line := strings.TrimSpace(strings.SplitN(content, "\n", 2)[0])
	if len([]rune(line)) > 90 {
		line = string([]rune(line)[:90]) + "…"
	}
	if line == "" {
		return "Knowledge chunk"
	}
	return line
}

func hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func validateHost(host string) error {
	ip := net.ParseIP(host)
	if ip != nil {
		if isPrivateIP(ip) {
			return fmt.Errorf("private and loopback source targets are blocked")
		}
		return nil
	}
	addresses, err := net.LookupIP(host)
	if err != nil {
		return err
	}
	for _, address := range addresses {
		if isPrivateIP(address) {
			return fmt.Errorf("source hostname resolves to a private target")
		}
	}
	return nil
}

// safeDialContext resolves the target immediately before connecting and dials
// the validated address directly. This closes the DNS-rebinding gap between
// the URL check and the HTTP transport's own resolver call.
func safeDialContext(allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if allowPrivate {
			return dialer.DialContext(ctx, network, address)
		}
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if parsed := net.ParseIP(host); parsed != nil {
			if err := validateHost(host); err != nil {
				return nil, err
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(parsed.String(), port))
		}
		addresses, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, address := range addresses {
			if isPrivateIP(address) {
				continue
			}
			connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("source hostname resolves only to private targets")
	}
}

func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsLinkLocalMulticast()
}

func ExtractUpload(filename, mimeType string, body []byte) (string, error) {
	lowerName := strings.ToLower(filename)
	lowerMime := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	if strings.HasPrefix(lowerMime, "image/") || imageExtension(lowerName) {
		if len(body) == 0 {
			return "", fmt.Errorf("image attachment is empty")
		}
		// The binary is carried to vision-capable chat models as an image UI
		// part. Keep a small, searchable source record for Knowledge context
		// without pretending that the RAG worker performed OCR or image
		// understanding.
		return fmt.Sprintf("Image attachment %q. Ask a vision-capable chat endpoint to inspect the image itself.", filename), nil
	}
	if strings.HasPrefix(lowerMime, "audio/") || strings.HasPrefix(lowerMime, "video/") || mediaExtension(lowerName) {
		return "", fmt.Errorf("audio and video attachments must be transcribed before they can be added as Knowledge")
	}
	allowedText := lowerMime == "" || strings.HasPrefix(lowerMime, "text/") || lowerMime == "application/json" || lowerMime == "application/pdf" || strings.HasSuffix(lowerName, ".md") || strings.HasSuffix(lowerName, ".markdown") || strings.HasSuffix(lowerName, ".txt") || strings.HasSuffix(lowerName, ".html") || strings.HasSuffix(lowerName, ".htm") || strings.HasSuffix(lowerName, ".json") || strings.HasSuffix(lowerName, ".pdf")
	if !allowedText {
		return "", fmt.Errorf("unsupported attachment type; use PDF, Markdown, text, HTML, or JSON")
	}
	if strings.HasSuffix(lowerName, ".pdf") || strings.Contains(lowerMime, "pdf") {
		command := exec.Command("pdftotext", "-layout", "-", "-")
		command.Stdin = bytes.NewReader(body)
		output, err := command.Output()
		if err != nil {
			return "", fmt.Errorf("PDF extraction requires pdftotext: %w", err)
		}
		return strings.TrimSpace(string(output)), nil
	}
	if !utf8.Valid(body) {
		return "", fmt.Errorf("text attachments must be UTF-8")
	}
	if strings.Contains(lowerMime, "html") || strings.HasSuffix(lowerName, ".html") || strings.HasSuffix(lowerName, ".htm") {
		return cleanWebContent("text/html", body), nil
	}
	return strings.TrimSpace(string(body)), nil
}

func mediaExtension(filename string) bool {
	for _, extension := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".heic", ".mp3", ".wav", ".ogg", ".m4a", ".mp4", ".mov", ".webm", ".avi"} {
		if strings.HasSuffix(filename, extension) {
			return true
		}
	}
	return false
}

func imageExtension(filename string) bool {
	for _, extension := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".heic"} {
		if strings.HasSuffix(filename, extension) {
			return true
		}
	}
	return false
}
