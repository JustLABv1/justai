package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/middleware"
	"justai-backend/models"
	"justai-backend/provider"
)

type endpointPreflightRequest struct {
	EndpointID string `json:"endpointId"`
	endpointRequest
}

type endpointPreflightCheck struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

func (a *App) preflightEndpoint(c *gin.Context) {
	var input endpointPreflightRequest
	if !decodeJSON(c, &input) {
		return
	}
	input.Credential = strings.TrimSpace(input.Credential)

	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	if input.EndpointID != "" {
		id, err := uuid.Parse(input.EndpointID)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid endpointId"))
			return
		}
		current, err := a.getEndpoint(c, id)
		if err != nil {
			writeError(c, http.StatusNotFound, fmt.Errorf("endpoint not found"))
			return
		}
		if err := a.canManageEndpoint(c, current, principal, organizationID, middleware.GetOrganizationRole(c)); err != nil {
			writeError(c, http.StatusForbidden, err)
			return
		}
		hydratePreflightFromEndpoint(&input.endpointRequest, current)
		if input.Credential == "" {
			credential, err := a.endpointCredential(c, id)
			if err != nil {
				writeError(c, http.StatusInternalServerError, err)
				return
			}
			input.Credential = credential
		}
	} else {
		scopeType := strings.TrimSpace(input.ScopeType)
		if scopeType == "" {
			scopeType = "organization"
		}
		requestedScopeID, err := parseNullableUUID(input.ScopeID)
		if err != nil {
			writeError(c, http.StatusBadRequest, fmt.Errorf("invalid scopeId"))
			return
		}
		if _, err := a.authorizeEndpointScope(c, scopeType, principal, organizationID, requestedScopeID); err != nil {
			writeError(c, http.StatusForbidden, err)
			return
		}
	}

	if err := validateEndpointRequest(&input.endpointRequest); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	capabilities := input.Capabilities
	if capabilities == nil {
		if input.EndpointKind == "diarization" || input.ProviderType == "pyannote" {
			capabilities = map[string]bool{"diarization": true}
		} else {
			capabilities = map[string]bool{"chat": true}
		}
	}
	if input.EndpointKind == "" {
		input.EndpointKind = inferEndpointKind(input.ProviderType, capabilities)
	}
	if err := validateProviderCapabilities(input.ProviderType, capabilities); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := validateEndpointKind(input.EndpointKind, input.ProviderType, capabilities); err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}

	endpoint := provider.Endpoint{
		ProviderType:       input.ProviderType,
		BaseURL:            input.BaseURL,
		APIPath:            input.APIPath,
		APIVersion:         input.APIVersion,
		Credential:         input.Credential,
		ChatModel:          input.ChatModel,
		VisionModel:        input.VisionModel,
		ImageModel:         input.ImageModel,
		EmbeddingModel:     input.EmbeddingModel,
		TranscriptionModel: input.TranscriptionModel,
		DiarizationModel:   input.DiarizationModel,
		SpeechModel:        input.SpeechModel,
		Capabilities:       capabilities,
		TimeoutSeconds:     intValue(input.TimeoutSeconds, endpointTimeoutDefault(input.ProviderType)),
		MaxOutputTokens:    intValue(input.MaxOutputTokens, 2048),
		Temperature:        floatValue(input.Temperature, 0.2),
	}
	c.Header("Cache-Control", "no-store")

	probeContext, cancel := context.WithTimeout(c, 30*time.Second)
	defer cancel()
	models, err := provider.Probe(probeContext, endpoint)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"ok":           false,
			"endpointKind": input.EndpointKind,
			"providerType": input.ProviderType,
			"models":       []provider.ChatModel{},
			"checks": gin.H{
				"connection": endpointPreflightCheck{OK: false, Message: safePreflightMessage(err)},
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":              true,
		"endpointKind":    input.EndpointKind,
		"providerType":    input.ProviderType,
		"configuredModel": strings.TrimSpace(input.ChatModel),
		"models":          models,
		"checks": gin.H{
			"connection": endpointPreflightCheck{OK: true, Message: "Provider is reachable."},
			"models":     endpointPreflightCheck{OK: true, Message: modelCheckMessage(input.ProviderType, len(models))},
		},
	})
}

func (a *App) preflightPlatformEndpoint(c *gin.Context) {
	if !a.requirePlatformAdmin(c) {
		return
	}
	markPlatformCatalogRoute(c)
	a.preflightEndpoint(c)
}

func hydratePreflightFromEndpoint(request *endpointRequest, current models.Endpoint) {
	if request.EndpointKind == "" {
		request.EndpointKind = current.EndpointKind
	}
	if request.ProviderType == "" {
		request.ProviderType = current.ProviderType
	}
	if request.Name == "" {
		request.Name = current.Name
	}
	if request.BaseURL == "" {
		request.BaseURL = current.BaseURL
	}
	if request.APIPath == "" {
		request.APIPath = current.APIPath
	}
	if request.APIVersion == "" {
		request.APIVersion = current.APIVersion
	}
	if request.ChatModel == "" {
		request.ChatModel = current.ChatModel
	}
	if request.VisionModel == "" {
		request.VisionModel = current.VisionModel
	}
	if request.ImageModel == "" {
		request.ImageModel = current.ImageModel
	}
	if request.EmbeddingModel == "" {
		request.EmbeddingModel = current.EmbeddingModel
	}
	if request.TranscriptionModel == "" {
		request.TranscriptionModel = current.TranscriptionModel
	}
	if request.DiarizationModel == "" {
		request.DiarizationModel = current.DiarizationModel
	}
	if request.SpeechModel == "" {
		request.SpeechModel = current.SpeechModel
	}
	if request.Capabilities == nil {
		request.Capabilities = capabilitiesMap(current.Capabilities)
	}
	if request.TimeoutSeconds == 0 {
		request.TimeoutSeconds = current.TimeoutSeconds
	}
	if request.MaxOutputTokens == 0 {
		request.MaxOutputTokens = current.MaxOutputTokens
	}
	if request.Temperature == 0 {
		request.Temperature = current.Temperature
	}
}

func (a *App) endpointCredential(ctx context.Context, id uuid.UUID) (string, error) {
	var encrypted []byte
	if err := a.DB.QueryRowContext(ctx, `SELECT credential_ciphertext FROM endpoint_settings WHERE id = $1`, id).Scan(&encrypted); err != nil {
		return "", err
	}
	if len(encrypted) == 0 {
		return "", nil
	}
	credential, err := a.Secrets.Decrypt(encrypted)
	if err != nil {
		return "", fmt.Errorf("could not decrypt endpoint credential")
	}
	return credential, nil
}

func safePreflightMessage(err error) string {
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return "The provider could not be reached."
	}
	return message
}

func modelCheckMessage(providerType string, count int) string {
	if providerType == "pyannote" {
		return "Diarization service is healthy."
	}
	if count == 0 {
		return "Provider is reachable; enter a model ID manually if no catalog is available."
	}
	suffix := "s"
	if count == 1 {
		suffix = ""
	}
	return fmt.Sprintf("Found %d available model%s.", count, suffix)
}
