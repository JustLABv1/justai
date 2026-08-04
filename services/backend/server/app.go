package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
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
	return application
}

func (a *App) Router() *gin.Engine {
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery(), middleware.CORS(a.Config.FrontendOrigins), middleware.RequestLog(a.DB))
	router.GET("/api/v1/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "justai-backend"})
	})

	a.registerAuthRoutes(router)

	protected := router.Group("/api/v1")
	protected.Use(middleware.RequireAuth(a.Tokens, a.DB))
	protected.GET("/auth/me", a.me)
	protected.GET("/organizations", a.listOrganizations)
	protected.POST("/auth/logout", a.logout)
	protected.GET("/providers/supported", a.supportedProviders)
	protected.GET("/mcp/oauth/callback", a.mcpOAuthCallback)

	org := protected.Group("")
	org.Use(middleware.RequireOrg(a.DB))
	org.GET("/endpoints", a.listEndpoints)
	org.POST("/endpoints", middleware.RequireOrgRole("owner", "admin"), a.createEndpoint)
	org.PATCH("/endpoints/:id", middleware.RequireOrgRole("owner", "admin"), a.updateEndpoint)
	org.DELETE("/endpoints/:id", middleware.RequireOrgRole("owner", "admin"), a.deleteEndpoint)
	org.POST("/endpoints/:id/test", a.testEndpoint)
	org.POST("/ws/tickets", a.createWSTicket)
	org.GET("/knowledge/sources", a.listKnowledgeSources)
	org.POST("/knowledge/sources", a.createKnowledgeSource)
	org.POST("/knowledge/sources/:id/reindex", a.reindexKnowledgeSource)
	org.DELETE("/knowledge/sources/:id", a.deleteKnowledgeSource)
	org.GET("/mcp/servers", a.listMCPServers)
	org.POST("/mcp/servers", middleware.RequireOrgRole("owner", "admin"), a.createMCPServer)
	org.PATCH("/mcp/servers/:id", middleware.RequireOrgRole("owner", "admin"), a.updateMCPServer)
	org.DELETE("/mcp/servers/:id", middleware.RequireOrgRole("owner", "admin"), a.deleteMCPServer)
	org.POST("/mcp/servers/:id/test", a.testMCPServer)
	org.GET("/mcp/servers/:id/tools", a.listMCPTools)
	org.POST("/mcp/servers/:id/tools/:tool/call", a.callMCPTool)
	org.GET("/mcp/servers/:id/oauth/start", a.mcpOAuthStart)
	org.GET("/conversations", a.listConversations)
	org.POST("/conversations", a.createConversation)
	org.GET("/conversations/:id/messages", a.listConversationMessages)

	protected.GET("/ws/chat", a.chatWebSocket)
	protected.GET("/ws/transcription", a.transcriptionWebSocket)
	members := protected.Group("/organizations/:id")
	members.Use(middleware.RequireOrg(a.DB))
	members.GET("/members", a.listOrganizationMembers)
	members.POST("/members", middleware.RequireOrgRole("owner", "admin"), a.addOrganizationMember)
	members.PATCH("/members/:userId", middleware.RequireOrgRole("owner", "admin"), a.updateOrganizationMember)
	members.DELETE("/members/:userId", middleware.RequireOrgRole("owner", "admin"), a.removeOrganizationMember)
	return router
}

func (a *App) registerAuthRoutes(router *gin.Engine) {
	group := router.Group("/api/v1/auth")
	group.POST("/register", a.register)
	group.POST("/login", a.login)
	group.GET("/oidc/start", a.oidcStart)
	group.GET("/oidc/callback", a.oidcCallback)
}

func (a *App) issueSession(c *gin.Context, user models.User) error {
	token, err := a.Tokens.Issue(user.ID, user.Email, user.PlatformAdmin)
	if err != nil {
		return err
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("justai_session", token, 12*60*60, "/", "", false, true)
	organizations, err := a.organizationsFor(c, user.ID)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"user": user, "organizations": organizations})
	return nil
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	organizations, err := a.organizationsFor(c, user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user, "organizations": organizations})
}

func (a *App) listOrganizations(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	organizations, err := a.organizationsFor(c, principal.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"organizations": organizations})
}

func (a *App) logout(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("justai_session", "", -1, "/", "", false, true)
	c.Status(http.StatusNoContent)
}

func writeError(c *gin.Context, status int, err error) {
	c.JSON(status, gin.H{"error": err.Error()})
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
