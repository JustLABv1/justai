package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"justai-backend/mcp"
	"justai-backend/middleware"
)

const mcpAppHTMLMIMEType = "text/html;profile=mcp-app"

type mcpAppBridgeRequest struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// mcpAppsBridge is the authenticated data plane used by assistant-ui's
// McpAppsRemoteHost. Every operation carries a server id so the bridge can
// re-check tenant access instead of trusting widget-originated resource URLs.
func (a *App) mcpAppsBridge(c *gin.Context) {
	var request mcpAppBridgeRequest
	if !decodeJSON(c, &request) {
		return
	}
	method := strings.TrimSpace(request.Method)
	serverID, err := mcpAppServerID(request.Params)
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	if err := a.authorizeMCPServer(c, serverID.String()); err != nil {
		writeError(c, http.StatusForbidden, err)
		return
	}
	server, err := a.loadMCPServer(c, serverID.String())
	if err != nil {
		writeError(c, http.StatusNotFound, err)
		return
	}

	switch method {
	case "mcp-apps/read-resource":
		uri, err := mcpAppStringParam(request.Params, "uri")
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		if !strings.HasPrefix(uri, "ui://") {
			writeError(c, http.StatusBadRequest, fmt.Errorf("MCP App resource URI must use ui://"))
			return
		}
		result, err := server.ReadResource(c, uri)
		if err != nil {
			writeError(c, http.StatusBadGateway, err)
			return
		}
		resource, err := mcpAppResource(result, uri)
		if err != nil {
			writeError(c, http.StatusBadGateway, err)
			return
		}
		c.JSON(http.StatusOK, resource)
	case "resources/read":
		uri, err := mcpAppStringParam(request.Params, "uri")
		if err != nil {
			writeError(c, http.StatusBadRequest, err)
			return
		}
		result, err := server.ReadResource(c, uri)
		if err != nil {
			writeError(c, http.StatusBadGateway, err)
			return
		}
		c.Data(http.StatusOK, "application/json; charset=utf-8", result)
	case "resources/list":
		result, err := server.ListResources(c)
		if err != nil {
			writeError(c, http.StatusBadGateway, err)
			return
		}
		c.Data(http.StatusOK, "application/json; charset=utf-8", result)
	case "tools/call":
		a.mcpAppCallTool(c, serverID, server, request.Params)
	default:
		writeError(c, http.StatusBadRequest, fmt.Errorf("unsupported MCP App method"))
	}
}

func mcpAppServerID(params map[string]any) (uuid.UUID, error) {
	value, ok := params["serverId"].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return uuid.Nil, fmt.Errorf("serverId is required")
	}
	id, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid serverId")
	}
	return id, nil
}

func mcpAppStringParam(params map[string]any, key string) (string, error) {
	value, ok := params[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return strings.TrimSpace(value), nil
}

func (a *App) mcpAppCallTool(c *gin.Context, serverID uuid.UUID, server mcp.Server, params map[string]any) {
	name, err := mcpAppStringParam(params, "name")
	if err != nil {
		writeError(c, http.StatusBadRequest, err)
		return
	}
	arguments := map[string]any{}
	if rawArguments, exists := params["arguments"]; exists && rawArguments != nil {
		var ok bool
		arguments, ok = rawArguments.(map[string]any)
		if !ok {
			writeError(c, http.StatusBadRequest, fmt.Errorf("arguments must be an object"))
			return
		}
	}
	if !mcpToolAllowed(server.Allowed, name) {
		writeError(c, http.StatusForbidden, fmt.Errorf("MCP tool is not allowlisted"))
		return
	}

	tools, cached, cacheErr := a.cachedMCPTools(c, serverID)
	if cacheErr != nil {
		writeError(c, http.StatusInternalServerError, cacheErr)
		return
	}
	if !cached {
		mcp.Invalidate(server.ID)
		tools, err = server.ListTools(c)
		if err != nil {
			writeError(c, http.StatusBadGateway, err)
			return
		}
		if cacheErr := a.cacheMCPTools(c, serverID, tools); cacheErr != nil {
			writeError(c, http.StatusInternalServerError, cacheErr)
			return
		}
	}
	var tool mcp.Tool
	found := false
	for _, candidate := range tools {
		if candidate.Name == name {
			tool = candidate
			found = true
			break
		}
	}
	if !found {
		writeError(c, http.StatusNotFound, fmt.Errorf("MCP tool is not available"))
		return
	}
	if mcpToolRequiresApproval(server, tool) {
		// Widgets do not have access to the conversation approval controller.
		// Refuse the call rather than turning a widget-originated request into an
		// authorization bypass. The normal assistant tool path can still ask the
		// user for approval and resume the run.
		writeError(c, http.StatusForbidden, fmt.Errorf("MCP App tool calls require assistant approval"))
		return
	}

	principal, _ := middleware.GetPrincipal(c)
	organizationID, _ := middleware.GetOrganizationID(c)
	a.auditVoiceTool(c, principal.UserID, organizationID, "mcp.app.auto_approved", serverID, map[string]any{
		"serverId":  serverID,
		"tool":      name,
		"arguments": arguments,
		"reason":    "trusted_read_only",
	})
	result, err := server.CallTool(c, name, arguments)
	if err != nil {
		a.auditVoiceTool(c, principal.UserID, organizationID, "mcp.app.completed", serverID, map[string]any{
			"serverId": serverID,
			"tool":     name,
			"success":  false,
			"error":    err.Error(),
		})
		writeError(c, http.StatusBadGateway, err)
		return
	}
	a.auditVoiceTool(c, principal.UserID, organizationID, "mcp.app.completed", serverID, map[string]any{
		"serverId": serverID,
		"tool":     name,
		"success":  true,
	})
	c.Data(http.StatusOK, "application/json; charset=utf-8", result)
}

func mcpToolRequiresApproval(server mcp.Server, tool mcp.Tool) bool {
	return !(server.TrustedReadOnly && tool.Annotations.ReadOnlyHintSet && tool.Annotations.ReadOnlyHint && tool.Annotations.DestructiveHintSet && !tool.Annotations.DestructiveHint)
}

func mcpAppResource(raw json.RawMessage, requestedURI string) (gin.H, error) {
	var payload struct {
		Contents []map[string]any `json:"contents"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("invalid MCP resource response: %w", err)
	}
	for _, content := range payload.Contents {
		uri, _ := content["uri"].(string)
		if strings.TrimSpace(uri) == "" {
			uri = requestedURI
		}
		if uri != requestedURI {
			continue
		}
		if !strings.HasPrefix(uri, "ui://") {
			continue
		}
		mimeType, _ := content["mimeType"].(string)
		if mimeType != "" && !strings.HasPrefix(strings.ToLower(mimeType), "text/html;profile=mcp-app") {
			continue
		}
		html, _ := content["text"].(string)
		if html == "" {
			if encoded, ok := content["blob"].(string); ok && encoded != "" {
				decoded, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					return nil, fmt.Errorf("invalid MCP App resource blob: %w", err)
				}
				html = string(decoded)
			}
		}
		if html == "" {
			return nil, fmt.Errorf("MCP App resource is empty")
		}
		if len(html) > 4*1024*1024 {
			return nil, fmt.Errorf("MCP App resource is too large")
		}
		resource := gin.H{
			"uri":      uri,
			"mimeType": mcpAppHTMLMIMEType,
			"html":     html,
		}
		if metadata, ok := content["_meta"].(map[string]any); ok {
			resource["meta"] = metadata
		} else if metadata, ok := content["meta"].(map[string]any); ok {
			resource["meta"] = metadata
		}
		return resource, nil
	}
	return nil, fmt.Errorf("MCP App resource was not returned for %s", requestedURI)
}
