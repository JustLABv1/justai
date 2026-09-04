"use client"

import {
  Activity,
  AudioLines,
  Bot,
  CircleDot,
  Gauge,
  Link2,
  MonitorUp,
  Pause,
  Radio,
  Share2,
  ShieldCheck,
  Square,
  Tv,
  Wifi,
} from "lucide-react"
import { useMemo, useState, type CSSProperties } from "react"
import type { LucideIcon } from "lucide-react"

import { VoiceOrb } from "@/components/assistant-ui/voice"
import {
  SignalBars,
  TranscriptTray,
  type RoomSpeaker,
  type RoomTranscriptLine,
} from "@/components/live-transcription-primitives"
import type {
  LiveTranscriptionOrbitProps,
  LiveTranscriptionSnapshot,
} from "@/components/live-transcription-orbit"
import orbitStyles from "@/components/live-transcription.module.css"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { groupTranscriptionSegments } from "@/lib/transcription"
import { cn } from "@/lib/utils"

export type LiveTranscriptionCaptureViewMode =
  "browser-system" | "stream" | "meeting-bot"

type LiveTranscriptionSourceViewProps = LiveTranscriptionOrbitProps & {
  mode: LiveTranscriptionCaptureViewMode
}

type CaptureModeConfig = {
  audioLevelDescription: string
  badge: string
  description: string
  eyebrow: string
  icon: LucideIcon
  hint: string
  sourceFallback: string
  transportLabel: string
}

const captureModeConfig: Record<
  LiveTranscriptionCaptureViewMode,
  CaptureModeConfig
> = {
  "browser-system": {
    audioLevelDescription:
      "Follows the tab's playback volume; it is not a connection-health score.",
    badge: "Browser capture",
    description:
      "The shared tab or screen is the source. Include audio when you choose it, then keep that tab active while JustAI listens.",
    eyebrow: "Browser audio",
    icon: MonitorUp,
    hint: "Monitor the shared audio track directly.",
    sourceFallback: "Browser tab audio",
    transportLabel: "Browser audio track",
  },
  stream: {
    audioLevelDescription:
      "Follows the stream's playback level; it is not a connection-health score.",
    badge: "Stream ingest",
    description:
      "JustAI decodes the remote stream on the server and keeps the transcription pipeline alive through short reconnects.",
    eyebrow: "Live stream",
    icon: Tv,
    hint: "Decoder and transcription run on the server.",
    sourceFallback: "Live stream",
    transportLabel: "Remote decoder",
  },
  "meeting-bot": {
    audioLevelDescription:
      "Follows the incoming meeting audio; it is not a connection-health score.",
    badge: "Meeting ingress",
    description:
      "A meeting adapter sends audio into this session. This view keeps the call connection and incoming audio visible together.",
    eyebrow: "Meeting bot",
    icon: Bot,
    hint: "Follow the adapter and its incoming audio.",
    sourceFallback: "Meeting bot",
    transportLabel: "Bot audio ingress",
  },
}

const speakerAccents = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function LiveTranscriptionSourceView({
  mode,
  snapshot,
  user,
  loading,
  partial,
  partialSourceId,
  partialSpeakerId,
  level,
  capturing,
  canStartCapture = true,
  onStartCapture,
  onShare,
  onPauseOrResume,
  onStopSession,
}: LiveTranscriptionSourceViewProps) {
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const config = captureModeConfig[mode]
  const source = useMemo(
    () => findPrimarySource(snapshot, mode) || snapshot.sources[0],
    [mode, snapshot]
  )
  const signalLevel = clamp(Math.max(level, source?.signalLevel ?? 0))
  const signalValue = Math.round(signalLevel * 100)
  const sourceStatus = getCaptureStatus(snapshot, source, mode)
  const sourceName = source?.name || config.sourceFallback
  const isLive = snapshot.session.status === "live"
  const sourceConnected = source?.status === "connected"
  const transcriptSpeakers = useMemo(
    () => buildTranscriptSpeakers(snapshot),
    [snapshot]
  )
  const transcript = useMemo(
    () => buildTranscript(snapshot, partial, partialSourceId, partialSpeakerId),
    [partial, partialSourceId, partialSpeakerId, snapshot]
  )
  const Icon = config.icon

  return (
    <div className={orbitStyles.productionVariant}>
      <header className={orbitStyles.sessionHeader}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Live transcription</span>
            <span>/</span>
            <span className="truncate">
              {snapshot.session.language === "auto"
                ? "Automatic language"
                : snapshot.session.language}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {snapshot.session.title}
            </h1>
            <Badge variant={isLive ? "default" : "secondary"}>
              {loading ? "Syncing" : snapshot.session.status}
            </Badge>
            <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">
              Hosted by {user.displayName}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <VoiceOrb
            className="shrink-0 shadow-[0_0_30px_rgba(99,102,241,0.18)]"
            compact
            state={
              !sourceConnected || snapshot.session.status === "paused"
                ? "idle"
                : signalLevel >= 0.08
                  ? "speaking"
                  : "listening"
            }
            volume={sourceConnected ? signalLevel : 0}
          />
          <Badge className="hidden sm:inline-flex" variant="secondary">
            <Icon data-icon="inline-start" /> {config.eyebrow}
          </Badge>
          {snapshot.session.status !== "completed" ? (
            <Button
              aria-label="Share transcription room"
              onClick={onShare}
              size="sm"
              variant="outline"
            >
              <Share2 data-icon="inline-start" />
              <span className="hidden sm:inline">Share</span>
            </Button>
          ) : null}
          {!capturing &&
          mode === "browser-system" &&
          canStartCapture &&
          snapshot.session.status !== "paused" &&
          snapshot.session.status !== "completed" ? (
            <Button
              aria-label="Start audio capture"
              onClick={() => void onStartCapture()}
              size="sm"
            >
              <AudioLines data-icon="inline-start" />
              <span className="hidden sm:inline">Start audio</span>
            </Button>
          ) : null}
          {(capturing ||
            mode !== "browser-system" ||
            snapshot.session.status === "paused") &&
          snapshot.session.status !== "completed" ? (
            <Button
              aria-label={
                snapshot.session.status === "paused"
                  ? "Resume listening"
                  : "Pause listening"
              }
              onClick={() => void onPauseOrResume()}
              size="sm"
              variant="outline"
            >
              {snapshot.session.status === "paused" ? (
                <AudioLines data-icon="inline-start" />
              ) : (
                <Pause data-icon="inline-start" />
              )}
              <span className="hidden sm:inline">
                {snapshot.session.status === "paused" ? "Resume" : "Pause"}
              </span>
            </Button>
          ) : null}
          {snapshot.session.status !== "completed" ? (
            <Button
              aria-label="Stop transcription session"
              onClick={() => void onStopSession()}
              size="sm"
              variant="destructive"
            >
              <Square data-icon="inline-start" />
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : null}
        </div>
      </header>

      <div className={orbitStyles.productionContent}>
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold">{config.eyebrow}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {config.hint}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">
              <ShieldCheck data-icon="inline-start" />{" "}
              {snapshot.session.recordAudio ? "Recording on" : "Recording off"}
            </Badge>
            <Badge className="hidden sm:inline-flex" variant="secondary">
              <Activity data-icon="inline-start" /> {snapshot.segments.length}{" "}
              segments
            </Badge>
          </div>
        </div>

        <div className={orbitStyles.orbitWorkspace}>
          <section
            aria-label={`${config.eyebrow} source view`}
            className={orbitStyles.captureStage}
            data-capture-state={sourceStatus.key}
            style={{ "--capture-accent": sourceAccent(mode) } as CSSProperties}
          >
            <div className={orbitStyles.captureStageGrid} />
            <div className={orbitStyles.captureStageContent}>
              <div className={orbitStyles.captureStageHint}>
                <Badge variant="secondary">
                  <CircleDot data-icon="inline-start" /> {config.badge}
                </Badge>
                <span className={orbitStyles.captureStageHintText}>
                  {config.hint}
                </span>
              </div>

              <div className={orbitStyles.captureStageBody}>
                <div className={orbitStyles.captureStageIdentity}>
                  <div className={orbitStyles.captureStageIcon}>
                    <Icon aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                      {sourceStatus.label}
                    </p>
                    <h2 className="mt-2 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
                      {sourceName}
                    </h2>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                      {config.description}
                    </p>
                  </div>
                </div>
                <div className={orbitStyles.captureStageVisual}>
                  <div className={orbitStyles.captureStagePulse} />
                  <div className={orbitStyles.captureStageVisualCore}>
                    <Wifi aria-hidden="true" />
                    <strong>{signalValue}%</strong>
                    <span>audio level</span>
                  </div>
                  <CaptureWaveform
                    active={sourceConnected && isLive}
                    level={signalLevel}
                  />
                </div>
              </div>

              <div className={orbitStyles.captureStageFooter}>
                <CaptureStageFact
                  icon={Icon}
                  label="Source"
                  value={sourceName}
                />
                <CaptureStageFact
                  icon={Link2}
                  label="Path"
                  value={getTransportValue(mode, source)}
                />
                <CaptureStageFact
                  icon={Radio}
                  label="Transcript"
                  value={
                    isLive
                      ? "Live"
                      : formatSessionStatus(snapshot.session.status)
                  }
                />
              </div>
            </div>
          </section>

          <aside
            className={cn(
              orbitStyles.orbitInspector,
              orbitStyles.captureInspector
            )}
          >
            <CaptureSignalCard
              mode={mode}
              signalValue={signalValue}
              source={source}
              sourceName={sourceName}
              sourceStatus={sourceStatus}
            />
            <CaptureConnectionCard
              mode={mode}
              sessionStatus={snapshot.session.status}
              source={source}
              sourceConnected={sourceConnected}
            />
            <Card className="shadow-none">
              <CardHeader className="gap-1 px-4 py-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Gauge /> Pipeline health
                </CardTitle>
                <CardDescription className="text-[11px]">
                  Live source diagnostics.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 px-4 pb-4">
                <HealthMetric label="Audio level" value={`${signalValue}%`} />
                <HealthMetric
                  label="Confidence"
                  value={averageConfidence(snapshot.segments)}
                />
              </CardContent>
            </Card>
          </aside>
        </div>

        <TranscriptTray
          key={snapshot.session.id}
          label={
            mode === "meeting-bot"
              ? "Meeting transcription"
              : "Live transcription"
          }
          onOpenChange={setTranscriptOpen}
          open={transcriptOpen}
          segmentCount={snapshot.segments.length}
          speakers={transcriptSpeakers}
          transcript={transcript}
        />
      </div>
    </div>
  )
}

function CaptureSignalCard({
  mode,
  signalValue,
  source,
  sourceName,
  sourceStatus,
}: {
  mode: LiveTranscriptionCaptureViewMode
  signalValue: number
  source?: TranscriptionSourceLike
  sourceName: string
  sourceStatus: CaptureStatus
}) {
  const Icon = captureModeConfig[mode].icon
  return (
    <Card
      className={orbitStyles.selectedSpeakerCard}
      style={{ "--speaker-accent": sourceAccent(mode) } as CSSProperties}
    >
      <CardHeader className="gap-2 px-4 py-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Audio level</CardTitle>
          <Badge variant={sourceStatus.variant}>{sourceStatus.label}</Badge>
        </div>
        <CardDescription className="text-[11px]">
          {captureModeConfig[mode].audioLevelDescription}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{sourceName}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {getSourceSubtitle(mode, source)}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/55 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Audio level</span>
          <span className="flex items-center gap-2 text-xs font-medium">
            <SignalBars accent={sourceAccent(mode)} value={signalValue} />
            {signalValue}%
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function CaptureConnectionCard({
  mode,
  sessionStatus,
  source,
  sourceConnected,
}: {
  mode: LiveTranscriptionCaptureViewMode
  sessionStatus: string
  source?: TranscriptionSourceLike
  sourceConnected: boolean
}) {
  const config = captureModeConfig[mode]
  const transportStatus = source?.transportStatus || source?.status || "pending"
  const rows =
    mode === "browser-system"
      ? [
          ["Capture permission", sourceConnected ? "Granted" : "Waiting"],
          ["Audio track", sourceConnected ? "Receiving" : "Not receiving"],
          ["Transcription", formatSessionStatus(sessionStatus)],
        ]
      : mode === "stream"
        ? [
            [config.transportLabel, formatTransportStatus(transportStatus)],
            ["Protocol", source?.protocol || "Remote media"],
            ["Reconnects", String(source?.reconnectCount ?? 0)],
          ]
        : [
            ["Adapter", formatTransportStatus(transportStatus)],
            ["Platform", formatPlatform(source?.platform)],
            [
              "Ingress",
              sourceConnected ? "Receiving audio" : "Waiting for bot",
            ],
          ]

  return (
    <Card className="shadow-none">
      <CardHeader className="gap-1 px-4 py-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Link2 /> Connection path
        </CardTitle>
        <CardDescription className="text-[11px]">
          {mode === "browser-system"
            ? "Audio stays in the browser capture session."
            : "The source transport stays separate from the transcript."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4 pb-4">
        {rows.map(([label, value]) => (
          <div
            className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted/45 px-3 py-2"
            key={label}
          >
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate text-right text-[11px] font-medium">
              {value}
            </span>
          </div>
        ))}
        {source?.lastError ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[11px] leading-4 text-destructive">
            {source.lastError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function CaptureStageFact({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <p className="mt-1 truncate text-xs font-medium">{value}</p>
    </div>
  )
}

function CaptureWaveform({
  active,
  level,
}: {
  active: boolean
  level: number
}) {
  const pattern = [
    0.46, 0.82, 0.58, 1, 0.68, 0.9, 0.5, 0.76, 0.42, 0.64, 0.48, 0.72,
  ]
  return (
    <div
      aria-label={`${Math.round(level * 100)}% audio level waveform`}
      className={orbitStyles.captureWaveform}
      role="img"
    >
      {pattern.map((weight, index) => {
        const scale = active
          ? Math.max(0.16, Math.min(1, 0.18 + level * (0.72 + weight * 0.55)))
          : 0.14 + (index % 3) * 0.025
        return (
          <span
            className={orbitStyles.captureWaveformBar}
            key={index}
            style={{ transform: `scaleY(${scale})` }}
          />
        )
      })}
    </div>
  )
}

function HealthMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/55 p-3">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  )
}

type TranscriptionSourceLike = LiveTranscriptionSnapshot["sources"][number]

type CaptureStatus = {
  key:
    | "connected"
    | "waiting"
    | "reconnecting"
    | "paused"
    | "completed"
    | "failed"
    | "stopped"
  label: string
  variant: "default" | "secondary" | "outline" | "destructive"
}

function findPrimarySource(
  snapshot: LiveTranscriptionSnapshot,
  mode: LiveTranscriptionCaptureViewMode
) {
  const kind = mode === "browser-system" ? "browser-system" : mode
  return snapshot.sources.find((source) => source.kind === kind)
}

function getCaptureStatus(
  snapshot: LiveTranscriptionSnapshot,
  source: TranscriptionSourceLike | undefined,
  mode: LiveTranscriptionCaptureViewMode
): CaptureStatus {
  if (snapshot.session.status === "completed") {
    return { key: "completed", label: "Complete", variant: "secondary" }
  }
  if (snapshot.session.status === "paused") {
    return { key: "paused", label: "Paused", variant: "secondary" }
  }
  if (source?.status === "stopped" || source?.transportStatus === "stopped") {
    return { key: "stopped", label: "Stopped", variant: "secondary" }
  }
  if (source?.lastError || source?.transportStatus === "failed") {
    return { key: "failed", label: "Needs attention", variant: "destructive" }
  }
  if (source?.transportStatus === "reconnecting") {
    return { key: "reconnecting", label: "Reconnecting", variant: "outline" }
  }
  if (source?.transportStatus === "connecting") {
    return { key: "reconnecting", label: "Connecting", variant: "outline" }
  }
  if (source?.status === "disconnected") {
    return mode === "browser-system"
      ? { key: "waiting", label: "Ready to capture", variant: "secondary" }
      : mode === "meeting-bot"
        ? { key: "waiting", label: "Waiting for bot", variant: "outline" }
        : { key: "reconnecting", label: "Reconnecting", variant: "outline" }
  }
  if (source?.status === "connected") {
    return { key: "connected", label: "Receiving audio", variant: "default" }
  }
  return { key: "waiting", label: "Waiting for source", variant: "secondary" }
}

function buildTranscript(
  snapshot: LiveTranscriptionSnapshot,
  partial: string,
  partialSourceId: string | null,
  partialSpeakerId: string | null
) {
  const lines: RoomTranscriptLine[] = groupTranscriptionSegments(
    snapshot.segments
  ).map((message) => ({
    id: message.id,
    timestamp: formatOffset(message.startOffsetMs),
    startOffsetMs: message.startOffsetMs,
    speakerId: message.speakerKey,
    text: message.text,
  }))
  if (partial) {
    lines.push({
      id: "partial",
      timestamp: formatOffset(snapshot.segments.at(-1)?.endOffsetMs ?? 0),
      startOffsetMs: snapshot.segments.at(-1)?.endOffsetMs ?? 0,
      speakerId:
        partialSpeakerId ||
        (partialSourceId ? `source:${partialSourceId}` : "unassigned"),
      text: partial,
      provisional: true,
    })
  }
  return lines
}

function buildTranscriptSpeakers(
  snapshot: LiveTranscriptionSnapshot
): RoomSpeaker[] {
  const sourceById = new Map(
    snapshot.sources.map((source) => [source.id, source])
  )
  const latestSegmentBySpeaker = new Map<
    string,
    TranscriptionSourceLike["id"]
  >()
  for (const segment of snapshot.segments) {
    if (segment.speakerId && segment.sourceId) {
      latestSegmentBySpeaker.set(segment.speakerId, segment.sourceId)
    }
  }
  const speakers: RoomSpeaker[] = snapshot.speakers.map((speaker, index) => {
    const source = latestSegmentBySpeaker.get(speaker.id)
      ? sourceById.get(latestSegmentBySpeaker.get(speaker.id) as string)
      : snapshot.sources[index % Math.max(snapshot.sources.length, 1)]
    const name = speaker.displayName || speaker.label || `Speaker ${index + 1}`
    return {
      id: speaker.id,
      name,
      initials: initials(name),
      role: "Speaker",
      sourceId: source?.id || "",
      source: source?.name || "Capture source",
      device: source?.deviceLabel || "",
      location: source?.kind || "",
      lastSpoke: "—",
      words: 0,
      confidence: "—",
      signal: source ? Math.round(clamp(source.signalLevel) * 100) : 0,
      accent: speaker.color || speakerAccents[index % speakerAccents.length],
      status: source?.status === "connected" ? "listening" : "quiet",
    }
  })
  const knownIds = new Set(speakers.map((speaker) => speaker.id))
  for (const [index, source] of snapshot.sources.entries()) {
    const id = `source:${source.id}`
    if (knownIds.has(id)) continue
    speakers.push({
      id,
      name: source.name || `Source ${index + 1}`,
      initials: initials(source.name || `Source ${index + 1}`),
      role: "Capture source",
      sourceId: source.id,
      source: source.name,
      device: source.deviceLabel || "",
      location: source.kind,
      lastSpoke: "—",
      words: 0,
      confidence: "—",
      signal: Math.round(clamp(source.signalLevel) * 100),
      accent: speakerAccents[index % speakerAccents.length],
      status: source.status === "connected" ? "listening" : "quiet",
    })
  }
  speakers.push({
    id: "unassigned",
    name: "Unassigned speaker",
    initials: "·",
    role: "Unassigned",
    sourceId: "",
    source: "Capture audio",
    device: "",
    location: "",
    lastSpoke: "—",
    words: 0,
    confidence: "—",
    signal: 0,
    accent: "var(--muted-foreground)",
    status: "quiet",
  })
  return speakers
}

function getSourceSubtitle(
  mode: LiveTranscriptionCaptureViewMode,
  source?: TranscriptionSourceLike
) {
  if (mode === "stream") {
    return source?.protocol
      ? `${source.protocol.toUpperCase()} decoder`
      : "Remote stream decoder"
  }
  if (mode === "meeting-bot") return formatPlatform(source?.platform)
  return source?.deviceLabel || "Shared browser audio"
}

function getTransportValue(
  mode: LiveTranscriptionCaptureViewMode,
  source?: TranscriptionSourceLike
) {
  if (mode === "stream")
    return source?.protocol?.toUpperCase() || "Remote stream"
  if (mode === "meeting-bot") return "JustAI ingress"
  return "Shared audio track"
}

function formatTransportStatus(value?: string) {
  switch (value) {
    case "connected":
      return "Connected"
    case "connecting":
      return "Connecting"
    case "reconnecting":
      return "Reconnecting"
    case "disconnected":
      return "Disconnected"
    case "stopped":
      return "Stopped"
    case "failed":
      return "Failed"
    case "paused":
      return "Paused"
    default:
      return "Waiting"
  }
}

function formatSessionStatus(value: string) {
  switch (value) {
    case "live":
      return "Live"
    case "paused":
      return "Paused"
    case "completed":
      return "Complete"
    case "processing":
      return "Processing"
    case "failed":
      return "Failed"
    default:
      return "Waiting"
  }
}

function formatPlatform(value?: string) {
  switch (value) {
    case "zoom":
      return "Zoom"
    case "google-meet":
      return "Google Meet"
    case "microsoft-teams":
      return "Microsoft Teams"
    case "generic":
      return "Custom adapter"
    default:
      return "Meeting adapter"
  }
}

function sourceAccent(mode: LiveTranscriptionCaptureViewMode) {
  if (mode === "stream") return "var(--chart-2)"
  if (mode === "meeting-bot") return "var(--chart-4)"
  return "var(--chart-1)"
}

function averageConfidence(segments: LiveTranscriptionSnapshot["segments"]) {
  const values = segments
    .map((segment) => segment.confidence)
    .filter((value): value is number => typeof value === "number")
  if (values.length === 0) return "—"
  return `${Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100)}%`
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return parts
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function formatOffset(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const formattedMinutes = String(minutes).padStart(2, "0")
  const formattedSeconds = String(seconds % 60).padStart(2, "0")
  return hours > 0
    ? `${hours}:${formattedMinutes}:${formattedSeconds}`
    : `${formattedMinutes}:${formattedSeconds}`
}
