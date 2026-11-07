import assert from "node:assert/strict"
import test from "node:test"

import { parseWorkspaceRoute, workspacePath } from "../lib/workspace-routes.ts"

test("live transcription lives at /live-transcription", () => {
  assert.equal(workspacePath("transcription"), "/live-transcription")
  assert.equal(
    workspacePath("transcription", null, "abc 1"),
    "/live-transcription/abc%201"
  )
})

test("the old /transcription address still opens live transcription", () => {
  for (const path of ["/live-transcription/s1", "/transcription/s1"]) {
    const route = parseWorkspaceRoute(path, new URLSearchParams())
    assert.equal(route.view, "transcription")
    assert.equal(route.sessionId, "s1")
  }
})

test("the old /integrations address opens Settings → Tools", () => {
  const route = parseWorkspaceRoute("/integrations", new URLSearchParams())
  assert.equal(route.view, "settings")
  assert.equal(route.settingsTab, "mcp")
})

test("Workspace settings live at /workspace-settings, and /settings redirects", () => {
  assert.equal(workspacePath("settings"), "/workspace-settings")
  assert.equal(
    workspacePath("settings", null, null, "members"),
    "/workspace-settings?tab=members"
  )
  const current = parseWorkspaceRoute(
    "/workspace-settings",
    new URLSearchParams("tab=members")
  )
  assert.equal(current.view, "settings")
  assert.equal(current.settingsTab, "members")
  assert.equal(current.legacyRedirect, undefined)
  const old = parseWorkspaceRoute(
    "/settings",
    new URLSearchParams("tab=privacy")
  )
  assert.equal(old.view, "settings")
  assert.equal(old.legacyRedirect, "/workspace-settings?tab=privacy")
})
