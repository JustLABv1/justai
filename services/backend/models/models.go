package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID              uuid.UUID  `json:"id"`
	Email           string     `json:"email"`
	DisplayName     string     `json:"displayName"`
	PlatformAdmin   bool       `json:"platformAdmin"`
	Status          string     `json:"status,omitempty"`
	SuspendedAt     *time.Time `json:"suspendedAt,omitempty"`
	SuspendedReason string     `json:"suspendedReason,omitempty"`
	SessionVersion  int        `json:"-"`
	LastLoginAt     *time.Time `json:"lastLoginAt,omitempty"`
}

type Organization struct {
	ID     uuid.UUID `json:"id"`
	Name   string    `json:"name"`
	Slug   string    `json:"slug"`
	Role   string    `json:"role,omitempty"`
	Status string    `json:"status,omitempty"`
}

type Conversation struct {
	ID                 uuid.UUID         `json:"id"`
	UserID             uuid.UUID         `json:"-"`
	OrganizationID     uuid.UUID         `json:"-"`
	OwnerID            uuid.UUID         `json:"ownerId,omitempty"`
	Title              string            `json:"title"`
	Visibility         string            `json:"visibility,omitempty"`
	CanManage          bool              `json:"canManage"`
	ProjectID          *uuid.UUID        `json:"projectId,omitempty"`
	EndpointID         *uuid.UUID        `json:"endpointId,omitempty"`
	AssistantID        *uuid.UUID        `json:"assistantId,omitempty"`
	AssistantVersionID *uuid.UUID        `json:"assistantVersionId,omitempty"`
	CreatedAt          time.Time         `json:"createdAt"`
	UpdatedAt          time.Time         `json:"updatedAt"`
	ArchivedAt         *time.Time        `json:"archivedAt,omitempty"`
	FolderID           *uuid.UUID        `json:"folderId,omitempty"`
	PinnedAt           *time.Time        `json:"pinnedAt,omitempty"`
	Tags               []ConversationTag `json:"tags,omitempty"`
	MessageCount       int               `json:"messageCount"`
}

type SavedAssistant struct {
	ID           uuid.UUID  `json:"id"`
	VersionID    uuid.UUID  `json:"versionId"`
	Version      int        `json:"version"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	Icon         string     `json:"icon"`
	Visibility   string     `json:"visibility"`
	Instructions string     `json:"instructions"`
	EndpointID   *uuid.UUID `json:"endpointId,omitempty"`
	Model        string     `json:"model,omitempty"`
	UseMemory    bool       `json:"useMemory"`
	DeepContext  bool       `json:"deepContext"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

// Automation is a persisted, user-owned instruction that can be run on a
// schedule. MCP access is deliberately scoped per automation rather than
// inheriting every connection available in a workspace.
type Automation struct {
	ID           uuid.UUID  `json:"id"`
	Name         string     `json:"name"`
	Prompt       string     `json:"prompt"`
	AssistantID  *uuid.UUID `json:"assistantId,omitempty"`
	Schedule     string     `json:"schedule"`
	Timezone     string     `json:"timezone"`
	MCPServerIDs []string   `json:"mcpServerIds"`
	ApprovalMode string     `json:"approvalMode"`
	Enabled      bool       `json:"enabled"`
	LastRunAt    *time.Time `json:"lastRunAt,omitempty"`
	NextRunAt    *time.Time `json:"nextRunAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type AutomationRun struct {
	ID           uuid.UUID  `json:"id"`
	AutomationID uuid.UUID  `json:"automationId"`
	Status       string     `json:"status"`
	Summary      string     `json:"summary"`
	StartedAt    time.Time  `json:"startedAt"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`
}

type ConversationFolder struct {
	ID             uuid.UUID `json:"id"`
	Name           string    `json:"name"`
	Color          string    `json:"color"`
	OrganizationID uuid.UUID `json:"-"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type ConversationTag struct {
	ID             uuid.UUID `json:"id"`
	Name           string    `json:"name"`
	Color          string    `json:"color"`
	OrganizationID uuid.UUID `json:"-"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type Memory struct {
	ID             uuid.UUID `json:"id"`
	Content        string    `json:"content"`
	Source         string    `json:"source"`
	Enabled        bool      `json:"enabled"`
	OrganizationID uuid.UUID `json:"-"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type Note struct {
	ID                   uuid.UUID  `json:"id"`
	OwnerID              uuid.UUID  `json:"ownerId,omitempty"`
	Visibility           string     `json:"visibility,omitempty"`
	CanManage            bool       `json:"canManage"`
	Title                string     `json:"title"`
	Content              string     `json:"content"`
	SourceConversationID *uuid.UUID `json:"sourceConversationId,omitempty"`
	PinnedAt             *time.Time `json:"pinnedAt,omitempty"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

type WorkspaceProject struct {
	ID             uuid.UUID `json:"id"`
	OwnerID        uuid.UUID `json:"ownerId,omitempty"`
	OrganizationID uuid.UUID `json:"-"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	Visibility     string    `json:"visibility"`
	CanManage      bool      `json:"canManage"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type PrivacySettings struct {
	ArchivedConversationRetentionDays int        `json:"archivedConversationRetentionDays"`
	KnowledgeRetentionDays            int        `json:"knowledgeRetentionDays"`
	TranscriptionRetentionDays        int        `json:"transcriptionRetentionDays"`
	UpdatedAt                         *time.Time `json:"updatedAt,omitempty"`
}

type GeneratedImage struct {
	ID         uuid.UUID  `json:"id"`
	EndpointID *uuid.UUID `json:"endpointId,omitempty"`
	Prompt     string     `json:"prompt"`
	Mode       string     `json:"mode"`
	MimeType   string     `json:"mimeType"`
	URL        string     `json:"url"`
	CreatedAt  time.Time  `json:"createdAt"`
}

type GeneratedPDF struct {
	ID        uuid.UUID `json:"id"`
	URL       string    `json:"url"`
	Filename  string    `json:"filename"`
	Title     string    `json:"title"`
	MimeType  string    `json:"mimeType"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
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
	EndpointKind         string          `json:"endpointKind"`
	ProviderType         string          `json:"providerType"`
	Name                 string          `json:"name"`
	BaseURL              string          `json:"baseUrl"`
	APIPath              string          `json:"apiPath,omitempty"`
	APIVersion           string          `json:"apiVersion,omitempty"`
	ChatModel            string          `json:"chatModel,omitempty"`
	VisionModel          string          `json:"visionModel,omitempty"`
	ImageModel           string          `json:"imageModel,omitempty"`
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
	Kind                  string     `json:"kind"`
	Status                string     `json:"status"`
	TranscriptionEndpoint *uuid.UUID `json:"transcriptionEndpointId,omitempty"`
	DiarizationEndpoint   *uuid.UUID `json:"diarizationEndpointId,omitempty"`
	GrammarEndpoint       *uuid.UUID `json:"grammarEndpointId,omitempty"`
	TranscriptionModel    string     `json:"transcriptionModel,omitempty"`
	DiarizationModel      string     `json:"diarizationModel,omitempty"`
	GrammarModel          string     `json:"grammarModel,omitempty"`
	Language              string     `json:"language"`
	RecordAudio           bool       `json:"recordAudio"`
	PolishStatus          string     `json:"polishStatus"`
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
	RawText          string      `json:"rawText,omitempty"`
	PolishedText     *string     `json:"polishedText,omitempty"`
	EditedText       *string     `json:"editedText,omitempty"`
	StartOffsetMs    int64       `json:"startOffsetMs"`
	EndOffsetMs      int64       `json:"endOffsetMs"`
	Confidence       *float64    `json:"confidence,omitempty"`
	SignalQuality    *float64    `json:"signalQuality,omitempty"`
	Canonical        bool        `json:"canonical"`
	HeardBySourceIDs []uuid.UUID `json:"heardBySourceIds,omitempty"`
	CreatedAt        time.Time   `json:"createdAt"`
	UpdatedAt        time.Time   `json:"updatedAt"`
}

type TranscriptionAnnotation struct {
	ID            uuid.UUID  `json:"id"`
	SessionID     uuid.UUID  `json:"sessionId"`
	UserID        uuid.UUID  `json:"-"`
	SegmentID     *uuid.UUID `json:"segmentId,omitempty"`
	Kind          string     `json:"kind"`
	Note          string     `json:"note,omitempty"`
	StartOffsetMs int64      `json:"startOffsetMs"`
	EndOffsetMs   int64      `json:"endOffsetMs"`
	Resolved      bool       `json:"resolved"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type TranscriptionInsightChapter struct {
	Title         string `json:"title"`
	Summary       string `json:"summary,omitempty"`
	StartOffsetMs int64  `json:"startOffsetMs"`
}

type TranscriptionInsights struct {
	SessionID   uuid.UUID                     `json:"sessionId"`
	Status      string                        `json:"status"`
	Language    string                        `json:"language"`
	Summary     string                        `json:"summary,omitempty"`
	Chapters    []TranscriptionInsightChapter `json:"chapters,omitempty"`
	Topics      []string                      `json:"topics,omitempty"`
	ActionItems []string                      `json:"actionItems,omitempty"`
	Error       string                        `json:"error,omitempty"`
	GeneratedAt *time.Time                    `json:"generatedAt,omitempty"`
	UpdatedAt   time.Time                     `json:"updatedAt"`
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

type TranscriptionVideoParallelProgress struct {
	Strategy        string                             `json:"strategy,omitempty"`
	Phase           string                             `json:"phase,omitempty"`
	ChunkDurationMs int64                              `json:"chunkDurationMs,omitempty"`
	OverlapMs       int64                              `json:"overlapMs,omitempty"`
	WorkerCount     int                                `json:"workerCount,omitempty"`
	SliceCount      int                                `json:"sliceCount,omitempty"`
	CompletedSlices int                                `json:"completedSlices,omitempty"`
	PreviewSegments []TranscriptionVideoPreviewSegment `json:"previewSegments,omitempty"`
}

type TranscriptionVideoPreviewSegment struct {
	StartOffsetMs int64  `json:"startOffsetMs"`
	EndOffsetMs   int64  `json:"endOffsetMs"`
	Text          string `json:"text"`
}

type TranscriptionVideoWorkerStatus struct {
	Capacity           int     `json:"capacity"`
	Active             int     `json:"active"`
	Queued             int     `json:"queued"`
	QueuePosition      int     `json:"queuePosition,omitempty"`
	UtilizationPercent float64 `json:"utilizationPercent"`
	SliceWorkersPerJob int     `json:"sliceWorkersPerJob"`
}

type TranscriptionVideoPipelineStep struct {
	Key         string                              `json:"key"`
	Status      string                              `json:"status"`
	StartedAt   *time.Time                          `json:"startedAt,omitempty"`
	CompletedAt *time.Time                          `json:"completedAt,omitempty"`
	DurationMs  int64                               `json:"durationMs,omitempty"`
	Error       string                              `json:"error,omitempty"`
	Parallel    *TranscriptionVideoParallelProgress `json:"parallel,omitempty"`
}

type TranscriptionVideoUpload struct {
	ID            uuid.UUID                        `json:"id"`
	SessionID     uuid.UUID                        `json:"sessionId"`
	FileName      string                           `json:"fileName"`
	MimeType      string                           `json:"mimeType"`
	ExpectedBytes int64                            `json:"expectedBytes"`
	Bytes         int64                            `json:"bytes"`
	PartSize      int64                            `json:"partSize"`
	PartCount     int                              `json:"partCount"`
	Status        string                           `json:"status"`
	Progress      int                              `json:"progress"`
	Stage         string                           `json:"stage,omitempty"`
	DurationMs    int64                            `json:"durationMs,omitempty"`
	Error         string                           `json:"error,omitempty"`
	Pipeline      []TranscriptionVideoPipelineStep `json:"pipeline,omitempty"`
	CreatedAt     time.Time                        `json:"createdAt"`
	UpdatedAt     time.Time                        `json:"updatedAt"`
	CompletedAt   *time.Time                       `json:"completedAt,omitempty"`
	ExpiresAt     *time.Time                       `json:"expiresAt,omitempty"`
	PlaybackURL   string                           `json:"playbackUrl,omitempty"`
	WorkerStatus  *TranscriptionVideoWorkerStatus  `json:"workerStatus,omitempty"`
}

type KnowledgeSource struct {
	ID           uuid.UUID `json:"id"`
	ScopeType    string    `json:"scopeType"`
	ScopeID      uuid.UUID `json:"scopeId"`
	ContextScope string    `json:"contextScope,omitempty"`
	Title        string    `json:"title"`
	SourceType   string    `json:"sourceType"`
	SourceURL    string    `json:"sourceUrl,omitempty"`
	MimeType     string    `json:"mimeType,omitempty"`
	Status       string    `json:"status"`
	Error        string    `json:"error,omitempty"`
	Progress     int       `json:"progress,omitempty"`
	Stage        string    `json:"stage,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type RepositoryContext struct {
	ID               uuid.UUID  `json:"id"`
	ConversationID   *uuid.UUID `json:"conversationId,omitempty"`
	ScopeType        string     `json:"scopeType"`
	ScopeID          uuid.UUID  `json:"scopeId"`
	Provider         string     `json:"provider"`
	RepositoryURL    string     `json:"repositoryUrl"`
	Owner            string     `json:"owner"`
	Repository       string     `json:"repository"`
	Ref              string     `json:"ref"`
	ResolvedRef      string     `json:"resolvedRef,omitempty"`
	Title            string     `json:"title"`
	ContextScope     string     `json:"contextScope,omitempty"`
	Status           string     `json:"status"`
	Error            string     `json:"error,omitempty"`
	FileCount        int        `json:"fileCount"`
	ReadyFileCount   int        `json:"readyFileCount"`
	SkippedFileCount int        `json:"skippedFileCount"`
	TotalBytes       int64      `json:"totalBytes"`
	Progress         int        `json:"progress"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}

type MCPServer struct {
	ID                   uuid.UUID       `json:"id"`
	ScopeType            string          `json:"scopeType"`
	ScopeID              *uuid.UUID      `json:"scopeId,omitempty"`
	Name                 string          `json:"name"`
	IconURL              string          `json:"iconUrl,omitempty"`
	EndpointURL          string          `json:"endpointUrl"`
	AuthType             string          `json:"authType"`
	CredentialConfigured bool            `json:"credentialConfigured"`
	Enabled              bool            `json:"enabled"`
	AllowedTools         json.RawMessage `json:"allowedTools"`
	TrustedReadOnly      bool            `json:"trustedReadOnly"`
	AutoDiscover         bool            `json:"autoDiscover"`
	LastTestedAt         *time.Time      `json:"lastTestedAt,omitempty"`
	LastError            string          `json:"lastError,omitempty"`
	ProtocolVersion      string          `json:"protocolVersion,omitempty"`
	ToolCount            int             `json:"toolCount"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}

type Citation struct {
	Kind       string    `json:"kind,omitempty"`
	ResourceID uuid.UUID `json:"resourceId,omitempty"`
	SourceID   uuid.UUID `json:"sourceId,omitempty"`
	Title      string    `json:"title"`
	ChunkIndex int       `json:"chunkIndex,omitempty"`
	Locator    string    `json:"locator,omitempty"`
	Snippet    string    `json:"snippet"`
	// PromptText keeps the complete retrieved chunk in memory for the provider
	// prompt. It is intentionally excluded from API responses and persistence;
	// Snippet remains the compact UI citation representation.
	PromptText string `json:"-"`
}

type ConversationContext struct {
	KnowledgeSources      []KnowledgeSource      `json:"knowledgeSources"`
	Repositories          []RepositoryContext    `json:"repositories"`
	MCPServers            []MCPServer            `json:"mcpServers"`
	TranscriptionSessions []TranscriptionSession `json:"transcriptionSessions"`
	Notes                 []Note                 `json:"notes,omitempty"`
	Project               *WorkspaceProject      `json:"project,omitempty"`
}

type SocketEnvelope struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
	Sequence  int64  `json:"sequence,omitempty"`
	Data      any    `json:"data,omitempty"`
}
