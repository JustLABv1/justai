import assert from "node:assert/strict"
import test from "node:test"

import {
  transcriptionWorkflowInput,
  transcriptionWorkflowPrefill,
  transcriptionWorkflowTranscript,
  type TranscriptionWorkflowSource,
} from "../lib/transcription-workflow.ts"
import type { AgentWorkflow } from "../lib/types"

const source: TranscriptionWorkflowSource = {
  session: { id: "session-1", title: "Planning meeting", kind: "video" },
  url: "https://justai.example/transcription/session-1",
  speakers: [
    {
      id: "speaker-1",
      sessionId: "session-1",
      label: "Speaker 1",
      displayName: "Ada",
      color: "#000000",
    },
  ],
  segments: [
    {
      id: "segment-1",
      sessionId: "session-1",
      speakerId: "speaker-1",
      text: "Old wording",
      editedText: "Review the figures.",
      startOffsetMs: 65_000,
      endOffsetMs: 67_000,
      canonical: true,
      createdAt: "",
      updatedAt: "",
    },
  ],
  insights: {
    sessionId: "session-1",
    status: "completed",
    language: "en",
    summary: "The team discussed the budget.",
    topics: ["Budget"],
    actionItems: ["Review the figures"],
    updatedAt: "",
  },
}

const workflow: AgentWorkflow = {
  id: "workflow-1",
  name: "Meeting actions",
  description: "",
  visibility: "private",
  definition: {
    nodes: [
      {
        id: "extract",
        type: "agent",
        instruction: "Prepare a follow-up.",
        approvalMode: "review",
        inputBindings: [
          { name: "transcript", source: "input" },
          { name: "actions", source: "input" },
        ],
      },
    ],
    edges: [],
  },
  schedule: { kind: "manual" },
  timezone: "UTC",
  enabled: true,
  createdAt: "",
  updatedAt: "",
}

test("passes reviewed transcript text and insights to a workflow run", () => {
  const transcript = transcriptionWorkflowTranscript(source)
  assert.equal(transcript.text, "[00:01:05] Ada: Review the figures.")
  assert.equal(transcript.truncated, false)

  const prefill = transcriptionWorkflowPrefill(workflow, source)
  assert.equal(prefill.transcript, transcript.text)
  assert.equal(prefill.actions, "- Review the figures")

  const input = transcriptionWorkflowInput(source, prefill)
  assert.equal(input.transcript, transcript.text)
  assert.equal(input.transcription.sessionId, "session-1")
  assert.deepEqual(input.transcription.actionItems, ["Review the figures"])
  assert.equal(input.transcription.url, source.url)
})
