import assert from "node:assert/strict"
import test from "node:test"

import { conversationCacheKey } from "../lib/conversation-cache.ts"

test("conversation cache keys isolate the same conversation id by scope", () => {
  const workspaceA = conversationCacheKey("org-a:user-1", "conversation-1")
  const workspaceB = conversationCacheKey("org-b:user-1", "conversation-1")
  const userB = conversationCacheKey("org-a:user-2", "conversation-1")

  assert.notEqual(workspaceA, workspaceB)
  assert.notEqual(workspaceA, userB)
  assert.equal(
    conversationCacheKey("scope:with:separators", "conversation:1"),
    '["scope:with:separators","conversation:1"]'
  )
})
