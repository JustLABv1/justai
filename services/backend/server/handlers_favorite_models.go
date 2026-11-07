package server

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"justai-backend/middleware"
)

const maxFavoriteModels = 200

// getFavoriteModels returns the models the user starred in the chat model picker.
func (a *App) getFavoriteModels(c *gin.Context) {
	principal, _ := middleware.GetPrincipal(c)
	var raw []byte
	if err := a.DB.QueryRowContext(c, `SELECT favorite_models FROM users WHERE id = $1`, principal.UserID).Scan(&raw); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	favorites := []string{}
	if err := json.Unmarshal(raw, &favorites); err != nil || favorites == nil {
		favorites = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"favorites": favorites})
}

// saveFavoriteModels replaces the user's starred models.
func (a *App) saveFavoriteModels(c *gin.Context) {
	var request struct {
		Favorites []string `json:"favorites"`
	}
	if !decodeJSON(c, &request) {
		return
	}
	favorites := make([]string, 0, len(request.Favorites))
	seen := map[string]bool{}
	for _, favorite := range request.Favorites {
		if favorite == "" || len(favorite) > 512 || seen[favorite] {
			continue
		}
		seen[favorite] = true
		favorites = append(favorites, favorite)
	}
	if len(favorites) > maxFavoriteModels {
		writeError(c, http.StatusBadRequest, publicError("invalid_request", "too many favorite models"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	if _, err := a.DB.ExecContext(c, `UPDATE users SET favorite_models = $2 WHERE id = $1`, principal.UserID, jsonRaw(favorites)); err != nil {
		writeError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"favorites": favorites})
}
