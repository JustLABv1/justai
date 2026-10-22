"use client"

import { useEffect, useState } from "react"
import { Download, Play, Save } from "lucide-react"

import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { PrivacySettings } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingsRow, SettingsSection } from "@/components/ui/settings"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"

export function PrivacyView() {
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

  function update(key: keyof PrivacySettings, value: string) {
    const parsed = Number.parseInt(value, 10)
    setSettings((current) => ({
      ...current,
      [key]: Number.isFinite(parsed) ? Math.min(3650, Math.max(0, parsed)) : 0,
    }))
  }

  async function save(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
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
        `Cleanup complete: ${conversations} archived chats, ${knowledge} knowledge sources, and ${transcripts} transcripts removed.`
      )
      notifySuccess("Retention cleanup complete")
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

  return (
    <div className="flex flex-col gap-4">
      {(loadError || error) && (
        <Alert
          aria-live="polite"
          className="flex flex-wrap items-start justify-between gap-3"
          role="alert"
          variant="destructive"
        >
          <div>
            <AlertTitle>
              {loadError
                ? "Privacy settings unavailable"
                : "Privacy action failed"}
            </AlertTitle>
            <AlertDescription>{loadError || error}</AlertDescription>
          </div>
          {loadError && (
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
              Retry
            </Button>
          )}
        </Alert>
      )}
      {notice && (
        <Alert aria-live="polite" role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <form onSubmit={(event) => void save(event)}>
        <SettingsSection
          aria-busy={loading || saving}
          description="Choose how long your personal data in this workspace remains. A value of 0 means JustAI never removes it automatically."
          footer={
            <>
              {settingsDirty && (
                <p className="mr-auto text-xs text-muted-foreground">
                  Save before running cleanup. It uses the last saved values.
                </p>
              )}
              <Button
                disabled={loading || saving || cleaning || settingsDirty}
                onClick={() => setCleanupOpen(true)}
                type="button"
                variant="outline"
              >
                <Play data-icon="inline-start" />
                {cleaning ? "Running…" : "Run cleanup now"}
              </Button>
              <Button disabled={loading || saving} type="submit">
                <Save data-icon="inline-start" />
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
          title="Retention"
        >
          <SettingsRow
            description="Delete archived chats after this many days."
            htmlFor="archived-retention"
            label="Archived conversations"
          >
            <Input
              className="sm:max-w-32"
              disabled={loading || saving}
              id="archived-retention"
              max={3650}
              min={0}
              onChange={(event) => update("archivedConversationRetentionDays", event.target.value)}
              type="number"
              value={settings.archivedConversationRetentionDays}
            />
          </SettingsRow>
          <SettingsRow
            description="Remove your uploaded and imported knowledge sources."
            htmlFor="knowledge-retention"
            label="Personal knowledge"
          >
            <Input
              className="sm:max-w-32"
              disabled={loading || saving}
              id="knowledge-retention"
              max={3650}
              min={0}
              onChange={(event) => update("knowledgeRetentionDays", event.target.value)}
              type="number"
              value={settings.knowledgeRetentionDays}
            />
          </SettingsRow>
          <SettingsRow
            description="Remove completed or failed transcript sessions and recordings."
            htmlFor="transcription-retention"
            label="Completed transcripts"
          >
            <Input
              className="sm:max-w-32"
              disabled={loading || saving}
              id="transcription-retention"
              max={3650}
              min={0}
              onChange={(event) => update("transcriptionRetentionDays", event.target.value)}
              type="number"
              value={settings.transcriptionRetentionDays}
            />
          </SettingsRow>
        </SettingsSection>
      </form>

      <SettingsSection
        description="Download conversations, messages, notes, memories, projects, and personal source metadata as JSON. Binary files, recordings, and message attachments are not included."
        title="Export your data"
      >
        <SettingsRow
          description="Exports are generated on demand and are not stored by JustAI after the response completes."
          label="Data export"
        >
          <Button
            disabled={exporting}
            onClick={() => void exportData()}
            variant="outline"
          >
            <Download data-icon="inline-start" />
            {exporting ? "Preparing export…" : "Download data export"}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <ConfirmActionDialog
        open={cleanupOpen}
        title="Run retention cleanup now?"
        description="Data older than your retention limits will be permanently removed. Review the values above before continuing."
        confirmLabel="Run cleanup"
        pending={cleaning}
        onOpenChange={setCleanupOpen}
        onConfirm={runCleanup}
      />
    </div>
  )
}
