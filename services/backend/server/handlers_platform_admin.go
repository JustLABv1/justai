package server

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"justai-backend/middleware"
)

const platformCatalogRouteKey = "justai.platform_catalog_route"

func markPlatformCatalogRoute(c *gin.Context) {
	c.Set(platformCatalogRouteKey, true)
}

func isPlatformCatalogRoute(c *gin.Context) bool {
	value, exists := c.Get(platformCatalogRouteKey)
	marked, ok := value.(bool)
	return exists && ok && marked
}

type platformSettingsRequest struct {
	LoginEnabled         *bool   `json:"loginEnabled"`
	LocalAuthEnabled     *bool   `json:"localAuthEnabled"`
	SignupEnabled        *bool   `json:"signupEnabled"`
	AIEnabled            *bool   `json:"aiEnabled"`
	VoiceEnabled         *bool   `json:"voiceEnabled"`
	TranscriptionEnabled *bool   `json:"transcriptionEnabled"`
	MCPEnabled           *bool   `json:"mcpEnabled"`
	KnowledgeEnabled     *bool   `json:"knowledgeEnabled"`
	AttachmentsEnabled   *bool   `json:"attachmentsEnabled"`
	MaintenanceMessage   *string `json:"maintenanceMessage"`
}

type platformHealthSnapshot struct {
	Database  platformDatabaseHealth `json:"database"`
	Workers   platformWorkerHealth   `json:"workers"`
	Providers platformProviderHealth `json:"providers"`
	MCP       platformMCPHealth      `json:"mcp"`
	CheckedAt time.Time              `json:"checkedAt"`
}

type platformDatabaseHealth struct {
	OK bool `json:"ok"`
}

type platformWorkerHealth struct {
	RAG           bool `json:"rag"`
	Transcription bool `json:"transcription"`
}

type platformProviderHealth struct {
	OK             bool `json:"ok"`
	Total          int  `json:"total"`
	Enabled        int  `json:"enabled"`
	RecentFailures int  `json:"recentFailures"`
}

type platformMCPHealth struct {
	OK       bool `json:"ok"`
	Total    int  `json:"total"`
	Enabled  int  `json:"enabled"`
	Failures int  `json:"failures"`
}

type platformAttentionItem struct {
	ID          string `json:"id"`
	Severity    string `json:"severity"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Tab         string `json:"tab"`
	Metric      any    `json:"metric,omitempty"`
}

type platformActivityItem struct {
	ID           int64     `json:"id"`
	Action       string    `json:"action"`
	ResourceType string    `json:"resourceType"`
	CreatedAt    time.Time `json:"createdAt"`
}

func (a *App) platformSettingsJSON(c *gin.Context) (platformSettings, bool) {
	if !a.requirePlatformAdmin(c) {
		return platformSettings{}, false
	}
	settings, err := a.readPlatformSettings(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return platformSettings{}, false
	}
	return settings, true
}

func (a *App) getPlatformSettings(c *gin.Context) {
	settings, ok := a.platformSettingsJSON(c)
	if ok {
		c.JSON(http.StatusOK, settings)
	}
}

func (a *App) putPlatformSettings(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	var request platformSettingsRequest
	if !decodeJSON(c, &request) {
		return
	}
	current, err := a.readPlatformSettings(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if request.LoginEnabled != nil {
		current.LoginEnabled = *request.LoginEnabled
	}
	if request.LocalAuthEnabled != nil {
		current.LocalAuthEnabled = *request.LocalAuthEnabled
	}
	if request.SignupEnabled != nil {
		current.SignupEnabled = *request.SignupEnabled
	}
	if request.AIEnabled != nil {
		current.AIEnabled = *request.AIEnabled
	}
	if request.VoiceEnabled != nil {
		current.VoiceEnabled = *request.VoiceEnabled
	}
	if request.TranscriptionEnabled != nil {
		current.TranscriptionEnabled = *request.TranscriptionEnabled
	}
	if request.MCPEnabled != nil {
		current.MCPEnabled = *request.MCPEnabled
	}
	if request.KnowledgeEnabled != nil {
		current.KnowledgeEnabled = *request.KnowledgeEnabled
	}
	if request.AttachmentsEnabled != nil {
		current.AttachmentsEnabled = *request.AttachmentsEnabled
	}
	if request.MaintenanceMessage != nil {
		current.MaintenanceMessage = strings.TrimSpace(*request.MaintenanceMessage)
	}
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `UPDATE platform_settings SET login_enabled = $1, local_auth_enabled = $2, signup_enabled = $3, ai_enabled = $4, voice_enabled = $5, transcription_enabled = $6, mcp_enabled = $7, knowledge_enabled = $8, attachments_enabled = $9, maintenance_message = $10, updated_by = $11, updated_at = now() WHERE id = TRUE`, current.LoginEnabled, current.LocalAuthEnabled, current.SignupEnabled, current.AIEnabled, current.VoiceEnabled, current.TranscriptionEnabled, current.MCPEnabled, current.KnowledgeEnabled, current.AttachmentsEnabled, current.MaintenanceMessage, principal.UserID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.settings.updated", "platform_settings", nil, gin.H{"maintenanceMessageChanged": request.MaintenanceMessage != nil})
	c.JSON(http.StatusOK, current)
}

func (a *App) getPlatformOverview(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	counts, err := a.readPlatformCounts(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	settings, err := a.readPlatformSettings(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	var databaseReady bool
	databaseReady = a.DB.PingContext(c) == nil
	c.JSON(http.StatusOK, gin.H{"counts": counts, "settings": settings, "readiness": gin.H{"database": databaseReady, "ragWorker": a.RAG != nil, "transcriptionWorker": a.Live != nil}})
}

func (a *App) readPlatformCounts(c *gin.Context) (map[string]int, error) {
	counts := map[string]int{}
	queries := map[string]string{
		"users":          `SELECT COUNT(*) FROM users`,
		"workspaces":     `SELECT COUNT(*) FROM organizations`,
		"endpoints":      `SELECT COUNT(*) FROM endpoint_settings`,
		"mcpServers":     `SELECT COUNT(*) FROM mcp_servers`,
		"conversations":  `SELECT COUNT(*) FROM conversations`,
		"transcriptions": `SELECT COUNT(*) FROM transcription_sessions`,
		"recentErrors":   `SELECT COUNT(*) FROM api_request_logs WHERE status_code >= 400 AND created_at >= now() - interval '24 hours'`,
	}
	for name, query := range queries {
		var count int
		if err := a.DB.QueryRowContext(c, query).Scan(&count); err != nil {
			return nil, err
		}
		counts[name] = count
	}
	return counts, nil
}

func (a *App) getPlatformDashboard(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	counts, err := a.readPlatformCounts(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	settings, err := a.readPlatformSettings(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	health, err := a.readPlatformHealth(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	analytics, err := a.readAnalytics(c, nil)
	if err != nil {
		writeError(c, analyticsErrorStatus(err), err)
		return
	}
	activity, err := a.readRecentPlatformActivity(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"generatedAt":    time.Now().UTC(),
		"counts":         counts,
		"settings":       settings,
		"health":         health,
		"usage":          analytics,
		"attention":      platformAttentionItems(counts, settings, health),
		"recentActivity": activity,
	})
}

func pageValues(c *gin.Context) (int, int, int) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "25"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 25
	}
	return page, pageSize, (page - 1) * pageSize
}

func (a *App) listPlatformUsers(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	page, pageSize, offset := pageValues(c)
	query := strings.TrimSpace(c.Query("query"))
	status := strings.TrimSpace(c.Query("status"))
	rows, err := a.DB.QueryContext(c, `SELECT id, email, display_name, is_platform_admin, COALESCE(status, 'active'), suspended_at, COALESCE(suspended_reason, ''), last_login_at, created_at, COUNT(*) OVER() FROM users WHERE ($1 = '' OR email ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%') AND ($2 = '' OR status = $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, query, status, pageSize, offset)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	users := []gin.H{}
	total := 0
	for rows.Next() {
		var id uuid.UUID
		var email, displayName, state, reason string
		var admin bool
		var suspendedAt, lastLogin, createdAt sql.NullTime
		if err := rows.Scan(&id, &email, &displayName, &admin, &state, &suspendedAt, &reason, &lastLogin, &createdAt, &total); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		users = append(users, gin.H{"id": id, "email": email, "displayName": displayName, "platformAdmin": admin, "status": state, "suspendedAt": nullTimeValue(suspendedAt), "suspendedReason": reason, "lastLoginAt": nullTimeValue(lastLogin), "createdAt": nullTimeValue(createdAt)})
	}
	c.JSON(http.StatusOK, gin.H{"users": users, "page": page, "pageSize": pageSize, "total": total})
}

func (a *App) getPlatformUser(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid user id"))
		return
	}
	var email, displayName, status, reason string
	var admin bool
	var suspendedAt, lastLogin, createdAt sql.NullTime
	if err := a.DB.QueryRowContext(c, `SELECT email, display_name, is_platform_admin, COALESCE(status, 'active'), suspended_at, COALESCE(suspended_reason, ''), last_login_at, created_at FROM users WHERE id = $1`, id).Scan(&email, &displayName, &admin, &status, &suspendedAt, &reason, &lastLogin, &createdAt); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("user not found"))
		return
	}
	orgRows, err := a.DB.QueryContext(c, `SELECT o.id, o.name, o.slug, om.role, COALESCE(o.status, 'active') FROM organizations o JOIN organization_members om ON om.organization_id = o.id WHERE om.user_id = $1 ORDER BY o.created_at`, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer orgRows.Close()
	orgs := []gin.H{}
	for orgRows.Next() {
		var orgID uuid.UUID
		var name, slug, role, orgStatus string
		if err := orgRows.Scan(&orgID, &name, &slug, &role, &orgStatus); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		orgs = append(orgs, gin.H{"id": orgID, "name": name, "slug": slug, "role": role, "status": orgStatus})
	}
	c.JSON(http.StatusOK, gin.H{"user": gin.H{"id": id, "email": email, "displayName": displayName, "platformAdmin": admin, "status": status, "suspendedAt": nullTimeValue(suspendedAt), "suspendedReason": reason, "lastLoginAt": nullTimeValue(lastLogin), "createdAt": nullTimeValue(createdAt)}, "organizations": orgs})
}

type platformUserPatch struct {
	Email           *string `json:"email"`
	DisplayName     *string `json:"displayName"`
	Status          *string `json:"status"`
	PlatformAdmin   *bool   `json:"platformAdmin"`
	SuspendedReason string  `json:"suspendedReason"`
}

func (a *App) updatePlatformUser(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid user id"))
		return
	}
	var request platformUserPatch
	if !decodeJSON(c, &request) {
		return
	}
	var currentAdmin bool
	if err := a.DB.QueryRowContext(c, `SELECT is_platform_admin FROM users WHERE id = $1`, id).Scan(&currentAdmin); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("user not found"))
		return
	}
	if request.PlatformAdmin != nil && currentAdmin && !*request.PlatformAdmin {
		var admins int
		if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM users WHERE is_platform_admin = TRUE`).Scan(&admins); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if admins <= 1 {
			writeError(c, http.StatusConflict, fmt.Errorf("the final platform administrator cannot be demoted"))
			return
		}
	}
	status := ""
	if request.Status != nil {
		status = strings.ToLower(strings.TrimSpace(*request.Status))
		if status != "active" && status != "suspended" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("status must be active or suspended"))
			return
		}
		if currentAdmin && status == "suspended" {
			var admins int
			if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM users WHERE is_platform_admin = TRUE AND COALESCE(status, 'active') = 'active'`).Scan(&admins); err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			if admins <= 1 {
				writeError(c, http.StatusConflict, fmt.Errorf("the final active platform administrator cannot be suspended"))
				return
			}
		}
	}
	platformAdminChanged := request.PlatformAdmin != nil && *request.PlatformAdmin != currentAdmin
	_, err = a.DB.ExecContext(c, `UPDATE users SET email = COALESCE(NULLIF($2, ''), email), display_name = COALESCE(NULLIF($3, ''), display_name), status = COALESCE(NULLIF($4, ''), status), suspended_at = CASE WHEN $4 = 'suspended' THEN COALESCE(suspended_at, now()) WHEN $4 = 'active' THEN NULL ELSE suspended_at END, suspended_reason = CASE WHEN $4 = 'suspended' THEN NULLIF($5, '') WHEN $4 = 'active' THEN NULL ELSE suspended_reason END, is_platform_admin = COALESCE($6, is_platform_admin), session_version = CASE WHEN $7 THEN COALESCE(session_version, 0) + 1 ELSE COALESCE(session_version, 0) END, updated_at = now() WHERE id = $1`, id, valueOrEmpty(request.Email), valueOrEmpty(request.DisplayName), status, strings.TrimSpace(request.SuspendedReason), request.PlatformAdmin, request.Status != nil || platformAdminChanged)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.user.updated", "user", &id, gin.H{"statusChanged": request.Status != nil, "adminChanged": request.PlatformAdmin != nil, "profileChanged": request.Email != nil || request.DisplayName != nil})
	a.getPlatformUser(c)
}

func (a *App) revokePlatformUserSessions(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid user id"))
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE users SET session_version = COALESCE(session_version, 0) + 1, updated_at = now() WHERE id = $1`, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("user not found"))
		return
	}
	a.writePlatformAudit(c, "platform.user.sessions_revoked", "user", &id, nil)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type platformUserDeleteRequest struct {
	Confirm               bool        `json:"confirm"`
	DeleteOrganizationIDs []uuid.UUID `json:"deleteOrganizationIds"`
}

func (a *App) deletePlatformUser(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid user id"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	if principal.UserID == id {
		// The audit event and the caller's session both depend on the actor
		// remaining present. Require another platform administrator to remove
		// this account instead of leaving an unaudited, half-revoked session.
		writeError(c, http.StatusConflict, fmt.Errorf("you cannot delete your own platform administrator account"))
		return
	}
	var request platformUserDeleteRequest
	if !decodeJSON(c, &request) {
		return
	}
	if !request.Confirm {
		writeError(c, http.StatusBadRequest, fmt.Errorf("explicit confirmation is required"))
		return
	}
	var admin bool
	if err := a.DB.QueryRowContext(c, `SELECT is_platform_admin FROM users WHERE id = $1`, id).Scan(&admin); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("user not found"))
		return
	}
	if admin {
		var activeAdmins int
		if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM users WHERE is_platform_admin = TRUE`).Scan(&activeAdmins); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if activeAdmins <= 1 {
			writeError(c, http.StatusConflict, fmt.Errorf("the final platform administrator cannot be removed"))
			return
		}
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	rows, err := transaction.QueryContext(c, `SELECT organization_id FROM organization_members WHERE user_id = $1 AND role = 'owner'`, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	owned := []uuid.UUID{}
	for rows.Next() {
		var orgID uuid.UUID
		if err := rows.Scan(&orgID); err != nil {
			rows.Close()
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		owned = append(owned, orgID)
	}
	rows.Close()
	requested := map[uuid.UUID]bool{}
	for _, orgID := range request.DeleteOrganizationIDs {
		requested[orgID] = true
	}
	for _, orgID := range owned {
		if !requested[orgID] {
			writeError(c, http.StatusConflict, fmt.Errorf("transfer or explicitly delete every workspace owned by this user"))
			return
		}
		if _, err := transaction.ExecContext(c, `DELETE FROM organizations WHERE id = $1`, orgID); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if _, err := transaction.ExecContext(c, `DELETE FROM users WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.user.deleted", "user", &id, gin.H{"deletedWorkspaces": len(owned)})
	c.Status(http.StatusNoContent)
}

func (a *App) listPlatformOrganizations(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	page, pageSize, offset := pageValues(c)
	query := strings.TrimSpace(c.Query("query"))
	status := strings.TrimSpace(c.Query("status"))
	rows, err := a.DB.QueryContext(c, `SELECT o.id, o.name, o.slug, COALESCE(o.status, 'active'), o.created_at, COUNT(om.user_id), COUNT(*) OVER() FROM organizations o LEFT JOIN organization_members om ON om.organization_id = o.id WHERE ($1 = '' OR o.name ILIKE '%' || $1 || '%' OR o.slug ILIKE '%' || $1 || '%') AND ($2 = '' OR o.status = $2) GROUP BY o.id ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`, query, status, pageSize, offset)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	orgs := []gin.H{}
	total := 0
	for rows.Next() {
		var id uuid.UUID
		var name, slug, state string
		var createdAt time.Time
		var members int
		if err := rows.Scan(&id, &name, &slug, &state, &createdAt, &members, &total); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		orgs = append(orgs, gin.H{"id": id, "name": name, "slug": slug, "status": state, "members": members, "createdAt": createdAt})
	}
	c.JSON(http.StatusOK, gin.H{"organizations": orgs, "page": page, "pageSize": pageSize, "total": total})
}

func (a *App) getPlatformOrganization(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organization id"))
		return
	}
	var name, slug, status string
	var createdAt time.Time
	if err := a.DB.QueryRowContext(c, `SELECT name, slug, COALESCE(status, 'active'), created_at FROM organizations WHERE id = $1`, id).Scan(&name, &slug, &status, &createdAt); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workspace not found"))
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT u.id, u.email, u.display_name, om.role, om.created_at FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id = $1 ORDER BY CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.display_name`, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	members := []gin.H{}
	for rows.Next() {
		var userID uuid.UUID
		var email, displayName, role string
		var joined time.Time
		if err := rows.Scan(&userID, &email, &displayName, &role, &joined); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		members = append(members, gin.H{"id": userID, "email": email, "displayName": displayName, "role": role, "createdAt": joined})
	}
	resources := gin.H{}
	resourceQueries := map[string]string{
		"conversations":    `SELECT COUNT(*) FROM conversations WHERE organization_id = $1`,
		"endpoints":        `SELECT COUNT(*) FROM endpoint_settings WHERE scope_type = 'organization' AND scope_id = $1`,
		"mcpServers":       `SELECT COUNT(*) FROM mcp_servers WHERE scope_type = 'organization' AND scope_id = $1`,
		"knowledgeSources": `SELECT COUNT(*) FROM knowledge_sources WHERE scope_type = 'organization' AND scope_id = $1`,
		"transcriptions":   `SELECT COUNT(*) FROM transcription_sessions WHERE organization_id = $1`,
	}
	for resource, query := range resourceQueries {
		var count int
		if err := a.DB.QueryRowContext(c, query, id).Scan(&count); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		resources[resource] = count
	}
	c.JSON(http.StatusOK, gin.H{"organization": gin.H{"id": id, "name": name, "slug": slug, "status": status, "createdAt": createdAt}, "members": members, "resources": resources})
}

type platformOrganizationPatch struct {
	Name   *string `json:"name"`
	Status *string `json:"status"`
}

func (a *App) updatePlatformOrganization(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organization id"))
		return
	}
	var request platformOrganizationPatch
	if !decodeJSON(c, &request) {
		return
	}
	status := ""
	if request.Status != nil {
		status = strings.ToLower(strings.TrimSpace(*request.Status))
		if status != "active" && status != "archived" && status != "suspended" {
			writeError(c, http.StatusBadRequest, fmt.Errorf("status must be active, archived, or suspended"))
			return
		}
	}
	_, err = a.DB.ExecContext(c, `UPDATE organizations SET name = COALESCE(NULLIF($2, ''), name), status = COALESCE(NULLIF($3, ''), status) WHERE id = $1`, id, valueOrEmpty(request.Name), status)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.organization.updated", "organization", &id, gin.H{"statusChanged": request.Status != nil, "nameChanged": request.Name != nil})
	a.getPlatformOrganization(c)
}

type transferOwnershipRequest struct {
	NewOwnerID uuid.UUID `json:"newOwnerId"`
}

func (a *App) transferPlatformOrganizationOwnership(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	organizationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organization id"))
		return
	}
	var request transferOwnershipRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.NewOwnerID == uuid.Nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("newOwnerId is required"))
		return
	}
	transaction, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer transaction.Rollback()
	var currentOwner uuid.UUID
	if err := transaction.QueryRowContext(c, `SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = 'owner' LIMIT 1`, organizationID).Scan(&currentOwner); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workspace owner not found"))
		return
	}
	var newOwnerRole, newOwnerStatus string
	if err := transaction.QueryRowContext(c, `SELECT om.role, COALESCE(u.status, 'active') FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id = $1 AND om.user_id = $2`, organizationID, request.NewOwnerID).Scan(&newOwnerRole, &newOwnerStatus); err != nil {
		if err == sql.ErrNoRows {
			writeError(c, http.StatusBadRequest, fmt.Errorf("new owner must already be an organization admin"))
		} else {
			writeError(c, http.StatusInternalServerError, err)
		}
		return
	}
	if newOwnerRole != "owner" && newOwnerRole != "admin" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("new owner must already be an organization admin"))
		return
	}
	if newOwnerStatus != "active" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("new owner is not active"))
		return
	}
	if _, err := transaction.ExecContext(c, `UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2`, organizationID, request.NewOwnerID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if currentOwner != request.NewOwnerID {
		if _, err := transaction.ExecContext(c, `UPDATE organization_members SET role = 'admin' WHERE organization_id = $1 AND user_id = $2 AND role = 'owner'`, organizationID, currentOwner); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
	}
	if err := transaction.Commit(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.organization.ownership_transferred", "organization", &organizationID, gin.H{"newOwnerId": request.NewOwnerID})
	c.JSON(http.StatusOK, gin.H{"ok": true, "ownerId": request.NewOwnerID})
}

type platformOrganizationDeleteRequest struct {
	ConfirmName string `json:"confirmName"`
}

func (a *App) deletePlatformOrganization(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organization id"))
		return
	}
	var name string
	if err := a.DB.QueryRowContext(c, `SELECT name FROM organizations WHERE id = $1`, id).Scan(&name); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("workspace not found"))
		return
	}
	var request platformOrganizationDeleteRequest
	if !decodeJSON(c, &request) {
		return
	}
	if strings.TrimSpace(request.ConfirmName) != name {
		writeError(c, http.StatusBadRequest, fmt.Errorf("type the workspace name to confirm deletion"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM organizations WHERE id = $1`, id); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	a.writePlatformAudit(c, "platform.organization.deleted", "organization", &id, nil)
	c.Status(http.StatusNoContent)
}

func (a *App) listPlatformEndpoints(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	scope := strings.ToLower(strings.TrimSpace(c.Query("scope")))
	if scope != "" && scope != "global" && scope != "organization" && scope != "user" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("scope must be global, organization, or user"))
		return
	}
	organizationID := strings.TrimSpace(c.Query("organizationId"))
	if organizationID != "" {
		if _, err := uuid.Parse(organizationID); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organizationId"))
			return
		}
	}
	rows, err := a.DB.QueryContext(c, `SELECT id FROM endpoint_settings WHERE ($1 = '' OR scope_type = $1) AND (NULLIF($2, '') IS NULL OR (scope_type = 'organization' AND scope_id = NULLIF($2, '')::uuid)) ORDER BY created_at DESC`, scope, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	endpoints := []any{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item, err := a.getEndpoint(c, id)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		endpoints = append(endpoints, item)
	}
	c.JSON(http.StatusOK, gin.H{"endpoints": endpoints})
}

func (a *App) createPlatformEndpoint(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	if raw := strings.TrimSpace(c.GetHeader("X-Organization-ID")); raw != "" {
		if organizationID, err := uuid.Parse(raw); err == nil {
			c.Set(middleware.OrgIDKey, organizationID)
			c.Set(middleware.OrgRoleKey, "owner")
		}
	}
	a.createEndpoint(c)
	if c.Writer.Status() < http.StatusBadRequest {
		a.writePlatformAudit(c, "platform.endpoint.created", "endpoint", nil, nil)
	}
}

func (a *App) updatePlatformEndpoint(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.updateEndpoint(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.endpoint.updated", "endpoint", &id, nil)
		}
	}
}

func (a *App) deletePlatformEndpoint(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	if id, err := uuid.Parse(c.Param("id")); err == nil {
		a.deleteEndpoint(c)
		if c.Writer.Status() < http.StatusBadRequest {
			a.writePlatformAudit(c, "platform.endpoint.deleted", "endpoint", &id, nil)
		}
		return
	}
	a.deleteEndpoint(c)
}

func (a *App) testPlatformEndpoint(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	a.testEndpoint(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.endpoint.tested", "endpoint", &id, nil)
		}
	}
}

func (a *App) listPlatformMCPServers(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	scope := strings.ToLower(strings.TrimSpace(c.Query("scope")))
	if scope != "" && scope != "global" && scope != "organization" && scope != "user" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("scope must be global, organization, or user"))
		return
	}
	organizationID := strings.TrimSpace(c.Query("organizationId"))
	if organizationID != "" {
		if _, err := uuid.Parse(organizationID); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organizationId"))
			return
		}
	}
	rows, err := a.DB.QueryContext(c, `SELECT id, scope_type, scope_id, name, endpoint_url, auth_type, encrypted_credential IS NOT NULL, enabled, allowed_tools, trusted_read_only, last_tested_at, COALESCE(last_error, ''), COALESCE(protocol_version, ''), (SELECT COUNT(*) FROM mcp_server_tools mst WHERE mst.server_id = mcp_servers.id), created_at, updated_at FROM mcp_servers WHERE ($1 = '' OR scope_type = $1) AND (NULLIF($2, '') IS NULL OR (scope_type = 'organization' AND scope_id = NULLIF($2, '')::uuid)) ORDER BY created_at DESC`, scope, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	servers := []any{}
	for rows.Next() {
		item, err := scanMCPServer(rows)
		if err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		servers = append(servers, item)
	}
	c.JSON(http.StatusOK, gin.H{"servers": servers})
}

func (a *App) createPlatformMCPServer(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.createMCPServer(c)
	if c.Writer.Status() < http.StatusBadRequest {
		a.writePlatformAudit(c, "platform.mcp.created", "mcp_server", nil, nil)
	}
}

func (a *App) updatePlatformMCPServer(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.updateMCPServer(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.mcp.updated", "mcp_server", &id, nil)
		}
	}
}

func (a *App) deletePlatformMCPServer(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	if id, err := uuid.Parse(c.Param("id")); err == nil {
		a.deleteMCPServer(c)
		if c.Writer.Status() < http.StatusBadRequest {
			a.writePlatformAudit(c, "platform.mcp.deleted", "mcp_server", &id, nil)
		}
		return
	}
	a.deleteMCPServer(c)
}

func (a *App) testPlatformMCPServer(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.testMCPServer(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.mcp.tested", "mcp_server", &id, nil)
		}
	}
}

func (a *App) discoverPlatformMCPTools(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.listMCPTools(c)
	if c.Writer.Status() < http.StatusBadRequest {
		if id, err := uuid.Parse(c.Param("id")); err == nil {
			a.writePlatformAudit(c, "platform.mcp.tools_discovered", "mcp_server", &id, nil)
		}
	}
}

func (a *App) listPlatformAudit(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	page, pageSize, offset := pageValues(c)
	args := []any{}
	filters := []string{"TRUE"}
	add := func(expression string, value any) {
		args = append(args, value)
		filters = append(filters, fmt.Sprintf(expression, len(args)))
	}
	if value := strings.TrimSpace(c.Query("search")); value != "" {
		args = append(args, value)
		position := len(args)
		filters = append(filters, fmt.Sprintf("(action ILIKE '%%' || $%d || '%%' OR resource_type ILIKE '%%' || $%d || '%%' OR details::text ILIKE '%%' || $%d || '%%')", position, position, position))
	}
	if value := strings.TrimSpace(c.Query("action")); value != "" {
		add("action = $%d", value)
	}
	if value := strings.TrimSpace(c.Query("resourceType")); value != "" {
		add("resource_type = $%d", value)
	}
	if value := strings.TrimSpace(c.Query("actorId")); value != "" {
		id, err := uuid.Parse(value)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid actorId"))
			return
		}
		add("user_id = $%d", id)
	}
	if value := strings.TrimSpace(c.Query("organizationId")); value != "" {
		id, err := uuid.Parse(value)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid organizationId"))
			return
		}
		add("organization_id = $%d", id)
	}
	if value := strings.TrimSpace(c.Query("from")); value != "" {
		from, err := parseAnalyticsTime(value, false)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid from date"))
			return
		}
		add("created_at >= $%d", from)
	}
	if value := strings.TrimSpace(c.Query("to")); value != "" {
		to, err := parseAnalyticsTime(value, true)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid to date"))
			return
		}
		add("created_at < $%d", to)
	}
	args = append(args, pageSize, offset)
	query := `SELECT id, user_id, organization_id, action, resource_type, resource_id, details, created_at, COUNT(*) OVER() FROM audit_events WHERE ` + strings.Join(filters, " AND ") + fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args))
	rows, err := a.DB.QueryContext(c, query, args...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	events := []gin.H{}
	total := 0
	for rows.Next() {
		var id int64
		var userID, orgID, resourceID uuid.NullUUID
		var action, resourceType string
		var details []byte
		var createdAt time.Time
		if err := rows.Scan(&id, &userID, &orgID, &action, &resourceType, &resourceID, &details, &createdAt, &total); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		events = append(events, gin.H{"id": id, "userId": nullableAdminUUID(userID), "organizationId": nullableAdminUUID(orgID), "action": action, "resourceType": resourceType, "resourceId": nullableAdminUUID(resourceID), "details": details, "createdAt": createdAt})
	}
	c.JSON(http.StatusOK, gin.H{"events": events, "page": page, "pageSize": pageSize, "total": total})
}

func (a *App) readPlatformHealth(c *gin.Context) (platformHealthSnapshot, error) {
	databaseOK := a.DB != nil && a.DB.PingContext(c) == nil
	var recentFailures, endpointTotal, endpointEnabled, mcpTotal, mcpEnabled, mcpFailures int
	if databaseOK {
		if err := a.DB.QueryRowContext(c, `SELECT COUNT(*) FROM api_request_logs WHERE status_code >= 500 AND created_at >= now() - interval '1 hour'`).Scan(&recentFailures); err != nil {
			return platformHealthSnapshot{}, err
		}
		if err := a.DB.QueryRowContext(c, `SELECT COUNT(*), COUNT(*) FILTER (WHERE enabled = TRUE) FROM endpoint_settings`).Scan(&endpointTotal, &endpointEnabled); err != nil {
			return platformHealthSnapshot{}, err
		}
		if err := a.DB.QueryRowContext(c, `SELECT COUNT(*), COUNT(*) FILTER (WHERE enabled = TRUE), COUNT(*) FILTER (WHERE last_error IS NOT NULL AND last_error <> '') FROM mcp_servers`).Scan(&mcpTotal, &mcpEnabled, &mcpFailures); err != nil {
			return platformHealthSnapshot{}, err
		}
	}
	return platformHealthSnapshot{
		Database:  platformDatabaseHealth{OK: databaseOK},
		Workers:   platformWorkerHealth{RAG: a.RAG != nil, Transcription: a.Live != nil},
		Providers: platformProviderHealth{OK: databaseOK && endpointEnabled > 0, Total: endpointTotal, Enabled: endpointEnabled, RecentFailures: recentFailures},
		MCP:       platformMCPHealth{OK: databaseOK && mcpFailures == 0, Total: mcpTotal, Enabled: mcpEnabled, Failures: mcpFailures},
		CheckedAt: time.Now().UTC(),
	}, nil
}

func (a *App) getPlatformHealth(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	health, err := a.readPlatformHealth(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, health)
}

func (a *App) readRecentPlatformActivity(c *gin.Context) ([]platformActivityItem, error) {
	rows, err := a.DB.QueryContext(c, `SELECT id, action, resource_type, created_at FROM audit_events ORDER BY created_at DESC LIMIT 6`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	activity := []platformActivityItem{}
	for rows.Next() {
		var item platformActivityItem
		if err := rows.Scan(&item.ID, &item.Action, &item.ResourceType, &item.CreatedAt); err != nil {
			return nil, err
		}
		activity = append(activity, item)
	}
	return activity, rows.Err()
}

func platformAttentionItems(counts map[string]int, settings platformSettings, health platformHealthSnapshot) []platformAttentionItem {
	items := []platformAttentionItem{}
	add := func(id, severity, title, description, tab string, metric any) {
		items = append(items, platformAttentionItem{ID: id, Severity: severity, Title: title, Description: description, Tab: tab, Metric: metric})
	}
	if !health.Database.OK {
		add("database-unavailable", "critical", "Database unavailable", "The platform cannot confirm database connectivity.", "health", nil)
	}
	if !health.Workers.RAG {
		add("rag-worker-offline", "warning", "RAG worker is offline", "Knowledge indexing and retrieval jobs may be delayed.", "health", nil)
	}
	if !health.Workers.Transcription {
		add("transcription-worker-offline", "warning", "Transcription worker is offline", "Live and video transcription processing may be unavailable.", "health", nil)
	}
	if health.Providers.Enabled == 0 {
		add("no-enabled-endpoints", "critical", "No enabled model endpoints", "New AI requests have no enabled provider available for routing.", "endpoints", counts["endpoints"])
	}
	if health.Providers.RecentFailures > 0 {
		add("provider-failures", "warning", "Provider failures detected", "One or more model requests failed in the last hour.", "health", health.Providers.RecentFailures)
	}
	if health.MCP.Failures > 0 {
		add("mcp-failures", "warning", "MCP failures detected", "One or more configured MCP servers reported a recent error.", "mcp", health.MCP.Failures)
	}
	if counts["recentErrors"] > 0 {
		add("recent-api-errors", "warning", "Recent API errors", "Requests returned errors during the last 24 hours.", "analytics", counts["recentErrors"])
	}
	if !settings.AIEnabled {
		add("ai-disabled", "info", "AI chat is disabled", "Model requests are currently blocked by platform controls.", "controls", nil)
	}
	if !settings.LoginEnabled {
		add("login-disabled", "info", "Login is disabled", "Existing sessions may continue, but new sign-ins are blocked.", "controls", nil)
	}
	return items
}

func (a *App) writePlatformAudit(c *gin.Context, action, resourceType string, resourceID *uuid.UUID, details any) {
	principal, ok := middleware.GetPrincipal(c)
	if !ok || a.DB == nil {
		return
	}
	var organizationID any
	if id, exists := middleware.GetOrganizationID(c); exists && id != uuid.Nil {
		organizationID = id
	}
	_, _ = a.DB.ExecContext(c, `INSERT INTO audit_events (user_id, organization_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5, $6)`, principal.UserID, organizationID, action, resourceType, resourceID, jsonRaw(details))
}

func nullTimeValue(value sql.NullTime) any {
	if value.Valid {
		return value.Time
	}
	return nil
}

func nullableAdminUUID(value uuid.NullUUID) any {
	if value.Valid {
		return value.UUID
	}
	return nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
