package server

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
)

type organizationMemberRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

func (a *App) listOrganizationMembers(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	rows, err := a.DB.QueryContext(c, `SELECT u.id, u.email, u.display_name, om.role, om.created_at FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id = $1 ORDER BY CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.display_name`, organizationID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()
	result := []gin.H{}
	for rows.Next() {
		var id uuid.UUID
		var email, displayName, role string
		var createdAt any
		if err := rows.Scan(&id, &email, &displayName, &role, &createdAt); err != nil {
			writeError(c, http.StatusInternalServerError, err)
			return
		}
		result = append(result, gin.H{"id": id, "email": email, "displayName": displayName, "role": role, "createdAt": createdAt})
	}
	c.JSON(http.StatusOK, gin.H{"members": result})
}

func (a *App) addOrganizationMember(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	var request organizationMemberRequest
	if !decodeJSON(c, &request) {
		return
	}
	request.Email = strings.ToLower(strings.TrimSpace(request.Email))
	if request.Email == "" || !strings.Contains(request.Email, "@") {
		writeError(c, http.StatusBadRequest, fmt.Errorf("a valid member email is required"))
		return
	}
	if request.Role == "" {
		request.Role = "member"
	}
	if request.Role != "admin" && request.Role != "member" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("role must be admin or member"))
		return
	}
	var userID uuid.UUID
	if err := a.DB.QueryRowContext(c, `SELECT id FROM users WHERE email = $1`, request.Email).Scan(&userID); err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("the user must register before being added to an organization"))
		return
	}
	if _, err := a.DB.ExecContext(c, `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`, organizationID, userID, request.Role); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": userID, "email": request.Email, "role": request.Role})
}

func (a *App) updateOrganizationMember(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	userID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid user id"))
		return
	}
	var request organizationMemberRequest
	if !decodeJSON(c, &request) {
		return
	}
	if request.Role != "owner" && request.Role != "admin" && request.Role != "member" {
		writeError(c, http.StatusBadRequest, fmt.Errorf("role must be owner, admin, or member"))
		return
	}
	if _, err := a.DB.ExecContext(c, `UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2`, organizationID, userID, request.Role); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": userID, "role": request.Role})
}

func (a *App) removeOrganizationMember(c *gin.Context) {
	organizationID, err := a.organizationRouteID(c)
	if err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	userID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid user id"))
		return
	}
	if _, err := a.DB.ExecContext(c, `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND role <> 'owner'`, organizationID, userID); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) organizationRouteID(c *gin.Context) (uuid.UUID, error) {
	organizationID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid organization id")
	}
	current, ok := middleware.GetOrganizationID(c)
	if !ok || current != organizationID {
		return uuid.Nil, fmt.Errorf("organization is outside the current session")
	}
	return organizationID, nil
}
