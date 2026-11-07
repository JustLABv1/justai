"use client"

import { useTranslations } from "@/components/locale-provider"
import { useEffect, useState } from "react"
import { Download } from "lucide-react"

import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { PrivacySettings } from "@/lib/types"
import { Alert } from "@/components/panelui/alert"
import { Frame } from "@/components/panelui/frame"
import { Field } from "@/components/panelui/field"
import { Spinner } from "@/components/panelui/spinner"
import { Button } from "@/components/panelui/button"
import { Input } from "@/components/panelui/input"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"

export function PrivacyView() {
  const { t } = useTranslations()

  const defaultSettings: PrivacySettings = {
    archivedConversationRetentionDays: 0,
    knowledgeRetentionDays: 0,
    transcriptionRetentionDays: 0,
  }
  const [settings, setSettings] = useState<PrivacySettings>(defaultSettings)
  const [savedSettings, setSavedSettings] =
    useState<PrivacySettings>(defaultSettings)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadError, setLoadError] = useState("")
  const [saving, setSaving] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [cleanupOpen, setCleanupOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ settings: PrivacySettings }>("/api/v1/privacy/settings")
      .then((response) => {
        if (!cancelled) {
          setSettings(response.settings)
          setSavedSettings(response.settings)
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setLoadError(
            caught instanceof Error
              ? caught.message
              : "Privacy settings could not be loaded."
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadAttempt])

  function update(
    key: Exclude<keyof PrivacySettings, "updatedAt">,
    value: string
  ) {
    const parsed = Number.parseInt(value, 10)
    setSettings((current) => ({
      ...current,
      [key]: Number.isFinite(parsed) ? Math.min(3650, Math.max(0, parsed)) : 0,
    }))
  }

  async function save(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (loading || loadError || saving || cleaning) return
    setSaving(true)
    setError("")
    setNotice("")
    try {
      const response = await api.put<{ settings: PrivacySettings }>(
        "/api/v1/privacy/settings",
        settings
      )
      setSettings(response.settings)
      setSavedSettings(response.settings)
      setNotice(
        "Privacy settings saved. The retention worker will apply them automatically."
      )
      notifySuccess("Privacy settings saved")
      setCleanupOpen(false)
    } catch (caught) {
      setError(
        notifyError(
          "Privacy settings could not be saved",
          caught,
          "Privacy settings could not be saved."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function exportData() {
    if (exporting) return
    setExporting(true)
    setError("")
    setNotice("")
    try {
      const blob = await api.getBlob("/api/v1/privacy/export")
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = "justai-data-export.json"
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      setNotice("Your data export is ready.")
      notifySuccess("Data export ready")
    } catch (caught) {
      setError(
        notifyError("Data export failed", caught, "The data export failed.")
      )
    } finally {
      setExporting(false)
    }
  }

  async function runCleanup() {
    if (loading || loadError || saving || cleaning || settingsDirty) return
    setCleaning(true)
    setError("")
    setNotice("")
    try {
      const response = await api.post<{
        deleted: {
          conversations: number
          knowledge: number
          transcripts: number
        }
      }>("/api/v1/privacy/cleanup")
      const { conversations, knowledge, transcripts } = response.deleted
      setNotice(
        t(
          "Cleanup complete: {conversations} archived chats, {knowledge} knowledge sources, and {transcripts} transcripts removed.",
          { conversations, knowledge, transcripts }
        )
      )
      notifySuccess("Retention cleanup complete")
      setCleanupOpen(false)
    } catch (caught) {
      setError(
        notifyError(
          "Cleanup could not be completed",
          caught,
          "Cleanup could not be completed."
        )
      )
    } finally {
      setCleaning(false)
    }
  }

  const settingsDirty =
    settings.archivedConversationRetentionDays !==
      savedSettings.archivedConversationRetentionDays ||
    settings.knowledgeRetentionDays !== savedSettings.knowledgeRetentionDays ||
    settings.transcriptionRetentionDays !==
      savedSettings.transcriptionRetentionDays

  const unavailable = loading || Boolean(loadError)
  const retentionFields: Array<{
    key: Exclude<keyof PrivacySettings, "updatedAt">
    id: string
    label: string
    description: string
  }> = [
    {
      key: "archivedConversationRetentionDays",
      id: "archived-retention",
      label: "Archived conversations",
      description: "Delete archived chats after this many days.",
    },
    {
      key: "knowledgeRetentionDays",
      id: "knowledge-retention",
      label: "Personal knowledge",
      description: "Remove your uploaded and imported knowledge sources.",
    },
    {
      key: "transcriptionRetentionDays",
      id: "transcription-retention",
      label: "Completed transcripts",
      description:
        "Remove completed or failed transcript sessions and recordings.",
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      {(loadError || error) && (
        <Alert tone="destructive" variant="plain">
          <Alert.Title>
            {t(
              loadError
                ? "Privacy settings unavailable"
                : "Privacy action failed"
            )}
          </Alert.Title>
          <Alert.Description>{t(loadError || error)}</Alert.Description>
          {loadError && (
            <Alert.Actions>
              <Button
                onClick={() => {
                  setLoadError("")
                  setLoading(true)
                  setLoadAttempt((attempt) => attempt + 1)
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Retry")}
              </Button>
            </Alert.Actions>
          )}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" variant="plain">
          <Alert.Description>{t(notice)}</Alert.Description>
        </Alert>
      )}
      <form onSubmit={(event) => void save(event)}>
        <Frame aria-busy={loading || saving}>
          <Frame.Header>
            <Frame.Title>{t("Retention")}</Frame.Title>
            <Frame.Description>
              {t(
                "Choose how long your personal data in this workspace remains. A value of 0 means JustAI never removes it automatically."
              )}
            </Frame.Description>
            {loading && (
              <Frame.Action>
                <span
                  role="status"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Spinner className="size-4" />
                  {t("Loading…")}
                </span>
              </Frame.Action>
            )}
          </Frame.Header>
          <Frame.Panel>
            {retentionFields.map((item) => (
              <Field
                key={item.key}
                disabled={unavailable || saving || cleaning}
              >
                <Frame.Row className="flex-wrap gap-y-3">
                  <Frame.Content className="min-w-48">
                    <Field.Label>{t(item.label)}</Field.Label>
                    <Field.Description>{t(item.description)}</Field.Description>
                  </Frame.Content>
                  <Frame.Actions className="w-full sm:w-40">
                    <Input.Group>
                      <Input
                        id={item.id}
                        type="number"
                        min={0}
                        max={3650}
                        step={1}
                        value={settings[item.key]}
                        disabled={unavailable || saving || cleaning}
                        onChange={(event) =>
                          update(item.key, event.target.value)
                        }
                      />
                      <Input.Addon align="end">{t("days")}</Input.Addon>
                    </Input.Group>
                  </Frame.Actions>
                </Frame.Row>
              </Field>
            ))}
          </Frame.Panel>
          <Frame.Footer className="flex flex-wrap items-center justify-between gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {settingsDirty
                ? t("You have unsaved changes.")
                : unavailable
                  ? ""
                  : t("Saved retention settings are applied automatically.")}
            </span>
            <Button
              disabled={unavailable || saving || cleaning || !settingsDirty}
              type="submit"
              size="sm"
            >
              {saving && <Spinner className="size-4" />}
              {t(saving ? "Saving…" : "Save changes")}
            </Button>
          </Frame.Footer>
        </Frame>
      </form>
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Export your data")}</Frame.Title>
          <Frame.Description>
            {t("Download a copy of your personal data as JSON.")}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel>
          <Frame.Row className="flex-wrap gap-y-3">
            <Frame.Content className="min-w-48">
              <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                {t(
                  "Download conversations, messages, notes, memories, projects, and personal source metadata as JSON. Binary files, recordings, and message attachments are not included."
                )}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Button
                disabled={exporting}
                onClick={() => void exportData()}
                variant="outline"
                size="sm"
                type="button"
              >
                {exporting ? (
                  <Spinner className="size-4" />
                ) : (
                  <Download className="size-4" />
                )}
                {t(exporting ? "Preparing export…" : "Download data export")}
              </Button>
            </Frame.Actions>
          </Frame.Row>
        </Frame.Panel>
      </Frame>
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Clean up old data")}</Frame.Title>
          <Frame.Description>
            {t("Apply your saved retention settings now.")}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel>
          <Frame.Row className="flex-wrap gap-y-3">
            <Frame.Content className="min-w-48">
              <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                {t(
                  settingsDirty
                    ? "Save before running cleanup. It uses the last saved values."
                    : "Data older than your saved retention limits will be permanently removed. Data with a retention of 0 is kept."
                )}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Button
                disabled={unavailable || saving || cleaning || settingsDirty}
                onClick={() => setCleanupOpen(true)}
                type="button"
                variant="outline"
                size="sm"
              >
                {cleaning && <Spinner className="size-4" />}
                {t(cleaning ? "Running…" : "Run cleanup")}
              </Button>
            </Frame.Actions>
          </Frame.Row>
        </Frame.Panel>
      </Frame>
      <ConfirmActionDialog
        open={cleanupOpen}
        title={t("Run retention cleanup now?")}
        description={t(
          "Data older than your retention limits will be permanently removed. Review the values above before continuing."
        )}
        confirmLabel={t("Run cleanup")}
        pending={cleaning}
        onOpenChange={setCleanupOpen}
        onConfirm={runCleanup}
      />
    </div>
  )
}
