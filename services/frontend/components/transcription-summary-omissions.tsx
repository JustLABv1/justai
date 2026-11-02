"use client"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/ui/button"
import { type SummaryOmission } from "@/lib/transcription-summary-standard"

export function SummaryOmissionReview({
  omissions,
  restoredIds,
  onRestore,
  disabled,
}: {
  omissions: SummaryOmission[]
  restoredIds: string[]
  onRestore: (ids: string[]) => void
  disabled: boolean
}) {
  const { t } = useTranslations()
  if (!omissions.length) return null
  return (
    <details className="rounded-lg bg-muted p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("{value0} contributions left out · Review", {
          value0: omissions.length,
        })}
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {t(
            "These passages matched the template rules. Restore a passage to include it when creating the summary again."
          )}
        </p>
        {omissions.map((omission, index) => (
          <div
            key={omission.segmentIds.join("-")}
            className="flex flex-col gap-2 rounded-lg bg-background p-3"
          >
            <p className="text-xs text-muted-foreground">
              {omission.speaker ? `${omission.speaker} · ` : ""}
              {Math.floor(omission.startOffsetMs / 60000)}:
              {String(Math.floor(omission.startOffsetMs / 1000) % 60).padStart(
                2,
                "0"
              )}
            </p>
            <p className="text-sm leading-6">{omission.text}</p>
            <p className="text-xs text-muted-foreground">{omission.reason}</p>
            <Button
              className="self-start"
              size="sm"
              variant="secondary"
              disabled={
                disabled ||
                omission.segmentIds.every((id) => restoredIds.includes(id))
              }
              onClick={() => onRestore(omission.segmentIds)}
              aria-label={t("Restore contribution {value0}", {
                value0: index + 1,
              })}
            >
              {t(
                omission.segmentIds.every((id) => restoredIds.includes(id))
                  ? "Will be included next time"
                  : "Include in summary"
              )}
            </Button>
          </div>
        ))}
      </div>
    </details>
  )
}
