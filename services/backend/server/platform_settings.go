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
	SignupEnabled        bool   `json:"signupEnabled"`
	AIEnabled            bool   `json:"aiEnabled"`
	VoiceEnabled         bool   `json:"voiceEnabled"`
	TranscriptionEnabled bool   `json:"transcriptionEnabled"`
	MCPEnabled           bool   `json:"mcpEnabled"`
	KnowledgeEnabled     bool   `json:"knowledgeEnabled"`
	AttachmentsEnabled   bool   `json:"attachmentsEnabled"`
	MaintenanceMessage   string `json:"maintenanceMessage"`
	UpdatedBy            any    `json:"updatedBy,omitempty"`
	UpdatedAt            any    `json:"updatedAt,omitempty"`
}

func (a *App) readPlatformSettings(c *gin.Context) (platformSettings, error) {
	var settings platformSettings
	err := a.DB.QueryRowContext(c, `SELECT login_enabled, signup_enabled, ai_enabled, voice_enabled, transcription_enabled, mcp_enabled, knowledge_enabled, attachments_enabled, maintenance_message, updated_by, updated_at FROM platform_settings WHERE id = TRUE`).Scan(
		&settings.LoginEnabled, &settings.SignupEnabled, &settings.AIEnabled, &settings.VoiceEnabled,
		&settings.TranscriptionEnabled, &settings.MCPEnabled, &settings.KnowledgeEnabled,
		&settings.AttachmentsEnabled, &settings.MaintenanceMessage, &settings.UpdatedBy, &settings.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return platformSettings{LoginEnabled: true, SignupEnabled: true, AIEnabled: true, VoiceEnabled: true, TranscriptionEnabled: true, MCPEnabled: true, KnowledgeEnabled: true, AttachmentsEnabled: true}, nil
	}
	return settings, err
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
