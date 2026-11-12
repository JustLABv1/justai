import test from "node:test"
import assert from "node:assert/strict"
import {
  filterCaptionResults,
  groupCaptionEvidence,
} from "../lib/speaker-caption-review.ts"

test("caption review filters distinguish review, missing and applied names and search accented names", () => {
  const results = [
    { speakerId: "a", name: "Anna Müller", applied: false, conflict: false },
    { speakerId: "b", name: "Ben", applied: true, conflict: false },
    { speakerId: "c", applied: false, conflict: false },
    { speakerId: "d", name: "Conflicting", applied: false, conflict: true },
  ]
  const labels = new Map([
    ["a", "SPEAKER_00"],
    ["c", "SPEAKER_02"],
  ])
  assert.deepEqual(
    filterCaptionResults(results, "review", "", labels).map((r) => r.speakerId),
    ["a", "d"]
  )
  assert.deepEqual(
    filterCaptionResults(results, "missing", "speaker_02", labels).map(
      (r) => r.speakerId
    ),
    ["c"]
  )
  assert.deepEqual(
    filterCaptionResults(results, "applied", "", labels).map(
      (r) => r.speakerId
    ),
    ["b"]
  )
  assert.deepEqual(
    filterCaptionResults(results, "all", " muller ", labels).map(
      (r) => r.speakerId
    ),
    ["a"]
  )
  assert.equal(
    filterCaptionResults(results, "missing", "Anna", labels).length,
    0
  )
})

test("caption evidence groups duplicate timestamps while retaining each available view", () => {
  const frames = [
    { offsetMs: 8000, view: "full" },
    { offsetMs: 4000 },
    { offsetMs: 4000, view: "sharp" },
  ]
  assert.deepEqual(groupCaptionEvidence([0, 1, 2, 1, 99, -1], frames), [
    {
      offsetMs: 4000,
      images: [
        { index: 1, view: "crop" },
        { index: 2, view: "sharp" },
      ],
    },
    { offsetMs: 8000, images: [{ index: 0, view: "full" }] },
  ])
  assert.deepEqual(groupCaptionEvidence([], frames), [])
})
