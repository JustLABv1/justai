"use client"

import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { useState } from "react"
import { Check, CircleAlert, RefreshCw, SkipForward } from "lucide-react"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Frame } from "@/components/panelui/frame"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { LiveTranscriptionSnapshot } from "./live-transcription-orbit"

type StepKey = "recording" | "diarization" | "grammar"

/**
 * What happens to a live transcript after capture: the recording is saved,
 * speakers are separated, the text is polished. Shown in the workspace's side
 * panel while it runs or when a step needs attention.
 */
export function LiveTranscriptProcessingPanel({
  snapshot,
  onChange,
  onError,
}: {
  snapshot: LiveTranscriptionSnapshot
  onChange: (next: LiveTranscriptionSnapshot) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslations()

  const [busy, setBusy] = useState(false)
  const p = snapshot.liveProcessing
  if (!p || !snapshot.session.startedAt || p.status === "completed") return null
  const act = async (action: "retry" | "skip") => {
    setBusy(true)
    try {
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/processing?action=${action}`
      )
      onChange(
        await api.get<LiveTranscriptionSnapshot>(
          `/api/v1/transcription/sessions/${snapshot.session.id}`
        )
      )
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : t("Processing could not be updated.")
      )
    } finally {
      setBusy(false)
    }
  }

  const failed = p.status === "failed"
  const polished = snapshot.segments.filter((s) => s.polishedText).length
  const steps: {
    key: StepKey
    label: string
    status: string
    detail: string
  }[] = [
    {
      key: "recording",
      label: t("Capture"),
      status: p.stage === "recording" ? "processing" : "completed",
      detail: t("Waiting for the audio recording to finish saving."),
    },
    {
      key: "diarization",
      label: t("Speakers"),
      status: p.diarizationStatus,
      detail: t("Telling the voices in the recording apart"),
    },
    {
      key: "grammar",
      label: t("Polish"),
      status: p.polishStatus,
      detail: t("{value0} of {value1} text blocks ready", {
        value0: polished,
        value1: snapshot.segments.length,
      }),
    },
  ]
  const active = steps.find((step) => step.key === p.stage)
  const stateLabel = (status: string, isActive: boolean) =>
    status === "completed"
      ? t("Completed")
      : status === "skipped"
        ? t("Skipped")
        : status === "failed"
          ? t("Needs attention")
          : isActive && p.status === "processing"
            ? t("In progress")
            : isActive
              ? t("Queued")
              : t("Pending")

  return (
    <section
      aria-label={t("Transcript post-processing")}
      className="flex shrink-0 flex-col gap-4"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {t("Transcript post-processing")}
          </h2>
          <Badge dot size="sm" variant={failed ? "destructive" : "info"}>
            {failed ? t("Processing paused") : t("In progress")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {failed
            ? t("The transcript is saved. Retry the step or skip it to finish.")
            : t(
                "The transcript is ready to read and edit while this runs in the background."
              )}
        </p>
      </div>

      <Frame>
        <Frame.Panel aria-label={t("Transcript post-processing")} role="list">
          {steps.map((step, index) => {
            const isActive = step.key === active?.key
            const complete = step.status === "completed"
            const error = step.status === "failed"
            const running = isActive && p.status === "processing" && !error
            return (
              <Frame.Row
                aria-current={isActive ? "step" : undefined}
                key={step.key}
                role="listitem"
              >
                <Frame.Media
                  className={cn(
                    complete && "text-success",
                    running && "text-primary",
                    error && "text-destructive"
                  )}
                >
                  {error ? (
                    <CircleAlert aria-hidden="true" />
                  ) : complete ? (
                    <Check aria-hidden="true" />
                  ) : step.status === "skipped" ? (
                    <SkipForward aria-hidden="true" />
                  ) : running ? (
                    <Spinner aria-hidden="true" className="size-4" />
                  ) : (
                    <span className="text-xs font-semibold tabular-nums">
                      {index + 1}
                    </span>
                  )}
                </Frame.Media>
                <Frame.Content>
                  <Frame.Title
                    as="p"
                    className={cn(
                      "overflow-visible! text-clip! whitespace-normal!",
                      !isActive && !complete && "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </Frame.Title>
                  <Frame.Description
                    aria-live={isActive ? "polite" : undefined}
                    className="overflow-visible! text-clip! whitespace-normal!"
                  >
                    {stateLabel(step.status, isActive)}
                    {running ? ` · ${step.detail}` : ""}
                  </Frame.Description>
                </Frame.Content>
              </Frame.Row>
            )
          })}
        </Frame.Panel>
      </Frame>

      {failed ? (
        <Alert tone="destructive">
          <Alert.Title>
            {active?.key === "diarization"
              ? t("Speaker separation did not finish")
              : t("This step did not finish")}
          </Alert.Title>
          {p.error ? <Alert.Description>{p.error}</Alert.Description> : null}
          <Alert.Actions>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act("retry")}
            >
              <RefreshCw data-icon="inline-start" />
              {t("Retry step")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void act("skip")}
            >
              <SkipForward data-icon="inline-start" />
              {t("Skip")}
            </Button>
          </Alert.Actions>
        </Alert>
      ) : null}
    </section>
  )
}
