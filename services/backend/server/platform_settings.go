package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
)

// platformCapabilityEnabled is used by long-lived chat and voice workflows
// that cannot be wrapped in a Gin middleware without turning off the entire
// workflow. A missing settings row/table keeps the pre-control-plane behavior.
func (a *App) platformCapabilityEnabled(ctx context.Context, feature string) bool {
	if a.DB == nil {
		return true
	}
	column := map[string]string{
		"mcp":           "mcp_enabled",
		"agents":        "agents_enabled",
		"knowledge":     "knowledge_enabled",
		"attachments":   "attachments_enabled",
		"ai":            "ai_enabled",
		"voice":         "voice_enabled",
		"transcription": "transcription_enabled",
	}[strings.ToLower(feature)]
	if column == "" {
		return true
	}
	var enabled bool
	if err := a.DB.QueryRowContext(ctx, `SELECT `+column+` FROM platform_settings WHERE id = TRUE`).Scan(&enabled); err != nil {
		return true
	}
	return enabled
}

type platformSettings struct {
	LoginEnabled         bool   `json:"loginEnabled"`
	LocalAuthEnabled     bool   `json:"localAuthEnabled"`
	SignupEnabled        bool   `json:"signupEnabled"`
	AIEnabled            bool   `json:"aiEnabled"`
	VoiceEnabled         bool   `json:"voiceEnabled"`
	TranscriptionEnabled bool   `json:"transcriptionEnabled"`
	MCPEnabled           bool   `json:"mcpEnabled"`
	KnowledgeEnabled     bool   `json:"knowledgeEnabled"`
	AttachmentsEnabled   bool   `json:"attachmentsEnabled"`
	AgentsEnabled        bool   `json:"agentsEnabled"`
	MaintenanceMessage   string `json:"maintenanceMessage"`
	UpdatedBy            any    `json:"updatedBy,omitempty"`
	UpdatedAt            any    `json:"updatedAt,omitempty"`
}

func (a *App) readPlatformSettings(c *gin.Context) (platformSettings, error) {
	if a.DB == nil {
		return platformSettings{LoginEnabled: true, LocalAuthEnabled: true, SignupEnabled: true, AIEnabled: true, VoiceEnabled: true, TranscriptionEnabled: true, MCPEnabled: true, KnowledgeEnabled: true, AttachmentsEnabled: true, AgentsEnabled: true}, nil
	}
	// Scan by returned column name so an older deployment (or an older
	// compatibility fixture) that predates agents_enabled remains readable.
	// The migration adds the column, but settings are also read during startup
	// and must not silently reset unrelated controls if that migration is still
	// rolling out.
	settings := platformSettings{LoginEnabled: true, LocalAuthEnabled: true, SignupEnabled: true, AIEnabled: true, VoiceEnabled: true, TranscriptionEnabled: true, MCPEnabled: true, KnowledgeEnabled: true, AttachmentsEnabled: true, AgentsEnabled: true}
	rows, err := a.DB.QueryContext(c, `SELECT login_enabled, local_auth_enabled, signup_enabled, ai_enabled, voice_enabled, transcription_enabled, mcp_enabled, knowledge_enabled, attachments_enabled, agents_enabled, maintenance_message, updated_by, updated_at FROM platform_settings WHERE id = TRUE`)
	if err != nil {
		return settings, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return settings, err
		}
		return settings, sql.ErrNoRows
	}
	columns, err := rows.Columns()
	if err != nil {
		return settings, err
	}
	destinations := make([]any, len(columns))
	for index, column := range columns {
		switch strings.ToLower(column) {
		case "login_enabled":
			destinations[index] = &settings.LoginEnabled
		case "local_auth_enabled":
			destinations[index] = &settings.LocalAuthEnabled
		case "signup_enabled":
			destinations[index] = &settings.SignupEnabled
		case "ai_enabled":
			destinations[index] = &settings.AIEnabled
		case "voice_enabled":
			destinations[index] = &settings.VoiceEnabled
		case "transcription_enabled":
			destinations[index] = &settings.TranscriptionEnabled
		case "mcp_enabled":
			destinations[index] = &settings.MCPEnabled
		case "knowledge_enabled":
			destinations[index] = &settings.KnowledgeEnabled
		case "attachments_enabled":
			destinations[index] = &settings.AttachmentsEnabled
		case "agents_enabled":
			destinations[index] = &settings.AgentsEnabled
		case "maintenance_message":
			destinations[index] = &settings.MaintenanceMessage
		case "updated_by":
			destinations[index] = &settings.UpdatedBy
		case "updated_at":
			destinations[index] = &settings.UpdatedAt
		default:
			var ignored any
			destinations[index] = &ignored
		}
	}
	if err := rows.Scan(destinations...); err != nil {
		return settings, err
	}
	return settings, nil
}

func (a *App) featureEnabled(c *gin.Context, feature string) bool {
	settings, err := a.readPlatformSettings(c)
	if err != nil {
		// Before the migration is applied, preserve the existing product behavior.
		return true
	}
	var enabled bool
	switch strings.ToLower(feature) {
	case "ai":
		enabled = settings.AIEnabled
	case "voice":
		enabled = settings.VoiceEnabled
	case "transcription":
		enabled = settings.TranscriptionEnabled
	case "mcp":
		enabled = settings.MCPEnabled
	case "knowledge":
		enabled = settings.KnowledgeEnabled
	case "attachments":
		enabled = settings.AttachmentsEnabled
	case "agents":
		enabled = settings.AgentsEnabled
	default:
		enabled = true
	}
	if enabled {
		return true
	}
	message := strings.TrimSpace(settings.MaintenanceMessage)
	if message == "" {
		message = fmt.Sprintf("%s is temporarily disabled by the platform administrator", feature)
	}
	middleware.AbortError(c, http.StatusServiceUnavailable, "feature_disabled", message)
	return false
}

func (a *App) requirePlatformAdmin(c *gin.Context) bool {
	principal, ok := middleware.GetPrincipal(c)
	if ok && principal.PlatformAdmin {
		return true
	}
	middleware.AbortError(c, http.StatusForbidden, "platform_admin_required", "platform administrator access required")
	return false
}

func (a *App) platformFeature(feature string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if a.featureEnabled(c, feature) {
			c.Next()
		}
	}
}
