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
