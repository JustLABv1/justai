"use client"

import { Check, Copy, Plus, Send, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"

import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import { useTranslations } from "@/components/locale-provider"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Dialog } from "@/components/panelui/dialog"
import { Field } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"

type WebhookFormat = "slack" | "mattermost" | "teams" | "discord" | "json"

type Webhook = {
  id: string
  name: string
  format: WebhookFormat
  urlHint: string
  enabled: boolean
  signed: boolean
  createdAt: string
  lastSuccessAt?: string
  lastError?: string
  lastErrorAt?: string
  failureCount: number
  secret?: string
}

const formatLabels: Record<WebhookFormat, string> = {
  slack: "Slack",
  mattermost: "Mattermost",
  teams: "Microsoft Teams",
  discord: "Discord",
  json: "JSON (signed)",
}

const formatHints: Record<WebhookFormat, string> = {
  slack:
    "In Slack, add the Incoming Webhooks app to a channel and copy its URL (https://hooks.slack.com/…).",
  mattermost:
    "In Mattermost, open Integrations, Incoming Webhooks, add one for a channel and copy its URL (https://your-server/hooks/…).",
  teams:
    "In a Teams channel, open Workflows, choose “Post to a channel when a webhook request is received” and copy the URL.",
  discord:
    "In Discord, open the channel settings, Integrations, Webhooks, create one and copy its URL.",
  json: "JustAI posts JSON to this address. Each request is signed: X-JustAI-Signature is sha256= followed by the HMAC-SHA256 of “timestamp.body” with your secret, and X-JustAI-Timestamp holds the timestamp.",
}

/** Webhooks that receive the user's notifications, in the profile. */
export function NotificationWebhooks() {
  const { t, locale } = useTranslations()
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [max, setMax] = useState(5)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState("")
  const [removing, setRemoving] = useState<Webhook | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ webhooks: Webhook[]; max: number }>(
        "/api/v1/notifications/webhooks"
      )
      .then((result) => {
        if (cancelled) return
        setHooks(result.webhooks)
        setMax(result.max)
      })
      .catch(() => {
        if (!cancelled) setHooks([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const replace = (hook: Webhook) =>
    setHooks((current) =>
      (current ?? []).map((item) => (item.id === hook.id ? hook : item))
    )

  const toggle = async (hook: Webhook, enabled: boolean) => {
    setBusyId(hook.id)
    try {
      replace(
        await api.patch<Webhook>(`/api/v1/notifications/webhooks/${hook.id}`, {
          enabled,
        })
      )
    } catch (caught) {
      notifyError(
        t("The webhook could not be changed."),
        caught,
        t("Try again.")
      )
    } finally {
      setBusyId("")
    }
  }

  const test = async (hook: Webhook) => {
    setBusyId(hook.id)
    try {
      await api.post(`/api/v1/notifications/webhooks/${hook.id}/test`)
      notifySuccess(t("Test sent to “{value0}”.", { value0: hook.name }))
      replace({
        ...hook,
        lastSuccessAt: new Date().toISOString(),
        failureCount: 0,
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      notifyError(t("The test failed."), caught, message)
      replace({
        ...hook,
        lastError: message,
        lastErrorAt: new Date().toISOString(),
      })
    } finally {
      setBusyId("")
    }
  }

  const remove = async (hook: Webhook) => {
    setBusyId(hook.id)
    try {
      await api.delete(`/api/v1/notifications/webhooks/${hook.id}`)
      setHooks((current) =>
        (current ?? []).filter((item) => item.id !== hook.id)
      )
      setRemoving(null)
    } catch (caught) {
      notifyError(
        t("The webhook could not be removed."),
        caught,
        t("Try again.")
      )
    } finally {
      setBusyId("")
    }
  }

  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  })
  const status = (hook: Webhook) => {
    const failedLast =
      hook.lastErrorAt &&
      (!hook.lastSuccessAt ||
        new Date(hook.lastErrorAt) > new Date(hook.lastSuccessAt))
    if (!hook.enabled && hook.failureCount > 0)
      return (
        <span className="text-destructive">
          {t("Turned off after repeated errors: {value0}", {
            value0: hook.lastError ?? "",
          })}
        </span>
      )
    if (failedLast)
      return (
        <span className="text-destructive">
          {t("Last delivery failed: {value0}", {
            value0: hook.lastError ?? "",
          })}
        </span>
      )
    if (hook.lastSuccessAt)
      return t("Last delivered {value0}", {
        value0: time.format(new Date(hook.lastSuccessAt)),
      })
    return t("Not used yet")
  }

  return (
    <Frame>
      <Frame.Header>
        <Frame.Title>{t("Webhooks")}</Frame.Title>
        <Frame.Description>
          {t(
            "Sends your notifications to other tools: Slack, Mattermost, Microsoft Teams, Discord, or as signed JSON to your own systems."
          )}
        </Frame.Description>
        <Frame.Action>
          <Button
            disabled={!hooks || hooks.length >= max}
            onClick={() => setAdding(true)}
            size="sm"
            variant="outline"
          >
            <Plus data-icon="inline-start" />
            {t("Add webhook")}
          </Button>
        </Frame.Action>
      </Frame.Header>
      <Frame.Panel>
        {hooks && hooks.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            {t("No webhooks yet.")}
          </p>
        ) : null}
        {(hooks ?? []).map((hook) => (
          <Frame.Row className="flex-wrap gap-3" key={hook.id}>
            <Frame.Content>
              <Frame.Title as="p" className="flex items-center gap-2">
                {hook.name}
                <Badge variant="secondary">
                  {t(formatLabels[hook.format])}
                </Badge>
              </Frame.Title>
              <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                {hook.urlHint} · {status(hook)}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions className="flex items-center gap-1">
              <Button
                aria-label={t("Send a test to “{value0}”", {
                  value0: hook.name,
                })}
                disabled={busyId === hook.id || !hook.enabled}
                onClick={() => void test(hook)}
                size="icon-sm"
                title={t("Send a test")}
                variant="ghost"
              >
                <Send />
              </Button>
              <Button
                aria-label={t("Remove “{value0}”", { value0: hook.name })}
                disabled={busyId === hook.id}
                onClick={() => setRemoving(hook)}
                size="icon-sm"
                title={t("Remove")}
                variant="ghost"
              >
                <Trash2 />
              </Button>
              <Switch
                checked={hook.enabled}
                disabled={busyId === hook.id}
                label={t("“{value0}” on", { value0: hook.name })}
                onCheckedChange={(checked) => void toggle(hook, checked)}
                size="sm"
              />
            </Frame.Actions>
          </Frame.Row>
        ))}
      </Frame.Panel>
      {adding ? (
        <AddWebhookDialog
          onAdded={(hook) => setHooks((current) => [...(current ?? []), hook])}
          onClose={() => setAdding(false)}
        />
      ) : null}
      <ConfirmActionDialog
        confirmLabel={t("Remove")}
        description={t("Notifications will no longer be sent to this address.")}
        onConfirm={() => {
          if (removing) void remove(removing)
        }}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        open={Boolean(removing)}
        pending={Boolean(removing) && busyId === removing?.id}
        title={t("Remove “{value0}”?", { value0: removing?.name ?? "" })}
      />
    </Frame>
  )
}

function AddWebhookDialog({
  onAdded,
  onClose,
}: {
  onAdded: (hook: Webhook) => void
  onClose: () => void
}) {
  const { t } = useTranslations()
  const [name, setName] = useState("")
  const [format, setFormat] = useState<WebhookFormat>("slack")
  const [url, setUrl] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [secret, setSecret] = useState("")
  const [copied, setCopied] = useState(false)

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const hook = await api.post<Webhook>("/api/v1/notifications/webhooks", {
        name: name.trim() || formatLabels[format],
        format,
        url: url.trim(),
      })
      onAdded({ ...hook, secret: undefined })
      if (hook.secret) setSecret(hook.secret)
      else onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {secret ? t("Copy the signing secret") : t("Add webhook")}
          </Dialog.Title>
          <Dialog.Description>
            {secret
              ? t(
                  "Your system checks each request with this secret. It is shown only now."
                )
              : t("JustAI sends each of your notifications to this address.")}
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Body className="flex flex-col gap-4">
          {secret ? (
            <div className="flex items-center gap-2">
              <Input className="font-mono text-xs" readOnly value={secret} />
              <Button
                aria-label={t("Copy")}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(secret)
                    .then(() => setCopied(true))
                    .catch(() => undefined)
                }}
                size="icon-sm"
                variant="outline"
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : (
            <>
              <Field disabled={saving}>
                <Field.Label>{t("Service")}</Field.Label>
                <Select
                  onValueChange={(value) => setFormat(value as WebhookFormat)}
                  value={format}
                >
                  <SelectTrigger aria-label={t("Service")}>
                    <SelectValue>{t(formatLabels[format])}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(Object.keys(formatLabels) as WebhookFormat[]).map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {t(formatLabels[value])}
                          </SelectItem>
                        )
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Field.Description>{t(formatHints[format])}</Field.Description>
              </Field>
              <Field disabled={saving}>
                <Field.Label>{t("Webhook URL")}</Field.Label>
                <Input
                  autoComplete="off"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://…"
                  type="url"
                  value={url}
                />
              </Field>
              <Field disabled={saving}>
                <Field.Label>{t("Name")}</Field.Label>
                <Input
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t(formatLabels[format])}
                  value={name}
                />
              </Field>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          {secret ? (
            <Button onClick={onClose}>{t("Done")}</Button>
          ) : (
            <>
              <Button disabled={saving} onClick={onClose} variant="outline">
                {t("Cancel")}
              </Button>
              <Button
                disabled={saving || !url.trim()}
                loading={saving}
                onClick={() => void save()}
              >
                {t("Add webhook")}
              </Button>
            </>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
