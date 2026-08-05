import type { ViewId } from "@/lib/types"

const validViews: ViewId[] = [
  "chat",
  "transcription",
  "endpoints",
  "knowledge",
  "mcp",
  "settings",
]

type QueryLike = {
  get: (name: string) => string | null
}

export type WorkspaceRoute = {
  view: ViewId
  conversationId: string | null
  sessionId: string | null
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
  sessionId: string | null = null
) {
  if (view === "chat") {
    return conversationId
      ? `/conversation/${encodeURIComponent(conversationId)}`
      : "/conversation"
  }

  if (view === "transcription") {
    return sessionId
      ? `/transcription/${encodeURIComponent(sessionId)}`
      : "/transcription"
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
    }
  }

  if (section === "transcription" && segments[1] !== "join") {
    return {
      view: "transcription",
      conversationId: null,
      sessionId: decodeSegment(segments[1]),
    }
  }

  if (section && validViews.includes(section as ViewId)) {
    return {
      view: section as ViewId,
      conversationId: null,
      sessionId: null,
    }
  }

  const queryView = searchParams.get("view") as ViewId | null
  const view = queryView && validViews.includes(queryView) ? queryView : "chat"

  return {
    view,
    conversationId: view === "chat" ? searchParams.get("conversation") : null,
    sessionId: view === "transcription" ? searchParams.get("session") : null,
  }
}
