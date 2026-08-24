package server

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"justai-backend/mcp"
	"justai-backend/provider"
)

const maxAutomaticMCPTools = 8

func automaticMCPRouterDefinition() provider.ToolDefinition {
	return provider.ToolDefinition{
		Name:        "discover_mcp_tools",
		Description: "Search the user's explicitly enabled connected integrations for relevant capabilities. Call this when private/workspace data or an external action may be needed and no listed tool clearly matches. Matching tools become available in the next step; call one of them instead of stopping after discovery.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","description":"A concise capability search, including likely service and action terms."}},"required":["query"],"additionalProperties":false}`),
	}
}

func automaticMCPRouterDiscovery() voiceToolDiscovery {
	definition := automaticMCPRouterDefinition()
	return voiceToolDiscovery{
		Definitions: []provider.ToolDefinition{definition},
		Bindings: map[string]voiceToolBinding{
			definition.Name: {ToolName: definition.Name, Builtin: true, Definition: definition},
		},
	}
}

type automaticMCPToolCandidate struct {
	ServerID   uuid.UUID
	ServerName string
	IconURL    string
	Allowed    map[string]bool
	Tool       mcp.Tool
	Score      int
}

// discoverAutomaticMCPTools exposes only a small, relevant slice of the MCP
// catalog. Eligibility is an explicit server setting; selection is ephemeral
// and never mutates conversation context.
func (a *App) discoverAutomaticMCPTools(ctx context.Context, userID, organizationID uuid.UUID, query string, existing map[string]voiceToolBinding) voiceToolDiscovery {
	result := voiceToolDiscovery{Definitions: []provider.ToolDefinition{}, Bindings: map[string]voiceToolBinding{}}
	if !a.platformCapabilityEnabled(ctx, "mcp") {
		return result
	}
	rows, err := a.DB.QueryContext(ctx, `
		SELECT ms.id, ms.name,
		       CASE WHEN EXISTS (SELECT 1 FROM mcp_server_icons msi WHERE msi.server_id = ms.id)
		            THEN '/api/v1/mcp/servers/' || ms.id::text || '/icon'
		            ELSE COALESCE(ms.icon_url, '') END,
		       ms.allowed_tools, mst.name, COALESCE(mst.description, ''),
		       mst.input_schema, mst.annotations, COALESCE(mst.metadata, '{}'::jsonb)
		FROM mcp_servers ms
		JOIN mcp_server_tools mst ON mst.server_id = ms.id
		WHERE ms.enabled = TRUE AND ms.auto_discover = TRUE
		  AND (ms.scope_type = 'global'
		       OR (ms.scope_type = 'organization' AND ms.scope_id = $2)
		       OR (ms.scope_type = 'user' AND ms.scope_id = $1))
		ORDER BY ms.name, mst.name`, userID, organizationID)
	if err != nil {
		result.Errors = []string{"automatic MCP catalog could not be loaded: " + err.Error()}
		return result
	}
	defer rows.Close()

	candidates := make([]automaticMCPToolCandidate, 0)
	for rows.Next() {
		var candidate automaticMCPToolCandidate
		var allowed, inputSchema, annotations, metadata []byte
		if err := rows.Scan(&candidate.ServerID, &candidate.ServerName, &candidate.IconURL, &allowed, &candidate.Tool.Name, &candidate.Tool.Description, &inputSchema, &annotations, &metadata); err != nil {
			result.Errors = append(result.Errors, "automatic MCP catalog row could not be read: "+err.Error())
			continue
		}
		candidate.Allowed = parseMCPAllowedTools(allowed)
		if !mcpToolAllowed(candidate.Allowed, candidate.Tool.Name) || automaticMCPBindingExists(existing, candidate.ServerID, candidate.Tool.Name) {
			continue
		}
		candidate.Tool.InputSchema = json.RawMessage(inputSchema)
		if len(candidate.Tool.InputSchema) > 64*1024 {
			result.Errors = append(result.Errors, candidate.ServerName+" returned an oversized schema for "+candidate.Tool.Name)
			continue
		}
		_ = json.Unmarshal(annotations, &candidate.Tool.Annotations)
		if len(metadata) > 0 && string(metadata) != "null" {
			candidate.Tool.Meta = json.RawMessage(metadata)
		}
		candidate.Score = automaticMCPToolScore(query, candidate.ServerName, candidate.Tool)
		if candidate.Score > 0 {
			candidates = append(candidates, candidate)
		}
	}
	if err := rows.Err(); err != nil {
		result.Errors = append(result.Errors, "automatic MCP catalog could not be completed: "+err.Error())
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Score == candidates[j].Score {
			return candidates[i].Tool.Name < candidates[j].Tool.Name
		}
		return candidates[i].Score > candidates[j].Score
	})
	if len(candidates) > maxAutomaticMCPTools {
		candidates = candidates[:maxAutomaticMCPTools]
	}
	for _, candidate := range candidates {
		result.addAutomaticMCPBinding(candidate)
	}
	return result
}

func (a *App) discoverAutomaticMCPTool(ctx context.Context, userID, organizationID, serverID uuid.UUID, toolName string) (string, voiceToolBinding, bool) {
	if !a.platformCapabilityEnabled(ctx, "mcp") {
		return "", voiceToolBinding{}, false
	}
	var candidate automaticMCPToolCandidate
	var allowed, inputSchema, annotations, metadata []byte
	err := a.DB.QueryRowContext(ctx, `
		SELECT ms.id, ms.name,
		       CASE WHEN EXISTS (SELECT 1 FROM mcp_server_icons msi WHERE msi.server_id = ms.id)
		            THEN '/api/v1/mcp/servers/' || ms.id::text || '/icon'
		            ELSE COALESCE(ms.icon_url, '') END,
		       ms.allowed_tools, mst.name, COALESCE(mst.description, ''),
		       mst.input_schema, mst.annotations, COALESCE(mst.metadata, '{}'::jsonb)
		FROM mcp_servers ms
		JOIN mcp_server_tools mst ON mst.server_id = ms.id
		WHERE ms.id = $1 AND mst.name = $2
		  AND ms.enabled = TRUE AND ms.auto_discover = TRUE
		  AND (ms.scope_type = 'global'
		       OR (ms.scope_type = 'organization' AND ms.scope_id = $4)
		       OR (ms.scope_type = 'user' AND ms.scope_id = $3))
		LIMIT 1`, serverID, toolName, userID, organizationID).Scan(
		&candidate.ServerID, &candidate.ServerName, &candidate.IconURL, &allowed,
		&candidate.Tool.Name, &candidate.Tool.Description, &inputSchema, &annotations, &metadata,
	)
	if err != nil {
		return "", voiceToolBinding{}, false
	}
	candidate.Allowed = parseMCPAllowedTools(allowed)
	if !mcpToolAllowed(candidate.Allowed, candidate.Tool.Name) || len(inputSchema) > 64*1024 {
		return "", voiceToolBinding{}, false
	}
	candidate.Tool.InputSchema = json.RawMessage(inputSchema)
	_ = json.Unmarshal(annotations, &candidate.Tool.Annotations)
	if len(metadata) > 0 && string(metadata) != "null" {
		candidate.Tool.Meta = json.RawMessage(metadata)
	}
	discovery := voiceToolDiscovery{Definitions: []provider.ToolDefinition{}, Bindings: map[string]voiceToolBinding{}}
	discovery.addAutomaticMCPBinding(candidate)
	return findMCPBindingWithProviderName(discovery.Bindings, serverID, toolName)
}

func automaticMCPDiscoveryResult(discovery voiceToolDiscovery) json.RawMessage {
	tools := make([]map[string]any, 0, len(discovery.Definitions))
	for _, definition := range discovery.Definitions {
		binding := discovery.Bindings[definition.Name]
		tools = append(tools, map[string]any{
			"name":        definition.Name,
			"server":      binding.ServerName,
			"tool":        binding.ToolName,
			"description": definition.Description,
		})
	}
	result, _ := json.Marshal(map[string]any{
		"tools":       tools,
		"instruction": "Call the best matching tool now. If no tools matched, explain that no automatically available integration matched the request.",
	})
	return result
}

func (result *voiceToolDiscovery) addAutomaticMCPBinding(candidate automaticMCPToolCandidate) {
	name := voiceToolName(candidate.ServerID, candidate.Tool.Name, result.Bindings)
	parameters := candidate.Tool.InputSchema
	if len(parameters) == 0 || !json.Valid(parameters) {
		parameters = json.RawMessage(`{"type":"object","properties":{}}`)
	}
	description := strings.TrimSpace(candidate.Tool.Description)
	if len([]rune(description)) > 1200 {
		description = string([]rune(description)[:1200])
	}
	description = "Connected integration: " + candidate.ServerName + ". " + description
	definition := provider.ToolDefinition{Name: name, Description: description, Parameters: parameters}
	appMetadata := candidate.Tool.AppMetadata()
	result.Definitions = append(result.Definitions, definition)
	result.Bindings[name] = voiceToolBinding{
		ServerID:          candidate.ServerID,
		ServerName:        candidate.ServerName,
		IconURL:           candidate.IconURL,
		ToolName:          candidate.Tool.Name,
		MCPAppResourceURI: appMetadata.ResourceURI,
		MCPAppMIMEType:    appMetadata.MIMEType,
		Definition:        definition,
		RequiresApproval:  true,
		Automatic:         true,
	}
}

func automaticMCPBindingExists(bindings map[string]voiceToolBinding, serverID uuid.UUID, toolName string) bool {
	for _, binding := range bindings {
		if binding.ServerID == serverID && binding.ToolName == toolName {
			return true
		}
	}
	return false
}

func parseMCPAllowedTools(raw []byte) map[string]bool {
	var names []string
	_ = json.Unmarshal(raw, &names)
	allowed := make(map[string]bool, len(names))
	for _, name := range names {
		allowed[name] = true
	}
	return allowed
}

func automaticMCPToolScore(query, serverName string, tool mcp.Tool) int {
	queryTerms := automaticMCPQueryTerms(query)
	if len(queryTerms) == 0 {
		return 0
	}
	toolName := normalizeAutomaticMCPText(tool.Name)
	server := normalizeAutomaticMCPText(serverName)
	description := normalizeAutomaticMCPText(tool.Description)
	score := 0
	for _, term := range queryTerms {
		if strings.Contains(toolName, term) {
			score += 8
		}
		if strings.Contains(server, term) {
			score += 5
		}
		if strings.Contains(description, term) {
			score += 2
		}
	}
	return score
}

func automaticMCPQueryTerms(value string) []string {
	stop := map[string]bool{"the": true, "and": true, "for": true, "with": true, "from": true, "this": true, "that": true, "what": true, "please": true, "can": true, "could": true, "would": true, "you": true, "my": true, "our": true, "me": true, "about": true}
	seen := map[string]bool{}
	terms := make([]string, 0)
	for _, term := range strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len([]rune(term)) < 3 || stop[term] || seen[term] {
			continue
		}
		seen[term] = true
		terms = append(terms, term)
	}
	return terms
}

func normalizeAutomaticMCPText(value string) string {
	return strings.Join(strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }), " ")
}

func (a *App) automaticMCPServerAvailable(ctx context.Context, userID, organizationID, serverID uuid.UUID) (bool, error) {
	if !a.platformCapabilityEnabled(ctx, "mcp") {
		return false, nil
	}
	var available bool
	err := a.DB.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM mcp_servers ms
			WHERE ms.id = $1 AND ms.enabled = TRUE AND ms.auto_discover = TRUE
			  AND (ms.scope_type = 'global'
			       OR (ms.scope_type = 'organization' AND ms.scope_id = $3)
			       OR (ms.scope_type = 'user' AND ms.scope_id = $2))
		)`, serverID, userID, organizationID).Scan(&available)
	return available, err
}
