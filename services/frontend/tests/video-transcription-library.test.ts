import assert from "node:assert/strict"
import test from "node:test"
import {
  videoLibraryFilter,
  videoLibraryStep,
  type VideoTranscriptionLibraryItem,
  videoLibraryPage,
  videoLibraryPath,
  videoLibraryDuration,
  videoLibraryPending,
} from "../lib/video-transcription-library.ts"

test("recording pages are deep-linkable and invalid URL values cannot produce unsafe offsets", () => {
  assert.equal(videoLibraryPage("3"), 3)
  for (const value of [
    null,
    "",
    "0",
    "-1",
    "2.5",
    "wrong",
    "999999999999999999999999",
  ])
    assert.equal(videoLibraryPage(value), 1)
  assert.equal(videoLibraryPath(1), "/video-transcription")
  assert.equal(
    videoLibraryPath(3, "Budget & Europe"),
    "/video-transcription?page=3&query=Budget+%26+Europe"
  )
  assert.equal(
    videoLibraryPath(1, "  budget "),
    "/video-transcription?query=budget"
  )
})

test("recording durations handle hour-long debates without inventing unknown durations", () => {
  assert.equal(videoLibraryDuration(0), "")
  assert.equal(videoLibraryDuration(Number.NaN), "")
  assert.equal(videoLibraryDuration(240000), "4:00")
  assert.equal(videoLibraryDuration(7265000), "2:01:05")
  assert.equal(videoLibraryPending("uploaded"), true)
  assert.equal(videoLibraryPending("completed"), false)
  assert.equal(videoLibraryPending("cancelled"), false)
})

test("filters persist in URLs and terminal states take precedence over processing stages", () => {
  assert.equal(videoLibraryFilter("failed"), "failed")
  assert.equal(videoLibraryFilter("unknown"), "all")
  assert.equal(
    videoLibraryPath(2, "Budget", "failed"),
    "/video-transcription?status=failed&page=2&query=Budget"
  )
  const item = {
    status: "processing",
    stage: "diarizing",
  } as VideoTranscriptionLibraryItem
  assert.equal(videoLibraryStep(item), "Identifying speakers…")
  assert.equal(videoLibraryStep({ ...item, status: "failed" }), "Failed")
  assert.equal(videoLibraryStep({ ...item, status: "completed" }), "Ready")
  assert.equal(
    videoLibraryStep({ ...item, status: "queued", stage: "queued" }),
    "Waiting to start…"
  )
})
