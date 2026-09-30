"use client"

import {
  Check,
  CircleAlert,
  FileText,
  Pencil,
  SkipForward,
  Upload,
  Users,
} from "lucide-react"
import type { TranscriptionVideoPipelineStep } from "@/lib/types"
import { cn } from "@/lib/utils"
import styles from "./video-processing-progress.module.css"

const stepPresentation = {
  upload: { label: "Upload", icon: Upload },
  transcription: { label: "Transcribe", icon: FileText },
  diarization: { label: "Speakers", icon: Users },
  grammar: { label: "Polish", icon: Pencil },
  finalization: { label: "Finish", icon: Check },
}

export function VideoProcessingProgress({
  steps,
  status,
  statusLabel,
  elapsed,
  uploadProgress,
}: {
  steps: TranscriptionVideoPipelineStep[]
  status: string
  statusLabel: string
  elapsed?: string
  uploadProgress: number
}) {
  const failed =
    steps.some((step) => step.status === "failed") || status === "failed"
  const cancelled = status === "cancelled"
  const currentStep = steps.find((step) =>
    ["active", "retrying", "failed"].includes(step.status)
  )

  return (
    <div className="flex flex-col gap-8 px-4 pt-8 pb-3 sm:px-8 sm:pt-10">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          {failed
            ? "Your transcript needs attention"
            : cancelled
              ? "Transcription cancelled"
              : "Preparing your transcript"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {failed
            ? currentStep?.key === "diarization"
              ? "Your progress is saved. Retry speaker separation or skip it to continue."
              : "Your progress is saved. Retry the failed step to continue."
            : cancelled
              ? "Any transcript already created is still available."
              : "You can leave this page. Processing continues in the background."}
        </p>
      </div>
      <ol aria-label="Transcription progress" className="grid grid-cols-5">
        {steps.map((step, index) => {
          const presentation =
            stepPresentation[step.key as keyof typeof stepPresentation]
          const Icon = presentation?.icon ?? FileText
          const complete = step.status === "completed"
          const skipped = step.status === "skipped"
          const active = step.status === "active" || step.status === "retrying"
          const error = step.status === "failed"
          return (
            <li
              key={step.key}
              aria-current={active || error ? "step" : undefined}
              className="relative flex min-w-0 flex-col items-center gap-3 text-center"
            >
              {index < steps.length - 1 ? (
                <span aria-hidden="true" className={styles.connector}>
                  <span
                    className={styles.connectorFill}
                    style={{
                      transform: `scaleX(${complete || skipped ? 1 : 0})`,
                    }}
                  />
                </span>
              ) : null}
              <span
                className={cn(
                  styles.step,
                  "relative flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground sm:size-12",
                  complete && "bg-primary/10 text-primary",
                  active && "bg-primary text-primary-foreground",
                  error && "bg-destructive/10 text-destructive"
                )}
                data-active={active || undefined}
              >
                {error ? (
                  <CircleAlert className="size-5" />
                ) : skipped ? (
                  <SkipForward className="size-5" />
                ) : complete ? (
                  <Check className="size-5" />
                ) : (
                  <Icon className="size-5" />
                )}
              </span>
              <span
                className={cn(
                  "text-xs font-medium sm:text-sm",
                  active
                    ? "text-primary"
                    : error
                      ? "text-destructive"
                      : complete
                        ? "text-foreground"
                        : "text-muted-foreground"
                )}
              >
                {presentation?.label ?? step.key}
                {skipped ? (
                  <span className="mt-1 block text-[10px] font-normal text-muted-foreground sm:text-xs">
                    Skipped
                  </span>
                ) : (
                  <span className="sr-only">: {step.status}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl bg-muted/40 px-4 py-4 text-center">
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-sm font-medium"
        >
          <span
            key={`${currentStep?.key}:${currentStep?.status}:${statusLabel}`}
            className={styles.status}
          >
            {statusLabel}
          </span>
        </p>
        {elapsed || status === "uploading" ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {status === "uploading"
              ? `${Math.round(uploadProgress)}% uploaded`
              : `Current step · ${elapsed}`}
          </span>
        ) : null}
      </div>
    </div>
  )
}
