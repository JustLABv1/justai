"use client"

import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Checkbox } from "@/components/panelui/checkbox"
import { Spinner } from "@/components/panelui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

export type CaptureScope = "all" | "topics"

type AgendaItem = {
  key: string
  label: string
  title: string
  startAt: string
  endAt: string
  note?: string
}

/**
 * Choose whether a Bundestag sitting is recorded completely or only around selected
 * agenda items. With selected items, JustAI starts shortly before the first one,
 * pauses between them and ends after the last, so only those parts are transcribed.
 */
export function BundestagTopicPicker({
  sittingNo,
  scope,
  onScopeChange,
  selected,
  onSelectedChange,
}: {
  sittingNo: number
  scope: CaptureScope
  onScopeChange: (scope: CaptureScope) => void
  selected: string[]
  onSelectedChange: (keys: string[]) => void
}) {
  const { t, locale } = useTranslations()
  const [agenda, setAgenda] = useState<{
    sitting: number
    items: AgendaItem[]
    leadMinutes: number
    error?: string
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ items: AgendaItem[]; leadMinutes: number }>(
        `/api/v1/transcription/bundestag/agenda?sitting=${sittingNo}`
      )
      .then((result) => {
        if (!cancelled)
          setAgenda({
            sitting: sittingNo,
            items: result.items,
            leadMinutes: result.leadMinutes,
          })
      })
      .catch(() => {
        if (!cancelled)
          setAgenda({
            sitting: sittingNo,
            items: [],
            leadMinutes: 30,
            // Raw backend errors ("Not Found") mean little here; say what failed.
            error: t("The agenda items could not be loaded."),
          })
      })
    return () => {
      cancelled = true
    }
  }, [sittingNo, t])

  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
  const current = agenda?.sitting === sittingNo ? agenda : null
  const chosen = (current?.items ?? []).filter((item) =>
    selected.includes(item.key)
  )
  const firstStart = chosen.length
    ? new Date(
        Math.min(...chosen.map((item) => new Date(item.startAt).getTime())) -
          (current?.leadMinutes ?? 30) * 60_000
      )
    : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => onScopeChange("all")}
          size="sm"
          type="button"
          variant={scope === "all" ? "default" : "outline"}
        >
          {t("Whole sitting")}
        </Button>
        <Button
          onClick={() => onScopeChange("topics")}
          size="sm"
          type="button"
          variant={scope === "topics" ? "default" : "outline"}
        >
          {t("Only selected topics")}
        </Button>
      </div>
      <p className="text-xs leading-4 text-muted-foreground">
        {scope === "all"
          ? t(
              "The whole sitting is transcribed. Each topic is ready as soon as it is finished."
            )
          : t(
              "Only your topics are transcribed: JustAI starts {value0} minutes before the first one, pauses between them and ends after the last. This saves transcription time.",
              { value0: current?.leadMinutes ?? 30 }
            )}
      </p>
      {scope === "topics" ? (
        !current ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("Loading the agenda…")}
          </p>
        ) : current.error ? (
          <p className="text-sm text-destructive" role="alert">
            {current.error}
          </p>
        ) : current.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No agenda items are published for this sitting yet.")}
          </p>
        ) : (
          <>
            <ul className="flex max-h-72 flex-col divide-y divide-border/60 overflow-auto rounded-lg bg-muted/40">
              {current.items.map((item) => {
                const checked = selected.includes(item.key)
                return (
                  <li key={item.key}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-3 px-3 py-2 text-sm",
                        checked && "bg-primary/5"
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        className="mt-0.5"
                        onCheckedChange={(next) =>
                          onSelectedChange(
                            next
                              ? [...selected, item.key]
                              : selected.filter((key) => key !== item.key)
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{item.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {item.label} · {t("planned")}{" "}
                          {time.format(new Date(item.startAt))}–
                          {time.format(new Date(item.endAt))}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <p
              className={cn(
                "text-xs leading-4",
                chosen.length ? "text-muted-foreground" : "text-destructive"
              )}
              role={chosen.length ? undefined : "alert"}
            >
              {chosen.length && firstStart
                ? t(
                    "{value0} topics selected. Capture starts around {value1}; planned times often slip, JustAI adjusts to the delay it observes.",
                    {
                      value0: chosen.length,
                      value1: time.format(firstStart),
                    }
                  )
                : t("Choose at least one topic.")}
            </p>
          </>
        )
      ) : null}
    </div>
  )
}
