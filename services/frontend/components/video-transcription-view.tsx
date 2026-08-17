"use client"

import { FileVideo, LoaderCircle, RefreshCw, Upload, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { api } from "@/lib/api"
import {
  formatTranscriptionOffset,
  groupTranscriptionSegments,
} from "@/lib/transcription"
import type {
  Endpoint,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionVideoUpload,
  User,
} from "@/lib/types"

type VideoSnapshot = {
  session: TranscriptionSession
  segments: TranscriptionSegment[]
  videoUpload?: TranscriptionVideoUpload | null
}

type VideoSessionResponse = VideoSnapshot & {
  sources?: unknown[]
  speakers?: unknown[]
  recordings?: unknown[]
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
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoStarting, setVideoStarting] = useState(false)
  const requestRef = useRef(0)
  const videoUploadAbortRef = useRef<AbortController | null>(null)

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
      videoUploadAbortRef.current?.abort()
    }
  }, [loadSession, sessionId])

  useEffect(() => {
    const upload = snapshot?.videoUpload
    if (!upload || !["queued", "processing"].includes(upload.status)) return
    let cancelled = false
    const poll = async () => {
      try {
        const result = await api.get<VideoSessionResponse>(
          `/api/v1/transcription/sessions/${upload.sessionId}`
        )
        if (cancelled) return
        const nextUpload = result.videoUpload ?? upload
        setSnapshot({
          session: { ...result.session, kind: "video" },
          segments: result.segments ?? [],
          videoUpload: nextUpload,
        })
        if (["completed", "failed", "cancelled"].includes(nextUpload.status)) {
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
    if (!videoFile) {
      setError("Choose a video file first.")
      return
    }
    setVideoStarting(true)
    setError("")
    try {
      const result = await api.post<{
        session: TranscriptionSession
        joinCode: string
        expiresAt: string
      }>("/api/v1/transcription/sessions", {
        title: title.trim() || "Video transcript",
        language,
        recordAudio: false,
        transcriptionEndpointId: effectiveSelectedEndpoint,
      })
      const createdSession: TranscriptionSession = {
        ...result.session,
        kind: "video",
      }
      const initialized = await api.post<{
        upload: TranscriptionVideoUpload
        partUrls: { partNumber: number; url: string }[]
      }>(`/api/v1/transcription/sessions/${createdSession.id}/video-uploads`, {
        fileName: videoFile.name,
        mimeType: videoFile.type || "application/octet-stream",
        fileBytes: videoFile.size,
      })
      setSnapshot({
        session: createdSession,
        segments: [],
        videoUpload: initialized.upload,
      })
      setCreateOpen(false)
      onSessionCreated(createdSession)
      const parts = await uploadVideoParts(
        videoFile,
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
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The video upload failed."
      )
    } finally {
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
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The video upload failed."
      )
    } finally {
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

  const transcript = useMemo(
    () => groupTranscriptionSegments(snapshot?.segments ?? []),
    [snapshot?.segments]
  )

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
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border pb-4">
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
              <div className="mt-1 flex items-center gap-2">
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

          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <Card className="min-h-0 overflow-hidden shadow-none">
              <CardHeader className="shrink-0 gap-1 px-4 py-4">
                <CardTitle className="text-sm">Transcript</CardTitle>
                <CardDescription>
                  {transcript.length} messages · {snapshot.segments.length}{" "}
                  segments
                </CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                {transcript.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {transcript.map((message) => (
                      <div
                        className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2.5 odd:bg-muted/30"
                        key={message.id}
                      >
                        <span className="pt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                          {formatTranscriptionOffset(message.startOffsetMs)}
                        </span>
                        <p className="min-w-0 text-sm leading-6 text-foreground">
                          {message.text}
                        </p>
                      </div>
                    ))}
                  </div>
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

            <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto">
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
                  <CardTitle className="text-sm">Video details</CardTitle>
                  <CardDescription>
                    {snapshot.videoUpload?.fileName ?? "Video upload"}
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
                  {snapshot.videoUpload?.durationMs ? (
                    <div className="flex items-center justify-between gap-3">
                      <span>Duration</span>
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
          if (!open) setVideoFile(null)
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
  const terminal = ["completed", "cancelled"].includes(upload.status)
  const failed = upload.status === "failed"
  const resumable =
    upload.status === "uploaded" || (upload.status === "uploading" && canRetry)
  const stage =
    upload.stage === "transcribing"
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
              aria-label="Cancel video transcription"
              onClick={onCancel}
              size="icon-sm"
              variant="ghost"
            >
              <X data-icon="inline-start" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4 pb-4">
        <Progress value={upload.progress}>
          <ProgressLabel>{stage}</ProgressLabel>
          <ProgressValue />
        </Progress>
        {upload.error ? (
          <p className="text-xs text-destructive">{upload.error}</p>
        ) : null}
        {upload.status === "uploading" && !canRetry ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">
              Select the original video file to resume this upload.
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
  )
}

function BadgeForStatus({
  status,
  loading,
}: {
  status: TranscriptionSession["status"]
  loading: boolean
}) {
  return (
    <Badge className="h-5 px-2 text-[10px]" variant="secondary">
      {loading ? "Syncing" : status}
    </Badge>
  )
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
    capability === "realtime-transcription" &&
    (endpoint.providerType === "openai" || endpoint.providerType === "gemini")
  )
}
