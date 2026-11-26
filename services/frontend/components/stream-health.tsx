"use client"

import { WifiOff } from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Alert, type AlertTone } from "@/components/panelui/alert"
import type { TranscriptionSource } from "@/lib/types"

export function StreamHealthNotice({
  sources,
}: {
  sources: TranscriptionSource[]
}) {
  const { t, locale } = useTranslations()
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
    <div className="flex flex-col gap-2">
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
        const tone: AlertTone = failed
          ? "destructive"
          : reconnecting
            ? "warning"
            : "neutral"
        const title = failed
          ? t("Capture failed")
          : reconnecting
            ? currentStart
              ? t("Stream interrupted since {value0}", { value0: currentStart })
              : t("Reconnecting to the stream")
            : count === 1
              ? t("The stream dropped once")
              : t("The stream dropped {value0} times", { value0: count })

        return (
          <Alert key={source.id} tone={tone} variant="plain">
            <Alert.Icon>
              <WifiOff />
            </Alert.Icon>
            <Alert.Title>{title}</Alert.Title>
            <Alert.Description>
              {failed
                ? source.lastError || t("The stream could not be captured.")
                : reconnecting
                  ? t("JustAI is trying to reconnect.")
                  : t("Total downtime: {value0}", {
                      value0: seconds.format(source.outageSeconds ?? 0),
                    })}
            </Alert.Description>
            {history.length > 0 || hasMissingTimes ? (
              <Alert.Details label={t("Interruption details")}>
                {[...history].reverse().map(({ startedAt, endedAt }) => (
                  <Alert.Item key={startedAt}>
                    {dateTime.formatRange(
                      new Date(startedAt),
                      new Date(endedAt)
                    )}
                  </Alert.Item>
                ))}
                {hasMissingTimes ? (
                  <Alert.Item>
                    {t(
                      "Some earlier interruptions only have a total duration."
                    )}
                  </Alert.Item>
                ) : null}
              </Alert.Details>
            ) : null}
          </Alert>
        )
      })}
    </div>
  )
}
