package server

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
)

type onboardingState struct {
	Installation bool   `json:"installation"`
	Step         string `json:"step"`
	Completed    bool   `json:"completed"`
}

func (a *App) readOnboarding(c *gin.Context) (onboardingState, error) {
	principal, _ := middleware.GetPrincipal(c)
	var state onboardingState
	var completed sql.NullTime
	if principal.PlatformAdmin {
		if err := a.DB.QueryRowContext(c, `SELECT step, completed_at FROM installation_setup WHERE id = TRUE`).Scan(&state.Step, &completed); err != nil {
			return state, err
		}
		if !completed.Valid {
			state.Installation = true
			return state, nil
		}
	}
	err := a.DB.QueryRowContext(c, `SELECT onboarding_step, onboarding_completed_at FROM users WHERE id = $1`, principal.UserID).Scan(&state.Step, &completed)
	state.Completed = completed.Valid
	return state, err
}

func (a *App) getOnboarding(c *gin.Context) {
	state, err := a.readOnboarding(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, state)
}

func validOnboardingStep(step string, installation bool) bool {
	switch step {
	case "welcome", "workspace", "ready":
		return true
	case "authentication", "endpoints":
		return installation
	default:
		return false
	}
}

func (a *App) updateOnboarding(c *gin.Context) {
	var request struct {
		Step     string `json:"step"`
		Complete bool   `json:"complete"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	state, err := a.readOnboarding(c)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	if !validOnboardingStep(request.Step, state.Installation) {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid onboarding step"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	tx, err := a.DB.BeginTx(c, nil)
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	defer tx.Rollback()
	if state.Installation {
		_, err = tx.ExecContext(c, `UPDATE installation_setup SET step = $1, completed_at = CASE WHEN $2 THEN COALESCE(completed_at, now()) ELSE completed_at END WHERE id = TRUE`, request.Step, request.Complete)
	}
	if err == nil && (!state.Installation || request.Complete) {
		_, err = tx.ExecContext(c, `UPDATE users SET onboarding_step = $2, onboarding_completed_at = CASE WHEN $3 THEN COALESCE(onboarding_completed_at, now()) ELSE onboarding_completed_at END WHERE id = $1`, principal.UserID, request.Step, request.Complete)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"saved": true})
}
