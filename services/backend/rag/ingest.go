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
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"justai-backend/models"
	"justai-backend/provider"
	"justai-backend/security"
)

type Worker struct {
	db           *sql.DB
	allowPrivate bool
	secrets      *security.SecretBox
}

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
	var jobID, sourceID uuid.UUID
	if err := transaction.QueryRowContext(ctx, `SELECT id, source_id FROM ingestion_jobs WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&jobID, &sourceID); err != nil {
		return nil
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE ingestion_jobs SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = $1`, jobID); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE knowledge_sources SET status = 'processing', error_message = NULL, updated_at = now() WHERE id = $1`, sourceID); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return err
	}
	if err := w.ingest(ctx, jobID, sourceID); err != nil {
		_, _ = w.db.ExecContext(ctx, `UPDATE ingestion_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, jobID, err.Error())
		_, _ = w.db.ExecContext(ctx, `UPDATE knowledge_sources SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, sourceID, err.Error())
		return err
	}
	_, _ = w.db.ExecContext(ctx, `UPDATE ingestion_jobs SET status = 'ready', error_message = NULL, updated_at = now() WHERE id = $1`, jobID)
	_, _ = w.db.ExecContext(ctx, `UPDATE knowledge_sources SET status = 'ready', error_message = NULL, updated_at = now() WHERE id = $1`, sourceID)
	return nil
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
	if content == "" {
		return fmt.Errorf("source contains no text")
	}
	chunks := splitChunks(content, 1200, 180)
	if _, err := w.db.ExecContext(ctx, `DELETE FROM knowledge_chunks WHERE source_id = $1`, sourceID); err != nil {
		return err
	}
	embeddingEndpoint, _ := w.embeddingEndpoint(ctx, scopeType, scopeID)
	for index, chunk := range chunks {
		metadata, _ := json.Marshal(map[string]any{"jobId": jobID.String(), "chunkIndex": index})
		var embedding any
		if embeddingEndpoint != nil {
			if values, err := provider.Embed(ctx, *embeddingEndpoint, chunk); err == nil {
				embedding = vectorLiteral(values, 1536)
			}
		}
		if _, err := w.db.ExecContext(ctx, `INSERT INTO knowledge_chunks (source_id, chunk_index, title, content, metadata, embedding) VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::vector)`, sourceID, index, titleForChunk(content), chunk, metadata, embedding); err != nil {
			return err
		}
	}
	return nil
}

func (w *Worker) embeddingEndpoint(ctx context.Context, scopeType string, scopeID uuid.UUID) (*provider.Endpoint, error) {
	if w.secrets == nil {
		return nil, nil
	}
	var endpoint provider.Endpoint
	var credential []byte
	if err := w.db.QueryRowContext(ctx, `SELECT provider_type, base_url, COALESCE(api_path, ''), COALESCE(api_version, ''), COALESCE(embedding_model, ''), credential_ciphertext, timeout_seconds FROM endpoint_settings WHERE enabled = TRUE AND embedding_model IS NOT NULL AND embedding_model <> '' AND ((scope_type = $1 AND scope_id = $2) OR scope_type = 'global') ORDER BY CASE WHEN scope_type = $1 THEN 1 ELSE 2 END, is_default DESC, created_at LIMIT 1`, scopeType, scopeID).Scan(&endpoint.ProviderType, &endpoint.BaseURL, &endpoint.APIPath, &endpoint.APIVersion, &endpoint.EmbeddingModel, &credential, &endpoint.TimeoutSeconds); err != nil {
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

func vectorLiteral(values []float64, dimension int) string {
	if len(values) > dimension {
		values = values[:dimension]
	}
	parts := make([]string, dimension)
	for index := range parts {
		value := 0.0
		if index < len(values) {
			value = values[index]
		}
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
	client := &http.Client{Timeout: 30 * time.Second}
	client.CheckRedirect = func(request *http.Request, _ []*http.Request) error {
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
	body, err := io.ReadAll(io.LimitReader(response.Body, 10*1024*1024))
	if err != nil {
		return "", err
	}
	return cleanWebContent(response.Header.Get("Content-Type"), body), nil
}

func Search(ctx context.Context, db *sql.DB, organizationID, userID uuid.UUID, query string, limit int) ([]models.Citation, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 12 {
		limit = 6
	}
	rows, err := db.QueryContext(ctx, `
		SELECT kc.source_id, ks.title, kc.chunk_index, kc.content
		FROM knowledge_chunks kc
		JOIN knowledge_sources ks ON ks.id = kc.source_id
		WHERE ((ks.scope_type = 'organization' AND ks.scope_id = $1) OR (ks.scope_type = 'user' AND ks.scope_id = $2))
		  AND to_tsvector('simple', kc.content) @@ plainto_tsquery('simple', $3)
		ORDER BY ts_rank(to_tsvector('simple', kc.content), plainto_tsquery('simple', $3)) DESC
		LIMIT $4`, organizationID, userID, query, limit)
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
		if len([]rune(citation.Snippet)) > 260 {
			citation.Snippet = string([]rune(citation.Snippet)[:260]) + "…"
		}
		result = append(result, citation)
	}
	return result, rows.Err()
}

func NewSource(ctx context.Context, db *sql.DB, scopeType string, scopeID, userID uuid.UUID, title, sourceType, sourceURL, mimeType, content string) (models.KnowledgeSource, error) {
	if sourceType != "upload" && sourceType != "url" && sourceType != "text" {
		return models.KnowledgeSource{}, fmt.Errorf("unsupported source type")
	}
	if sourceType == "url" && sourceURL == "" {
		return models.KnowledgeSource{}, fmt.Errorf("source URL is required")
	}
	if title == "" {
		title = "Untitled source"
	}
	sourceID := uuid.New()
	jobID := uuid.New()
	_, err := db.ExecContext(ctx, `INSERT INTO knowledge_sources (id, scope_type, scope_id, title, source_type, source_url, mime_type, content, content_hash, created_by) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''), $10)`, sourceID, scopeType, scopeID, title, sourceType, sourceURL, mimeType, content, hash(content), userID)
	if err != nil {
		return models.KnowledgeSource{}, err
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO ingestion_jobs (id, source_id) VALUES ($1, $2)`, jobID, sourceID); err != nil {
		return models.KnowledgeSource{}, err
	}
	return GetSource(ctx, db, sourceID)
}

func GetSource(ctx context.Context, db *sql.DB, sourceID uuid.UUID) (models.KnowledgeSource, error) {
	var result models.KnowledgeSource
	var sourceURL, mimeType, errorMessage sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT id, scope_type, scope_id, title, source_type, COALESCE(source_url, ''), COALESCE(mime_type, ''), status, COALESCE(error_message, ''), created_at, updated_at FROM knowledge_sources WHERE id = $1`, sourceID).Scan(&result.ID, &result.ScopeType, &result.ScopeID, &result.Title, &result.SourceType, &sourceURL, &mimeType, &result.Status, &errorMessage, &result.CreatedAt, &result.UpdatedAt); err != nil {
		return result, err
	}
	result.SourceURL = sourceURL.String
	result.MimeType = mimeType.String
	result.Error = errorMessage.String
	return result, nil
}

func ListSources(ctx context.Context, db *sql.DB, organizationID, userID uuid.UUID) ([]models.KnowledgeSource, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, scope_type, scope_id, title, source_type, COALESCE(source_url, ''), COALESCE(mime_type, ''), status, COALESCE(error_message, ''), created_at, updated_at FROM knowledge_sources WHERE (scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2) ORDER BY created_at DESC`, organizationID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []models.KnowledgeSource{}
	for rows.Next() {
		var item models.KnowledgeSource
		var sourceURL, mimeType, errorMessage sql.NullString
		if err := rows.Scan(&item.ID, &item.ScopeType, &item.ScopeID, &item.Title, &item.SourceType, &sourceURL, &mimeType, &item.Status, &errorMessage, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.SourceURL, item.MimeType, item.Error = sourceURL.String, mimeType.String, errorMessage.String
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
		reTags := regexp.MustCompile(`(?is)<(script|style|noscript)[^>]*>.*?</(script|style|noscript)>`)
		body = reTags.ReplaceAll(body, nil)
		reTags = regexp.MustCompile(`<[^>]+>`)
		body = reTags.ReplaceAll(body, []byte(" "))
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

func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsLinkLocalMulticast()
}

func ExtractUpload(filename, mimeType string, body []byte) (string, error) {
	if strings.HasSuffix(strings.ToLower(filename), ".pdf") || strings.Contains(mimeType, "pdf") {
		command := exec.Command("pdftotext", "-layout", "-", "-")
		command.Stdin = bytes.NewReader(body)
		output, err := command.Output()
		if err != nil {
			return "", fmt.Errorf("PDF extraction requires pdftotext: %w", err)
		}
		return strings.TrimSpace(string(output)), nil
	}
	return strings.TrimSpace(string(body)), nil
}
