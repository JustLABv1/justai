package middleware

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/auth"
)

const (
	PrincipalKey = "justai.principal"
	OrgIDKey     = "justai.organization"
	OrgRoleKey   = "justai.organization.role"
)

type Principal struct {
	UserID        uuid.UUID
	Email         string
	PlatformAdmin bool
}

func RequireAuth(tokens *auth.TokenManager, db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		value := ""
		if header := c.GetHeader("Authorization"); strings.HasPrefix(header, "Bearer ") {
			value = strings.TrimPrefix(header, "Bearer ")
		}
		if value == "" {
			if cookie, err := c.Cookie("justai_session"); err == nil {
				value = cookie
			}
		}
		claims, err := tokens.Parse(value)
		if err != nil {
			AbortError(c, http.StatusUnauthorized, "authentication_required", "authentication required")
			return
		}
		userID, err := uuid.Parse(claims.Subject)
		if err != nil {
			AbortError(c, http.StatusUnauthorized, "invalid_session", "invalid session subject")
			return
		}
		var exists, platformAdmin bool
		if err := db.QueryRowContext(c, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1), COALESCE((SELECT is_platform_admin FROM users WHERE id = $1), FALSE)`, userID).Scan(&exists, &platformAdmin); err != nil || !exists {
			AbortError(c, http.StatusUnauthorized, "user_not_found", "user no longer exists")
			return
		}
		// Resolve the current platform-admin flag from the database instead of
		// trusting a potentially stale JWT claim after an access change.
		c.Set(PrincipalKey, Principal{UserID: userID, Email: claims.Email, PlatformAdmin: platformAdmin})
		c.Next()
	}
}

func RequireOrg(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := GetPrincipal(c)
		if !ok {
			AbortError(c, http.StatusUnauthorized, "authentication_required", "authentication required")
			return
		}
		organizationID, role, err := ResolveOrganization(c, db, principal)
		if err != nil {
			AbortError(c, http.StatusForbidden, "organization_access_required", "organization access required")
			return
		}
		c.Set(OrgIDKey, organizationID)
		c.Set(OrgRoleKey, role)
		c.Next()
	}
}

func RequireOrgRole(roles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		role, exists := c.Get(OrgRoleKey)
		if !exists {
			AbortError(c, http.StatusForbidden, "organization_context_required", "organization context required")
			return
		}
		roleValue, _ := role.(string)
		for _, allowed := range roles {
			if roleValue == allowed {
				c.Next()
				return
			}
		}
		if principal, ok := GetPrincipal(c); ok && principal.PlatformAdmin {
			c.Next()
			return
		}
		AbortError(c, http.StatusForbidden, "insufficient_role", "insufficient organization role")
	}
}

func GetPrincipal(c *gin.Context) (Principal, bool) {
	value, exists := c.Get(PrincipalKey)
	if !exists {
		return Principal{}, false
	}
	principal, ok := value.(Principal)
	return principal, ok
}

func GetOrganizationID(c *gin.Context) (uuid.UUID, bool) {
	value, exists := c.Get(OrgIDKey)
	if !exists {
		return uuid.Nil, false
	}
	organizationID, ok := value.(uuid.UUID)
	return organizationID, ok
}

func GetOrganizationRole(c *gin.Context) string {
	value, _ := c.Get(OrgRoleKey)
	role, _ := value.(string)
	return role
}

func ResolveOrganization(c *gin.Context, db *sql.DB, principal Principal) (uuid.UUID, string, error) {
	requested := strings.TrimSpace(c.GetHeader("X-Organization-ID"))
	if requested != "" {
		organizationID, err := uuid.Parse(requested)
		if err != nil {
			return uuid.Nil, "", err
		}
		var role string
		if err := db.QueryRowContext(c, `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`, organizationID, principal.UserID).Scan(&role); err != nil {
			if principal.PlatformAdmin {
				return organizationID, "owner", nil
			}
			return uuid.Nil, "", err
		}
		return organizationID, role, nil
	}
	var organizationID uuid.UUID
	var role string
	err := db.QueryRowContext(c, `SELECT organization_id, role FROM organization_members WHERE user_id = $1 ORDER BY created_at LIMIT 1`, principal.UserID).Scan(&organizationID, &role)
	if err != nil && principal.PlatformAdmin {
		return uuid.Nil, "owner", nil
	}
	return organizationID, role, err
}
