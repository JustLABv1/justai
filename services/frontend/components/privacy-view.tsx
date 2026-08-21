"use client"

import { useEffect, useState } from "react"
import { Download, LockKeyhole, Play, Save } from "lucide-react"

import { api } from "@/lib/api"
import type { PrivacySettings } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export function PrivacyView() {
  const [settings, setSettings] = useState<PrivacySettings>({
    archivedConversationRetentionDays: 0,
    knowledgeRetentionDays: 0,
    transcriptionRetentionDays: 0,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ settings: PrivacySettings }>("/api/v1/privacy/settings")
      .then((response) => {
        if (!cancelled) setSettings(response.settings)
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
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
  }, [])

  function update(key: keyof PrivacySettings, value: string) {
    const parsed = Number.parseInt(value, 10)
    setSettings((current) => ({
      ...current,
      [key]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
    }))
  }

  async function save() {
    setSaving(true)
    setError("")
    setNotice("")
    try {
      const response = await api.put<{ settings: PrivacySettings }>(
        "/api/v1/privacy/settings",
        settings
      )
      setSettings(response.settings)
      setNotice(
        "Privacy settings saved. The retention worker will apply them automatically."
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Privacy settings could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }

  async function exportData() {
    setError("")
    setNotice("")
    try {
      const blob = await api.getBlob("/api/v1/privacy/export")
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = "justai-data-export.json"
      link.click()
      URL.revokeObjectURL(url)
      setNotice("Your data export is ready.")
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The data export failed."
      )
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
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Cleanup could not be completed."
      )
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-5 text-primary" />
            Retention controls
          </CardTitle>
          <CardDescription>
            Choose how long your workspace data remains. A value of 0 means
            JustAI never removes it automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert className="mb-4" variant="destructive">
              <AlertTitle>Privacy action failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert className="mb-4">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="archived-retention">
                Archived conversations
              </FieldLabel>
              <Input
                disabled={loading || saving}
                id="archived-retention"
                min={0}
                max={3650}
                onChange={(event) =>
                  update(
                    "archivedConversationRetentionDays",
                    event.target.value
                  )
                }
                type="number"
                value={settings.archivedConversationRetentionDays}
              />
              <FieldDescription>
                Delete archived chats after this many days.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-retention">
                Personal knowledge
              </FieldLabel>
              <Input
                disabled={loading || saving}
                id="knowledge-retention"
                min={0}
                max={3650}
                onChange={(event) =>
                  update("knowledgeRetentionDays", event.target.value)
                }
                type="number"
                value={settings.knowledgeRetentionDays}
              />
              <FieldDescription>
                Remove your uploaded and imported knowledge sources.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="transcription-retention">
                Completed transcripts
              </FieldLabel>
              <Input
                disabled={loading || saving}
                id="transcription-retention"
                min={0}
                max={3650}
                onChange={(event) =>
                  update("transcriptionRetentionDays", event.target.value)
                }
                type="number"
                value={settings.transcriptionRetentionDays}
              />
              <FieldDescription>
                Remove completed or failed transcript sessions and recordings.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button disabled={loading || saving} onClick={() => void save()}>
              <Save data-icon="inline-start" />
              {saving ? "Saving…" : "Save retention settings"}
            </Button>
            <Button
              disabled={cleaning}
              onClick={() => void runCleanup()}
              variant="outline"
            >
              <Play data-icon="inline-start" />
              {cleaning ? "Running…" : "Run cleanup now"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export your data</CardTitle>
          <CardDescription>
            Download conversations, messages, notes, memories, projects, and
            personal source metadata as JSON.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void exportData()} variant="outline">
            <Download data-icon="inline-start" />
            Download data export
          </Button>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Exports are generated on demand and are not stored by JustAI after
            the response completes.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
