import { parseToolResult } from "./file-result-logic.ts"

/** Persisted tool output is untrusted: only known in-app destinations are links. */
export function parseJustAIAction(value: unknown) {
  const parsed = parseToolResult(value)
  if (!parsed || typeof parsed !== "object") return null
  const action = (parsed as Record<string, unknown>).action
  if (!action || typeof action !== "object") return null
  const { href, title, description } = action as Record<string, unknown>
  if (
    typeof href !== "string" ||
    typeof title !== "string" ||
    !href.startsWith("/") ||
    href.startsWith("//")
  )
    return null
  const url = new URL(href, "https://justai.invalid")
  const tabs: Record<string, string[]> = {
    "/": [],
    "/agents": ["agents", "workflows", "runs"],
    "/knowledge": [],
    "/templates": [],
    "/live-transcription": [],
    "/video-transcription": [],
    "/profile": [],
    "/workspace-settings": [
      "workspace",
      "endpoints",
      "mcp",
      "members",
      "privacy",
      "lifecycle",
    ],
    "/admin": [
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
    ],
  }
  if (
    url.origin !== "https://justai.invalid" ||
    !(url.pathname in tabs) ||
    url.hash
  )
    return null
  for (const [key, val] of url.searchParams) {
    if (key === "tab" && tabs[url.pathname].includes(val)) continue
    if (
      key === "create" &&
      val === "1" &&
      url.pathname === "/live-transcription"
    )
      continue
    return null
  }
  return {
    href: url.pathname + url.search,
    title,
    description: typeof description === "string" ? description : "",
  }
}
