"use client"

import { Spinner } from "@/components/panelui/spinner"
import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"
import { Check, CircleAlert, SkipForward, X } from "lucide-react"
import type { ReactNode } from "react"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import type {
  TranscriptionSegment,
  TranscriptionVideoPipelineStep,
  TranscriptionVideoUpload,
} from "@/lib/types"
import { videoStepProgress } from "@/lib/video-processing"
import { cn } from "@/lib/utils"
import styles from "./video-processing-progress.module.css"

const presentationMessages: Record<
  string,
  { label: string; title: string; description: string }
> = {
  upload: {
    label: "Upload",
    title: "Uploading your recording",
    description:
      "Your video is being transferred. Transcription starts once the upload is complete.",
  },
  transcription: {
    label: "Transcribe",
    title: "Turning speech into text",
    description:
      "We're transcribing your recording. Available text appears below as it arrives.",
  },
  diarization: {
    label: "Speakers",
    title: "Identifying speakers",
    description:
      "We're comparing voices and assigning transcript passages to the same speaker.",
  },
  speaker_names: {
    label: "Names",
    title: "Reading speaker name captions",
    description:
      "We're reading printed names and matching them to voices. Uncertain matches remain suggestions.",
  },
  grammar: {
    label: "Polish",
    title: "Polishing your transcript",
    description:
      "We're improving punctuation and readability. Corrected passages appear below.",
  },
  finalization: {
    label: "Save transcript",
    title: "Saving your transcript",
    description:
      "The processing steps are finished. We're preparing your transcript for review and export.",
  },
}

export function VideoProcessingProgress({
  steps,
  upload,
  statusLabel,
  elapsed,
  segments,
  children,
  actions,
}: {
  steps: TranscriptionVideoPipelineStep[]
  upload: TranscriptionVideoUpload
  statusLabel: string
  elapsed?: string
  segments: TranscriptionSegment[]
  children: ReactNode
  actions?: ReactNode
}) {
  const presentation = useTranslatedConfig(presentationMessages)

  const { t } = useTranslations()

  const failedStep = steps.find((step) => step.status === "failed")
  const failed = Boolean(failedStep) || upload.status === "failed"
  const cancelled = upload.status === "cancelled"
  const completed = upload.status === "completed" && !failed
  const queued = upload.status === "queued"
  const currentStep =
    failedStep ??
    steps.find((step) => ["active", "retrying"].includes(step.status)) ??
    steps.find((step) => step.status === "pending")
  const visibleSteps = steps.filter((step) => step.key !== "finalization")
  const index = visibleSteps.findIndex((step) => step.key === currentStep?.key)
  const current =
    presentation[currentStep?.key ?? "finalization"] ??
    presentation.finalization
  const currentIndex = currentStep
    ? steps.indexOf(currentStep)
    : steps.length - 1
  const next = steps
    .slice(currentIndex + 1)
    .find((step) => step.status === "pending" && step.key !== "finalization")
  const measured = videoStepProgress(upload, currentStep, segments)
  const running = !failed && !cancelled && !completed && !queued
  const phase =
    currentStep?.key === "transcription"
      ? currentStep.parallel?.phase
      : undefined
  const title = failed
    ? t("{value0} needs attention", {
        value0:
          currentStep?.key === "diarization"
            ? t("Speaker separation")
            : currentStep?.key === "transcription"
              ? t("Transcription")
              : current.label,
      })
    : cancelled
      ? t("Transcription cancelled")
      : completed
        ? t("Your transcript is ready")
        : queued
          ? t("Waiting to start transcription")
          : upload.stage === "skipping_diarization"
            ? t("Skipping speaker separation")
            : phase === "preparing"
              ? t("Preparing your audio")
              : phase === "fusing"
                ? t("Combining transcript blocks")
                : current.title
  const description = failed
    ? failedStep?.key === "diarization"
      ? t(
          "Your progress is saved. Retry speaker separation or skip it to continue."
        )
      : t("Your progress is saved. Retry the failed step to continue.")
    : cancelled
      ? t("Any transcript already created is still available.")
      : completed
        ? t("Your transcript is available for review and export.")
        : queued
          ? t(
              "Your upload is complete. Processing starts automatically when a worker is available."
            )
          : upload.stage === "skipping_diarization"
            ? t(
                "We're continuing with your transcript without speaker separation."
              )
            : phase === "preparing"
              ? t("We're extracting audio and preparing it for transcription.")
              : phase === "fusing"
                ? t(
                    "We're merging the transcribed blocks and resolving overlapping passages."
                  )
                : current.description

  return (
    <div className="flex flex-col gap-6 p-5 sm:gap-7 sm:p-8">
      <header className="flex min-w-0 flex-col gap-1">
        <p
          className="truncate text-xs text-muted-foreground"
          title={upload.fileName}
        >
          {upload.fileName}
        </p>
        <p className="text-sm font-medium">{t("Video transcription")}</p>
      </header>
      <Separator />
      <div className="grid min-w-0 gap-7 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-8">
        <ol
          aria-label={t("Transcription progress")}
          className="grid grid-cols-3 gap-2 sm:flex sm:flex-col sm:gap-0"
        >
          {visibleSteps.map((step, stepIndex) => {
            const complete = step.status === "completed"
            const skipped = step.status === "skipped"
            const active =
              currentStep?.key === step.key && !cancelled && !completed
            const error = step.status === "failed"
            const stopped = step.status === "cancelled"
            const label = complete
              ? t("Completed")
              : skipped
                ? t("Skipped")
                : error
                  ? t("Needs attention")
                  : stopped
                    ? t("Cancelled")
                    : active
                      ? queued
                        ? t("Queued")
                        : t("In progress")
                      : t("Pending")
            return (
              <li
                key={step.key}
                aria-current={active ? "step" : undefined}
                className="relative flex min-w-0 flex-col items-center gap-2 pb-1 text-center sm:flex-row sm:items-start sm:gap-3 sm:pb-7 sm:text-left"
              >
                {stepIndex < visibleSteps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className={styles.connector}
                    data-complete={complete || skipped || undefined}
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground",
                    complete && "bg-primary/10 text-primary",
                    active && !error && "bg-primary text-primary-foreground",
                    error && "bg-destructive/10 text-destructive"
                  )}
                >
                  {error ? (
                    <CircleAlert className="size-4" />
                  ) : complete ? (
                    <Check className="size-4" />
                  ) : skipped ? (
                    <SkipForward className="size-4" />
                  ) : stopped ? (
                    <X className="size-4" />
                  ) : (
                    stepIndex + 1
                  )}
                </span>
                <span
                  className={cn(
                    "min-w-0 pt-1 text-xs sm:text-sm",
                    active && "font-medium",
                    !active && !complete && "text-muted-foreground",
                    error && "text-destructive"
                  )}
                >
                  {presentation[step.key]?.label ?? step.key}
                  <span className="sr-only sm:not-sr-only sm:mt-1 sm:block sm:text-xs sm:font-normal sm:text-muted-foreground">
                    {label}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
        <div className="flex min-w-0 flex-col gap-5">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex flex-col gap-2"
          >
            <p
              className={cn(
                "text-xs font-medium text-primary",
                failed && "text-destructive",
                cancelled && "text-muted-foreground"
              )}
            >
              {failed
                ? t("Processing paused")
                : cancelled
                  ? t("Cancelled")
                  : completed
                    ? t("Completed")
                    : currentStep?.key === "finalization"
                      ? t("Finishing up")
                      : t("Step {value0} of {value1} · {value2}", {
                          value0: Math.max(0, index) + 1,
                          value1: visibleSteps.length,
                          value2: queued
                            ? t("Queued")
                            : currentStep?.status === "retrying"
                              ? t("Retrying")
                              : t("In progress"),
                        })}
            </p>
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {title}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          {running && measured.percent !== null ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 tabular-nums">
                <span
                  aria-hidden="true"
                  className="text-3xl font-medium tracking-tight"
                >
                  {measured.percent}%
                </span>
                <span className="text-xs text-muted-foreground">
                  {measured.detail}
                </span>
              </div>
              <Progress
                aria-label={t("{value0} progress", { value0: current.label })}
                value={measured.percent}
              />
              {elapsed ? (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("Current step ·")} {elapsed} elapsed
                </p>
              ) : null}
            </div>
          ) : running ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner
                aria-hidden="true"
                className="size-4 shrink-0 text-primary"
              />
              {statusLabel}
              {elapsed ? t(" · {value0} elapsed", { value0: elapsed }) : ""}
            </p>
          ) : null}
          {children}
          {running ? (
            <p className="text-xs text-muted-foreground">
              {next
                ? t("Next: {value0}", {
                    value0: presentation[next.key]?.title ?? next.key,
                  })
                : currentStep?.key !== "finalization"
                  ? t("Next: save your transcript for review")
                  : t("Your transcript will open when it is ready.")}
            </p>
          ) : null}
          {actions}
        </div>
      </div>
      <Separator />
      <p className="text-xs leading-5 text-muted-foreground">
        {upload.status === "uploading"
          ? t("Keep this page open until the upload is complete.")
          : failed || cancelled
            ? t(
                "Any available transcript is saved. You can return to it later."
              )
            : completed
              ? t("Your transcript is saved and ready to use.")
              : t(
                  "Your upload is complete. You can leave this page; processing continues in the background."
                )}
      </p>
    </div>
  )
}
