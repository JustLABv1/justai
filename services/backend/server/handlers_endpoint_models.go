package server

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/provider"
)

// discoverEndpointModels returns the provider's current model catalog without
// exposing the stored credential. The endpoint is still subject to the same
// organization/user visibility rules as chat and endpoint testing.
func (a *App) discoverEndpointModels(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpoint id"))
		return
	}
	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	metadata, err := a.getEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
		return
	}
	if err := a.canUseEndpoint(metadata, principal, organizationID); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	endpoint, err := a.providerEndpoint(c, id)
	if err != nil {
		writeError(c, http.StatusConflict, fmt.Errorf("endpoint is disabled or unavailable: %w", err))
		return
	}
	capability := strings.TrimSpace(c.Query("capability"))
	if capability == "" {
		capability = "chat"
	}
	configuredModel := ""
	switch capability {
	case "chat", "grammar":
		configuredModel = strings.TrimSpace(metadata.ChatModel)
	case "transcription":
		configuredModel = strings.TrimSpace(metadata.TranscriptionModel)
	case "diarization":
		configuredModel = strings.TrimSpace(metadata.DiarizationModel)
	default:
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported model capability %q", capability))
		return
	}
	// DiscoverChatModels is the provider-neutral catalog route used by all
	// current adapters. Override its fallback model with the capability the
	// caller is configuring so a transcription picker never silently receives
	// the endpoint's chat default.
	endpoint.ChatModel = configuredModel
	var models []provider.ChatModel
	if endpoint.ProviderType != "pyannote" {
		models, err = provider.DiscoverChatModels(c, endpoint)
	}
	if err != nil {
		writeError(c, http.StatusBadGateway, fmt.Errorf("model discovery failed: %w", err))
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"models":          models,
		"configuredModel": configuredModel,
		"providerType":    metadata.ProviderType,
		"capability":      capability,
	})
}

func (a *App) discoverPlatformEndpointModels(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	a.discoverEndpointModels(c)
}
