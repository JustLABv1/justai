"use client"

import { useState } from "react"
import { CircleCheck, Undo2 } from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Spinner } from "@/components/panelui/spinner"
import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import type { TranscriptionSession } from "@/lib/types"

/**
 * Toggles the user-level "done" flag of a transcription session. This is
 * independent of the processing status, which only says the pipeline finished.
 */
export function TranscriptionDoneButton({
  session,
  onChange,
  className,
}: {
  session: Pick<TranscriptionSession, "id" | "doneAt">
  onChange: (doneAt: string | null) => void
  className?: string
}) {
  const { t } = useTranslations()
  const [saving, setSaving] = useState(false)
  const done = Boolean(session.doneAt)

  const toggle = async () => {
    setSaving(true)
    try {
      const result = await api.patch<{ session: TranscriptionSession }>(
        `/api/v1/transcription/sessions/${session.id}`,
        { done: !done }
      )
      onChange(result.session.doneAt ?? null)
    } catch (caught) {
      toast.add({
        type: "destructive",
        priority: "high",
        title: t(
          caught instanceof Error
            ? caught.message
            : "The status could not be saved."
        ),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Button
      className={className}
      disabled={saving}
      onClick={() => void toggle()}
      size="sm"
      variant={done ? "outline" : "default"}
    >
      {saving ? (
        <Spinner data-icon="inline-start" />
      ) : done ? (
        <Undo2 data-icon="inline-start" />
      ) : (
        <CircleCheck data-icon="inline-start" />
      )}
      <span>{done ? t("Reopen") : t("Mark as done")}</span>
    </Button>
  )
}
