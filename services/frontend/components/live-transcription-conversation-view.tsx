"use client"

import {
  Activity,
  AudioLines,
  Bot,
  Check,
  LoaderCircle,
  Mic2,
  MonitorUp,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Share2,
  Square,
  Tv,
  Users,
  Volume2,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useMemo, useState } from "react"

import type { LiveTranscriptionOrbitProps } from "@/components/live-transcription-orbit"
import type { LiveTranscriptionCaptureViewMode } from "@/components/live-transcription-source-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RealtimeConnectionStatus } from "@/components/realtime-connection-status"
import type { SSEConnectionState } from "@/lib/sse-transport"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { groupTranscriptionSegments } from "@/lib/transcription"

type Props = LiveTranscriptionOrbitProps & {
  mode: "microphone" | LiveTranscriptionCaptureViewMode
  transportStatus: SSEConnectionState
  interruptionAt?: Date | null
}

type SourcePresentation = {
  label: string
  shortLabel: string
  icon: LucideIcon
  detail: string
  kind: string[]
}

const presentation: Record<Props["mode"], SourcePresentation> = {
  microphone: {
    label: "Microphone room",
    shortLabel: "Room presence",
    icon: Mic2,
    detail: "People who joined this live room.",
    kind: ["browser"],
  },
  "browser-system": {
    label: "Browser tab audio",
    shortLabel: "Browser capture",
    icon: MonitorUp,
    detail: "The shared tab or screen is the active source.",
    kind: ["browser-system"],
  },
  stream: {
    label: "Live stream",
    shortLabel: "Stream ingest",
    icon: Tv,
    detail: "Decoder and transcription run on the server.",
    kind: ["stream"],
  },
  "meeting-bot": {
    label: "Meeting bot",
    shortLabel: "Meeting ingress",
    icon: Bot,
    detail: "The meeting adapter sends audio into this room.",
    kind: ["meeting-bot"],
  },
}

export function LiveTranscriptionConversationView({
  mode,
  snapshot,
  user,
  loading,
  partial,
  partialSourceId,
  level,
  capturing,
  canStartCapture = true,
  joinRequests,
  onShare,
  onStartCapture,
  onPauseOrResume,
  onRefreshJoinRequests,
  onSetJoinRequest,
  onStopSession,
  transportStatus,
  interruptionAt,
}: Props) {
  const config = presentation[mode]
  const SourceIcon = config.icon
  const primarySource = useMemo(
    () =>
      snapshot.sources.find((source) => config.kind.includes(source.kind)) ||
      snapshot.sources[0],
    [config.kind, snapshot.sources]
  )
  const lines = useMemo(
    () => groupTranscriptionSegments(snapshot.segments),
    [snapshot.segments]
  )
  const live = snapshot.session.status === "live"
  const sourceConnected = primarySource?.status === "connected"
  const hasSignal = level > 0.06 || (primarySource?.signalLevel || 0) > 0.06
  const isMicRoom = mode === "microphone"
  const pendingRequests = joinRequests.filter(
    (request) => request.status === "pending"
  )
  const [updatingRequestId, setUpdatingRequestId] = useState<string | null>(
    null
  )

  const updateJoinRequest = async (
    request: (typeof pendingRequests)[number],
    decision: "approve" | "deny"
  ) => {
    setUpdatingRequestId(request.id)
    try {
      await onSetJoinRequest(request, decision)
    } finally {
      setUpdatingRequestId(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl rounded-2xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            Live transcription <span className="mx-1">/</span>{" "}
            {snapshot.session.language === "auto"
              ? "Automatic language"
              : snapshot.session.language}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">
              {snapshot.session.title}
            </h1>
            <Badge variant={live ? "default" : "secondary"}>
              {loading ? "Syncing" : snapshot.session.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Hosted by {user.displayName}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="hidden sm:inline-flex" variant="secondary">
            <Users data-icon="inline-start" />
            {isMicRoom
              ? `${snapshot.speakers.length || 1} in room`
              : "1 source"}
          </Badge>
          <Button onClick={onShare} size="sm" variant="outline">
            <Share2 data-icon="inline-start" /> Share
          </Button>
          {!capturing && mode === "browser-system" && canStartCapture ? (
            <Button onClick={() => void onStartCapture()} size="sm">
              <Play data-icon="inline-start" /> Start source
            </Button>
          ) : (
            <Button
              onClick={() => void onPauseOrResume()}
              size="sm"
              variant="outline"
            >
              {snapshot.session.status === "paused" ? (
                <Play data-icon="inline-start" />
              ) : (
                <Pause data-icon="inline-start" />
              )}
              {snapshot.session.status === "paused"
                ? "Resume session"
                : "Pause session"}
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  className="hidden sm:inline-flex"
                  size="sm"
                  variant="destructive"
                />
              }
            >
              <Square data-icon="inline-start" /> End session
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>End this transcription?</AlertDialogTitle>
                <AlertDialogDescription>
                  The live feed will stop for everyone. The transcript collected
                  so far will be kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep session live</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void onStopSession()}
                >
                  End session
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="More session actions"
                  className="sm:hidden"
                  size="icon-sm"
                  variant="outline"
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <AlertDialog>
                <AlertDialogTrigger
                  render={<DropdownMenuItem variant="destructive" />}
                >
                  <Square /> End session
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>End this transcription?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The live feed will stop for everyone. The transcript
                      collected so far will be kept.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep session live</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => void onStopSession()}
                    >
                      End session
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <RealtimeConnectionStatus
        className="mx-5 mt-4 sm:mx-6"
        interruptionAt={interruptionAt}
        status={transportStatus}
      />

      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="flex min-w-0 flex-col rounded-xl border bg-background p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <AudioLines className="size-4" /> Live conversation
              </div>
              <h2 className="mt-1 text-base font-semibold tracking-tight">
                Transcript in progress
              </h2>
            </div>
            <Badge variant={hasSignal && live ? "default" : "secondary"}>
              <Volume2 data-icon="inline-start" />
              {hasSignal && live
                ? isMicRoom
                  ? "Someone is speaking"
                  : "Audio flowing"
                : "Listening"}
            </Badge>
          </div>
          <div className="flex flex-1 flex-col divide-y">
            {lines.length === 0 && !partial ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                <div className="relative grid size-24 place-items-center rounded-full border border-primary/20 bg-primary/5 text-primary shadow-[0_0_0_12px_hsl(var(--primary)/0.035)]">
                  <span className="absolute inset-[-7px] rounded-full border border-primary/20 motion-safe:animate-pulse" />
                  <AudioLines className="size-7" />
                </div>
                <h3 className="mt-6 text-sm font-semibold">
                  Listening for the first words
                </h3>
                <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
                  {isMicRoom
                    ? "When someone in the room speaks, their words will appear here in real time."
                    : `${config.label} is ready. The transcript starts as soon as audio arrives.`}
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-muted-foreground">
                    <span
                      className={
                        hasSignal
                          ? "size-1.5 rounded-full bg-emerald-500"
                          : "size-1.5 rounded-full bg-amber-500"
                      }
                    />{" "}
                    {hasSignal ? "Audio detected" : "Room is quiet"}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-muted-foreground">
                    <SourceIcon className="size-3.5" />{" "}
                    {primarySource?.deviceLabel || config.label}
                  </span>
                </div>
                {isMicRoom ? (
                  <div
                    className="mt-5 flex items-center -space-x-2"
                    aria-label={`${snapshot.speakers.length || 1} people in the room`}
                  >
                    {(snapshot.speakers.length
                      ? snapshot.speakers
                      : [{ id: user.id, displayName: user.displayName }]
                    )
                      .slice(0, 4)
                      .map((speaker, index) => {
                        const name =
                          speaker.displayName ||
                          ("label" in speaker ? speaker.label : "") ||
                          `Speaker ${index + 1}`
                        return (
                          <span
                            className="grid size-7 place-items-center rounded-full border-2 border-background bg-muted text-[9px] font-semibold"
                            key={speaker.id}
                          >
                            {initials(name)}
                          </span>
                        )
                      })}
                  </div>
                ) : null}
              </div>
            ) : (
              lines.map((line) => (
                <article
                  className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-3 py-4"
                  key={line.id}
                >
                  <time className="pt-0.5 text-xs text-muted-foreground">
                    {formatOffset(line.startOffsetMs)}
                  </time>
                  <p className="text-sm leading-6">
                    <span className="mr-2 font-semibold text-foreground">
                      {speakerName(snapshot, line.speakerKey)}
                    </span>
                    {line.text}
                  </p>
                </article>
              ))
            )}
            {partial ? (
              <article className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-3 py-4 text-muted-foreground">
                <time className="pt-0.5 text-xs">Live</time>
                <p className="text-sm leading-6">
                  <span className="mr-2 font-semibold">
                    {partialSourceId ? "Speaker" : "Listening"}
                  </span>
                  {partial}
                </p>
              </article>
            ) : null}
          </div>
        </section>

        <aside className="space-y-4">
          {isMicRoom ? (
            <section className="rounded-xl border bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Users className="size-4" /> In this room
                </h2>
                <Badge variant="secondary">
                  {snapshot.speakers.length || 1}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {config.detail}
              </p>
              <div className="mt-3 space-y-1">
                {(snapshot.speakers.length
                  ? snapshot.speakers
                  : [{ id: user.id, displayName: user.displayName }]
                ).map((speaker, index) => {
                  const name =
                    speaker.displayName ||
                    ("label" in speaker ? speaker.label : "") ||
                    `Speaker ${index + 1}`
                  const speaking = hasSignal && live && index === 0
                  return (
                    <div
                      className={
                        speaking
                          ? "flex items-center gap-3 rounded-lg bg-primary/5 p-2"
                          : "flex items-center gap-3 rounded-lg p-2"
                      }
                      key={speaker.id}
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">
                        {initials(name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-xs">
                          {name}
                        </strong>
                        <small
                          className={
                            speaking
                              ? "text-[11px] text-primary"
                              : "text-[11px] text-muted-foreground"
                          }
                        >
                          {speaking ? "Speaking now" : "Listening"}
                        </small>
                      </span>
                      {speaking ? (
                        <Volume2 className="size-4 text-primary" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                      )}
                    </div>
                  )
                })}
              </div>
              {pendingRequests.length > 0 ? (
                <div className="mt-3 border-t pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium">
                      {pendingRequests.length} waiting to join
                    </p>
                    <Button
                      aria-label="Refresh join requests"
                      onClick={() => void onRefreshJoinRequests()}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <RefreshCw />
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {pendingRequests.map((request) => {
                      const updating = updatingRequestId === request.id
                      return (
                        <div
                          className="flex items-center gap-2 rounded-lg bg-muted/50 p-2"
                          key={request.id}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">
                              {request.sourceName}
                            </p>
                            <p className="truncate text-[10px] text-muted-foreground">
                              {request.deviceLabel || "Unknown device"}
                            </p>
                          </div>
                          <Button
                            aria-label={`Accept ${request.sourceName}`}
                            disabled={updatingRequestId !== null}
                            onClick={() =>
                              void updateJoinRequest(request, "approve")
                            }
                            size="sm"
                          >
                            {updating ? (
                              <LoaderCircle className="motion-safe:animate-spin" />
                            ) : (
                              <Check />
                            )}
                            Accept
                          </Button>
                          <Button
                            aria-label={`Reject ${request.sourceName}`}
                            disabled={updatingRequestId !== null}
                            onClick={() =>
                              void updateJoinRequest(request, "deny")
                            }
                            size="sm"
                            variant="outline"
                          >
                            <X />
                            Reject
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="rounded-xl border bg-background p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <SourceIcon className="size-4" /> {config.shortLabel}
                </h2>
                <Badge variant={sourceConnected ? "default" : "secondary"}>
                  {sourceConnected ? "Connected" : "Waiting"}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {primarySource?.name || config.detail}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Input</dt>
                  <dd className="mt-1 font-medium">
                    {primarySource?.deviceLabel || config.shortLabel}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Audio level</dt>
                  <dd className="mt-1 flex items-center gap-1 font-medium">
                    <span
                      className={
                        hasSignal
                          ? "size-2 rounded-full bg-emerald-500"
                          : "size-2 rounded-full bg-muted-foreground/40"
                      }
                    />{" "}
                    {hasSignal ? "Active" : "Quiet"}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          <section className="rounded-xl border bg-background p-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Activity className="size-4" /> Room health
              </h2>
              <Badge variant="secondary">
                {transportStatus.audioQuality === "good"
                  ? "Good"
                  : "Needs attention"}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Connection status and signal level are measured separately.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-xs">
              <div>
                <span className="block text-muted-foreground">Connection</span>
                <strong className="mt-1 block capitalize">
                  {transportStatus.state}
                </strong>
              </div>
              <div>
                <span className="block text-muted-foreground">
                  Signal level
                </span>
                <strong className="mt-1 block">
                  {Math.round(level * 100)}%
                </strong>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

function speakerName(snapshot: Props["snapshot"], speakerKey: string) {
  return (
    snapshot.speakers.find((speaker) => speaker.id === speakerKey)
      ?.displayName || "Speaker"
  )
}
function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}
function formatOffset(offset: number) {
  const seconds = Math.max(0, Math.floor(offset / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
