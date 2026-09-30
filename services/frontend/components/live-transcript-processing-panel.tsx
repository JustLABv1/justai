"use client"

import { useState } from "react"
import {
  Check,
  LoaderCircle,
  CircleAlert,
  SkipForward,
  Users,
  Pencil,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { LiveTranscriptionSnapshot } from "./live-transcription-orbit"
import styles from "./video-processing-progress.module.css"

export function LiveTranscriptProcessingPanel({
  snapshot,
  onChange,
  onError,
}: {
  snapshot: LiveTranscriptionSnapshot
  onChange: (next: LiveTranscriptionSnapshot) => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const p = snapshot.liveProcessing
  if (!p || !snapshot.session.startedAt) return null
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
          : "Processing could not be updated."
      )
    } finally {
      setBusy(false)
    }
  }
  const steps = [
    { label: "Capture", status: "completed", icon: Check },
    { label: "Speakers", status: p.diarizationStatus, icon: Users },
    { label: "Polish", status: p.polishStatus, icon: Pencil },
  ]
  return (
    <section
      aria-label="Transcript post-processing"
      className="flex flex-col gap-4 rounded-2xl bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {p.status === "completed"
            ? "Transcript processing complete"
            : p.status === "failed"
              ? "Transcript processing needs attention"
              : "Preparing your final transcript"}
        </h2>
        <span className="text-xs text-muted-foreground">
          Your transcript remains available below.
        </span>
      </div>
      <ol className="grid grid-cols-3 gap-3">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
                step.status === "completed" && "bg-primary/10 text-primary",
                step.status === "processing" &&
                  "bg-primary text-primary-foreground",
                step.status === "failed" && "bg-destructive/10 text-destructive"
              )}
            >
              {step.status === "completed" ? (
                <Check className="size-4" />
              ) : step.status === "failed" ? (
                <CircleAlert className="size-4" />
              ) : step.status === "skipped" ? (
                <SkipForward className="size-4" />
              ) : step.status === "processing" ? (
                <LoaderCircle className="size-4 motion-safe:animate-spin" />
              ) : (
                <step.icon className="size-4" />
              )}
            </span>
            <span>
              {step.label}
              <span className="block text-xs text-muted-foreground">
                {step.status === "queued" ? "Waiting" : step.status}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {p.status !== "completed" ? (
        <div
          key={`${p.stage}:${p.status}`}
          className={cn(
            styles.result,
            "flex flex-col gap-3 rounded-xl bg-muted/40 p-4 text-sm"
          )}
        >
          <p role="status" aria-live="polite">
            {p.status === "failed"
              ? p.error
              : p.stage === "diarization"
                ? `Recognizing speakers · ${snapshot.speakers.length} speaker labels available`
                : p.stage === "grammar"
                  ? `Polishing transcript · ${snapshot.segments.filter((s) => s.polishedText).length} of ${snapshot.segments.length} text blocks ready`
                  : "Waiting for the audio recording to finish saving."}
          </p>
          {p.status === "failed" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act("retry")}
              >
                <RefreshCw data-icon="inline-start" />
                Retry step
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void act("skip")}
              >
                <SkipForward data-icon="inline-start" />
                Skip{" "}
                {p.stage === "diarization" ? "speaker separation" : "polish"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
