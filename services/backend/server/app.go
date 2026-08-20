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

	repositoryImportSlots chan struct{}
}

func New(cfg config.Config, db *sql.DB) *App {
	application := &App{
		Config:                cfg,
		DB:                    db,
		Tokens:                auth.NewTokenManager(cfg.JWTSecret),
		Secrets:               security.NewSecretBox(cfg.EncryptionKey),
		RAG:                   rag.NewWorker(db, cfg.AllowPrivate),
		repositoryImportSlots: make(chan struct{}, 2),
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
		var repositoryStorageReady bool
		if err := a.DB.QueryRowContext(c, `
			SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '029_saved_assistants.sql')
			   AND to_regclass('public.repository_contexts') IS NOT NULL
			   AND to_regclass('public.repository_context_files') IS NOT NULL
			   AND to_regclass('public.conversation_repository_contexts') IS NOT NULL
			   AND to_regclass('public.saved_assistants') IS NOT NULL
			   AND to_regclass('public.saved_assistant_versions') IS NOT NULL`).Scan(&repositoryStorageReady); err != nil || !repositoryStorageReady {
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
		if _, err := exec.LookPath("ffmpeg"); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "ffmpeg is unavailable"})
			return
		}
		if _, err := exec.LookPath("ffprobe"); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "ffprobe is unavailable"})
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
	transcriptionPublic.POST("/join-requests", a.platformFeature("transcription"), a.createTranscriptionJoinRequest)
	transcriptionPublic.GET("/join-requests/:id", a.platformFeature("transcription"), a.getTranscriptionJoinRequest)
	transcriptionPublic.POST("/capture-tickets", a.platformFeature("transcription"), a.createCaptureWSTicket)

	protected := router.Group("/api/v1")
	protected.Use(middleware.RequireAuth(a.Tokens, a.DB))
	protected.GET("/auth/me", a.me)
	protected.GET("/organizations", a.listOrganizations)
	protected.POST("/organizations", a.createOrganization)
	protected.POST("/auth/logout", a.logout)
	protected.GET("/providers/supported", a.supportedProviders)
	protected.GET("/mcp/oauth/callback", a.mcpOAuthCallback)
	protected.GET("/admin/defaults", a.getGlobalAdminDefaults)
	protected.PUT("/admin/defaults", a.putGlobalAdminDefaults)
	protected.GET("/admin/analytics", a.getPlatformAnalytics)
	protected.GET("/admin/dashboard", a.getPlatformDashboard)
	protected.GET("/admin/overview", a.getPlatformOverview)
	protected.GET("/admin/settings", a.getPlatformSettings)
	protected.PUT("/admin/settings", a.putPlatformSettings)
	protected.GET("/admin/oidc/providers", a.listPlatformOIDCProviders)
	protected.POST("/admin/oidc/providers", a.createPlatformOIDCProvider)
	protected.PATCH("/admin/oidc/providers/:id", a.updatePlatformOIDCProvider)
	protected.DELETE("/admin/oidc/providers/:id", a.deletePlatformOIDCProvider)
	protected.POST("/admin/oidc/providers/:id/test", a.testPlatformOIDCProvider)
	protected.GET("/admin/banners", a.listPlatformBanners)
	protected.POST("/admin/banners", a.createPlatformBanner)
	protected.PATCH("/admin/banners/:id", a.updatePlatformBanner)
	protected.DELETE("/admin/banners/:id", a.deletePlatformBanner)
	protected.GET("/admin/users", a.listPlatformUsers)
	protected.GET("/admin/users/:id", a.getPlatformUser)
	protected.PATCH("/admin/users/:id", a.updatePlatformUser)
	protected.POST("/admin/users/:id/revoke-sessions", a.revokePlatformUserSessions)
	protected.DELETE("/admin/users/:id", a.deletePlatformUser)
	protected.GET("/admin/organizations", a.listPlatformOrganizations)
	protected.GET("/admin/organizations/:id", a.getPlatformOrganization)
	protected.PATCH("/admin/organizations/:id", a.updatePlatformOrganization)
	protected.POST("/admin/organizations/:id/transfer-ownership", a.transferPlatformOrganizationOwnership)
	protected.DELETE("/admin/organizations/:id", a.deletePlatformOrganization)
	protected.GET("/admin/endpoints", a.listPlatformEndpoints)
	protected.POST("/admin/endpoints", a.createPlatformEndpoint)
	protected.POST("/admin/endpoints/preflight", a.preflightPlatformEndpoint)
	protected.PATCH("/admin/endpoints/:id", a.updatePlatformEndpoint)
	protected.DELETE("/admin/endpoints/:id", a.deletePlatformEndpoint)
	protected.POST("/admin/endpoints/:id/test", a.testPlatformEndpoint)
	protected.GET("/admin/endpoints/:id/models", a.discoverPlatformEndpointModels)
	protected.GET("/admin/mcp/servers", a.listPlatformMCPServers)
	protected.POST("/admin/mcp/servers", a.createPlatformMCPServer)
	protected.PATCH("/admin/mcp/servers/:id", a.updatePlatformMCPServer)
	protected.DELETE("/admin/mcp/servers/:id", a.deletePlatformMCPServer)
	protected.POST("/admin/mcp/servers/:id/icon", a.uploadPlatformMCPServerIcon)
	protected.DELETE("/admin/mcp/servers/:id/icon", a.deletePlatformMCPServerIcon)
	protected.POST("/admin/mcp/servers/:id/test", a.testPlatformMCPServer)
	protected.GET("/admin/mcp/servers/:id/tools", a.discoverPlatformMCPTools)
	protected.GET("/admin/audit", a.listPlatformAudit)
	protected.GET("/admin/health", a.getPlatformHealth)

	org := protected.Group("")
	org.Use(middleware.RequireOrg(a.DB))
	org.GET("/endpoints", a.listEndpoints)
	org.POST("/endpoints", a.createEndpoint)
	org.POST("/endpoints/preflight", a.platformFeature("ai"), a.preflightEndpoint)
	org.PATCH("/endpoints/:id", a.updateEndpoint)
	org.DELETE("/endpoints/:id", a.deleteEndpoint)
	org.POST("/endpoints/:id/test", a.platformFeature("ai"), a.testEndpoint)
	org.GET("/endpoints/:id/models", a.platformFeature("ai"), a.discoverEndpointModels)
	org.POST("/ws/tickets", a.platformFeature("ai"), a.createWSTicket)
	org.POST("/voice/speech", a.platformFeature("voice"), a.synthesizeVoiceSpeech)
	org.GET("/transcription/sessions", a.platformFeature("transcription"), a.listTranscriptionSessions)
	org.POST("/transcription/sessions", a.platformFeature("transcription"), a.createTranscriptionSession)
	org.GET("/transcription/sessions/:id", a.platformFeature("transcription"), a.getTranscriptionSession)
	org.PATCH("/transcription/sessions/:id", a.platformFeature("transcription"), a.updateTranscriptionSession)
	org.DELETE("/transcription/sessions/:id", a.platformFeature("transcription"), a.deleteTranscriptionSession)
	org.POST("/transcription/sessions/:id/pause", a.platformFeature("transcription"), a.pauseTranscriptionSession)
	org.POST("/transcription/sessions/:id/resume", a.platformFeature("transcription"), a.resumeTranscriptionSession)
	org.POST("/transcription/sessions/:id/stop", a.platformFeature("transcription"), a.stopTranscriptionSession)
	org.POST("/transcription/sessions/:id/video-uploads", a.platformFeature("transcription"), a.initVideoTranscriptionUpload)
	org.GET("/transcription/video-uploads/:id", a.platformFeature("transcription"), a.getVideoTranscriptionUpload)
	org.POST("/transcription/video-uploads/:id/complete", a.platformFeature("transcription"), a.completeVideoTranscriptionUpload)
	org.POST("/transcription/video-uploads/:id/retry", a.platformFeature("transcription"), a.retryVideoTranscription)
	org.POST("/transcription/video-uploads/:id/cancel", a.platformFeature("transcription"), a.cancelVideoTranscription)
	org.GET("/transcription/video-uploads/:id/playback", a.platformFeature("transcription"), a.getVideoTranscriptionPlayback)
	org.POST("/transcription/sessions/:id/sources", a.platformFeature("transcription"), a.createTranscriptionSource)
	org.POST("/transcription/sessions/:id/join-code", a.platformFeature("transcription"), a.rotateTranscriptionJoinCode)
	org.GET("/transcription/sessions/:id/join-requests", a.platformFeature("transcription"), a.listTranscriptionJoinRequests)
	org.POST("/transcription/join-requests/:id/approve", a.platformFeature("transcription"), a.approveTranscriptionJoinRequest)
	org.POST("/transcription/join-requests/:id/deny", a.platformFeature("transcription"), a.denyTranscriptionJoinRequest)
	org.PATCH("/transcription/sessions/:id/speakers/:speakerId", a.platformFeature("transcription"), a.renameTranscriptionSpeaker)
	org.POST("/transcription/sessions/:id/speakers/merge", a.platformFeature("transcription"), a.mergeTranscriptionSpeakers)
	org.GET("/transcription/sessions/:id/recordings", a.platformFeature("transcription"), a.listTranscriptionRecordings)
	org.GET("/transcription/recordings/:id", a.platformFeature("transcription"), a.streamTranscriptionRecording)
	org.DELETE("/transcription/recordings/:id", a.platformFeature("transcription"), a.deleteTranscriptionRecording)
	org.POST("/transcription/recordings/:id/start", a.platformFeature("transcription"), a.startTranscriptionRecording)
	org.PUT("/transcription/recordings/:id/parts/:part", a.platformFeature("transcription"), a.appendTranscriptionRecordingPart)
	org.POST("/transcription/recordings/:id/complete", a.platformFeature("transcription"), a.completeTranscriptionRecording)
	org.GET("/knowledge/sources", a.platformFeature("knowledge"), a.listKnowledgeSources)
	org.POST("/knowledge/sources", a.platformFeature("knowledge"), a.createKnowledgeSource)
	org.POST("/knowledge/sources/:id/reindex", a.platformFeature("knowledge"), a.reindexKnowledgeSource)
	org.DELETE("/knowledge/sources/:id", a.platformFeature("knowledge"), a.deleteKnowledgeSource)
	org.GET("/repositories", a.platformFeature("knowledge"), a.listUserRepositoryContexts)
	org.GET("/memories", a.listMemories)
	org.POST("/memories", a.createMemory)
	org.PATCH("/memories/:id", a.updateMemory)
	org.DELETE("/memories/:id", a.deleteMemory)
	org.GET("/assistants", a.listSavedAssistants)
	org.POST("/assistants", a.createSavedAssistant)
	org.GET("/assistants/:id", a.getSavedAssistant)
	org.PATCH("/assistants/:id", a.updateSavedAssistant)
	org.DELETE("/assistants/:id", a.deleteSavedAssistant)
	org.GET("/conversation-folders", a.listConversationFolders)
	org.POST("/conversation-folders", a.createConversationFolder)
	org.PATCH("/conversation-folders/:id", a.updateConversationFolder)
	org.DELETE("/conversation-folders/:id", a.deleteConversationFolder)
	org.GET("/conversation-tags", a.listConversationTags)
	org.POST("/conversation-tags", a.createConversationTag)
	org.PATCH("/conversation-tags/:id", a.updateConversationTag)
	org.DELETE("/conversation-tags/:id", a.deleteConversationTag)
	org.POST("/conversations/:id/tags/:tagId", a.attachConversationTag)
	org.DELETE("/conversations/:id/tags/:tagId", a.detachConversationTag)
	org.GET("/notes", a.listNotes)
	org.POST("/notes", a.createNote)
	org.GET("/notes/:id", a.getNote)
	org.PATCH("/notes/:id", a.updateNote)
	org.DELETE("/notes/:id", a.deleteNote)
	org.GET("/web/search", a.webSearch)
	org.GET("/web/fetch", a.webFetch)
	org.POST("/images/generate", a.generateImage)
	org.POST("/images/edit", a.editImage)
	org.GET("/images/:id", a.serveGeneratedImage)
	org.GET("/conversations/:id/context", a.getConversationContext)
	org.POST("/conversations/:id/repositories", a.platformFeature("knowledge"), a.createRepositoryContext)
	org.DELETE("/conversations/:id/context/repositories/:repositoryId", a.platformFeature("knowledge"), a.deleteRepositoryContext)
	org.POST("/conversations/:id/context/knowledge/:sourceId", a.platformFeature("knowledge"), a.attachConversationKnowledge)
	org.PATCH("/conversations/:id/context/knowledge/:sourceId", a.platformFeature("knowledge"), a.updateConversationKnowledge)
	org.DELETE("/conversations/:id/context/knowledge/:sourceId", a.platformFeature("knowledge"), a.detachConversationKnowledge)
	org.POST("/conversations/:id/context/notes/:noteId", a.attachConversationNote)
	org.DELETE("/conversations/:id/context/notes/:noteId", a.detachConversationNote)
	org.POST("/conversations/:id/context/mcp/:serverId", a.platformFeature("mcp"), a.attachConversationMCP)
	org.DELETE("/conversations/:id/context/mcp/:serverId", a.platformFeature("mcp"), a.detachConversationMCP)
	org.POST("/conversations/:id/context/transcription/:sessionId", a.platformFeature("transcription"), a.attachConversationTranscription)
	org.DELETE("/conversations/:id/context/transcription/:sessionId", a.platformFeature("transcription"), a.detachConversationTranscription)
	org.POST("/conversations/:id/attachments", a.platformFeature("attachments"), a.createConversationAttachment)
	org.POST("/conversations/:id/attachments/url", a.platformFeature("attachments"), a.createConversationURLAttachment)
	org.POST("/conversations/:id/attachments/text", a.platformFeature("attachments"), a.createConversationTextAttachment)
	org.GET("/mcp/servers", a.platformFeature("mcp"), a.listMCPServers)
	org.POST("/mcp/servers", a.platformFeature("mcp"), a.createMCPServer)
	org.PATCH("/mcp/servers/:id", a.platformFeature("mcp"), a.updateMCPServer)
	org.DELETE("/mcp/servers/:id", a.platformFeature("mcp"), a.deleteMCPServer)
	org.POST("/mcp/servers/:id/test", a.platformFeature("mcp"), a.testMCPServer)
	org.GET("/mcp/servers/:id/tools", a.platformFeature("mcp"), a.listMCPTools)
	org.GET("/mcp/servers/:id/resources", a.platformFeature("mcp"), a.listMCPResources)
	org.POST("/mcp/servers/:id/resources/read", a.platformFeature("mcp"), a.readMCPResource)
	org.GET("/mcp/servers/:id/prompts", a.platformFeature("mcp"), a.listMCPPrompts)
	org.POST("/mcp/servers/:id/prompts/get", a.platformFeature("mcp"), a.getMCPPrompt)
	org.POST("/mcp/apps", a.platformFeature("mcp"), a.mcpAppsBridge)
	org.GET("/mcp/servers/:id/oauth/start", a.platformFeature("mcp"), a.mcpOAuthStart)
	org.GET("/conversations", a.listConversations)
	org.POST("/conversations", a.createConversation)
	org.GET("/conversations/:id", a.getConversation)
	org.PATCH("/conversations/:id", a.updateConversation)
	org.DELETE("/conversations/:id", a.deleteConversation)
	org.GET("/conversations/:id/messages", a.listConversationMessages)
	org.PUT("/conversations/:id/messages/:messageId", a.upsertAssistantMessage)
	org.PATCH("/conversations/:id/messages/:messageId", a.updateAssistantMessage)
	org.POST("/chat", a.platformFeature("ai"), a.assistantUIChat)
	org.GET("/chat/resume/:streamId", a.platformFeature("ai"), a.resumeChatStream)

	protected.GET("/ws/voice", a.platformFeature("voice"), a.voiceWebSocket)
	protected.GET("/mcp/servers/:id/icon", a.serveMCPServerIcon)
	protected.POST("/mcp/servers/:id/icon", a.uploadMCPServerIcon)
	protected.DELETE("/mcp/servers/:id/icon", a.deleteMCPServerIcon)
	router.GET("/api/v1/ws/transcription", a.platformFeature("transcription"), a.transcriptionWebSocket)
	organizationRoutes := protected.Group("/organizations/:id")
	organizationRoutes.Use(middleware.RequireOrg(a.DB))
	organizationRoutes.PATCH("", middleware.RequireOrgRole("owner", "admin"), a.updateOrganization)
	organizationRoutes.GET("/admin/defaults", middleware.RequireOrgRole("owner", "admin"), a.getOrganizationAdminDefaults)
	organizationRoutes.PUT("/admin/defaults", middleware.RequireOrgRole("owner", "admin"), a.putOrganizationAdminDefaults)
	organizationRoutes.GET("/admin/analytics", middleware.RequireOrgRole("owner", "admin"), a.getOrganizationAnalytics)
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
	group.GET("/oidc/:provider/start", a.oidcStart)
	group.GET("/oidc/callback", a.oidcCallback)
	group.GET("/config", a.authConfig)
}

func (a *App) issueSession(c *gin.Context, user models.User) error {
	token, err := a.Tokens.Issue(user.ID, user.Email, user.PlatformAdmin, user.SessionVersion)
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
	err := a.DB.QueryRowContext(ctx, `SELECT id, email, display_name, is_platform_admin, COALESCE(status, 'active'), suspended_at, COALESCE(suspended_reason, ''), COALESCE(session_version, 0), last_login_at FROM users WHERE id = $1`, userID).Scan(&user.ID, &user.Email, &user.DisplayName, &user.PlatformAdmin, &user.Status, &user.SuspendedAt, &user.SuspendedReason, &user.SessionVersion, &user.LastLoginAt)
	return user, err
}

func (a *App) organizationsFor(ctx context.Context, userID uuid.UUID) ([]models.Organization, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT o.id, o.name, o.slug, om.role, COALESCE(o.status, 'active') FROM organizations o JOIN organization_members om ON om.organization_id = o.id WHERE om.user_id = $1 ORDER BY o.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []models.Organization{}
	for rows.Next() {
		var item models.Organization
		if err := rows.Scan(&item.ID, &item.Name, &item.Slug, &item.Role, &item.Status); err != nil {
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
	settings, err := a.readPlatformSettings(c)
	if err != nil {
		settings = platformSettings{LoginEnabled: true, LocalAuthEnabled: true, SignupEnabled: true, AIEnabled: true, VoiceEnabled: true, TranscriptionEnabled: true, MCPEnabled: true, KnowledgeEnabled: true, AttachmentsEnabled: true}
	}
	providers := a.publicOIDCProviders(c)
	c.JSON(http.StatusOK, gin.H{
		"oidcEnabled":        len(providers) > 0,
		"oidcLabel":          "Continue with OIDC",
		"oidcProviders":      providers,
		"loginEnabled":       settings.LoginEnabled,
		"localAuthEnabled":   settings.LocalAuthEnabled,
		"signupEnabled":      settings.SignupEnabled,
		"maintenanceMessage": settings.MaintenanceMessage,
		"banners":            a.activePlatformBanners(c),
	})
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
