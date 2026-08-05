"use client"

import {
  Activity,
  AudioLines,
  Check,
  CircleDot,
  Gauge,
  Mic2,
  Pencil,
  Radio,
  RefreshCw,
  Share2,
  ShieldCheck,
  Square,
  Users,
  X,
} from "lucide-react"
import { useMemo, useState, type CSSProperties } from "react"

import {
  ListenCore,
  SignalBars,
  SpeakerDetailDialog,
  SpeakerNode,
  TranscriptTray,
  type RoomSpeaker,
  type RoomTranscriptLine,
} from "@/app/prototypes/transcription/prototype-data"
import orbitStyles from "@/app/prototypes/transcription/prototype.module.css"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type {
  TranscriptionJoinRequest,
  TranscriptionRecording,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSource,
  TranscriptionSpeaker,
  User,
} from "@/lib/types"
import { cn } from "@/lib/utils"

export type LiveTranscriptionSnapshot = {
  session: TranscriptionSession
  sources: TranscriptionSource[]
  speakers: TranscriptionSpeaker[]
  segments: TranscriptionSegment[]
  recordings: TranscriptionRecording[]
}

type LiveTranscriptionOrbitProps = {
  snapshot: LiveTranscriptionSnapshot
  user: User
  loading: boolean
  partial: string
  partialSourceId: string | null
  partialSpeakerId: string | null
  level: number
  capturing: boolean
  joinRequests: TranscriptionJoinRequest[]
  onShare: () => void
  onStartCapture: () => void | Promise<void>
  onPauseOrResume: () => void | Promise<void>
  onStopSession: () => void | Promise<void>
  onRefreshJoinRequests: () => void | Promise<void>
  onSetJoinRequest: (
    request: TranscriptionJoinRequest,
    status: "approve" | "deny"
  ) => void | Promise<void>
  onRenameSpeaker: (speakerId: string, name: string) => void | Promise<void>
}

const speakerAccents = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function LiveTranscriptionOrbit({
  snapshot,
  user,
  loading,
  partial,
  partialSourceId,
  partialSpeakerId,
  level,
  capturing,
  joinRequests,
  onShare,
  onStartCapture,
  onPauseOrResume,
  onStopSession,
  onRefreshJoinRequests,
  onSetJoinRequest,
  onRenameSpeaker,
}: LiveTranscriptionOrbitProps) {
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [focusedSourceId, setFocusedSourceId] = useState<string | null>(null)
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const sourceById = useMemo(
    () => new Map(snapshot.sources.map((source) => [source.id, source])),
    [snapshot.sources]
  )
  const latestSegmentBySpeaker = useMemo(() => {
    const segments = [...snapshot.segments].sort(
      (left, right) => right.startOffsetMs - left.startOffsetMs
    )
    return new Map(
      segments
        .filter((segment) => segment.speakerId)
        .map((segment) => [segment.speakerId as string, segment])
    )
  }, [snapshot.segments])
  const dominantSourceId = useMemo(() => {
    const browserSource = snapshot.sources.find((source) => source.kind === "browser")
    if (capturing && level > 0.12 && browserSource) {
      return browserSource.id
    }
    const activeSources = snapshot.sources.filter(
      (source) => source.status === "connected" || source.signalLevel > 0.02
    )
    return activeSources.reduce<string | null>(
      (dominant, source) => {
        if (!dominant) return source.id
        return source.signalLevel > (sourceById.get(dominant)?.signalLevel ?? 0)
          ? source.id
          : dominant
      },
      null
    )
  }, [capturing, level, snapshot.sources, sourceById])

  const mappedSpeakers = useMemo(() => {
    if (snapshot.speakers.length > 0) {
      return snapshot.speakers.map((speaker, index) => {
        const segment = latestSegmentBySpeaker.get(speaker.id)
        const source = segment?.sourceId
          ? sourceById.get(segment.sourceId)
          : snapshot.sources[index % Math.max(snapshot.sources.length, 1)]
        const signal = source ? Math.round(clamp(source.signalLevel) * 100) : 0
        const name = speaker.displayName || speaker.label || `Speaker ${index + 1}`
        return {
          id: speaker.id,
          name,
          initials: initials(name),
          role: "Speaker",
          sourceId: source?.id || "",
          source: source?.name || "Room source",
          device: source?.deviceLabel || "Unknown capture device",
          location: source?.kind || "room",
          lastSpoke: segment ? formatOffset(segment.startOffsetMs) : "—",
          words: segment ? wordCount(segment.text) : 0,
          confidence: segment?.confidence == null ? "—" : `${Math.round(segment.confidence * 100)}%`,
          signal,
          accent: speaker.color || speakerAccents[index % speakerAccents.length],
          status: source?.id === dominantSourceId && snapshot.session.status === "live" ? "speaking" : source?.status === "connected" ? "listening" : "quiet",
        } satisfies RoomSpeaker
      })
    }

    return snapshot.sources.map((source, index) => {
      const name = source.name || `Source ${index + 1}`
      return {
        id: `source:${source.id}`,
        name,
        initials: initials(name),
        role: "Capture source",
        sourceId: source.id,
        source: source.name,
        device: source.deviceLabel || "Unknown capture device",
        location: source.kind || "room",
        lastSpoke: "—",
        words: 0,
        confidence: "—",
        signal: Math.round(clamp(source.signalLevel) * 100),
        accent: speakerAccents[index % speakerAccents.length],
        status: source.id === dominantSourceId && snapshot.session.status === "live" ? "speaking" : source.status === "connected" ? "listening" : "quiet",
      } satisfies RoomSpeaker
    })
  }, [dominantSourceId, latestSegmentBySpeaker, snapshot.session.status, snapshot.sources, snapshot.speakers, sourceById])

  const transcriptSpeakers = useMemo(() => {
    const unassigned: RoomSpeaker = {
      id: "unassigned",
      name: "Unassigned speaker",
      initials: "·",
      role: "Unassigned",
      sourceId: "",
      source: "Room audio",
      device: "",
      location: "",
      lastSpoke: "—",
      words: 0,
      confidence: "—",
      signal: 0,
      accent: "var(--muted-foreground)",
      status: "quiet",
    }
    return [...mappedSpeakers, unassigned]
  }, [mappedSpeakers])

  const activeSpeaker = dominantSourceId
    ? mappedSpeakers.find((speaker) => speaker.sourceId === dominantSourceId) || null
    : null
  const selectedSpeaker = mappedSpeakers.find((speaker) => speaker.id === selectedSpeakerId) || null
  const selectedIsRealSpeaker = Boolean(
    selectedSpeaker && snapshot.speakers.some((speaker) => speaker.id === selectedSpeaker.id)
  )
  const focusedSource = sourceById.get(
    focusedSourceId || activeSpeaker?.sourceId || snapshot.sources[0]?.id || ""
  )

  const transcript = useMemo(() => {
    const lines: RoomTranscriptLine[] = snapshot.segments.map((segment) => ({
      id: segment.id,
      timestamp: formatOffset(segment.startOffsetMs),
      speakerId: segment.speakerId || (segment.sourceId ? `source:${segment.sourceId}` : "unassigned"),
      text: segment.text,
    }))
    if (partial) {
      lines.push({
        id: "partial",
        timestamp: formatOffset(snapshot.segments.at(-1)?.endOffsetMs ?? 0),
        speakerId: partialSpeakerId || (partialSourceId ? `source:${partialSourceId}` : activeSpeaker?.id || "unassigned"),
        text: partial,
        provisional: true,
      })
    }
    return lines
  }, [activeSpeaker?.id, partial, partialSourceId, partialSpeakerId, snapshot.segments])

  const selectSpeaker = (speaker: RoomSpeaker) => {
    setSelectedSpeakerId(speaker.id)
    if (speaker.sourceId) setFocusedSourceId(speaker.sourceId)
    if (snapshot.speakers.some((item) => item.id === speaker.id)) setDetailOpen(true)
  }

  const isLive = capturing
    ? snapshot.session.status !== "paused" && snapshot.session.status !== "completed"
    : snapshot.session.status === "live"
  const pendingRequests = joinRequests.filter((request) => request.status === "pending")
  const selectedAccent = selectedSpeaker?.accent || "var(--primary)"

  return (
    <div className={orbitStyles.productionVariant}>
      <header className={orbitStyles.sessionHeader}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Live transcription</span>
            <span>/</span>
            <span className="truncate">{snapshot.session.language === "auto" ? "Automatic language" : snapshot.session.language}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">{snapshot.session.title}</h1>
            <Badge variant={isLive ? "default" : "secondary"}>{loading ? "Syncing" : snapshot.session.status}</Badge>
            <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">Hosted by {user.displayName}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className="hidden sm:inline-flex" variant="secondary"><Users data-icon="inline-start" /> {snapshot.sources.length} sources</Badge>
          {snapshot.session.status !== "completed" ? (
            <Button aria-label="Share transcription room" onClick={onShare} size="sm" variant="outline">
              <Share2 data-icon="inline-start" />
              <span className="hidden sm:inline">Share</span>
            </Button>
          ) : null}
          {!capturing && snapshot.session.status !== "completed" ? (
            <Button aria-label="Start microphone" onClick={() => void onStartCapture()} size="sm">
              <Mic2 data-icon="inline-start" />
              <span className="hidden sm:inline">Start microphone</span>
            </Button>
          ) : null}
          {capturing && snapshot.session.status !== "completed" ? (
            <Button aria-label={snapshot.session.status === "paused" ? "Resume listening" : "Pause listening"} onClick={() => void onPauseOrResume()} size="sm" variant="outline">
              {snapshot.session.status === "paused" ? <AudioLines data-icon="inline-start" /> : <X data-icon="inline-start" />}
              <span className="hidden sm:inline">{snapshot.session.status === "paused" ? "Resume" : "Pause"}</span>
            </Button>
          ) : null}
          {snapshot.session.status !== "completed" ? (
            <Button aria-label="Stop transcription session" onClick={() => void onStopSession()} size="sm" variant="destructive">
              <Square data-icon="inline-start" />
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : null}
        </div>
      </header>

      <div className={orbitStyles.productionContent}>
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold">Room orbit</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">Click a speaker to inspect its source, signal, and label.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline"><ShieldCheck data-icon="inline-start" /> {snapshot.session.recordAudio ? "Recording on" : "Recording off"}</Badge>
            <Badge className="hidden sm:inline-flex" variant="secondary"><Activity data-icon="inline-start" /> {snapshot.segments.length} segments</Badge>
          </div>
        </div>

        <div className={orbitStyles.orbitWorkspace}>
          <section aria-label="Speaker orbit" className={orbitStyles.orbitCanvas}>
            <div className={orbitStyles.orbitHint}>
              <Badge variant="secondary"><CircleDot data-icon="inline-start" /> Room view</Badge>
              <span className={orbitStyles.orbitHintText}>{snapshot.speakers.length > 0 ? "Anonymous speaker labels are editable" : "Sources are ready; labels arrive after diarization"}</span>
            </div>
            <div aria-hidden="true" className={orbitStyles.orbitTrack} />
            {mappedSpeakers.map((speaker, index) => (
              <SpeakerNode
                active={speaker.sourceId === dominantSourceId}
                angle={(360 / Math.max(mappedSpeakers.length, 1)) * index}
                key={speaker.id}
                onClick={() => selectSpeaker(speaker)}
                speaker={speaker}
              />
            ))}
            <ListenCore activeSpeaker={activeSpeaker} isLive={isLive} />
            <div className="absolute bottom-5 left-1/2 z-[2] -translate-x-1/2 text-center">
              <p className="text-xs font-medium">{activeSpeaker ? `${activeSpeaker.source} is dominant` : "Waiting for audio"}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{capturing ? `${Math.round(level * 100)}% local signal · source-separated audio` : "Viewer mode · live room feed"}</p>
            </div>
          </section>

          <aside className={orbitStyles.orbitInspector}>
            <Card className={orbitStyles.selectedSpeakerCard} style={{ "--speaker-accent": selectedAccent } as CSSProperties}>
              <CardHeader className="gap-2 px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">{selectedSpeaker ? "Selected source" : "Room signal"}</CardTitle>
                  <Badge variant={selectedSpeaker?.status === "speaking" ? "default" : "secondary"}>{selectedSpeaker?.status === "speaking" ? "Speaking" : isLive ? "Listening" : "Paused"}</Badge>
                </div>
                <CardDescription className="text-[11px]">{selectedSpeaker ? "The selected circle follows this capture source." : "The orb follows the loudest connected microphone."}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4 pb-4">
                {selectedSpeaker ? (
                  <div className="flex items-center gap-3">
                    <Avatar size="lg">
                      <AvatarFallback style={{ background: selectedSpeaker.accent, color: "var(--background)" } as CSSProperties}>{selectedSpeaker.initials}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{selectedSpeaker.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{selectedSpeaker.source} · {selectedSpeaker.device}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Radio data-icon="inline-start" /></div>
                    <div className="min-w-0"><p className="truncate text-sm font-semibold">{focusedSource?.name || activeSpeaker?.source || "No source yet"}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{focusedSource?.deviceLabel || "Waiting for a microphone"}</p></div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/55 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">Signal quality</span>
                  <span className="flex items-center gap-2 text-xs font-medium"><SignalBars accent={selectedSpeaker?.accent} value={selectedSpeaker?.signal ?? Math.round(clamp(focusedSource?.signalLevel ?? 0) * 100)} /> {selectedSpeaker?.signal ?? Math.round(clamp(focusedSource?.signalLevel ?? 0) * 100)}%</span>
                </div>
                {selectedIsRealSpeaker ? <Button onClick={() => setDetailOpen(true)} size="sm" variant="outline"><Pencil data-icon="inline-start" /> Edit speaker details</Button> : null}
              </CardContent>
            </Card>

            <ProductionSourceSummary activeSourceId={focusedSourceId || dominantSourceId} onSourceChange={setFocusedSourceId} sources={snapshot.sources} speakers={mappedSpeakers} />

            {pendingRequests.length > 0 ? (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-3 px-4 py-4">
                  <div><CardTitle className="text-sm">Join requests</CardTitle><CardDescription className="text-[11px]">Approve another microphone.</CardDescription></div>
                  <Button aria-label="Refresh join requests" onClick={() => void onRefreshJoinRequests()} size="icon-sm" variant="ghost"><RefreshCw data-icon="inline-start" /></Button>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 px-4 pb-4">
                  {pendingRequests.map((request) => (
                    <div className="flex items-center gap-2" key={request.id}>
                      <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{request.sourceName}</p><p className="truncate text-[10px] text-muted-foreground">{request.deviceLabel || "Unknown device"}</p></div>
                      <Button aria-label={`Approve ${request.sourceName}`} onClick={() => void onSetJoinRequest(request, "approve")} size="icon-sm" variant="outline"><Check data-icon="inline-start" /></Button>
                      <Button aria-label={`Deny ${request.sourceName}`} onClick={() => void onSetJoinRequest(request, "deny")} size="icon-sm" variant="ghost"><X data-icon="inline-start" /></Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {snapshot.recordings.length > 0 ? <RecordingCard recordings={snapshot.recordings} sources={snapshot.sources} /> : null}

            <Card className="shadow-none">
              <CardHeader className="gap-1 px-4 py-4"><CardTitle className="flex items-center gap-2 text-sm"><Gauge /> Room health</CardTitle><CardDescription className="text-[11px]">Live pipeline diagnostics.</CardDescription></CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 px-4 pb-4"><HealthMetric label="Sources" value={String(snapshot.sources.length)} /><HealthMetric label="Confidence" value={averageConfidence(snapshot.segments)} /></CardContent>
            </Card>
          </aside>
        </div>

        <TranscriptTray key={snapshot.session.id} onOpenChange={setTranscriptOpen} open={transcriptOpen} speakers={transcriptSpeakers} transcript={transcript} />
      </div>

      <SpeakerDetailDialog
        onOpenChange={setDetailOpen}
        onSave={(speakerId, name) => void onRenameSpeaker(speakerId, name)}
        open={detailOpen}
        speaker={selectedIsRealSpeaker ? selectedSpeaker : null}
      />
    </div>
  )
}

function ProductionSourceSummary({
  sources,
  speakers,
  activeSourceId,
  onSourceChange,
}: {
  sources: TranscriptionSource[]
  speakers: RoomSpeaker[]
  activeSourceId: string | null
  onSourceChange: (sourceId: string) => void
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="gap-1 px-4 py-4"><CardTitle className="flex items-center gap-2 text-sm"><Mic2 /> Capture sources</CardTitle><CardDescription className="text-[11px]">Each microphone stays source-separated.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-1 px-3 pb-3">
        {sources.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">No microphones have joined yet.</p> : sources.map((source) => {
          const sourceSpeaker = speakers.find((speaker) => speaker.sourceId === source.id)
          const active = activeSourceId === source.id
          const value = Math.round(clamp(source.signalLevel) * 100)
          return (
            <Button aria-pressed={active} className={cn("h-auto justify-start gap-2 rounded-xl px-2 py-2 text-left", active && "bg-muted")} key={source.id} onClick={() => onSourceChange(source.id)} variant="ghost">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><Mic2 data-icon="inline-start" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{source.name}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{source.deviceLabel || source.kind} · {source.status}</span></span>
              <SignalBars accent={sourceSpeaker?.accent} value={value} />
            </Button>
          )
        })}
      </CardContent>
    </Card>
  )
}

function RecordingCard({ recordings, sources }: { recordings: TranscriptionRecording[]; sources: TranscriptionSource[] }) {
  return (
    <Card>
      <CardHeader className="gap-1 px-4 py-4"><CardTitle className="text-sm">Audio tracks</CardTitle><CardDescription className="text-[11px]">Source recordings remain available until retention expires.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 pb-4">{recordings.map((recording) => <div className="flex flex-col gap-2" key={recording.id}><div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span className="truncate">{sources.find((source) => source.id === recording.sourceId)?.name || "Source"}</span><span className="shrink-0">{recording.expiresAt ? `Until ${new Date(recording.expiresAt).toLocaleDateString()}` : ""}</span></div><audio controls preload="none" src={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080"}/api/v1/transcription/recordings/${recording.id}`} /></div>)}</CardContent>
    </Card>
  )
}

function HealthMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-muted/55 p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

function wordCount(value: string) {
  return value.trim() ? value.trim().split(/\s+/).length : 0
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return parts.map((part) => part[0]).join("").slice(0, 2).toUpperCase()
}

function formatOffset(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function averageConfidence(segments: TranscriptionSegment[]) {
  const values = segments.map((segment) => segment.confidence).filter((value): value is number => typeof value === "number")
  if (values.length === 0) return "—"
  return `${Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100)}%`
}
