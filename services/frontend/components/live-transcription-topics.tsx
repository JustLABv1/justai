"use client"

import {
  Check,
  Copy,
  Download,
  FileText,
  ListChecks,
  Play,
  Sparkles,
  Square,
  Star,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
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
import { downloadFile } from "@/lib/download-file"
import type { TranscriptionTopic } from "@/lib/types"
import { cn } from "@/lib/utils"

function formatOffset(ms?: number) {
  if (ms === undefined) return ""
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${h}:${pad(m)}:${pad(s)}`
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
}: {
  sessionId: string
  topics: TranscriptionTopic[]
  onTopics: (topics: TranscriptionTopic[]) => void
  /** A starred topic that has just finished. */
  finishedNotice: TranscriptionTopic | null
  onDismissNotice: () => void
  defaultSittingNo?: number
}) {
  const { t, locale } = useTranslations()
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

  const time = new Intl.DateTimeFormat(locale, {
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

  const statusBadge = (topic: TranscriptionTopic) =>
    topic.status === "active" ? (
      <Badge variant="default">{t("Running")}</Badge>
    ) : topic.status === "done" ? (
      <Badge variant="secondary">{t("Finished")}</Badge>
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
          <ListChecks className="size-4" /> {t("Topics")}
        </h3>
        {topics.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("{value0} of {value1} finished", {
              value0: topics.filter((topic) => topic.status === "done").length,
              value1: topics.length,
            })}
          </span>
        ) : null}
      </div>

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
                setOpenId(finishedNotice.id)
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
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            {t(
              "Load the agenda items of a Bundestag sitting. JustAI then recognises each item from the chair’s announcements and makes its transcript available as soon as it is finished."
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t("Sitting number")}
              className="w-32"
              inputMode="numeric"
              onChange={(event) =>
                setSittingNo(event.target.value.replace(/\D/g, ""))
              }
              placeholder={t("e.g. 110")}
              value={sittingNo}
            />
            <Button
              disabled={loading}
              onClick={() => void loadTopics()}
              size="sm"
              variant="outline"
            >
              {loading ? <Spinner /> : null}
              {t("Load agenda items")}
            </Button>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-lg bg-muted/40">
          {topics.map((topic) => (
            <li
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2",
                topic.status === "active" && "bg-primary/5"
              )}
              key={topic.id}
            >
              <Button
                aria-label={
                  topic.starred
                    ? t("Remove from my topics")
                    : t("Mark as my topic")
                }
                aria-pressed={topic.starred}
                onClick={() =>
                  void run(topic.id, async () => {
                    const result = await api.patch<{
                      topic: TranscriptionTopic
                    }>(`/api/v1/transcription/topics/${topic.id}`, {
                      starred: !topic.starred,
                    })
                    upsert(result.topic)
                  })
                }
                size="icon-sm"
                variant="ghost"
              >
                <Star
                  className={cn(
                    "size-4",
                    topic.starred && "fill-amber-400 text-amber-500"
                  )}
                />
              </Button>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{topic.title}</p>
                <p className="text-xs text-muted-foreground">
                  {topic.label}
                  {topic.plannedStartAt
                    ? ` · ${t("planned")} ${time.format(new Date(topic.plannedStartAt))}–${
                        topic.plannedEndAt
                          ? time.format(new Date(topic.plannedEndAt))
                          : ""
                      }`
                    : ""}
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
              <div className="flex gap-1">
                {topic.status === "planned" ? (
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
                    variant="ghost"
                  >
                    <Square data-icon="inline-start" /> {t("Finish")}
                  </Button>
                ) : null}
                {topic.status !== "planned" ? (
                  <Button
                    onClick={() => setOpenId(topic.id)}
                    size="sm"
                    variant={topic.status === "done" ? "default" : "outline"}
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
          <Button
            onClick={() =>
              void downloadFile(
                `/api/v1/transcription/topics/${topic.id}/transcript?download=1`,
                `${topic.label || topic.title}.txt`
              ).catch(() => setError(t("The download failed.")))
            }
            variant="outline"
          >
            <Download data-icon="inline-start" /> {t("Download")}
          </Button>
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
