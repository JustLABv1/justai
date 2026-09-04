"use client"

import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  GitMerge,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import {
  activeTranscriptionMessageId,
  activeTranscriptionSegmentId,
  groupTranscriptionSegments,
  joinTranscriptText,
} from "@/lib/transcription"
import { cn } from "@/lib/utils"
import type {
  TranscriptionAnnotation,
  TranscriptionInsights,
  TranscriptionRecording,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSpeaker,
  TranscriptionVideoPreviewSegment,
  TranscriptionVideoUpload,
} from "@/lib/types"

export type TranscriptWorkspaceSnapshot = {
  session: TranscriptionSession
  segments: TranscriptionSegment[]
  speakers: TranscriptionSpeaker[]
  annotations?: TranscriptionAnnotation[]
  insights?: TranscriptionInsights
  recordings?: TranscriptionRecording[]
  videoUpload?: TranscriptionVideoUpload | null
}

export type TranscriptWorkspaceMediaKind = "video" | "audio" | "none"

export type TranscriptWorkspaceProps = {
  snapshot: TranscriptWorkspaceSnapshot
  onSnapshotChange: (
    updater: (
      snapshot: TranscriptWorkspaceSnapshot
    ) => TranscriptWorkspaceSnapshot
  ) => void
  videoRef: RefObject<HTMLVideoElement | null>
  currentTimeMs: number
  onCurrentTimeChange: (value: number) => void
  videoDurationMs: number
  onVideoDurationChange: (value: number) => void
  videoPlaybackError: string
  onVideoPlaybackError: (value: string) => void
  onRefreshPlayback: () => Promise<void>
  onRenameSpeaker: (speaker: TranscriptionSpeaker) => void
  onError: (value: string) => void
  mediaKind?: TranscriptWorkspaceMediaKind
}

/**
 * Kept as a compatibility alias for the video pipeline while the workspace
 * itself is shared by every completed transcript session.
 */
export type VideoTranscriptSnapshot = TranscriptWorkspaceSnapshot

type VideoTranscriptWorkspaceProps = TranscriptWorkspaceProps

type TranscriptMode = "verbatim" | "polished" | "edited"
type WorkspaceView = "review" | "insights" | "speakers" | "details"

type AnnotationTarget = {
  segmentId: string
  startOffsetMs: number
  endOffsetMs: number
}

type SpeakerSummary = {
  speaker: TranscriptionSpeaker
  segmentCount: number
  speakingMs: number
  sampleStartMs: number | null
  sampleEndMs: number | null
  sampleText: string
}

const insightLanguageOptions = [
  { value: "auto", label: "Auto (transcript language)" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "uk", label: "Ukrainian" },
  { value: "tr", label: "Turkish" },
  { value: "ar", label: "Arabic" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
] as const

function formatVideoDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

function formatVideoTimestamp(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function speakerInitials(value: string) {
  const initials = value
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return initials || "S"
}

function speakerDisplayName(speaker: TranscriptionSpeaker | undefined) {
  return speaker?.displayName || speaker?.label || "Unassigned"
}

function qualityIssues(segment: TranscriptionSegment) {
  const issues: string[] = []
  if (typeof segment.confidence === "number" && segment.confidence < 0.65) {
    issues.push("Low confidence")
  }
  if (segment.endOffsetMs < segment.startOffsetMs) {
    issues.push("Invalid timing")
  }
  const words = segment.text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
  for (let size = 2; size <= 6; size += 1) {
    if (words.length < size * 2) continue
    const left = words.slice(-size)
    const right = words.slice(-size * 2, -size)
    if (left.join(" ") === right.join(" ")) {
      issues.push("Repeated phrase")
      break
    }
  }
  return issues
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function highlightText(value: string, query: string) {
  const normalized = query.trim()
  if (!normalized) return value
  const parts = value.split(new RegExp(`(${escapeRegExp(normalized)})`, "ig"))
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === normalized.toLocaleLowerCase() ? (
      <mark
        className="rounded bg-primary/20 px-0.5 text-inherit"
        key={`${part}-${index}`}
      >
        {part}
      </mark>
    ) : (
      part
    )
  )
}

function highlightActiveTranscriptSegment(
  messageText: string,
  segments: TranscriptionSegment[],
  activeSegmentId: string | null,
  query: string
) {
  const activeIndex = segments.findIndex(
    (segment) => segment.id === activeSegmentId
  )
  const activeText = segments[activeIndex]?.text.trim()
  if (!activeText) return highlightText(messageText, query)

  let prefix = ""
  for (let index = 0; index < activeIndex; index += 1) {
    prefix = joinTranscriptText(prefix, segments[index]?.text ?? "")
  }
  const start = messageText.indexOf(activeText, prefix.length)
  if (start < 0) return highlightText(messageText, query)

  const end = start + activeText.length
  return (
    <>
      {highlightText(messageText.slice(0, start), query)}
      <span className="rounded bg-primary/20 px-0.5 ring-1 ring-primary/25">
        {highlightText(messageText.slice(start, end), query)}
      </span>
      {highlightText(messageText.slice(end), query)}
    </>
  )
}

function transcriptMatches(
  segment: TranscriptionSegment,
  query: string,
  speakerFilter: string,
  speakerById: Map<string, TranscriptionSpeaker>,
  onlyQuality: boolean
) {
  if (speakerFilter !== "all" && segment.speakerId !== speakerFilter) {
    return false
  }
  if (onlyQuality && qualityIssues(segment).length === 0) return false
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  const speaker = speakerDisplayName(
    segment.speakerId ? speakerById.get(segment.speakerId) : undefined
  )
  return `${speaker} ${segment.text}`
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}

function livePreviewSegments(
  upload: TranscriptionVideoUpload | null | undefined,
  processing: boolean
) {
  const parallelProgress = upload?.pipeline?.find(
    (step) => step.key === "transcription"
  )?.parallel
  if (
    !processing ||
    !["preparing", "transcribing", "fusing"].includes(
      parallelProgress?.phase ?? ""
    )
  ) {
    return [] as TranscriptionVideoPreviewSegment[]
  }
  return [...(parallelProgress?.previewSegments ?? [])]
    .filter((segment) => segment.text.trim())
    .sort((left, right) => left.startOffsetMs - right.startOffsetMs)
}

export function TranscriptWorkspace({
  snapshot,
  onSnapshotChange,
  videoRef,
  currentTimeMs,
  onCurrentTimeChange,
  videoDurationMs,
  onVideoDurationChange,
  videoPlaybackError,
  onVideoPlaybackError,
  onRefreshPlayback,
  onRenameSpeaker,
  onError,
  mediaKind = "video",
}: VideoTranscriptWorkspaceProps) {
  const [transcriptMode, setTranscriptMode] =
    useState<TranscriptMode>("verbatim")
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("review")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [transcriptQuery, setTranscriptQuery] = useState("")
  const [speakerFilter, setSpeakerFilter] = useState("all")
  const [qualityOnly, setQualityOnly] = useState(false)
  const [matchIndex, setMatchIndex] = useState(0)
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({})
  const [savingSegmentId, setSavingSegmentId] = useState<string | null>(null)
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([])
  const [assignmentSpeakerId, setAssignmentSpeakerId] = useState("")
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationTarget | null>(null)
  const [annotationKind, setAnnotationKind] = useState<"bookmark" | "comment">(
    "comment"
  )
  const [annotationNote, setAnnotationNote] = useState("")
  const [annotationSaving, setAnnotationSaving] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeSourceId, setMergeSourceId] = useState("")
  const [mergeTargetId, setMergeTargetId] = useState("")
  const [mergeSaving, setMergeSaving] = useState(false)
  const [mediaPlaying, setMediaPlaying] = useState(false)
  const [audioSource, setAudioSource] = useState<{
    recordingId: string
    url: string
    error: string
  } | null>(null)
  const [audioDurationMs, setAudioDurationMs] = useState(0)
  const [selectedRecordingId, setSelectedRecordingId] = useState(
    () => snapshot.recordings?.[0]?.id ?? ""
  )
  const [polishGenerating, setPolishGenerating] = useState(false)
  const [insightsGenerating, setInsightsGenerating] = useState(false)
  const [insightLanguage, setInsightLanguage] = useState(
    () => snapshot.insights?.language ?? "auto"
  )
  const [exportFormat, setExportFormat] = useState("pdf")
  const [includeInsightsInExport, setIncludeInsightsInExport] = useState(true)
  const [speakerSample, setSpeakerSample] = useState<{
    speakerId: string
    endOffsetMs: number
  } | null>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const recordings = useMemo(() => snapshot.recordings ?? [], [snapshot.recordings])
  const effectiveRecordingId = recordings.some(
    (recording) => recording.id === selectedRecordingId
  )
    ? selectedRecordingId
    : (recordings[0]?.id ?? "")
  const selectedRecording = recordings.find(
    (recording) => recording.id === effectiveRecordingId
  )
  const audioSourceURL =
    mediaKind === "audio" &&
    audioSource?.recordingId === effectiveRecordingId &&
    !audioSource.error
      ? audioSource.url
      : ""
  const audioPlaybackError =
    mediaKind === "audio" && audioSource?.recordingId === effectiveRecordingId
      ? audioSource.error
      : ""
  const canSeek =
    mediaKind === "video"
      ? Boolean(snapshot.videoUpload?.playbackUrl)
      : mediaKind === "audio"
        ? Boolean(audioSourceURL)
        : false

  useEffect(() => {
    if (mediaKind !== "audio" || !effectiveRecordingId) {
      return
    }
    let cancelled = false
    let objectURL = ""
    const recordingId = effectiveRecordingId
    void api
      .getBlob(`/api/v1/transcription/recordings/${recordingId}`)
      .then((blob) => {
        if (cancelled) return
        objectURL = URL.createObjectURL(blob)
        setAudioSource({
          recordingId,
          url: objectURL,
          error: "",
        })
      })
      .catch((caught) => {
        if (cancelled) return
        setAudioSource({
          recordingId,
          url: "",
          error:
            caught instanceof Error
              ? caught.message
              : "Audio could not be loaded.",
        })
      })
    return () => {
      cancelled = true
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [effectiveRecordingId, mediaKind])

  const updateSnapshot = useCallback(
    (
      updater: (current: VideoTranscriptSnapshot) => VideoTranscriptSnapshot
    ) => {
      onSnapshotChange(updater)
    },
    [onSnapshotChange]
  )

  const speakerById = useMemo(
    () => new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker])),
    [snapshot.speakers]
  )
  const displaySegments = useMemo(
    () =>
      snapshot.segments.map((segment) => {
        const verbatim = segment.text.trim() || segment.rawText?.trim() || ""
        const polished = segment.polishedText?.trim() || verbatim
        const edited = segment.editedText?.trim() || ""
        return {
          ...segment,
          text:
            transcriptMode === "polished"
              ? polished
              : transcriptMode === "edited"
                ? edited || polished
                : verbatim,
        }
      }),
    [snapshot.segments, transcriptMode]
  )
  const displaySegmentById = useMemo(
    () => new Map(displaySegments.map((segment) => [segment.id, segment])),
    [displaySegments]
  )
  const transcript = useMemo(
    () => groupTranscriptionSegments(displaySegments),
    [displaySegments]
  )
  const isVideoProcessing = ["uploading", "queued", "processing"].includes(
    snapshot.videoUpload?.status ?? ""
  )
  const preview = useMemo(
    () => livePreviewSegments(snapshot.videoUpload, isVideoProcessing),
    [isVideoProcessing, snapshot.videoUpload]
  )
  const polishedAvailable = snapshot.segments.some((segment) =>
    segment.polishedText?.trim()
  )
  const editedAvailable = snapshot.segments.some((segment) =>
    segment.editedText?.trim()
  )
  const filteredTranscript = useMemo(
    () =>
      transcript.filter((message) =>
        message.segmentIds.some((segmentId) => {
          const segment = displaySegmentById.get(segmentId)
          return (
            segment &&
            transcriptMatches(
              segment,
              transcriptQuery,
              speakerFilter,
              speakerById,
              qualityOnly
            )
          )
        })
      ),
    [
      displaySegmentById,
      qualityOnly,
      speakerById,
      speakerFilter,
      transcript,
      transcriptQuery,
    ]
  )
  const filteredSegments = useMemo(
    () =>
      displaySegments.filter((segment) =>
        transcriptMatches(
          segment,
          transcriptQuery,
          speakerFilter,
          speakerById,
          qualityOnly
        )
      ),
    [displaySegments, qualityOnly, speakerById, speakerFilter, transcriptQuery]
  )
  const activeMessageId = useMemo(
    () => activeTranscriptionMessageId(transcript, currentTimeMs),
    [currentTimeMs, transcript]
  )
  const activeSegmentId = useMemo(
    () => activeTranscriptionSegmentId(displaySegments, currentTimeMs),
    [currentTimeMs, displaySegments]
  )
  const displayDurationMs =
    mediaKind === "audio"
      ? audioDurationMs
      : mediaKind === "video"
        ? videoDurationMs || snapshot.videoUpload?.durationMs || 0
        : 0
  const hasActiveFilter = Boolean(
    transcriptQuery.trim() || speakerFilter !== "all" || qualityOnly
  )
  const activeMatchIndex = Math.min(
    matchIndex,
    Math.max(0, filteredTranscript.length - 1)
  )
  const annotations = snapshot.annotations ?? []
  const insights = snapshot.insights ?? {
    sessionId: snapshot.session.id,
    status: "idle" as const,
    language: "auto",
    chapters: [],
    topics: [],
    actionItems: [],
    updatedAt: "",
  }
  const validInsightChapters = useMemo(() => {
    const chapters = insights.chapters ?? []
    return chapters.filter(
      (chapter) =>
        Number.isFinite(chapter.startOffsetMs) &&
        chapter.startOffsetMs >= 0 &&
        (displayDurationMs <= 0 || chapter.startOffsetMs <= displayDurationMs)
    )
  }, [displayDurationMs, insights.chapters])
  const hiddenInsightChapterCount = Math.max(
    0,
    (insights.chapters?.length ?? 0) - validInsightChapters.length
  )
  const exportSupportsInsights = ["pdf", "docx", "md", "txt"].includes(
    exportFormat
  )
  const insightsReady = insights.status === "completed"
  const insightsProcessing =
    insightsGenerating || insights.status === "processing"
  const polishProcessing =
    polishGenerating || snapshot.session.polishStatus === "processing"
  const canPolishTranscript =
    snapshot.session.kind === "live" &&
    Boolean(snapshot.session.grammarEndpointId) &&
    snapshot.segments.length > 0
  const speakerSummaries = useMemo<SpeakerSummary[]>(() => {
    const segmentsBySpeaker = new Map<string, TranscriptionSegment[]>()
    for (const segment of displaySegments) {
      if (!segment.speakerId) continue
      const items = segmentsBySpeaker.get(segment.speakerId) ?? []
      items.push(segment)
      segmentsBySpeaker.set(segment.speakerId, items)
    }
    return snapshot.speakers.map((speaker) => {
      const segments = segmentsBySpeaker.get(speaker.id) ?? []
      const first = segments[0]
      const start = first ? Math.max(0, first.startOffsetMs) : null
      const end = first
        ? Math.max(start ?? 0, first.endOffsetMs || (start ?? 0) + 2500)
        : null
      const sampleEnd =
        start === null || end === null
          ? null
          : Math.min(
              displayDurationMs > start ? displayDurationMs : start + 8000,
              Math.max(start + 1500, Math.min(start + 8000, end + 4000))
            )
      return {
        speaker,
        segmentCount: segments.length,
        speakingMs: segments.reduce((total, item) => {
          const duration = item.endOffsetMs - item.startOffsetMs
          return total + (duration > 0 ? duration : 0)
        }, 0),
        sampleStartMs: start,
        sampleEndMs: sampleEnd,
        sampleText: first?.text.trim() ?? "",
      }
    })
  }, [displayDurationMs, displaySegments, snapshot.speakers])

  useEffect(() => {
    if (filteredTranscript.length === 0) return
    const message =
      filteredTranscript[Math.min(matchIndex, filteredTranscript.length - 1)]
    messageRefs.current.get(message.id)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    })
  }, [filteredTranscript, matchIndex])

  useEffect(() => {
    if (
      !mediaPlaying ||
      workspaceView !== "review" ||
      editorOpen ||
      hasActiveFilter ||
      !activeMessageId
    ) {
      return
    }
    const message = messageRefs.current.get(activeMessageId)
    if (!message) return
    const frame = window.requestAnimationFrame(() => {
      message.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeMessageId,
    editorOpen,
    hasActiveFilter,
    mediaPlaying,
    workspaceView,
  ])

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("t")
    const offset = raw ? Number(raw) : NaN
    const media =
      mediaKind === "audio" ? audioRef.current : videoRef.current
    if (!Number.isFinite(offset) || offset < 0 || !media) return
    const seek = () => {
      media.currentTime = offset / 1000
      onCurrentTimeChange(offset)
    }
    seek()
    media.addEventListener("loadedmetadata", seek)
    return () => media.removeEventListener("loadedmetadata", seek)
  }, [
    audioSourceURL,
    mediaKind,
    onCurrentTimeChange,
    snapshot.videoUpload?.playbackUrl,
    videoRef,
  ])

  const seekTo = useCallback(
    (offsetMs: number, play = true) => {
      const media =
        mediaKind === "audio" ? audioRef.current : videoRef.current
      if (!media) return
      setSpeakerSample(null)
      const durationFromElementMs =
        Number.isFinite(media.duration) && media.duration > 0
          ? media.duration * 1000
          : 0
      const knownDurationMs = Math.max(displayDurationMs, durationFromElementMs)
      const safeOffsetMs = Math.max(0, offsetMs)
      const boundedOffsetMs =
        knownDurationMs > 0
          ? Math.min(safeOffsetMs, knownDurationMs)
          : safeOffsetMs
      media.currentTime = boundedOffsetMs / 1000
      onCurrentTimeChange(boundedOffsetMs)
      if (play) void media.play().catch(() => undefined)
    },
    [displayDurationMs, mediaKind, onCurrentTimeChange, videoRef]
  )

  const playSpeakerSample = useCallback(
    (summary: SpeakerSummary) => {
      const media =
        mediaKind === "audio" ? audioRef.current : videoRef.current
      if (!media || !canSeek) return
      if (speakerSample?.speakerId === summary.speaker.id) {
        media.pause()
        setSpeakerSample(null)
        return
      }
      if (summary.sampleStartMs === null || summary.sampleEndMs === null) return
      media.currentTime = summary.sampleStartMs / 1000
      onCurrentTimeChange(summary.sampleStartMs)
      setSpeakerSample({
        speakerId: summary.speaker.id,
        endOffsetMs: summary.sampleEndMs,
      })
      void media.play().catch(() => setSpeakerSample(null))
    },
    [
      canSeek,
      mediaKind,
      onCurrentTimeChange,
      speakerSample?.speakerId,
      videoRef,
    ]
  )

  const saveSegmentEdit = async (segment: TranscriptionSegment) => {
    const value = editDrafts[segment.id] ?? segment.editedText ?? segment.text
    setSavingSegmentId(segment.id)
    try {
      const result = await api.patch<{ segment: TranscriptionSegment }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/segments/${segment.id}`,
        { editedText: value }
      )
      updateSnapshot((current) => ({
        ...current,
        segments: current.segments.map((item) =>
          item.id === segment.id ? result.segment : item
        ),
      }))
      setEditDrafts((current) => {
        const next = { ...current }
        delete next[segment.id]
        return next
      })
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "The edit could not be saved."
      )
    } finally {
      setSavingSegmentId(null)
    }
  }

  const assignSelectedSpeaker = async () => {
    if (!assignmentSpeakerId || selectedSegmentIds.length === 0) return
    try {
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/segments/assign-speaker`,
        { segmentIds: selectedSegmentIds, speakerId: assignmentSpeakerId }
      )
      updateSnapshot((current) => ({
        ...current,
        segments: current.segments.map((segment) =>
          selectedSegmentIds.includes(segment.id)
            ? { ...segment, speakerId: assignmentSpeakerId }
            : segment
        ),
      }))
      setSelectedSegmentIds([])
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error ? caught.message : "Speaker assignment failed."
      )
    }
  }

  const createAnnotation = async () => {
    if (
      !annotationTarget ||
      (annotationKind === "comment" && !annotationNote.trim())
    ) {
      return
    }
    setAnnotationSaving(true)
    try {
      const result = await api.post<{ annotation: TranscriptionAnnotation }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/annotations`,
        {
          kind: annotationKind,
          note: annotationNote.trim(),
          segmentId: annotationTarget.segmentId,
          startOffsetMs: annotationTarget.startOffsetMs,
          endOffsetMs: annotationTarget.endOffsetMs,
        }
      )
      updateSnapshot((current) => ({
        ...current,
        annotations: [...(current.annotations ?? []), result.annotation].sort(
          (left, right) => left.startOffsetMs - right.startOffsetMs
        ),
      }))
      setAnnotationTarget(null)
      setAnnotationNote("")
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "The annotation could not be saved."
      )
    } finally {
      setAnnotationSaving(false)
    }
  }

  const deleteAnnotation = async (annotation: TranscriptionAnnotation) => {
    try {
      await api.delete(
        `/api/v1/transcription/sessions/${snapshot.session.id}/annotations/${annotation.id}`
      )
      updateSnapshot((current) => ({
        ...current,
        annotations: (current.annotations ?? []).filter(
          (item) => item.id !== annotation.id
        ),
      }))
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "The annotation could not be deleted."
      )
    }
  }

  const copyTimestampLink = async (offsetMs: number) => {
    const url = new URL(window.location.href)
    url.searchParams.set("t", String(Math.max(0, Math.floor(offsetMs))))
    try {
      await navigator.clipboard.writeText(url.toString())
      onError("")
    } catch {
      onError("The timestamp link could not be copied.")
    }
  }

  const mergeSpeakers = async () => {
    if (!mergeSourceId || !mergeTargetId || mergeSourceId === mergeTargetId)
      return
    setMergeSaving(true)
    try {
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/merge`,
        { sourceId: mergeSourceId, targetId: mergeTargetId }
      )
      updateSnapshot((current) => ({
        ...current,
        speakers: current.speakers.filter(
          (speaker) => speaker.id !== mergeSourceId
        ),
        segments: current.segments.map((segment) =>
          segment.speakerId === mergeSourceId
            ? { ...segment, speakerId: mergeTargetId }
            : segment
        ),
      }))
      setMergeOpen(false)
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "The speakers could not be merged."
      )
    } finally {
      setMergeSaving(false)
    }
  }

  const polishTranscript = async () => {
    if (!canPolishTranscript || polishProcessing) return
    setPolishGenerating(true)
    updateSnapshot((current) => ({
      ...current,
      session: { ...current.session, polishStatus: "processing" },
    }))
    try {
      const result = await api.post<{
        snapshot: TranscriptWorkspaceSnapshot
      }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/polish`,
        undefined,
        { timeoutMs: 15 * 60 * 1000 }
      )
      updateSnapshot(() => result.snapshot)
      setTranscriptMode("polished")
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "Grammar polish could not be generated."
      )
      updateSnapshot((current) => ({
        ...current,
        session: { ...current.session, polishStatus: "failed" },
      }))
    } finally {
      setPolishGenerating(false)
    }
  }

  const generateInsights = async () => {
    setInsightsGenerating(true)
    updateSnapshot((current) => ({
      ...current,
      insights: {
        ...(current.insights ?? {
          sessionId: current.session.id,
          language: insightLanguage,
          updatedAt: "",
        }),
        sessionId: current.session.id,
        language: insightLanguage,
        status: "processing",
      },
    }))
    try {
      const result = await api.post<{ insights: TranscriptionInsights }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/insights`,
        { language: insightLanguage },
        { timeoutMs: 15 * 60 * 1000 }
      )
      updateSnapshot((current) => ({ ...current, insights: result.insights }))
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "AI insights could not be generated."
      )
      updateSnapshot((current) => ({
        ...current,
        insights: {
          ...(current.insights ?? {
            sessionId: current.session.id,
            language: insightLanguage,
            updatedAt: "",
          }),
          language: insightLanguage,
          status: "failed",
        },
      }))
    } finally {
      setInsightsGenerating(false)
    }
  }

  const exportTranscript = async () => {
    try {
      const includeInsights =
        exportSupportsInsights && includeInsightsInExport && insightsReady
      const exportUrl = `/api/v1/transcription/sessions/${snapshot.session.id}/export/${exportFormat}${includeInsights ? "?includeInsights=true" : ""}`
      const blob = await api.getBlob(exportUrl)
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${snapshot.session.title || "transcript"}.${exportFormat === "markdown" ? "md" : exportFormat}`
      link.click()
      URL.revokeObjectURL(url)
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : "The transcript export failed."
      )
    }
  }

  const workspaceGridClass = cn(
    "grid gap-4",
    workspaceView === "review" ? "xl:items-stretch" : "xl:items-start",
    workspaceView === "details"
      ? "xl:grid-cols-1"
      : "xl:grid-cols-[minmax(0,1.3fr)_minmax(19rem,0.7fr)]"
  )

  return (
    <div className="space-y-3">
      <Tabs
        aria-label="Transcript workspace sections"
        className="min-w-0"
        onValueChange={(value) => {
          if (
            value === "review" ||
            value === "insights" ||
            value === "speakers" ||
            value === "details"
          ) {
            setWorkspaceView(value)
          }
        }}
        value={workspaceView}
      >
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="review">
            Review
            {annotations.length > 0 ? (
              <span className="text-[10px] text-muted-foreground">
                {annotations.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="insights">
            Insights
            {insightsReady ? (
              <Badge className="h-4 px-1.5 text-[9px]" variant="secondary">
                Ready
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="speakers">
            Speakers
            {snapshot.speakers.length > 0 ? (
              <span className="text-[10px] text-muted-foreground">
                {snapshot.speakers.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className={workspaceGridClass}>
        <Card
          className={cn(
            "flex max-h-[min(calc(100dvh-22rem),56rem)] min-h-[28rem] min-w-0 flex-col overflow-hidden shadow-none xl:h-full",
            workspaceView !== "review" && "hidden"
          )}
        >
          <CardHeader className="shrink-0 gap-3 border-b border-border px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  Transcript
                </CardTitle>
                <CardDescription>
                  {transcript.length} messages · {snapshot.segments.length}{" "}
                  segments
                  {preview.length > 0
                    ? ` · ${preview.length} live preview lines`
                    : ""}
                  {transcriptQuery
                    ? ` · ${filteredTranscript.length} matches`
                    : ""}
                </CardDescription>
                {mediaPlaying && !hasActiveFilter ? (
                  <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-primary">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse motion-reduce:animate-none"
                    />
                    Following playback
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Tabs
                  aria-label="Transcript display mode"
                  onValueChange={(value) => {
                    if (
                      value === "verbatim" ||
                      value === "polished" ||
                      value === "edited"
                    ) {
                      setTranscriptMode(value)
                    }
                  }}
                  value={transcriptMode}
                >
                  <TabsList>
                    <TabsTrigger value="verbatim">Verbatim</TabsTrigger>
                    <TabsTrigger disabled={!polishedAvailable} value="polished">
                      Polished
                    </TabsTrigger>
                    <TabsTrigger disabled={!editedAvailable} value="edited">
                      Edited
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {editorOpen ? (
                  <Button
                    onClick={() => setEditorOpen(false)}
                    size="sm"
                    variant="default"
                  >
                    <Pencil data-icon="inline-start" />
                    Done editing
                  </Button>
                ) : null}
                {canPolishTranscript ? (
                  <Button
                    disabled={polishProcessing}
                    onClick={() => void polishTranscript()}
                    size="sm"
                    variant={polishedAvailable ? "outline" : "default"}
                  >
                    {polishProcessing ? (
                      <LoaderCircle
                        className="motion-safe:animate-spin motion-reduce:animate-none"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Sparkles data-icon="inline-start" />
                    )}
                    {polishProcessing
                      ? "Polishing…"
                      : polishedAvailable
                        ? "Re-polish"
                        : "Polish transcript"}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        aria-label="Transcript tools"
                        size="icon-sm"
                        title="Transcript tools"
                        variant="outline"
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem
                      onClick={() => {
                        setWorkspaceView("review")
                        setEditorOpen((current) => !current)
                        setTranscriptMode("edited")
                      }}
                    >
                      <Pencil data-icon="inline-start" />
                      {editorOpen ? "Close editor" : "Edit transcript"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setWorkspaceView("review")
                        setFiltersOpen((current) => !current)
                      }}
                    >
                      <CircleAlert data-icon="inline-start" />
                      {filtersOpen ? "Hide filters" : "Show filters"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setWorkspaceView("review")
                        setExportOpen((current) => !current)
                      }}
                    >
                      <Download data-icon="inline-start" />
                      {exportOpen ? "Hide export" : "Export transcript"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setWorkspaceView("insights")}
                    >
                      <Sparkles data-icon="inline-start" />
                      Open AI insights
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setWorkspaceView("speakers")}
                    >
                      <Users data-icon="inline-start" />
                      Open speaker tools
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setWorkspaceView("details")}
                    >
                      <Clock3 data-icon="inline-start" />
                      Open details
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative max-w-md min-w-48 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search transcript"
                  className="h-9 pl-9"
                  onChange={(event) => setTranscriptQuery(event.target.value)}
                  placeholder="Search transcript"
                  value={transcriptQuery}
                />
              </div>
              {filtersOpen ? (
                <>
                  <Select
                    items={[
                      { value: "all", label: "All speakers" },
                      ...snapshot.speakers.map((speaker) => ({
                        value: speaker.id,
                        label: speakerDisplayName(speaker),
                      })),
                    ]}
                    onValueChange={(value) => setSpeakerFilter(value ?? "all")}
                    value={speakerFilter}
                  >
                    <SelectTrigger
                      aria-label="Filter by speaker"
                      className="h-9 w-40 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All speakers</SelectItem>
                      {snapshot.speakers.map((speaker) => (
                        <SelectItem key={speaker.id} value={speaker.id}>
                          {speakerDisplayName(speaker)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    className="h-9"
                    onClick={() => setQualityOnly((current) => !current)}
                    size="sm"
                    variant={qualityOnly ? "default" : "outline"}
                  >
                    <CircleAlert data-icon="inline-start" /> Review flags
                  </Button>
                </>
              ) : hasActiveFilter ? (
                <Badge className="h-7" variant="outline">
                  Filters active
                </Badge>
              ) : null}
              {filteredTranscript.length > 0 &&
              !editorOpen &&
              hasActiveFilter ? (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Button
                    aria-label="Previous search match"
                    disabled={filteredTranscript.length < 2}
                    onClick={() =>
                      setMatchIndex(
                        (current) =>
                          (current - 1 + filteredTranscript.length) %
                          filteredTranscript.length
                      )
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronLeft />
                  </Button>
                  <span className="min-w-16 text-center tabular-nums">
                    {activeMatchIndex + 1} / {filteredTranscript.length}
                  </span>
                  <Button
                    aria-label="Next search match"
                    disabled={filteredTranscript.length < 2}
                    onClick={() =>
                      setMatchIndex(
                        (current) => (current + 1) % filteredTranscript.length
                      )
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronRight />
                  </Button>
                </div>
              ) : null}
            </div>
            {exportOpen ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/80 bg-muted/20 p-2">
                <span className="mr-1 text-xs font-medium text-foreground">
                  Export transcript
                </span>
                <Select
                  items={[
                    { value: "pdf", label: "PDF" },
                    { value: "docx", label: "Word (.docx)" },
                    { value: "md", label: "Markdown" },
                    { value: "txt", label: "Plain text" },
                    { value: "srt", label: "SubRip (.srt)" },
                    { value: "vtt", label: "WebVTT (.vtt)" },
                    { value: "json", label: "JSON" },
                  ]}
                  onValueChange={(value) => setExportFormat(value ?? "pdf")}
                  value={exportFormat}
                >
                  <SelectTrigger
                    aria-label="Export format"
                    className="h-8 w-32 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pdf">PDF</SelectItem>
                    <SelectItem value="docx">Word (.docx)</SelectItem>
                    <SelectItem value="md">Markdown</SelectItem>
                    <SelectItem value="txt">Plain text</SelectItem>
                    <SelectItem value="srt">SubRip (.srt)</SelectItem>
                    <SelectItem value="vtt">WebVTT (.vtt)</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  aria-label="Export transcript"
                  onClick={() => void exportTranscript()}
                  size="sm"
                  variant="outline"
                >
                  <Download data-icon="inline-start" /> Download
                </Button>
                {exportSupportsInsights ? (
                  <label
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    title={
                      insightsReady
                        ? "Include the generated AI insights"
                        : "Generate AI insights first"
                    }
                  >
                    <Switch
                      aria-label="Include AI insights in export"
                      checked={includeInsightsInExport}
                      disabled={!insightsReady}
                      onCheckedChange={setIncludeInsightsInExport}
                      size="sm"
                    />
                    AI insights
                  </label>
                ) : exportFormat === "json" ? (
                  <span className="text-[11px] text-muted-foreground">
                    Includes insights
                  </span>
                ) : null}
              </div>
            ) : null}
            {editorOpen && selectedSegmentIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2 text-xs">
                <span className="text-muted-foreground">
                  {selectedSegmentIds.length} lines selected
                </span>
                <Select
                  items={snapshot.speakers.map((speaker) => ({
                    value: speaker.id,
                    label: speakerDisplayName(speaker),
                  }))}
                  onValueChange={(value) => setAssignmentSpeakerId(value ?? "")}
                  value={assignmentSpeakerId}
                >
                  <SelectTrigger className="h-8 w-40 text-xs">
                    <SelectValue placeholder="Assign speaker" />
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.speakers.map((speaker) => (
                      <SelectItem key={speaker.id} value={speaker.id}>
                        {speakerDisplayName(speaker)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={!assignmentSpeakerId}
                  onClick={() => void assignSelectedSpeaker()}
                  size="sm"
                >
                  <Users data-icon="inline-start" /> Assign speaker
                </Button>
                <Button
                  onClick={() => setSelectedSegmentIds([])}
                  size="sm"
                  variant="ghost"
                >
                  Clear
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
            {editorOpen ? (
              filteredSegments.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {filteredSegments.map((segment) => {
                    const issues = qualityIssues(segment)
                    const baseText =
                      segment.editedText?.trim() ||
                      segment.text.trim() ||
                      segment.rawText?.trim() ||
                      ""
                    const draft = editDrafts[segment.id] ?? baseText
                    const selected = selectedSegmentIds.includes(segment.id)
                    return (
                      <div
                        className={cn(
                          "rounded-xl border p-3",
                          selected
                            ? "border-primary/40 bg-primary/5"
                            : "border-border"
                        )}
                        key={segment.id}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            aria-label={`Select line at ${formatVideoTimestamp(segment.startOffsetMs)}`}
                            checked={selected}
                            className="size-4 accent-primary"
                            onChange={(event) =>
                              setSelectedSegmentIds((current) =>
                                event.target.checked
                                  ? [...current, segment.id]
                                  : current.filter((id) => id !== segment.id)
                              )
                            }
                            type="checkbox"
                          />
                          <button
                            className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
                            disabled={!canSeek}
                            onClick={() => seekTo(segment.startOffsetMs)}
                            type="button"
                          >
                            {formatVideoTimestamp(segment.startOffsetMs)}
                          </button>
                          {segment.speakerId ? (
                            <Badge variant="outline">
                              {speakerDisplayName(
                                speakerById.get(segment.speakerId)
                              )}
                            </Badge>
                          ) : (
                            <Badge variant="outline">Unassigned</Badge>
                          )}
                          {issues.map((issue) => (
                            <Badge
                              className="text-[10px]"
                              key={issue}
                              variant="destructive"
                            >
                              {issue}
                            </Badge>
                          ))}
                          <Button
                            className="ml-auto"
                            disabled={savingSegmentId === segment.id}
                            onClick={() => void saveSegmentEdit(segment)}
                            size="sm"
                            variant="outline"
                          >
                            {savingSegmentId === segment.id ? (
                              <LoaderCircle
                                className="animate-spin"
                                data-icon="inline-start"
                              />
                            ) : (
                              <Check data-icon="inline-start" />
                            )}{" "}
                            Save
                          </Button>
                        </div>
                        <Textarea
                          className="mt-2 min-h-20 resize-y text-sm leading-6"
                          onChange={(event) =>
                            setEditDrafts((current) => ({
                              ...current,
                              [segment.id]: event.target.value,
                            }))
                          }
                          value={draft}
                        />
                        {(segment.text.trim() ||
                          segment.polishedText?.trim()) && (
                          <details className="mt-2 text-xs text-muted-foreground">
                            <summary className="cursor-pointer select-none">
                              Compare source and polish
                            </summary>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <p>
                                <span className="font-medium text-foreground">
                                  Verbatim:
                                </span>{" "}
                                {segment.text.trim() || segment.rawText?.trim()}
                              </p>
                              <p>
                                <span className="font-medium text-foreground">
                                  Polished:
                                </span>{" "}
                                {segment.polishedText?.trim() ||
                                  "Not available"}
                              </p>
                            </div>
                          </details>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <Empty className="min-h-48 border-0 p-4">
                  <EmptyHeader>
                    <EmptyTitle>No lines need review</EmptyTitle>
                    <EmptyDescription>
                      Try clearing a filter or turn off Review flags.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            ) : filteredTranscript.length > 0 ? (
              <div className="flex flex-col gap-1">
                {filteredTranscript.map((message) => {
                  const active = message.id === activeMessageId
                  const speaker = speakerById.get(message.speakerKey)
                  const issues = message.segmentIds
                    .flatMap((id) =>
                      qualityIssues(
                        displaySegmentById.get(id) ??
                          ({ text: "" } as TranscriptionSegment)
                      )
                    )
                    .filter(
                      (issue, index, list) => list.indexOf(issue) === index
                    )
                  const firstSegment = displaySegmentById.get(
                    message.segmentIds[0]
                  )
                  const messageSegments = message.segmentIds
                    .map((segmentId) => displaySegmentById.get(segmentId))
                    .filter((segment): segment is TranscriptionSegment =>
                      Boolean(segment)
                    )
                  return (
                    <div
                      className={cn(
                        "group grid w-full grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg px-2.5 py-3 text-left transition-colors",
                        active
                          ? "bg-primary/10 ring-1 ring-primary/30"
                          : "hover:bg-muted/50"
                      )}
                      key={message.id}
                      ref={(element) => {
                        if (element)
                          messageRefs.current.set(message.id, element)
                        else messageRefs.current.delete(message.id)
                      }}
                    >
                      <button
                        aria-current={active ? "true" : undefined}
                        aria-label={`Jump to ${formatVideoTimestamp(message.startOffsetMs)}`}
                        disabled={!canSeek}
                        className={cn(
                          "flex h-fit items-start gap-1 rounded-sm pt-0.5 text-left font-mono text-[11px] tabular-nums",
                          active ? "text-primary" : "text-muted-foreground"
                        )}
                        onClick={() => seekTo(message.startOffsetMs)}
                        type="button"
                      >
                        {active ? (
                          <Play
                            aria-hidden="true"
                            className="mt-0.5 size-3 fill-current"
                          />
                        ) : null}
                        {formatVideoTimestamp(message.startOffsetMs)}
                      </button>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {speaker ? (
                            <Button
                              aria-label={`Rename ${speakerDisplayName(speaker)}`}
                              className="group/speaker-name h-auto max-w-full justify-start p-0 hover:bg-transparent"
                              onClick={() => onRenameSpeaker(speaker)}
                              size="sm"
                              title="Rename speaker"
                              variant="ghost"
                            >
                              <Badge
                                className="max-w-full truncate"
                                variant="outline"
                              >
                                {speakerDisplayName(speaker)}
                              </Badge>
                              <Pencil
                                aria-hidden="true"
                                className="text-muted-foreground transition-colors group-hover/speaker-name:text-foreground"
                                data-icon="inline-end"
                              />
                            </Button>
                          ) : null}
                          {issues.map((issue) => (
                            <Badge
                              className="text-[10px]"
                              key={issue}
                              variant="destructive"
                            >
                              {issue}
                            </Badge>
                          ))}
                          <div className="ml-auto flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                            <Button
                              aria-label="Add bookmark"
                              onClick={() => {
                                setAnnotationKind("bookmark")
                                setAnnotationNote("")
                                setAnnotationTarget({
                                  segmentId:
                                    firstSegment?.id ?? message.segmentIds[0],
                                  startOffsetMs: message.startOffsetMs,
                                  endOffsetMs: message.endOffsetMs,
                                })
                              }}
                              size="icon-sm"
                              title="Add bookmark"
                              variant="ghost"
                            >
                              <Bookmark />
                            </Button>
                            <Button
                              aria-label="Add comment"
                              onClick={() => {
                                setAnnotationKind("comment")
                                setAnnotationNote("")
                                setAnnotationTarget({
                                  segmentId:
                                    firstSegment?.id ?? message.segmentIds[0],
                                  startOffsetMs: message.startOffsetMs,
                                  endOffsetMs: message.endOffsetMs,
                                })
                              }}
                              size="icon-sm"
                              title="Add comment"
                              variant="ghost"
                            >
                              <MessageSquarePlus />
                            </Button>
                          </div>
                        </div>
                        <button
                          className="block min-w-0 text-left text-sm leading-6 text-foreground"
                          disabled={!canSeek}
                          onClick={() => seekTo(message.startOffsetMs)}
                          type="button"
                        >
                          {highlightActiveTranscriptSegment(
                            message.text,
                            messageSegments,
                            activeMessageId === message.id
                              ? activeSegmentId
                              : null,
                            transcriptQuery
                          )}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : transcript.length > 0 && transcriptQuery ? (
              <Empty className="min-h-48 border-0 p-4">
                <EmptyHeader>
                  <EmptyTitle>No matching lines</EmptyTitle>
                  <EmptyDescription>
                    Try another word or clear the transcript search.
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  onClick={() => setTranscriptQuery("")}
                  size="sm"
                  variant="outline"
                >
                  Clear search
                </Button>
              </Empty>
            ) : preview.length > 0 ? (
              <LiveTranscriptPreview segments={preview} />
            ) : isVideoProcessing ? (
              <Empty className="min-h-48 border-0 p-4">
                <EmptyHeader>
                  <EmptyTitle>Waiting for the first slice</EmptyTitle>
                  <EmptyDescription>
                    Workers are transcribing in parallel. Preview lines will
                    appear as output arrives.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Empty className="min-h-48 border-0 p-4">
                <EmptyHeader>
                  <EmptyTitle>No transcript yet</EmptyTitle>
                  <EmptyDescription>
                    The transcript will appear here after video processing
                    starts.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <div
          className={cn(
            workspaceView === "review"
              ? "flex min-h-0 flex-col gap-4 xl:h-full"
              : "contents"
          )}
        >
          <Card
            className={cn(
              "min-h-0 flex-1 shadow-none",
              workspaceView !== "review" && "hidden",
              workspaceView === "review" && "order-last"
            )}
          >
            <CardHeader className="gap-1 px-4 py-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Bookmark className="size-4 text-primary" /> Bookmarks &
                comments
              </CardTitle>
              <CardDescription>
                Keep review notes attached to exact transcript moments.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col px-4 pb-4">
              {annotations.length > 0 ? (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {annotations.map((annotation) => (
                    <div
                      className="rounded-lg border border-border/80 p-2.5"
                      key={annotation.id}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          className="font-mono text-[11px] text-primary hover:underline"
                          disabled={!canSeek}
                          onClick={() => seekTo(annotation.startOffsetMs)}
                          type="button"
                        >
                          {formatVideoTimestamp(annotation.startOffsetMs)}
                        </button>
                        <Badge variant="outline">
                          {annotation.kind === "bookmark"
                            ? "Bookmark"
                            : "Comment"}
                        </Badge>
                        <Button
                          className="ml-auto"
                          onClick={() => void deleteAnnotation(annotation)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      {annotation.note ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {annotation.note}
                        </p>
                      ) : null}
                      <Button
                        className="mt-2 h-7 text-[11px]"
                        onClick={() =>
                          void copyTimestampLink(annotation.startOffsetMs)
                        }
                        size="sm"
                        variant="ghost"
                      >
                        <Copy data-icon="inline-start" /> Copy timestamp link
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Bookmark a line or add a comment while reviewing.
                </p>
              )}
            </CardContent>
          </Card>

          <Card
            className={cn(
              "shrink-0 shadow-none",
              workspaceView !== "insights" && "hidden"
            )}
          >
            <CardHeader className="gap-1 px-4 py-4">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Sparkles className="size-4 text-primary" /> AI insights
                </CardTitle>
                <Button
                  disabled={insightsProcessing || !snapshot.segments.length}
                  onClick={() => void generateInsights()}
                  size="sm"
                  variant="outline"
                >
                  {insightsProcessing ? (
                    <LoaderCircle
                      className="motion-safe:animate-spin motion-reduce:animate-none"
                      data-icon="inline-start"
                    />
                  ) : (
                    <Sparkles data-icon="inline-start" />
                  )}{" "}
                  {insightsProcessing
                    ? "Writing…"
                    : insights.status === "completed"
                      ? "Regenerate"
                      : "Generate"}
                </Button>
              </div>
              <CardDescription>
                Summary, chapters, topics, and action items from the transcript.
              </CardDescription>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <span className="text-xs text-muted-foreground">
                  Output language
                </span>
                <Select
                  disabled={insightsProcessing}
                  items={insightLanguageOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onValueChange={(value) => setInsightLanguage(value ?? "auto")}
                  value={insightLanguage}
                >
                  <SelectTrigger
                    aria-label="AI insight output language"
                    className="h-7 min-w-48 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {insightLanguageOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {insights.status === "completed" &&
                insights.language !== insightLanguage ? (
                  <span className="text-xs text-muted-foreground">
                    Regenerate to apply
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-4 pb-4 text-xs">
              {insightsProcessing ? <AiWritingIndicator /> : null}
              {insights.error ? (
                <p className="text-destructive">{insights.error}</p>
              ) : null}
              {insights.summary ? (
                <p className="leading-5 text-muted-foreground">
                  {insights.summary}
                </p>
              ) : null}
              {hiddenInsightChapterCount > 0 ? (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {hiddenInsightChapterCount} chapter timestamp
                    {hiddenInsightChapterCount === 1 ? " was" : "s were"} hidden
                    because it fell outside the video duration.
                  </span>
                </p>
              ) : null}
              {validInsightChapters.length > 0 ? (
                <div>
                  <p className="mb-1 font-medium text-foreground">Chapters</p>
                  <div className="space-y-1">
                    {validInsightChapters.map((chapter) => (
                        <button
                          className="flex w-full items-start gap-2 rounded-md p-1 text-left hover:bg-muted"
                          disabled={!canSeek}
                          key={`${chapter.startOffsetMs}-${chapter.title}`}
                        onClick={() => seekTo(chapter.startOffsetMs)}
                        type="button"
                      >
                        <span className="font-mono text-primary">
                          {formatVideoTimestamp(chapter.startOffsetMs)}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium text-foreground">
                            {chapter.title}
                          </span>
                          {chapter.summary ? (
                            <span className="block text-muted-foreground">
                              {chapter.summary}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {(insights.topics?.length ?? 0) > 0 ? (
                <div>
                  <p className="mb-1 font-medium text-foreground">Topics</p>
                  <div className="flex flex-wrap gap-1">
                    {insights.topics?.map((topic) => (
                      <Badge key={topic} variant="secondary">
                        {topic}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {(insights.actionItems?.length ?? 0) > 0 ? (
                <div>
                  <p className="mb-1 font-medium text-foreground">
                    Action items
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                    {insights.actionItems?.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {insights.status === "idle" ? (
                <p className="text-muted-foreground">
                  Generate insights when the transcript is ready.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {speakerSummaries.length > 0 ? (
            <Card
              className={cn(
                "shrink-0 shadow-none",
                workspaceView !== "speakers" && "hidden"
              )}
            >
              <CardHeader className="gap-1 px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Users className="size-4 text-primary" /> Speaker summary
                  </CardTitle>
                  <Button
                    onClick={() => {
                      setMergeSourceId("")
                      setMergeTargetId("")
                      setMergeOpen(true)
                    }}
                    size="icon-sm"
                    title="Merge speakers"
                    variant="outline"
                  >
                    <GitMerge />
                  </Button>
                </div>
                <CardDescription>
                  Rename speakers, play samples, or merge duplicate labels.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 px-4 pb-4">
                <div className="max-h-72 min-h-0 space-y-2 overflow-y-auto pr-1">
                  {speakerSummaries.map((summary) => {
                    const name = speakerDisplayName(summary.speaker)
                    const playing =
                      speakerSample?.speakerId === summary.speaker.id
                    const canPlay =
                      canSeek &&
                      summary.sampleStartMs !== null &&
                      summary.sampleEndMs !== null
                    return (
                      <div
                        className="rounded-xl border border-border/80 bg-muted/20 p-3"
                        key={summary.speaker.id}
                      >
                        <div className="flex min-w-0 items-start gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                            {speakerInitials(name)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                                {name}
                              </span>
                              <Badge
                                className="shrink-0 text-[9px]"
                                variant="outline"
                              >
                                {summary.speaker.label}
                              </Badge>
                            </div>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {summary.segmentCount}{" "}
                              {summary.segmentCount === 1
                                ? "segment"
                                : "segments"}{" "}
                              · {formatVideoDuration(summary.speakingMs)}{" "}
                              speaking
                            </p>
                            {summary.sampleText ? (
                              <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                                “{summary.sampleText}”
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              aria-label={
                                playing
                                  ? `Stop sample for ${name}`
                                  : `Play sample for ${name}`
                              }
                              disabled={!canPlay}
                              onClick={() => playSpeakerSample(summary)}
                              size="icon-sm"
                              variant={playing ? "default" : "outline"}
                            >
                              {playing ? <Pause /> : <Play />}
                            </Button>
                            <Button
                              aria-label={`Rename ${name}`}
                              onClick={() => onRenameSpeaker(summary.speaker)}
                              size="icon-sm"
                              variant="ghost"
                            >
                              <Pencil />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Speaker assignment changes are preserved separately from the
                  original transcript text.
                </p>
              </CardContent>
            </Card>
          ) : workspaceView === "speakers" ? (
            <Card className="shrink-0 shadow-none">
              <CardHeader className="gap-1 px-4 py-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users className="size-4 text-primary" /> Speaker tools
                </CardTitle>
                <CardDescription>
                  Speaker separation has not produced any labels for this
                  transcript.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4 text-xs text-muted-foreground">
                You can still review, edit, and export the transcript without
                speaker assignments.
              </CardContent>
            </Card>
          ) : null}

          <Card
            className={cn(
              "shrink-0 shadow-none xl:sticky xl:top-4",
              workspaceView === "details" && "hidden",
              workspaceView === "review" && "order-first"
            )}
          >
            <CardHeader className="gap-2 px-4 py-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                {mediaKind === "video" ? (
                  <FileVideo className="size-4" />
                ) : mediaKind === "audio" ? (
                  <FileAudio className="size-4" />
                ) : (
                  <FileText className="size-4" />
                )} {mediaKind === "video"
                  ? "Source video"
                  : mediaKind === "audio"
                    ? "Source audio"
                    : "Transcript only"}
              </CardTitle>
              <CardDescription className="truncate">
                {mediaKind === "video"
                  ? snapshot.videoUpload?.fileName ?? "Video upload"
                  : mediaKind === "audio"
                    ? selectedRecording
                      ? "Recorded source audio"
                      : "No recording attached"
                    : "No source media attached"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4 pb-4">
              {mediaKind === "video" ? (
                <>
                  <div className="overflow-hidden rounded-xl border border-border bg-muted">
                    {snapshot.videoUpload?.playbackUrl ? (
                      <video
                        className="block aspect-video w-full bg-muted object-contain"
                        controls
                        onError={() => {
                          setMediaPlaying(false)
                          setSpeakerSample(null)
                          onVideoPlaybackError(
                            "The video link expired or the stored video is unavailable."
                          )
                        }}
                        onLoadedMetadata={(event) => {
                          if (Number.isFinite(event.currentTarget.duration))
                            onVideoDurationChange(
                              Math.round(event.currentTarget.duration * 1000)
                            )
                        }}
                        onEnded={() => {
                          setMediaPlaying(false)
                          setSpeakerSample(null)
                        }}
                        onPause={() => setMediaPlaying(false)}
                        onPlay={() => setMediaPlaying(true)}
                        onTimeUpdate={(event) => {
                          const current = Math.round(
                            event.currentTarget.currentTime * 1000
                          )
                          onCurrentTimeChange(current)
                          if (
                            speakerSample &&
                            current >= speakerSample.endOffsetMs
                          ) {
                            event.currentTarget.pause()
                            setSpeakerSample(null)
                          }
                        }}
                        playsInline
                        preload="metadata"
                        ref={videoRef}
                        src={snapshot.videoUpload.playbackUrl}
                      />
                    ) : (
                      <div className="flex aspect-video flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                        <FileVideo aria-hidden="true" />
                        <p className="text-xs">
                          The video will be available here once the upload has
                          finished.
                        </p>
                      </div>
                    )}
                  </div>
                  {snapshot.videoUpload?.playbackUrl ? (
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Clock3 className="size-3.5" />
                        {formatVideoTimestamp(currentTimeMs)}
                        {displayDurationMs
                          ? ` / ${formatVideoTimestamp(displayDurationMs)}`
                          : ""}
                      </span>
                      <span>Click a transcript line to seek</span>
                    </div>
                  ) : null}
                  {videoPlaybackError ? (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                      <p className="font-medium">Playback unavailable</p>
                      <p className="mt-1">{videoPlaybackError}</p>
                      <Button
                        className="mt-2"
                        onClick={() => void onRefreshPlayback()}
                        size="sm"
                        variant="outline"
                      >
                        <RefreshCw data-icon="inline-start" /> Refresh link
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : mediaKind === "audio" ? (
                <>
                  {recordings.length > 1 ? (
                    <Select
                      items={recordings.map((recording, index) => ({
                        value: recording.id,
                        label: `Source ${index + 1}`,
                      }))}
                      onValueChange={(value) =>
                        setSelectedRecordingId(value ?? "")
                      }
                      value={selectedRecordingId}
                    >
                      <SelectTrigger aria-label="Select source recording">
                        <SelectValue placeholder="Select recording" />
                      </SelectTrigger>
                      <SelectContent>
                        {recordings.map((recording, index) => (
                          <SelectItem key={recording.id} value={recording.id}>
                            Source {index + 1}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div className="rounded-xl border border-border bg-muted/40 p-3">
                    {audioSourceURL ? (
                      <audio
                        className="w-full"
                        controls
                        onEnded={() => {
                          setMediaPlaying(false)
                          setSpeakerSample(null)
                        }}
                        onError={() => {
                          setMediaPlaying(false)
                          setSpeakerSample(null)
                          setAudioSource((current) =>
                            current?.recordingId === effectiveRecordingId
                              ? {
                                  ...current,
                                  url: "",
                                  error:
                                    "The source recording could not be decoded.",
                                }
                              : current
                          )
                        }}
                        onLoadedMetadata={(event) => {
                          if (Number.isFinite(event.currentTarget.duration))
                            setAudioDurationMs(
                              Math.round(event.currentTarget.duration * 1000)
                            )
                        }}
                        onPause={() => setMediaPlaying(false)}
                        onPlay={() => setMediaPlaying(true)}
                        onTimeUpdate={(event) => {
                          const current = Math.round(
                            event.currentTarget.currentTime * 1000
                          )
                          onCurrentTimeChange(current)
                          if (
                            speakerSample &&
                            current >= speakerSample.endOffsetMs
                          ) {
                            event.currentTarget.pause()
                            setSpeakerSample(null)
                          }
                        }}
                        preload="metadata"
                        ref={audioRef}
                        src={audioSourceURL}
                      />
                    ) : (
                      <div className="flex min-h-20 items-center justify-center text-center text-xs text-muted-foreground">
                        {audioPlaybackError ||
                          (selectedRecording
                            ? "Loading the recording…"
                            : "Record source audio to enable playback.")}
                      </div>
                    )}
                  </div>
                  {audioSourceURL ? (
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Clock3 className="size-3.5" />
                        {formatVideoTimestamp(currentTimeMs)}
                        {displayDurationMs
                          ? ` / ${formatVideoTimestamp(displayDurationMs)}`
                          : ""}
                      </span>
                      <span>Click a transcript line to seek</span>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex min-h-20 items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 text-xs text-muted-foreground">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  <p>
                    This session has no recording. The transcript remains
                    fully editable and exportable.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card
            className={cn(
              "shrink-0 shadow-none",
              workspaceView !== "details" && "hidden"
            )}
          >
            <CardHeader className="gap-1 px-4 py-4">
              <CardTitle className="text-sm">At a glance</CardTitle>
              <CardDescription>
                Transcript settings and coverage
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 px-4 pb-4 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span>Language</span>
                <span className="font-medium text-foreground">
                  {snapshot.session.language}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Messages</span>
                <span className="font-medium text-foreground">
                  {transcript.length}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <Users className="size-3.5" /> Speakers
                </span>
                <span className="font-medium text-foreground">
                  {snapshot.speakers.length || "Not separated"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Grammar</span>
                <span className="font-medium text-foreground">
                  {snapshot.session.polishStatus === "completed"
                    ? "Available"
                    : snapshot.session.polishStatus === "failed"
                      ? "Failed"
                      : snapshot.session.polishStatus === "processing"
                        ? "Processing"
                        : "Not requested"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <Clock3 className="size-3.5" /> Duration
                </span>
                <span className="font-medium text-foreground tabular-nums">
                  {displayDurationMs
                    ? formatVideoDuration(displayDurationMs)
                    : "—"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={Boolean(annotationTarget)}
        onOpenChange={(open) => {
          if (!open && !annotationSaving) setAnnotationTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {annotationKind === "bookmark" ? "Add bookmark" : "Add comment"}
            </DialogTitle>
            <DialogDescription>
              This note stays linked to{" "}
              {annotationTarget
                ? formatVideoTimestamp(annotationTarget.startOffsetMs)
                : "the selected moment"}{" "}
              in the {mediaKind === "video" ? "video" : "transcript"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select
              items={[
                { value: "comment", label: "Comment" },
                { value: "bookmark", label: "Bookmark" },
              ]}
              onValueChange={(value) =>
                setAnnotationKind(
                  (value as "bookmark" | "comment") ?? "comment"
                )
              }
              value={annotationKind}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comment">Comment</SelectItem>
                <SelectItem value="bookmark">Bookmark</SelectItem>
              </SelectContent>
            </Select>
            <Textarea
              autoFocus={annotationKind === "comment"}
              onChange={(event) => setAnnotationNote(event.target.value)}
              placeholder={
                annotationKind === "bookmark"
                  ? "Optional note"
                  : "What should be reviewed here?"
              }
              value={annotationNote}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={annotationSaving}
              onClick={() => setAnnotationTarget(null)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                annotationSaving ||
                (annotationKind === "comment" && !annotationNote.trim())
              }
              onClick={() => void createAnnotation()}
            >
              {annotationSaving ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <Bookmark data-icon="inline-start" />
              )}{" "}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mergeOpen}
        onOpenChange={(open) => {
          if (!open && !mergeSaving) setMergeOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Merge speakers</DialogTitle>
            <DialogDescription>
              All lines assigned to the source speaker will be moved to the
              target. Their transcript text is unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium">Merge this speaker</p>
              <Select
                items={snapshot.speakers
                  .filter((speaker) => speaker.id !== mergeTargetId)
                  .map((speaker) => ({
                    value: speaker.id,
                    label: speakerDisplayName(speaker),
                  }))}
                onValueChange={(value) => setMergeSourceId(value ?? "")}
                value={mergeSourceId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.speakers
                    .filter((speaker) => speaker.id !== mergeTargetId)
                    .map((speaker) => (
                      <SelectItem key={speaker.id} value={speaker.id}>
                        {speakerDisplayName(speaker)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium">Keep this speaker</p>
              <Select
                items={snapshot.speakers
                  .filter((speaker) => speaker.id !== mergeSourceId)
                  .map((speaker) => ({
                    value: speaker.id,
                    label: speakerDisplayName(speaker),
                  }))}
                onValueChange={(value) => setMergeTargetId(value ?? "")}
                value={mergeTargetId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Target" />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.speakers
                    .filter((speaker) => speaker.id !== mergeSourceId)
                    .map((speaker) => (
                      <SelectItem key={speaker.id} value={speaker.id}>
                        {speakerDisplayName(speaker)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={mergeSaving}
              onClick={() => setMergeOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                mergeSaving ||
                !mergeSourceId ||
                !mergeTargetId ||
                mergeSourceId === mergeTargetId
              }
              onClick={() => void mergeSpeakers()}
            >
              {mergeSaving ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <GitMerge data-icon="inline-start" />
              )}{" "}
              Merge speakers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function VideoTranscriptWorkspace(
  props: VideoTranscriptWorkspaceProps
) {
  return <TranscriptWorkspace {...props} mediaKind="video" />
}

function AiWritingIndicator() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="animate-in rounded-xl border border-primary/20 bg-primary/5 p-3 duration-200 ease-out fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
      role="status"
    >
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border border-primary/30 motion-safe:animate-ping motion-reduce:animate-none"
          />
          <Sparkles aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            Writing AI insights
            <span
              aria-hidden="true"
              className="inline-block w-5 text-primary motion-safe:animate-pulse motion-reduce:animate-none"
            >
              …
            </span>
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            Reading the full transcript and organizing the key moments.
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="mt-3 space-y-1.5">
        <span
          className="block h-1.5 w-[84%] rounded-full bg-primary/20 motion-safe:animate-pulse motion-reduce:animate-none"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="block h-1.5 w-[62%] rounded-full bg-primary/15 motion-safe:animate-pulse motion-reduce:animate-none"
          style={{ animationDelay: "120ms" }}
        />
        <span
          className="block h-1.5 w-[72%] rounded-full bg-primary/15 motion-safe:animate-pulse motion-reduce:animate-none"
          style={{ animationDelay: "240ms" }}
        />
      </div>
    </div>
  )
}

function LiveTranscriptPreview({
  segments,
}: {
  segments: TranscriptionVideoPreviewSegment[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        Live preview · lines may be refined when overlapping slices are fused.
      </div>
      {segments.map((segment) => (
        <div
          className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg border border-border/70 px-2.5 py-3"
          key={`${segment.startOffsetMs}-${segment.endOffsetMs}-${segment.text}`}
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatVideoTimestamp(segment.startOffsetMs)}
          </span>
          <span className="text-sm leading-6">{segment.text}</span>
        </div>
      ))}
    </div>
  )
}
