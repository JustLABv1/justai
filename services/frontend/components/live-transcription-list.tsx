"use client"

import Link from "next/link"
import { useState } from "react"
import {
  AudioLines,
  Bot,
  Check,
  CircleCheck,
  FileText,
  Mic,
  MonitorUp,
  RefreshCw,
  Tv,
  Undo2,
  Users,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { TopicIcon } from "@/components/topic-icons"
import { TranscriptionDeleteButton } from "@/components/transcription-delete-button"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Card } from "@/components/panelui/card"
import { Checkbox } from "@/components/panelui/checkbox"
import { Spinner } from "@/components/panelui/spinner"
import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { workspacePath } from "@/lib/workspace-routes"
import {
  liveLibraryGroups,
  videoLibraryDuration,
  type LiveLibraryGroupKey,
  type VideoTranscriptionLibraryItem,
} from "@/lib/video-transcription-library"

const sourceIcons: Record<string, typeof AudioLines> = {
  stream: Tv,
  browser: Mic,
  "browser-system": MonitorUp,
  "meeting-bot": Bot,
}

/**
 * The live sessions as a list grouped by time: what runs now, what is planned, then
 * by day and month. Each row says what a session was about; status shows only when it
 * means something (running, planned, or a step that needs attention).
 */
export function LiveTranscriptionList({
  items,
  selecting,
  selectedIds,
  onToggleSelected,
  onChanged,
}: {
  items: VideoTranscriptionLibraryItem[]
  selecting: boolean
  selectedIds: string[]
  onToggleSelected: (id: string) => void
  onChanged: () => void
}) {
  const { t, locale } = useTranslations()
  const groups = liveLibraryGroups(items)
  const monthFormatter = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  })
  const groupLabel = (key: LiveLibraryGroupKey) => {
    switch (key) {
      case "now":
        return t("Live now")
      case "scheduled":
        return t("Scheduled")
      case "today":
        return t("Today")
      case "yesterday":
        return t("Yesterday")
      case "week":
        return t("Earlier this week")
      default: {
        const [year, month] = key.slice("month:".length).split("-")
        return monthFormatter.format(new Date(Number(year), Number(month) - 1))
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section
          aria-labelledby={`live-group-${group.key}`}
          className="flex flex-col gap-2"
          key={group.key}
        >
          <h2
            className="flex items-center gap-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
            id={`live-group-${group.key}`}
          >
            {group.key === "now" ? (
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-primary motion-safe:animate-pulse"
              />
            ) : null}
            {groupLabel(group.key)}
          </h2>
          <Card className="gap-0 overflow-hidden p-0">
            <ul className="divide-y divide-border/60">
              {group.items.map((item) => (
                <LiveSessionRow
                  groupKey={group.key}
                  item={item}
                  key={item.id}
                  onChanged={onChanged}
                  onToggleSelected={onToggleSelected}
                  selected={selectedIds.includes(item.id)}
                  selecting={selecting}
                />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  )
}

function LiveSessionRow({
  item,
  groupKey,
  selecting,
  selected,
  onToggleSelected,
  onChanged,
}: {
  item: VideoTranscriptionLibraryItem
  groupKey: LiveLibraryGroupKey
  selecting: boolean
  selected: boolean
  onToggleSelected: (id: string) => void
  onChanged: () => void
}) {
  const { t, locale } = useTranslations()
  const [busy, setBusy] = useState(false)
  const Icon = (item.sourceKind && sourceIcons[item.sourceKind]) || AudioLines
  const title = item.title.trim() || t("Live transcription")
  const sameDay = ["now", "today", "yesterday"].includes(groupKey)
  const when = new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
  ).format(new Date(item.createdAt))
  const duration = videoLibraryDuration(item.durationMs)
  const meta = [
    item.sourceName,
    when,
    duration,
    item.speakerCount
      ? item.speakerCount === 1
        ? t("1 speaker")
        : t("{value0} speakers", { value0: item.speakerCount })
      : "",
  ].filter(Boolean)

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await action()
      onChanged()
    } catch (caught) {
      toast.add({
        type: "destructive",
        title: t(caught instanceof Error ? caught.message : failure),
      })
    } finally {
      setBusy(false)
    }
  }
  const toggleDone = () =>
    run(
      () =>
        api.patch("/api/v1/transcription/sessions", {
          ids: [item.id],
          done: !item.doneAt,
        }),
      "The status could not be saved."
    )
  const retry = () =>
    run(
      () =>
        api.post(
          `/api/v1/transcription/sessions/${item.id}/processing?action=retry`
        ),
      "Processing could not be updated."
    )

  return (
    <li
      className={cn(
        "group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40",
        selected && "bg-primary/5"
      )}
    >
      {selecting ? (
        <Checkbox
          aria-label={t("Select {value0}", { value0: title })}
          checked={selected}
          className="relative z-10 mt-2.5"
          onCheckedChange={() => onToggleSelected(item.id)}
        />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
          item.status === "live" && "bg-primary/10 text-primary"
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className={cn("min-w-0 flex-1", item.doneAt && "opacity-60")}>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            aria-label={t(selecting ? "Select {value0}" : "Open {value0}", {
              value0: title,
            })}
            className="min-w-0 truncate text-sm font-medium outline-none group-hover:underline after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            href={workspacePath("transcription", null, item.id)}
            onClick={(event) => {
              if (!selecting) return
              event.preventDefault()
              onToggleSelected(item.id)
            }}
            prefetch={false}
          >
            {title}
          </Link>
          {item.doneAt ? (
            <Check
              aria-label={t("Done")}
              className="size-3.5 shrink-0 text-success"
            />
          ) : null}
          {item.hasSummary ? (
            <FileText
              aria-label={t("With summary")}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
        </div>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {meta.map((part, index) => (
            <span className="tabular-nums" key={index}>
              {index > 0 ? <span aria-hidden="true">· </span> : null}
              {part}
            </span>
          ))}
          {item.topicsTotal ? (
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true">· </span>
              <TopicIcon aria-hidden="true" className="size-3" />
              {t("{value0} of {value1} topics", {
                value0: item.topicsDone ?? 0,
                value1: item.topicsTotal,
              })}
            </span>
          ) : null}
        </p>
        {item.excerpt ? (
          <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
            {item.excerpt}
          </p>
        ) : null}
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1.5 self-center">
        <LiveSessionStatus item={item} />
        {item.status === "failed" &&
        ["diarization", "grammar"].includes(item.stage ?? "") &&
        !selecting ? (
          <Button
            disabled={busy}
            onClick={() => void retry()}
            size="sm"
            variant="ghost"
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {t("Try again")}
          </Button>
        ) : null}
        {!selecting ? (
          <div className="flex items-center gap-0.5 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
            <Button
              aria-label={t(item.doneAt ? "Reopen" : "Mark as done")}
              disabled={busy}
              onClick={() => void toggleDone()}
              size="icon-sm"
              title={t(item.doneAt ? "Reopen" : "Mark as done")}
              variant="ghost"
            >
              {item.doneAt ? <Undo2 /> : <CircleCheck />}
            </Button>
            <TranscriptionDeleteButton
              iconOnly
              ids={[item.id]}
              onDeleted={onChanged}
            />
          </div>
        ) : null}
      </div>
    </li>
  )
}

/** Status only where it tells something; a finished, healthy session shows none. */
function LiveSessionStatus({ item }: { item: VideoTranscriptionLibraryItem }) {
  const { t, locale } = useTranslations()
  if (item.status === "live")
    return (
      <Badge dot size="sm" variant="info">
        {t("Live")}
      </Badge>
    )
  if (item.status === "paused")
    return (
      <Badge dot size="sm" variant="warning">
        {t("Paused")}
      </Badge>
    )
  if (item.status === "waiting")
    return (
      <Badge size="sm" variant="outline">
        {item.scheduledStartAt
          ? t("Starts {value0}", {
              value0: new Intl.DateTimeFormat(locale, {
                weekday: "short",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(item.scheduledStartAt)),
            })
          : t("Waiting to start…")}
      </Badge>
    )
  if (item.status === "processing")
    return (
      <Badge size="sm" variant="info">
        <Spinner className="size-3" />
        {t("Post-processing…")}
      </Badge>
    )
  if (item.status === "failed")
    return (
      <Badge dot size="sm" variant="warning">
        {item.stage === "diarization" ? (
          <>
            <Users aria-hidden="true" className="size-3" />
            {t("Speakers not recognized")}
          </>
        ) : item.stage === "grammar" ? (
          t("Polishing failed")
        ) : (
          t("Failed")
        )}
      </Badge>
    )
  if (item.streamStatus === "failed" || item.streamEndReason === "aborted")
    return (
      <Badge dot size="sm" variant="warning">
        {item.streamStatus === "failed"
          ? t("Capture failed")
          : t("Ended early")}
      </Badge>
    )
  if (item.outageCount)
    return (
      <Badge size="sm" variant="outline">
        {t(item.outageCount === 1 ? "Dropped once" : "Dropped {value0} times", {
          value0: item.outageCount,
        })}
      </Badge>
    )
  return null
}
