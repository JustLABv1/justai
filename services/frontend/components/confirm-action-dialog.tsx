"use client"

import { useTranslations } from "@/components/locale-provider"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/panelui/alert-dialog"

type ConfirmActionDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  pending?: boolean
  destructive?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

/** A question that must be answered, drawn with PanelUI's AlertDialog. */
export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  destructive = true,
  onOpenChange,
  onConfirm,
}: ConfirmActionDialogProps) {
  const { t } = useTranslations()

  return (
    <AlertDialog
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen)
      }}
      open={open}
    >
      <AlertDialogContent tone={destructive ? "destructive" : "neutral"}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("Cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            loading={pending}
            onClick={() => onConfirm()}
          >
            {pending ? t("Working…") : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
