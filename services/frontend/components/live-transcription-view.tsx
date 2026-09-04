"use client"

import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Bot,
  Check,
  Copy,
  LoaderCircle,
  Mic,
  MonitorUp,
  Play,
  Radio,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tv,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  LiveTranscriptionOrbit,
  type LiveTranscriptionSnapshot,
} from "@/components/live-transcription-orbit"
import {
  LiveTranscriptionSourceView,
  type LiveTranscriptionCaptureViewMode,
} from "@/components/live-transcription-source-view"
import { TranscriptWorkspace } from "@/components/transcript-workspace"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import { Switch } from "@/components/ui/switch"
import { api, socketURL } from "@/lib/api"
import {
  mergeTranscriptionSegments,
  transcriptionJoinPath,
  upsertTranscriptionSource,
} from "@/lib/transcription"
import type {
  Endpoint,
  TranscriptionJoinRequest,
  TranscriptionRecording,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSpeaker,
  TranscriptionSource,
  User,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type Snapshot = LiveTranscriptionSnapshot

type SocketEvent = {
  type: string
  data?: Record<string, unknown>
}

type CaptureMode = "microphone" | "system-audio" | "external"
type ExternalSourceType = "stream" | "meeting-bot"
type SessionWizardStep = 0 | 1 | 2 | 3
type SessionSourceChoice =
  "microphone" | "system-audio" | "stream" | "meeting-bot"

const liveSessionWizardSteps = [
  { label: "Source", description: "Choose input" },
  { label: "Setup", description: "Connect it" },
  { label: "Options", description: "Tune room" },
  { label: "Review", description: "Start safely" },
] as const

const liveSessionSourceOptions: Array<{
  key: SessionSourceChoice
  icon: LucideIcon
  label: string
  description: string
}> = [
  {
    key: "microphone",
    icon: Mic,
    label: "Microphone",
    description: "Capture an in-person conversation or your mic.",
  },
  {
    key: "system-audio",
    icon: MonitorUp,
    label: "Browser tab or system",
    description: "Capture YouTube, TV, a webinar, or another tab.",
  },
  {
    key: "stream",
    icon: Tv,
    label: "Live stream URL",
    description: "Connect an HLS, HTTP(S), or RTMP(S) source.",
  },
  {
    key: "meeting-bot",
    icon: Bot,
    label: "Meeting bot",
    description: "Receive audio from Zoom, Meet, Teams, or a custom adapter.",
  },
]

const botPlatformLabels: Record<string, string> = {
  generic: "Custom / desktop adapter",
  zoom: "Zoom",
  "google-meet": "Google Meet",
  "microsoft-teams": "Microsoft Teams",
}

type BotSetup = {
  source: TranscriptionSource
  bot?: { platform?: string; status?: string }
  token: string
  protocol: string
  ticketPath: string
  websocketPath: string
  warning: string
}

export function LiveTranscriptionView({
  sessionId,
  sessions,
  endpoints,
  user,
  onSessionCreated,
  onSessionsChanged,
  createSessionRequested = false,
  onCreateSessionRequestHandled,
}: {
  sessionId: string | null
  sessions: TranscriptionSession[]
  endpoints: Endpoint[]
  user: User
  onSessionCreated: (session: TranscriptionSession) => void
  onSessionsChanged: () => void
  createSessionRequested?: boolean
  onCreateSessionRequestHandled?: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [partial, setPartial] = useState("")
  const [partialSourceId, setPartialSourceId] = useState<string | null>(null)
  const [partialSpeakerId, setPartialSpeakerId] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [joinLinkCopied, setJoinLinkCopied] = useState(false)
  const [joinRequests, setJoinRequests] = useState<TranscriptionJoinRequest[]>(
    []
  )
  const [title, setTitle] = useState("Room session")
  const [language, setLanguage] = useState("auto")
  const [recordAudio, setRecordAudio] = useState(false)
  const [selectedEndpoint, setSelectedEndpoint] = useState("")
  const [selectedDiarizationEndpoint, setSelectedDiarizationEndpoint] =
    useState("")
  const [selectedGrammarEndpoint, setSelectedGrammarEndpoint] = useState("")
  const [starting, setStarting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [deviceLabel, setDeviceLabel] = useState("")
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [captureMode, setCaptureMode] = useState<CaptureMode>("microphone")
  const [externalSourceType, setExternalSourceType] =
    useState<ExternalSourceType>("stream")
  const [createStep, setCreateStep] = useState<SessionWizardStep>(0)
  const [streamDialogOpen, setStreamDialogOpen] = useState(false)
  const [streamName, setStreamName] = useState("Live stream")
  const [streamURL, setStreamURL] = useState("")
  const [streamStarting, setStreamStarting] = useState(false)
  const [botDialogOpen, setBotDialogOpen] = useState(false)
  const [botName, setBotName] = useState("Meeting bot")
  const [botPlatform, setBotPlatform] = useState("generic")
  const [botMeetingURL, setBotMeetingURL] = useState("")
  const [botStarting, setBotStarting] = useState(false)
  const [botSetup, setBotSetup] = useState<BotSetup | null>(null)
  const [workspaceTimeMs, setWorkspaceTimeMs] = useState(0)
  const [workspaceDurationMs, setWorkspaceDurationMs] = useState(0)
  const [workspacePlaybackError, setWorkspacePlaybackError] = useState("")
  const [workspaceSpeaker, setWorkspaceSpeaker] =
    useState<TranscriptionSpeaker | null>(null)
  const [workspaceSpeakerName, setWorkspaceSpeakerName] = useState("")
  const [workspaceSpeakerSaving, setWorkspaceSpeakerSaving] = useState(false)

  const viewerSocketRef = useRef<WebSocket | null>(null)
  const captureSocketRef = useRef<WebSocket | null>(null)
  const connectViewerRef = useRef<
    (id: string, reconnect?: boolean) => Promise<void>
  >(() => Promise.resolve())
  const viewerAttemptRef = useRef(0)
  const viewerReconnectTimerRef = useRef<number | null>(null)
  const viewerReconnectAttemptsRef = useRef(0)
  const captureAttemptRef = useRef(0)
  const captureSourceIdRef = useRef<string | null>(null)
  const sessionLoadRef = useRef(0)
  const pendingFinalSegmentsRef = useRef(
    new Map<string, TranscriptionSegment>()
  )
  const pendingSpeakerUpdatesRef = useRef(new Map<string, string>())
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const captureDisplayStreamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const workspaceVideoRef = useRef<HTMLVideoElement | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const recordingUploadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const completingRecordingsRef = useRef(new Set<string>())
  const levelTimerRef = useRef<number | null>(null)
  const transcriptionEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled && endpointSupportsTranscription(endpoint)
      ),
    [endpoints]
  )
  const diarizationEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.providerType !== "pyannote" &&
          endpointSupportsCapability(endpoint, "diarization")
      ),
    [endpoints]
  )
  const grammarEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled && endpointSupportsCapability(endpoint, "chat")
      ),
    [endpoints]
  )

  const effectiveSelectedEndpoint =
    selectedEndpoint ||
    transcriptionEndpoints.find((endpoint) => endpoint.isDefault)?.id ||
    transcriptionEndpoints[0]?.id ||
    ""
  const selectedDeviceName =
    devices.find((device) => device.deviceId === deviceLabel)?.label ||
    "System default"
  const captureSourceKind =
    captureMode === "system-audio" ? "browser-system" : "browser"
  const captureSourceName =
    captureMode === "system-audio" ? "Browser tab audio" : "This laptop"
  const effectiveGrammarEndpoint = selectedGrammarEndpoint
  const selectedGrammarName =
    grammarEndpoints.find((endpoint) => endpoint.id === effectiveGrammarEndpoint)
      ?.name || "Off"

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const next = await navigator.mediaDevices.enumerateDevices()
      setDevices(next.filter((device) => device.kind === "audioinput"))
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Audio input devices could not be listed."
      )
    }
  }, [])

  const openCreateWizard = useCallback(() => {
    setError("")
    setCreateStep(0)
    setBotSetup(null)
    setCreateOpen(true)
    void refreshDevices()
  }, [refreshDevices])

  const completeRecording = useCallback(
    (recordingId: string, uploads: Promise<void>) => {
      if (completingRecordingsRef.current.has(recordingId)) return
      completingRecordingsRef.current.add(recordingId)
      void uploads
        .then(() =>
          api.post(`/api/v1/transcription/recordings/${recordingId}/complete`)
        )
        .catch((caught) =>
          setError(
            caught instanceof Error
              ? caught.message
              : "Audio upload could not be completed."
          )
        )
        .finally(() => {
          completingRecordingsRef.current.delete(recordingId)
          if (recordingIdRef.current === recordingId)
            recordingIdRef.current = null
        })
    },
    []
  )

  const closeCapture = useCallback(() => {
    captureAttemptRef.current += 1
    try {
      captureSocketRef.current?.send(
        JSON.stringify({ type: "transcription.stop" })
      )
    } catch {
      // The socket may already be closed.
    }
    captureSocketRef.current?.close()
    captureSocketRef.current = null
    captureSourceIdRef.current = null
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
    else if (recordingIdRef.current)
      completeRecording(recordingIdRef.current, recordingUploadQueueRef.current)
    mediaRecorderRef.current = null
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    workletRef.current?.disconnect()
    workletRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    audioStreamRef.current?.getTracks().forEach((track) => track.stop())
    audioStreamRef.current = null
    captureDisplayStreamRef.current
      ?.getTracks()
      .forEach((track) => track.stop())
    captureDisplayStreamRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    setCapturing(false)
    setLevel(0)
  }, [completeRecording])

  const closeViewer = useCallback((resetReconnect = true) => {
    viewerAttemptRef.current += 1
    if (viewerReconnectTimerRef.current !== null) {
      window.clearTimeout(viewerReconnectTimerRef.current)
      viewerReconnectTimerRef.current = null
    }
    if (resetReconnect) viewerReconnectAttemptsRef.current = 0
    viewerSocketRef.current?.close()
    viewerSocketRef.current = null
  }, [])

  const closeSockets = useCallback(() => {
    closeCapture()
    closeViewer()
  }, [closeCapture, closeViewer])

  useEffect(() => () => closeSockets(), [closeSockets])

  const applySnapshot = useCallback((next: Snapshot) => {
    setSnapshot((current) => {
      const sameSession = current?.session.id === next.session.id
      const pendingSegments = [
        ...pendingFinalSegmentsRef.current.values(),
      ].filter((segment) => segment.sessionId === next.session.id)
      const mergedSegments = mergeTranscriptionSegments(
        sameSession ? current?.segments || [] : [],
        next.segments,
        pendingSegments
      ).map((segment) => {
        const speakerId = pendingSpeakerUpdatesRef.current.get(segment.id)
        return speakerId ? { ...segment, speakerId } : segment
      })
      for (const segment of pendingSegments) {
        pendingFinalSegmentsRef.current.delete(segment.id)
      }
      for (const segment of mergedSegments) {
        if (pendingSpeakerUpdatesRef.current.has(segment.id)) {
          pendingSpeakerUpdatesRef.current.delete(segment.id)
        }
      }
      if (!sameSession) {
        return { ...next, segments: mergedSegments }
      }
      return {
        ...next,
        segments: mergedSegments,
        sources: next.sources.map((source) => {
          const existing = current.sources.find((item) => item.id === source.id)
          return existing
            ? { ...source, signalLevel: existing.signalLevel }
            : source
        }),
      }
    })
  }, [])

  const handleSocketEvent = useCallback(
    (event: SocketEvent) => {
      const data = event.data ?? {}
      if (event.type === "transcription.snapshot") {
        applySnapshot(data as unknown as Snapshot)
        return
      }
      if (event.type === "transcription.session") {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                session: {
                  ...current.session,
                  ...(data as Partial<TranscriptionSession>),
                },
              }
            : current
        )
        onSessionsChanged()
        return
      }
      if (event.type === "transcription.join-request") {
        const requestId = String(data.requestId ?? "")
        const status = String(data.status ?? "pending")
        if (
          !requestId ||
          !["pending", "approved", "denied", "expired"].includes(status)
        )
          return
        setJoinRequests((current) => {
          const nextStatus = status as TranscriptionJoinRequest["status"]
          const index = current.findIndex((request) => request.id === requestId)
          if (index < 0 && nextStatus !== "pending") return current
          if (index < 0) {
            return [
              {
                id: requestId,
                sourceName: String(data.sourceName ?? "Room microphone"),
                deviceLabel: String(data.deviceLabel ?? ""),
                status: nextStatus,
                sourceId: null,
                expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                createdAt: new Date().toISOString(),
              },
              ...current,
            ]
          }
          return current.map((request, requestIndex) =>
            requestIndex === index
              ? { ...request, status: nextStatus }
              : request
          )
        })
        return
      }
      if (event.type === "transcription.source") {
        const sourceId = String(data.sourceId ?? "")
        const sourceData =
          (data.source as Partial<TranscriptionSource> | undefined) ?? {}
        const status = String(
          data.status ?? sourceData?.status ?? "connected"
        ) as TranscriptionSource["status"]
        if (!sourceId) return
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: upsertTranscriptionSource(
                  current.sources,
                  { ...sourceData, id: sourceId },
                  status
                ),
              }
            : current
        )
        return
      }
      if (
        event.type === "transcription.stream" ||
        event.type === "transcription.bot"
      ) {
        const sourceId = String(data.sourceId ?? "")
        const transportStatus = String(data.status ?? "")
        if (!sourceId) return
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: current.sources.map((source) => {
                  if (source.id !== sourceId) return source
                  const nextStatus = [
                    "pending",
                    "connected",
                    "paused",
                    "disconnected",
                    "stopped",
                  ].includes(transportStatus)
                    ? (transportStatus as TranscriptionSource["status"])
                    : source.status
                  return {
                    ...source,
                    status: nextStatus,
                    transportStatus: transportStatus || source.transportStatus,
                    reconnectCount:
                      typeof data.reconnectCount === "number"
                        ? data.reconnectCount
                        : source.reconnectCount,
                    lastError:
                      typeof data.lastError === "string"
                        ? data.lastError
                        : transportStatus === "stopped"
                          ? ""
                          : source.lastError,
                    lastSeenAt:
                      data.lastSeenAt === null
                        ? null
                        : data.lastSeenAt
                          ? String(data.lastSeenAt)
                          : source.lastSeenAt,
                  }
                }),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.source.level") {
        const sourceId = String(data.sourceId ?? "")
        const nextLevel = Number(data.level ?? 0)
        if (captureSourceIdRef.current === sourceId) setLevel(nextLevel)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: current.sources.map((source) =>
                  source.id === sourceId
                    ? { ...source, signalLevel: nextLevel }
                    : source
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.partial") {
        setPartial(String(data.text ?? ""))
        setPartialSourceId(data.sourceId ? String(data.sourceId) : null)
        setPartialSpeakerId(data.speakerId ? String(data.speakerId) : null)
        return
      }
      if (event.type === "transcription.final") {
        const segment = data.segment as TranscriptionSegment | undefined
        if (!segment) return
        setPartial("")
        setPartialSourceId(null)
        setPartialSpeakerId(null)
        pendingFinalSegmentsRef.current.set(segment.id, segment)
        setSnapshot((current) => {
          if (
            !current ||
            (segment.sessionId && current.session.id !== segment.sessionId)
          )
            return current
          pendingFinalSegmentsRef.current.delete(segment.id)
          return {
            ...current,
            segments: mergeTranscriptionSegments(current.segments, [segment]),
          }
        })
        if (segment.sourceId) onSessionsChanged()
        return
      }
      if (event.type === "transcription.segment.updated") {
        const segmentId = String(data.segmentId ?? "")
        const speakerId = String(data.speakerId ?? "")
        if (!segmentId || !speakerId) return
        pendingSpeakerUpdatesRef.current.set(segmentId, speakerId)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                segments: current.segments.map((segment) =>
                  segment.id === segmentId ? { ...segment, speakerId } : segment
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.speaker") {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                speakers: current.speakers.map((speaker) =>
                  speaker.id === data.speakerId
                    ? {
                        ...speaker,
                        displayName: String(data.displayName ?? ""),
                      }
                    : speaker
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.polish") {
        const status = String(data.status ?? "") as NonNullable<
          TranscriptionSession["polishStatus"]
        >
        if (
          !["not_requested", "queued", "processing", "completed", "failed"].includes(
            status
          )
        ) {
          return
        }
        setSnapshot((current) =>
          current
            ? {
                ...current,
                session: { ...current.session, polishStatus: status },
              }
            : current
        )
        return
      }
      if (
        event.type === "error" ||
        event.type === "transcription.diarization-error"
      ) {
        setError(
          String(data.message ?? "The transcription service reported an error.")
        )
      }
    },
    [applySnapshot, onSessionsChanged]
  )

  const connectViewer = useCallback(
    async (id: string, reconnect = false) => {
      if (!reconnect) viewerReconnectAttemptsRef.current = 0
      closeViewer(!reconnect)
      const attempt = viewerAttemptRef.current
      const ticketResponse = await api.post<{ ticket: string }>(
        "/api/v1/ws/tickets",
        { kind: "transcription-viewer", sessionId: id }
      )
      if (viewerAttemptRef.current !== attempt) return
      const socket = new WebSocket(
        socketURL("/api/v1/ws/transcription", ticketResponse.ticket)
      )
      viewerSocketRef.current = socket
      let opened = false
      let openTimer: number | null = null
      socket.onmessage = (message) => {
        if (viewerAttemptRef.current !== attempt) return
        try {
          handleSocketEvent(JSON.parse(message.data) as SocketEvent)
        } catch {
          setError("Received an invalid event from the transcription server.")
        }
      }
      socket.onerror = () => {
        if (viewerAttemptRef.current === attempt) {
          setError(
            "The live transcription connection could not be established."
          )
        }
      }
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
          opened = true
          if (openTimer !== null) window.clearTimeout(openTimer)
          setError("")
          resolve()
        }
        socket.onclose = () => {
          if (openTimer !== null) window.clearTimeout(openTimer)
          if (viewerSocketRef.current === socket) viewerSocketRef.current = null
          if (viewerAttemptRef.current !== attempt) {
            resolve()
            return
          }
          if (opened) {
            setError("The live transcription connection dropped; reconnecting…")
            const retry = viewerReconnectAttemptsRef.current
            if (retry < 5) {
              viewerReconnectAttemptsRef.current = retry + 1
              viewerReconnectTimerRef.current = window.setTimeout(
                () => {
                  viewerReconnectTimerRef.current = null
                  if (viewerAttemptRef.current === attempt) {
                    void connectViewerRef
                      .current(id, true)
                      .catch(() => undefined)
                  }
                },
                Math.min(15_000, 1000 * 2 ** retry)
              )
            }
          }
          reject(new Error("The live transcription connection closed."))
        }
        openTimer = window.setTimeout(() => {
          socket.close()
          reject(
            new Error("The live transcription socket took too long to connect.")
          )
        }, 15_000)
      })
      if (
        viewerAttemptRef.current !== attempt ||
        socket.readyState !== WebSocket.OPEN
      ) {
        socket.close()
        return
      }
      socket.send(JSON.stringify({ type: "viewer.ready" }))
    },
    [closeViewer, handleSocketEvent]
  )

  useEffect(() => {
    connectViewerRef.current = connectViewer
  }, [connectViewer])

  const downsample = (
    input: Float32Array,
    sourceRate: number,
    targetRate: number
  ) => {
    if (sourceRate === targetRate) return input
    const ratio = sourceRate / targetRate
    const output = new Float32Array(Math.round(input.length / ratio))
    for (let index = 0; index < output.length; index += 1) {
      const start = Math.floor(index * ratio)
      const end = Math.min(input.length, Math.ceil((index + 1) * ratio))
      let total = 0
      for (let inputIndex = start; inputIndex < end; inputIndex += 1)
        total += input[inputIndex]
      output[index] = end > start ? total / (end - start) : 0
    }
    return output
  }

  const encodePCM16 = (input: Float32Array) => {
    const buffer = new ArrayBuffer(input.length * 2)
    const view = new DataView(buffer)
    input.forEach((value, index) => {
      const sample = Math.max(-1, Math.min(1, value))
      view.setInt16(
        index * 2,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      )
    })
    return buffer
  }

  const calculateRMS = (input: Float32Array) => {
    if (input.length === 0) return 0
    let total = 0
    input.forEach((value) => {
      total += value * value
    })
    return Math.sqrt(total / input.length)
  }

  const beginAudio = useCallback(
    async (
      socket: WebSocket,
      session: TranscriptionSession,
      source: TranscriptionSource,
      attempt: number
    ) => {
      const systemAudio = source.kind === "browser-system"
      if (
        systemAudio
          ? !navigator.mediaDevices?.getDisplayMedia
          : !navigator.mediaDevices?.getUserMedia
      )
        throw new Error(
          systemAudio
            ? "This browser does not support browser tab or system audio capture."
            : "This browser does not support microphone capture."
        )
      const isCurrent = () =>
        captureAttemptRef.current === attempt &&
        captureSocketRef.current === socket &&
        socket.readyState === WebSocket.OPEN
      let stream: MediaStream | null = null
      let context: AudioContext | null = null
      let worklet: AudioWorkletNode | null = null
      let analyser: AnalyserNode | null = null
      let levelTimer: number | null = null
      let displayStream: MediaStream | null = null
      const cleanupLocal = () => {
        if (levelTimer !== null) {
          window.clearInterval(levelTimer)
          if (levelTimerRef.current === levelTimer) levelTimerRef.current = null
          levelTimer = null
        }
        worklet?.disconnect()
        if (workletRef.current === worklet) workletRef.current = null
        analyser?.disconnect()
        if (analyserRef.current === analyser) analyserRef.current = null
        stream?.getTracks().forEach((track) => track.stop())
        if (audioStreamRef.current === stream) audioStreamRef.current = null
        displayStream?.getTracks().forEach((track) => track.stop())
        if (captureDisplayStreamRef.current === displayStream)
          captureDisplayStreamRef.current = null
        if (audioContextRef.current === context) audioContextRef.current = null
        void context?.close()
        context = null
      }
      if (systemAudio) {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })
        const audioTracks = displayStream.getAudioTracks()
        if (audioTracks.length === 0) {
          displayStream.getTracks().forEach((track) => track.stop())
          displayStream = null
          throw new Error(
            "The selected tab or screen did not share audio. Enable Share audio and try again."
          )
        }
        captureDisplayStreamRef.current = displayStream
        stream = new MediaStream(audioTracks)
        const stopWhenCaptureEnds = () => {
          if (isCurrent()) {
            setError("Browser tab or system audio capture ended.")
            closeCapture()
          }
        }
        displayStream
          .getVideoTracks()
          .forEach((track) =>
            track.addEventListener("ended", stopWhenCaptureEnds, { once: true })
          )
        audioTracks.forEach((track) =>
          track.addEventListener("ended", stopWhenCaptureEnds, { once: true })
        )
      } else {
        const constraints: MediaStreamConstraints = {
          audio: {
            ...(deviceLabel ? { deviceId: { exact: deviceLabel } } : {}),
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      audioStreamRef.current = stream
      if (!systemAudio) void refreshDevices()
      try {
        context = new AudioContext()
      } catch (caught) {
        cleanupLocal()
        throw caught
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      audioContextRef.current = context
      try {
        await context!.audioWorklet.addModule("/audio-worklet.js")
      } catch (caught) {
        cleanupLocal()
        throw caught
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      const sourceNode = context!.createMediaStreamSource(stream)
      analyser = context!.createAnalyser()
      analyser.fftSize = 512
      worklet = new AudioWorkletNode(context!, "justai-pcm-processor")
      const silentGain = context!.createGain()
      silentGain.gain.value = 0
      sourceNode.connect(analyser)
      sourceNode.connect(worklet)
      worklet.connect(silentGain)
      silentGain.connect(context.destination)
      analyserRef.current = analyser
      workletRef.current = worklet
      let sequence = 0
      let voiceUntil = 0
      const voiceThreshold = 0.01
      const voiceHangoverMs = 650
      worklet.port.onmessage = (message: MessageEvent<Float32Array>) => {
        if (!isCurrent()) return
        const samples = downsample(message.data, context!.sampleRate, 16000)
        const rms = calculateRMS(samples)
        const now = performance.now()
        if (rms >= voiceThreshold) voiceUntil = now + voiceHangoverMs
        if (now > voiceUntil) return
        const pcm = encodePCM16(samples)
        const frame = new ArrayBuffer(17 + pcm.byteLength)
        const view = new DataView(frame)
        view.setUint8(0, 1)
        view.setBigUint64(1, BigInt(Date.now()), true)
        view.setUint32(9, sequence, true)
        view.setUint32(13, 16000, true)
        new Uint8Array(frame, 17).set(new Uint8Array(pcm))
        sequence += 1
        socket.send(frame)
      }
      const levelBuffer = new Uint8Array(analyser.fftSize)
      levelTimer = window.setInterval(() => {
        if (!isCurrent()) return
        analyser.getByteTimeDomainData(levelBuffer)
        let total = 0
        levelBuffer.forEach((value) => {
          const normalized = (value - 128) / 128
          total += normalized * normalized
        })
        const nextLevel = Math.min(
          1,
          Math.sqrt(total / levelBuffer.length) * 3.2
        )
        setLevel(nextLevel)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "source.level", level: nextLevel })
          )
      }, 100)
      levelTimerRef.current = levelTimer
      try {
        await context!.resume()
      } catch (caught) {
        cleanupLocal()
        throw caught
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      if (session.recordAudio) {
        const recording = await api.post<{ recording: TranscriptionRecording }>(
          "/api/v1/transcription/recordings/start",
          {
            sessionId: session.id,
            sourceId: source.id,
            mimeType: "audio/webm;codecs=opus",
          }
        )
        if (!isCurrent()) {
          void api
            .post(
              `/api/v1/transcription/recordings/${recording.recording.id}/complete`
            )
            .catch(() => undefined)
          cleanupLocal()
          return
        }
        const recordingId = recording.recording.id
        recordingIdRef.current = recordingId
        recordingUploadQueueRef.current = Promise.resolve()
        const recorder = new MediaRecorder(stream, {
          mimeType: "audio/webm;codecs=opus",
        })
        let part = 0
        let uploads = Promise.resolve()
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return
          const currentPart = part
          part += 1
          uploads = uploads.then(async () => {
            await api.binary(
              `/api/v1/transcription/recordings/${recordingId}/parts/${currentPart}`,
              event.data
            )
          })
          recordingUploadQueueRef.current = uploads
        }
        recorder.onstop = () => completeRecording(recordingId, uploads)
        recorder.start(5000)
        mediaRecorderRef.current = recorder
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      setCapturing(true)
    },
    [closeCapture, completeRecording, deviceLabel, refreshDevices]
  )

  const startCapture = useCallback(
    async (session: TranscriptionSession, source: TranscriptionSource) => {
      closeCapture()
      const attempt = captureAttemptRef.current
      const ticketResponse = await api.post<{ ticket: string }>(
        "/api/v1/ws/tickets",
        {
          kind: "transcription-capture",
          sessionId: session.id,
          sourceId: source.id,
        }
      )
      if (captureAttemptRef.current !== attempt) return
      captureSourceIdRef.current = source.id
      const socket = new WebSocket(
        socketURL("/api/v1/ws/transcription", ticketResponse.ticket)
      )
      captureSocketRef.current = socket
      socket.onmessage = (message) => {
        if (captureAttemptRef.current !== attempt) return
        try {
          handleSocketEvent(JSON.parse(message.data) as SocketEvent)
        } catch {
          setError(
            "Received an invalid capture event from the transcription server."
          )
        }
      }
      socket.onerror = () => {
        if (captureAttemptRef.current === attempt) {
          setError("The audio capture connection could not be established.")
        }
      }
      let socketOpened = false
      let rejectOpen: ((reason?: unknown) => void) | null = null
      let openTimer: number | null = null
      await new Promise<void>((resolve, reject) => {
        rejectOpen = reject
        socket.onopen = () => {
          socketOpened = true
          rejectOpen = null
          if (openTimer !== null) window.clearTimeout(openTimer)
          resolve()
        }
        socket.onclose = () => {
          if (openTimer !== null) window.clearTimeout(openTimer)
          if (captureSocketRef.current === socket)
            captureSocketRef.current = null
          if (captureAttemptRef.current !== attempt) {
            resolve()
            return
          }
          if (!socketOpened) {
            rejectOpen?.(
              new Error(
                "The audio capture connection closed before connecting."
              )
            )
            return
          }
          reject(new Error("The audio capture connection closed."))
        }
        openTimer = window.setTimeout(() => {
          socket.close()
          reject(
            new Error("The audio capture socket took too long to connect.")
          )
        }, 15_000)
      })
      if (
        captureAttemptRef.current !== attempt ||
        socket.readyState !== WebSocket.OPEN
      ) {
        socket.close()
        return
      }
      socket.onclose = () => {
        if (captureAttemptRef.current !== attempt) return
        closeCapture()
        setError(
          "The audio capture connection dropped. Restart audio to reconnect."
        )
      }
      socket.send(
        JSON.stringify({
          type: "transcription.start",
          sessionId: session.id,
          sourceId: source.id,
        })
      )
      try {
        await beginAudio(socket, session, source, attempt)
      } catch (caught) {
        if (captureAttemptRef.current === attempt) closeCapture()
        throw caught
      }
    },
    [beginAudio, closeCapture, handleSocketEvent]
  )

  const loadSession = useCallback(
    async (id: string) => {
      const requestId = sessionLoadRef.current + 1
      sessionLoadRef.current = requestId
      const isCurrentRequest = () => sessionLoadRef.current === requestId
      setLoading(true)
      setError("")
      try {
        const next = await api.get<Snapshot>(
          `/api/v1/transcription/sessions/${id}`
        )
        if (!isCurrentRequest()) return
        const primarySource = next.sources[0]
        if (primarySource?.kind === "stream") {
          setCaptureMode("external")
          setExternalSourceType("stream")
        } else if (primarySource?.kind === "meeting-bot") {
          setCaptureMode("external")
          setExternalSourceType("meeting-bot")
        } else if (primarySource?.kind === "browser-system") {
          setCaptureMode("system-audio")
        } else if (primarySource?.kind === "browser") {
          setCaptureMode("microphone")
        }
        applySnapshot(next)
        setCreateOpen(false)
        await connectViewer(id)
        if (!isCurrentRequest()) return
        const requests = await api.get<{
          requests: TranscriptionJoinRequest[]
        }>(`/api/v1/transcription/sessions/${id}/join-requests`)
        if (!isCurrentRequest()) return
        setJoinRequests(requests.requests)
      } catch (caught) {
        if (!isCurrentRequest()) return
        setError(
          caught instanceof Error
            ? caught.message
            : "The transcription session could not be loaded."
        )
      } finally {
        if (isCurrentRequest()) setLoading(false)
      }
    },
    [applySnapshot, connectViewer]
  )

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      queueMicrotask(() => {
        if (cancelled) return
        closeSockets()
        pendingFinalSegmentsRef.current.clear()
        pendingSpeakerUpdatesRef.current.clear()
        setSnapshot(null)
        setPartial("")
        setPartialSourceId(null)
        setPartialSpeakerId(null)
        setCreateOpen(false)
      })
      return () => {
        cancelled = true
      }
    }
    queueMicrotask(() => {
      if (!cancelled) void loadSession(sessionId)
    })
    return () => {
      cancelled = true
      sessionLoadRef.current += 1
      closeSockets()
    }
  }, [closeSockets, loadSession, sessionId])

  useEffect(() => {
    if (!createSessionRequested || sessionId) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      openCreateWizard()
      onCreateSessionRequestHandled?.()
    })
    return () => {
      cancelled = true
    }
  }, [
    createSessionRequested,
    onCreateSessionRequestHandled,
    openCreateWizard,
    sessionId,
  ])

  const createSession = async () => {
    setStarting(true)
    setError("")
    try {
      const result = await api.post<{
        session: TranscriptionSession
        joinCode: string
        expiresAt: string
      }>("/api/v1/transcription/sessions", {
        kind: "live",
        title,
        language,
        recordAudio,
        transcriptionEndpointId: effectiveSelectedEndpoint,
        diarizationEndpointId: selectedDiarizationEndpoint || undefined,
        grammarEndpointId: effectiveGrammarEndpoint || undefined,
      })
      const createdSession = {
        ...result.session,
        joinCode: result.joinCode,
        joinCodeExpiresAt: result.expiresAt,
      }
      let createdSource: TranscriptionSource | null = null
      let createdBotSetup: BotSetup | null = null
      if (captureMode === "external" && externalSourceType === "stream") {
        const stream = await api.post<{
          source: TranscriptionSource
          stream?: { protocol?: string; status?: string }
        }>(
          `/api/v1/transcription/sessions/${result.session.id}/stream-sources`,
          {
            name: streamName.trim() || "Live stream",
            url: streamURL.trim(),
          }
        )
        createdSource = {
          ...stream.source,
          protocol: stream.stream?.protocol,
          transportStatus: stream.stream?.status,
        }
      } else if (
        captureMode === "external" &&
        externalSourceType === "meeting-bot"
      ) {
        createdBotSetup = await api.post<BotSetup>(
          `/api/v1/transcription/sessions/${result.session.id}/bot-sources`,
          {
            name: botName.trim() || "Meeting bot",
            platform: botPlatform,
            meetingUrl: botMeetingURL.trim() || undefined,
          }
        )
        createdSource = {
          ...createdBotSetup.source,
          platform: createdBotSetup.bot?.platform,
          transportStatus: createdBotSetup.bot?.status,
        }
      } else {
        const source = await api.post<{ source: TranscriptionSource }>(
          `/api/v1/transcription/sessions/${result.session.id}/sources`,
          {
            name: captureSourceName,
            kind: captureSourceKind,
            deviceLabel:
              captureMode === "microphone" ? selectedDeviceName : undefined,
          }
        )
        createdSource = source.source
      }
      const sessionWithExternalSource =
        captureMode === "external"
          ? { ...createdSession, status: "live" as const }
          : createdSession
      onSessionCreated(sessionWithExternalSource)
      setCreateOpen(false)
      const nextSnapshot: Snapshot = {
        session: sessionWithExternalSource,
        sources: createdSource ? [createdSource] : [],
        speakers: [],
        segments: [],
        recordings: [],
        annotations: [],
      }
      applySnapshot(nextSnapshot)
      if (createdSource && captureMode !== "external") {
        await startCapture(sessionWithExternalSource, createdSource)
        await api.post(
          `/api/v1/transcription/sessions/${result.session.id}/resume`
        )
      }
      if (createdBotSetup) {
        setBotSetup(createdBotSetup)
        setBotDialogOpen(true)
      }
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcription session could not be started."
      )
    } finally {
      setStarting(false)
    }
  }

  const ensureCapture = async () => {
    if (!snapshot || capturing) return
    if (
      captureMode === "external" ||
      snapshot.sources.some(
        (source) => source.kind === "stream" || source.kind === "meeting-bot"
      )
    ) {
      setError("Add a stream or meeting bot source to this room first.")
      return
    }
    try {
      let source = snapshot.sources.find(
        (item) => item.kind === captureSourceKind
      )
      if (!source) {
        const result = await api.post<{ source: TranscriptionSource }>(
          `/api/v1/transcription/sessions/${snapshot.session.id}/sources`,
          {
            name: captureSourceName,
            kind: captureSourceKind,
            deviceLabel:
              captureMode === "microphone" ? selectedDeviceName : undefined,
          }
        )
        source = result.source
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: [...current.sources, source as TranscriptionSource],
              }
            : current
        )
      }
      await startCapture(snapshot.session, source)
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/resume`
      )
      setSnapshot((current) =>
        current
          ? { ...current, session: { ...current.session, status: "live" } }
          : current
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The audio capture could not be started."
      )
    }
  }

  const pauseOrResume = async () => {
    if (!snapshot) return
    const hasExternalSource = snapshot.sources.some(
      (source) => source.kind === "stream" || source.kind === "meeting-bot"
    )
    try {
      const action = snapshot.session.status === "paused" ? "resume" : "pause"
      if (action === "pause" && !hasExternalSource) closeCapture()
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/${action}`
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                status: action === "pause" ? "paused" : "live",
              },
            }
          : current
      )
      if (action === "resume" && !hasExternalSource) await ensureCapture()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcription session could not be updated."
      )
    }
  }

  const stopSession = async () => {
    if (!snapshot) return
    try {
      closeCapture()
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/stop`
      )
      onSessionsChanged()
      await loadSession(snapshot.session.id)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcription session could not be stopped."
      )
    }
  }

  const refreshJoinRequests = async () => {
    if (!snapshot) return
    try {
      const result = await api.get<{ requests: TranscriptionJoinRequest[] }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/join-requests`
      )
      setJoinRequests(result.requests)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Join requests could not be refreshed."
      )
    }
  }

  const setJoinRequest = async (
    request: TranscriptionJoinRequest,
    status: "approve" | "deny"
  ) => {
    if (!snapshot) return
    try {
      await api.post(
        `/api/v1/transcription/join-requests/${request.id}/${status}`
      )
      await refreshJoinRequests()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The join request could not be updated."
      )
    }
  }

  const renameSpeaker = async (speakerId: string, displayName: string) => {
    if (!snapshot) return false
    const trimmedName = displayName.trim()
    if (!trimmedName) return false
    try {
      await api.patch(
        `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/${speakerId}`,
        { displayName: trimmedName }
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              speakers: current.speakers.map((item) =>
                item.id === speakerId
                  ? { ...item, displayName: trimmedName }
                  : item
              ),
            }
          : current
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The speaker name could not be saved."
      )
      return false
    }
    return true
  }

  const openWorkspaceSpeakerRename = (speaker: TranscriptionSpeaker) => {
    setWorkspaceSpeaker(speaker)
    setWorkspaceSpeakerName(speaker.displayName || speaker.label)
  }

  const saveWorkspaceSpeakerName = async () => {
    if (!workspaceSpeaker) return
    const trimmedName = workspaceSpeakerName.trim()
    if (!trimmedName) {
      setError("A speaker name is required.")
      return
    }
    setWorkspaceSpeakerSaving(true)
    try {
      const saved = await renameSpeaker(workspaceSpeaker.id, trimmedName)
      if (saved) {
        setWorkspaceSpeaker(null)
        setError("")
      }
    } finally {
      setWorkspaceSpeakerSaving(false)
    }
  }

  const copyJoinCode = async () => {
    if (!snapshot?.session.joinCode) return
    try {
      await navigator.clipboard.writeText(snapshot.session.joinCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The room code could not be copied."
      )
    }
  }

  const copyJoinLink = async () => {
    if (!snapshot?.session.joinCode) return
    try {
      const joinURL = new URL(
        transcriptionJoinPath(snapshot.session.joinCode),
        window.location.origin
      ).toString()
      await navigator.clipboard.writeText(joinURL)
      setJoinLinkCopied(true)
      window.setTimeout(() => setJoinLinkCopied(false), 1600)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The room link could not be copied."
      )
    }
  }

  const rotateJoinCode = async () => {
    if (!snapshot) return
    try {
      const result = await api.post<{ joinCode: string; expiresAt: string }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/join-code`
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                joinCode: result.joinCode,
                joinCodeExpiresAt: result.expiresAt,
              },
            }
          : current
      )
      setShareOpen(true)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "A room code could not be generated."
      )
    }
  }

  const addStreamSource = async () => {
    if (!snapshot || !streamURL.trim() || streamStarting) return
    setStreamStarting(true)
    setError("")
    try {
      const result = await api.post<{
        source: TranscriptionSource
        stream: { protocol: string; status: string }
      }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/stream-sources`,
        {
          name: streamName.trim() || "Live stream",
          url: streamURL.trim(),
        }
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              sources: [
                ...current.sources,
                {
                  ...result.source,
                  protocol: result.stream.protocol,
                  transportStatus: result.stream.status,
                },
              ],
              session: {
                ...current.session,
                status:
                  current.session.status === "waiting"
                    ? "live"
                    : current.session.status,
              },
            }
          : current
      )
      setStreamURL("")
      setStreamDialogOpen(false)
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The live stream could not be connected."
      )
    } finally {
      setStreamStarting(false)
    }
  }

  const createBotSource = async () => {
    if (!snapshot || botStarting) return
    setBotStarting(true)
    setError("")
    try {
      const result = await api.post<BotSetup>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/bot-sources`,
        {
          name: botName.trim() || "Meeting bot",
          platform: botPlatform,
          meetingUrl: botMeetingURL.trim() || undefined,
        }
      )
      setBotSetup(result)
      setBotMeetingURL("")
      setBotDialogOpen(true)
      const source = {
        ...result.source,
        platform: result.bot?.platform,
        transportStatus: result.bot?.status,
      }
      setSnapshot((current) =>
        current
          ? {
              ...current,
              sources: [...current.sources, source],
              session: {
                ...current.session,
                status:
                  current.session.status === "waiting"
                    ? "live"
                    : current.session.status,
              },
            }
          : current
      )
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The meeting bot source could not be created."
      )
    } finally {
      setBotStarting(false)
    }
  }

  const copyBotToken = async () => {
    if (!botSetup) return
    try {
      await navigator.clipboard.writeText(botSetup.token)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The bot token could not be copied."
      )
    }
  }

  const selectedWizardSource: SessionSourceChoice =
    captureMode === "external" ? externalSourceType : captureMode
  const selectedWizardSourceLabel =
    liveSessionSourceOptions.find(
      (option) => option.key === selectedWizardSource
    )?.label || "Microphone"
  const selectedEndpointName =
    transcriptionEndpoints.find(
      (endpoint) => endpoint.id === effectiveSelectedEndpoint
    )?.name || "No endpoint selected"
  const selectedDiarizationName =
    diarizationEndpoints.find(
      (endpoint) => endpoint.id === selectedDiarizationEndpoint
    )?.name || "Off"
  const sourceSetupReady =
    captureMode !== "external" ||
    externalSourceType === "meeting-bot" ||
    streamURL.trim().length > 0
  const canContinueWizard =
    createStep === 0 ||
    (createStep === 1 && sourceSetupReady) ||
    (createStep >= 2 && Boolean(effectiveSelectedEndpoint))
  const selectWizardSource = (choice: SessionSourceChoice) => {
    if (choice === "stream" || choice === "meeting-bot") {
      setCaptureMode("external")
      setExternalSourceType(choice)
      return
    }
    setCaptureMode(choice)
  }
  const goToNextWizardStep = () => {
    if (!canContinueWizard || createStep === 3) return
    setCreateStep((current) => (current + 1) as SessionWizardStep)
  }
  const goToPreviousWizardStep = () => {
    if (createStep === 0) return
    setCreateStep((current) => (current - 1) as SessionWizardStep)
  }
  const captureViewMode = snapshot
    ? resolveCaptureViewMode(snapshot, captureMode, externalSourceType)
    : "microphone"
  const workspaceMediaKind =
    snapshot?.session.status === "completed"
      ? snapshot.recordings.length > 0
        ? ("audio" as const)
        : ("none" as const)
      : ("none" as const)

  return (
    <div className="flex min-h-[calc(100svh-2rem)] w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Live transcription needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        <Empty className="min-h-[calc(100svh-8rem)] border-0">
          <EmptyHeader>
            <div className="mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Radio aria-hidden="true" />
            </div>
            <EmptyTitle>Listen to the room</EmptyTitle>
            <EmptyDescription>
              {sessions.length > 0
                ? "Select a session from the sidebar, or start a new room."
                : "Start a named session, capture browser audio, or connect an external stream or meeting bot."}
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={openCreateWizard}>
            <Play data-icon="inline-start" />
            New live session
          </Button>
        </Empty>
      ) : snapshot.session.status === "completed" ? (
        <>
          <section className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Check aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <Badge className="mb-2" variant="secondary">
                  Capture complete
                </Badge>
                <h1 className="text-lg font-semibold tracking-tight">
                  Your transcript is ready to review
                </h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Edit the wording, add notes, inspect speakers, generate
                  insights, or export the finished transcript from one shared
                  workspace.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {snapshot.segments.length} segments
              </Badge>
              <Badge variant="outline">
                {snapshot.recordings.length > 0
                  ? "Audio recording available"
                  : "Transcript only"}
              </Badge>
            </div>
          </section>
          <TranscriptWorkspace
            key={snapshot.session.id}
            currentTimeMs={workspaceTimeMs}
            mediaKind={workspaceMediaKind}
            onCurrentTimeChange={setWorkspaceTimeMs}
            onError={setError}
            onRefreshPlayback={async () => undefined}
            onRenameSpeaker={openWorkspaceSpeakerRename}
            onSnapshotChange={(updater) =>
              setSnapshot((current) =>
                current ? { ...current, ...updater(current) } : current
              )
            }
            onVideoDurationChange={setWorkspaceDurationMs}
            onVideoPlaybackError={setWorkspacePlaybackError}
            snapshot={snapshot}
            videoDurationMs={workspaceDurationMs}
            videoPlaybackError={workspacePlaybackError}
            videoRef={workspaceVideoRef}
          />
        </>
      ) : (
        <>
          {captureViewMode === "microphone" ? (
            <LiveTranscriptionOrbit
              capturing={capturing}
              canStartCapture
              joinRequests={joinRequests}
              level={level}
              loading={loading}
              onPauseOrResume={pauseOrResume}
              onRefreshJoinRequests={refreshJoinRequests}
              onRenameSpeaker={(speakerId, name) => {
                void renameSpeaker(speakerId, name)
              }}
              onSetJoinRequest={setJoinRequest}
              onShare={() =>
                void (snapshot.session.joinCode
                  ? setShareOpen(true)
                  : rotateJoinCode())
              }
              onStartCapture={ensureCapture}
              onStopSession={stopSession}
              partial={partial}
              partialSourceId={partialSourceId}
              partialSpeakerId={partialSpeakerId}
              snapshot={snapshot}
              user={user}
            />
          ) : (
            <LiveTranscriptionSourceView
              capturing={capturing}
              joinRequests={joinRequests}
              level={level}
              loading={loading}
              mode={captureViewMode}
              onPauseOrResume={pauseOrResume}
              onRefreshJoinRequests={refreshJoinRequests}
              onRenameSpeaker={(speakerId, name) => {
                void renameSpeaker(speakerId, name)
              }}
              onSetJoinRequest={setJoinRequest}
              onShare={() =>
                void (snapshot.session.joinCode
                  ? setShareOpen(true)
                  : rotateJoinCode())
              }
              onStartCapture={ensureCapture}
              onStopSession={stopSession}
              partial={partial}
              partialSourceId={partialSourceId}
              partialSpeakerId={partialSpeakerId}
              snapshot={snapshot}
              user={user}
            />
          )}
          {captureViewMode === "microphone" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Tv aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Capture a live stream</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Add an authorized HLS, HTTP(S), or RTMP(S) audio URL.
                      JustAI keeps the decoder and provider connection alive
                      while it reconnects.
                    </p>
                  </div>
                </div>
                <Button
                  className="w-fit"
                  onClick={() => setStreamDialogOpen(true)}
                  size="sm"
                  variant="outline"
                >
                  <Tv data-icon="inline-start" /> Add stream source
                </Button>
              </div>
              <div className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Bot aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Connect a meeting bot</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Create a scoped ingress token for a Zoom, Meet, Teams, or
                      custom adapter. The adapter sends audio into this room.
                    </p>
                  </div>
                </div>
                <Button
                  className="w-fit"
                  onClick={() => {
                    setBotSetup(null)
                    setBotDialogOpen(true)
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Bot data-icon="inline-start" /> Add meeting bot
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <Dialog
        open={createOpen && !sessionId}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (open) {
            setCreateStep(0)
            void refreshDevices()
          }
        }}
      >
        <DialogContent className="max-h-[min(760px,calc(100svh-2rem))] overflow-y-auto p-5 sm:max-w-2xl sm:p-6">
          <DialogHeader className="gap-4">
            <div className="flex items-start justify-between gap-4 pr-6">
              <div className="min-w-0">
                <DialogTitle>New live session</DialogTitle>
                <DialogDescription className="mt-1 max-w-xl">
                  A short setup tour helps you choose the right audio path
                  before the room starts listening.
                </DialogDescription>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[0.625rem] font-medium text-muted-foreground">
                Step {createStep + 1} of {liveSessionWizardSteps.length}
              </span>
            </div>
            <div
              aria-label="Live session setup progress"
              className="grid grid-cols-4 gap-1.5"
            >
              {liveSessionWizardSteps.map((step, index) => {
                const active = createStep === index
                const complete = createStep > index
                return (
                  <button
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex min-w-0 flex-col gap-1 rounded-lg p-1.5 text-left transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/30",
                      active
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted/60",
                      index > createStep && "cursor-default opacity-60"
                    )}
                    disabled={index > createStep}
                    key={step.label}
                    onClick={() => {
                      if (index <= createStep)
                        setCreateStep(index as SessionWizardStep)
                    }}
                    type="button"
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.625rem] font-semibold",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : complete
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-border bg-background"
                        )}
                      >
                        {complete ? <Check className="size-3" /> : index + 1}
                      </span>
                      <span className="truncate text-[0.625rem] font-medium">
                        {step.label}
                      </span>
                    </span>
                    <span className="truncate pl-6 text-[0.625rem] text-muted-foreground">
                      {step.description}
                    </span>
                  </button>
                )
              })}
            </div>
          </DialogHeader>

          {createStep === 0 ? (
            <div
              className="flex animate-in flex-col gap-4 duration-200 fade-in-0 slide-in-from-right-1 motion-reduce:animate-none"
              key="source-step"
            >
              <div>
                <p className="text-sm font-medium">
                  What do you want to capture?
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick the source that already has the audio. You can add more
                  sources after the room is created.
                </p>
              </div>
              <FieldSet>
                <FieldLegend className="sr-only">Audio source</FieldLegend>
                <div
                  aria-label="Audio source"
                  className="grid gap-2 sm:grid-cols-2"
                  role="radiogroup"
                >
                  {liveSessionSourceOptions.map((option) => {
                    const selected = selectedWizardSource === option.key
                    const OptionIcon = option.icon
                    return (
                      <button
                        aria-checked={selected}
                        className={cn(
                          "group flex min-h-28 flex-col gap-3 rounded-2xl border bg-card p-3 text-left transition-[border-color,background-color,transform] duration-180 ease-out hover:border-primary/40 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30 active:translate-y-px",
                          selected &&
                            "border-primary bg-primary/5 ring-1 ring-primary/20"
                        )}
                        key={option.key}
                        onClick={() => selectWizardSource(option.key)}
                        role="radio"
                        type="button"
                      >
                        <span
                          className={cn(
                            "flex size-8 items-center justify-center rounded-xl transition-colors duration-150",
                            selected
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground group-hover:text-foreground"
                          )}
                        >
                          <OptionIcon aria-hidden="true" />
                        </span>
                        <span className="flex flex-col gap-1">
                          <span className="text-sm font-medium">
                            {option.label}
                          </span>
                          <span className="text-xs leading-relaxed text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </FieldSet>
              <Alert>
                <ShieldCheck aria-hidden="true" />
                <AlertTitle>Audio stays under your control</AlertTitle>
                <AlertDescription>
                  Browser sources ask for permission only when you start. Direct
                  URLs are encrypted at rest, and meeting bots receive a scoped
                  ingest credential.
                </AlertDescription>
              </Alert>
            </div>
          ) : createStep === 1 ? (
            <div
              className="flex animate-in flex-col gap-4 duration-200 fade-in-0 slide-in-from-right-1 motion-reduce:animate-none"
              key="setup-step"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  {selectedWizardSource === "microphone" ? (
                    <Mic aria-hidden="true" />
                  ) : selectedWizardSource === "system-audio" ? (
                    <MonitorUp aria-hidden="true" />
                  ) : selectedWizardSource === "stream" ? (
                    <Tv aria-hidden="true" />
                  ) : (
                    <Bot aria-hidden="true" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    Set up {selectedWizardSourceLabel.toLowerCase()}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedWizardSource === "microphone"
                      ? "Choose the microphone this browser should stream."
                      : selectedWizardSource === "system-audio"
                        ? "Choose a tab, window, or screen in the browser picker."
                        : selectedWizardSource === "stream"
                          ? "Point JustAI at an authorized live media feed."
                          : "Prepare a platform adapter or desktop companion to send meeting audio."}
                  </p>
                </div>
              </div>

              {selectedWizardSource === "microphone" ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel>Microphone</FieldLabel>
                    <Select
                      onValueChange={(value) =>
                        setDeviceLabel(value === "default" ? "" : (value ?? ""))
                      }
                      value={deviceLabel || "default"}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="System default microphone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Audio inputs</SelectLabel>
                          <SelectItem value="default">
                            System default
                          </SelectItem>
                          {devices.map((device, index) => (
                            <SelectItem
                              key={device.deviceId || `audio-input-${index}`}
                              value={device.deviceId}
                            >
                              {device.label || `Microphone ${index + 1}`}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Permission is requested only after you press Start
                      session.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              ) : selectedWizardSource === "system-audio" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3 rounded-2xl border bg-muted/20 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <MonitorUp className="text-primary" />
                      Share audio from your browser
                    </div>
                    <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                      <div className="flex gap-2">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-[0.625rem] font-semibold text-foreground">
                          1
                        </span>
                        <span>Keep the tab, window, or screen open.</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-[0.625rem] font-semibold text-foreground">
                          2
                        </span>
                        <span>Choose it in the native share picker.</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-[0.625rem] font-semibold text-foreground">
                          3
                        </span>
                        <span>Turn on Share audio before confirming.</span>
                      </div>
                    </div>
                  </div>
                  <Alert>
                    <AudioLines aria-hidden="true" />
                    <AlertTitle>Great for livestreams</AlertTitle>
                    <AlertDescription>
                      Open YouTube, a TV livestream, or a webinar in a tab, then
                      share that tab’s audio. JustAI does not need the page URL.
                    </AlertDescription>
                  </Alert>
                </div>
              ) : selectedWizardSource === "stream" ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="session-stream-name">
                      Source name
                    </FieldLabel>
                    <Input
                      id="session-stream-name"
                      onChange={(event) => setStreamName(event.target.value)}
                      value={streamName}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="session-stream-url">
                      Stream URL
                    </FieldLabel>
                    <Input
                      id="session-stream-url"
                      onChange={(event) => setStreamURL(event.target.value)}
                      placeholder="https://example.com/live/playlist.m3u8"
                      type="url"
                      value={streamURL}
                    />
                    <FieldDescription>
                      Use an authorized HLS, direct HTTP(S), RTMP(S), or audio
                      feed URL. YouTube watch-page URLs are not direct media
                      URLs.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              ) : (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="session-bot-name">
                      Source name
                    </FieldLabel>
                    <Input
                      id="session-bot-name"
                      onChange={(event) => setBotName(event.target.value)}
                      value={botName}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Meeting platform</FieldLabel>
                    <Select
                      onValueChange={(value) =>
                        setBotPlatform(value ?? "generic")
                      }
                      value={botPlatform}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose a platform" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Adapter type</SelectLabel>
                          <SelectItem value="generic">
                            Custom / desktop adapter
                          </SelectItem>
                          <SelectItem value="zoom">Zoom</SelectItem>
                          <SelectItem value="google-meet">
                            Google Meet
                          </SelectItem>
                          <SelectItem value="microsoft-teams">
                            Microsoft Teams
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="session-bot-url">
                      Meeting URL{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Input
                      id="session-bot-url"
                      onChange={(event) => setBotMeetingURL(event.target.value)}
                      placeholder="https://…"
                      type="url"
                      value={botMeetingURL}
                    />
                    <FieldDescription>
                      Stored encrypted for your adapter. JustAI will not sign in
                      to a third-party meeting for you.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              )}
            </div>
          ) : createStep === 2 ? (
            <div
              className="flex animate-in flex-col gap-4 duration-200 fade-in-0 slide-in-from-right-1 motion-reduce:animate-none"
              key="options-step"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Settings2 aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">Tune the room</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    These settings control how JustAI transcribes, labels, and
                    retains this session.
                  </p>
                </div>
              </div>
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-[1.5fr_0.75fr]">
                  <Field>
                    <FieldLabel htmlFor="session-title">
                      Session name
                    </FieldLabel>
                    <Input
                      id="session-title"
                      onChange={(event) => setTitle(event.target.value)}
                      value={title}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="session-language">Language</FieldLabel>
                    <Input
                      id="session-language"
                      onChange={(event) =>
                        setLanguage(event.target.value || "auto")
                      }
                      placeholder="auto"
                      value={language}
                    />
                    <FieldDescription>BCP-47 code or auto.</FieldDescription>
                  </Field>
                </div>
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
                  <FieldDescription>
                    Native providers use Realtime WebSockets. Whisper-style
                    gateways use rolling HTTP chunks.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Diarization endpoint</FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      setSelectedDiarizationEndpoint(
                        value === "none" ? "" : (value ?? "")
                      )
                    }
                    value={selectedDiarizationEndpoint || "none"}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Optional speaker separation" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Speaker providers</SelectLabel>
                        <SelectItem value="none">
                          No speaker separation
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
                    Speaker labels arrive after a short rolling audio window.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Grammar polish</FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      setSelectedGrammarEndpoint(
                        value === "none" ? "" : (value ?? "")
                      )
                    }
                    value={selectedGrammarEndpoint || "none"}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Optional grammar polish" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Writing providers</SelectLabel>
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
                    You can generate the polished version from the transcript
                    workspace after capture.
                  </FieldDescription>
                </Field>
                <div className="flex items-center justify-between rounded-xl border bg-muted/20 p-3">
                  <div>
                    <p className="text-sm font-medium">Record source audio</p>
                    <p className="text-xs text-muted-foreground">
                      Encrypted, source-separated tracks. Default retention: 30
                      days.
                    </p>
                  </div>
                  <Switch
                    aria-label="Record source audio"
                    checked={recordAudio}
                    onCheckedChange={setRecordAudio}
                  />
                </div>
              </FieldGroup>
            </div>
          ) : (
            <div
              className="flex animate-in flex-col gap-4 duration-200 fade-in-0 slide-in-from-right-1 motion-reduce:animate-none"
              key="review-step"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Sparkles aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">Everything looks ready</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Review the first source and room settings, then start when
                    you are ready.
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex min-w-0 items-start gap-3 rounded-xl border bg-muted/20 p-3">
                  <AudioLines className="mt-0.5 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      Audio source
                    </p>
                    <p className="truncate text-sm font-medium">
                      {selectedWizardSourceLabel}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {selectedWizardSource === "microphone"
                        ? selectedDeviceName
                        : selectedWizardSource === "system-audio"
                          ? "Browser share picker"
                          : selectedWizardSource === "stream"
                            ? streamName.trim() || "Live stream"
                            : `${botPlatformLabels[botPlatform] || "Meeting bot"} adapter`}
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 items-start gap-3 rounded-xl border bg-muted/20 p-3">
                  <Settings2 className="mt-0.5 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      Transcription
                    </p>
                    <p className="truncate text-sm font-medium">
                      {selectedEndpointName}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {language || "auto"} · speakers {selectedDiarizationName} ·
                      polish {selectedGrammarName}
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 items-start gap-3 rounded-xl border bg-muted/20 p-3">
                  <Users className="mt-0.5 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Room</p>
                    <p className="truncate text-sm font-medium">
                      {title.trim() || "Room session"}
                    </p>
                    <div className="mt-1">
                      <Badge variant={recordAudio ? "secondary" : "outline"}>
                        {recordAudio ? "Recording enabled" : "Recording off"}
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex min-w-0 items-start gap-3 rounded-xl border bg-muted/20 p-3">
                  <ShieldCheck className="mt-0.5 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      Privacy note
                    </p>
                    <p className="text-sm font-medium">
                      {selectedWizardSource === "system-audio"
                        ? "You choose what to share"
                        : selectedWizardSource === "meeting-bot"
                          ? "Bot token shown once"
                          : selectedWizardSource === "stream"
                            ? "Stream URL encrypted"
                            : "Permission requested on start"}
                    </p>
                  </div>
                </div>
              </div>
              <Alert>
                <ShieldCheck aria-hidden="true" />
                <AlertTitle>What happens next</AlertTitle>
                <AlertDescription>
                  {selectedWizardSource === "system-audio"
                    ? "The browser opens its native share picker. Choose the tab or window and enable Share audio."
                    : selectedWizardSource === "meeting-bot"
                      ? "The room starts first, then JustAI shows a one-time ingest token for your adapter. It does not automatically join the third-party meeting."
                      : selectedWizardSource === "stream"
                        ? "JustAI starts the decoder and reconnects automatically when the authorized live source or provider briefly drops."
                        : "The browser asks for microphone permission, then audio begins flowing into the room."}
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter className="items-center border-t pt-4 sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <Progress
                aria-label="Session setup progress"
                className="w-24"
                value={((createStep + 1) / liveSessionWizardSteps.length) * 100}
              />
              <span className="shrink-0 text-[0.625rem] text-muted-foreground tabular-nums">
                {createStep + 1}/{liveSessionWizardSteps.length}
              </span>
            </div>
            <div className="flex items-center justify-end gap-2">
              {createStep > 0 ? (
                <Button onClick={goToPreviousWizardStep} variant="outline">
                  <ArrowLeft data-icon="inline-start" /> Back
                </Button>
              ) : (
                <Button onClick={() => setCreateOpen(false)} variant="outline">
                  Cancel
                </Button>
              )}
              {createStep < 3 ? (
                <Button
                  disabled={!canContinueWizard}
                  onClick={goToNextWizardStep}
                >
                  Continue <ArrowRight data-icon="inline-end" />
                </Button>
              ) : (
                <Button
                  disabled={starting || !effectiveSelectedEndpoint}
                  onClick={() => void createSession()}
                >
                  {starting ? (
                    <>
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                      Starting…
                    </>
                  ) : (
                    <>
                      <Play data-icon="inline-start" /> Start session
                    </>
                  )}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={streamDialogOpen} onOpenChange={setStreamDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Capture a live stream</DialogTitle>
            <DialogDescription>
              Paste a stream URL that JustAI is authorized to access. HLS
              playlists and direct HTTP(S)/RTMP(S) audio feeds are supported; a
              YouTube watch-page URL is not a media stream URL.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="stream-source-name">Source name</FieldLabel>
              <Input
                id="stream-source-name"
                onChange={(event) => setStreamName(event.target.value)}
                value={streamName}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="stream-source-url">Stream URL</FieldLabel>
              <Input
                id="stream-source-url"
                onChange={(event) => setStreamURL(event.target.value)}
                placeholder="https://example.com/live/playlist.m3u8"
                type="url"
                value={streamURL}
              />
              <FieldDescription>
                The backend keeps this URL encrypted and does not expose it in
                snapshots or source lists.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              onClick={() => setStreamDialogOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={streamStarting || !streamURL.trim()}
              onClick={() => void addStreamSource()}
            >
              {streamStarting ? (
                <>
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                  Connecting…
                </>
              ) : (
                <>
                  <Tv data-icon="inline-start" /> Connect stream
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={botDialogOpen} onOpenChange={setBotDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Connect a meeting bot</DialogTitle>
            <DialogDescription>
              Create a source credential for a platform adapter or desktop
              companion. JustAI handles transcription after the adapter sends
              its meeting audio.
            </DialogDescription>
          </DialogHeader>
          {botSetup ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Ingest token</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      This is shown once. Store it in the adapter’s secret
                      manager.
                    </p>
                  </div>
                  <Button
                    aria-label="Copy bot ingest token"
                    onClick={() => void copyBotToken()}
                    size="icon-sm"
                    variant="outline"
                  >
                    <Copy />
                  </Button>
                </div>
                <code className="mt-3 block overflow-x-auto rounded-lg bg-background p-3 text-xs break-all">
                  {botSetup.token}
                </code>
              </div>
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                <p>
                  1. POST to <code>{botSetup.ticketPath}</code> with
                  <code> Authorization: Bearer &lt;token&gt;</code>.
                </p>
                <p>
                  2. Open{" "}
                  <code>{botSetup.websocketPath}?ticket=&lt;ticket&gt;</code>.
                </p>
                <p>
                  3. Send <code>transcription.start</code>, then binary PCM16
                  frames using the existing <code>{botSetup.protocol}</code>{" "}
                  wire format. Send <code>transcription.stop</code> when the
                  meeting ends.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setBotDialogOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bot-source-name">Source name</FieldLabel>
                <Input
                  id="bot-source-name"
                  onChange={(event) => setBotName(event.target.value)}
                  value={botName}
                />
              </Field>
              <Field>
                <FieldLabel>Meeting platform</FieldLabel>
                <Select
                  onValueChange={(value) => setBotPlatform(value ?? "generic")}
                  value={botPlatform}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a platform" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Adapter type</SelectLabel>
                      <SelectItem value="generic">
                        Custom / desktop adapter
                      </SelectItem>
                      <SelectItem value="zoom">Zoom</SelectItem>
                      <SelectItem value="google-meet">Google Meet</SelectItem>
                      <SelectItem value="microsoft-teams">
                        Microsoft Teams
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="bot-meeting-url">
                  Meeting URL{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input
                  id="bot-meeting-url"
                  onChange={(event) => setBotMeetingURL(event.target.value)}
                  placeholder="https://…"
                  type="url"
                  value={botMeetingURL}
                />
                <FieldDescription>
                  Saved encrypted for the adapter configuration; JustAI does not
                  automatically sign in to third-party meetings.
                </FieldDescription>
              </Field>
              <DialogFooter>
                <Button
                  onClick={() => setBotDialogOpen(false)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={botStarting}
                  onClick={() => void createBotSource()}
                >
                  {botStarting ? (
                    <>
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                      Creating…
                    </>
                  ) : (
                    <>
                      <Bot data-icon="inline-start" /> Create bot source
                    </>
                  )}
                </Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Join this room</DialogTitle>
            <DialogDescription>
              Share this persistent link. The microphone connects only after you
              approve the request here.
            </DialogDescription>
          </DialogHeader>
          {snapshot?.session.joinCode ? (
            <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-muted/30 p-3">
              <code className="min-w-0 flex-1 text-xs break-all text-muted-foreground">
                {new URL(
                  transcriptionJoinPath(snapshot.session.joinCode),
                  typeof window === "undefined"
                    ? "http://localhost"
                    : window.location.origin
                ).toString()}
              </code>
              <Button
                aria-label="Copy room link"
                onClick={() => void copyJoinLink()}
                size="icon-sm"
                variant="outline"
              >
                {joinLinkCopied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-xl border bg-muted/30 p-4">
            <span className="font-mono text-2xl font-semibold tracking-[0.32em]">
              {snapshot?.session.joinCode ?? "--------"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void rotateJoinCode()}
                size="sm"
                variant="outline"
              >
                New code
              </Button>
              {snapshot?.session.joinCode && (
                <Button
                  aria-label="Copy room code"
                  onClick={() => void copyJoinCode()}
                  size="icon-sm"
                  variant="outline"
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShareOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(workspaceSpeaker)}
        onOpenChange={(open) => {
          if (!open && !workspaceSpeakerSaving) setWorkspaceSpeaker(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename speaker</DialogTitle>
            <DialogDescription>
              This name is used throughout the finished transcript and its
              exports.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="workspace-speaker-name">Name</FieldLabel>
              <Input
                autoFocus
                id="workspace-speaker-name"
                onChange={(event) => setWorkspaceSpeakerName(event.target.value)}
                value={workspaceSpeakerName}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              disabled={workspaceSpeakerSaving}
              onClick={() => setWorkspaceSpeaker(null)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={workspaceSpeakerSaving || !workspaceSpeakerName.trim()}
              onClick={() => void saveWorkspaceSpeakerName()}
            >
              {workspaceSpeakerSaving ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function resolveCaptureViewMode(
  snapshot: Snapshot,
  fallbackMode: CaptureMode,
  fallbackExternalSourceType: ExternalSourceType
): "microphone" | LiveTranscriptionCaptureViewMode {
  const primarySource = snapshot.sources[0]
  if (primarySource?.kind === "stream") return "stream"
  if (primarySource?.kind === "meeting-bot") return "meeting-bot"
  if (primarySource?.kind === "browser-system") return "browser-system"
  if (primarySource?.kind === "browser") return "microphone"
  if (fallbackMode === "external") return fallbackExternalSourceType
  return fallbackMode === "system-audio" ? "browser-system" : "microphone"
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
  if (chunked) return "HTTP chunks"
  return "Realtime"
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
  ) {
    return false
  }
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "realtime-transcription")
  ) {
    return false
  }
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
    (capability === "realtime-transcription" || capability === "diarization") &&
    (endpoint.providerType === "openai" || endpoint.providerType === "gemini")
  )
}
