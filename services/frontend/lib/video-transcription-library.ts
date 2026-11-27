export const VIDEO_LIBRARY_PAGE_SIZE = 12

export type VideoTranscriptionLibraryItem = {
  id: string
  thumbnailUrl?: string
  title: string
  fileName: string
  status:
    | "waiting"
    | "live"
    | "paused"
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
  doneAt?: string | null
  createdAt: string
  updatedAt: string
  /** Live sessions: the first source, a scheduled start and the agenda progress. */
  sourceKind?: string
  sourceName?: string
  scheduledStartAt?: string | null
  topicsTotal?: number
  topicsDone?: number
  streamStatus?: string
  streamEndReason?: string
  outageCount?: number
  /** Live sessions: what it was about, and how many voices were told apart. */
  excerpt?: string
  speakerCount?: number
}

export type VideoTranscriptionLibraryPage = {
  /** Live sessions also count meetings and livestreams for the source filter. */
  counts: Record<VideoLibraryFilter, number> &
    Partial<Record<LiveLibrarySource, number>>
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
  "open",
  "done",
] as const
export type VideoLibraryFilter = (typeof VIDEO_LIBRARY_FILTERS)[number]
export function videoLibraryFilter(value: string | null): VideoLibraryFilter {
  return VIDEO_LIBRARY_FILTERS.includes(value as VideoLibraryFilter)
    ? (value as VideoLibraryFilter)
    : "all"
}
export const LIVE_LIBRARY_SOURCES = ["all", "meetings", "streams"] as const
export type LiveLibrarySource = (typeof LIVE_LIBRARY_SOURCES)[number]
export function liveLibrarySource(value: string | null): LiveLibrarySource {
  return LIVE_LIBRARY_SOURCES.includes(value as LiveLibrarySource)
    ? (value as LiveLibrarySource)
    : "all"
}

export function videoLibraryPath(
  page: number,
  query = "",
  status: VideoLibraryFilter = "all",
  kind: "video" | "live" = "video",
  source: LiveLibrarySource = "all"
) {
  const params = new URLSearchParams()
  if (kind === "live" && source !== "all") params.set("source", source)
  if (status !== "all") params.set("status", status)
  if (page > 1) params.set("page", String(page))
  if (query.trim()) params.set("query", query.trim())
  return `${kind === "live" ? "/live-transcription" : "/video-transcription"}${params.size ? `?${params}` : ""}`
}

export function videoLibraryStatus(
  status: VideoTranscriptionLibraryItem["status"]
) {
  switch (status) {
    case "waiting":
      return "Waiting to start…"
    case "live":
      return "Live"
    case "paused":
      return "Paused"
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
  return [
    "waiting",
    "live",
    "paused",
    "uploading",
    "uploaded",
    "queued",
    "processing",
  ].includes(status)
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
  if (["waiting", "live", "paused"].includes(item.status))
    return videoLibraryStatus(item.status)
  if (!videoLibraryPending(item.status)) return videoLibraryStatus(item.status)
  if (item.status === "uploading") return "Uploading…"
  switch (item.stage) {
    case "recording":
      return "Preparing your final transcript"
    case "uploaded":
    case "queued":
      return "Waiting to start…"
    case "retrying":
      return "Trying again…"
    case "starting":
    case "extracting":
      return "Preparing recording…"
    case "diarization":
    case "diarizing":
    case "skipping_diarization":
      return "Identifying speakers…"
    case "naming_speakers":
      return "Finding speaker names…"
    case "grammar":
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

export type LiveLibraryGroupKey =
  "now" | "scheduled" | "today" | "yesterday" | "week" | `month:${string}`

export type LiveLibraryGroup = {
  key: LiveLibraryGroupKey
  items: VideoTranscriptionLibraryItem[]
}

/**
 * Orders live sessions the way people look for them: what is running now, what is
 * coming up, then by day (today, yesterday, the last seven days) and by month. The
 * order within a group is kept.
 */
export function liveLibraryGroups(
  items: VideoTranscriptionLibraryItem[],
  now = new Date()
): LiveLibraryGroup[] {
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const today = startOfDay(now)
  const day = 24 * 60 * 60 * 1000
  const keyOf = (item: VideoTranscriptionLibraryItem): LiveLibraryGroupKey => {
    if (item.status === "live" || item.status === "paused") return "now"
    if (item.status === "waiting") return "scheduled"
    const created = new Date(item.createdAt)
    const started = startOfDay(created)
    if (started >= today) return "today"
    if (started >= today - day) return "yesterday"
    if (started >= today - 6 * day) return "week"
    return `month:${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}`
  }
  const groups: LiveLibraryGroup[] = []
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.find((candidate) => candidate.key === key)
    if (group) group.items.push(item)
    else groups.push({ key, items: [item] })
  }
  const rank = (key: LiveLibraryGroupKey) =>
    ["now", "scheduled", "today", "yesterday", "week"].indexOf(key)
  return groups.sort((a, b) => {
    const ra = rank(a.key)
    const rb = rank(b.key)
    if (ra >= 0 || rb >= 0) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0
  })
}
