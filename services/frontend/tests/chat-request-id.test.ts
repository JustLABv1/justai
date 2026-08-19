import assert from "node:assert/strict"
import test from "node:test"

import { chatRequestId } from "../lib/chat-request-id.ts"

test("uses the approval id so sequential approvals on one assistant message are distinct", () => {
  const first = chatRequestId([
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          state: "approval-responded",
          approval: { id: "approval-1", approved: true },
        },
      ],
    },
  ])
  const second = chatRequestId([
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          state: "approval-responded",
          approval: { id: "approval-2", approved: true },
        },
      ],
    },
  ])

  assert.equal(first, "approval:assistant-1:approval-1")
  assert.equal(second, "approval:assistant-1:approval-2")
  assert.notEqual(first, second)
})

test("keeps user turn ids stable", () => {
  assert.equal(
    chatRequestId([{ id: "user-1", role: "user", parts: [] }]),
    "turn:user-1"
  )
})
