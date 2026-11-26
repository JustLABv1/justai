"use client"

import { Send } from "lucide-react"
import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
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
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"

type EmailSettings = {
  enabled: boolean
  host: string
  port: number
  username: string
  passwordSet: boolean
  from: string
  security: "starttls" | "tls" | "none"
  publicUrl: string
  smtpFromConfig: boolean
  publicUrlFromConfig: boolean
  defaultPublicUrl: string
  lastTestedAt?: string
  lastError?: string
}

const securityLabels: Record<EmailSettings["security"], string> = {
  starttls: "STARTTLS (port 587)",
  tls: "TLS (port 465)",
  none: "None",
}

/**
 * Outgoing e-mail (SMTP) and the public address used in links, for notifications.
 * Values pinned in the server configuration are shown read-only.
 */
export function PlatformEmailView() {
  const { t, locale } = useTranslations()
  const [settings, setSettings] = useState<EmailSettings | null>(null)
  const [password, setPassword] = useState("")
  const [clearPassword, setClearPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .get<EmailSettings>("/api/v1/admin/email")
      .then((result) => {
        if (!cancelled) setSettings(result)
      })
      .catch((caught) =>
        notifyError(
          t("E-mail settings could not be loaded."),
          caught,
          t("Try again.")
        )
      )
    return () => {
      cancelled = true
    }
  }, [t])

  if (!settings) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("Loading…")}
      </p>
    )
  }

  const pinned = settings.smtpFromConfig
  const update = (change: Partial<EmailSettings>) =>
    setSettings({ ...settings, ...change })

  const save = async () => {
    setSaving(true)
    try {
      const result = await api.put<EmailSettings>("/api/v1/admin/email", {
        enabled: settings.enabled,
        host: settings.host,
        port: Number(settings.port) || 587,
        username: settings.username,
        password: password || undefined,
        clearPassword,
        from: settings.from,
        security: settings.security,
        publicUrl: settings.publicUrl,
      })
      setSettings(result)
      setPassword("")
      setClearPassword(false)
      notifySuccess(t("E-mail settings saved."))
    } catch (caught) {
      notifyError(
        t("E-mail settings could not be saved."),
        caught,
        t("Check the values and try again.")
      )
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    try {
      const result = await api.post<{ sentTo: string }>(
        "/api/v1/admin/email/test"
      )
      notifySuccess(
        t("Test e-mail sent to {value0}.", { value0: result.sentTo })
      )
      update({ lastTestedAt: new Date().toISOString(), lastError: "" })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      update({ lastTestedAt: new Date().toISOString(), lastError: message })
      notifyError(t("The test e-mail failed."), caught, message)
    } finally {
      setTesting(false)
    }
  }

  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  })

  return (
    <div className="flex flex-col gap-5">
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Outgoing e-mail")}</Frame.Title>
          <Frame.Description>
            {t(
              "JustAI sends notifications by e-mail through this SMTP server, for example when a shared live transcript or one of its topics is finished."
            )}
          </Frame.Description>
        </Frame.Header>
        {pinned ? (
          <Frame.Panel className="p-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Set by the server configuration (config.yaml or JUSTAI_SMTP_* variables). Change it there; it takes precedence over this page."
              )}
            </p>
          </Frame.Panel>
        ) : null}
        <Frame.Panel>
          <Frame.Row className="gap-5 py-4">
            <Frame.Content>
              <Frame.Title as="p">
                <label className="cursor-pointer" htmlFor="platform-email-on">
                  {t("Send e-mail")}
                </label>
              </Frame.Title>
              <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                {t(
                  "When off, notifications appear in the app and by browser push only."
                )}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Switch
                checked={settings.enabled}
                disabled={pinned || saving}
                id="platform-email-on"
                onCheckedChange={(checked) => update({ enabled: checked })}
                size="sm"
              />
            </Frame.Actions>
          </Frame.Row>
        </Frame.Panel>
        <Frame.Panel className="grid gap-4 p-4 sm:grid-cols-2">
          <Field disabled={pinned || saving}>
            <Field.Label>{t("SMTP server")}</Field.Label>
            <Input
              autoComplete="off"
              onChange={(event) => update({ host: event.target.value })}
              placeholder="smtp.example.org"
              value={settings.host}
            />
          </Field>
          <div className="grid grid-cols-[6rem_1fr] gap-3">
            <Field disabled={pinned || saving}>
              <Field.Label>{t("Port")}</Field.Label>
              <Input
                inputMode="numeric"
                onChange={(event) =>
                  update({
                    port: Number(event.target.value.replace(/\D/g, "")) || 0,
                  })
                }
                value={settings.port ? String(settings.port) : ""}
              />
            </Field>
            <Field disabled={pinned || saving}>
              <Field.Label>{t("Encryption")}</Field.Label>
              <Select
                disabled={pinned || saving}
                onValueChange={(value) => {
                  const security = value as EmailSettings["security"]
                  update({
                    security,
                    port:
                      security === "tls"
                        ? 465
                        : settings.port === 465
                          ? 587
                          : settings.port,
                  })
                }}
                value={settings.security}
              >
                <SelectTrigger aria-label={t("Encryption")}>
                  <SelectValue>
                    {t(securityLabels[settings.security])}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(["starttls", "tls", "none"] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(securityLabels[value])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field disabled={pinned || saving}>
            <Field.Label>{t("Username")}</Field.Label>
            <Input
              autoComplete="off"
              onChange={(event) => update({ username: event.target.value })}
              value={settings.username}
            />
          </Field>
          <Field disabled={pinned || saving}>
            <Field.Label>{t("Password")}</Field.Label>
            <Input
              autoComplete="new-password"
              onChange={(event) => {
                setPassword(event.target.value)
                setClearPassword(false)
              }}
              placeholder={
                settings.passwordSet && !clearPassword
                  ? t("Leave blank to preserve")
                  : ""
              }
              type="password"
              value={password}
            />
            {settings.passwordSet && !pinned ? (
              <Field.Description>
                <button
                  className="underline-offset-4 hover:underline"
                  onClick={() => {
                    setPassword("")
                    setClearPassword(!clearPassword)
                  }}
                  type="button"
                >
                  {clearPassword
                    ? t("Keep the stored password")
                    : t("Remove the stored password")}
                </button>
              </Field.Description>
            ) : null}
          </Field>
          <Field className="sm:col-span-2" disabled={pinned || saving}>
            <Field.Label>{t("Sender")}</Field.Label>
            <Input
              onChange={(event) => update({ from: event.target.value })}
              placeholder="JustAI <justai@example.org>"
              value={settings.from}
            />
          </Field>
        </Frame.Panel>
        <Frame.Footer className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {settings.lastTestedAt ? (
              settings.lastError ? (
                <>
                  <Badge variant="destructive">{t("Test failed")}</Badge>
                  <span className="break-all">{settings.lastError}</span>
                </>
              ) : (
                <>
                  <Badge variant="success">{t("Test passed")}</Badge>
                  <span>{time.format(new Date(settings.lastTestedAt))}</span>
                </>
              )
            ) : (
              <span>
                {t("The test goes to the e-mail address of your account.")}
              </span>
            )}
          </div>
          <Button
            disabled={testing || saving || (!pinned && !settings.enabled)}
            loading={testing}
            onClick={() => void sendTest()}
            variant="outline"
          >
            <Send data-icon="inline-start" />
            {t("Send test e-mail")}
          </Button>
        </Frame.Footer>
      </Frame>

      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Public address")}</Frame.Title>
          <Frame.Description>
            {t(
              "Links in e-mails and push notifications point here. Use the address people open JustAI with."
            )}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel className="p-4">
          <Field disabled={settings.publicUrlFromConfig || saving}>
            <Field.Label>{t("Address")}</Field.Label>
            <Input
              onChange={(event) => update({ publicUrl: event.target.value })}
              placeholder={
                settings.defaultPublicUrl || "https://justai.example.org"
              }
              type="url"
              value={settings.publicUrl}
            />
            <Field.Description>
              {settings.publicUrlFromConfig
                ? t("Set by the server configuration (JUSTAI_PUBLIC_URL).")
                : t("Empty uses {value0}.", {
                    value0: settings.defaultPublicUrl || "—",
                  })}
            </Field.Description>
          </Field>
        </Frame.Panel>
      </Frame>

      <div className="flex justify-end">
        <Button
          disabled={saving || (pinned && settings.publicUrlFromConfig)}
          loading={saving}
          onClick={() => void save()}
        >
          {t(saving ? "Saving…" : "Save")}
        </Button>
      </div>
    </div>
  )
}
