import type { AdminTab, SettingsTab, ViewId } from "./types.ts"
import type { WorkspaceRoute } from "./workspace-routes.ts"

export const settingsBreadcrumbLabels: Record<SettingsTab, string> = {
  workspace: "Overview",
  endpoints: "AI models",
  mcp: "Tools",
  members: "Members",
  privacy: "Data & privacy",
  lifecycle: "Management",
  knowledge: "Storage",
  admin: "Administration",
}
export const adminBreadcrumbLabels: Record<AdminTab, string> = {
  overview: "Overview",
  users: "Users",
  workspaces: "Workspaces",
  endpoints: "Endpoints",
  mcp: "MCP",
  controls: "Platform controls",
  authentication: "Authentication",
  announcements: "Announcements",
  health: "Health",
  analytics: "Analytics",
  audit: "Audit",
}
const pages: Record<ViewId, { label: string; href: string; group?: string }> = {
  chat: { label: "Chat", href: "/", group: "Create" },
  agents: { label: "Agents", href: "/agents", group: "Create" },
  assistants: { label: "Assistants", href: "/assistants", group: "Create" },
  automations: { label: "Automations", href: "/automations", group: "Create" },
  transcription: {
    label: "Live transcription",
    href: "/live-transcription",
    group: "Capture",
  },
  "video-transcription": {
    label: "Video transcription",
    href: "/video-transcription",
    group: "Capture",
  },
  templates: { label: "Templates", href: "/templates", group: "Storage" },
  knowledge: { label: "Storage", href: "/knowledge" },
  notes: { label: "Notes", href: "/knowledge?type=note", group: "Storage" },
  memory: { label: "Memory", href: "/knowledge?type=memory", group: "Storage" },
  settings: { label: "Workspace settings", href: "/workspace-settings" },
  admin: { label: "Platform admin", href: "/admin" },
  profile: { label: "Profile", href: "/profile" },
  endpoints: { label: "AI models", href: "/workspace-settings?tab=endpoints" },
  mcp: { label: "Tools", href: "/workspace-settings?tab=mcp" },
}
export type WorkspaceCrumb = { label: string; href?: string; literal?: boolean }

/** Route hierarchy; entity names are data and must not go through translation. */
export function workspaceBreadcrumbs(
  route: WorkspaceRoute,
  detailTitle?: string
): WorkspaceCrumb[] {
  const page = pages[route.view]
  const crumbs: WorkspaceCrumb[] = page.group ? [{ label: page.group }] : []
  crumbs.push({ label: page.label })
  let child: WorkspaceCrumb | undefined
  if (route.view === "settings")
    child = { label: settingsBreadcrumbLabels[route.settingsTab] }
  if (route.view === "admin")
    child = { label: adminBreadcrumbLabels[route.adminTab] }
  if (route.view === "agents" && route.agentTab !== "agents") {
    child = { label: route.agentTab === "workflows" ? "Workflows" : "Runs" }
  }
  if (route.view === "chat" && route.conversationId) {
    child =
      detailTitle && detailTitle !== "New conversation"
        ? { label: detailTitle, literal: true }
        : {
            label:
              detailTitle === "New conversation"
                ? "New conversation"
                : "Conversation",
          }
  }
  if (
    (route.view === "transcription" || route.view === "video-transcription") &&
    route.sessionId
  ) {
    child = detailTitle
      ? { label: detailTitle, literal: true }
      : { label: "Transcript" }
  }
  if (child) {
    crumbs[crumbs.length - 1].href = page.href
    crumbs.push(child)
  }
  return crumbs
}
