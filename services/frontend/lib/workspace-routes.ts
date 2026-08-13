import type { SettingsTab, ViewId } from "@/lib/types"

const validViews: ViewId[] = [
  "chat",
  "transcription",
  "endpoints",
  "knowledge",
  "mcp",
  "settings",
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
}

const settingsTabs: SettingsTab[] = [
  "workspace",
  "endpoints",
  "knowledge",
  "mcp",
  "members",
  "admin",
]

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
  settingsTab: SettingsTab = "workspace"
) {
  if (view === "chat") {
    return conversationId ? `/${encodeURIComponent(conversationId)}` : "/"
  }

  if (view === "transcription") {
    return sessionId
      ? `/transcription/${encodeURIComponent(sessionId)}`
      : "/transcription"
  }

  if (view === "settings") {
    return settingsTab === "workspace"
      ? "/settings"
      : `/settings?tab=${encodeURIComponent(settingsTab)}`
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
    }
  }

  if (section === "transcription" && segments[1] !== "join") {
    return {
      view: "transcription",
      conversationId: null,
      sessionId: decodeSegment(segments[1]),
      settingsTab: "workspace",
    }
  }

  if (section === "settings") {
    return {
      view: "settings",
      conversationId: null,
      sessionId: null,
      settingsTab: parseSettingsTab(searchParams.get("tab")),
    }
  }

  if (section === "profile") {
    return {
      view: "profile",
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
    }
  }

  if (section === "endpoints" || section === "knowledge" || section === "mcp") {
    return {
      view: "settings",
      conversationId: null,
      sessionId: null,
      settingsTab: section,
    }
  }

  if (isUUID(decodeSegment(section))) {
    return {
      view: "chat",
      conversationId: decodeSegment(section),
      sessionId: null,
      settingsTab: "workspace",
    }
  }

  if (section && validViews.includes(section as ViewId)) {
    return {
      view: section as ViewId,
      conversationId: null,
      sessionId: null,
      settingsTab: "workspace",
    }
  }

  const queryView = searchParams.get("view") as ViewId | null
  const view = queryView && validViews.includes(queryView) ? queryView : "chat"

  return {
    view,
    conversationId: view === "chat" ? searchParams.get("conversation") : null,
    sessionId: view === "transcription" ? searchParams.get("session") : null,
    settingsTab: parseSettingsTab(searchParams.get("tab")),
  }
}
