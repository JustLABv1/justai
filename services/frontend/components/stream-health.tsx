"use client"

import { CircleAlert, WifiOff } from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import type { TranscriptionSource } from "@/lib/types"

type Notice = {
  id: string
  tone: "warning" | "error" | "muted"
  title: string
  text: string
}

/**
 * Says plainly when a stream capture has a problem: the stream is down right now, the
 * capture failed, or it dropped earlier and the transcript has gaps there.
 */
export function StreamHealthNotice({
  sources,
}: {
  sources: TranscriptionSource[]
}) {
  const { t, locale } = useTranslations()
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
  const notices = sources
    .filter((source) => source.kind === "stream")
    .flatMap((source): Notice[] => {
      if (source.transportStatus === "reconnecting" && source.interruptedAt)
        return [
          {
            id: source.id,
            tone: "warning",
            title: t("Stream interrupted since {value0}", {
              value0: time.format(new Date(source.interruptedAt)),
            }),
            text: t(
              "JustAI keeps reconnecting. If the stream does not come back within 15 minutes, the capture ends."
            ),
          },
        ]
      if (source.transportStatus === "failed")
        return [
          {
            id: source.id,
            tone: "error",
            title: t("Capture failed"),
            text: source.lastError || t("The stream could not be captured."),
          },
        ]
      if ((source.outageCount ?? 0) > 0)
        return [
          {
            id: source.id,
            tone: "muted",
            title: t(
              source.outageCount === 1
                ? "The stream dropped once"
                : "The stream dropped {value0} times",
              { value0: source.outageCount ?? 0 }
            ),
            text: t(
              "About {value0} minutes are missing from the transcript where the stream was down.",
              {
                value0: Math.max(
                  1,
                  Math.round((source.outageSeconds ?? 0) / 60)
                ),
              }
            ),
          },
        ]
      return []
    })
  if (notices.length === 0) return null
  return (
    <div className="flex flex-col gap-2 px-5 pt-4 sm:px-6">
      {notices.map((notice) => (
        <div
          className={
            notice.tone === "error"
              ? "flex items-start gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : notice.tone === "warning"
                ? "flex items-start gap-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
                : "flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
          }
          key={notice.id}
          role={notice.tone === "muted" ? undefined : "status"}
        >
          {notice.tone === "muted" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
          ) : (
            <WifiOff className="mt-0.5 size-4 shrink-0" />
          )}
          <p>
            <span className="font-medium">{notice.title}.</span> {notice.text}
          </p>
        </div>
      ))}
    </div>
  )
}
