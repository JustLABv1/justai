export type ViewId = "chat" | "endpoints" | "knowledge" | "mcp" | "settings"

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

export type Conversation = {
  id: string
  title: string
  endpointId?: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  citations?: Citation[]
  createdAt?: string
}
