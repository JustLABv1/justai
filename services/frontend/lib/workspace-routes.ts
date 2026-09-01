import type { AdminTab, AgentTab, SettingsTab, ViewId } from "@/lib/types"

const validViews: ViewId[] = [
  "chat",
  "transcription",
  "video-transcription",
  "endpoints",
  "knowledge",
  "integrations",
  "automations",
  "agents",
  "mcp",
  "notes",
  "memory",
  "assistants",
  "settings",
  "admin",
  "profile",
]

type QueryLike = {
  get: (name: string) => string | null
}

export type WorkspaceRoute = {
  view: ViewId
  conversationId: string | null
  sessionId: string | null
  settingsTab: SettingsTab
  adminTab: AdminTab
  agentTab: AgentTab
  legacyRedirect?: string
}

const settingsTabs: SettingsTab[] = [
  "workspace",
  "endpoints",
  "knowledge",
  "mcp",
  "members",
  "privacy",
  "admin",
]

const adminTabs: AdminTab[] = [
  "overview",
  "users",
  "workspaces",
  "endpoints",
  "mcp",
  "controls",
  "authentication",
  "announcements",
  "health",
  "analytics",
  "audit",
]

const agentTabs: AgentTab[] = ["agents", "workflows", "runs"]

function isUUID(value: string | null): value is string {
  return Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  )
}

function parseSettingsTab(value: string | null | undefined): SettingsTab {
  return value && settingsTabs.includes(value as SettingsTab)
    ? (value as SettingsTab)
    : "workspace"
}

function parseAdminTab(value: string | null | undefined): AdminTab {
  return value && adminTabs.includes(value as AdminTab)
    ? (value as AdminTab)
    : "overview"
}

function parseAgentTab(value: string | null | undefined): AgentTab {
  return value && agentTabs.includes(value as AgentTab)
    ? (value as AgentTab)
    : "agents"
}

function decodeSegment(value: string | undefined) {
  if (!value) return null

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function workspacePath(
  view: ViewId,
  conversationId: string | null = null,
  sessionId: string | null = null,
  settingsTab: SettingsTab = "workspace",
  adminTab: AdminTab = "overview",
  agentTab: AgentTab = "agents"
) {
  if (view === "chat") {
    return conversationId ? `/${encodeURIComponent(conversationId)}` : "/"
  }

  if (view === "transcription" || view === "video-transcription") {
    return sessionId ? `/${view}/${encodeURIComponent(sessionId)}` : `/${view}`
  }

  if (view === "settings") {
    return settingsTab === "workspace"
      ? "/settings"
      : `/settings?tab=${encodeURIComponent(settingsTab)}`
  }

  if (view === "admin") {
    return adminTab === "overview"
      ? "/admin"
      : `/admin?tab=${encodeURIComponent(adminTab)}`
  }

  if (view === "agents") {
    return agentTab === "agents"
      ? "/agents"
      : `/agents?tab=${encodeURIComponent(agentTab)}`
  }

  if (view === "endpoints" || view === "knowledge" || view === "mcp") {
    return `/settings?tab=${view}`
  }

  return `/${view}`
}

export function parseWorkspaceRoute(
  pathname: string,
  searchParams: QueryLike
): WorkspaceRoute {
  const segments = pathname.split("/").filter(Boolean)
  const section = segments[0]

  if (section === "conversation" || section === "chat") {
    return {
      view: "chat",
      conversationId: decodeSegment(segments[1]),
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (section === "transcription" && segments[1] !== "join") {
    return {
      view: "transcription",
      conversationId: null,
      sessionId: decodeSegment(segments[1]),
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (section === "video-transcription") {
    return {
      view: "video-transcription",
      conversationId: null,
      sessionId: decodeSegment(segments[1]),
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (section === "settings") {
    return {
      view: "settings",
      conversationId: null,
      sessionId: null,
      settingsTab: parseSettingsTab(searchParams.get("tab")),
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (section === "admin") {
    return {
      view: "admin",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: parseAdminTab(searchParams.get("tab")),
      agentTab: "agents",
    }
  }

  if (section === "profile") {
    return {
      view: "profile",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (section === "endpoints" || section === "knowledge" || section === "mcp") {
    return {
      view: "settings",
      conversationId: null,
      sessionId: null,
      settingsTab: section,
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (isUUID(decodeSegment(section))) {
    return {
      view: "chat",
      conversationId: decodeSegment(section),
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  if (section === "assistants") {
    return {
      view: "agents",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
      legacyRedirect: "/agents",
    }
  }

  if (section === "automations") {
    return {
      view: "agents",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "workflows",
      legacyRedirect: "/agents?tab=workflows",
    }
  }

  if (section === "agents") {
    return {
      view: "agents",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: parseAgentTab(searchParams.get("tab")),
    }
  }

  if (section && validViews.includes(section as ViewId)) {
    return {
      view: section as ViewId,
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
    }
  }

  const queryView = searchParams.get("view") as ViewId | null
  const view = queryView && validViews.includes(queryView) ? queryView : "chat"

  return {
    view,
    conversationId: view === "chat" ? searchParams.get("conversation") : null,
    sessionId:
      view === "transcription" || view === "video-transcription"
        ? searchParams.get("session")
        : null,
    settingsTab: parseSettingsTab(searchParams.get("tab")),
    adminTab: parseAdminTab(searchParams.get("tab")),
    agentTab: parseAgentTab(searchParams.get("tab")),
  }
}
