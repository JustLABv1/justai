package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/auth"
	"justai-backend/config"
	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/rag"
	"justai-backend/security"
)

type App struct {
	Config  config.Config
	DB      *sql.DB
	Tokens  *auth.TokenManager
	Secrets *security.SecretBox
	RAG     *rag.Worker
	Live    *TranscriptionManager
}

func New(cfg config.Config, db *sql.DB) *App {
	application := &App{
		Config:  cfg,
		DB:      db,
		Tokens:  auth.NewTokenManager(cfg.JWTSecret),
		Secrets: security.NewSecretBox(cfg.EncryptionKey),
		RAG:     rag.NewWorker(db, cfg.AllowPrivate),
	}
	application.RAG.SetSecretBox(application.Secrets)
	application.Live = NewTranscriptionManager(cfg, db, application.Secrets)
	application.Live.SetApp(application)
	return application
}

func (a *App) Router() *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery(), middleware.RequestID(), middleware.MaxBodyBytes(26*1024*1024), middleware.CORS(a.Config.FrontendOrigins), middleware.RequestLog(a.DB))
	healthHandler := func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "justai-backend"})
	}
	liveHandler := func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	}
	readyHandler := func(c *gin.Context) {
		if a.DB == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "database is not configured"})
			return
		}
		if err := a.DB.PingContext(c); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "database unavailable"})
			return
		}
		var migrated bool
		if err := a.DB.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '008_assistant_ui.sql')`).Scan(&migrated); err != nil || !migrated {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "database migrations are incomplete"})
			return
		}
		if a.RAG == nil || a.Live == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "background workers are unavailable"})
			return
		}
		if _, err := exec.LookPath("pdftotext"); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "pdftotext is unavailable"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	}
	router.GET("/api/v1/health", healthHandler)
	router.GET("/api/v1/health/live", liveHandler)
	router.GET("/api/v1/health/ready", readyHandler)
	// Keep conventional root health paths available to load balancers while
	// retaining the versioned paths used by the compose health checks.
	router.GET("/health/live", liveHandler)
	router.GET("/health/ready", readyHandler)

	a.registerAuthRoutes(router)
	transcriptionPublic := router.Group("/api/v1/transcription")
	transcriptionPublic.POST("/join-requests", a.createTranscriptionJoinRequest)
	transcriptionPublic.GET("/join-requests/:id", a.getTranscriptionJoinRequest)
	transcriptionPublic.POST("/capture-tickets", a.createCaptureWSTicket)

	protected := router.Group("/api/v1")
	protected.Use(middleware.RequireAuth(a.Tokens, a.DB))
	protected.GET("/auth/me", a.me)
	protected.GET("/organizations", a.listOrganizations)
	protected.POST("/organizations", a.createOrganization)
	protected.POST("/auth/logout", a.logout)
	protected.GET("/providers/supported", a.supportedProviders)
	protected.GET("/mcp/oauth/callback", a.mcpOAuthCallback)

	org := protected.Group("")
	org.Use(middleware.RequireOrg(a.DB))
	org.GET("/endpoints", a.listEndpoints)
	org.POST("/endpoints", a.createEndpoint)
	org.PATCH("/endpoints/:id", a.updateEndpoint)
	org.DELETE("/endpoints/:id", a.deleteEndpoint)
	org.POST("/endpoints/:id/test", a.testEndpoint)
	org.GET("/endpoints/:id/models", a.discoverEndpointModels)
	org.POST("/ws/tickets", a.createWSTicket)
	org.POST("/voice/speech", a.synthesizeVoiceSpeech)
	org.GET("/transcription/sessions", a.listTranscriptionSessions)
	org.POST("/transcription/sessions", a.createTranscriptionSession)
	org.GET("/transcription/sessions/:id", a.getTranscriptionSession)
	org.PATCH("/transcription/sessions/:id", a.updateTranscriptionSession)
	org.DELETE("/transcription/sessions/:id", a.deleteTranscriptionSession)
	org.POST("/transcription/sessions/:id/pause", a.pauseTranscriptionSession)
	org.POST("/transcription/sessions/:id/resume", a.resumeTranscriptionSession)
	org.POST("/transcription/sessions/:id/stop", a.stopTranscriptionSession)
	org.POST("/transcription/sessions/:id/sources", a.createTranscriptionSource)
	org.POST("/transcription/sessions/:id/join-code", a.rotateTranscriptionJoinCode)
	org.GET("/transcription/sessions/:id/join-requests", a.listTranscriptionJoinRequests)
	org.POST("/transcription/join-requests/:id/approve", a.approveTranscriptionJoinRequest)
	org.POST("/transcription/join-requests/:id/deny", a.denyTranscriptionJoinRequest)
	org.PATCH("/transcription/sessions/:id/speakers/:speakerId", a.renameTranscriptionSpeaker)
	org.POST("/transcription/sessions/:id/speakers/merge", a.mergeTranscriptionSpeakers)
	org.GET("/transcription/sessions/:id/recordings", a.listTranscriptionRecordings)
	org.GET("/transcription/recordings/:id", a.streamTranscriptionRecording)
	org.DELETE("/transcription/recordings/:id", a.deleteTranscriptionRecording)
	org.POST("/transcription/recordings/:id/start", a.startTranscriptionRecording)
	org.PUT("/transcription/recordings/:id/parts/:part", a.appendTranscriptionRecordingPart)
	org.POST("/transcription/recordings/:id/complete", a.completeTranscriptionRecording)
	org.GET("/knowledge/sources", a.listKnowledgeSources)
	org.POST("/knowledge/sources", a.createKnowledgeSource)
	org.POST("/knowledge/sources/:id/reindex", a.reindexKnowledgeSource)
	org.DELETE("/knowledge/sources/:id", a.deleteKnowledgeSource)
	org.GET("/conversations/:id/context", a.getConversationContext)
	org.POST("/conversations/:id/context/knowledge/:sourceId", a.attachConversationKnowledge)
	org.DELETE("/conversations/:id/context/knowledge/:sourceId", a.detachConversationKnowledge)
	org.POST("/conversations/:id/context/mcp/:serverId", a.attachConversationMCP)
	org.DELETE("/conversations/:id/context/mcp/:serverId", a.detachConversationMCP)
	org.POST("/conversations/:id/context/transcription/:sessionId", a.attachConversationTranscription)
	org.DELETE("/conversations/:id/context/transcription/:sessionId", a.detachConversationTranscription)
	org.POST("/conversations/:id/attachments", a.createConversationAttachment)
	org.POST("/conversations/:id/attachments/url", a.createConversationURLAttachment)
	org.POST("/conversations/:id/attachments/text", a.createConversationTextAttachment)
	org.GET("/mcp/servers", a.listMCPServers)
	org.POST("/mcp/servers", a.createMCPServer)
	org.PATCH("/mcp/servers/:id", a.updateMCPServer)
	org.DELETE("/mcp/servers/:id", a.deleteMCPServer)
	org.POST("/mcp/servers/:id/test", a.testMCPServer)
	org.GET("/mcp/servers/:id/tools", a.listMCPTools)
	org.GET("/mcp/servers/:id/oauth/start", a.mcpOAuthStart)
	org.GET("/conversations", a.listConversations)
	org.POST("/conversations", a.createConversation)
	org.PATCH("/conversations/:id", a.updateConversation)
	org.DELETE("/conversations/:id", a.deleteConversation)
	org.GET("/conversations/:id/messages", a.listConversationMessages)
	org.PUT("/conversations/:id/messages/:messageId", a.upsertAssistantMessage)
	org.PATCH("/conversations/:id/messages/:messageId", a.updateAssistantMessage)
	org.POST("/chat", a.assistantUIChat)

	protected.GET("/ws/voice", a.voiceWebSocket)
	router.GET("/api/v1/ws/transcription", a.transcriptionWebSocket)
	organizationRoutes := protected.Group("/organizations/:id")
	organizationRoutes.Use(middleware.RequireOrg(a.DB))
	organizationRoutes.PATCH("", middleware.RequireOrgRole("owner", "admin"), a.updateOrganization)
	organizationRoutes.GET("/members", a.listOrganizationMembers)
	organizationRoutes.POST("/members", middleware.RequireOrgRole("owner", "admin"), a.addOrganizationMember)
	organizationRoutes.PATCH("/members/:userId", middleware.RequireOrgRole("owner", "admin"), a.updateOrganizationMember)
	organizationRoutes.DELETE("/members/:userId", middleware.RequireOrgRole("owner", "admin"), a.removeOrganizationMember)
	return router
}

func (a *App) registerAuthRoutes(router *gin.Engine) {
	group := router.Group("/api/v1/auth")
	group.POST("/register", a.register)
	group.POST("/login", a.login)
	group.GET("/oidc/start", a.oidcStart)
	group.GET("/oidc/callback", a.oidcCallback)
	group.GET("/config", a.authConfig)
}

func (a *App) issueSession(c *gin.Context, user models.User) error {
	token, err := a.Tokens.Issue(user.ID, user.Email, user.PlatformAdmin)
	if err != nil {
		return err
	}
	a.setSessionCookie(c, token, 12*60*60)
	organizations, err := a.organizationsFor(c, user.ID)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"user": user, "organizations": organizations})
	return nil
}

func (a *App) setSessionCookie(c *gin.Context, token string, maxAge int) {
	c.SetSameSite(a.cookieSameSite())
	c.SetCookie("justai_session", token, maxAge, "/", a.Config.CookieDomain, a.Config.SecureCookies, true)
}

func (a *App) cookieSameSite() http.SameSite {
	switch strings.ToLower(strings.TrimSpace(a.Config.CookieSameSite)) {
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteLaxMode
	}
}

func (a *App) userByID(ctx context.Context, userID uuid.UUID) (models.User, error) {
	var user models.User
	err := a.DB.QueryRowContext(ctx, `SELECT id, email, display_name, is_platform_admin FROM users WHERE id = $1`, userID).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin)
	return user, err
}

func (a *App) organizationsFor(ctx context.Context, userID uuid.UUID) ([]models.Organization, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT o.id, o.name, o.slug, om.role FROM organizations o JOIN organization_members om ON om.organization_id = o.id WHERE om.user_id = $1 ORDER BY o.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []models.Organization{}
	for rows.Next() {
		var item models.Organization
		if err := rows.Scan(&item.ID, &item.Name, &item.Slug, &item.Role); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (a *App) me(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	user, err := a.userByID(c, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	organizations, err := a.organizationsFor(c, user.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user, "organizations": organizations})
}

func (a *App) authConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"oidcEnabled": a.Config.OIDCEnabled(), "oidcLabel": "Continue with OIDC"})
}

func (a *App) listOrganizations(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizations, err := a.organizationsFor(c, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"organizations": organizations})
}

func (a *App) logout(c *gin.Context) {
	a.setSessionCookie(c, "", -1)
	c.Status(http.StatusNoContent)
}

func writeError(c *gin.Context, status int, err error) {
	message := err.Error()
	c.JSON(status, gin.H{
		"error":     message,
		"message":   message,
		"code":      normalizedHTTPCode(status),
		"requestId": middleware.GetRequestID(c),
	})
}

func normalizedHTTPCode(status int) string {
	return strings.ToLower(strings.ReplaceAll(http.StatusText(status), " ", "_"))
}

func decodeJSON(c *gin.Context, target any) bool {
	if err := c.ShouldBindJSON(target); err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid request: %w", err))
		return false
	}
	return true
}

func jsonRaw(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
