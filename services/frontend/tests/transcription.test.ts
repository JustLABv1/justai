import assert from "node:assert/strict"
import test from "node:test"

import type { TranscriptionSegment, TranscriptionSource } from "../lib/types.ts"
import {
  groupTranscriptionSegments,
  joinTranscriptText,
  mergeTranscriptionSegments,
  upsertTranscriptionSource,
} from "../lib/transcription.ts"

function segment(
  id: string,
  text: string,
  startOffsetMs: number,
  endOffsetMs: number,
  overrides: Partial<TranscriptionSegment> = {}
): TranscriptionSegment {
  return {
    id,
    sessionId: "session",
    sourceId: "source-a",
    speakerId: null,
    text,
    startOffsetMs,
    endOffsetMs,
    confidence: null,
    signalQuality: null,
    canonical: true,
    heardBySourceIds: [],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  }
}

test("groups adjacent rolling transcription segments into one message", () => {
  const messages = groupTranscriptionSegments([
    segment("two", "erst zu kommen nach", 2500, 5000),
    segment("one", "Zumindest scheint eine Antwort", 0, 2500),
    segment("three", "dem ich das nächste losgesagt hat war", 5000, 7500),
    segment("four", "und", 7500, 10000),
    segment("five", "Eine neue Aussage", 15000, 17500),
  ])

  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0]?.segmentIds, ["one", "two", "three", "four"])
  assert.equal(
    messages[0]?.text,
    "Zumindest scheint eine Antwort erst zu kommen nach dem ich das nächste losgesagt hat war und"
  )
  assert.equal(messages[1]?.text, "Eine neue Aussage")
})

test("does not merge different speakers or sources", () => {
  const messages = groupTranscriptionSegments([
    segment("one", "hello", 0, 1000),
    segment("two", "world", 1000, 2000, { speakerId: "speaker-b" }),
    segment("three", "again", 2000, 3000, { sourceId: "source-b" }),
  ])

  assert.equal(messages.length, 3)
})

test("keeps segments without timing separate", () => {
  const messages = groupTranscriptionSegments([
    segment("one", "first", 0, 0),
    segment("two", "second", 0, 0),
  ])

  assert.equal(messages.length, 2)
})

test("keeps repeated timestamps separate", () => {
  const messages = groupTranscriptionSegments([
    segment("one", "first", 0, 2500),
    segment("two", "second", 0, 2500),
  ])

  assert.equal(messages.length, 2)
})

test("reconciles snapshot and event segments without dropping either", () => {
  const merged = mergeTranscriptionSegments(
    [segment("one", "old text", 0, 1000)],
    [
      segment("one", "updated text", 0, 1000),
      segment("two", "new text", 1000, 2000),
    ]
  )

  assert.deepEqual(
    merged.map((item) => [item.id, item.text]),
    [
      ["one", "updated text"],
      ["two", "new text"],
    ]
  )
})

test("joins punctuation without inserting an unwanted space", () => {
  assert.equal(joinTranscriptText("hello", ", world"), "hello, world")
  assert.equal(joinTranscriptText("hello", " world"), "hello world")
})

test("clears a source signal when a participant pauses or disconnects", () => {
  const source: TranscriptionSource = {
    id: "source-a",
    sessionId: "session",
    name: "Conference mic",
    kind: "browser",
    deviceLabel: "Laptop",
    status: "connected",
    clockOffsetMs: 0,
    connectedAt: null,
    lastSeenAt: null,
    signalLevel: 0.8,
  }

  const paused = upsertTranscriptionSource(
    [source],
    { id: source.id },
    "paused"
  )

  assert.equal(paused[0]?.status, "paused")
  assert.equal(paused[0]?.signalLevel, 0)
})
