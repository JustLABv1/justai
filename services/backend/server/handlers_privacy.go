package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/models"
)

func defaultPrivacySettings() models.PrivacySettings {
	return models.PrivacySettings{}
}

func (a *App) getPrivacySettings(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	settings := defaultPrivacySettings()
	err = a.DB.QueryRowContext(c, `
		SELECT archived_conversation_retention_days, knowledge_retention_days,
		       transcription_retention_days, updated_at
		FROM privacy_settings WHERE user_id = $1 AND organization_id = $2`, principal.UserID, organizationID).Scan(
		&settings.ArchivedConversationRetentionDays,
		&settings.KnowledgeRetentionDays,
		&settings.TranscriptionRetentionDays,
		&settings.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusOK, gin.H{"settings": settings})
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"settings": settings})
}

func (a *App) putPrivacySettings(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var request models.PrivacySettings
	if !decodeJSON(c, &request) {
		return
	}
	if err := validateRetentionDays(request.ArchivedConversationRetentionDays, request.KnowledgeRetentionDays, request.TranscriptionRetentionDays); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	var settings models.PrivacySettings
	err = a.DB.QueryRowContext(c, `
		INSERT INTO privacy_settings (user_id, organization_id, archived_conversation_retention_days, knowledge_retention_days, transcription_retention_days)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id, organization_id) DO UPDATE SET
			archived_conversation_retention_days = EXCLUDED.archived_conversation_retention_days,
			knowledge_retention_days = EXCLUDED.knowledge_retention_days,
			transcription_retention_days = EXCLUDED.transcription_retention_days,
			updated_at = now()
		RETURNING archived_conversation_retention_days, knowledge_retention_days, transcription_retention_days, updated_at
	`, principal.UserID, organizationID, request.ArchivedConversationRetentionDays, request.KnowledgeRetentionDays, request.TranscriptionRetentionDays).Scan(
		&settings.ArchivedConversationRetentionDays,
		&settings.KnowledgeRetentionDays,
		&settings.TranscriptionRetentionDays,
		&settings.UpdatedAt,
	)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"settings": settings})
}

func validateRetentionDays(values ...int) error {
	for _, value := range values {
		if value < 0 || value > 3650 {
			return fmt.Errorf("retention must be between 0 and 3650 days; 0 means never delete")
		}
	}
	return nil
}

type privacyCleanupResult struct {
	Conversations int `json:"conversations"`
	Knowledge     int `json:"knowledge"`
	Transcripts   int `json:"transcripts"`
}

func (a *App) runPrivacyCleanup(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	settings := defaultPrivacySettings()
	_ = a.DB.QueryRowContext(c, `SELECT archived_conversation_retention_days, knowledge_retention_days, transcription_retention_days FROM privacy_settings WHERE user_id = $1 AND organization_id = $2`, principal.UserID, organizationID).Scan(&settings.ArchivedConversationRetentionDays, &settings.KnowledgeRetentionDays, &settings.TranscriptionRetentionDays)
	result, err := a.cleanupPrivacyData(c, principal.UserID, organizationID, settings)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": result})
}

func (a *App) cleanupPrivacyData(ctx context.Context, userID, organizationID uuid.UUID, settings models.PrivacySettings) (privacyCleanupResult, error) {
	var result privacyCleanupResult
	if settings.ArchivedConversationRetentionDays > 0 {
		cutoff := time.Now().Add(-time.Duration(settings.ArchivedConversationRetentionDays) * 24 * time.Hour)
		deleted, err := a.DB.ExecContext(ctx, `DELETE FROM conversations WHERE user_id = $1 AND organization_id = $2 AND archived_at IS NOT NULL AND archived_at < $3`, userID, organizationID, cutoff)
		if err != nil {
			return result, err
		}
		result.Conversations = rowsAffected(deleted)
	}
	if settings.KnowledgeRetentionDays > 0 {
		cutoff := time.Now().Add(-time.Duration(settings.KnowledgeRetentionDays) * 24 * time.Hour)
		deleted, err := a.DB.ExecContext(ctx, `DELETE FROM knowledge_sources WHERE scope_type = 'user' AND scope_id = $1 AND created_at < $2`, userID, cutoff)
		if err != nil {
			return result, err
		}
		result.Knowledge = rowsAffected(deleted)
	}
	if settings.TranscriptionRetentionDays > 0 {
		cutoff := time.Now().Add(-time.Duration(settings.TranscriptionRetentionDays) * 24 * time.Hour)
		rows, err := a.DB.QueryContext(ctx, `SELECT id FROM transcription_sessions WHERE user_id = $1 AND organization_id = $2 AND COALESCE(ended_at, updated_at) < $3 AND status IN ('completed', 'failed')`, userID, organizationID, cutoff)
		if err != nil {
			return result, err
		}
		sessionIDs := make([]uuid.UUID, 0)
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return result, err
			}
			sessionIDs = append(sessionIDs, id)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return result, err
		}
		_ = rows.Close()
		for _, sessionID := range sessionIDs {
			if a.Live != nil {
				recordings, recordingErr := a.DB.QueryContext(ctx, `SELECT id FROM transcription_recordings WHERE session_id = $1`, sessionID)
				if recordingErr != nil {
					return result, recordingErr
				}
				var recordingIDs []uuid.UUID
				for recordings.Next() {
					var recordingID uuid.UUID
					if scanErr := recordings.Scan(&recordingID); scanErr != nil {
						_ = recordings.Close()
						return result, scanErr
					}
					recordingIDs = append(recordingIDs, recordingID)
				}
				_ = recordings.Close()
				for _, recordingID := range recordingIDs {
					if err := a.Live.deleteRecording(ctx, recordingID); err != nil {
						return result, err
					}
				}
			}
			deleted, deleteErr := a.DB.ExecContext(ctx, `DELETE FROM transcription_sessions WHERE id = $1 AND user_id = $2 AND organization_id = $3`, sessionID, userID, organizationID)
			if deleteErr != nil {
				return result, deleteErr
			}
			result.Transcripts += rowsAffected(deleted)
		}
	}
	return result, nil
}

func rowsAffected(result sql.Result) int {
	count, err := result.RowsAffected()
	if err != nil || count < 0 {
		return 0
	}
	return int(count)
}

type privacyExportMessage struct {
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

type privacyExportConversation struct {
	ID         uuid.UUID              `json:"id"`
	Title      string                 `json:"title"`
	Visibility string                 `json:"visibility"`
	CreatedAt  time.Time              `json:"createdAt"`
	UpdatedAt  time.Time              `json:"updatedAt"`
	Messages   []privacyExportMessage `json:"messages"`
}

func (a *App) exportPrivacyData(c *gin.Context) {
	principal, organizationID, err := workspaceScope(c)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	export := gin.H{
		"exportedAt":     time.Now().UTC(),
		"userId":         principal.UserID,
		"organizationId": organizationID,
		"conversations":  []privacyExportConversation{},
		"notes":          []map[string]any{},
		"memories":       []map[string]any{},
		"projects":       []map[string]any{},
		"knowledge":      []map[string]any{},
		"transcriptions": []map[string]any{},
	}
	conversations := make([]privacyExportConversation, 0)
	conversationRows, err := a.DB.QueryContext(c, `SELECT id, title, visibility, created_at, updated_at FROM conversations WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at`, principal.UserID, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	for conversationRows.Next() {
		var item privacyExportConversation
		if err := conversationRows.Scan(&item.ID, &item.Title, &item.Visibility, &item.CreatedAt, &item.UpdatedAt); err != nil {
			_ = conversationRows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item.Messages = make([]privacyExportMessage, 0)
		messageRows, messageErr := a.DB.QueryContext(c, `SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at`, item.ID)
		if messageErr != nil {
			_ = conversationRows.Close()
			writeError(c, http.StatusInternalServerError, messageErr)
			return
		}
		for messageRows.Next() {
			var message privacyExportMessage
			if scanErr := messageRows.Scan(&message.Role, &message.Content, &message.CreatedAt); scanErr != nil {
				_ = messageRows.Close()
				_ = conversationRows.Close()
				writeError(c, http.StatusInternalServerError, scanErr)
				return
			}
			item.Messages = append(item.Messages, message)
		}
		_ = messageRows.Close()
		conversations = append(conversations, item)
	}
	if err := conversationRows.Err(); err != nil {
		_ = conversationRows.Close()
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	_ = conversationRows.Close()
	export["conversations"] = conversations

	if err := a.collectPrivacyRows(c, &export, principal.UserID, organizationID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Header("Content-Disposition", `attachment; filename="justai-data-export.json"`)
	c.JSON(http.StatusOK, export)
}

func (a *App) collectPrivacyRows(ctx context.Context, export *gin.H, userID, organizationID uuid.UUID) error {
	noteRows, err := a.DB.QueryContext(ctx, `SELECT id, title, content, visibility, created_at, updated_at FROM notes WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at`, userID, organizationID)
	if err != nil {
		return err
	}
	notes := make([]map[string]any, 0)
	for noteRows.Next() {
		var id uuid.UUID
		var title, content, visibility string
		var createdAt, updatedAt time.Time
		if err := noteRows.Scan(&id, &title, &content, &visibility, &createdAt, &updatedAt); err != nil {
			_ = noteRows.Close()
			return err
		}
		notes = append(notes, map[string]any{"id": id, "title": title, "content": content, "visibility": visibility, "createdAt": createdAt, "updatedAt": updatedAt})
	}
	_ = noteRows.Close()
	(*export)["notes"] = notes

	for key, query := range map[string]string{
		"memories":       `SELECT id, content, source, enabled, created_at, updated_at FROM memories WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at`,
		"projects":       `SELECT id, name, description, visibility, created_at, updated_at FROM workspace_projects WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at`,
		"knowledge":      `SELECT id, title, source_type, source_url, content, status, created_at, updated_at FROM knowledge_sources WHERE scope_type = 'user' AND scope_id = $1 AND $2::uuid IS NOT NULL ORDER BY created_at`,
		"transcriptions": `SELECT id, title, kind, status, language, record_audio, created_at, updated_at, archived_at FROM transcription_sessions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at`,
	} {
		rows, queryErr := a.DB.QueryContext(ctx, query, userID, organizationID)
		if queryErr != nil {
			return queryErr
		}
		values := make([]map[string]any, 0)
		columns, columnsErr := rows.Columns()
		if columnsErr != nil {
			_ = rows.Close()
			return columnsErr
		}
		for rows.Next() {
			cells := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for index := range cells {
				pointers[index] = &cells[index]
			}
			if scanErr := rows.Scan(pointers...); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			value := make(map[string]any, len(columns))
			for index, column := range columns {
				value[column] = cells[index]
			}
			values = append(values, value)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return rowsErr
		}
		_ = rows.Close()
		(*export)[key] = values
	}
	return nil
}

func (a *App) StartLifecycleWorker(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.cleanupAllPrivacySettings(ctx)
			}
		}
	}()
}

func (a *App) cleanupAllPrivacySettings(ctx context.Context) {
	rows, err := a.DB.QueryContext(ctx, `SELECT user_id, organization_id, archived_conversation_retention_days, knowledge_retention_days, transcription_retention_days FROM privacy_settings`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var userID, organizationID uuid.UUID
		var settings models.PrivacySettings
		if err := rows.Scan(&userID, &organizationID, &settings.ArchivedConversationRetentionDays, &settings.KnowledgeRetentionDays, &settings.TranscriptionRetentionDays); err != nil {
			return
		}
		_, _ = a.cleanupPrivacyData(ctx, userID, organizationID, settings)
	}
}
