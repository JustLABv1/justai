export type ViewId =
  | "chat"
  | "transcription"
  | "endpoints"
  | "knowledge"
  | "mcp"
  | "settings"

export type User = {
  id: string
  email: string
  displayName: string
  platformAdmin: boolean
}

export type Organization = {
  id: string
  name: string
  slug: string
  role?: string
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
  scopeId: string
  title: string
  sourceType: string
  sourceUrl?: string
  mimeType?: string
  status: "queued" | "processing" | "ready" | "failed"
  error?: string
  createdAt: string
  updatedAt: string
}

export type MCPServer = {
  id: string
  scopeType: string
  scopeId: string
  name: string
  endpointUrl: string
  authType: string
  credentialConfigured: boolean
  enabled: boolean
  allowedTools: string[]
  createdAt: string
  updatedAt: string
}

export type Citation = {
  sourceId: string
  title: string
  chunkIndex: number
  snippet: string
}

export type ChatToolEvent = {
  kind: "mcp_tool"
  status: "running" | "awaiting_approval" | "completed" | "declined" | "failed"
  serverId?: string
  serverName: string
  toolName: string
  callId: string
  approvalId?: string
  arguments?: Record<string, unknown>
  result?: string
  error?: string
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

export type ChatMessage = {
  id: string
  role: "user" | "assistant" | "tool"
  content: string
  citations?: Citation[]
  toolCall?: ChatToolEvent
  createdAt?: string
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
