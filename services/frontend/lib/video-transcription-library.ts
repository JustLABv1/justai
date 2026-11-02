export const VIDEO_LIBRARY_PAGE_SIZE = 12

export type VideoTranscriptionLibraryItem = {
  id: string
  thumbnailUrl?: string
  title: string
  fileName: string
  status:
    | "uploading"
    | "uploaded"
    | "queued"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled"
  stage?: string
  language: string
  durationMs: number
  hasSummary: boolean
  createdAt: string
  updatedAt: string
}

export type VideoTranscriptionLibraryPage = {
  counts: Record<VideoLibraryFilter, number>
  items: VideoTranscriptionLibraryItem[]
  total: number
  page: number
  pageSize: number
}

export function videoLibraryPage(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

export const VIDEO_LIBRARY_FILTERS = [
  "all",
  "pending",
  "completed",
  "failed",
  "cancelled",
] as const
export type VideoLibraryFilter = (typeof VIDEO_LIBRARY_FILTERS)[number]
export function videoLibraryFilter(value: string | null): VideoLibraryFilter {
  return VIDEO_LIBRARY_FILTERS.includes(value as VideoLibraryFilter)
    ? (value as VideoLibraryFilter)
    : "all"
}
export function videoLibraryPath(
  page: number,
  query = "",
  status: VideoLibraryFilter = "all"
) {
  const params = new URLSearchParams()
  if (status !== "all") params.set("status", status)
  if (page > 1) params.set("page", String(page))
  if (query.trim()) params.set("query", query.trim())
  return `/video-transcription${params.size ? `?${params}` : ""}`
}

export function videoLibraryStatus(
  status: VideoTranscriptionLibraryItem["status"]
) {
  switch (status) {
    case "completed":
      return "Ready"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "uploading":
      return "Uploading…"
    default:
      return "Transcribing…"
  }
}

export function videoLibraryPending(
  status: VideoTranscriptionLibraryItem["status"]
) {
  return ["uploading", "uploaded", "queued", "processing"].includes(status)
}

export function videoLibraryDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return ""
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

export function videoLibraryStep(item: VideoTranscriptionLibraryItem) {
  if (!videoLibraryPending(item.status)) return videoLibraryStatus(item.status)
  if (item.status === "uploading") return "Uploading…"
  switch (item.stage) {
    case "uploaded":
    case "queued":
      return "Waiting to start…"
    case "retrying":
      return "Trying again…"
    case "starting":
    case "extracting":
      return "Preparing recording…"
    case "diarizing":
    case "skipping_diarization":
      return "Identifying speakers…"
    case "naming_speakers":
      return "Finding speaker names…"
    case "polishing":
      return "Improving transcript…"
    case "finalizing":
      return "Finishing up…"
    default:
      return item.status === "queued" || item.status === "uploaded"
        ? "Waiting to start…"
        : "Transcribing…"
  }
}
