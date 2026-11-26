"use client"

import { Pencil } from "lucide-react"
import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { translateStreamAlert } from "@/lib/transcription"
import type { TranscriptionSource, TranscriptionTopic } from "@/lib/types"

/** A start time that moved by more than a minute since it was first planned. */
export function topicMoved(topic: TranscriptionTopic) {
  return Boolean(
    topic.originalStartAt &&
    topic.plannedStartAt &&
    Math.abs(
      new Date(topic.originalStartAt).getTime() -
        new Date(topic.plannedStartAt).getTime()
    ) > 60_000
  )
}

/** Ticks once a second during the last hours, once a minute before that. */
function useNow(target: number) {
  const [now, setNow] = useState(() => Date.now())
  const close = target - now < 3 * 3_600_000
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      close ? 1_000 : 30_000
    )
    return () => window.clearInterval(timer)
  }, [close])
  return now
}

function Countdown({
  target,
  watching,
}: {
  target: string
  watching: boolean
}) {
  const { t, locale } = useTranslations()
  const at = new Date(target).getTime()
  const now = useNow(at)
  const left = at - now
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  let text: string
  if (watching) text = t("Listening for the broadcast")
  else if (left <= 0) text = t("Starting…")
  else if (left >= 48 * 3_600_000)
    text = t("Starts {value0}", {
      value0: relative.format(Math.floor(left / 86_400_000), "day"),
    })
  else if (left >= 3 * 3_600_000)
    text = t("Starts {value0}", {
      value0: relative.format(Math.floor(left / 3_600_000), "hour"),
    })
  else {
    const total = Math.floor(left / 1000)
    const pad = (n: number) => String(n).padStart(2, "0")
    text = t("Starts in {value0}", {
      value0: `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`,
    })
  }
  return (
    <p
      aria-live="off"
      className="text-2xl font-semibold tracking-tight tabular-nums"
    >
      {text}
    </p>
  )
}

/**
 * What a scheduled stream capture is going to do: a countdown, when it starts and ends,
 * and for "only selected topics" which items it records and whether the plan moved them.
 */
export function ScheduledCaptureCard({
  source,
  topics,
  onEditSchedule,
}: {
  source: TranscriptionSource
  topics: TranscriptionTopic[]
  onEditSchedule?: (source: TranscriptionSource) => void
}) {
  const { t, locale } = useTranslations()
  const watching = source.transportStatus === "watching"
  const topicsOnly = source.captureScope === "topics"
  const moved = topics.filter(
    (topic) => topic.status === "planned" && topicMoved(topic)
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
  const start = source.scheduledStartAt!

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl bg-muted/40 p-5 text-left text-sm">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">
          {source.name || t("Live stream")}
        </p>
        {topicsOnly ? (
          <p className="text-lg font-semibold">
            {t("Scheduled topic monitoring")}
          </p>
        ) : (
          <Countdown target={start} watching={watching} />
        )}
        <p className="text-muted-foreground">
          {topicsOnly
            ? t(
                "Monitoring from {value0}. Transcription begins when a selected topic is called.",
                { value0: dateTime.format(new Date(start)) }
              )
            : watching
              ? t("Listening now. Capture begins as soon as speech is heard.")
              : source.startMode === "when_live"
                ? t(
                    "Watches from {value0}; capture begins when speech is heard.",
                    {
                      value0: dateTime.format(new Date(start)),
                    }
                  )
                : dateTime.format(new Date(start))}
        </p>
      </div>

      {source.alert ? (
        <p
          className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200"
          role="status"
        >
          {translateStreamAlert(t, source.alert)}
        </p>
      ) : null}

      {topicsOnly ? (
        <p className="text-muted-foreground">
          {t(
            "Pauses between the selected topics and ends after the last one. If the sitting runs late, JustAI waits longer; at the latest it stops at {value0}.",
            {
              value0: source.scheduledEndAt
                ? time.format(new Date(source.scheduledEndAt))
                : "–",
            }
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">
          {source.scheduledEndAt
            ? t("Ends at the latest {value0}.", {
                value0: dateTime.format(new Date(source.scheduledEndAt)),
              })
            : t("Stops when the stream ends.")}
        </p>
      )}

      {moved.length > 0 ? (
        <p className="text-xs text-amber-900 dark:text-amber-200">
          {t("The Bundestag plan moved {value0} agenda items.", {
            value0: moved.length,
          })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {source.planFollow || topicsOnly
            ? t(
                "JustAI regularly checks the Bundestag plan and follows changes."
              )
            : t("The JustAI server must remain running.")}
        </p>
        {onEditSchedule && !topicsOnly ? (
          <Button
            onClick={() => onEditSchedule(source)}
            size="sm"
            variant="outline"
          >
            <Pencil data-icon="inline-start" /> {t("Edit schedule")}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
