"use client"

import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Switch } from "@/components/panelui/switch"
import { api } from "@/lib/api"
import { notifyError } from "@/lib/feedback"

type NotifyOn = { approval: boolean; failed: boolean; completed: boolean }

const options: Array<{ key: keyof NotifyOn; label: string; hint: string }> = [
  {
    key: "approval",
    label: "Waiting for my approval",
    hint: "So an action does not expire unnoticed.",
  },
  { key: "failed", label: "Run failed", hint: "With the error message." },
  {
    key: "completed",
    label: "Run completed",
    hint: "With a short summary of the result.",
  },
]

/**
 * When runs of a workflow notify its owner. Agents can also send one themselves with
 * the notify_user tool, for example "only if something new comes up".
 */
export function WorkflowNotifications({
  workflowId,
  disabled = false,
}: {
  workflowId: string
  disabled?: boolean
}) {
  const { t } = useTranslations()
  const [notifyOn, setNotifyOn] = useState<NotifyOn | null>(null)
  const [saving, setSaving] = useState<keyof NotifyOn | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .get<NotifyOn>(`/api/v1/agent-workflows/${workflowId}/notifications`)
      .then((result) => {
        if (!cancelled) setNotifyOn(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workflowId])

  if (!notifyOn) return null

  const change = async (key: keyof NotifyOn, value: boolean) => {
    const next = { ...notifyOn, [key]: value }
    setNotifyOn(next)
    setSaving(key)
    try {
      setNotifyOn(
        await api.put<NotifyOn>(
          `/api/v1/agent-workflows/${workflowId}/notifications`,
          next
        )
      )
    } catch (caught) {
      setNotifyOn(notifyOn)
      notifyError(
        t("The notification setting could not be saved."),
        caught,
        t("Try again.")
      )
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="mt-3 flex flex-col gap-3 rounded-xl bg-muted/50 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Notifications")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Tell me about runs of this workflow. Agents can also notify you themselves when their instructions ask for it, for example “tell me only if a new bill on digital policy appears”."
          )}
        </p>
      </div>
      {options.map((option) => (
        <div
          className="flex items-start justify-between gap-3"
          key={option.key}
        >
          <div className="min-w-0">
            <label
              className="text-sm"
              htmlFor={`workflow-notify-${option.key}`}
            >
              {t(option.label)}
            </label>
            <p className="text-xs text-muted-foreground">{t(option.hint)}</p>
          </div>
          <Switch
            checked={notifyOn[option.key]}
            disabled={disabled || saving !== null}
            id={`workflow-notify-${option.key}`}
            onCheckedChange={(checked) => void change(option.key, checked)}
            pending={saving === option.key}
            size="sm"
          />
        </div>
      ))}
    </section>
  )
}
