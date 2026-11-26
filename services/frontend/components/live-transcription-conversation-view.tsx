"use client"

import { Mascot } from "@/components/mascot"
import { Workbench } from "@/components/panelui/workbench"
import { Micro } from "@/components/panelui/micro"
import { Tooltip } from "@/components/panelui/tooltip"
import { Spinner } from "@/components/panelui/spinner"
import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

import {
  Activity,
  AudioLines,
  Bot,
  CalendarClock,
  Check,
  Mic2,
  MonitorUp,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
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
import { useMemo, useState, type ReactNode } from "react"

import type { LiveTranscriptionOrbitProps } from "@/components/live-transcription-orbit"
import type { LiveTranscriptionCaptureViewMode } from "@/components/live-transcription-source-view"
import { Badge } from "@/components/panelui/badge"
import { ScheduledCaptureCard } from "@/components/scheduled-capture-card"
import { StreamHealthNotice } from "@/components/stream-health"
import { ViewLinkButton } from "@/components/transcription-view-link"
import type { TranscriptionTopic } from "@/lib/types"
import { Button } from "@/components/panelui/button"
import { RealtimeConnectionStatus } from "@/components/realtime-connection-status"
import type { SSEConnectionState } from "@/lib/sse-transport"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/panelui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  groupTranscriptionSegments,
  translateStreamAlert,
} from "@/lib/transcription"

type Props = LiveTranscriptionOrbitProps & {
  mode: "microphone" | LiveTranscriptionCaptureViewMode
  transportStatus: SSEConnectionState
  interruptionAt?: Date | null
  processingSettings?: ReactNode
  /** Agenda items of the session, readable as soon as each is finished. */
  topicsPanel?: ReactNode
  topics?: TranscriptionTopic[]
  /** Reschedule a capture that has not started yet. */
  onEditSchedule?: (
    source: LiveTranscriptionOrbitProps["snapshot"]["sources"][number]
  ) => void
}

type SourcePresentation = {
  label: string
  shortLabel: string
  icon: LucideIcon
  detail: string
  kind: string[]
}

const presentationMessages: Record<Props["mode"], SourcePresentation> = {
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
  processingSettings,
  onEditSchedule,
  topicsPanel,
  topics = [],
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
  const presentation = useTranslatedConfig(presentationMessages)

  const { t, locale } = useTranslations()

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
  const waitingForTopic =
    live &&
    snapshot.sources.length > 0 &&
    snapshot.sources.every((source) => source.captureScope === "topics") &&
    !topics.some((topic) => topic.starred && topic.status === "active")
  const nextTopic = waitingForTopic
    ? topics
        .filter((topic) => topic.starred && topic.status === "planned")
        .sort((a, b) => a.order - b.order)[0]
    : undefined
  const plannedTime = nextTopic?.plannedStartAt
    ? new Date(nextTopic.plannedStartAt).toLocaleTimeString(locale, {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : undefined
  const sourceConnected = primarySource?.status === "connected"
  const streamFailed =
    primarySource?.transportStatus === "failed" ||
    primarySource?.endReason === "aborted"
  const reconnecting = primarySource?.transportStatus === "reconnecting"
  const streamTone = streamFailed
    ? "destructive"
    : reconnecting
      ? "warning"
      : sourceConnected
        ? "success"
        : "default"
  const streamLabel = streamFailed
    ? t("Capture failed")
    : reconnecting
      ? t("Reconnecting to the stream")
      : sourceConnected
        ? t("Connected")
        : t("Waiting")
  const streamPercent = Math.round(
    Math.max(0, Math.min(1, primarySource?.signalLevel ?? level)) * 100
  )
  const hasSignal = level > 0.06 || (primarySource?.signalLevel || 0) > 0.06
  const isMicRoom = mode === "microphone"
  const pendingRequests = joinRequests.filter(
    (request) => request.status === "pending"
  )
  const [focus, setFocus] = useState(false)
  const [endDialogOpen, setEndDialogOpen] = useState(false)
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

  const scheduledSources = snapshot.sources.filter(
    (source) =>
      (source.transportStatus === "scheduled" ||
        source.transportStatus === "watching") &&
      source.scheduledStartAt
  )
  const alerts = snapshot.sources.filter((source) => source.alert)
  const scheduled =
    snapshot.session.status === "waiting" &&
    scheduledSources.length > 0 &&
    !snapshot.sources.some((source) => source.status === "connected")
  if (scheduled)
    return (
      <Workbench
        className="h-[max(32rem,calc(100dvh-8rem))]"
        compactBelow={840}
        inspectorWidth={384}
        focusShortcut={false}
      >
        <Workbench.Canvas className="items-stretch justify-start bg-none p-0">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-4 sm:px-6">
              <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold">
                  {snapshot.session.title}
                </h1>
                <Badge variant="secondary">{t("Scheduled")}</Badge>
              </div>
              <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
                {processingSettings}
                {topicsPanel && (
                  <Workbench.InspectorTrigger
                    aria-label={t("Topics")}
                    className="w-auto gap-2 px-3"
                  >
                    <PanelRight aria-hidden="true" /> {t("Topics")}
                  </Workbench.InspectorTrigger>
                )}
                <AlertDialog>
                  <AlertDialogTrigger
                    render={<Button size="sm" variant="destructive" />}
                  >
                    <X data-icon="inline-start" />{" "}
                    {t("Cancel scheduled capture")}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogTitle>
                      {t("Cancel scheduled capture?")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        "The stream will no longer start automatically at the scheduled time."
                      )}
                    </AlertDialogDescription>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("Keep scheduled")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        tone="destructive"
                        onClick={() => void onStopSession()}
                      >
                        {t("Cancel capture")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </header>
            <section
              aria-label={t("Scheduled capture")}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-6 text-center sm:px-6"
            >
              <div className="flex min-h-full flex-col items-center justify-center gap-5">
                <Mascot
                  state="sleeping"
                  size={88}
                  fallback={
                    <CalendarClock
                      aria-hidden="true"
                      className="size-8 text-muted-foreground"
                    />
                  }
                />
                <div className="flex flex-col gap-2">
                  <h2 className="text-xl font-semibold">
                    {scheduledSources.some(
                      (source) => source.transportStatus === "watching"
                    )
                      ? t("JustAI is waiting for the broadcast")
                      : t("Your transcription is scheduled")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "JustAI will capture the stream automatically. You can close your browser."
                    )}
                  </p>
                </div>
                <div className="flex w-full flex-col items-center gap-3">
                  {scheduledSources.map((source) => (
                    <ScheduledCaptureCard
                      key={source.id}
                      onEditSchedule={onEditSchedule}
                      source={source}
                      topics={topics}
                    />
                  ))}
                </div>
              </div>
            </section>
          </div>
        </Workbench.Canvas>
        {topicsPanel && (
          <Workbench.Inspector title={t("Topics")} className="ps-2">
            <div className="w-full overflow-y-auto rounded-[20px] bg-background p-4">
              {topicsPanel}
            </div>
          </Workbench.Inspector>
        )}
      </Workbench>
    )

  const header = (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b px-5 py-4 sm:px-6">
      <div className="min-w-0 flex-[1_1_16rem]">
        <p className="text-xs text-muted-foreground">
          {t("Live transcription")} <span className="mx-1">/</span>{" "}
          {snapshot.session.language === "auto"
            ? t("Automatic language")
            : snapshot.session.language}
        </p>
        <h1 className="mt-1 text-lg leading-snug font-semibold tracking-tight wrap-anywhere">
          {snapshot.session.title}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={live && !waitingForTopic ? "default" : "secondary"}>
            {loading
              ? t("Syncing")
              : waitingForTopic
                ? t("Waiting for topic")
                : snapshot.session.status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("Hosted by")} {user.displayName}
          </span>
        </div>
      </div>
      <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
        {isMicRoom ? (
          <Badge className="hidden sm:inline-flex" variant="secondary">
            <Users data-icon="inline-start" />
            {t("{value0} in room", { value0: snapshot.speakers.length || 1 })}
          </Badge>
        ) : null}
        {/* Inviting people only makes sense where they join with their microphone;
              everywhere else others can follow along with a read-only link. */}
        {isMicRoom ? (
          <Button onClick={onShare} size="sm" variant="outline">
            <Share2 data-icon="inline-start" /> {t("Invite participants")}
          </Button>
        ) : (
          <ViewLinkButton
            key={snapshot.session.id}
            sessionId={snapshot.session.id}
            owner={user}
          />
        )}
        {!capturing && mode === "browser-system" && canStartCapture ? (
          <Button onClick={() => void onStartCapture()} size="sm">
            <Play data-icon="inline-start" /> {t("Start source")}
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
              ? t("Resume session")
              : t("Pause session")}
          </Button>
        )}
        {mode === "stream" && (
          <>
            <Tooltip>
              <Tooltip.Trigger
                render={
                  <Button
                    size="icon-sm"
                    variant={focus ? "secondary" : "outline"}
                    className="group-data-compact/workbench:hidden"
                    aria-label={t("Focus view")}
                    aria-pressed={focus}
                    onClick={() => setFocus((active) => !active)}
                  />
                }
              >
                {focus ? (
                  <PanelRightOpen aria-hidden="true" />
                ) : (
                  <PanelRightClose aria-hidden="true" />
                )}
              </Tooltip.Trigger>
              <Tooltip.Content>
                {focus ? t("Show stream details") : t("Focus view")}
              </Tooltip.Content>
            </Tooltip>
            <Workbench.InspectorTrigger
              aria-label={t("Stream details")}
              className="w-auto gap-2 px-3"
            >
              <PanelRight aria-hidden="true" /> {t("Stream details")}
            </Workbench.InspectorTrigger>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("More session actions")}
                size="icon-sm"
                variant="outline"
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-44">
            <DropdownMenuItem
              variant="destructive"
              className="min-h-8 text-sm whitespace-nowrap"
              onClick={() => setEndDialogOpen(true)}
            >
              <Square /> {t("End session")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog open={endDialogOpen} onOpenChange={setEndDialogOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>{t("End this transcription?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "The live feed will stop for everyone. The transcript collected so far will be kept."
              )}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Keep session live")}</AlertDialogCancel>
              <AlertDialogAction
                tone="destructive"
                onClick={() => void onStopSession()}
              >
                {t("End session")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </header>
  )
  const transcript = (
    <section
      className={
        mode === "stream"
          ? "flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-5"
          : "flex min-w-0 flex-col self-start rounded-xl border bg-background p-5"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <AudioLines className="size-4" /> {t("Live conversation")}
          </div>
          <h2 className="mt-1 text-base font-semibold tracking-tight">
            {waitingForTopic
              ? t("Waiting for a selected topic")
              : t("Transcript in progress")}
          </h2>
        </div>
        {!waitingForTopic && (
          <Badge variant={hasSignal && live ? "default" : "secondary"}>
            <Volume2 data-icon="inline-start" />
            {hasSignal && live
              ? isMicRoom
                ? t("Someone is speaking")
                : t("Audio flowing")
              : t("Listening")}
          </Badge>
        )}
      </div>
      <div
        aria-label={t("Transcript")}
        className={`divide-y overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${mode === "stream" ? "min-h-0 flex-1" : "max-h-[min(55dvh,32rem)]"}`}
        role="region"
        tabIndex={
          lines.length > 0 || (partial && !waitingForTopic) ? 0 : undefined
        }
      >
        {waitingForTopic && (
          <div
            className={
              lines.length === 0
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4 py-8 text-center"
                : "flex items-center gap-3 py-4"
            }
            role="status"
          >
            <Mascot
              state="sleeping"
              size={lines.length === 0 ? 88 : 40}
              fallback={
                <CalendarClock
                  aria-hidden="true"
                  className="size-6 shrink-0 text-muted-foreground"
                />
              }
            />
            <div className="max-w-md">
              {nextTopic && (
                <p className="text-sm font-medium">{nextTopic.title}</p>
              )}
              {plannedTime && (
                <p className="text-sm">
                  {t("Planned for {value0} (Berlin time)", {
                    value0: plannedTime,
                  })}
                </p>
              )}
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Transcription begins when a selected topic is called.")}
              </p>
            </div>
          </div>
        )}
        {lines.length === 0 && !partial && !waitingForTopic ? (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <div className="relative grid size-24 place-items-center rounded-full border border-primary/20 bg-primary/5 text-primary shadow-[0_0_0_12px_hsl(var(--primary)/0.035)]">
              <span className="absolute inset-[-7px] rounded-full border border-primary/20 motion-safe:animate-pulse" />
              <AudioLines className="size-7" />
            </div>
            <h3 className="mt-6 text-sm font-semibold">
              {t("Listening for the first words")}
            </h3>
            <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
              {isMicRoom
                ? t(
                    "When someone in the room speaks, their words will appear here in real time."
                  )
                : t(
                    "{value0} is ready. The transcript starts as soon as audio arrives.",
                    { value0: config.label }
                  )}
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
                {hasSignal ? t("Audio detected") : t("Room is quiet")}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-muted-foreground">
                <SourceIcon className="size-3.5" />{" "}
                {primarySource?.deviceLabel || config.label}
              </span>
            </div>
            {isMicRoom ? (
              <div
                className="mt-5 flex items-center -space-x-2"
                aria-label={t("{value0} people in the room", {
                  value0: snapshot.speakers.length || 1,
                })}
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
              <p className="text-sm leading-6 wrap-anywhere">
                <span className="mr-2 font-semibold text-foreground">
                  {t(speakerName(snapshot, line.speakerKey))}
                </span>
                {line.text}
              </p>
            </article>
          ))
        )}
        {partial && !waitingForTopic ? (
          <article className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-3 py-4 text-muted-foreground">
            <time className="pt-0.5 text-xs">{t("Live")}</time>
            <p className="text-sm leading-6 wrap-anywhere">
              <span className="mr-2 font-semibold">
                {partialSourceId ? t("Speaker") : t("Listening")}
              </span>
              {partial}
            </p>
          </article>
        ) : null}
      </div>
    </section>
  )
  const details = (
    <aside className="min-w-0 space-y-3">
      {mode === "stream" && (
        <div className="flex flex-wrap items-start gap-2">
          <Micro size="sm" className="max-w-full">
            <Micro.Pulse
              live={streamTone === "success" && live && hasSignal}
              tone={streamTone}
            />
            <Micro.Text
              label={primarySource?.name || config.shortLabel}
              value={streamLabel}
            />
          </Micro>
          <Micro size="sm">
            <Micro.Ring
              label={t("Audio level")}
              value={streamPercent}
              tone="info"
            />
            <Micro.Text label={t("Audio level")} value={streamPercent + "%"} />
          </Micro>
          <StreamHealthNotice sources={snapshot.sources} />
        </div>
      )}
      {mode !== "stream" && (
        <RealtimeConnectionStatus
          interruptionAt={interruptionAt}
          status={transportStatus}
        />
      )}
      {mode !== "stream" && <StreamHealthNotice sources={snapshot.sources} />}
      {mode === "stream" && topicsPanel}
      {alerts.length > 0 ? (
        <div
          className="flex flex-col gap-1 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
          role="status"
        >
          {alerts.map((source) => (
            <p key={source.id}>
              <span className="font-medium">{source.name}:</span>{" "}
              {translateStreamAlert(t, source.alert ?? "")}
            </p>
          ))}
        </div>
      ) : null}
      {isMicRoom ? (
        <section className="rounded-xl border bg-background p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Users className="size-4" /> {t("In this room")}
            </h2>
            <Badge variant="secondary">{snapshot.speakers.length || 1}</Badge>
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
                    <strong className="block truncate text-xs">{name}</strong>
                    <small
                      className={
                        speaking
                          ? "text-[11px] text-primary"
                          : "text-[11px] text-muted-foreground"
                      }
                    >
                      {speaking ? t("Speaking now") : t("Listening")}
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
                  {pendingRequests.length} {t("waiting to join")}
                </p>
                <Button
                  aria-label={t("Refresh join requests")}
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
                          {request.deviceLabel || t("Unknown device")}
                        </p>
                      </div>
                      <Button
                        aria-label={t("Accept {value0}", {
                          value0: request.sourceName,
                        })}
                        disabled={updatingRequestId !== null}
                        onClick={() =>
                          void updateJoinRequest(request, "approve")
                        }
                        size="sm"
                      >
                        {updating ? <Spinner /> : <Check />}
                        {t("Accept")}
                      </Button>
                      <Button
                        aria-label={t("Reject {value0}", {
                          value0: request.sourceName,
                        })}
                        disabled={updatingRequestId !== null}
                        onClick={() => void updateJoinRequest(request, "deny")}
                        size="sm"
                        variant="outline"
                      >
                        <X />
                        {t("Reject")}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : mode !== "stream" ? (
        <section className="rounded-xl border bg-background p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <SourceIcon className="size-4" /> {config.shortLabel}
            </h2>
            <Badge variant={sourceConnected ? "default" : "secondary"}>
              {sourceConnected ? t("Connected") : t("Waiting")}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {primarySource?.name || config.detail}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-xs">
            <div>
              <dt className="text-muted-foreground">{t("Input")}</dt>
              <dd className="mt-1 font-medium">
                {primarySource?.deviceLabel || config.shortLabel}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("Audio level")}</dt>
              <dd className="mt-1 flex items-center gap-1 font-medium">
                <span
                  className={
                    hasSignal
                      ? "size-2 rounded-full bg-emerald-500"
                      : "size-2 rounded-full bg-muted-foreground/40"
                  }
                />{" "}
                {hasSignal ? t("Active") : t("Quiet")}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
      {mode !== "stream" && (
        <section className="rounded-xl border bg-background p-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="size-4" /> {t("Room health")}
            </h2>
            <Badge variant="secondary">
              {transportStatus.audioQuality === "good"
                ? t("Good")
                : t("Needs attention")}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t("Connection status and signal level are measured separately.")}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-xs">
            <div>
              <span className="block text-muted-foreground">
                {t("Connection")}
              </span>
              <strong className="mt-1 block capitalize">
                {transportStatus.state}
              </strong>
            </div>
            <div>
              <span className="block text-muted-foreground">
                {t("Signal level")}
              </span>
              <strong className="mt-1 block">{Math.round(level * 100)}%</strong>
            </div>
          </div>
        </section>
      )}
    </aside>
  )

  if (mode === "stream") {
    const connectionIssue =
      transportStatus.state === "reconnecting" ||
      transportStatus.state === "disconnected" ||
      transportStatus.state === "degraded" ||
      transportStatus.audioQuality !== "good" ||
      Boolean(interruptionAt)

    return (
      <Workbench
        className="h-[max(32rem,calc(100dvh-8rem))]"
        compactBelow={840}
        focus={focus}
        onFocusChange={setFocus}
        inspectorWidth={384}
      >
        <Workbench.Canvas className="items-stretch justify-start bg-none p-0">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {header}
            {(streamFailed || reconnecting) && (
              <p
                className="mx-4 mt-3 rounded-lg bg-muted px-3 py-2 text-sm"
                role="status"
              >
                <span
                  className={streamFailed ? "text-destructive" : "text-warning"}
                >
                  {streamLabel}
                </span>
                {primarySource?.lastError && streamFailed
                  ? ` · ${primarySource.lastError}`
                  : null}
              </p>
            )}
            {connectionIssue && (
              <RealtimeConnectionStatus
                className="mx-4 mt-3"
                interruptionAt={interruptionAt}
                status={transportStatus}
              />
            )}
            {transcript}
          </div>
        </Workbench.Canvas>
        <Workbench.Inspector title={t("Stream details")} className="ps-2">
          <div className="w-full overflow-y-auto rounded-[20px] bg-background p-4">
            {details}
          </div>
        </Workbench.Inspector>
      </Workbench>
    )
  }
  return (
    <div className="mx-auto w-full max-w-7xl rounded-2xl border bg-card shadow-sm">
      {header}
      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        {transcript}
        {details}
      </div>
      {topicsPanel ? (
        <div className="border-t px-5 py-4 sm:px-6">{topicsPanel}</div>
      ) : null}
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
