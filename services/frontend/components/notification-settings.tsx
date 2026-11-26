"use client"

import { Send } from "lucide-react"
import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Frame } from "@/components/panelui/frame"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { api } from "@/lib/api"
import {
  disablePush,
  enablePush,
  pushState,
  type PushState,
} from "@/lib/push-notifications"

export type NotificationSettingsData = {
  emailEnabled: boolean
  emailAvailable: boolean
  vapidPublicKey?: string
}

/**
 * How a user hears about finished topics and live transcripts besides the bell: browser
 * push on this device and e-mail, plus a test. Lives in the profile.
 */
export function NotificationSettingsPanel() {
  const { t } = useTranslations()
  const [settings, setSettings] = useState<NotificationSettingsData | null>(
    null
  )
  const [push, setPush] = useState<PushState>("unsupported")
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")

  useEffect(() => {
    let cancelled = false
    void pushState().then((state) => {
      if (!cancelled) setPush(state)
    })
    void api
      .get<NotificationSettingsData>("/api/v1/notifications/settings")
      .then((result) => {
        if (!cancelled) setSettings(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const togglePush = async (on: boolean) => {
    setBusy("push")
    setMessage("")
    try {
      if (on && settings?.vapidPublicKey) {
        setPush(await enablePush(settings.vapidPublicKey))
      } else {
        setPush(await disablePush())
      }
    } catch (caught) {
      setMessage(
        caught instanceof Error
          ? caught.message
          : t("Browser notifications could not be turned on.")
      )
    } finally {
      setBusy("")
    }
  }

  const toggleEmail = async (on: boolean) => {
    setBusy("email")
    setMessage("")
    try {
      setSettings(
        await api.put<NotificationSettingsData>(
          "/api/v1/notifications/settings",
          { emailEnabled: on }
        )
      )
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy("")
    }
  }

  const sendTest = async () => {
    setBusy("test")
    setMessage("")
    try {
      const result = await api.post<{
        pushed: number
        emailed: boolean
        emailError: string
      }>("/api/v1/notifications/test")
      const parts = []
      if (result.pushed > 0)
        parts.push(t("Sent to {value0} browser(s).", { value0: result.pushed }))
      if (result.emailed) parts.push(t("E-mail sent."))
      if (result.emailError)
        parts.push(t("E-mail failed: {value0}", { value0: result.emailError }))
      setMessage(
        parts.length > 0
          ? parts.join(" ")
          : t("Turn on browser or e-mail notifications first.")
      )
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Frame>
        <Frame.Panel>
          <Frame.Row className="flex-wrap gap-3">
            <Frame.Content>
              <Frame.Title as="p">{t("Browser notifications")}</Frame.Title>
              <Frame.Description>
                {push === "unsupported"
                  ? t(
                      "This browser cannot show push notifications. On an iPhone, add JustAI to the home screen first."
                    )
                  : push === "denied"
                    ? t(
                        "Blocked in this browser. Allow notifications for this site in the browser settings."
                      )
                    : t("Shown even when JustAI is closed, on this device.")}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Switch
                checked={push === "on"}
                disabled={
                  push === "unsupported" ||
                  push === "denied" ||
                  !settings?.vapidPublicKey ||
                  busy === "push"
                }
                label={t("Browser notifications")}
                onCheckedChange={(checked) => void togglePush(checked)}
                pending={busy === "push"}
              />
            </Frame.Actions>
          </Frame.Row>
          <Frame.Row className="flex-wrap gap-3">
            <Frame.Content>
              <Frame.Title as="p">{t("Email")}</Frame.Title>
              <Frame.Description>
                {settings && !settings.emailAvailable
                  ? t("This server does not send e-mail yet.")
                  : t("Sent to the address of your account.")}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Switch
                checked={Boolean(
                  settings?.emailAvailable && settings.emailEnabled
                )}
                disabled={!settings?.emailAvailable || busy === "email"}
                label={t("Email")}
                onCheckedChange={(checked) => void toggleEmail(checked)}
                pending={busy === "email"}
              />
            </Frame.Actions>
          </Frame.Row>
          <Frame.Row className="flex-wrap gap-3">
            <Frame.Content>
              <Frame.Title as="p">{t("Test notification")}</Frame.Title>
              <Frame.Description>
                {t(
                  "Sends a message through every channel that is turned on, to check that it arrives."
                )}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Button
                disabled={busy === "test"}
                onClick={() => void sendTest()}
                size="sm"
                variant="outline"
              >
                {busy === "test" ? (
                  <Spinner />
                ) : (
                  <Send data-icon="inline-start" />
                )}
                {t("Send a test")}
              </Button>
            </Frame.Actions>
          </Frame.Row>
        </Frame.Panel>
      </Frame>
      {message ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t(
          "The bell in the sidebar always lists your notifications. You can turn them off for a single live transcript in its topic list."
        )}
      </p>
    </div>
  )
}
