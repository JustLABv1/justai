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

type Conversation struct {
	ID             uuid.UUID  `json:"id"`
	UserID         uuid.UUID  `json:"-"`
	OrganizationID uuid.UUID  `json:"-"`
	Title          string     `json:"title"`
	EndpointID     *uuid.UUID `json:"endpointId,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	ArchivedAt     *time.Time `json:"archivedAt,omitempty"`
	MessageCount   int        `json:"messageCount"`
}

type Message struct {
	ID             uuid.UUID  `json:"id"`
	ConversationID uuid.UUID  `json:"conversationId"`
	Role           string     `json:"role"`
	Content        string     `json:"content"`
	Citations      []Citation `json:"citations,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
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
	DiarizationModel     string          `json:"diarizationModel,omitempty"`
	SpeechModel          string          `json:"speechModel,omitempty"`
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

type TranscriptionSession struct {
	ID                    uuid.UUID  `json:"id"`
	UserID                uuid.UUID  `json:"-"`
	OrganizationID        uuid.UUID  `json:"-"`
	Title                 string     `json:"title"`
	Status                string     `json:"status"`
	TranscriptionEndpoint *uuid.UUID `json:"transcriptionEndpointId,omitempty"`
	DiarizationEndpoint   *uuid.UUID `json:"diarizationEndpointId,omitempty"`
	Language              string     `json:"language"`
	RecordAudio           bool       `json:"recordAudio"`
	JoinCode              string     `json:"joinCode,omitempty"`
	StartedAt             *time.Time `json:"startedAt,omitempty"`
	EndedAt               *time.Time `json:"endedAt,omitempty"`
	CreatedAt             time.Time  `json:"createdAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
	ArchivedAt            *time.Time `json:"archivedAt,omitempty"`
	SourceCount           int        `json:"sourceCount"`
	SegmentCount          int        `json:"segmentCount"`
}

type TranscriptionSource struct {
	ID            uuid.UUID  `json:"id"`
	SessionID     uuid.UUID  `json:"sessionId"`
	Name          string     `json:"name"`
	Kind          string     `json:"kind"`
	DeviceLabel   string     `json:"deviceLabel,omitempty"`
	Status        string     `json:"status"`
	ClockOffsetMs int64      `json:"clockOffsetMs"`
	ConnectedAt   *time.Time `json:"connectedAt,omitempty"`
	LastSeenAt    *time.Time `json:"lastSeenAt,omitempty"`
	SignalLevel   float64    `json:"signalLevel"`
}

type TranscriptionSpeaker struct {
	ID          uuid.UUID `json:"id"`
	SessionID   uuid.UUID `json:"sessionId"`
	Label       string    `json:"label"`
	DisplayName string    `json:"displayName,omitempty"`
	Color       string    `json:"color"`
}

type TranscriptionSegment struct {
	ID               uuid.UUID   `json:"id"`
	SessionID        uuid.UUID   `json:"sessionId"`
	SourceID         *uuid.UUID  `json:"sourceId,omitempty"`
	SpeakerID        *uuid.UUID  `json:"speakerId,omitempty"`
	Text             string      `json:"text"`
	StartOffsetMs    int64       `json:"startOffsetMs"`
	EndOffsetMs      int64       `json:"endOffsetMs"`
	Confidence       *float64    `json:"confidence,omitempty"`
	SignalQuality    *float64    `json:"signalQuality,omitempty"`
	Canonical        bool        `json:"canonical"`
	HeardBySourceIDs []uuid.UUID `json:"heardBySourceIds,omitempty"`
	CreatedAt        time.Time   `json:"createdAt"`
	UpdatedAt        time.Time   `json:"updatedAt"`
}

type TranscriptionRecording struct {
	ID          uuid.UUID  `json:"id"`
	SessionID   uuid.UUID  `json:"sessionId"`
	SourceID    uuid.UUID  `json:"sourceId"`
	MimeType    string     `json:"mimeType"`
	Bytes       int64      `json:"bytes"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
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
