import type { AdminTab, AgentTab, SettingsTab, ViewId } from "@/lib/types"

const validViews: ViewId[] = [
  "templates",
  "chat",
  "transcription",
  "video-transcription",
  "endpoints",
  "knowledge",
  "automations",
  "agents",
  "mcp",
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
  /** Optional entity selected by a deep link (for example a note or source). */
  targetId?: string | null
  settingsTab: SettingsTab
  adminTab: AdminTab
  agentTab: AgentTab
  legacyRedirect?: string
}

const settingsTabs: SettingsTab[] = [
  "lifecycle",
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
    const base = view === "transcription" ? "live-transcription" : view
    return sessionId ? `/${base}/${encodeURIComponent(sessionId)}` : `/${base}`
  }

  if (view === "settings") {
    return settingsTab === "workspace"
      ? "/workspace-settings"
      : `/workspace-settings?tab=${encodeURIComponent(settingsTab)}`
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
    if (view === "knowledge") {
      return conversationId
        ? `/knowledge?item=${encodeURIComponent(conversationId)}`
        : "/knowledge"
    }
    return `/workspace-settings?tab=${view}`
  }

  if (view === "notes") {
    return conversationId
      ? `/knowledge?type=note&item=${encodeURIComponent(conversationId)}`
      : "/knowledge?type=note"
  }

  if (view === "memory") return "/knowledge?type=memory"

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

  // `/transcription/...` is the old address of the live transcription page;
  // it keeps resolving so existing bookmarks work. `/transcription/join` is
  // the participant link and stays a page of its own.
  if (
    (section === "live-transcription" || section === "transcription") &&
    segments[1] !== "join"
  ) {
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

  // `/settings` is the old address of Workspace settings; it redirects.
  if (section === "settings" || section === "workspace-settings") {
    const settingsTab = parseSettingsTab(searchParams.get("tab"))
    if (settingsTab === "knowledge") {
      const source = searchParams.get("source")
      return {
        view: "knowledge",
        conversationId: null,
        sessionId: null,
        targetId: source,
        settingsTab,
        adminTab: "overview",
        agentTab: "agents",
        legacyRedirect: source
          ? `/knowledge?item=${encodeURIComponent(source)}`
          : "/knowledge",
      }
    }
    return {
      view: "settings",
      conversationId: null,
      sessionId: null,
      targetId: null,
      settingsTab,
      adminTab: "overview",
      agentTab: "agents",
      legacyRedirect:
        section === "settings"
          ? settingsTab === "workspace"
            ? "/workspace-settings"
            : `/workspace-settings?tab=${encodeURIComponent(settingsTab)}`
          : undefined,
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

  // `/integrations` was the MCP servers page; it now lives in Settings → Tools.
  if (
    section === "endpoints" ||
    section === "mcp" ||
    section === "integrations"
  ) {
    return {
      view: "settings",
      conversationId: null,
      sessionId: null,
      targetId: null,
      settingsTab: section === "integrations" ? "mcp" : section,
      adminTab: "overview",
      agentTab: "agents",
      legacyRedirect: `/workspace-settings?tab=${section === "integrations" ? "mcp" : section}`,
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

  if (section === "notes") {
    return {
      view: "knowledge",
      conversationId: null,
      sessionId: null,
      targetId: searchParams.get("note"),
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
      legacyRedirect: searchParams.get("note")
        ? `/knowledge?type=note&item=${encodeURIComponent(searchParams.get("note") as string)}`
        : "/knowledge?type=note",
    }
  }

  if (section === "memory") {
    return {
      view: "knowledge",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
      legacyRedirect: "/knowledge?type=memory",
    }
  }

  if (section === "knowledge") {
    const item = searchParams.get("item") ?? searchParams.get("source")
    return {
      view: "knowledge",
      conversationId: null,
      sessionId: null,
      targetId: item,
      settingsTab: "workspace",
      adminTab: "overview",
      agentTab: "agents",
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

  const rawQueryView = searchParams.get("view")
  const queryView =
    rawQueryView === "assistants"
      ? "agents"
      : rawQueryView === "automations"
        ? "agents"
        : rawQueryView === "notes" || rawQueryView === "memory"
          ? "knowledge"
          : (rawQueryView as ViewId | null)
  const view = queryView && validViews.includes(queryView) ? queryView : "chat"
  const legacyRedirect =
    rawQueryView === "assistants"
      ? "/agents"
      : rawQueryView === "automations"
        ? "/agents?tab=workflows"
        : rawQueryView === "notes"
          ? "/knowledge?type=note"
          : rawQueryView === "memory"
            ? "/knowledge?type=memory"
            : undefined

  return {
    view,
    conversationId: view === "chat" ? searchParams.get("conversation") : null,
    sessionId:
      view === "transcription" || view === "video-transcription"
        ? searchParams.get("session")
        : null,
    settingsTab: parseSettingsTab(searchParams.get("tab")),
    adminTab: parseAdminTab(searchParams.get("tab")),
    agentTab: parseAgentTab(
      rawQueryView === "automations" ? "workflows" : searchParams.get("tab")
    ),
    legacyRedirect,
  }
}

const knownSections = new Set<string>([
  ...validViews,
  "conversation",
  "chat",
  "live-transcription",
  "transcription",
  "settings",
  "workspace-settings",
  "integrations",
  "assistants",
  "automations",
  "notes",
  "memory",
])

/** False for addresses the workspace would otherwise silently show as an empty chat. */
export function isKnownWorkspaceRoute(pathname: string) {
  const segments = pathname.split("/").filter(Boolean)
  const section = segments[0]
  if (!section) return true
  if (isUUID(decodeSegment(section))) return segments.length === 1
  if (!knownSections.has(section)) return false
  // Only these sections take a second segment (an id), `join` being the participant link.
  const takesId = [
    "conversation",
    "chat",
    "live-transcription",
    "transcription",
    "video-transcription",
  ]
  return (
    segments.length === 1 ||
    (segments.length === 2 && takesId.includes(section))
  )
}
