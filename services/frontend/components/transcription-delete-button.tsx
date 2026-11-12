"use client"

import { useRef, useState } from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/panelui/button"
import { Dialog } from "@/components/panelui/dialog"
import { useTranslations } from "@/components/locale-provider"
import { api } from "@/lib/api"

export function TranscriptionDeleteButton({
  ids,
  onDeleted,
  disabled = false,
  iconOnly = false,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  ids: string[]
  onDeleted: () => void
  disabled?: boolean
  iconOnly?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}) {
  const { t } = useTranslations()
  const deleted = useRef(new Set<string>())
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (value: boolean) => {
    setInternalOpen(value)
    onOpenChange?.(value)
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return (
    <>
      {!hideTrigger ? (
        <Button
          size={iconOnly ? "icon-sm" : "sm"}
          aria-label={t("Delete")}
          title={t("Delete")}
          className="text-destructive hover:not-disabled:text-destructive"
          variant="ghost"
          disabled={disabled || !ids.length}
          onClick={() => setOpen(true)}
        >
          <Trash2 data-icon="inline-start" />
          {iconOnly ? null : t("Delete")}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <Dialog.Content>
          <Dialog.Header
            title={t("Delete transcription?")}
            description={t(
              "The selected transcriptions and their recordings will be permanently deleted."
            )}
          />
          {error ? (
            <Dialog.Body>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </Dialog.Body>
          ) : null}
          <Dialog.Footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                setError("")
                try {
                  // Remember successful deletions so a partial failure can be retried.
                  for (const id of ids) {
                    if (deleted.current.has(id)) continue
                    await api.delete(`/api/v1/transcription/sessions/${id}`)
                    deleted.current.add(id)
                  }
                  setOpen(false)
                  onDeleted()
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : t("The transcription could not be deleted.")
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t("Delete")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  )
}
