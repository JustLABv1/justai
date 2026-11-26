"use client"

import {
  CalendarClock,
  ChevronDown,
  Check,
  Copy,
  FileText,
  Play,
  Sparkles,
  X,
  Square,
} from "lucide-react"
import {
  TopicIcon,
  TopicNotifyIcon,
  TopicQuietIcon,
} from "@/components/topic-icons"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useId, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Micro } from "@/components/panelui/micro"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Checkbox } from "@/components/panelui/checkbox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import { Input } from "@/components/panelui/input"
import { Spinner } from "@/components/panelui/spinner"
import { api } from "@/lib/api"
import type { TopicBoundaryProposal, TranscriptionTopic } from "@/lib/types"
import { cn } from "@/lib/utils"
import { workspacePath } from "@/lib/workspace-routes"
import { topicMoved } from "@/components/scheduled-capture-card"
import { TopicExportMenu } from "@/components/topic-export-menu"
import { TopicSubscriptionButton } from "@/components/topic-subscriptions"

function formatOffset(ms?: number) {
  if (ms === undefined) return ""
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${h}:${pad(m)}:${pad(s)}`
}

/** The topic passed without being captured, so it has no transcript. */
function notRecorded(topic: TranscriptionTopic) {
  return (
    topic.status === "done" &&
    (topic.detectedBy === "missed" || topic.startedOffsetMs == null)
  )
}

/**
 * Agenda items of a live session. Each item can be read, exported and summarised as
 * soon as it is finished, without waiting for the whole session to end.
 */
export function LiveTranscriptionTopics({
  sessionId,
  topics,
  onTopics,
  finishedNotice,
  onDismissNotice,
  defaultSittingNo,
  capturing = true,
  topicsOnly = false,
}: {
  sessionId: string
  topics: TranscriptionTopic[]
  onTopics: (topics: TranscriptionTopic[]) => void
  /** A starred topic that has just finished. */
  finishedNotice: TranscriptionTopic | null
  onDismissNotice: () => void
  defaultSittingNo?: number
  /** A stream is being transcribed, so a topic can be started by hand. */
  capturing?: boolean
  /** Only starred topics are recorded ("only selected topics"). */
  topicsOnly?: boolean
}) {
  const { t, locale } = useTranslations()
  const router = useRouter()
  const agendaId = useId()
  const [agendaOpen, setAgendaOpen] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [sittingNo, setSittingNo] = useState(
    defaultSittingNo ? String(defaultSittingNo) : ""
  )
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const openTopic = topics.find((topic) => topic.id === openId) ?? null

  const upsert = useCallback(
    (topic: TranscriptionTopic) =>
      onTopics(
        topics.some((item) => item.id === topic.id)
          ? topics.map((item) => (item.id === topic.id ? topic : item))
          : [...topics, topic]
      ),
    [onTopics, topics]
  )

  const activeTopic = topics.find((topic) => topic.status === "active")
  // The agenda has moved past an item once a later one has started; its slot time is
  // no guide, since sittings often run late.
  const reachedOrder = Math.max(
    -1,
    ...topics
      .filter(
        (topic) =>
          (topic.status === "active" || topic.status === "done") &&
          !notRecorded(topic)
      )
      .map((topic) => topic.order)
  )
  const passed = (topic: TranscriptionTopic) =>
    topic.status === "planned" && topic.order < reachedOrder
  const nextSelectedTopic = topicsOnly
    ? topics
        .filter((topic) => topic.starred && topic.status === "planned")
        .sort((a, b) => a.order - b.order)[0]
    : undefined
  const time = new Intl.DateTimeFormat(locale, {
    ...(topicsOnly ? { timeZone: "Europe/Berlin" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  })

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id)
    setError("")
    try {
      await action()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("The action failed.")
      )
    } finally {
      setBusyId(null)
    }
  }

  const loadTopics = async () => {
    setLoading(true)
    setError("")
    try {
      const result = await api.post<{ topics: TranscriptionTopic[] }>(
        `/api/v1/transcription/sessions/${sessionId}/topics/sync`,
        sittingNo ? { sessionNo: Number(sittingNo) } : {}
      )
      onTopics(result.topics)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("The agenda items could not be loaded.")
      )
    } finally {
      setLoading(false)
    }
  }

  const toggleStarred = (topic: TranscriptionTopic, starred: boolean) =>
    void run(topic.id, async () => {
      const result = await api.patch<{ topic: TranscriptionTopic }>(
        `/api/v1/transcription/topics/${topic.id}`,
        { starred }
      )
      upsert(result.topic)
    })

  // A finished topic opens as a transcript of its own, with speakers, summaries and
  // export. A running topic still grows, so it opens as a live text preview.
  const openTranscript = (topic: TranscriptionTopic) => {
    if (topic.status !== "done") {
      setOpenId(topic.id)
      return
    }
    void run(topic.id, async () => {
      const sessionId =
        topic.transcriptSessionId ??
        (
          await api.post<{ sessionId: string }>(
            `/api/v1/transcription/topics/${topic.id}/transcript-session`
          )
        ).sessionId
      router.push(workspacePath("transcription", null, sessionId))
    })
  }

  const statusBadge = (topic: TranscriptionTopic) =>
    notRecorded(topic) ? (
      <Badge variant="outline">{t("Not recorded")}</Badge>
    ) : topic.status === "active" ? (
      <Badge variant={topicsOnly && !topic.starred ? "secondary" : "default"}>
        {t("Topic in progress")}
      </Badge>
    ) : topic.status === "done" ? (
      <Badge variant="secondary">{t("Finished")}</Badge>
    ) : passed(topic) ? (
      <Badge variant="outline">{t("Skipped")}</Badge>
    ) : topicsOnly ? (
      topic.starred ? (
        <Badge variant="secondary">{t("Selected for recording")}</Badge>
      ) : null
    ) : (
      <Badge variant="outline">{t("Planned")}</Badge>
    )

  return (
    <section
      aria-label={t("Topics")}
      className="flex flex-col gap-3 text-left text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-medium">
          {topics.length > 0 ? (
            <Button
              aria-controls={agendaId}
              aria-expanded={agendaOpen}
              aria-label={
                agendaOpen ? t("Collapse agenda") : t("Expand agenda")
              }
              onClick={() => setAgendaOpen((open) => !open)}
              size="sm"
              variant="ghost"
            >
              <TopicIcon aria-hidden="true" className="size-4" />
              {t("Topics")}
              <ChevronDown
                aria-hidden="true"
                className={cn("size-4", !agendaOpen && "-rotate-90")}
              />
            </Button>
          ) : (
            <>
              <TopicIcon className="size-4" /> {t("Topics")}
            </>
          )}
        </h3>
        {topics.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Micro size="sm">
              <Micro.Progress
                label={t("Finished")}
                max={topics.length}
                value={topics.filter((topic) => topic.status === "done").length}
                tone="info"
              />
            </Micro>
            <TopicSubscriptionButton sessionId={sessionId} />
            {topics.some((topic) => topic.startedOffsetMs !== undefined) ? (
              <TopicExportMenu
                fileName={t("Topics")}
                label={t("Export topics")}
                onError={setError}
                path={`/api/v1/transcription/sessions/${sessionId}/topics/export`}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {topics.map((topic) =>
        topic.boundaryProposal ? (
          <BoundaryProposalCard
            busy={busyId === topic.id}
            key={`proposal-${topic.id}`}
            nextTitle={
              topics.find((item) => item.id === topic.boundaryProposal?.topicId)
                ?.title ?? ""
            }
            onDecide={(decision) =>
              void run(topic.id, async () => {
                const result = await api.post<{
                  topics: TranscriptionTopic[]
                }>(`/api/v1/transcription/topics/${topic.id}/boundary`, {
                  decision,
                })
                onTopics(result.topics)
              })
            }
            proposal={topic.boundaryProposal}
          />
        ) : null
      )}

      {nextSelectedTopic ? (
        <div className="flex items-start gap-3 rounded-lg bg-muted/60 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <CalendarClock aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {t("Next selected topic")}
            </p>
            {agendaOpen ? (
              <a
                className="font-medium underline-offset-4 hover:underline"
                href={`#agenda-topic-${nextSelectedTopic.id}`}
              >
                {nextSelectedTopic.title}
              </a>
            ) : (
              <p className="font-medium">{nextSelectedTopic.title}</p>
            )}
            {nextSelectedTopic.plannedStartAt ? (
              <p className="text-xs text-muted-foreground">
                {t("Planned for {value0} (Berlin time)", {
                  value0: time.format(
                    new Date(nextSelectedTopic.plannedStartAt)
                  ),
                })}
              </p>
            ) : null}
            {!activeTopic?.starred ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Transcription begins when a selected topic is called.")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {finishedNotice ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-900 dark:text-emerald-200"
          role="status"
        >
          <span>
            {t("“{value0}” is finished. The transcript is ready.", {
              value0: finishedNotice.title,
            })}
          </span>
          <span className="flex gap-2">
            <Button
              onClick={() => {
                openTranscript(finishedNotice)
                onDismissNotice()
              }}
              size="sm"
            >
              {t("Open transcript")}
            </Button>
            <Button onClick={onDismissNotice} size="sm" variant="ghost">
              {t("Dismiss")}
            </Button>
          </span>
        </div>
      ) : null}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {topics.length === 0 ? (
        <form
          className="space-y-3 rounded-lg bg-muted/40 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!loading) void loadTopics()
          }}
        >
          <p className="text-xs text-muted-foreground">
            {t("Load the Bundestag agenda to follow individual topics live.")}
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor={`${agendaId}-sitting`}
              className="block text-xs font-medium"
            >
              {t("Sitting number")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`${agendaId}-sitting`}
                className="h-8 w-20"
                inputMode="numeric"
                onChange={(event) =>
                  setSittingNo(event.target.value.replace(/\D/g, ""))
                }
                placeholder="110"
                value={sittingNo}
              />
              <Button disabled={loading} size="sm" type="submit">
                {loading ? <Spinner /> : null}
                {t("Load agenda")}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <ul
          id={agendaId}
          hidden={!agendaOpen}
          className="divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40"
        >
          {topics.map((topic) => (
            <li
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2",
                (topic.status === "active" ||
                  (topicsOnly &&
                    topic.starred &&
                    topic.status === "planned")) &&
                  "bg-primary/5",
                topicsOnly &&
                  !topic.starred &&
                  topic.status === "planned" &&
                  "text-muted-foreground"
              )}
              id={`agenda-topic-${topic.id}`}
              key={topic.id}
              tabIndex={-1}
            >
              {topicsOnly && topic.status === "planned" ? (
                <Checkbox
                  aria-label={t("Record “{value0}”", { value0: topic.title })}
                  checked={topic.starred}
                  disabled={busyId === topic.id}
                  onCheckedChange={(next) =>
                    toggleStarred(topic, Boolean(next))
                  }
                />
              ) : topicsOnly ? (
                <span
                  className="grid size-4 shrink-0 place-items-center"
                  aria-hidden="true"
                >
                  {topic.status === "active" ? (
                    <span className="size-2 rounded-full bg-primary" />
                  ) : (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </span>
              ) : (
                <Button
                  aria-label={
                    topic.starred
                      ? t("Do not notify me when this topic is finished")
                      : t("Notify me when this topic is finished")
                  }
                  aria-pressed={topic.starred}
                  disabled={busyId === topic.id}
                  onClick={() => toggleStarred(topic, !topic.starred)}
                  size="icon-sm"
                  title={
                    topic.starred
                      ? t("Do not notify me when this topic is finished")
                      : t("Notify me when this topic is finished")
                  }
                  variant="ghost"
                >
                  {topic.starred ? (
                    <TopicNotifyIcon className="size-4 text-primary" />
                  ) : (
                    <TopicQuietIcon className="size-4 text-muted-foreground" />
                  )}
                </Button>
              )}
              <div className="min-w-0 flex-[1_1_12rem]">
                <p className="font-medium">{topic.title}</p>
                <p className="text-xs text-muted-foreground">
                  {topic.label}
                  {topic.plannedStartAt
                    ? ` · ${t("planned")} ${time.format(new Date(topic.plannedStartAt))}–${
                        topic.plannedEndAt
                          ? time.format(new Date(topic.plannedEndAt))
                          : ""
                      }`
                    : ""}
                  {topic.status === "planned" && topicMoved(topic) ? (
                    <span className="ml-1 rounded bg-amber-500/10 px-1 text-amber-900 dark:text-amber-200">
                      {t("moved, previously {value0}", {
                        value0: time.format(new Date(topic.originalStartAt!)),
                      })}
                    </span>
                  ) : null}
                  {topic.startedOffsetMs !== undefined
                    ? ` · ${formatOffset(topic.startedOffsetMs)}${
                        topic.endedOffsetMs !== undefined
                          ? `–${formatOffset(topic.endedOffsetMs)}`
                          : ""
                      }`
                    : ""}
                </p>
              </div>
              {statusBadge(topic)}
              <div className="ml-auto flex shrink-0 gap-1.5">
                {topic.status === "planned" && capturing && !passed(topic) ? (
                  <Button
                    disabled={busyId === topic.id}
                    onClick={() =>
                      void run(topic.id, async () => {
                        const result = await api.post<{
                          topic: TranscriptionTopic
                        }>(`/api/v1/transcription/topics/${topic.id}/start`)
                        upsert(result.topic)
                      })
                    }
                    size="sm"
                    title={t("Use if the announcement was not recognised.")}
                    variant="ghost"
                  >
                    <Play data-icon="inline-start" /> {t("Start now")}
                  </Button>
                ) : null}
                {topic.status === "active" ? (
                  <Button
                    disabled={busyId === topic.id}
                    onClick={() =>
                      void run(topic.id, async () => {
                        const result = await api.post<{
                          topic: TranscriptionTopic
                        }>(`/api/v1/transcription/topics/${topic.id}/finish`)
                        upsert(result.topic)
                      })
                    }
                    size="sm"
                    variant="secondary"
                  >
                    <Square data-icon="inline-start" /> {t("Finish")}
                  </Button>
                ) : null}
                {topic.status !== "planned" && !notRecorded(topic) ? (
                  <Button
                    disabled={busyId === topic.id}
                    onClick={() => openTranscript(topic)}
                    size="sm"
                    variant="secondary"
                  >
                    <FileText data-icon="inline-start" /> {t("Transcript")}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {openTopic ? (
        <TopicTranscriptDialog
          onClose={() => setOpenId(null)}
          onTopic={upsert}
          topic={openTopic}
        />
      ) : null}
    </section>
  )
}

/**
 * Live detection missed an agenda change and an AI model found it in the transcript.
 * The user can accept or reject; otherwise JustAI applies it when the time is up.
 */
function BoundaryProposalCard({
  proposal,
  nextTitle,
  busy,
  onDecide,
}: {
  proposal: TopicBoundaryProposal
  nextTitle: string
  busy: boolean
  onDecide: (decision: "accept" | "reject") => void
}) {
  const { t } = useTranslations()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  const minutes = Math.ceil(
    (new Date(proposal.deadline).getTime() - now) / 60_000
  )

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
      role="status"
    >
      <p className="flex items-center gap-2 text-xs font-medium text-primary">
        <Sparkles aria-hidden="true" className="size-4" />
        {t("Topic change detected")}
      </p>
      <p className="font-medium">
        {t("“{value0}” probably began at {value1}.", {
          value0: nextTitle,
          value1: formatOffset(proposal.offsetMs),
        })}
      </p>
      {proposal.quote ? (
        <blockquote className="border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground italic">
          „{proposal.quote}“
        </blockquote>
      ) : null}
      {proposal.reason ? (
        <p className="text-xs text-muted-foreground">{proposal.reason}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {minutes > 0
            ? t("JustAI applies this in {value0} min unless you decide.", {
                value0: minutes,
              })
            : t("JustAI applies this now.")}
        </p>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button
            disabled={busy}
            onClick={() => onDecide("reject")}
            size="sm"
            variant="ghost"
          >
            <X data-icon="inline-start" /> {t("Reject change")}
          </Button>
          <Button disabled={busy} onClick={() => onDecide("accept")} size="sm">
            <Check data-icon="inline-start" /> {t("Accept change")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function TopicTranscriptDialog({
  topic,
  onClose,
  onTopic,
}: {
  topic: TranscriptionTopic
  onClose: () => void
  onTopic: (topic: TranscriptionTopic) => void
}) {
  const { t } = useTranslations()
  const [text, setText] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const running = topic.status === "active"

  // A running topic keeps growing, so refresh it while the dialog is open.
  useEffect(() => {
    let cancelled = false
    const fetchText = () =>
      api
        .get<{ text: string }>(
          `/api/v1/transcription/topics/${topic.id}/transcript`
        )
        .then((result) => {
          if (cancelled) return
          setText(result.text)
          setError("")
          setLoading(false)
        })
        .catch((caught) => {
          if (cancelled) return
          setError(
            caught instanceof Error
              ? caught.message
              : t("The transcript could not be loaded.")
          )
          setLoading(false)
        })
    void fetchText()
    if (!running) {
      return () => {
        cancelled = true
      }
    }
    const timer = window.setInterval(() => void fetchText(), 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [running, t, topic.id, topic.status])

  const summarize = async () => {
    setSummarizing(true)
    setError("")
    try {
      const result = await api.post<{ topic: TranscriptionTopic }>(
        `/api/v1/transcription/topics/${topic.id}/summary`
      )
      onTopic(result.topic)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("The summary could not be started.")
      )
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{topic.title}</DialogTitle>
          <DialogDescription>
            {running
              ? t(
                  "This topic is still running. The transcript updates while it goes on."
                )
              : t("This topic is finished.")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {topic.summaryStatus === "completed" && topic.summary ? (
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <Sparkles className="size-4" /> {t("Summary")}
              </p>
              <p className="whitespace-pre-wrap">{topic.summary}</p>
            </div>
          ) : null}
          {topic.summaryStatus === "processing" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("The summary is being written…")}
            </p>
          ) : null}
          {topic.summaryStatus === "failed" ? (
            <p className="text-sm text-destructive" role="alert">
              {topic.summaryError || t("The summary failed.")}
            </p>
          ) : null}
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("Loading…")}
            </p>
          ) : (
            <pre className="max-h-[50vh] overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap">
              {text}
            </pre>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 2000)
                })
                .catch(() => setError(t("Copying is not available here.")))
            }}
            variant="outline"
          >
            {copied ? (
              <Check data-icon="inline-start" />
            ) : (
              <Copy data-icon="inline-start" />
            )}
            {copied ? t("Copied") : t("Copy")}
          </Button>
          <TopicExportMenu
            fileName={topic.label || topic.title}
            onError={setError}
            path={`/api/v1/transcription/topics/${topic.id}/export`}
          />
          <Button
            disabled={
              summarizing || topic.summaryStatus === "processing" || loading
            }
            onClick={() => void summarize()}
          >
            <Sparkles data-icon="inline-start" />
            {topic.summaryStatus === "completed"
              ? t("Summarise again")
              : t("Summarise")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
