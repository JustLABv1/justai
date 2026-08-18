"use client"

import {
  Clock3,
  FileText,
  FileVideo,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Upload,
  Users,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
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
import type {
  Endpoint,
  TranscriptionSegment,
  TranscriptionSpeaker,
  TranscriptionSession,
  TranscriptionVideoUpload,
  User,
} from "@/lib/types"

type VideoSnapshot = {
  session: TranscriptionSession
  segments: TranscriptionSegment[]
  speakers: TranscriptionSpeaker[]
  videoUpload?: TranscriptionVideoUpload | null
}

type VideoSessionResponse = VideoSnapshot & {
  sources?: unknown[]
  recordings?: unknown[]
}

function videoUploadStateLabel(upload: TranscriptionVideoUpload) {
  switch (upload.status) {
    case "uploading":
      return `Uploading · ${Math.max(0, Math.min(100, upload.progress))}%`
    case "uploaded":
      return "Upload complete"
    case "queued":
      return upload.stage === "retrying" ? "Retrying" : "Queued"
    case "processing":
      return "Processing"
    case "completed":
      return "Ready"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
  }
}

function videoUploadStatusVariant(
  upload: TranscriptionVideoUpload
): "default" | "secondary" | "destructive" {
  if (["uploading", "queued", "processing"].includes(upload.status)) {
    return "default"
  }
  if (upload.status === "failed") return "destructive"
  return "secondary"
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
  const [snapshot, setSnapshot] = useState<VideoSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
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
  const requestRef = useRef(0)
  const videoUploadAbortRef = useRef<AbortController | null>(null)
  const videoUploadInFlightRef = useRef(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

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
    setLoading(true)
    try {
      const result = await api.get<VideoSessionResponse>(
        `/api/v1/transcription/sessions/${id}`
      )
      if (requestRef.current !== requestId) return
      setSnapshot({
        session: { ...result.session, kind: "video" },
        segments: result.segments ?? [],
        speakers: result.speakers ?? [],
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
    } finally {
      if (requestRef.current === requestId) setLoading(false)
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
    const upload = snapshot?.videoUpload
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
        const nextUpload = result.videoUpload ?? upload
        const mergedUpload =
          upload.status === "uploading" && nextUpload.status === "uploading"
            ? {
                ...nextUpload,
                progress: Math.max(upload.progress, nextUpload.progress),
              }
            : nextUpload
        setSnapshot({
          session: { ...result.session, kind: "video" },
          segments: result.segments ?? [],
          speakers: result.speakers ?? [],
          videoUpload: mergedUpload,
        })
        if (
          ["completed", "failed", "cancelled"].includes(mergedUpload.status)
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
  }, [onSessionsChanged, snapshot?.videoUpload])

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
    if (
      currentUpload.status !== "failed" &&
      currentUpload.status !== "uploaded" &&
      !file
    ) {
      return
    }
    videoUploadInFlightRef.current = true
    setVideoStarting(true)
    setError("")
    try {
      if (currentUpload.status === "failed") {
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
        const verbatim = segment.rawText?.trim() || segment.text.trim()
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
      return `${speakerLabel} ${message.text}`.toLocaleLowerCase().includes(query)
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
  const seekToMessage = useCallback((startOffsetMs: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, startOffsetMs / 1000)
    setCurrentTimeMs(Math.max(0, startOffsetMs))
    void video.play().catch(() => undefined)
  }, [])

  return (
    <div className="flex min-h-[calc(100svh-2rem)] w-full min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6">
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
                <BadgeForStatus
                  status={snapshot.session.status}
                  loading={loading}
                />
                <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">
                  Uploaded by {user.displayName}
                </span>
              </div>
            </div>
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              variant="outline"
            >
              <Upload data-icon="inline-start" />
              <span className="hidden sm:inline">New video</span>
            </Button>
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

          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:overflow-hidden lg:grid-cols-[minmax(0,1.3fr)_minmax(19rem,0.7fr)]">
            <Card className="min-h-[28rem] overflow-hidden shadow-none lg:min-h-0">
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
                      {transcript.length} messages · {snapshot.segments.length}{" "}
                      segments
                      {transcriptQuery ? ` · ${filteredTranscript.length} matches` : ""}
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
                    onChange={(event) => setTranscriptQuery(event.target.value)}
                    placeholder="Search transcript"
                    value={transcriptQuery}
                  />
                </div>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
                {filteredTranscript.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {filteredTranscript.map((message) => {
                      const active = message.id === activeMessageId
                      const speaker = speakerById.get(message.speakerKey)
                      return (
                        <button
                          aria-current={active ? "true" : undefined}
                          aria-label={`Jump to ${formatVideoTimestamp(message.startOffsetMs)}`}
                          className={cn(
                            "grid w-full grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg px-2.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                            active
                              ? "bg-primary/10 ring-1 ring-primary/30"
                              : "hover:bg-muted/50"
                          )}
                          key={message.id}
                          onClick={() => seekToMessage(message.startOffsetMs)}
                          type="button"
                        >
                          <span
                            className={cn(
                              "flex items-start gap-1 pt-0.5 font-mono text-[11px] tabular-nums",
                              active
                                ? "text-primary"
                                : "text-muted-foreground"
                            )}
                          >
                            {active ? (
                              <Play
                                aria-hidden="true"
                                className="mt-0.5 size-3 fill-current"
                              />
                            ) : null}
                            {formatVideoTimestamp(message.startOffsetMs)}
                          </span>
                          <span className="min-w-0">
                            {speaker ? (
                              <Badge
                                className="mb-1 max-w-full truncate"
                                variant="outline"
                              >
                                {speaker.displayName || speaker.label}
                              </Badge>
                            ) : null}
                            <span className="block min-w-0 text-sm leading-6 text-foreground">
                              {message.text}
                            </span>
                          </span>
                        </button>
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

            <aside className="flex min-h-0 flex-col gap-4 overflow-visible lg:overflow-y-auto">
              <Card className="shadow-none">
                <CardHeader className="gap-2 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                      <FileVideo
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                      <span className="truncate">Source video</span>
                    </CardTitle>
                    {snapshot.videoUpload ? (
                      <Badge
                        className="shrink-0"
                        variant={videoUploadStatusVariant(snapshot.videoUpload)}
                      >
                        {videoUploadStateLabel(snapshot.videoUpload)}
                      </Badge>
                    ) : null}
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
                        onError={() =>
                          setVideoPlaybackError(
                            "The video link expired or the stored video is unavailable."
                          )
                        }
                        onLoadedMetadata={(event) => {
                          if (Number.isFinite(event.currentTarget.duration)) {
                            setVideoDurationMs(
                              Math.round(event.currentTarget.duration * 1000)
                            )
                          }
                        }}
                        onTimeUpdate={(event) =>
                          setCurrentTimeMs(
                            Math.round(event.currentTarget.currentTime * 1000)
                          )
                        }
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
                        <Clock3 aria-hidden="true" className="size-3.5 shrink-0" />
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
                      <AlertDescription>{videoPlaybackError}</AlertDescription>
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
              {snapshot.videoUpload ? (
                <VideoUploadStatus
                  canRetry={Boolean(videoFile)}
                  onCancel={() => void cancelVideoUpload()}
                  onFileSelected={(file) => {
                    setVideoFile(file)
                    setError("")
                  }}
                  onRetry={() => void retryVideoUpload()}
                  upload={snapshot.videoUpload}
                  working={videoStarting}
                />
              ) : null}
              <Card className="shadow-none">
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
                      <Users aria-hidden="true" className="size-3.5 shrink-0" />
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
                  {snapshot.videoUpload?.durationMs ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5">
                        <Clock3
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        Duration
                      </span>
                      <span className="font-medium text-foreground">
                        {formatVideoDuration(snapshot.videoUpload.durationMs)}
                      </span>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </aside>
          </div>
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
    </div>
  )
}

function VideoUploadStatus({
  upload,
  working,
  canRetry,
  onRetry,
  onCancel,
  onFileSelected,
}: {
  upload: TranscriptionVideoUpload
  working: boolean
  canRetry: boolean
  onRetry: () => void
  onCancel: () => void
  onFileSelected: (file: File) => void
}) {
  const [cancelOpen, setCancelOpen] = useState(false)
  const terminal = ["completed", "cancelled"].includes(upload.status)
  const failed = upload.status === "failed"
  const activeUpload = working && upload.status === "uploading"
  const resumable =
    upload.status === "uploaded" ||
    (upload.status === "uploading" && canRetry && !working)
  const cancelLabel =
    upload.status === "uploading" ? "Cancel upload" : "Cancel transcription"
  const stage =
    upload.stage === "diarizing"
      ? "Separating speakers"
      : upload.stage === "polishing"
        ? "Polishing grammar"
        : upload.stage === "transcribing"
          ? "Transcribing audio"
          : upload.stage === "extracting"
            ? "Extracting audio"
            : upload.stage === "finalizing"
              ? "Finalizing transcript"
              : upload.stage === "retrying"
                ? "Retrying"
                : upload.status === "completed"
                  ? "Transcript ready"
                  : upload.status === "cancelled"
                    ? "Cancelled"
                    : upload.status === "uploaded"
                      ? "Upload complete"
                      : upload.status === "queued"
                        ? "Queued for processing"
                        : upload.status === "processing"
                          ? "Processing video"
                          : "Uploading video"

  return (
    <>
      <Card className="shadow-none">
        <CardHeader className="gap-2 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileVideo data-icon="inline-start" />
                <span className="truncate">{upload.fileName}</span>
              </CardTitle>
              <CardDescription className="mt-1">
                {stage}
                {upload.durationMs
                  ? ` · ${formatVideoDuration(upload.durationMs)}`
                  : ""}
              </CardDescription>
            </div>
            {failed || resumable ? (
              <Button
                disabled={working}
                onClick={onRetry}
                size="sm"
                variant="outline"
              >
                <RefreshCw data-icon="inline-start" />
                {failed
                  ? "Retry"
                  : upload.status === "uploaded"
                    ? "Queue processing"
                    : "Resume upload"}
              </Button>
            ) : terminal ? null : (
              <Button
                aria-label={cancelLabel}
                onClick={() => setCancelOpen(true)}
                size="sm"
                variant="outline"
              >
                <X data-icon="inline-start" />
                {cancelLabel}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4 pb-4">
          {activeUpload ? (
            <Alert className="border-primary/20 bg-primary/5">
              <AlertTitle>Uploading video</AlertTitle>
              <AlertDescription>
                Keep this tab open while the video is uploaded. Transcription
                starts automatically when the upload finishes.
              </AlertDescription>
            </Alert>
          ) : null}
          <Progress value={upload.progress}>
            <ProgressLabel>{stage}</ProgressLabel>
            <ProgressValue />
          </Progress>
          {upload.error ? (
            <p className="text-xs text-destructive">{upload.error}</p>
          ) : null}
          {upload.status === "uploading" && !canRetry && !working ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                This upload is paused. Select the original video file to resume
                it.
              </p>
              <Input
                accept="video/*,.mkv,.avi,.mpeg,.mpg,.wmv"
                aria-label="Select original video file"
                className="h-8 text-xs"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) onFileSelected(file)
                }}
                type="file"
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this video?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the upload and cancels transcription. The video will
              not be processed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep uploading</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setCancelOpen(false)
                onCancel()
              }}
            >
              {cancelLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function BadgeForStatus({
  status,
  loading,
}: {
  status: TranscriptionSession["status"]
  loading: boolean
}) {
  const variant =
    status === "failed"
      ? "destructive"
      : status === "processing" || status === "live"
        ? "default"
        : "secondary"
  return (
    <Badge className="h-5 px-2 text-[10px]" variant={variant}>
      {loading ? "Syncing" : status}
    </Badge>
  )
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
