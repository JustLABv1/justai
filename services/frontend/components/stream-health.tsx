"use client"

import { useId, useState } from "react"
import { ChevronDown, WifiOff } from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Micro } from "@/components/panelui/micro"
import type { TranscriptionSource } from "@/lib/types"

export function StreamHealthNotice({
  sources,
}: {
  sources: TranscriptionSource[]
}) {
  const { t, locale } = useTranslations()
  const [expanded, setExpanded] = useState<string | null>(null)
  const prefix = useId()
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  })
  const seconds = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "second",
  })
  const notices = sources.filter(
    (source) =>
      source.kind === "stream" &&
      (source.transportStatus === "reconnecting" ||
        source.transportStatus === "failed" ||
        (source.outageCount ?? 0) > 0)
  )
  if (notices.length === 0) return null

  return (
    <>
      {notices.map((source) => {
        const reconnecting = source.transportStatus === "reconnecting"
        const failed = source.transportStatus === "failed"
        const history = source.outageHistory ?? []
        const count = source.outageCount ?? 0
        const currentStart = source.interruptedAt
          ? dateTime.format(new Date(source.interruptedAt))
          : undefined
        const hasMissingTimes =
          count > history.length + Number(Boolean(currentStart))
        const title = failed
          ? t("Capture failed")
          : reconnecting
            ? t("Reconnecting")
            : count === 1
              ? t("1 interruption")
              : t("{value0} interruptions", { value0: count })
        const duration = t("{value0} downtime", {
          value0: seconds.format(source.outageSeconds ?? 0),
        })
        const id = prefix + source.id
        const isOpen = expanded === source.id
        return (
          <div key={source.id} className="max-w-full min-w-0 shrink-0">
            <Micro
              size="sm"
              className="h-auto min-h-10 max-w-full gap-1.5 py-1 ps-2.5"
            >
              <WifiOff
                aria-hidden="true"
                className={
                  failed
                    ? "size-4 shrink-0 text-destructive"
                    : reconnecting
                      ? "size-4 shrink-0 text-warning"
                      : "size-4 shrink-0 text-muted-foreground"
                }
              />
              <Micro.Text
                className="[&>span]:wrap-anywhere [&>span]:whitespace-normal"
                value={title}
                label={duration}
              />
              <Micro.Button
                variant="ghost"
                aria-label={t("Interruption details")}
                aria-expanded={isOpen}
                aria-controls={id}
                onClick={() => setExpanded(isOpen ? null : source.id)}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={isOpen ? "rotate-180" : undefined}
                />
              </Micro.Button>
            </Micro>
            <div
              id={id}
              hidden={!isOpen}
              className="mt-2 space-y-1 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"
            >
              {failed && (
                <p>
                  {source.lastError || t("The stream could not be captured.")}
                </p>
              )}
              {reconnecting && (
                <p>
                  {currentStart
                    ? t("Stream interrupted since {value0}", {
                        value0: currentStart,
                      })
                    : t("JustAI is trying to reconnect.")}
                </p>
              )}
              {history.length > 0 && (
                <ul className="space-y-1">
                  {[...history].reverse().map(({ startedAt, endedAt }) => (
                    <li key={startedAt}>
                      {dateTime.formatRange(
                        new Date(startedAt),
                        new Date(endedAt)
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {hasMissingTimes && (
                <p>
                  {t("Some earlier interruptions only have a total duration.")}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
