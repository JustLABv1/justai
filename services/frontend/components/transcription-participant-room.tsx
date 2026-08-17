"use client"

import { LogOut, Mic, MicOff, Radio, Users, Wifi } from "lucide-react"
import { useEffect, useMemo, useRef, type CSSProperties } from "react"

import type { LiveTranscriptionSnapshot } from "@/components/live-transcription-orbit"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { SignalBars } from "@/components/live-transcription-primitives"
import {
  formatTranscriptionOffset,
  groupTranscriptionSegments,
} from "@/lib/transcription"

type ParticipantTranscriptLine = {
  id: string
  timestamp: string
  startOffsetMs: number
  name: string
  sourceName: string
  initials: string
  accent?: string
  text: string
  provisional?: boolean
}

export function TranscriptionParticipantRoom({
  snapshot,
  currentSourceId,
  connectionState,
  error,
  level,
  microphoneActive,
  partial,
  partialSourceId,
  partialSpeakerId,
  onToggleMicrophone,
  onLeaveRoom,
}: {
  snapshot: LiveTranscriptionSnapshot
  currentSourceId: string | null
  connectionState: "connecting" | "connected" | "paused"
  error: string
  level: number
  microphoneActive: boolean
  partial: string
  partialSourceId: string | null
  partialSpeakerId: string | null
  onToggleMicrophone: () => void | Promise<void>
  onLeaveRoom: () => void
}) {
  const sourceById = useMemo(
    () => new Map(snapshot.sources.map((source) => [source.id, source])),
    [snapshot.sources]
  )
  const speakerById = useMemo(
    () => new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker])),
    [snapshot.speakers]
  )
  const transcript = useMemo(() => {
    const segmentsById = new Map(
      snapshot.segments.map((segment) => [segment.id, segment])
    )
    const lines: ParticipantTranscriptLine[] = groupTranscriptionSegments(
      snapshot.segments
    ).map((message) => {
      const firstSegment = segmentsById.get(message.segmentIds[0])
      const speaker = message.speakerKey.startsWith("source:")
        ? undefined
        : speakerById.get(message.speakerKey)
      const source = firstSegment?.sourceId
        ? sourceById.get(firstSegment.sourceId)
        : undefined
      return {
        id: message.id,
        timestamp: formatTranscriptionOffset(message.startOffsetMs),
        startOffsetMs: message.startOffsetMs,
        name:
          speaker?.displayName ||
          speaker?.label ||
          source?.name ||
          "Unassigned speaker",
        sourceName: source?.name || "Room audio",
        initials: initials(
          speaker?.displayName || speaker?.label || source?.name || "?"
        ),
        accent: speaker?.color ? speakerColor(speaker.color) : undefined,
        text: message.text,
      }
    })
    if (partial.trim()) {
      const source = partialSourceId
        ? sourceById.get(partialSourceId)
        : undefined
      const speaker = partialSpeakerId
        ? speakerById.get(partialSpeakerId)
        : undefined
      lines.push({
        id: "participant-partial",
        timestamp: formatTranscriptionOffset(
          snapshot.segments.at(-1)?.endOffsetMs ?? 0
        ),
        startOffsetMs: snapshot.segments.at(-1)?.endOffsetMs ?? 0,
        name:
          speaker?.displayName ||
          speaker?.label ||
          source?.name ||
          "Unassigned speaker",
        sourceName: source?.name || "Room audio",
        initials: initials(
          speaker?.displayName || speaker?.label || source?.name || "?"
        ),
        accent: speaker?.color ? speakerColor(speaker.color) : undefined,
        text: partial,
        provisional: true,
      })
    }
    return lines
  }, [
    partial,
    partialSpeakerId,
    partialSourceId,
    snapshot,
    sourceById,
    speakerById,
  ])
  const speakingSource = useMemo(() => {
    if (partialSourceId) return sourceById.get(partialSourceId) || null
    return snapshot.sources.reduce<(typeof snapshot.sources)[number] | null>(
      (loudest, source) => {
        if (source.status !== "connected") return loudest
        if (!loudest || source.signalLevel > loudest.signalLevel) return source
        return loudest
      },
      null
    )
  }, [partialSourceId, snapshot, sourceById])
  const transcriptViewportRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)

  useEffect(() => {
    if (!followLatestRef.current) return
    const viewport = transcriptViewportRef.current
    if (!viewport) return
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [transcript])

  return (
    <main className="min-h-svh flex-1 bg-background px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <Card className="overflow-visible">
          <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Radio aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="truncate">
                    {snapshot.session.title}
                  </CardTitle>
                  <Badge
                    variant={
                      snapshot.session.status === "live"
                        ? "default"
                        : "secondary"
                    }
                  >
                    {snapshot.session.status}
                  </Badge>
                </div>
                <CardDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>Live transcription room</span>
                  <span aria-hidden="true">·</span>
                  <span>{snapshot.sources.length} microphones connected</span>
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5" variant="outline">
                <Wifi aria-hidden="true" />
                {connectionState === "connecting"
                  ? "Reconnecting…"
                  : connectionState === "paused"
                    ? "Microphone paused"
                    : "Room feed live"}
              </Badge>
              <Button
                disabled={connectionState === "connecting"}
                onClick={() => void onToggleMicrophone()}
                size="sm"
                variant={microphoneActive ? "outline" : "default"}
              >
                {microphoneActive ? (
                  <MicOff data-icon="inline-start" />
                ) : (
                  <Mic data-icon="inline-start" />
                )}
                {microphoneActive ? "Stop microphone" : "Start microphone"}
              </Button>
              <Button onClick={onLeaveRoom} size="sm" variant="ghost">
                <LogOut data-icon="inline-start" /> Leave room
              </Button>
            </div>
          </CardHeader>
        </Card>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Live transcription needs attention</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <Card className="min-h-0 overflow-hidden">
            <CardHeader className="border-b py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Live transcription</CardTitle>
                  <CardDescription className="mt-1">
                    New messages stay grouped by speaker and include room time.
                  </CardDescription>
                </div>
                <Badge variant="secondary">
                  {snapshot.segments.length} segments ·{" "}
                  {transcript.filter((line) => !line.provisional).length}{" "}
                  messages
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div
                aria-label="Live transcription messages"
                className="max-h-[min(66svh,720px)] min-h-72 overflow-y-auto overscroll-contain"
                onScroll={(event) => {
                  const viewport = event.currentTarget
                  followLatestRef.current =
                    viewport.scrollHeight -
                      viewport.scrollTop -
                      viewport.clientHeight <=
                    40
                }}
                ref={transcriptViewportRef}
                role="log"
              >
                {transcript.length === 0 ? (
                  <div className="flex min-h-72 items-center justify-center p-6 text-center text-sm text-muted-foreground">
                    Waiting for the first spoken message…
                  </div>
                ) : (
                  <div className="divide-y divide-border/70">
                    {transcript.map((line) => (
                      <article
                        className="flex min-w-0 gap-3 px-4 py-3 sm:px-5"
                        key={line.id}
                      >
                        <time
                          className="w-12 shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted-foreground"
                          dateTime={`PT${Math.max(0, Math.floor(line.startOffsetMs / 1000))}S`}
                        >
                          {line.timestamp}
                        </time>
                        <Avatar className="mt-0.5 shrink-0" size="sm">
                          <AvatarFallback
                            style={
                              {
                                background: line.accent || "var(--primary)",
                                color: "var(--background)",
                              } as CSSProperties
                            }
                          >
                            {line.initials}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="max-w-full truncate text-xs font-semibold">
                              {line.name}
                            </span>
                            <Badge
                              className="max-w-full truncate"
                              variant="outline"
                            >
                              {line.sourceName}
                            </Badge>
                            {line.provisional ? (
                              <Badge variant="secondary">Listening</Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm leading-relaxed break-words">
                            {line.text}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <aside className="flex min-h-0 flex-col gap-4">
            <Card>
              <CardHeader className="gap-1 py-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users aria-hidden="true" /> In this room
                </CardTitle>
                <CardDescription>
                  Everyone connected to the live feed.
                </CardDescription>
              </CardHeader>
              <CardContent className="max-h-[min(50svh,520px)] overflow-y-auto px-3 pb-3">
                <div className="flex flex-col gap-1">
                  {snapshot.sources.map((source) => {
                    const speaking =
                      source.id === speakingSource?.id &&
                      source.status === "connected" &&
                      (source.signalLevel > 0.04 ||
                        source.id === partialSourceId)
                    const local = source.id === currentSourceId
                    return (
                      <div
                        className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-2"
                        key={source.id}
                      >
                        <Avatar size="sm">
                          <AvatarFallback>
                            {initials(source.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-xs font-medium">
                              {source.name}
                            </span>
                            {local ? (
                              <Badge variant="secondary">You</Badge>
                            ) : null}
                          </div>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {speaking ? "Speaking now" : source.status}
                            {source.deviceLabel
                              ? ` · ${source.deviceLabel}`
                              : ""}
                          </span>
                        </div>
                        <SignalBars
                          accent={speaking ? "var(--primary)" : undefined}
                          value={Math.round(
                            (local ? level : source.signalLevel) * 100
                          )}
                        />
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="gap-1 py-4">
                <CardTitle className="text-sm">Your microphone</CardTitle>
                <CardDescription>
                  Stopping capture keeps you in the room and preserves the live
                  feed.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 px-4 pb-4">
                <div className="rounded-xl bg-muted/55 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">
                      {snapshot.sources.find(
                        (source) => source.id === currentSourceId
                      )?.name || "Your microphone"}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {Math.round(level * 100)}%
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-150"
                      style={{ width: `${Math.round(level * 100)}%` }}
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {microphoneActive
                    ? "Your audio is being sent after host approval."
                    : "Your audio is paused; you can still see the room."}
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  )
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

function speakerColor(value: string) {
  if (value.startsWith("var(")) return value
  const colors: Record<string, string> = {
    blue: "var(--chart-1)",
    cyan: "var(--chart-2)",
    green: "var(--chart-3)",
    orange: "var(--chart-4)",
    violet: "var(--chart-5)",
  }
  return colors[value] || "var(--primary)"
}
