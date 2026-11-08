import assert from "node:assert/strict"
import test from "node:test"
import { workspaceBreadcrumbs } from "../lib/workspace-breadcrumbs.ts"
import { parseWorkspaceRoute } from "../lib/workspace-routes.ts"
const trail = (url: string, title?: string) => {
  const parsed = new URL(url, "https://example.test")
  return workspaceBreadcrumbs(
    parseWorkspaceRoute(parsed.pathname, parsed.searchParams),
    title
  )
}
test("settings breadcrumbs match every visible settings tab", () => {
  for (const [tab, label] of Object.entries({
    workspace: "Overview",
    endpoints: "AI models",
    mcp: "Tools",
    members: "Members",
    privacy: "Data & privacy",
    lifecycle: "Management",
  })) {
    assert.deepEqual(trail(`/workspace-settings?tab=${tab}`), [
      { label: "Workspace settings", href: "/workspace-settings" },
      { label },
    ])
  }
})
test("admin breadcrumbs cover every admin tab", () => {
  for (const [tab, label] of Object.entries({
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
  })) {
    assert.deepEqual(trail(`/admin?tab=${tab}`), [
      { label: "Platform admin", href: "/admin" },
      { label },
    ])
  }
})
test("details preserve entity titles and link back to their list", () => {
  assert.deepEqual(trail("/chat/example", "My project"), [
    { label: "Create" },
    { label: "Chat", href: "/" },
    { label: "My project", literal: true },
  ])
  for (const base of ["live-transcription", "video-transcription"]) {
    const crumbs = trail(`/${base}/example`, "Interview")
    assert.equal(crumbs.at(-2)?.href, `/${base}`)
    assert.deepEqual(crumbs.at(-1), { label: "Interview", literal: true })
  }
  assert.equal(trail("/chat/example").at(-1)?.label, "Conversation")
})
test("agent tabs, legacy routes and storage resolve their actual hierarchy", () => {
  assert.deepEqual(trail("/agents?tab=workflows"), [
    { label: "Create" },
    { label: "Agents", href: "/agents" },
    { label: "Workflows" },
  ])
  assert.equal(trail("/agents?tab=runs").at(-1)?.label, "Runs")
  assert.equal(trail("/endpoints").at(-1)?.label, "AI models")
  assert.deepEqual(trail("/knowledge"), [{ label: "Storage" }])
  assert.deepEqual(trail("/profile"), [{ label: "Profile" }])
  assert.equal(trail("/").at(-1)?.label, "Chat")
  assert.equal(trail("/templates").at(-1)?.label, "Templates")
})
