import type {
  TranscriptionSegment,
  TranscriptionVideoPipelineStep,
  TranscriptionVideoUpload,
} from "./types"

/** Only report measured work within a step, never the weighted job progress. */
export function videoStepProgress(
  upload: TranscriptionVideoUpload,
  step: TranscriptionVideoPipelineStep | undefined,
  segments: TranscriptionSegment[]
): { percent: number | null; detail: string } {
  if (step?.key === "upload" && upload.expectedBytes > 0) {
    const bytes = Math.max(0, Math.min(upload.bytes, upload.expectedBytes))
    return {
      percent: Math.floor((bytes / upload.expectedBytes) * 100),
      detail: `${(bytes / 1048576).toFixed(1)} / ${(upload.expectedBytes / 1048576).toFixed(1)} MB uploaded`,
    }
  }
  const parallel = step?.parallel
  if (
    step?.key === "transcription" &&
    parallel?.phase === "transcribing" &&
    parallel.sliceCount &&
    parallel.sliceCount > 0
  ) {
    const completed = Math.max(
      0,
      Math.min(parallel.completedSlices ?? 0, parallel.sliceCount)
    )
    return {
      percent: Math.floor((completed / parallel.sliceCount) * 100),
      detail: `${completed} / ${parallel.sliceCount} audio blocks transcribed`,
    }
  }
  if (step?.key === "speaker_names" && parallel?.sliceCount) {
    const completed = Math.max(
      0,
      Math.min(parallel.completedSlices ?? 0, parallel.sliceCount)
    )
    return {
      percent: Math.floor((completed / parallel.sliceCount) * 100),
      detail:
        parallel.phase === "queued"
          ? `Waiting for caption analysis · ${parallel.sliceCount} images selected`
          : `${completed} / ${parallel.sliceCount} caption images analyzed`,
    }
  }
  if (step?.key === "grammar") {
    const textSegments = segments.filter((segment) => segment.text.trim())
    const polished = textSegments.filter((segment) =>
      segment.polishedText?.trim()
    ).length
    if (textSegments.length) {
      return {
        percent: Math.floor((polished / textSegments.length) * 100),
        detail: `${polished} / ${textSegments.length} text blocks polished`,
      }
    }
  }
  return { percent: null, detail: "" }
}
