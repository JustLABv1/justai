"use client"

import {
  AudioLines,
  Check,
  ChevronDown,
  Clock3,
  CircleAlert,
  CircleDashed,
  FileText,
  FileVideo,
  GitMerge,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  SkipForward,
  Sparkles,
  Upload,
  Users,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { groupTranscriptionSegments } from "@/lib/transcription"
import { cn } from "@/lib/utils"
import { VideoTranscriptWorkspace } from "@/components/video-transcript-workspace"
import type {
  Endpoint,
  TranscriptionAnnotation,
  TranscriptionInsights,
  TranscriptionSegment,
  TranscriptionSpeaker,
  TranscriptionSession,
  TranscriptionVideoPreviewSegment,
  TranscriptionVideoParallelProgress,
  TranscriptionVideoPipelineStep,
  TranscriptionVideoUpload,
  TranscriptionVideoWorkerStatus,
  User,
} from "@/lib/types"

type VideoSnapshot = {
  session: TranscriptionSession
  segments: TranscriptionSegment[]
  speakers: TranscriptionSpeaker[]
  annotations?: TranscriptionAnnotation[]
  insights?: TranscriptionInsights
  videoUpload?: TranscriptionVideoUpload | null
}

type VideoSessionResponse = VideoSnapshot & {
  sources?: unknown[]
  recordings?: unknown[]
}

type VideoSpeakerSummary = {
  speaker: TranscriptionSpeaker
  segmentCount: number
  speakingMs: number
  sampleStartMs: number | null
  sampleEndMs: number | null
  sampleText: string
}

export function VideoTranscriptionView({
  sessionId,
  endpoints,
  user,
  onSessionCreated,
  onSessionsChanged,
  createSessionRequested = false,
  onCreateSessionRequestHandled,
}: {
  sessionId: string | null
  endpoints: Endpoint[]
  user: User
  onSessionCreated: (session: TranscriptionSession) => void
  onSessionsChanged: () => void
  createSessionRequested?: boolean
  onCreateSessionRequestHandled?: () => void
}) {
  const [snapshotState, setSnapshot] = useState<VideoSnapshot | null>(null)
  // The rendered workspace is guarded below; this non-null view keeps the
  // legacy branch type-safe while it is retained as a migration reference.
  const snapshot = snapshotState as VideoSnapshot & {
    videoUpload: TranscriptionVideoUpload
  }
  const [error, setError] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState("Video transcript")
  const [language, setLanguage] = useState("auto")
  const [selectedEndpoint, setSelectedEndpoint] = useState("")
  const [selectedDiarizationEndpoint, setSelectedDiarizationEndpoint] =
    useState("none")
  const [grammarChoice, setGrammarChoice] = useState("auto")
  const [transcriptMode, setTranscriptMode] = useState<"verbatim" | "polished">(
    "verbatim"
  )
  const [transcriptQuery, setTranscriptQuery] = useState("")
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [videoDurationMs, setVideoDurationMs] = useState(0)
  const [videoPlaybackError, setVideoPlaybackError] = useState("")
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoStarting, setVideoStarting] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [skipSpeakerOpen, setSkipSpeakerOpen] = useState(false)
  const [skipSpeakerInFlight, setSkipSpeakerInFlight] = useState(false)
  const [speakerToRename, setSpeakerToRename] =
    useState<TranscriptionSpeaker | null>(null)
  const [speakerName, setSpeakerName] = useState("")
  const [speakerRenameSaving, setSpeakerRenameSaving] = useState(false)
  const [speakerSample, setSpeakerSample] = useState<{
    speakerId: string
    endOffsetMs: number
  } | null>(null)
  const [transcriptRailHeight, setTranscriptRailHeight] = useState<
    number | null
  >(null)
  const requestRef = useRef(0)
  const videoUploadAbortRef = useRef<AbortController | null>(null)
  const videoUploadInFlightRef = useRef(false)
  const videoUploadRef = useRef<TranscriptionVideoUpload | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const transcriptRailRef = useRef<HTMLElement | null>(null)

  const transcriptionEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled && endpointSupportsTranscription(endpoint)
      ),
    [endpoints]
  )
  const effectiveSelectedEndpoint =
    selectedEndpoint ||
    transcriptionEndpoints.find((endpoint) => endpoint.isDefault)?.id ||
    transcriptionEndpoints[0]?.id ||
    ""
  const diarizationEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled &&
          endpointSupportsCapability(endpoint, "diarization")
      ),
    [endpoints]
  )
  const effectiveDiarizationEndpoint =
    selectedDiarizationEndpoint === "none" ? "" : selectedDiarizationEndpoint
  const grammarEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled && endpointSupportsCapability(endpoint, "chat")
      ),
    [endpoints]
  )
  const effectiveGrammarEndpoint =
    grammarChoice === "none"
      ? ""
      : grammarChoice === "auto"
        ? grammarEndpoints.find((endpoint) => endpoint.isDefault)?.id ||
          grammarEndpoints[0]?.id ||
          ""
        : grammarChoice

  const loadSession = useCallback(async (id: string) => {
    const requestId = ++requestRef.current
    try {
      const result = await api.get<VideoSessionResponse>(
        `/api/v1/transcription/sessions/${id}`
      )
      if (requestRef.current !== requestId) return
      setSnapshot({
        session: { ...result.session, kind: "video" },
        segments: result.segments ?? [],
        speakers: result.speakers ?? [],
        annotations: result.annotations ?? [],
        insights: result.insights,
        videoUpload: result.videoUpload ?? null,
      })
      setError("")
    } catch (caught) {
      if (requestRef.current !== requestId) return
      setError(
        caught instanceof Error
          ? caught.message
          : "The video transcription could not be loaded."
      )
    }
  }, [])

  useEffect(() => {
    if (!sessionId) {
      queueMicrotask(() => {
        setSnapshot(null)
        setError("")
        setCreateOpen(false)
      })
      return
    }
    queueMicrotask(() => void loadSession(sessionId))
    return () => {
      requestRef.current += 1
    }
  }, [loadSession, sessionId])

  useEffect(() => {
    videoUploadRef.current = snapshot?.videoUpload ?? null
  }, [snapshot?.videoUpload])

  useEffect(() => {
    const upload = videoUploadRef.current
    if (
      !upload ||
      !["uploading", "queued", "processing"].includes(upload.status)
    )
      return
    let cancelled = false
    const poll = async () => {
      try {
        const result = await api.get<VideoSessionResponse>(
          `/api/v1/transcription/sessions/${upload.sessionId}`
        )
        if (cancelled) return
        setSnapshot((current) => ({
          ...(current ?? {
            session: { ...result.session, kind: "video" },
            segments: [],
            speakers: [],
          }),
          session: { ...result.session, kind: "video" },
          segments: result.segments ?? [],
          speakers: result.speakers ?? [],
          annotations: result.annotations ?? current?.annotations ?? [],
          insights: result.insights ?? current?.insights,
          videoUpload: mergeVideoUploadSnapshot(
            current?.videoUpload ?? upload,
            result.videoUpload
          ),
        }))
        const nextStatus = result.videoUpload?.status
        if (
          nextStatus &&
          ["completed", "failed", "cancelled"].includes(nextStatus)
        ) {
          onSessionsChanged()
        }
      } catch {
        // Polling is a recovery path; keep the last useful progress state.
      }
    }
    const timer = window.setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    onSessionsChanged,
    snapshot?.videoUpload?.id,
    snapshot?.videoUpload?.status,
  ])

  useEffect(() => {
    if (!createSessionRequested || sessionId) return
    queueMicrotask(() => {
      setCreateOpen(true)
      onCreateSessionRequestHandled?.()
    })
  }, [createSessionRequested, onCreateSessionRequestHandled, sessionId])

  useEffect(() => {
    queueMicrotask(() => {
      setTranscriptQuery("")
      setCurrentTimeMs(0)
      setVideoDurationMs(0)
      setVideoPlaybackError("")
      setSpeakerToRename(null)
      setSpeakerName("")
      setSpeakerSample(null)
    })
  }, [sessionId])

  const uploadVideoParts = async (
    file: File,
    upload: TranscriptionVideoUpload,
    partUrls: { partNumber: number; url: string }[]
  ) => {
    const abortController = new AbortController()
    videoUploadAbortRef.current = abortController
    const parts: { partNumber: number; etag: string }[] = []
    try {
      for (const part of partUrls) {
        if (abortController.signal.aborted) throw new Error("Upload cancelled.")
        const start = (part.partNumber - 1) * upload.partSize
        const end = Math.min(file.size, start + upload.partSize)
        let response: Response | null = null
        let lastError: Error | null = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            response = await fetch(part.url, {
              method: "PUT",
              body: file.slice(start, end),
              signal: abortController.signal,
            })
            if (response.ok) break
            lastError = new Error(
              `Storage rejected upload part ${part.partNumber} (${response.status}).`
            )
          } catch (caught) {
            if (abortController.signal.aborted) throw caught
            lastError =
              caught instanceof Error
                ? caught
                : new Error("Video upload failed.")
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, 500 * (attempt + 1))
          )
        }
        if (!response?.ok) throw lastError ?? new Error("Video upload failed.")
        const etag = response.headers.get("ETag")
        if (!etag) {
          throw new Error(
            "Storage did not expose the uploaded part ETag. Configure S3 CORS to expose the ETag header."
          )
        }
        parts.push({ partNumber: part.partNumber, etag })
        setSnapshot((current) =>
          current?.videoUpload?.id === upload.id
            ? {
                ...current,
                videoUpload: {
                  ...current.videoUpload,
                  progress: Math.round((parts.length / partUrls.length) * 100),
                  stage: "uploading",
                },
              }
            : current
        )
      }
      return parts
    } finally {
      if (videoUploadAbortRef.current === abortController) {
        videoUploadAbortRef.current = null
      }
    }
  }

  const createVideoSession = async () => {
    const file = videoFile
    if (!file) {
      setError("Choose a video file first.")
      return
    }
    videoUploadInFlightRef.current = true
    setVideoStarting(true)
    setError("")
    try {
      const result = await api.post<{
        session: TranscriptionSession
        joinCode: string
        expiresAt: string
      }>("/api/v1/transcription/sessions", {
        kind: "video",
        title: title.trim() || "Video transcript",
        language,
        recordAudio: false,
        transcriptionEndpointId: effectiveSelectedEndpoint,
        diarizationEndpointId: effectiveDiarizationEndpoint || undefined,
        grammarEndpointId: effectiveGrammarEndpoint || undefined,
      })
      const createdSession: TranscriptionSession = {
        ...result.session,
        kind: "video",
      }
      const initialized = await api.post<{
        upload: TranscriptionVideoUpload
        partUrls: { partNumber: number; url: string }[]
      }>(`/api/v1/transcription/sessions/${createdSession.id}/video-uploads`, {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileBytes: file.size,
      })
      setSnapshot({
        session: createdSession,
        segments: [],
        speakers: [],
        videoUpload: initialized.upload,
      })
      setCreateOpen(false)
      onSessionCreated(createdSession)
      const parts = await uploadVideoParts(
        file,
        initialized.upload,
        initialized.partUrls
      )
      const completed = await api.post<{
        upload: TranscriptionVideoUpload
        jobId?: string
      }>(
        `/api/v1/transcription/video-uploads/${initialized.upload.id}/complete`,
        {
          parts,
        }
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: { ...current.session, status: "processing" },
              videoUpload: completed.upload,
            }
          : current
      )
      setVideoFile(null)
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The video upload failed."
      )
    } finally {
      videoUploadInFlightRef.current = false
      setVideoStarting(false)
    }
  }

  const retryVideoUpload = async () => {
    if (!snapshot?.videoUpload) return
    const currentUpload = snapshot.videoUpload
    const file = videoFile
    const cancelledUploadHasVideo =
      currentUpload.status === "cancelled" &&
      currentUpload.bytes >= currentUpload.expectedBytes
    if (
      currentUpload.status !== "failed" &&
      currentUpload.status !== "uploaded" &&
      !cancelledUploadHasVideo &&
      !file
    ) {
      return
    }
    videoUploadInFlightRef.current = true
    setVideoStarting(true)
    setError("")
    try {
      if (currentUpload.status === "failed" || cancelledUploadHasVideo) {
        const retried = await api.post<{
          upload: TranscriptionVideoUpload
          jobId?: string
        }>(`/api/v1/transcription/video-uploads/${currentUpload.id}/retry`)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                session: { ...current.session, status: "processing" },
                videoUpload: retried.upload,
              }
            : current
        )
        setVideoFile(null)
        onSessionsChanged()
        return
      }
      const initialized = await api.get<{
        upload: TranscriptionVideoUpload
        partUrls: { partNumber: number; url: string }[]
      }>(`/api/v1/transcription/video-uploads/${currentUpload.id}`)
      if (initialized.upload.status === "uploaded") {
        const completed = await api.post<{
          upload: TranscriptionVideoUpload
          jobId?: string
        }>(`/api/v1/transcription/video-uploads/${currentUpload.id}/complete`, {
          parts: [],
        })
        setSnapshot((current) =>
          current
            ? {
                ...current,
                session: { ...current.session, status: "processing" },
                videoUpload: completed.upload,
              }
            : current
        )
        setVideoFile(null)
        onSessionsChanged()
        return
      }
      if (!file) throw new Error("Choose the original video file to resume.")
      if (file.size !== initialized.upload.expectedBytes) {
        throw new Error(
          "Choose the same video file that was used to start this upload."
        )
      }
      const parts = await uploadVideoParts(
        file,
        initialized.upload,
        initialized.partUrls
      )
      const completed = await api.post<{
        upload: TranscriptionVideoUpload
        jobId?: string
      }>(`/api/v1/transcription/video-uploads/${currentUpload.id}/complete`, {
        parts,
      })
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: { ...current.session, status: "processing" },
              videoUpload: completed.upload,
            }
          : current
      )
      setVideoFile(null)
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The video upload failed."
      )
    } finally {
      videoUploadInFlightRef.current = false
      setVideoStarting(false)
    }
  }

  const cancelVideoUpload = async () => {
    if (!snapshot?.videoUpload) return
    videoUploadAbortRef.current?.abort()
    try {
      const result = await api.post<{ upload: TranscriptionVideoUpload }>(
        `/api/v1/transcription/video-uploads/${snapshot.videoUpload.id}/cancel`
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: { ...current.session, status: "failed" },
              videoUpload: result.upload,
            }
          : current
      )
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The video upload could not be cancelled."
      )
    }
  }

  const skipSpeakerSeparation = async () => {
    const uploadID = snapshot?.videoUpload?.id
    if (!uploadID) return
    setSkipSpeakerInFlight(true)
    setError("")
    try {
      const result = await api.post<{ upload: TranscriptionVideoUpload }>(
        `/api/v1/transcription/video-uploads/${uploadID}/skip?step=diarization`
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: { ...current.session, status: "processing" },
              videoUpload: result.upload,
            }
          : current
      )
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Speaker separation could not be skipped."
      )
    } finally {
      setSkipSpeakerInFlight(false)
    }
  }

  const refreshVideoPlayback = useCallback(async () => {
    const uploadID = snapshot?.videoUpload?.id
    if (!uploadID) return
    try {
      const result = await api.get<{ url: string }>(
        `/api/v1/transcription/video-uploads/${uploadID}/playback`
      )
      setSnapshot((current) =>
        current?.videoUpload
          ? {
              ...current,
              videoUpload: {
                ...current.videoUpload,
                playbackUrl: result.url,
              },
            }
          : current
      )
      setVideoPlaybackError("")
    } catch (caught) {
      setVideoPlaybackError(
        caught instanceof Error
          ? caught.message
          : "The video playback link could not be refreshed."
      )
    }
  }, [snapshot?.videoUpload?.id])

  const polishedAvailable = Boolean(
    snapshot?.session.polishStatus === "completed" &&
    snapshot.segments.some((segment) => segment.polishedText?.trim())
  )
  const displaySegments = useMemo(
    () =>
      (snapshot?.segments ?? []).map((segment) => {
        const verbatim = segment.text.trim() || segment.rawText?.trim() || ""
        return {
          ...segment,
          text:
            transcriptMode === "polished"
              ? segment.polishedText?.trim() || verbatim
              : verbatim,
        }
      }),
    [snapshot?.segments, transcriptMode]
  )
  const transcript = useMemo(
    () => groupTranscriptionSegments(displaySegments),
    [displaySegments]
  )
  const isVideoProcessing = ["uploading", "queued", "processing"].includes(
    snapshot?.videoUpload?.status ?? ""
  )
  const livePreviewSegments = useMemo<
    TranscriptionVideoPreviewSegment[]
  >(() => {
    const parallelProgress = snapshot?.videoUpload?.pipeline?.find(
      (step) => step.key === "transcription"
    )?.parallel
    const isPreviewActive =
      isVideoProcessing &&
      ["preparing", "transcribing", "fusing"].includes(
        parallelProgress?.phase ?? ""
      )
    if (!isPreviewActive) {
      return []
    }
    const preview = parallelProgress?.previewSegments ?? []
    return [...preview]
      .filter((segment) => segment.text.trim())
      .sort((left, right) => {
        if (left.startOffsetMs !== right.startOffsetMs) {
          return left.startOffsetMs - right.startOffsetMs
        }
        return left.endOffsetMs - right.endOffsetMs
      })
  }, [isVideoProcessing, snapshot?.videoUpload?.pipeline])
  const speakerById = useMemo(
    () =>
      new Map(
        (snapshot?.speakers ?? []).map((speaker) => [speaker.id, speaker])
      ),
    [snapshot?.speakers]
  )
  const filteredTranscript = useMemo(() => {
    const query = transcriptQuery.trim().toLocaleLowerCase()
    if (!query) return transcript
    return transcript.filter((message) => {
      const speaker = speakerById.get(message.speakerKey)
      const speakerLabel = speaker?.displayName || speaker?.label || ""
      return `${speakerLabel} ${message.text}`
        .toLocaleLowerCase()
        .includes(query)
    })
  }, [speakerById, transcript, transcriptQuery])
  const activeMessageId = useMemo(
    () =>
      transcript.find((message) => {
        if (currentTimeMs < message.startOffsetMs) return false
        const endOffset =
          message.endOffsetMs > message.startOffsetMs
            ? message.endOffsetMs
            : message.startOffsetMs + 4000
        return currentTimeMs <= endOffset
      })?.id ?? null,
    [currentTimeMs, transcript]
  )
  const displayDurationMs =
    videoDurationMs || snapshot?.videoUpload?.durationMs || 0
  const speakerSummaries = useMemo<VideoSpeakerSummary[]>(() => {
    const segmentsBySpeaker = new Map<string, TranscriptionSegment[]>()
    for (const segment of displaySegments) {
      if (!segment.speakerId) continue
      const segments = segmentsBySpeaker.get(segment.speakerId) ?? []
      segments.push(segment)
      segmentsBySpeaker.set(segment.speakerId, segments)
    }

    return (snapshot?.speakers ?? []).map((speaker) => {
      const segments = segmentsBySpeaker.get(speaker.id) ?? []
      const firstSegment = segments[0]
      const sampleStartMs = firstSegment
        ? Math.max(0, firstSegment.startOffsetMs)
        : null
      const observedEndMs = firstSegment
        ? Math.max(
            sampleStartMs ?? 0,
            firstSegment.endOffsetMs || (sampleStartMs ?? 0) + 2500
          )
        : null
      const sampleEndMs =
        sampleStartMs === null || observedEndMs === null
          ? null
          : Math.min(
              displayDurationMs > sampleStartMs
                ? displayDurationMs
                : sampleStartMs + 8000,
              Math.max(
                sampleStartMs + 1500,
                Math.min(sampleStartMs + 8000, observedEndMs + 4000)
              )
            )

      return {
        speaker,
        segmentCount: segments.length,
        speakingMs: segments.reduce((total, segment) => {
          const duration = segment.endOffsetMs - segment.startOffsetMs
          return total + (duration > 0 ? duration : 0)
        }, 0),
        sampleStartMs,
        sampleEndMs,
        sampleText: firstSegment?.text.trim() ?? "",
      }
    })
  }, [displayDurationMs, displaySegments, snapshot?.speakers])

  useEffect(() => {
    const rail = transcriptRailRef.current
    if (!rail) return

    const updateHeight = () => {
      if (!window.matchMedia("(min-width: 1024px)").matches) {
        setTranscriptRailHeight(null)
        return
      }
      const height = Math.ceil(rail.scrollHeight)
      setTranscriptRailHeight(height > 0 ? height : null)
    }

    updateHeight()
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateHeight)
    observer?.observe(rail)
    window.addEventListener("resize", updateHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", updateHeight)
    }
  }, [
    snapshot?.session.polishStatus,
    snapshot?.videoUpload?.playbackUrl,
    snapshot?.videoUpload?.status,
    speakerSummaries.length,
  ])

  const playSpeakerSample = useCallback(
    (summary: VideoSpeakerSummary) => {
      const video = videoRef.current
      if (!video || !snapshot?.videoUpload?.playbackUrl) return
      if (speakerSample?.speakerId === summary.speaker.id) {
        video.pause()
        setSpeakerSample(null)
        return
      }
      if (summary.sampleStartMs === null || summary.sampleEndMs === null) {
        return
      }
      const startOffsetMs = summary.sampleStartMs
      const endOffsetMs = summary.sampleEndMs
      video.currentTime = startOffsetMs / 1000
      setCurrentTimeMs(startOffsetMs)
      setSpeakerSample({
        speakerId: summary.speaker.id,
        endOffsetMs,
      })
      void video.play().catch(() => setSpeakerSample(null))
    },
    [snapshot?.videoUpload?.playbackUrl, speakerSample?.speakerId]
  )

  const seekToMessage = useCallback((startOffsetMs: number) => {
    const video = videoRef.current
    if (!video) return
    setSpeakerSample(null)
    video.currentTime = Math.max(0, startOffsetMs / 1000)
    setCurrentTimeMs(Math.max(0, startOffsetMs))
    void video.play().catch(() => undefined)
  }, [])

  const openSpeakerRename = (speaker: TranscriptionSpeaker) => {
    setSpeakerToRename(speaker)
    setSpeakerName(speaker.displayName || speaker.label)
  }

  const saveSpeakerName = async () => {
    if (!speakerToRename || !snapshot) return
    const trimmedName = speakerName.trim()
    if (!trimmedName) {
      setError("A speaker name is required.")
      return
    }

    setSpeakerRenameSaving(true)
    try {
      await api.patch(
        `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/${speakerToRename.id}`,
        { displayName: trimmedName }
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              speakers: current.speakers.map((speaker) =>
                speaker.id === speakerToRename.id
                  ? { ...speaker, displayName: trimmedName }
                  : speaker
              ),
            }
          : current
      )
      setSpeakerToRename(null)
      setError("")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The speaker name could not be saved."
      )
    } finally {
      setSpeakerRenameSaving(false)
    }
  }

  const canCancelVideo = Boolean(
    snapshot?.videoUpload &&
    ["uploading", "queued", "processing"].includes(snapshot.videoUpload.status)
  )
  const cancelLabel =
    snapshot?.videoUpload?.status === "uploading"
      ? "Cancel upload"
      : "Cancel transcription"

  return (
    <div className="flex min-h-[calc(100svh-2rem)] w-full min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
      {error && (
        <Alert className="shrink-0" variant="destructive">
          <AlertTitle>Video transcription needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        <Empty className="min-h-0 flex-1 border-0">
          <EmptyHeader>
            <div className="mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <FileVideo aria-hidden="true" />
            </div>
            <EmptyTitle>Transcribe a video</EmptyTitle>
            <EmptyDescription>
              Upload a prerecorded video and receive a timestamped transcript.
              Processing continues in the background.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setCreateOpen(true)}>
            <Upload data-icon="inline-start" />
            New video transcription
          </Button>
        </Empty>
      ) : (
        <>
          <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>Video transcription</span>
                <span>/</span>
                <span>
                  {snapshot.session.language === "auto"
                    ? "Automatic language"
                    : snapshot.session.language}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold tracking-tight">
                  {snapshot.session.title}
                </h1>
                <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">
                  Uploaded by {user.displayName}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {canCancelVideo ? (
                <Button
                  aria-label={cancelLabel}
                  onClick={() => setCancelOpen(true)}
                  size="sm"
                  variant="destructive"
                >
                  <X data-icon="inline-start" />
                  <span>{cancelLabel}</span>
                </Button>
              ) : null}
              <Button
                onClick={() => setCreateOpen(true)}
                size="sm"
                variant="outline"
              >
                <Upload data-icon="inline-start" />
                <span className="hidden sm:inline">New video</span>
              </Button>
            </div>
          </header>

          {snapshot.videoUpload?.error ? (
            <Alert className="shrink-0" variant="destructive">
              <AlertTitle>
                {snapshot.videoUpload.status === "failed"
                  ? "Video transcription failed"
                  : "Video transcription is retrying"}
              </AlertTitle>
              <AlertDescription>
                {snapshot.videoUpload.error}
                {snapshot.videoUpload.status !== "failed"
                  ? " JustAI will retry this processing step automatically."
                  : " Retry the video after resolving the reported issue."}
              </AlertDescription>
            </Alert>
          ) : null}

          {snapshot.videoUpload?.status === "completed" &&
          snapshot.session.polishStatus === "failed" ? (
            <Alert className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Transcript completed with warnings</AlertTitle>
              <AlertDescription>
                The verbatim transcript is complete, but Grammar polish failed.
                The Polished view is unavailable; open the Grammar polish step
                below to see the error.
              </AlertDescription>
            </Alert>
          ) : null}

          {snapshot.videoUpload ? (
            <VideoPipeline
              hasDiarizedSpeakers={snapshot.speakers.some((speaker) =>
                /^speaker[_ -]?\d+$/i.test(speaker.label)
              )}
              onRequestSkipSpeakerSeparation={() => setSkipSpeakerOpen(true)}
              skipSpeakerInFlight={skipSpeakerInFlight}
              session={snapshot.session}
              upload={snapshot.videoUpload}
            />
          ) : null}

          {false ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(19rem,0.7fr)] lg:items-start">
              <Card
                className="flex max-h-[min(70vh,42rem)] min-h-[28rem] min-w-0 flex-col overflow-hidden shadow-none"
                style={
                  transcriptRailHeight
                    ? {
                        height: transcriptRailHeight ?? undefined,
                        maxHeight: transcriptRailHeight ?? undefined,
                      }
                    : undefined
                }
              >
                <CardHeader className="shrink-0 gap-3 border-b border-border px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <FileText
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        Transcript
                      </CardTitle>
                      <CardDescription>
                        {transcript.length} messages ·{" "}
                        {snapshot.segments.length} segments
                        {livePreviewSegments.length > 0
                          ? ` · ${livePreviewSegments.length} live preview lines`
                          : ""}
                        {transcriptQuery
                          ? ` · ${filteredTranscript.length} matches`
                          : ""}
                      </CardDescription>
                    </div>
                    <Tabs
                      aria-label="Transcript display mode"
                      onValueChange={(value) => {
                        if (value === "verbatim" || value === "polished") {
                          setTranscriptMode(value)
                        }
                      }}
                      value={transcriptMode}
                    >
                      <TabsList>
                        <TabsTrigger value="verbatim">Verbatim</TabsTrigger>
                        <TabsTrigger
                          disabled={!polishedAvailable}
                          value="polished"
                        >
                          Polished
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                  <div className="relative max-w-md">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label="Search transcript"
                      className="h-9 pl-9"
                      onChange={(event) =>
                        setTranscriptQuery(event.target.value)
                      }
                      placeholder="Search transcript"
                      value={transcriptQuery}
                    />
                  </div>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
                  {filteredTranscript.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {filteredTranscript.map((message) => {
                        const active = message.id === activeMessageId
                        const speaker = speakerById.get(message.speakerKey)
                        return (
                          <div
                            className={cn(
                              "grid w-full grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg px-2.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                              active
                                ? "bg-primary/10 ring-1 ring-primary/30"
                                : "hover:bg-muted/50"
                            )}
                            key={message.id}
                            onClick={(event) => {
                              if (
                                event.target instanceof Element &&
                                event.target.closest("button")
                              ) {
                                return
                              }
                              seekToMessage(message.startOffsetMs)
                            }}
                            role="group"
                          >
                            <button
                              aria-current={active ? "true" : undefined}
                              aria-label={`Jump to ${formatVideoTimestamp(message.startOffsetMs)}`}
                              className={cn(
                                "flex h-fit items-start gap-1 rounded-sm pt-0.5 text-left font-mono text-[11px] tabular-nums focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                                active
                                  ? "text-primary"
                                  : "text-muted-foreground"
                              )}
                              onClick={() =>
                                seekToMessage(message.startOffsetMs)
                              }
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
                            <span className="min-w-0">
                              {speaker ? (
                                <Button
                                  aria-label={`Rename ${speaker.displayName || speaker.label}`}
                                  className="group/speaker-name mb-1 h-auto max-w-full justify-start p-0 hover:bg-transparent"
                                  onClick={() => openSpeakerRename(speaker)}
                                  size="sm"
                                  title="Rename speaker"
                                  variant="ghost"
                                >
                                  <Badge
                                    className="max-w-full truncate"
                                    variant="outline"
                                  >
                                    {speaker.displayName || speaker.label}
                                  </Badge>
                                  <Pencil
                                    aria-hidden="true"
                                    className="text-muted-foreground transition-colors group-hover/speaker-name:text-foreground group-focus-visible/speaker-name:text-foreground"
                                    data-icon="inline-end"
                                  />
                                </Button>
                              ) : null}
                              <span className="block min-w-0 text-sm leading-6 text-foreground">
                                {message.text}
                              </span>
                            </span>
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
                  ) : livePreviewSegments.length > 0 ? (
                    <LiveTranscriptPreview segments={livePreviewSegments} />
                  ) : isVideoProcessing ? (
                    <Empty className="min-h-48 border-0 p-4">
                      <EmptyHeader>
                        <EmptyTitle>Waiting for the first slice</EmptyTitle>
                        <EmptyDescription>
                          Workers are transcribing in parallel. Preview lines
                          will appear as output arrives.
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

              <aside
                className="flex min-h-0 flex-col gap-4"
                ref={transcriptRailRef}
              >
                {speakerSummaries.length > 0 ? (
                  <Card
                    aria-label="Speaker summary"
                    className="shrink-0 shadow-none"
                  >
                    <CardHeader className="gap-1 px-4 py-4">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Users
                          aria-hidden="true"
                          className="size-4 shrink-0 text-primary"
                        />
                        Speaker summary
                      </CardTitle>
                      <CardDescription>
                        Name each speaker and play a short sample from their
                        first detected line.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2 px-4 pb-4">
                      <div className="max-h-72 min-h-0 space-y-2 overflow-y-auto pr-1">
                        {speakerSummaries.map((summary) => {
                          const speakerName =
                            summary.speaker.displayName || summary.speaker.label
                          const isPlaying =
                            speakerSample?.speakerId === summary.speaker.id
                          const canPlaySample =
                            Boolean(snapshot.videoUpload?.playbackUrl) &&
                            summary.sampleStartMs !== null &&
                            summary.sampleEndMs !== null
                          return (
                            <div
                              className="rounded-xl border border-border/80 bg-muted/20 p-3"
                              key={summary.speaker.id}
                            >
                              <div className="flex min-w-0 items-start gap-2.5">
                                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                                  {speakerInitials(speakerName)}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="min-w-0 truncate text-xs font-medium text-foreground">
                                      {speakerName}
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
                                    ·{" "}
                                    {formatSpeakerSummaryDuration(
                                      summary.speakingMs
                                    )}
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
                                      isPlaying
                                        ? `Stop sample for ${speakerName}`
                                        : `Play sample for ${speakerName}`
                                    }
                                    className="shrink-0"
                                    disabled={!canPlaySample}
                                    onClick={() => playSpeakerSample(summary)}
                                    size="icon-sm"
                                    title={
                                      isPlaying
                                        ? "Stop sample"
                                        : "Play speaker sample"
                                    }
                                    variant={isPlaying ? "default" : "outline"}
                                  >
                                    {isPlaying ? <Pause /> : <Play />}
                                  </Button>
                                  <Button
                                    aria-label={`Rename ${speakerName}`}
                                    className="shrink-0"
                                    onClick={() =>
                                      openSpeakerRename(summary.speaker)
                                    }
                                    size="icon-sm"
                                    title={`Rename ${speakerName}`}
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
                      <p
                        aria-live="polite"
                        className="text-[11px] text-muted-foreground"
                      >
                        {snapshot.videoUpload?.playbackUrl
                          ? "Samples play for up to 8 seconds in the source video."
                          : "Samples become available when source video playback is ready."}
                      </p>
                    </CardContent>
                  </Card>
                ) : null}
                <Card className="shrink-0 shadow-none">
                  <CardHeader className="gap-2 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                        <FileVideo
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        <span className="truncate">Source video</span>
                      </CardTitle>
                    </div>
                    <CardDescription className="truncate">
                      {snapshot.videoUpload?.fileName ?? "Video upload"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 px-4 pb-4">
                    <div className="overflow-hidden rounded-xl border border-border bg-muted">
                      {snapshot.videoUpload?.playbackUrl ? (
                        <video
                          className="block aspect-video w-full bg-muted object-contain"
                          controls
                          key={snapshot.videoUpload.playbackUrl}
                          onError={() => {
                            setSpeakerSample(null)
                            setVideoPlaybackError(
                              "The video link expired or the stored video is unavailable."
                            )
                          }}
                          onLoadedMetadata={(event) => {
                            if (Number.isFinite(event.currentTarget.duration)) {
                              setVideoDurationMs(
                                Math.round(event.currentTarget.duration * 1000)
                              )
                            }
                          }}
                          onEnded={() => setSpeakerSample(null)}
                          onTimeUpdate={(event) => {
                            const currentTime = Math.round(
                              event.currentTarget.currentTime * 1000
                            )
                            setCurrentTimeMs(currentTime)
                            if (
                              speakerSample &&
                              currentTime >= speakerSample.endOffsetMs
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
                          <Clock3
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />
                          {formatVideoTimestamp(currentTimeMs)}
                          {displayDurationMs
                            ? ` / ${formatVideoTimestamp(displayDurationMs)}`
                            : ""}
                        </span>
                        <span>Click a transcript line to seek</span>
                      </div>
                    ) : null}
                    {videoPlaybackError ? (
                      <Alert variant="destructive">
                        <AlertTitle>Playback unavailable</AlertTitle>
                        <AlertDescription>
                          {videoPlaybackError}
                        </AlertDescription>
                        <div className="mt-2">
                          <Button
                            onClick={() => void refreshVideoPlayback()}
                            size="sm"
                            variant="outline"
                          >
                            <RefreshCw data-icon="inline-start" />
                            Refresh link
                          </Button>
                        </div>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>
                {snapshot.videoUpload &&
                snapshot.videoUpload.status !== "completed" ? (
                  <div className="flex flex-col gap-2 px-1 text-xs">
                    {snapshot.videoUpload.status === "failed" ||
                    snapshot.videoUpload.status === "uploaded" ||
                    (snapshot.videoUpload.status === "cancelled" &&
                      snapshot.videoUpload.bytes >=
                        snapshot.videoUpload.expectedBytes) ||
                    (snapshot.videoUpload.status === "uploading" &&
                      Boolean(videoFile) &&
                      !videoStarting) ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 text-muted-foreground">
                          {snapshot.videoUpload.status === "failed"
                            ? "Processing failed"
                            : snapshot.videoUpload.status === "uploaded"
                              ? "Upload complete"
                              : snapshot.videoUpload.status === "cancelled"
                                ? "Processing cancelled"
                                : "Upload paused"}
                        </span>
                        <Button
                          disabled={videoStarting}
                          onClick={() => void retryVideoUpload()}
                          size="sm"
                          variant="outline"
                        >
                          <RefreshCw data-icon="inline-start" />
                          {snapshot.videoUpload.status === "failed"
                            ? "Retry"
                            : snapshot.videoUpload.status === "uploaded"
                              ? "Queue processing"
                              : snapshot.videoUpload.status === "cancelled"
                                ? "Retry processing"
                                : "Resume upload"}
                        </Button>
                      </div>
                    ) : null}
                    {snapshot.videoUpload.status === "uploading" &&
                    !videoFile &&
                    !videoStarting ? (
                      <div className="flex flex-col gap-1.5">
                        <p className="text-muted-foreground">
                          This upload is paused. Select the original video file
                          to resume it.
                        </p>
                        <Input
                          accept="video/*,.mkv,.avi,.mpeg,.mpg,.wmv"
                          aria-label="Select original video file"
                          className="h-8 text-xs"
                          onChange={(event) => {
                            const file = event.target.files?.[0]
                            if (file) {
                              setVideoFile(file)
                              setError("")
                            }
                          }}
                          type="file"
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <Card className="shrink-0 shadow-none">
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
                        <Users
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        Speakers
                      </span>
                      <span className="font-medium text-foreground">
                        {snapshot.speakers.length || "Not separated"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Grammar</span>
                      <span className="font-medium text-foreground">
                        {polishStatusLabel(snapshot.session.polishStatus)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5">
                        <Clock3
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        Duration
                      </span>
                      <span className="font-medium text-foreground tabular-nums">
                        {displayDurationMs
                          ? formatVideoDuration(displayDurationMs)
                          : "—"}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </aside>
            </div>
          ) : null}
          <VideoTranscriptWorkspace
            currentTimeMs={currentTimeMs}
            onCurrentTimeChange={setCurrentTimeMs}
            onError={setError}
            onRefreshPlayback={refreshVideoPlayback}
            onRenameSpeaker={openSpeakerRename}
            onSnapshotChange={(updater) =>
              setSnapshot((current) => (current ? updater(current) : current))
            }
            onVideoDurationChange={setVideoDurationMs}
            onVideoPlaybackError={setVideoPlaybackError}
            snapshot={snapshot}
            videoDurationMs={videoDurationMs}
            videoPlaybackError={videoPlaybackError}
            videoRef={videoRef}
          />
        </>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open && !videoUploadInFlightRef.current) setVideoFile(null)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New video transcription</DialogTitle>
            <DialogDescription>
              Upload a prerecorded video. JustAI will process it in the
              background and keep a timestamped transcript.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="video-session-title">
                Transcript name
              </FieldLabel>
              <Input
                id="video-session-title"
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="video-file">Video file</FieldLabel>
              <Input
                accept="video/*,.mkv,.avi,.mpeg,.mpg,.wmv"
                id="video-file"
                onChange={(event) =>
                  setVideoFile(event.target.files?.[0] ?? null)
                }
                type="file"
              />
              <FieldDescription>
                Four-hour videos are supported when configured storage and
                upload limits allow them.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="video-language">Language</FieldLabel>
              <Input
                id="video-language"
                onChange={(event) => setLanguage(event.target.value || "auto")}
                placeholder="auto"
                value={language}
              />
            </Field>
            <Field>
              <FieldLabel>Transcription endpoint</FieldLabel>
              <Select
                items={transcriptionEndpoints.map((endpoint) => ({
                  value: endpoint.id,
                  label: `${endpoint.name} · ${endpoint.providerType} · ${transcriptionModeLabel(endpoint)}`,
                }))}
                onValueChange={(value) => setSelectedEndpoint(value ?? "")}
                value={effectiveSelectedEndpoint}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a transcription endpoint" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Transcription providers</SelectLabel>
                    {transcriptionEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} · {endpoint.providerType} ·{" "}
                        {transcriptionModeLabel(endpoint)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Speaker separation</FieldLabel>
              <Select
                disabled={diarizationEndpoints.length === 0}
                items={[
                  { value: "none", label: "Keep one transcript stream" },
                  ...diarizationEndpoints.map((endpoint) => ({
                    value: endpoint.id,
                    label: `${endpoint.name} · ${endpoint.providerType}`,
                  })),
                ]}
                onValueChange={(value) =>
                  setSelectedDiarizationEndpoint(value ?? "none")
                }
                value={selectedDiarizationEndpoint}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Keep one transcript stream" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Diarization providers</SelectLabel>
                    <SelectItem value="none">
                      Keep one transcript stream
                    </SelectItem>
                    {diarizationEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} · {endpoint.providerType}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Separate speakers in the transcript when a diarization endpoint
                is available.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Grammar polishing</FieldLabel>
              <Select
                items={[
                  { value: "none", label: "Keep verbatim transcript" },
                  ...grammarEndpoints.map((endpoint) => ({
                    value: endpoint.id,
                    label: `${endpoint.name} · ${endpoint.providerType}`,
                  })),
                ]}
                onValueChange={(value) => setGrammarChoice(value ?? "none")}
                value={effectiveGrammarEndpoint || "none"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Keep verbatim transcript" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Chat providers</SelectLabel>
                    <SelectItem value="none">
                      Keep verbatim transcript
                    </SelectItem>
                    {grammarEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} · {endpoint.providerType}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                The original ASR output stays available under Verbatim.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={() => setCreateOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={
                videoStarting || !videoFile || !effectiveSelectedEndpoint
              }
              onClick={() => void createVideoSession()}
            >
              {videoStarting ? (
                <>
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload data-icon="inline-start" /> Start upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(speakerToRename)}
        onOpenChange={(open) => {
          if (!open && !speakerRenameSaving) setSpeakerToRename(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename speaker</DialogTitle>
            <DialogDescription>
              This name is shown for every transcript line attributed to this
              speaker.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="video-speaker-name">Speaker name</FieldLabel>
              <Input
                autoFocus
                id="video-speaker-name"
                onChange={(event) => setSpeakerName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void saveSpeakerName()
                  }
                }}
                value={speakerName}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              disabled={speakerRenameSaving}
              onClick={() => setSpeakerToRename(null)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={speakerRenameSaving || !speakerName.trim()}
              onClick={() => void saveSpeakerName()}
            >
              {speakerRenameSaving ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <Pencil data-icon="inline-start" />
              )}
              Save speaker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this video?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the upload and cancels transcription. A completed
              upload is retained so you can still view the source or retry it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep processing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setCancelOpen(false)
                void cancelVideoUpload()
              }}
            >
              {cancelLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!skipSpeakerInFlight) setSkipSpeakerOpen(open)
        }}
        open={skipSpeakerOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skip speaker separation?</AlertDialogTitle>
            <AlertDialogDescription>
              The transcript and timestamps will be kept, but this video will
              not receive automatic speaker labels.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={skipSpeakerInFlight}>
              Keep speaker separation
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={skipSpeakerInFlight}
              onClick={() => {
                setSkipSpeakerOpen(false)
                void skipSpeakerSeparation()
              }}
            >
              {skipSpeakerInFlight ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <SkipForward data-icon="inline-start" />
              )}
              Skip separation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function LiveTranscriptPreview({
  segments,
}: {
  segments: TranscriptionVideoPreviewSegment[]
}) {
  return (
    <div
      aria-label="Live transcript preview"
      aria-live="polite"
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AudioLines aria-hidden="true" className="size-4 text-primary" />
            Live transcript preview
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Recent output from active workers. The final fused transcript will
            replace this preview.
          </p>
        </div>
        <Badge className="shrink-0" variant="outline">
          <LoaderCircle
            aria-hidden="true"
            className="size-3 motion-safe:animate-spin motion-reduce:animate-none"
          />
          Live
        </Badge>
      </div>
      <div className="divide-y rounded-xl border border-border/70 bg-muted/10">
        {segments.map((segment, index) => (
          <div
            className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm"
            key={`${segment.startOffsetMs}-${segment.endOffsetMs}-${index}`}
          >
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {formatVideoTimestamp(segment.startOffsetMs)}
            </span>
            <span className="min-w-0 leading-6 text-foreground">
              {segment.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function VideoPipeline({
  hasDiarizedSpeakers,
  onRequestSkipSpeakerSeparation,
  skipSpeakerInFlight,
  upload,
  session,
}: {
  hasDiarizedSpeakers: boolean
  onRequestSkipSpeakerSeparation: () => void
  skipSpeakerInFlight: boolean
  upload: TranscriptionVideoUpload
  session: TranscriptionSession
}) {
  const [now, setNow] = useState(() => Date.now())
  const pipelineStorageKey = `justai.video-transcription.pipeline.collapsed:${upload.sessionId}`
  const [open, setOpen] = useState(true)
  const isActive = ["uploading", "queued", "processing"].includes(upload.status)

  useEffect(() => {
    if (!isActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isActive])

  useEffect(() => {
    let collapsed = false
    try {
      collapsed = window.localStorage.getItem(pipelineStorageKey) === "true"
    } catch {
      // Local storage can be unavailable in private browsing contexts.
    }
    queueMicrotask(() => setOpen(!collapsed))
  }, [pipelineStorageKey])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    try {
      window.localStorage.setItem(pipelineStorageKey, String(!nextOpen))
    } catch {
      // The pipeline remains usable when local storage is unavailable.
    }
  }

  const steps = getVideoPipelineSteps(upload, session, hasDiarizedSpeakers)
  const parallelProgress = steps.find(
    (step) => step.key === "transcription"
  )?.parallel
  const activeStep = steps.find(
    (step) => step.status === "active" || step.status === "retrying"
  )
  const hasFailedStep = steps.some((step) => step.status === "failed")
  const completedCount = steps.filter((step) =>
    ["completed", "skipped"].includes(step.status)
  ).length
  const hasStepTiming = steps.some(
    (step) =>
      (step.durationMs ?? 0) > 0 ||
      Boolean(
        step.startedAt && (step.completedAt || activeStep?.key === step.key)
      )
  )
  const runTimeMs = getVideoPipelineRunTime(session, upload, now)
  const workerStatus = upload.workerStatus
  const workerCapacity = workerStatus?.capacity ?? 0
  const skipSpeakerRequested = upload.stage === "skipping_diarization"
  const showSpeakerSkipAction =
    upload.status === "processing" &&
    (upload.stage === "diarizing" || skipSpeakerRequested)
  const workersSaturated = Boolean(
    workerStatus && workerStatus.active >= workerStatus.capacity
  )
  const overallLabel =
    upload.status === "completed"
      ? hasFailedStep
        ? "Processing completed with warnings"
        : "Processing complete"
      : upload.status === "failed"
        ? "Processing stopped"
        : upload.status === "cancelled"
          ? "Processing cancelled"
          : activeStep
            ? skipSpeakerRequested
              ? "Skipping speaker separation"
              : parallelProgress?.phase === "preparing"
                ? "Preparing audio slices"
                : parallelProgress?.phase === "fusing"
                  ? "Fusing transcript in progress"
                  : parallelProgress?.phase === "transcribing"
                    ? "Transcribing slices in parallel"
                    : `${videoPipelineStepLabel(activeStep.key)} in progress`
            : upload.status === "queued"
              ? workersSaturated
                ? "Waiting for an available worker"
                : "Queued for transcription"
              : "Preparing video"

  return (
    <Collapsible
      className="shrink-0"
      onOpenChange={handleOpenChange}
      open={open}
    >
      <Card
        aria-label="Video processing pipeline"
        className="flex min-h-0 flex-col overflow-hidden border-border/80 shadow-none"
      >
        <CardHeader className="gap-3 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles aria-hidden="true" className="size-4 text-primary" />
                Processing pipeline
              </CardTitle>
              <CardDescription className="mt-1">
                {overallLabel}.{" "}
                {hasStepTiming
                  ? "Each step shows its recorded or inferred duration."
                  : "Step timings will appear as processing advances."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge
                className="h-5 px-2 text-[10px]"
                variant={
                  upload.status === "failed" || hasFailedStep
                    ? "destructive"
                    : "secondary"
                }
              >
                {completedCount}/{steps.length} steps
              </Badge>
              {parallelProgress ? (
                <Badge className="h-5 px-2 text-[10px]" variant="outline">
                  {parallelProgress.workerCount ?? 1} parallel workers
                </Badge>
              ) : null}
              {workerStatus &&
              (upload.status === "queued" || upload.status === "processing") ? (
                <Badge className="h-5 px-2 text-[10px]" variant="outline">
                  {workerStatus.active}/{workerCapacity} video workers
                </Badge>
              ) : null}
              <span className="whitespace-nowrap">
                Run time · {formatPipelineStepDuration(runTimeMs)}
              </span>
              <CollapsibleTrigger
                aria-label={
                  open
                    ? "Collapse video processing pipeline"
                    : "Expand video processing pipeline"
                }
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                type="button"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 transition-transform duration-200 motion-reduce:transition-none",
                    !open && "-rotate-90"
                  )}
                />
              </CollapsibleTrigger>
            </div>
          </div>
          <Progress
            aria-label="Overall video processing progress"
            className="h-1.5"
            value={Math.max(0, Math.min(100, upload.progress))}
          />
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="px-4 pb-4 sm:px-5">
            {upload.status === "queued" && workerStatus ? (
              <VideoWorkerQueue status={workerStatus} />
            ) : null}
            {parallelProgress ? (
              <ParallelTranscriptionFlow
                key={
                  upload.status === "completed" ||
                  parallelProgress.phase === "complete"
                    ? "complete"
                    : "active"
                }
                progress={parallelProgress}
                upload={upload}
              />
            ) : null}
            <div
              className="flex min-w-0 flex-row items-stretch gap-0 overflow-x-auto pb-2 md:overflow-visible md:pb-0"
              role="list"
            >
              {steps.map((step, index) => {
                const active =
                  step.status === "active" || step.status === "retrying"
                const Icon = videoPipelineStepIcon(step.status)
                return (
                  <Fragment key={step.key}>
                    <div
                      className={cn(
                        "w-[13rem] min-w-0 flex-none rounded-xl border p-3 transition-[transform,opacity,background-color,border-color] duration-200 ease-out motion-reduce:transition-none md:w-auto md:flex-1",
                        videoPipelineStepClass(step.status),
                        active && "md:-translate-y-0.5"
                      )}
                      role="listitem"
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground",
                            active &&
                              "video-pipeline-orb border-primary/50 bg-primary/10 text-primary",
                            step.status === "completed" &&
                              "border-primary/30 bg-primary/10 text-primary",
                            step.status === "failed" &&
                              "border-destructive/40 bg-destructive/10 text-destructive",
                            step.status === "cancelled" &&
                              "border-destructive/30 bg-destructive/5 text-destructive"
                          )}
                        >
                          <Icon
                            aria-hidden="true"
                            className={cn(
                              "size-4",
                              active &&
                                "motion-safe:animate-spin motion-reduce:animate-none"
                            )}
                          />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">
                            {videoPipelineStepLabel(step.key)}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {videoPipelineStepDescription(step.key)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-muted-foreground">
                          {videoPipelineStatusLabel(step.status)}
                        </span>
                        <span className="font-medium text-foreground tabular-nums">
                          {step.durationEstimated ? "~" : ""}
                          {formatPipelineStepDuration(
                            getVideoPipelineStepDuration(
                              step,
                              now,
                              steps,
                              index
                            )
                          )}
                        </span>
                      </div>
                      {step.status === "failed" && step.error ? (
                        <p className="mt-2 line-clamp-2 text-[11px] text-destructive">
                          {step.error}
                        </p>
                      ) : null}
                      {step.key === "diarization" && showSpeakerSkipAction ? (
                        <Button
                          className="mt-2 w-full justify-center"
                          disabled={skipSpeakerInFlight || skipSpeakerRequested}
                          onClick={onRequestSkipSpeakerSeparation}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          {skipSpeakerInFlight || skipSpeakerRequested ? (
                            <LoaderCircle
                              className="animate-spin"
                              data-icon="inline-start"
                            />
                          ) : (
                            <SkipForward data-icon="inline-start" />
                          )}
                          {skipSpeakerRequested
                            ? "Skipping…"
                            : "Skip speaker separation"}
                        </Button>
                      ) : null}
                    </div>
                    {index < steps.length - 1 ? (
                      <div
                        aria-hidden="true"
                        className={cn(
                          "mx-2 my-auto h-px w-5 shrink-0 bg-border",
                          ["completed", "skipped"].includes(step.status) &&
                            "bg-primary/40"
                        )}
                      />
                    ) : null}
                  </Fragment>
                )
              })}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function VideoWorkerQueue({
  status,
}: {
  status: TranscriptionVideoWorkerStatus
}) {
  const capacity = Math.max(1, status.capacity)
  const active = Math.min(capacity, Math.max(0, status.active))
  const queued = Math.max(1, status.queued)
  const position = Math.max(1, status.queuePosition ?? 1)
  const saturated = active >= capacity
  const visibleSlots = Math.min(capacity, 6)
  const queuedBehind = Math.max(0, queued - position)
  const visibleQueueItems = Math.min(queued, 5)
  const yourQueueIndex = Math.min(position - 1, visibleQueueItems - 1)
  const hiddenAhead = Math.max(0, position - visibleQueueItems)

  return (
    <div
      aria-live="polite"
      className="video-worker-queue mb-4 rounded-xl border border-primary/20 bg-primary/[0.035] p-3 sm:p-4"
      role="status"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="video-worker-queue-icon flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <Clock3 aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {saturated
                ? "All transcription workers are busy"
                : position === 1
                  ? "Your transcription is next in line"
                  : "Your transcription is queued"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {saturated
                ? "Your video is safely queued and will start automatically as soon as a worker is free."
                : position === 1
                  ? "The worker pool is opening a slot for your video now."
                  : "The videos ahead of you will be processed in order."}
            </p>
          </div>
        </div>
        <Badge className="shrink-0 text-[10px]" variant="secondary">
          Queue position {position}
        </Badge>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="video-worker-queue-lane rounded-lg border border-border/70 bg-background/65 p-2.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>Worker pool</span>
            <span className="tabular-nums">
              {active} of {capacity} busy
            </span>
          </div>
          <div
            className="mt-2 grid gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${visibleSlots}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: visibleSlots }, (_, index) => {
              const busy = index < active
              return (
                <div
                  className={cn(
                    "flex min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[9px] text-muted-foreground",
                    busy
                      ? "video-worker-queue-worker border-primary/25 bg-primary/10 text-primary"
                      : "border-border/60 bg-muted/20"
                  )}
                  key={index}
                  title={
                    busy
                      ? "Worker is processing another video"
                      : "Available worker"
                  }
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-current" />
                  <span className="truncate">
                    W{String(index + 1).padStart(2, "0")}
                  </span>
                </div>
              )
            })}
          </div>
          {capacity > visibleSlots ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              +{capacity - visibleSlots} more configured worker
              {capacity - visibleSlots === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>

        <div className="video-worker-queue-lane rounded-lg border border-border/70 bg-background/65 p-2.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>Queue flow</span>
            <span className="tabular-nums">{queuedBehind} behind you</span>
          </div>
          <div className="relative mt-2 flex min-h-11 items-center gap-1.5 overflow-hidden rounded-md border border-border/60 bg-muted/20 px-2">
            <span aria-hidden="true" className="video-worker-queue-flow" />
            {Array.from({ length: visibleQueueItems }, (_, index) => {
              const isYou = index === yourQueueIndex
              return (
                <span
                  aria-hidden="true"
                  className={cn(
                    "video-worker-queue-token relative z-1 flex size-6 shrink-0 items-center justify-center rounded-full border text-[9px] font-medium",
                    isYou
                      ? "border-primary/35 bg-primary/15 text-primary"
                      : "border-border/70 bg-background text-muted-foreground"
                  )}
                  key={index}
                >
                  {isYou ? "You" : "•"}
                </span>
              )
            })}
            {hiddenAhead > 0 ? (
              <span className="relative z-1 text-[10px] text-muted-foreground">
                +{hiddenAhead} ahead
              </span>
            ) : queued > visibleQueueItems ? (
              <span className="relative z-1 text-[10px] text-muted-foreground">
                +{queued - visibleQueueItems}
              </span>
            ) : null}
            <span className="relative z-1 ml-auto flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
              <LoaderCircle
                aria-hidden="true"
                className="size-3 motion-safe:animate-spin motion-reduce:animate-none"
              />
            </span>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            No work is lost while you wait.
          </p>
        </div>
      </div>
    </div>
  )
}

function ParallelTranscriptionFlow({
  progress,
  upload,
}: {
  progress: TranscriptionVideoParallelProgress
  upload: TranscriptionVideoUpload
}) {
  const phase =
    upload.status === "completed" ? "complete" : progress.phase || "preparing"
  const [open, setOpen] = useState(() => phase !== "complete")
  const phaseOrder: Record<string, number> = {
    preparing: 0,
    transcribing: 1,
    fusing: 2,
    complete: 3,
  }
  const currentPhase = phaseOrder[phase] ?? 0
  const interrupted =
    upload.status === "failed" || upload.status === "cancelled"
  const sliceCount = Math.max(0, progress.sliceCount ?? 0)
  const completedSlices = Math.min(
    sliceCount,
    Math.max(0, progress.completedSlices ?? 0)
  )
  const workerCount = Math.max(1, Math.min(progress.workerCount ?? 1, 8))
  const sliceProgress =
    phase === "preparing"
      ? 0
      : phase === "fusing" || phase === "complete"
        ? 100
        : sliceCount > 0
          ? Math.round((completedSlices / sliceCount) * 100)
          : 0
  const stages = [
    {
      key: "preparing",
      label: "Prepare audio",
      description: "Extract and cut overlapping slices",
      icon: FileVideo,
    },
    {
      key: "transcribing",
      label: "Transcribe slices",
      description: "Run multiple workers at once",
      icon: AudioLines,
    },
    {
      key: "fusing",
      label: "Fuse transcript",
      description: "Sort timestamps and remove overlap",
      icon: GitMerge,
    },
  ]

  return (
    <Collapsible className="mb-4" onOpenChange={setOpen} open={open}>
      <div
        aria-label="Parallel transcription details"
        className="rounded-xl border border-primary/15 bg-primary/[0.025] p-3 sm:p-4"
      >
        <CollapsibleTrigger
          aria-label={
            open
              ? "Collapse parallel transcription details"
              : "Expand parallel transcription details"
          }
          className="flex w-full items-start justify-between gap-3 text-left"
          type="button"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <AudioLines
                aria-hidden="true"
                className="size-3.5 text-primary"
              />
              Parallel transcription
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The source is split into overlapping audio slices so long videos
              do not wait on one continuous transcription stream.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge className="text-[10px]" variant="outline">
              {progress.workerCount ?? 1} workers
            </Badge>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                !open && "-rotate-90"
              )}
            />
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-4 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
            {stages.map((stage, index) => {
              const stageIndex = phaseOrder[stage.key] ?? index
              const complete = phase === "complete" || stageIndex < currentPhase
              const active = !complete && stageIndex === currentPhase
              const failed = interrupted && active
              const Icon = failed
                ? CircleAlert
                : complete
                  ? Check
                  : active
                    ? LoaderCircle
                    : stage.icon
              return (
                <Fragment key={stage.key}>
                  <div
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 transition-[background-color,border-color,transform] duration-200 ease-out motion-reduce:transition-none",
                      complete && "border-primary/20 bg-primary/[0.04]",
                      active &&
                        !failed &&
                        "-translate-y-0.5 border-primary/35 bg-primary/10",
                      failed &&
                        "border-destructive/30 bg-destructive/10 text-destructive",
                      !complete &&
                        !active &&
                        "border-border/70 bg-background/50"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground",
                        complete &&
                          "border-primary/25 bg-primary/10 text-primary",
                        active && !failed && "border-primary/40 text-primary",
                        failed &&
                          "border-destructive/30 bg-destructive/10 text-destructive"
                      )}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5",
                          active &&
                            !failed &&
                            "motion-safe:animate-spin motion-reduce:animate-none"
                        )}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] font-medium">
                        {stage.label}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {failed
                          ? upload.status === "cancelled"
                            ? "Cancelled"
                            : "Stopped"
                          : stage.description}
                      </span>
                    </span>
                  </div>
                  {index < stages.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "hidden h-px bg-border md:block",
                        stageIndex < currentPhase && "bg-primary/40"
                      )}
                    />
                  ) : null}
                </Fragment>
              )
            })}
          </div>

          <div className="mt-3 rounded-lg border border-border/70 bg-background/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-foreground">
                {sliceCount > 0
                  ? `${completedSlices} of ${sliceCount} slices complete`
                  : "Building the slice map…"}
              </span>
              <span className="text-muted-foreground">
                {formatVideoDuration(progress.chunkDurationMs ?? 0)} windows ·{" "}
                {formatVideoDuration(progress.overlapMs ?? 0)} overlap
              </span>
            </div>
            <Progress
              aria-label="Parallel slice transcription progress"
              className="mt-2 h-1.5"
              value={sliceProgress}
            />
            <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: workerCount }, (_, index) => {
                const workerActive = phase === "transcribing" && !interrupted
                return (
                  <div
                    className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground"
                    key={index}
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full bg-muted-foreground/40",
                        workerActive &&
                          "bg-primary motion-safe:animate-pulse motion-reduce:animate-none",
                        (phase === "fusing" || phase === "complete") &&
                          "bg-primary/70"
                      )}
                    />
                    <span>Worker {String(index + 1).padStart(2, "0")}</span>
                    <span className="ml-auto">
                      {workerActive
                        ? "processing"
                        : phase === "preparing"
                          ? "ready"
                          : interrupted
                            ? "stopped"
                            : "joined"}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

const videoPipelineKeys = [
  "upload",
  "transcription",
  "diarization",
  "grammar",
  "finalization",
] as const

function getVideoPipelineSteps(
  upload: TranscriptionVideoUpload,
  session: TranscriptionSession,
  hasDiarizedSpeakers = false
): TranscriptionVideoPipelineStep[] {
  const pipelineLooksUninitialized = Boolean(
    upload.pipeline?.length &&
    [
      "uploaded",
      "queued",
      "processing",
      "completed",
      "failed",
      "cancelled",
    ].includes(upload.status) &&
    upload.pipeline.every(
      (step, index) =>
        (index === 0 && step.status === "active") ||
        (index > 0 && step.status === "pending")
    )
  )
  const pipelineConflictsWithUpload = Boolean(
    upload.pipeline?.length &&
    storedVideoPipelineConflictsWithUpload(upload, upload.pipeline)
  )
  if (
    upload.pipeline &&
    upload.pipeline.length > 0 &&
    !pipelineLooksUninitialized &&
    !pipelineConflictsWithUpload
  ) {
    const byKey = new Map(upload.pipeline.map((step) => [step.key, step]))
    const steps = videoPipelineKeys.map((key) => ({
      ...(byKey.get(key) ?? {
        key,
        status: "pending" as const,
      }),
    }))
    repairCancelledVideoPipeline(steps, upload)
    const diarizationStep = steps.find((step) => step.key === "diarization")
    if (hasDiarizedSpeakers && diarizationStep?.status === "skipped") {
      diarizationStep.status = "completed"
      diarizationStep.error = undefined
    }
    return hydrateVideoPipelineTiming(steps, upload, session)
  }

  const fallbackSteps = fallbackVideoPipeline(
    upload,
    session,
    hasDiarizedSpeakers
  )
  const parallelProgress = upload.pipeline?.find(
    (step) => step.key === "transcription"
  )?.parallel
  if (parallelProgress) {
    const transcriptionStep = fallbackSteps.find(
      (step) => step.key === "transcription"
    )
    if (transcriptionStep) transcriptionStep.parallel = parallelProgress
  }
  const storedDiarization = upload.pipeline?.find(
    (step) => step.key === "diarization"
  )
  const fallbackDiarization = fallbackSteps.find(
    (step) => step.key === "diarization"
  )
  if (storedDiarization?.status === "skipped" && fallbackDiarization) {
    fallbackDiarization.status = "skipped"
    fallbackDiarization.startedAt = undefined
    fallbackDiarization.completedAt = undefined
    fallbackDiarization.durationMs = 0
    fallbackDiarization.error = undefined
  }
  return hydrateVideoPipelineTiming(fallbackSteps, upload, session)
}

function storedVideoPipelineConflictsWithUpload(
  upload: TranscriptionVideoUpload,
  pipeline: TranscriptionVideoPipelineStep[]
) {
  const stage = upload.stage || ""
  let authoritativeIndex: number | null = null
  if (upload.status === "completed" || stage === "completed") {
    authoritativeIndex = videoPipelineKeys.length
  } else if (stage === "uploading") {
    authoritativeIndex = 0
  } else if (stage === "uploaded" || stage === "queued") {
    authoritativeIndex = 1
  } else if (
    ["starting", "extracting", "transcribing", "fusing", "processing"].includes(
      stage
    )
  ) {
    authoritativeIndex = 1
  } else if (stage === "diarizing" || stage === "skipping_diarization") {
    authoritativeIndex = 2
  } else if (stage === "polishing") {
    authoritativeIndex = 3
  } else if (stage === "finalizing") {
    authoritativeIndex = 4
  }
  if (authoritativeIndex === null) return false

  const byKey = new Map(pipeline.map((step) => [step.key, step]))
  for (let index = 0; index < authoritativeIndex; index += 1) {
    const key = videoPipelineKeys[index]
    const status = byKey.get(key)?.status ?? "pending"
    if (key === "upload" || key === "transcription" || key === "finalization") {
      if (status !== "completed") return true
      continue
    }
    if (!["completed", "skipped", "failed"].includes(status)) return true
  }

  if (
    authoritativeIndex < videoPipelineKeys.length &&
    upload.status === "processing"
  ) {
    const currentStatus = byKey.get(
      videoPipelineKeys[authoritativeIndex]
    )?.status
    if (stage === "skipping_diarization") {
      return currentStatus !== "active" && currentStatus !== "skipped"
    }
    return currentStatus !== "active" && currentStatus !== "retrying"
  }
  return false
}

function repairCancelledVideoPipeline(
  steps: TranscriptionVideoPipelineStep[],
  upload: TranscriptionVideoUpload
) {
  if (
    upload.status !== "cancelled" ||
    upload.expectedBytes <= 0 ||
    upload.bytes < upload.expectedBytes
  ) {
    return
  }

  const uploadStep = steps.find((step) => step.key === "upload")
  const transcriptionStep = steps.find((step) => step.key === "transcription")
  if (
    !uploadStep ||
    !transcriptionStep ||
    uploadStep.status !== "cancelled" ||
    (transcriptionStep.status !== "pending" &&
      transcriptionStep.status !== "cancelled")
  ) {
    return
  }

  // A complete source object means the user cancelled processing after the
  // upload had finished. Repair a stale pipeline snapshot from an in-flight
  // cancel race so the UI does not claim that the source upload was lost.
  uploadStep.status = "completed"
  transcriptionStep.status = "cancelled"
  const completedAt =
    transcriptionStep.completedAt ||
    upload.updatedAt ||
    upload.completedAt ||
    upload.createdAt
  transcriptionStep.startedAt =
    transcriptionStep.startedAt || uploadStep.completedAt || completedAt
  transcriptionStep.completedAt = completedAt
  if (transcriptionStep.startedAt) {
    const start = Date.parse(transcriptionStep.startedAt)
    const end = Date.parse(completedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      transcriptionStep.durationMs = Math.max(0, end - start)
    }
  }
}

function hydrateVideoPipelineTiming(
  steps: TranscriptionVideoPipelineStep[],
  upload: TranscriptionVideoUpload,
  session: TranscriptionSession
) {
  const firstTimestamp =
    parseVideoTimestamp(upload.createdAt) ??
    parseVideoTimestamp(session.createdAt)
  const sessionProcessingStart = parseVideoTimestamp(session.startedAt)
  const terminalEnd =
    parseVideoTimestamp(session.endedAt) ??
    parseVideoTimestamp(upload.completedAt) ??
    parseVideoTimestamp(upload.updatedAt) ??
    sessionProcessingStart ??
    firstTimestamp
  const result = steps.map((step) => ({ ...step }))
  let cursor = firstTimestamp

  const nextKnownStart = (index: number) => {
    for (let nextIndex = index + 1; nextIndex < result.length; nextIndex += 1) {
      const startedAt = parseVideoTimestamp(result[nextIndex].startedAt)
      if (startedAt !== null) return startedAt
    }
    return null
  }

  // The upload record's completedAt is the end of the whole transcription
  // job. For legacy pipeline records, the first downstream step (or the
  // session start) is the only reliable upload-phase boundary.
  const processingStart =
    sessionProcessingStart ?? nextKnownStart(0) ?? firstTimestamp
  const uploadProcessingBoundary = sessionProcessingStart ?? nextKnownStart(0)

  const hydrated = result.map((step, index) => {
    if (step.status === "pending" || step.status === "skipped") return step

    let startedAt = parseVideoTimestamp(step.startedAt)
    if (startedAt === null) {
      startedAt =
        step.key === "upload"
          ? firstTimestamp
          : step.key === "transcription"
            ? processingStart
            : cursor
      if (startedAt !== null) step.startedAt = new Date(startedAt).toISOString()
    }
    if (
      startedAt !== null &&
      cursor !== null &&
      (step.status === "active" || step.status === "retrying") &&
      startedAt < cursor
    ) {
      // Some legacy snapshots recorded the active step from the session start.
      // Pipeline steps are sequential, so never let an active step include
      // time that belongs to the preceding completed step.
      startedAt = cursor
      step.startedAt = new Date(startedAt).toISOString()
    }

    if (
      step.status === "completed" ||
      step.status === "failed" ||
      step.status === "cancelled"
    ) {
      let completedAt = parseVideoTimestamp(step.completedAt)
      if (
        step.key === "upload" &&
        uploadProcessingBoundary !== null &&
        (completedAt === null || completedAt > uploadProcessingBoundary)
      ) {
        completedAt = Math.max(
          startedAt ?? uploadProcessingBoundary,
          uploadProcessingBoundary
        )
        step.completedAt = new Date(completedAt).toISOString()
        step.durationMs =
          startedAt === null ? 0 : Math.max(0, completedAt - startedAt)
        step.durationEstimated = true
      } else if (completedAt === null) {
        completedAt =
          step.durationMs && step.durationMs > 0 && startedAt !== null
            ? startedAt + step.durationMs
            : step.key === "upload"
              ? uploadProcessingBoundary
              : (nextKnownStart(index) ?? terminalEnd)
        if (completedAt !== null && startedAt !== null) {
          completedAt = Math.max(startedAt, completedAt)
        }
        if (completedAt !== null) {
          step.completedAt = new Date(completedAt).toISOString()
        }
      }
      if (
        (step.durationMs ?? 0) <= 0 &&
        startedAt !== null &&
        completedAt !== null
      ) {
        step.durationMs = Math.max(0, completedAt - startedAt)
      }
      if (completedAt !== null) cursor = completedAt
    } else if (startedAt !== null) {
      cursor = startedAt
    }

    return step
  })

  const estimatedSteps = hydrated.filter(
    (step) =>
      step.key !== "upload" &&
      ["completed", "failed", "cancelled"].includes(step.status) &&
      !hasPositiveVideoStepDuration(step)
  )
  const processingWindowMs =
    processingStart !== null && terminalEnd !== null
      ? Math.max(0, terminalEnd - processingStart)
      : 0
  const recordedProcessingMs = hydrated.reduce((total, step) => {
    if (
      step.key === "upload" ||
      step.status === "skipped" ||
      estimatedSteps.includes(step)
    ) {
      return total
    }
    return total + Math.max(0, step.durationMs ?? 0)
  }, 0)
  let remainingProcessingMs = Math.max(
    0,
    processingWindowMs - recordedProcessingMs
  )
  if (estimatedSteps.length > 0 && processingWindowMs > 0) {
    let estimatedStart = processingStart ?? terminalEnd ?? 0
    estimatedSteps.forEach((step, index) => {
      const remainingSteps = estimatedSteps.length - index
      const durationMs =
        index === estimatedSteps.length - 1
          ? Math.max(1, remainingProcessingMs)
          : Math.max(1, Math.floor(remainingProcessingMs / remainingSteps))
      const completedAt = estimatedStart + durationMs
      step.startedAt = new Date(estimatedStart).toISOString()
      step.completedAt = new Date(completedAt).toISOString()
      step.durationMs = durationMs
      step.durationEstimated = true
      estimatedStart = completedAt
      remainingProcessingMs = Math.max(0, remainingProcessingMs - durationMs)
    })
  }

  return hydrated
}

function hasPositiveVideoStepDuration(step: TranscriptionVideoPipelineStep) {
  if ((step.durationMs ?? 0) > 0) return true
  if (!step.startedAt || !step.completedAt) return false
  const startedAt = parseVideoTimestamp(step.startedAt)
  const completedAt = parseVideoTimestamp(step.completedAt)
  return startedAt !== null && completedAt !== null && completedAt > startedAt
}

function parseVideoTimestamp(value?: string | null) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function fallbackVideoPipeline(
  upload: TranscriptionVideoUpload,
  session: TranscriptionSession,
  hasDiarizedSpeakers = false
): TranscriptionVideoPipelineStep[] {
  const timestamp = upload.updatedAt || upload.createdAt
  const steps = videoPipelineKeys.map<TranscriptionVideoPipelineStep>(
    (key) => ({
      key,
      status: "pending",
    })
  )
  const stepByKey = new Map(steps.map((step) => [step.key, step]))
  const startAt = session.startedAt || upload.createdAt

  const setStatus = (
    key: string,
    status: TranscriptionVideoPipelineStep["status"],
    completedAt?: string | null
  ) => {
    const step = stepByKey.get(key)
    if (!step) return
    step.status = status
    if (status === "active" || status === "retrying") {
      step.startedAt = step.startedAt || startAt
      return
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      if (completedAt) {
        step.completedAt = completedAt
        if (step.startedAt) {
          const start = Date.parse(step.startedAt)
          const end = Date.parse(completedAt)
          step.durationMs =
            Number.isFinite(start) && Number.isFinite(end)
              ? Math.max(0, end - start)
              : 0
        }
      }
    }
  }

  const optionalStatus = (
    key: "diarization" | "grammar",
    completedAt = timestamp,
    assumeCompleted = false
  ) => {
    if (key === "diarization") {
      setStatus(
        key,
        session.diarizationEndpointId || hasDiarizedSpeakers
          ? "completed"
          : "skipped",
        completedAt
      )
      return
    }
    if (
      !session.grammarEndpointId ||
      session.polishStatus === "not_requested"
    ) {
      setStatus(key, "skipped", completedAt)
    } else if (assumeCompleted && session.polishStatus !== "failed") {
      setStatus(key, "completed", completedAt)
    } else if (session.polishStatus === "failed") {
      setStatus(key, "failed", completedAt)
    } else if (session.polishStatus === "completed") {
      setStatus(key, "completed", completedAt)
    } else {
      setStatus(key, "active", completedAt)
    }
  }

  const stage = upload.stage || ""
  if (upload.status === "uploading" || stage === "uploading") {
    setStatus("upload", "active")
    return steps
  }
  const uploadCompletedAt =
    session.startedAt ||
    (upload.status === "uploaded" ? upload.updatedAt : undefined)
  setStatus("upload", "completed", uploadCompletedAt)

  if (upload.status === "queued" && stage === "retrying") {
    setStatus("transcription", "retrying")
    return steps
  }
  if (["starting", "extracting", "transcribing", "fusing"].includes(stage)) {
    setStatus("transcription", "active")
    return steps
  }
  if (stage === "diarizing") {
    setStatus("transcription", "completed")
    setStatus("diarization", "active")
    return steps
  }
  if (stage === "skipping_diarization") {
    setStatus("transcription", "completed")
    setStatus("diarization", "active")
    return steps
  }
  if (stage === "polishing") {
    setStatus("transcription", "completed")
    optionalStatus("diarization")
    setStatus("grammar", "active")
    return steps
  }
  if (stage === "finalizing") {
    setStatus("transcription", "completed")
    optionalStatus("diarization")
    optionalStatus("grammar")
    setStatus("finalization", "active")
    return steps
  }
  if (upload.status === "completed") {
    setStatus("transcription", "completed")
    optionalStatus("diarization", upload.completedAt || timestamp, true)
    optionalStatus("grammar", upload.completedAt || timestamp, true)
    setStatus("finalization", "completed", upload.completedAt || timestamp)
    return steps
  }
  if (upload.status === "cancelled") {
    setStatus("transcription", "cancelled")
    return steps
  }
  if (upload.status === "failed") {
    setStatus("transcription", "failed")
  }
  return steps
}

function videoPipelineStepLabel(key: string) {
  switch (key) {
    case "upload":
      return "Upload"
    case "transcription":
      return "Transcription"
    case "diarization":
      return "Speaker separation"
    case "grammar":
      return "Grammar polish"
    case "finalization":
      return "Finalization"
    default:
      return key
  }
}

function videoPipelineStepDescription(key: string) {
  switch (key) {
    case "upload":
      return "Store the source video"
    case "transcription":
      return "Create timestamped text"
    case "diarization":
      return "Match words to speakers"
    case "grammar":
      return "Correct grammar and punctuation"
    case "finalization":
      return "Publish the transcript"
    default:
      return ""
  }
}

function videoPipelineStatusLabel(
  status: TranscriptionVideoPipelineStep["status"]
) {
  switch (status) {
    case "active":
      return "In progress"
    case "retrying":
      return "Retrying"
    case "completed":
      return "Complete"
    case "skipped":
      return "Skipped"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    default:
      return "Pending"
  }
}

function videoPipelineStepIcon(
  status: TranscriptionVideoPipelineStep["status"]
): LucideIcon {
  switch (status) {
    case "active":
      return LoaderCircle
    case "retrying":
      return RefreshCw
    case "completed":
      return Check
    case "failed":
      return CircleAlert
    case "cancelled":
      return X
    default:
      return CircleDashed
  }
}

function videoPipelineStepClass(
  status: TranscriptionVideoPipelineStep["status"]
) {
  switch (status) {
    case "active":
    case "retrying":
      return "border-primary/40 bg-primary/5"
    case "completed":
      return "border-primary/20 bg-primary/[0.03]"
    case "failed":
      return "border-destructive/30 bg-destructive/5"
    case "cancelled":
      return "border-destructive/20 bg-destructive/[0.03]"
    case "skipped":
      return "border-dashed bg-muted/30 opacity-75"
    default:
      return "bg-muted/20"
  }
}

function getVideoPipelineStepDuration(
  step: TranscriptionVideoPipelineStep,
  now: number,
  steps: TranscriptionVideoPipelineStep[] = [],
  index = -1
) {
  const storedDuration = step.durationMs ?? 0
  if (step.status === "active" || step.status === "retrying") {
    let startedAt = step.startedAt ? Date.parse(step.startedAt) : NaN
    const previousBoundary = getVideoPipelinePreviousBoundary(steps, index)
    if (
      previousBoundary !== null &&
      Number.isFinite(previousBoundary) &&
      (!Number.isFinite(startedAt) || startedAt < previousBoundary)
    ) {
      startedAt = previousBoundary
    }
    if (Number.isFinite(startedAt)) return Math.max(0, now - startedAt)
  }
  if (storedDuration > 0) return storedDuration
  if (step.startedAt && step.completedAt) {
    const start = Date.parse(step.startedAt)
    const end = Date.parse(step.completedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return Math.max(0, end - start)
    }
  }
  return 0
}

function getVideoPipelinePreviousBoundary(
  steps: TranscriptionVideoPipelineStep[],
  index: number
) {
  for (let current = index - 1; current >= 0; current -= 1) {
    const step = steps[current]
    if (step.status === "pending" || step.status === "skipped") continue
    const completedAt = step.completedAt ? Date.parse(step.completedAt) : NaN
    if (Number.isFinite(completedAt)) return completedAt
    const startedAt = step.startedAt ? Date.parse(step.startedAt) : NaN
    const duration = step.durationMs ?? 0
    if (Number.isFinite(startedAt) && duration > 0) {
      return startedAt + duration
    }
  }
  return null
}

function getVideoPipelineRunTime(
  session: TranscriptionSession,
  upload: TranscriptionVideoUpload,
  now: number
) {
  const startedAt = Date.parse(session.startedAt || upload.createdAt)
  if (!Number.isFinite(startedAt)) return 0
  const terminal = ["completed", "failed", "cancelled"].includes(upload.status)
  const endedAt = terminal
    ? Date.parse(session.endedAt || upload.completedAt || upload.updatedAt)
    : now
  if (!Number.isFinite(endedAt)) return 0
  return Math.max(0, endedAt - startedAt)
}

function formatPipelineStepDuration(durationMs: number) {
  if (durationMs <= 0) return "—"
  if (durationMs < 1000) return "<1s"
  if (durationMs < 60_000) return `${Math.floor(durationMs / 1000)}s`
  return formatVideoDuration(durationMs)
}

function polishStatusLabel(status: TranscriptionSession["polishStatus"]) {
  switch (status) {
    case "queued":
      return "Queued"
    case "processing":
      return "Processing"
    case "completed":
      return "Available"
    case "failed":
      return "Unavailable"
    default:
      return "Verbatim only"
  }
}

function speakerInitials(value: string) {
  const initials = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return initials || "?"
}

function formatSpeakerSummaryDuration(durationMs: number) {
  if (durationMs <= 0) return "timing unavailable"
  if (durationMs < 1000) return "<1s speaking"
  return formatVideoDuration(durationMs) + " speaking"
}

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

function mergeVideoUploadSnapshot(
  current: TranscriptionVideoUpload | null | undefined,
  next: TranscriptionVideoUpload | null | undefined
) {
  if (!next) return current ?? null
  if (!current || current.id !== next.id) return next

  const sourceStillExists =
    next.status !== "cancelled" || next.bytes >= next.expectedBytes
  const pipeline =
    next.pipeline && next.pipeline.length > 0 ? next.pipeline : current.pipeline
  return {
    ...current,
    ...next,
    pipeline,
    progress:
      current.status === "uploading" && next.status === "uploading"
        ? Math.max(current.progress, next.progress)
        : next.progress,
    // Session snapshots generate a fresh signed URL on every request. Keep
    // the existing URL during polling so React does not reload the video;
    // the explicit "Refresh link" action replaces it when it actually expires.
    playbackUrl: sourceStillExists
      ? current.playbackUrl || next.playbackUrl
      : undefined,
  }
}

function transcriptionModeLabel(endpoint: Endpoint) {
  const realtime = endpointSupportsCapability(
    endpoint,
    "realtime-transcription"
  )
  const whisperGateway =
    endpoint.providerType === "openai-compatible" &&
    /whisper/i.test(endpoint.transcriptionModel ?? "")
  const chunked = Boolean(
    endpoint.capabilities["chunked-transcription"] ||
    (endpoint.capabilities.transcription && (!realtime || whisperGateway))
  )
  return chunked ? "HTTP chunks" : "Realtime"
}

function endpointSupportsTranscription(endpoint: Endpoint) {
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, "transcription")) {
    return Boolean(capabilities.transcription)
  }
  if (capabilities["chunked-transcription"]) return true
  if (capabilities["realtime-transcription"]) return true
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "chunked-transcription")
  )
    return false
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "realtime-transcription")
  )
    return false
  return (
    endpoint.providerType === "openai" || endpoint.providerType === "gemini"
  )
}

function endpointSupportsCapability(endpoint: Endpoint, capability: string) {
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, capability)) {
    return Boolean(capabilities[capability])
  }
  return (
    (capability === "realtime-transcription" &&
      (endpoint.providerType === "openai" ||
        endpoint.providerType === "gemini")) ||
    ((capability === "diarization" || capability === "chat") &&
      ["openai", "openai-compatible", "ollama", "gemini", "anthropic"].includes(
        endpoint.providerType
      ))
  )
}
