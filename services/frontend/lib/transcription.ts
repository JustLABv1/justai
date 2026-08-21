import type { TranscriptionSegment, TranscriptionSource } from "@/lib/types"

export const TRANSCRIPT_GROUP_GAP_MS = 4000

export function transcriptionJoinPath(code: string) {
  const params = new URLSearchParams({ code: code.trim().toUpperCase() })
  return `/transcription/join?${params.toString()}`
}

export function formatTranscriptionOffset(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

export function upsertTranscriptionSource(
  sources: TranscriptionSource[],
  source: Partial<TranscriptionSource> & Pick<TranscriptionSource, "id">,
  status?: TranscriptionSource["status"]
) {
  const existing = sources.find((item) => item.id === source.id)
  const nextStatus =
    status ?? source.status ?? existing?.status ?? ("pending" as const)
  const inactive = ["paused", "disconnected", "stopped"].includes(nextStatus)
  const next: TranscriptionSource = {
    id: source.id,
    sessionId: source.sessionId ?? existing?.sessionId ?? "",
    name: source.name ?? existing?.name ?? "Room microphone",
    kind: source.kind ?? existing?.kind ?? "browser",
    deviceLabel: source.deviceLabel ?? existing?.deviceLabel ?? "",
    status: nextStatus,
    clockOffsetMs: source.clockOffsetMs ?? existing?.clockOffsetMs ?? 0,
    connectedAt: source.connectedAt ?? existing?.connectedAt ?? null,
    lastSeenAt: source.lastSeenAt ?? existing?.lastSeenAt ?? null,
    signalLevel: inactive
      ? 0
      : (existing?.signalLevel ?? source.signalLevel ?? 0),
  }
  if (!existing) return [...sources, next]
  return sources.map((item) => (item.id === source.id ? next : item))
}

export type TranscriptionMessage = {
  id: string
  segmentIds: string[]
  speakerKey: string
  text: string
  startOffsetMs: number
  endOffsetMs: number
}

export function transcriptionSpeakerKey(
  segment: Pick<TranscriptionSegment, "speakerId" | "sourceId">
) {
  if (segment.speakerId) return segment.speakerId
  if (segment.sourceId) return `source:${segment.sourceId}`
  return "unassigned"
}

export function mergeTranscriptionSegments(
  ...lists: TranscriptionSegment[][]
): TranscriptionSegment[] {
  const byId = new Map<string, TranscriptionSegment>()
  for (const list of lists) {
    for (const segment of list) {
      const existing = byId.get(segment.id)
      byId.set(segment.id, existing ? { ...existing, ...segment } : segment)
    }
  }
  return [...byId.values()].sort((left, right) => {
    const byStart = left.startOffsetMs - right.startOffsetMs
    return byStart || left.endOffsetMs - right.endOffsetMs
  })
}

export function joinTranscriptText(left: string, right: string) {
  const first = left.trim()
  const second = right.trim()
  if (!first) return second
  if (!second) return first
  if (/^[,.;:!?%…)}\]]/u.test(second) || /^[”’]/u.test(second)) {
    return `${first}${second}`
  }
  if (/[([{“‘—-]$/u.test(first)) return `${first}${second}`
  return `${first} ${second}`
}

export function groupTranscriptionSegments(
  segments: TranscriptionSegment[],
  maxGapMs = TRANSCRIPT_GROUP_GAP_MS
) {
  const groups: TranscriptionMessage[] = []
  const ordered = [...segments]
    .filter((segment) => segment.text.trim())
    .sort((left, right) => {
      const byStart = left.startOffsetMs - right.startOffsetMs
      return byStart || left.endOffsetMs - right.endOffsetMs
    })

  for (const segment of ordered) {
    const speakerKey = transcriptionSpeakerKey(segment)
    const previous = groups.at(-1)
    const gap = previous
      ? !hasUsableTiming(previous) && !hasUsableTiming(segment)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, segment.startOffsetMs - previous.endOffsetMs)
      : Number.POSITIVE_INFINITY
    const advancesTimeline = previous
      ? segment.startOffsetMs > previous.startOffsetMs ||
        segment.endOffsetMs > previous.endOffsetMs
      : false

    if (
      previous &&
      previous.speakerKey === speakerKey &&
      advancesTimeline &&
      gap <= maxGapMs
    ) {
      previous.segmentIds.push(segment.id)
      previous.text = joinTranscriptText(previous.text, segment.text)
      previous.endOffsetMs = Math.max(previous.endOffsetMs, segment.endOffsetMs)
      continue
    }

    groups.push({
      id: segment.id,
      segmentIds: [segment.id],
      speakerKey,
      text: segment.text.trim(),
      startOffsetMs: segment.startOffsetMs,
      endOffsetMs: segment.endOffsetMs,
    })
  }

  return groups
}

export function activeTranscriptionMessageId(
  messages: TranscriptionMessage[],
  currentTimeMs: number
) {
  const exactMatch = messages.find((message) => {
    if (currentTimeMs < message.startOffsetMs) return false
    const endOffset =
      message.endOffsetMs > message.startOffsetMs
        ? message.endOffsetMs
        : message.startOffsetMs + 4000
    return currentTimeMs <= endOffset
  })
  if (exactMatch) return exactMatch.id

  // Keep the last spoken line active during a short silence so playback never
  // appears to lose its place between two transcript messages.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && currentTimeMs >= message.startOffsetMs) return message.id
  }
  return null
}

export function activeTranscriptionSegmentId(
  segments: Pick<TranscriptionSegment, "id" | "startOffsetMs">[],
  currentTimeMs: number
) {
  // Walk backwards so a segment that starts exactly when the previous one
  // ends becomes active immediately at the boundary.
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment && currentTimeMs >= segment.startOffsetMs) {
      return segment.id
    }
  }
  return null
}

function hasUsableTiming(
  value: Pick<TranscriptionMessage, "startOffsetMs" | "endOffsetMs">
) {
  return value.startOffsetMs > 0 || value.endOffsetMs > value.startOffsetMs
}
