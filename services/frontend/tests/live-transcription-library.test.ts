import assert from "node:assert/strict"
import test from "node:test"

import {
  liveLibraryGroups,
  liveLibrarySource,
  videoLibraryPath,
  type VideoTranscriptionLibraryItem,
} from "../lib/video-transcription-library.ts"

const now = new Date(2026, 10, 27, 15, 0)

function item(
  id: string,
  createdAt: Date,
  status: VideoTranscriptionLibraryItem["status"] = "completed"
): VideoTranscriptionLibraryItem {
  return {
    id,
    title: id,
    fileName: "",
    status,
    language: "de",
    durationMs: 0,
    hasSummary: false,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  }
}

test("live sessions are grouped by what runs now, what is planned, then by day and month", () => {
  const groups = liveLibraryGroups(
    [
      item("today-late", new Date(2026, 10, 27, 14, 30)),
      item("running", new Date(2026, 10, 27, 14, 0), "live"),
      item("today-early", new Date(2026, 10, 27, 9, 0)),
      item("yesterday", new Date(2026, 10, 26, 18, 0)),
      item("planned", new Date(2026, 10, 25, 10, 0), "waiting"),
      item("this-week", new Date(2026, 10, 22, 10, 0)),
      item("october", new Date(2026, 9, 30, 10, 0)),
      item("august", new Date(2026, 7, 1, 10, 0)),
      item("paused", new Date(2026, 10, 20, 10, 0), "paused"),
    ],
    now
  )
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.map((entry) => entry.id)]),
    [
      ["now", ["running", "paused"]],
      ["scheduled", ["planned"]],
      ["today", ["today-late", "today-early"]],
      ["yesterday", ["yesterday"]],
      ["week", ["this-week"]],
      ["month:2026-10", ["october"]],
      ["month:2026-08", ["august"]],
    ]
  )
})

test("the source filter lives in the URL of the live list only", () => {
  assert.equal(liveLibrarySource("streams"), "streams")
  assert.equal(liveLibrarySource("podcasts"), "all")
  assert.equal(
    videoLibraryPath(1, "", "open", "live", "meetings"),
    "/live-transcription?source=meetings&status=open"
  )
  assert.equal(
    videoLibraryPath(1, "", "all", "video", "meetings"),
    "/video-transcription"
  )
})
