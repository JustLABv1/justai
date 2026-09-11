package server

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

// accountSession is intentionally limited to device metadata. In particular,
// the session token, raw IP address, and JWT claims never leave the backend.
type accountSession struct {
	ID         uuid.UUID `json:"id"`
	IssuedAt   time.Time `json:"issuedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	UserAgent  string    `json:"userAgent"`
	Current    bool      `json:"current"`
}

type accountIdentity struct {
	Provider     string    `json:"provider"`
	ProviderSlug string    `json:"providerSlug,omitempty"`
	Issuer       string    `json:"issuer,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}

func (a *App) listAccountSessions(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	rows, err := a.DB.QueryContext(c, `SELECT id, issued_at, expires_at, last_seen_at, user_agent FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC, issued_at DESC`, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := make([]accountSession, 0)
	for rows.Next() {
		var item accountSession
		if err := rows.Scan(&item.ID, &item.IssuedAt, &item.ExpiresAt, &item.LastSeenAt, &item.UserAgent); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		item.Current = item.ID == principal.SessionID
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": result})
}

func (a *App) revokeAccountSession(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	sessionID, err := uuid.Parse(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid session id"))
		return
	}
	if sessionID == principal.SessionID {
		writeError(c, http.StatusBadRequest, fmt.Errorf("the current session must be ended with sign out"))
		return
	}
	result, err := a.DB.ExecContext(c, `UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, now()) WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, sessionID, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(c, http.StatusNotFound, fmt.Errorf("session not found or already signed out"))
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) revokeOtherAccountSessions(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var (
		result sql.Result
		err    error
	)
	if principal.SessionID == uuid.Nil {
		result, err = a.DB.ExecContext(c, `UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, now()) WHERE user_id=$1 AND revoked_at IS NULL`, principal.UserID)
	} else {
		result, err = a.DB.ExecContext(c, `UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, now()) WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, principal.UserID, principal.SessionID)
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	count, _ := result.RowsAffected()
	c.JSON(http.StatusOK, gin.H{"revoked": count})
}

func (a *App) listAccountIdentities(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	rows, err := a.DB.QueryContext(c, `SELECT oi.issuer, COALESCE(p.display_name, ''), COALESCE(p.slug, ''), oi.created_at FROM oidc_identities oi LEFT JOIN oidc_providers p ON p.issuer=oi.issuer WHERE oi.user_id=$1 ORDER BY oi.created_at`, principal.UserID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := make([]accountIdentity, 0)
	for rows.Next() {
		var item accountIdentity
		if err := rows.Scan(&item.Issuer, &item.Provider, &item.ProviderSlug, &item.CreatedAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		if item.Provider == "" {
			if parsed, parseErr := url.Parse(item.Issuer); parseErr == nil && parsed.Host != "" {
				item.Provider = parsed.Host
			} else {
				item.Provider = "Single sign-on"
			}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"identities": result})
}
