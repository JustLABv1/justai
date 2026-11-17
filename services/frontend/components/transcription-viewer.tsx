"use client"

import { CalendarClock, Eye, Radio, WifiOff } from "lucide-react"
import { TopicIcon } from "@/components/topic-icons"
import { useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Badge } from "@/components/panelui/badge"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type ViewSegment = {
  id: string
  speakerId?: string
  text: string
  startOffsetMs: number
  endOffsetMs: number
}
type ViewSpeaker = { id: string; name: string; color: string }
type ViewSource = {
  kind: string
  name: string
  transportStatus?: string
  scheduledStartAt?: string
  scheduledEndAt?: string
  interruptedAt?: string
  captureScope?: string
}
type ViewTopic = {
  id: string
  label: string
  title: string
  status: "planned" | "active" | "done"
  starred: boolean
  missed?: boolean
  plannedStartAt?: string
  summary?: string
}
type ViewSnapshot = {
  session: {
    title: string
    status: string
    language: string
    startedAt?: string
    endedAt?: string
  }
  segments: ViewSegment[]
  speakers: ViewSpeaker[]
  sources: ViewSource[]
  topics: ViewTopic[]
  complete: boolean
}

const speakerTone: Record<string, string> = {
  violet: "text-violet-700 dark:text-violet-300",
  blue: "text-blue-700 dark:text-blue-300",
  emerald: "text-emerald-700 dark:text-emerald-300",
  amber: "text-amber-700 dark:text-amber-300",
  rose: "text-rose-700 dark:text-rose-300",
  cyan: "text-cyan-700 dark:text-cyan-300",
}

function offsetLabel(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** Merges newer lines into the transcript, replacing lines that came again. */
function mergeSegments(current: ViewSegment[], incoming: ViewSegment[]) {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((segment) => [segment.id, segment]))
  for (const segment of incoming) byId.set(segment.id, segment)
  return [...byId.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs)
}

/**
 * The public, read-only view of a session behind a view link. It polls: new lines every
 * few seconds and the whole transcript every minute, so later corrections show up too.
 */
export function TranscriptionViewer() {
  const { t, locale } = useTranslations()
  const token = useSearchParams().get("token") ?? ""
  const [snapshot, setSnapshot] = useState<ViewSnapshot | null>(null)
  const [error, setError] = useState("")
  const [follow, setFollow] = useState(true)
  const lastOffset = useRef(-1)
  const endRef = useRef<HTMLDivElement>(null)
  const finished =
    snapshot?.session.status === "completed" ||
    snapshot?.session.status === "failed"

  const load = useCallback(
    async (full: boolean) => {
      const query = full ? "" : `?afterOffset=${lastOffset.current}`
      const result = await api.get<ViewSnapshot>(
        `/api/v1/transcription/view/${encodeURIComponent(token)}${query}`
      )
      setSnapshot((current) => {
        const segments =
          full || !current
            ? result.segments
            : mergeSegments(current.segments, result.segments)
        const last = segments.at(-1)
        if (last) lastOffset.current = last.startOffsetMs - 1
        return { ...result, segments }
      })
      setError("")
    },
    [token]
  )

  useEffect(() => {
    if (!token) return
    let cancelled = false
    let ticks = 0
    const run = (full: boolean) =>
      load(full).catch((caught) => {
        if (!cancelled)
          setError(
            caught instanceof Error
              ? caught.message
              : t("The transcript could not be loaded.")
          )
      })
    void run(true)
    if (finished) return
    const timer = window.setInterval(() => {
      ticks += 1
      void run(ticks % 15 === 0)
    }, 4_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [finished, load, t, token])

  const segmentCount = snapshot?.segments.length ?? 0
  useEffect(() => {
    if (follow && segmentCount > 0)
      endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [follow, segmentCount])

  const speakers = useMemo(
    () => new Map((snapshot?.speakers ?? []).map((s) => [s.id, s])),
    [snapshot?.speakers]
  )
  const turns = useMemo(() => {
    const out: { speakerId?: string; segments: ViewSegment[] }[] = []
    for (const segment of snapshot?.segments ?? []) {
      const last = out.at(-1)
      if (last && last.speakerId === segment.speakerId)
        last.segments.push(segment)
      else out.push({ speakerId: segment.speakerId, segments: [segment] })
    }
    return out
  }, [snapshot?.segments])

  if (!token)
    return (
      <ViewerMessage
        text={t("This link is incomplete. Ask for a new read-only link.")}
      />
    )
  if (!snapshot)
    return error ? (
      <ViewerMessage text={error} />
    ) : (
      <main className="flex min-h-full flex-1 items-center justify-center bg-background">
        <Spinner />
      </main>
    )

  const dateTime = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  })
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
  const live = snapshot.session.status === "live"
  const scheduled = snapshot.sources.find(
    (source) =>
      (source.transportStatus === "scheduled" ||
        source.transportStatus === "watching") &&
      source.scheduledStartAt
  )
  const interrupted = snapshot.sources.find(
    (source) =>
      source.transportStatus === "reconnecting" && source.interruptedAt
  )
  const topicsOnly = snapshot.sources.some(
    (source) => source.captureScope === "topics"
  )
  const topics = topicsOnly
    ? snapshot.topics.filter((topic) => topic.starred)
    : snapshot.topics

  return (
    <main className="min-h-full flex-1 bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Eye className="size-3.5" /> {t("Read-only view")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {snapshot.session.title}
            </h1>
            {live ? (
              <Badge>
                <Radio data-icon="inline-start" /> {t("Live")}
              </Badge>
            ) : scheduled ? (
              <Badge variant="secondary">{t("Scheduled")}</Badge>
            ) : finished ? (
              <Badge variant="secondary">{t("Finished")}</Badge>
            ) : null}
          </div>
          {interrupted?.interruptedAt ? (
            <p
              className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
              role="status"
            >
              <WifiOff className="size-4 shrink-0" />
              {t(
                "The stream has been interrupted since {value0}. The transcript continues when it is back.",
                { value0: time.format(new Date(interrupted.interruptedAt)) }
              )}
            </p>
          ) : null}
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section
            aria-label={t("Transcript")}
            className="flex min-h-[50vh] flex-col rounded-2xl border border-border bg-card"
          >
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <h2 className="text-sm font-medium">{t("Transcript")}</h2>
              {!finished ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {t("Follow live")}
                  <Switch checked={follow} onCheckedChange={setFollow} />
                </label>
              ) : null}
            </div>
            <div className="flex max-h-[70vh] flex-col gap-4 overflow-auto px-4 pb-4">
              {turns.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center text-sm text-muted-foreground">
                  <CalendarClock className="size-6" />
                  {scheduled?.scheduledStartAt
                    ? t("The capture starts {value0}.", {
                        value0: dateTime.format(
                          new Date(scheduled.scheduledStartAt)
                        ),
                      })
                    : t(
                        "The transcript appears here as soon as someone speaks."
                      )}
                </div>
              ) : (
                turns.map((turn) => {
                  const speaker = turn.speakerId
                    ? speakers.get(turn.speakerId)
                    : undefined
                  return (
                    <div
                      className="flex flex-col gap-1"
                      key={turn.segments[0].id}
                    >
                      <p className="flex items-baseline gap-2 text-xs">
                        <span
                          className={cn(
                            "font-medium",
                            speaker
                              ? speakerTone[speaker.color]
                              : "text-muted-foreground"
                          )}
                        >
                          {speaker?.name ?? t("Unknown speaker")}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {offsetLabel(turn.segments[0].startOffsetMs)}
                        </span>
                      </p>
                      <p className="text-sm leading-6">
                        {turn.segments.map((segment) => segment.text).join(" ")}
                      </p>
                    </div>
                  )
                })
              )}
              <div ref={endRef} />
            </div>
          </section>

          {topics.length > 0 ? (
            <aside
              aria-label={t("Agenda items")}
              className="flex flex-col gap-2 self-start rounded-2xl border border-border bg-card p-4"
            >
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <TopicIcon className="size-4" />
                {topicsOnly ? t("Selected topics") : t("Agenda items")}
              </h2>
              <ul className="flex flex-col gap-1">
                {topics.map((topic) => (
                  <li key={topic.id}>
                    <details
                      className={cn(
                        "group rounded-lg px-2 py-1.5",
                        topic.status === "active" && "bg-primary/5"
                      )}
                    >
                      <summary className="flex cursor-pointer list-none flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          {topic.title}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {topic.label}
                          {topic.label ? " · " : ""}
                          {topic.missed
                            ? t("Not recorded")
                            : topic.status === "active"
                              ? t("Running now")
                              : topic.status === "done"
                                ? topic.summary
                                  ? t("Finished · summary available")
                                  : t("Finished")
                                : topic.plannedStartAt
                                  ? t("planned {value0}", {
                                      value0: time.format(
                                        new Date(topic.plannedStartAt)
                                      ),
                                    })
                                  : t("Planned")}
                        </span>
                      </summary>
                      {topic.summary ? (
                        <p className="mt-2 rounded-md bg-muted/50 p-2 text-sm whitespace-pre-wrap">
                          {topic.summary}
                        </p>
                      ) : null}
                    </details>
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
        {error ? (
          <p className="text-xs text-muted-foreground" role="status">
            {t("Connection problem, retrying…")}
          </p>
        ) : null}
      </div>
    </main>
  )
}

function ViewerMessage({ text }: { text: string }) {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-background px-4">
      <p className="max-w-md rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {text}
      </p>
    </main>
  )
}
