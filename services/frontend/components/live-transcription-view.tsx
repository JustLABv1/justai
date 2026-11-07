"use client"

import { Spinner } from "@/components/panelui/spinner"
import { ChoiceCards } from "@/components/panelui/choice-cards"
import { Alert as PuAlert } from "@/components/panelui/alert"
import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Bot,
  CalendarDays,
  Check,
  Copy,
  ChevronDown,
  Mic,
  MonitorUp,
  Play,
  ShieldCheck,
  Tv,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import Link from "next/link"
import { VideoTranscriptionLibrary } from "@/components/video-transcription-library"
import { LiveProcessingSettings } from "@/components/live-processing-settings"
import { LiveTranscriptProcessingPanel } from "@/components/live-transcript-processing-panel"
import type { LiveTranscriptionSnapshot } from "@/components/live-transcription-orbit"
import { LiveTranscriptionConversationView } from "@/components/live-transcription-conversation-view"
import type { LiveTranscriptionCaptureViewMode } from "@/components/live-transcription-source-view"
import { TranscriptionCreationFlow } from "@/components/transcription-creation-flow"
import { TranscriptWorkspace } from "@/components/transcript-workspace"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/panelui/button"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldDescription, FieldLabel } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { Input } from "@/components/panelui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {} from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectGroupLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import { languageItemsFor } from "@/lib/transcription-languages"
import { cn } from "@/lib/utils"
import { api, eventStreamURL } from "@/lib/api"
import { SSETransport } from "@/lib/sse-transport"
import type { SSEConnectionState } from "@/lib/sse-transport"
import { initialRealtimeState } from "@/components/realtime-connection-status"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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

type Snapshot = LiveTranscriptionSnapshot

type SocketEvent = {
  type: string
  data?: Record<string, unknown>
}

type CaptureMode = "microphone" | "system-audio" | "external"
type ExternalSourceType = "stream" | "meeting-bot"
type SessionWizardStep = 0 | 1 | 2
type SessionSourceChoice =
  "microphone" | "system-audio" | "stream" | "meeting-bot"

const liveSessionWizardStepsMessages = [
  { label: "Source" },
  { label: "Setup" },
  { label: "Options" },
] as const

function localDateTimeValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

function parseLocalDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const result = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  )
  return Number.isNaN(result.getTime()) ? null : result
}

function formatScheduleDateTime(value: string) {
  const date = parseLocalDateTime(value)
  if (!date) return "Select date and time"
  return `${String(date.getDate()).padStart(2, "0")}.${String(
    date.getMonth() + 1
  ).padStart(2, "0")}.${date.getFullYear()} · ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function updateLocalDateTime(
  value: string,
  update: Partial<{
    date: Date
    hour: number
    minute: number
  }>
) {
  const current = parseLocalDateTime(value) ?? new Date()
  const date = update.date ?? current
  return localDateTimeValue(
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      update.hour ?? current.getHours(),
      update.minute ?? current.getMinutes()
    )
  )
}

function isYouTubePageURL(value: string) {
  try {
    const host = new URL(value.trim()).hostname
      .toLowerCase()
      .replace(/^www\./, "")
    return [
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
    ].includes(host)
  } catch {
    return false
  }
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-5", className)} {...props} />
}

function DialogError({ message }: { message: string }) {
  const { t } = useTranslations()

  return (
    <Alert variant="destructive">
      <AlertTitle>{t("Live transcription needs attention")}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

const youtubeCaptureGuidance =
  "A YouTube watch page must be captured from the browser. Choose Browser tab or system, then select the YouTube tab and enable Share audio."

function ScheduleDateTimePicker({
  idPrefix,
  label,
  value,
  minimum,
  optional = false,
  onChange,
}: {
  idPrefix: string
  label: string
  value: string
  minimum?: string
  optional?: boolean
  onChange: (value: string) => void
}) {
  const { t } = useTranslations()

  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Browser time zone"
  const selected = parseLocalDateTime(value)
  const minimumDate = minimum ? parseLocalDateTime(minimum) : undefined
  const hours = Array.from({ length: 24 }, (_, hour) => hour)
  const minutes = Array.from({ length: 60 }, (_, minute) => minute)

  return (
    <Field>
      <FieldLabel>
        {label}
        {optional ? " (optional)" : ""}
      </FieldLabel>
      <div className="flex flex-col gap-2">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                aria-label={t("{value0}: select date and time", {
                  value0: label,
                })}
                className="w-full justify-start"
                id={`${idPrefix}-trigger`}
                variant="outline"
              >
                <CalendarDays data-icon="inline-start" />
                {formatScheduleDateTime(value)}
              </Button>
            }
          />
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              disabled={minimumDate ? { before: minimumDate } : undefined}
              mode="single"
              onSelect={(date) => {
                if (date) onChange(updateLocalDateTime(value, { date }))
              }}
              selected={selected ?? undefined}
            />
          </PopoverContent>
        </Popover>
        <div className="grid grid-cols-2 gap-2">
          <Select
            onValueChange={(next) => {
              if (next)
                onChange(updateLocalDateTime(value, { hour: Number(next) }))
            }}
            value={
              selected
                ? String(selected.getHours()).padStart(2, "0")
                : undefined
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("Hour")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectGroupLabel>{t("Hour (24-hour)")}</SelectGroupLabel>
                {hours.map((hour) => (
                  <SelectItem key={hour} value={String(hour).padStart(2, "0")}>
                    {String(hour).padStart(2, "0")}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            onValueChange={(next) => {
              if (next)
                onChange(updateLocalDateTime(value, { minute: Number(next) }))
            }}
            value={
              selected
                ? String(selected.getMinutes()).padStart(2, "0")
                : undefined
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("Minute")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectGroupLabel>{t("Minute")}</SelectGroupLabel>
                {minutes.map((minute) => (
                  <SelectItem
                    key={minute}
                    value={String(minute).padStart(2, "0")}
                  >
                    {String(minute).padStart(2, "0")}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <FieldDescription>
          {t("Local browser time ·")} {timeZone} {t("· 24-hour format")}
        </FieldDescription>
      </div>
    </Field>
  )
}

function StreamScheduleFields({
  idPrefix,
  scheduled,
  start,
  end,
  onScheduledChange,
  onStartChange,
  onEndChange,
}: {
  idPrefix: string
  scheduled: boolean
  start: string
  end: string
  onScheduledChange: (checked: boolean) => void
  onStartChange: (value: string) => void
  onEndChange: (value: string) => void
}) {
  const { t } = useTranslations()

  return (
    <>
      <Frame>
        <Frame.Panel>
          <Frame.Row>
            <Frame.Content>
              <Frame.Title as="p">{t("Schedule capture")}</Frame.Title>
              <Frame.Description>
                {t("JustAI connects automatically at the selected local time.")}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Switch
                aria-label={t("Schedule livestream capture")}
                checked={scheduled}
                onCheckedChange={onScheduledChange}
              />
            </Frame.Actions>
          </Frame.Row>
        </Frame.Panel>
      </Frame>
      {scheduled ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <ScheduleDateTimePicker
            idPrefix={`${idPrefix}-scheduled-start`}
            label={t("Start time")}
            minimum={localDateTimeValue(new Date())}
            onChange={onStartChange}
            value={start}
          />
          <ScheduleDateTimePicker
            idPrefix={`${idPrefix}-scheduled-end`}
            label={t("End time")}
            minimum={start || localDateTimeValue(new Date())}
            onChange={onEndChange}
            optional
            value={end}
          />
          <p className="text-xs leading-4 text-muted-foreground sm:col-span-2">
            {t(
              "Without an end time, capture stops when the stream ends. Temporary disconnects are retried for 15 minutes; the eight-hour session limit remains the final safeguard."
            )}
          </p>
        </div>
      ) : null}
    </>
  )
}

const liveSessionSourceOptionsMessages: Array<{
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
    label: "Livestream link",
    description: "Paste a livestream webpage or direct stream link.",
  },
  {
    key: "meeting-bot",
    icon: Bot,
    label: "Meeting bot",
    description: "Receive audio from Zoom, Meet, Teams, or a custom adapter.",
  },
]

type BotSetup = {
  source: TranscriptionSource
  bot?: { platform?: string; status?: string }
  token: string
  protocol: string
  ticketPath: string
  streamPath: string
  warning: string
}

export function LiveTranscriptionView({
  sessionId,
  sessions,
  endpoints,
  user,
  onSessionCreated,
  onSessionsChanged,
  onStartChat,
  createSessionRequested = false,
  onCreateSessionRequestHandled,
}: {
  sessionId: string | null
  sessions: TranscriptionSession[]
  endpoints: Endpoint[]
  user: User
  onSessionCreated: (session: TranscriptionSession) => void
  onSessionsChanged: () => void
  onStartChat: (sessionId: string) => Promise<void>
  createSessionRequested?: boolean
  onCreateSessionRequestHandled?: () => void
}) {
  const liveSessionSourceOptions = useTranslatedConfig(
    liveSessionSourceOptionsMessages
  )
  const liveSessionWizardSteps = useTranslatedConfig(
    liveSessionWizardStepsMessages
  )

  const { t } = useTranslations()

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const processingSessionId = snapshot?.session.id
  const processingSessionStatus = snapshot?.session.status
  const processingStatus = snapshot?.liveProcessing?.status
  useEffect(() => {
    if (!processingSessionId || processingSessionStatus !== "completed") return
    const id = processingSessionId
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const next = await api.get<Snapshot>(
          `/api/v1/transcription/sessions/${id}`
        )
        if (stopped) return
        setSnapshot((current) => (current?.session.id === id ? next : current))
        if (
          !next.liveProcessing ||
          next.liveProcessing.status === "completed" ||
          next.liveProcessing.status === "failed"
        )
          return
      } catch {
        /* Retry transient snapshot errors without hiding the transcript. */
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 3000)
    }
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [processingSessionId, processingSessionStatus, processingStatus])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [transportStatus, setTransportStatus] =
    useState<SSEConnectionState>(initialRealtimeState)
  const [interruptionAt, setInterruptionAt] = useState<Date | null>(null)
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
  const languageItems = useMemo(() => languageItemsFor(language), [language])
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
  const [streamName, setStreamName] = useState(t("Live stream"))
  const [streamURL, setStreamURL] = useState("")
  const [streamScheduled, setStreamScheduled] = useState(false)
  const [streamScheduledStart, setStreamScheduledStart] = useState("")
  const [streamScheduledEnd, setStreamScheduledEnd] = useState("")
  const [streamStarting, setStreamStarting] = useState(false)
  const [streamCheck, setStreamCheck] = useState<{
    url: string
    name?: string
    error?: string
  } | null>(null)
  const checkedStreamReady =
    streamCheck?.url === streamURL.trim() && Boolean(streamCheck.name)
  useEffect(() => {
    let cancelled = false
    const url = streamURL.trim()
    if (!url) return
    const timer = window.setTimeout(() => {
      void api
        .post<{ name: string; kind: string }>(
          "/api/v1/transcription/stream-sources/resolve",
          { url }
        )
        .then((result) => {
          if (!cancelled) setStreamCheck({ url, name: result.name })
        })
        .catch((caught) => {
          if (!cancelled)
            setStreamCheck({
              url,
              error:
                caught instanceof Error
                  ? caught.message
                  : "This stream could not be checked.",
            })
        })
    }, 600)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [streamURL])
  const streamCheckFeedback = streamURL.trim() ? (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "text-xs leading-4 text-muted-foreground",
        streamCheck?.url === streamURL.trim() &&
          streamCheck.error &&
          "text-destructive"
      )}
    >
      {streamCheck?.url !== streamURL.trim()
        ? t("Checking livestream link…")
        : streamCheck.error ||
          t(
            "{value0} · Stream found. JustAI captures it on the server; your browser can be closed.",
            { value0: streamCheck.name }
          )}
    </p>
  ) : null

  const [botDialogOpen, setBotDialogOpen] = useState(false)
  const [botName, setBotName] = useState(t("Meeting bot"))
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

  const viewerSocketRef = useRef<SSETransport | null>(null)
  const captureSocketRef = useRef<SSETransport | null>(null)
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
          endpoint.enabled &&
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
    t("System default")
  const captureSourceKind =
    captureMode === "system-audio" ? "browser-system" : "browser"
  const captureSourceName =
    captureMode === "system-audio" ? t("Browser tab audio") : t("This laptop")
  const effectiveGrammarEndpoint = selectedGrammarEndpoint

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
          ![
            "not_requested",
            "queued",
            "processing",
            "completed",
            "failed",
          ].includes(status)
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
        "/api/v1/stream-tickets",
        { kind: "transcription-viewer", sessionId: id }
      )
      if (viewerAttemptRef.current !== attempt) return
      const socket = new SSETransport(
        eventStreamURL("/api/v1/streams/transcription", ticketResponse.ticket)
      )
      socket.onconnectionstatechange = (next) => {
        setTransportStatus(next)
        if (next.state === "reconnecting" || next.audioQuality !== "good")
          setInterruptionAt(new Date())
      }
      socket.ontransporterror = (transportError) => {
        if (
          !["stream_reconnecting", "audio_backpressure"].includes(
            transportError.code
          )
        )
          setError(transportError.message)
      }
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
        socket.readyState !== SSETransport.OPEN
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

  const beginAudio = useCallback(
    async (
      socket: SSETransport,
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
        socket.readyState === SSETransport.OPEN
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
      worklet.port.onmessage = (message: MessageEvent<Float32Array>) => {
        if (!isCurrent()) return
        const samples = downsample(message.data, context!.sampleRate, 16000)
        // Preserve the audio timeline, including silence. The backend chooses
        // provider-side VAD or local turn commits for the selected transport.
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
        if (socket.readyState === SSETransport.OPEN)
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
        "/api/v1/stream-tickets",
        {
          kind: "transcription-capture",
          sessionId: session.id,
          sourceId: source.id,
        }
      )
      if (captureAttemptRef.current !== attempt) return
      captureSourceIdRef.current = source.id
      const socket = new SSETransport(
        eventStreamURL("/api/v1/streams/transcription", ticketResponse.ticket)
      )
      socket.onconnectionstatechange = (next) => {
        setTransportStatus(next)
        if (next.state === "reconnecting" || next.audioQuality !== "good")
          setInterruptionAt(new Date())
      }
      socket.ontransporterror = (transportError) => {
        if (
          !["stream_reconnecting", "audio_backpressure"].includes(
            transportError.code
          )
        )
          setError(transportError.message)
      }
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
        socket.readyState !== SSETransport.OPEN
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
    if (
      captureMode === "external" &&
      externalSourceType === "stream" &&
      isYouTubePageURL(streamURL)
    ) {
      setError(youtubeCaptureGuidance)
      setCreateStep(1)
      return
    }
    if (
      captureMode === "external" &&
      externalSourceType === "stream" &&
      !checkedStreamReady
    )
      return
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
        recordAudio: recordAudio || Boolean(selectedDiarizationEndpoint),
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
            name: streamName.trim() || t("Live stream"),
            url: streamURL.trim(),
            scheduledStartAt:
              streamScheduled && streamScheduledStart
                ? new Date(streamScheduledStart).toISOString()
                : undefined,
            scheduledEndAt:
              streamScheduled && streamScheduledEnd
                ? new Date(streamScheduledEnd).toISOString()
                : undefined,
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
            name: botName.trim() || t("Meeting bot"),
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
        captureMode === "external" &&
        !(externalSourceType === "stream" && streamScheduled)
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
    if (!snapshot || !checkedStreamReady || streamStarting) return
    if (isYouTubePageURL(streamURL)) {
      setError(youtubeCaptureGuidance)
      return
    }
    setStreamStarting(true)
    setError("")
    try {
      const result = await api.post<{
        source: TranscriptionSource
        stream: { protocol: string; status: string }
      }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/stream-sources`,
        {
          name: streamName.trim() || t("Live stream"),
          url: streamURL.trim(),
          scheduledStartAt:
            streamScheduled && streamScheduledStart
              ? new Date(streamScheduledStart).toISOString()
              : undefined,
          scheduledEndAt:
            streamScheduled && streamScheduledEnd
              ? new Date(streamScheduledEnd).toISOString()
              : undefined,
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
                  current.session.status === "waiting" &&
                  result.stream.status !== "scheduled"
                    ? "live"
                    : current.session.status,
              },
            }
          : current
      )
      setStreamURL("")
      setStreamScheduled(false)
      setStreamScheduledStart("")
      setStreamScheduledEnd("")
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
          name: botName.trim() || t("Meeting bot"),
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
    )?.label || t("Microphone")
  const selectedEndpointName =
    transcriptionEndpoints.find(
      (endpoint) => endpoint.id === effectiveSelectedEndpoint
    )?.name || "No endpoint selected"

  const sourceSetupReady =
    captureMode !== "external" ||
    externalSourceType === "meeting-bot" ||
    (checkedStreamReady &&
      (!streamScheduled ||
        (Boolean(streamScheduledStart) &&
          (!streamScheduledEnd ||
            new Date(streamScheduledEnd) > new Date(streamScheduledStart)))))
  const canContinueWizard =
    createStep === 0 ||
    (createStep === 1 && sourceSetupReady) ||
    (createStep === 2 && Boolean(effectiveSelectedEndpoint))
  const selectWizardSource = (choice: SessionSourceChoice) => {
    if (choice === "stream" || choice === "meeting-bot") {
      setCaptureMode("external")
      setExternalSourceType(choice)
      return
    }
    setCaptureMode(choice)
  }
  const goToNextWizardStep = () => {
    if (!canContinueWizard || createStep === 2) return
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
  const dialogOpen =
    (createOpen && !sessionId) ||
    streamDialogOpen ||
    botDialogOpen ||
    shareOpen ||
    Boolean(workspaceSpeaker)

  return (
    <div className="flex min-h-[calc(100svh-2rem)] w-full min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
      {error && !dialogOpen ? <DialogError message={error} /> : null}

      {!sessionId && !createOpen ? (
        <VideoTranscriptionLibrary
          kind="live"
          ownerId={user.id}
          revision={sessions
            .map((session) => `${session.id}:${session.updatedAt}`)
            .join("|")}
          onCreate={openCreateWizard}
        />
      ) : !snapshot && !createOpen ? (
        <div
          className="flex min-h-64 items-center justify-center gap-3 text-muted-foreground"
          role="status"
        >
          {error ? (
            <Link
              href="/transcription"
              className="rounded-md text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("All live sessions")}
            </Link>
          ) : (
            <>
              <Spinner className="size-5" aria-hidden="true" />
              {t("Opening recording…")}
            </>
          )}
        </div>
      ) : snapshot && !createOpen && snapshot.session.status === "completed" ? (
        <>
          <Link
            href="/transcription"
            className="self-start rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("All live sessions")}
          </Link>
          {snapshot.liveProcessing ? (
            <LiveTranscriptProcessingPanel
              snapshot={snapshot}
              onChange={(next) => setSnapshot(next)}
              onError={setError}
            />
          ) : null}
          <TranscriptWorkspace
            key={snapshot.session.id}
            currentTimeMs={workspaceTimeMs}
            mediaKind={workspaceMediaKind}
            onCurrentTimeChange={setWorkspaceTimeMs}
            onError={setError}
            onRefreshPlayback={async () => undefined}
            onRenameSpeaker={openWorkspaceSpeakerRename}
            onStartChat={onStartChat}
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
      ) : snapshot && !createOpen ? (
        <>
          <LiveTranscriptionConversationView
            processingSettings={
              <LiveProcessingSettings
                key={snapshot.session.id}
                snapshot={snapshot}
                diarizationEndpoints={diarizationEndpoints}
                grammarEndpoints={grammarEndpoints}
                onChange={(next) => setSnapshot(next)}
              />
            }
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
            mode={captureViewMode}
            transportStatus={transportStatus}
            interruptionAt={interruptionAt}
          />
        </>
      ) : null}

      {createOpen && !sessionId ? (
        <TranscriptionCreationFlow
          title={t("New live session")}
          description={t("Choose an audio source and how it is processed.")}
          steps={liveSessionWizardSteps}
          step={createStep}
          onStepChange={(step) => setCreateStep(step as SessionWizardStep)}
          busy={starting}
          footer={
            <footer className="flex flex-wrap items-center justify-end gap-4 pt-4">
              <div className="flex items-center justify-end gap-2">
                {createStep > 0 ? (
                  <Button
                    disabled={starting}
                    onClick={goToPreviousWizardStep}
                    variant="outline"
                  >
                    <ArrowLeft data-icon="inline-start" /> {t("Back")}
                  </Button>
                ) : (
                  <Button
                    onClick={() => setCreateOpen(false)}
                    variant="outline"
                  >
                    {t("Cancel")}
                  </Button>
                )}
                {createStep < 2 ? (
                  <Button
                    disabled={!canContinueWizard}
                    onClick={goToNextWizardStep}
                  >
                    {t("Continue")} <ArrowRight data-icon="inline-end" />
                  </Button>
                ) : (
                  <Button
                    disabled={starting || !effectiveSelectedEndpoint}
                    onClick={() => void createSession()}
                  >
                    {starting ? (
                      <>
                        <Spinner data-icon="inline-start" />
                        {t("Starting…")}
                      </>
                    ) : (
                      <>
                        <Play data-icon="inline-start" /> {t("Start session")}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </footer>
          }
        >
          {error ? (
            <div className="flex flex-col gap-3">
              <DialogError message={error} />
              {error === youtubeCaptureGuidance ? (
                <Button
                  className="w-fit"
                  onClick={() => {
                    setError("")
                    setCaptureMode("system-audio")
                    setCreateStep(1)
                  }}
                  variant="outline"
                >
                  <MonitorUp data-icon="inline-start" />{" "}
                  {t("Use browser tab audio")}
                </Button>
              ) : null}
            </div>
          ) : null}

          {createStep === 0 ? (
            <div className="flex flex-col gap-5" key="source-step">
              <div>
                <p className="text-sm font-medium">
                  {t("What do you want to capture?")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    "Pick the source that already has the audio. You can add more sources after the room is created."
                  )}
                </p>
              </div>
              <ChoiceCards
                aria-label={t("Audio source")}
                columns={2}
                aspect="16 / 4"
                onValueChange={(value) =>
                  selectWizardSource(value as SessionSourceChoice)
                }
                value={selectedWizardSource}
              >
                {liveSessionSourceOptions.map((option) => {
                  const OptionIcon = option.icon
                  return (
                    <ChoiceCards.Item key={option.key} value={option.key}>
                      <ChoiceCards.Media>
                        <OptionIcon aria-hidden="true" className="size-8" />
                      </ChoiceCards.Media>
                      <ChoiceCards.Label>{option.label}</ChoiceCards.Label>
                      <ChoiceCards.Description>
                        {option.description}
                      </ChoiceCards.Description>
                    </ChoiceCards.Item>
                  )
                })}
              </ChoiceCards>
              <PuAlert tone="info" variant="plain">
                <PuAlert.Icon>
                  <ShieldCheck aria-hidden="true" />
                </PuAlert.Icon>
                <PuAlert.Title>
                  {t("Audio stays under your control")}
                </PuAlert.Title>
                <PuAlert.Description>
                  {t(
                    "Browser sources ask for permission only when you start. Direct URLs are encrypted at rest, and meeting bots receive a scoped ingest credential."
                  )}
                </PuAlert.Description>
              </PuAlert>
            </div>
          ) : createStep === 1 ? (
            <div className="flex flex-col gap-5" key="setup-step">
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
                    {t("Set up")} {selectedWizardSourceLabel}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedWizardSource === "microphone"
                      ? t("Choose the microphone this browser should stream.")
                      : selectedWizardSource === "system-audio"
                        ? t(
                            "Choose a tab, window, or screen in the browser picker."
                          )
                        : selectedWizardSource === "stream"
                          ? t(
                              "Paste a livestream link. JustAI checks the source before you schedule it."
                            )
                          : t(
                              "Prepare a platform adapter or desktop companion to send meeting audio."
                            )}
                  </p>
                </div>
              </div>

              {selectedWizardSource === "microphone" ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel>{t("Microphone")}</FieldLabel>
                    <Select
                      onValueChange={(value) =>
                        setDeviceLabel(value === "default" ? "" : (value ?? ""))
                      }
                      value={deviceLabel || "default"}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={t("System default microphone")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectGroupLabel>
                            {t("Audio inputs")}
                          </SelectGroupLabel>
                          <SelectItem value="default">
                            {t("System default")}
                          </SelectItem>
                          {devices.map((device, index) => (
                            <SelectItem
                              key={device.deviceId || `audio-input-${index}`}
                              value={device.deviceId}
                            >
                              {device.label ||
                                t("Microphone {value0}", { value0: index + 1 })}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t(
                        "Permission is requested only after you press Start session."
                      )}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              ) : selectedWizardSource === "system-audio" ? (
                <div className="flex flex-col gap-4">
                  <Frame>
                    <Frame.Header>
                      <Frame.Title>
                        {t("Share audio from your browser")}
                      </Frame.Title>
                    </Frame.Header>
                    <Frame.Panel>
                      {[
                        t("Keep the tab, window, or screen open."),
                        t("Choose it in the native share picker."),
                        t("Turn on Share audio before confirming."),
                      ].map((instruction, index) => (
                        <Frame.Row key={instruction}>
                          <Frame.Media>
                            <span className="text-xs font-semibold tabular-nums">
                              {index + 1}
                            </span>
                          </Frame.Media>
                          <Frame.Content>
                            <Frame.Title as="p">{instruction}</Frame.Title>
                          </Frame.Content>
                        </Frame.Row>
                      ))}
                    </Frame.Panel>
                  </Frame>
                  <PuAlert tone="info" variant="plain">
                    <PuAlert.Icon>
                      <AudioLines aria-hidden="true" />
                    </PuAlert.Icon>
                    <PuAlert.Title>{t("Great for livestreams")}</PuAlert.Title>
                    <PuAlert.Description>
                      {t(
                        "Open YouTube, a TV livestream, or a webinar in a tab, then share that tab’s audio. JustAI does not need the page URL."
                      )}
                    </PuAlert.Description>
                  </PuAlert>
                </div>
              ) : selectedWizardSource === "stream" ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel>{t("Source name")}</FieldLabel>
                    <Input
                      id="session-stream-name"
                      onChange={(event) => setStreamName(event.target.value)}
                      value={streamName}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t("Livestream link")}</FieldLabel>
                    <Input
                      id="session-stream-url"
                      onChange={(event) => setStreamURL(event.target.value)}
                      placeholder="https://www.bundestag.de/mediathek/live"
                      type="url"
                      value={streamURL}
                    />
                    <FieldDescription>
                      {t(
                        "Paste a livestream webpage or a direct audio/video link. JustAI checks whether automatic capture is supported."
                      )}
                    </FieldDescription>
                  </Field>
                  {streamCheckFeedback}
                  <StreamScheduleFields
                    end={streamScheduledEnd}
                    idPrefix="session-stream"
                    onEndChange={setStreamScheduledEnd}
                    onScheduledChange={(checked) => {
                      setStreamScheduled(checked)
                      if (checked && !streamScheduledStart) {
                        setStreamScheduledStart(
                          localDateTimeValue(new Date(Date.now() + 15 * 60_000))
                        )
                      }
                    }}
                    onStartChange={setStreamScheduledStart}
                    scheduled={streamScheduled}
                    start={streamScheduledStart}
                  />
                </FieldGroup>
              ) : (
                <FieldGroup>
                  <Field>
                    <FieldLabel>{t("Source name")}</FieldLabel>
                    <Input
                      id="session-bot-name"
                      onChange={(event) => setBotName(event.target.value)}
                      value={botName}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t("Meeting platform")}</FieldLabel>
                    <Select
                      onValueChange={(value) =>
                        setBotPlatform(value ?? "generic")
                      }
                      value={botPlatform}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("Choose a platform")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectGroupLabel>
                            {t("Adapter type")}
                          </SelectGroupLabel>
                          <SelectItem value="generic">
                            {t("Custom / desktop adapter")}
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
                    <FieldLabel>
                      {t("Meeting URL")}{" "}
                      <span className="text-muted-foreground">
                        {t("(optional)")}
                      </span>
                    </FieldLabel>
                    <Input
                      id="session-bot-url"
                      onChange={(event) => setBotMeetingURL(event.target.value)}
                      placeholder="https://…"
                      type="url"
                      value={botMeetingURL}
                    />
                    <FieldDescription>
                      {t(
                        "Stored encrypted for your adapter. JustAI will not sign in to a third-party meeting for you."
                      )}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-5" key="options-step">
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
                  <Field>
                    <FieldLabel>{t("Session name")}</FieldLabel>
                    <Input
                      id="session-title"
                      onChange={(event) => setTitle(event.target.value)}
                      value={title}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t("Language")}</FieldLabel>
                    <Select
                      items={languageItems}
                      onValueChange={(value) => setLanguage(value || "auto")}
                      value={language}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {languageItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                <Frame>
                  <Frame.Header>
                    <Frame.Title>{t("Processing")}</Frame.Title>
                  </Frame.Header>
                  <Frame.Panel>
                    <Frame.Row>
                      <Frame.Content>
                        <Frame.Title as="p">
                          {t("Separate speakers")}
                        </Frame.Title>
                        <Frame.Description>
                          {diarizationEndpoints.length === 0
                            ? t("No speaker separation endpoint is configured.")
                            : t(
                                "Label who is talking after capture ends. Turns on audio recording."
                              )}
                        </Frame.Description>
                      </Frame.Content>
                      <Frame.Actions>
                        <Switch
                          checked={Boolean(selectedDiarizationEndpoint)}
                          disabled={diarizationEndpoints.length === 0}
                          aria-label={t("Separate speakers")}
                          id="session-option-speakers"
                          onCheckedChange={(on) =>
                            setSelectedDiarizationEndpoint(
                              on ? (diarizationEndpoints[0]?.id ?? "") : ""
                            )
                          }
                        />
                      </Frame.Actions>
                    </Frame.Row>

                    <Frame.Row>
                      <Frame.Content>
                        <Frame.Title as="p">{t("Polish grammar")}</Frame.Title>
                        <Frame.Description>
                          {grammarEndpoints.length === 0
                            ? t("No chat endpoint is configured.")
                            : t(
                                "Clean up wording when capture ends. The verbatim transcript stays available."
                              )}
                        </Frame.Description>
                      </Frame.Content>
                      <Frame.Actions>
                        <Switch
                          checked={Boolean(selectedGrammarEndpoint)}
                          disabled={grammarEndpoints.length === 0}
                          aria-label={t("Polish grammar")}
                          id="session-option-grammar"
                          onCheckedChange={(on) =>
                            setSelectedGrammarEndpoint(
                              on
                                ? (grammarEndpoints.find(
                                    (endpoint) => endpoint.isDefault
                                  )?.id ??
                                    grammarEndpoints[0]?.id ??
                                    "")
                                : ""
                            )
                          }
                        />
                      </Frame.Actions>
                    </Frame.Row>

                    <Frame.Row>
                      <Frame.Content>
                        <Frame.Title as="p">
                          {t("Record source audio")}
                        </Frame.Title>
                        <Frame.Description>
                          {t(
                            "Encrypted, source-separated tracks. Default retention: 30 days."
                          )}
                        </Frame.Description>
                      </Frame.Content>
                      <Frame.Actions>
                        <Switch
                          checked={
                            recordAudio || Boolean(selectedDiarizationEndpoint)
                          }
                          disabled={Boolean(selectedDiarizationEndpoint)}
                          aria-label={t("Record source audio")}
                          id="session-option-record"
                          onCheckedChange={setRecordAudio}
                        />
                      </Frame.Actions>
                    </Frame.Row>
                  </Frame.Panel>
                </Frame>

                <Collapsible defaultOpen={!effectiveSelectedEndpoint}>
                  <CollapsibleTrigger className="group/advanced flex w-full items-center gap-2 rounded-lg py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("Advanced settings")}
                    <span className="min-w-0 flex-1 truncate text-left text-xs font-normal text-muted-foreground">
                      {selectedEndpointName}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/advanced:rotate-180"
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <FieldGroup className="pt-4">
                      <Field>
                        <FieldLabel>{t("Transcription endpoint")}</FieldLabel>
                        <Select
                          items={transcriptionEndpoints.map((endpoint) => ({
                            value: endpoint.id,
                            label: endpoint.name,
                          }))}
                          onValueChange={(value) =>
                            setSelectedEndpoint(value ?? "")
                          }
                          value={effectiveSelectedEndpoint}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue
                              placeholder={t("Select a transcription endpoint")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectGroupLabel>
                                {t("Transcription providers")}
                              </SelectGroupLabel>
                              {transcriptionEndpoints.map((endpoint) => (
                                <SelectItem
                                  key={endpoint.id}
                                  value={endpoint.id}
                                >
                                  {endpoint.name} · {endpoint.providerType} ·{" "}
                                  {t(transcriptionModeLabel(endpoint))}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      {selectedDiarizationEndpoint ? (
                        <Field>
                          <FieldLabel>
                            {t("Speaker separation after capture")}
                          </FieldLabel>
                          <Select
                            items={[
                              { value: "none", label: "No speaker separation" },
                              ...diarizationEndpoints.map((endpoint) => ({
                                value: endpoint.id,
                                label: endpoint.name,
                              })),
                            ]}
                            onValueChange={(value) =>
                              setSelectedDiarizationEndpoint(
                                value === "none" ? "" : (value ?? "")
                              )
                            }
                            value={selectedDiarizationEndpoint || "none"}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue
                                placeholder={t("Optional speaker separation")}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectGroupLabel>
                                  {t("Speaker providers")}
                                </SelectGroupLabel>
                                <SelectItem value="none">
                                  {t("No speaker separation")}
                                </SelectItem>
                                {diarizationEndpoints.map((endpoint) => (
                                  <SelectItem
                                    key={endpoint.id}
                                    value={endpoint.id}
                                  >
                                    {endpoint.name} · {endpoint.providerType}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <FieldDescription>
                            {t(
                              "Runs after capture ends. Audio recording is required and enabled automatically."
                            )}
                          </FieldDescription>
                        </Field>
                      ) : null}
                      {selectedGrammarEndpoint ? (
                        <Field>
                          <FieldLabel>{t("Grammar polish")}</FieldLabel>
                          <Select
                            items={[
                              {
                                value: "none",
                                label: "Keep verbatim transcript",
                              },
                              ...grammarEndpoints.map((endpoint) => ({
                                value: endpoint.id,
                                label: endpoint.name,
                              })),
                            ]}
                            onValueChange={(value) =>
                              setSelectedGrammarEndpoint(
                                value === "none" ? "" : (value ?? "")
                              )
                            }
                            value={selectedGrammarEndpoint || "none"}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue
                                placeholder={t("Optional grammar polish")}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectGroupLabel>
                                  {t("Writing providers")}
                                </SelectGroupLabel>
                                <SelectItem value="none">
                                  {t("Keep verbatim transcript")}
                                </SelectItem>
                                {grammarEndpoints.map((endpoint) => (
                                  <SelectItem
                                    key={endpoint.id}
                                    value={endpoint.id}
                                  >
                                    {endpoint.name} · {endpoint.providerType}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <FieldDescription>
                            {t(
                              "Runs automatically after speaker separation, when capture ends."
                            )}
                          </FieldDescription>
                        </Field>
                      ) : null}
                    </FieldGroup>
                  </CollapsibleContent>
                </Collapsible>
              </FieldGroup>
              <PuAlert tone="info" variant="plain">
                <PuAlert.Icon>
                  <ShieldCheck aria-hidden="true" />
                </PuAlert.Icon>
                <PuAlert.Title>{t("What happens next")}</PuAlert.Title>
                <PuAlert.Description>
                  {selectedWizardSource === "system-audio"
                    ? t(
                        "The browser opens its native share picker. Choose the tab or window and enable Share audio."
                      )
                    : selectedWizardSource === "meeting-bot"
                      ? t(
                          "The room starts first, then JustAI shows a one-time ingest token for your adapter. It does not automatically join the third-party meeting."
                        )
                      : selectedWizardSource === "stream"
                        ? t(
                            "JustAI starts the decoder and reconnects automatically when the authorized live source or provider briefly drops."
                          )
                        : t(
                            "The browser asks for microphone permission, then audio begins flowing into the room."
                          )}
                </PuAlert.Description>
              </PuAlert>
            </div>
          )}
        </TranscriptionCreationFlow>
      ) : null}

      <Dialog
        open={streamDialogOpen}
        onOpenChange={(open) => {
          setStreamDialogOpen(open)
          if (!open) setError("")
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Capture a live stream")}</DialogTitle>
            <DialogDescription>
              {t(
                "Paste a public livestream link. JustAI finds supported streams and captures them automatically, without an open browser."
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? <DialogError message={error} /> : null}
          <FieldGroup>
            <Field>
              <FieldLabel>{t("Source name")}</FieldLabel>
              <Input
                id="stream-source-name"
                onChange={(event) => setStreamName(event.target.value)}
                value={streamName}
              />
            </Field>
            <Field>
              <FieldLabel>{t("Livestream link")}</FieldLabel>
              <Input
                id="stream-source-url"
                onChange={(event) => setStreamURL(event.target.value)}
                placeholder="https://www.bundestag.de/mediathek/live"
                type="url"
                value={streamURL}
              />
              <FieldDescription>
                {t(
                  "Paste a livestream webpage or direct stream link. The link is stored encrypted and checked again when capture starts."
                )}
              </FieldDescription>
            </Field>
            {streamCheckFeedback}
            <StreamScheduleFields
              end={streamScheduledEnd}
              idPrefix="stream-source"
              onEndChange={setStreamScheduledEnd}
              onScheduledChange={(checked) => {
                setStreamScheduled(checked)
                if (checked && !streamScheduledStart) {
                  setStreamScheduledStart(
                    localDateTimeValue(new Date(Date.now() + 15 * 60_000))
                  )
                }
              }}
              onStartChange={setStreamScheduledStart}
              scheduled={streamScheduled}
              start={streamScheduledStart}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              onClick={() => {
                setError("")
                setStreamDialogOpen(false)
              }}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                streamStarting ||
                !checkedStreamReady ||
                (streamScheduled &&
                  (!streamScheduledStart ||
                    Boolean(
                      streamScheduledEnd &&
                      new Date(streamScheduledEnd) <=
                        new Date(streamScheduledStart)
                    )))
              }
              onClick={() => void addStreamSource()}
            >
              {streamStarting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  {t("Connecting…")}
                </>
              ) : (
                <>
                  <Tv data-icon="inline-start" />
                  {streamScheduled ? t("Schedule stream") : t("Connect stream")}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={botDialogOpen}
        onOpenChange={(open) => {
          setBotDialogOpen(open)
          if (!open) setError("")
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("Connect a meeting bot")}</DialogTitle>
            <DialogDescription>
              {t(
                "Create a source credential for a platform adapter or desktop companion. JustAI handles transcription after the adapter sends its meeting audio."
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? <DialogError message={error} /> : null}
          {botSetup ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl bg-muted/50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{t("Ingest token")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        "This is shown once. Store it in the adapter’s secret manager."
                      )}
                    </p>
                  </div>
                  <Button
                    aria-label={t("Copy bot ingest token")}
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
              <div className="rounded-xl border bg-background p-4 text-sm">
                <p className="font-medium">{t("Adapter setup")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    "Give the adapter the ingest token above. It will exchange it for a short-lived connection and begin sending meeting audio."
                  )}
                </p>
              </div>
              <Collapsible>
                <CollapsibleTrigger
                  render={
                    <Button className="w-fit" size="sm" variant="ghost" />
                  }
                >
                  {t("Advanced protocol details")}
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 flex flex-col gap-2 rounded-xl border bg-muted/30 p-4 text-xs text-muted-foreground">
                  <p>
                    1. POST to <code>{botSetup.ticketPath}</code> with
                    <code> Authorization: Bearer &lt;token&gt;</code>.
                  </p>
                  <p>
                    2. Open{" "}
                    <code>{botSetup.streamPath}?ticket=&lt;ticket&gt;</code>.
                  </p>
                  <p>
                    3. Read the <code>streamId</code> from{" "}
                    <code>transport.ready</code>. Use its{" "}
                    <code>uploadToken</code> as <code>X-Stream-Token</code>,
                    POST sequenced <code>transcription.start</code> to{" "}
                    <code>/events</code>, and batched PCM16 frames to{" "}
                    <code>/audio</code> using the{" "}
                    <code>{botSetup.protocol}</code> format.
                  </p>
                </CollapsibleContent>
              </Collapsible>
              <DialogFooter>
                <Button onClick={() => setBotDialogOpen(false)}>
                  {t("Done")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel>{t("Source name")}</FieldLabel>
                <Input
                  id="bot-source-name"
                  onChange={(event) => setBotName(event.target.value)}
                  value={botName}
                />
              </Field>
              <Field>
                <FieldLabel>{t("Meeting platform")}</FieldLabel>
                <Select
                  onValueChange={(value) => setBotPlatform(value ?? "generic")}
                  value={botPlatform}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("Choose a platform")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectGroupLabel>{t("Adapter type")}</SelectGroupLabel>
                      <SelectItem value="generic">
                        {t("Custom / desktop adapter")}
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
                <FieldLabel>
                  {t("Meeting URL")}{" "}
                  <span className="text-muted-foreground">
                    {t("(optional)")}
                  </span>
                </FieldLabel>
                <Input
                  id="bot-meeting-url"
                  onChange={(event) => setBotMeetingURL(event.target.value)}
                  placeholder="https://…"
                  type="url"
                  value={botMeetingURL}
                />
                <FieldDescription>
                  {t(
                    "Saved encrypted for the adapter configuration; JustAI does not automatically sign in to third-party meetings."
                  )}
                </FieldDescription>
              </Field>
              <DialogFooter>
                <Button
                  onClick={() => setBotDialogOpen(false)}
                  variant="outline"
                >
                  {t("Cancel")}
                </Button>
                <Button
                  disabled={botStarting}
                  onClick={() => void createBotSource()}
                >
                  {botStarting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      {t("Creating…")}
                    </>
                  ) : (
                    <>
                      <Bot data-icon="inline-start" /> {t("Create bot source")}
                    </>
                  )}
                </Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={shareOpen}
        onOpenChange={(open) => {
          setShareOpen(open)
          if (!open) setError("")
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("Join this room")}</DialogTitle>
            <DialogDescription>
              {t(
                "Share this persistent link. The microphone connects only after you approve the request here."
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? <DialogError message={error} /> : null}
          {snapshot?.session.joinCode ? (
            <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted/50 p-3">
              <code className="min-w-0 flex-1 text-xs break-all text-muted-foreground">
                {new URL(
                  transcriptionJoinPath(snapshot.session.joinCode),
                  typeof window === "undefined"
                    ? "http://localhost"
                    : window.location.origin
                ).toString()}
              </code>
              <Button
                aria-label={t("Copy room link")}
                onClick={() => void copyJoinLink()}
                size="icon-sm"
                variant="outline"
              >
                {joinLinkCopied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-xl bg-muted/50 p-4">
            <span className="font-mono text-2xl font-semibold tracking-[0.32em]">
              {snapshot?.session.joinCode ?? "--------"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void rotateJoinCode()}
                size="sm"
                variant="outline"
              >
                {t("New code")}
              </Button>
              {snapshot?.session.joinCode && (
                <Button
                  aria-label={t("Copy room code")}
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
            <Button onClick={() => setShareOpen(false)}>{t("Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(workspaceSpeaker)}
        onOpenChange={(open) => {
          if (!open && !workspaceSpeakerSaving) {
            setError("")
            setWorkspaceSpeaker(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Rename speaker")}</DialogTitle>
            <DialogDescription>
              {t(
                "This name is used throughout the finished transcript and its exports."
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? <DialogError message={error} /> : null}
          <FieldGroup>
            <Field>
              <FieldLabel>{t("Name")}</FieldLabel>
              <Input
                autoFocus
                id="workspace-speaker-name"
                onChange={(event) =>
                  setWorkspaceSpeakerName(event.target.value)
                }
                value={workspaceSpeakerName}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              disabled={workspaceSpeakerSaving}
              onClick={() => {
                setError("")
                setWorkspaceSpeaker(null)
              }}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={workspaceSpeakerSaving || !workspaceSpeakerName.trim()}
              onClick={() => void saveWorkspaceSpeakerName()}
            >
              {workspaceSpeakerSaving ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {t("Save name")}
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
