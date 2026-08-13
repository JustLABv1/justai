export type ViewId =
  | "chat"
  | "transcription"
  | "endpoints"
  | "knowledge"
  | "mcp"
  | "settings"
  | "admin"
  | "profile"

export type SettingsTab =
  "workspace" | "endpoints" | "knowledge" | "mcp" | "members" | "admin"

export type AdminTab =
  | "overview"
  | "users"
  | "workspaces"
  | "endpoints"
  | "mcp"
  | "controls"
  | "health"
  | "analytics"
  | "audit"

export type User = {
  id: string
  email: string
  displayName: string
  platformAdmin: boolean
  status?: "active" | "suspended"
  suspendedAt?: string | null
  suspendedReason?: string
  lastLoginAt?: string | null
}

export type Organization = {
  id: string
  name: string
  slug: string
  role?: string
  status?: "active" | "archived" | "suspended"
}

export type OrganizationMember = {
  id: string
  email: string
  displayName: string
  role: "owner" | "admin" | "member"
  createdAt: string
}

export type Endpoint = {
  id: string
  scopeType: "global" | "organization" | "user"
  scopeId?: string
  providerType: string
  name: string
  baseUrl: string
  apiPath?: string
  apiVersion?: string
  chatModel?: string
  embeddingModel?: string
  transcriptionModel?: string
  diarizationModel?: string
  speechModel?: string
  capabilities: Record<string, boolean>
  credentialConfigured: boolean
  enabled: boolean
  isDefault: boolean
  timeoutSeconds: number
  maxOutputTokens: number
  temperature: number
  createdAt: string
  updatedAt: string
}

export type KnowledgeSource = {
  id: string
  scopeType: string
  scopeId?: string | null
  title: string
  sourceType: string
  sourceUrl?: string
  mimeType?: string
  status: "queued" | "processing" | "ready" | "failed"
  progress?: number
  stage?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type MCPServer = {
  id: string
  scopeType: string
  scopeId?: string | null
  name: string
  endpointUrl: string
  authType: string
  credentialConfigured: boolean
  enabled: boolean
  allowedTools: string[]
  trustedReadOnly?: boolean
  lastTestedAt?: string | null
  lastError?: string
  protocolVersion?: string
  toolCount?: number
  createdAt: string
  updatedAt: string
}

export type Citation = {
  kind?: "knowledge" | "transcription"
  resourceId?: string
  sourceId?: string
  title: string
  chunkIndex?: number
  locator?: string
  snippet: string
}

export type ConversationContext = {
  knowledgeSources: KnowledgeSource[]
  mcpServers: MCPServer[]
  transcriptionSessions: TranscriptionSession[]
}

export type Conversation = {
  id: string
  title: string
  endpointId?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  messageCount: number
}

export type TranscriptionSession = {
  id: string
  title: string
  status: "waiting" | "live" | "paused" | "processing" | "completed" | "failed"
  transcriptionEndpointId?: string | null
  diarizationEndpointId?: string | null
  language: string
  recordAudio: boolean
  joinCode?: string
  joinCodeExpiresAt?: string
  startedAt?: string | null
  endedAt?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  sourceCount: number
  segmentCount: number
}

export type TranscriptionSource = {
  id: string
  sessionId: string
  name: string
  kind: string
  deviceLabel?: string
  status: "pending" | "connected" | "paused" | "disconnected" | "stopped"
  clockOffsetMs: number
  connectedAt?: string | null
  lastSeenAt?: string | null
  signalLevel: number
}

export type TranscriptionSpeaker = {
  id: string
  sessionId: string
  label: string
  displayName?: string
  color: string
}

export type TranscriptionSegment = {
  id: string
  sessionId: string
  sourceId?: string | null
  speakerId?: string | null
  text: string
  startOffsetMs: number
  endOffsetMs: number
  confidence?: number | null
  signalQuality?: number | null
  canonical: boolean
  heardBySourceIds?: string[]
  createdAt: string
  updatedAt: string
}

export type TranscriptionRecording = {
  id: string
  sessionId: string
  sourceId: string
  mimeType: string
  bytes: number
  expiresAt?: string | null
  completedAt?: string | null
}

export type TranscriptionJoinRequest = {
  id: string
  sourceName: string
  deviceLabel?: string
  status: "pending" | "approved" | "denied" | "expired"
  sourceId?: string | null
  expiresAt: string
  createdAt: string
}
