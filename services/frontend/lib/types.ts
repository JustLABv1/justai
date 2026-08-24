export type ViewId =
  | "chat"
  | "transcription"
  | "video-transcription"
  | "endpoints"
  | "knowledge"
  | "mcp"
  | "notes"
  | "memory"
  | "assistants"
  | "settings"
  | "admin"
  | "profile"

export type SettingsTab =
  | "workspace"
  | "endpoints"
  | "knowledge"
  | "mcp"
  | "members"
  | "privacy"
  | "admin"

export type AdminTab =
  | "overview"
  | "users"
  | "workspaces"
  | "endpoints"
  | "mcp"
  | "controls"
  | "authentication"
  | "announcements"
  | "health"
  | "analytics"
  | "audit"

export type PlatformSettings = {
  loginEnabled: boolean
  localAuthEnabled: boolean
  signupEnabled: boolean
  aiEnabled: boolean
  voiceEnabled: boolean
  transcriptionEnabled: boolean
  mcpEnabled: boolean
  knowledgeEnabled: boolean
  attachmentsEnabled: boolean
  maintenanceMessage: string
  updatedAt?: string | null
}

export type AdminAnalyticsSummary = {
  requests: number
  succeeded: number
  failed: number
  cancelled: number
  averageLatencyMs: number
  p95LatencyMs: number
  averageTtftMs: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  toolCalls: number
}

export type AdminAnalyticsDay = {
  date: string
  requests: number
  succeeded: number
  failed: number
  cancelled: number
  averageLatencyMs: number
  toolCalls: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export type AdminAnalyticsEndpoint = {
  endpointId: string
  endpointName: string
  model: string
  requests: number
  errors: number
  averageLatencyMs: number
}

export type TranscriptionWorkerAnalyticsDay = {
  date: string
  total: number
  completed: number
  failed: number
  cancelled: number
}

export type TranscriptionWorkerAnalytics = {
  capacity: number
  active: number
  queued: number
  utilizationPercent: number
  sliceWorkersPerJob: number
  activeSliceWorkers: number
  totalJobs: number
  completedJobs: number
  failedJobs: number
  cancelledJobs: number
  audioHoursProcessed: number
  averageQueueWaitMs: number
  p95QueueWaitMs: number
  averageProcessingMs: number
  p95ProcessingMs: number
  periodDays: number
  timeSeries: TranscriptionWorkerAnalyticsDay[]
}

export type AdminAnalyticsResponse = {
  summary: AdminAnalyticsSummary
  byEndpoint: AdminAnalyticsEndpoint[]
  timeSeries: AdminAnalyticsDay[]
  transcriptionWorkers: TranscriptionWorkerAnalytics
}

export type PlatformHealth = {
  database: { ok: boolean }
  workers: { rag: boolean; transcription: boolean }
  providers: {
    ok: boolean
    total: number
    enabled: number
    recentFailures: number
  }
  mcp: { ok: boolean; total: number; enabled: number; failures: number }
  checkedAt: string
}

export type AdminAttentionItem = {
  id: string
  severity: "critical" | "warning" | "info"
  title: string
  description: string
  tab: AdminTab
  metric?: number
}

export type AdminActivityItem = {
  id: number
  action: string
  resourceType: string
  createdAt: string
}

export type AdminDashboardResponse = {
  generatedAt: string
  counts: Record<string, number>
  settings: PlatformSettings
  health: PlatformHealth
  usage: AdminAnalyticsResponse
  attention: AdminAttentionItem[]
  recentActivity: AdminActivityItem[]
}

export type OIDCProviderSummary = {
  id: string
  slug: string
  displayName: string
}

export type AdminOIDCProvider = OIDCProviderSummary & {
  issuer: string
  clientId: string
  scopes: string
  enabled: boolean
  secretConfigured: boolean
  lastTestedAt?: string | null
  lastError?: string
  callbackUrl: string
}

export type PlatformBanner = {
  id: string
  message: string
  severity: "info" | "success" | "warning" | "danger"
  linkUrl?: string
  priority: number
  enabled: boolean
  dismissible: boolean
  startsAt: string
  endsAt?: string | null
  createdAt: string
  updatedAt: string
}

export type AuthConfig = {
  oidcEnabled: boolean
  oidcLabel?: string
  oidcProviders: OIDCProviderSummary[]
  loginEnabled: boolean
  localAuthEnabled: boolean
  signupEnabled: boolean
  maintenanceMessage?: string
  banners: PlatformBanner[]
}

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
  endpointKind: EndpointKind
  providerType: string
  name: string
  baseUrl: string
  apiPath?: string
  apiVersion?: string
  chatModel?: string
  visionModel?: string
  embeddingModel?: string
  imageModel?: string
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

export type EndpointKind = "llm" | "diarization"

export type KnowledgeSource = {
  id: string
  scopeType: string
  scopeId?: string | null
  contextScope?: "persistent" | "message"
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

export type RepositoryContext = {
  id: string
  conversationId?: string | null
  scopeType: string
  scopeId?: string | null
  provider: "github" | "gitlab" | string
  repositoryUrl: string
  owner: string
  repository: string
  ref: string
  resolvedRef?: string
  title: string
  contextScope?: "persistent" | "message"
  status: "processing" | "queued" | "ready" | "failed" | string
  error?: string
  fileCount: number
  readyFileCount: number
  skippedFileCount: number
  totalBytes: number
  progress: number
  createdAt: string
  updatedAt: string
}

export type MCPServer = {
  id: string
  scopeType: string
  scopeId?: string | null
  name: string
  iconUrl?: string
  endpointUrl: string
  authType: string
  credentialConfigured: boolean
  enabled: boolean
  allowedTools: string[]
  trustedReadOnly?: boolean
  autoDiscover?: boolean
  lastTestedAt?: string | null
  lastError?: string
  protocolVersion?: string
  toolCount?: number
  createdAt: string
  updatedAt: string
}

export type Citation = {
  kind?: "knowledge" | "note" | "transcription"
  resourceId?: string
  sourceId?: string
  title: string
  chunkIndex?: number
  locator?: string
  snippet: string
}

export type ConversationContext = {
  knowledgeSources: KnowledgeSource[]
  repositories: RepositoryContext[]
  mcpServers: MCPServer[]
  transcriptionSessions: TranscriptionSession[]
  notes?: Note[]
  project?: WorkspaceProject | null
}

export type ConversationFolder = {
  id: string
  name: string
  color?: string
  createdAt: string
  updatedAt: string
}

export type ConversationTag = {
  id: string
  name: string
  color?: string
  createdAt: string
}

export type Conversation = {
  id: string
  title: string
  ownerId?: string
  visibility?: "private" | "workspace" | string
  canManage?: boolean
  projectId?: string | null
  endpointId?: string | null
  assistantId?: string | null
  assistantVersionId?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  messageCount: number
  folderId?: string | null
  pinnedAt?: string | null
  tags?: ConversationTag[]
}

export type SavedAssistant = {
  id: string
  versionId: string
  version: number
  name: string
  description: string
  icon: string
  visibility: "private" | "workspace" | string
  instructions: string
  endpointId?: string | null
  model?: string
  useMemory: boolean
  deepContext: boolean
  createdAt: string
  updatedAt: string
}

export type Memory = {
  id: string
  content: string
  source: "manual" | "chat" | "import" | string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type Note = {
  id: string
  ownerId?: string
  visibility?: "private" | "workspace" | string
  canManage?: boolean
  title: string
  content: string
  sourceConversationId?: string | null
  pinnedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type WorkspaceProject = {
  id: string
  ownerId?: string
  name: string
  description: string
  visibility: "private" | "workspace" | string
  canManage?: boolean
  createdAt: string
  updatedAt: string
}

export type PrivacySettings = {
  archivedConversationRetentionDays: number
  knowledgeRetentionDays: number
  transcriptionRetentionDays: number
  updatedAt?: string | null
}

export type UniversalSearchResult = {
  kind:
    "conversation" | "note" | "knowledge" | "transcript" | "project" | string
  id: string
  title: string
  snippet: string
  updatedAt: string
  conversationId?: string
  sessionId?: string
}

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  domain?: string
}

export type GeneratedImage = {
  id: string
  endpointId?: string
  prompt: string
  mode: "generate" | "edit" | string
  mimeType: string
  createdAt: string
  url: string
}

export type TranscriptionSession = {
  id: string
  title: string
  kind: "live" | "video"
  status: "waiting" | "live" | "paused" | "processing" | "completed" | "failed"
  transcriptionEndpointId?: string | null
  diarizationEndpointId?: string | null
  grammarEndpointId?: string | null
  transcriptionModel?: string
  diarizationModel?: string
  grammarModel?: string
  language: string
  recordAudio: boolean
  polishStatus?:
    "not_requested" | "queued" | "processing" | "completed" | "failed"
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
  rawText?: string
  polishedText?: string | null
  editedText?: string | null
  startOffsetMs: number
  endOffsetMs: number
  confidence?: number | null
  signalQuality?: number | null
  canonical: boolean
  heardBySourceIds?: string[]
  createdAt: string
  updatedAt: string
}

export type TranscriptionAnnotation = {
  id: string
  sessionId: string
  segmentId?: string | null
  kind: "bookmark" | "comment"
  note?: string
  startOffsetMs: number
  endOffsetMs: number
  resolved: boolean
  createdAt: string
  updatedAt: string
}

export type TranscriptionInsightChapter = {
  title: string
  summary?: string
  startOffsetMs: number
}

export type TranscriptionInsights = {
  sessionId: string
  status: "idle" | "processing" | "completed" | "failed"
  language: string
  summary?: string
  chapters?: TranscriptionInsightChapter[]
  topics?: string[]
  actionItems?: string[]
  error?: string
  generatedAt?: string | null
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

export type TranscriptionVideoPipelineStep = {
  key: string
  status:
    | "pending"
    | "active"
    | "completed"
    | "skipped"
    | "failed"
    | "retrying"
    | "cancelled"
  startedAt?: string | null
  completedAt?: string | null
  durationMs?: number
  durationEstimated?: boolean
  error?: string
  parallel?: TranscriptionVideoParallelProgress
}

export type TranscriptionVideoParallelProgress = {
  strategy?: string
  phase?: "preparing" | "transcribing" | "fusing" | "complete" | string
  chunkDurationMs?: number
  overlapMs?: number
  workerCount?: number
  sliceCount?: number
  completedSlices?: number
  previewSegments?: TranscriptionVideoPreviewSegment[]
}

export type TranscriptionVideoPreviewSegment = {
  startOffsetMs: number
  endOffsetMs: number
  text: string
}

export type TranscriptionVideoWorkerStatus = {
  capacity: number
  active: number
  queued: number
  queuePosition?: number
  utilizationPercent: number
  sliceWorkersPerJob: number
}

export type TranscriptionVideoUpload = {
  id: string
  sessionId: string
  fileName: string
  mimeType: string
  expectedBytes: number
  bytes: number
  partSize: number
  partCount: number
  status:
    | "uploading"
    | "uploaded"
    | "queued"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled"
  progress: number
  stage?: string
  durationMs?: number
  error?: string
  pipeline?: TranscriptionVideoPipelineStep[]
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  expiresAt?: string | null
  playbackUrl?: string
  workerStatus?: TranscriptionVideoWorkerStatus
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
