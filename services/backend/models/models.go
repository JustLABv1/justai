package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	DisplayName   string    `json:"displayName"`
	PlatformAdmin bool      `json:"platformAdmin"`
}

type Organization struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	Slug string    `json:"slug"`
	Role string    `json:"role,omitempty"`
}

type Endpoint struct {
	ID                   uuid.UUID       `json:"id"`
	ScopeType            string          `json:"scopeType"`
	ScopeID              *uuid.UUID      `json:"scopeId,omitempty"`
	ProviderType         string          `json:"providerType"`
	Name                 string          `json:"name"`
	BaseURL              string          `json:"baseUrl"`
	APIPath              string          `json:"apiPath,omitempty"`
	APIVersion           string          `json:"apiVersion,omitempty"`
	ChatModel            string          `json:"chatModel,omitempty"`
	EmbeddingModel       string          `json:"embeddingModel,omitempty"`
	TranscriptionModel   string          `json:"transcriptionModel,omitempty"`
	Capabilities         json.RawMessage `json:"capabilities"`
	CredentialConfigured bool            `json:"credentialConfigured"`
	Enabled              bool            `json:"enabled"`
	IsDefault            bool            `json:"isDefault"`
	TimeoutSeconds       int             `json:"timeoutSeconds"`
	MaxOutputTokens      int             `json:"maxOutputTokens"`
	Temperature          float64         `json:"temperature"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}

type KnowledgeSource struct {
	ID         uuid.UUID `json:"id"`
	ScopeType  string    `json:"scopeType"`
	ScopeID    uuid.UUID `json:"scopeId"`
	Title      string    `json:"title"`
	SourceType string    `json:"sourceType"`
	SourceURL  string    `json:"sourceUrl,omitempty"`
	MimeType   string    `json:"mimeType,omitempty"`
	Status     string    `json:"status"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type MCPServer struct {
	ID                   uuid.UUID       `json:"id"`
	ScopeType            string          `json:"scopeType"`
	ScopeID              uuid.UUID       `json:"scopeId"`
	Name                 string          `json:"name"`
	EndpointURL          string          `json:"endpointUrl"`
	AuthType             string          `json:"authType"`
	CredentialConfigured bool            `json:"credentialConfigured"`
	Enabled              bool            `json:"enabled"`
	AllowedTools         json.RawMessage `json:"allowedTools"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}

type Citation struct {
	SourceID   uuid.UUID `json:"sourceId"`
	Title      string    `json:"title"`
	ChunkIndex int       `json:"chunkIndex"`
	Snippet    string    `json:"snippet"`
}

type SocketEnvelope struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
	Sequence  int64  `json:"sequence,omitempty"`
	Data      any    `json:"data,omitempty"`
}
