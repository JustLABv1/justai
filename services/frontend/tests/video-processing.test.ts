import assert from "node:assert/strict"
import test from "node:test"
import type {
  TranscriptionSegment,
  TranscriptionVideoPipelineStep,
  TranscriptionVideoUpload,
} from "../lib/types.ts"
import { videoStepProgress } from "../lib/video-processing.ts"

const upload = {
  expectedBytes: 100 * 1048576,
  bytes: 23 * 1048576,
  progress: 87,
} as TranscriptionVideoUpload
const step = (
  key: string,
  parallel?: TranscriptionVideoPipelineStep["parallel"]
): TranscriptionVideoPipelineStep => ({ key, status: "active", parallel })

test("upload percent and byte detail use the same transport measurement", () => {
  assert.deepEqual(videoStepProgress(upload, step("upload"), []), {
    percent: 23,
    detail: "23.0 / 100.0 MB uploaded",
  })
  assert.equal(
    videoStepProgress({ ...upload, bytes: 200 * 1048576 }, step("upload"), [])
      .percent,
    100
  )
  assert.equal(
    videoStepProgress({ ...upload, expectedBytes: 0 }, step("upload"), [])
      .percent,
    null
  )
})

test("counts completed audio blocks rather than inferring progress from preview timestamps", () => {
  const result = videoStepProgress(
    upload,
    step("transcription", {
      phase: "transcribing",
      sliceCount: 10,
      completedSlices: 3,
      previewSegments: [
        {
          startOffsetMs: 540000,
          endOffsetMs: 600000,
          text: "Last block finished first",
        },
      ],
    }),
    []
  )
  assert.deepEqual(result, {
    percent: 30,
    detail: "3 / 10 audio blocks transcribed",
  })
})

test("preparing, merging and speaker detection have no fabricated percent", () => {
  for (const phase of ["preparing", "fusing", "complete"]) {
    assert.equal(
      videoStepProgress(
        upload,
        step("transcription", { phase, sliceCount: 10, completedSlices: 10 }),
        []
      ).percent,
      null
    )
  }
  assert.equal(videoStepProgress(upload, step("diarization"), []).percent, null)
  assert.equal(
    videoStepProgress(upload, step("transcription"), []).percent,
    null
  )
})

test("polishing counts available corrections and ignores empty text blocks", () => {
  const segments = [
    { text: "First", polishedText: "First." },
    { text: "Second", polishedText: "  " },
    { text: "  ", polishedText: null },
  ] as TranscriptionSegment[]
  assert.deepEqual(videoStepProgress(upload, step("grammar"), segments), {
    percent: 50,
    detail: "1 / 2 text blocks polished",
  })
})
