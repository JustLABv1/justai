"use client"

import { Spinner } from "@/components/panelui/spinner"
import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"
import { Check, CircleAlert, FileVideo, SkipForward, X } from "lucide-react"
import type { ReactNode } from "react"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Card } from "@/components/panelui/card"
import { Frame } from "@/components/panelui/frame"
import { Progress } from "@/components/ui/progress"
import type {
  TranscriptionSegment,
  TranscriptionVideoPipelineStep,
  TranscriptionVideoUpload,
} from "@/lib/types"
import { videoStepProgress } from "@/lib/video-processing"
import { cn } from "@/lib/utils"

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

type Translate = (
  key: string,
  values?: Record<string, string | number>
) => string

/** The measured detail line is built in English in `lib`; localize its known shapes here. */
function localizeDetail(detail: string, t: Translate) {
  const patterns: Array<[RegExp, string]> = [
    [/^(\S+) \/ (\S+) MB uploaded$/, "{value0} / {value1} MB uploaded"],
    [
      /^(\d+) \/ (\d+) audio blocks transcribed$/,
      "{value0} / {value1} audio blocks transcribed",
    ],
    [
      /^(\d+) \/ (\d+) caption images analyzed$/,
      "{value0} / {value1} caption images analyzed",
    ],
    [
      /^(\d+) \/ (\d+) text blocks polished$/,
      "{value0} / {value1} text blocks polished",
    ],
    [
      /^Waiting for caption analysis · (\d+) images selected$/,
      "Waiting for caption analysis · {value0} images selected",
    ],
  ]
  for (const [pattern, key] of patterns) {
    const match = pattern.exec(detail)
    if (match)
      return t(
        key,
        Object.fromEntries(match.slice(1).map((v, i) => [`value${i}`, v]))
      )
  }
  return detail
}

function formatRemaining(ms: number, t: Translate) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return t("{value0} s", { value0: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t("{value0} min", { value0: minutes })
  return t("{value0} h {value1} min", {
    value0: Math.floor(minutes / 60),
    value1: minutes % 60,
  })
}

function formatStepDuration(ms: number, t: Translate) {
  if (ms <= 0) return ""
  if (ms < 1000) return t("under 1 s")
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return t("{value0} s", { value0: seconds })
  return t("{value0} min {value1} s", {
    value0: Math.floor(seconds / 60),
    value1: seconds % 60,
  })
}

function formatSize(bytes: number) {
  if (!bytes) return ""
  const mb = bytes / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

export function VideoProcessingProgress({
  steps,
  upload,
  elapsed,
  elapsedMs,
  segments,
  children,
  actions,
}: {
  steps: TranscriptionVideoPipelineStep[]
  upload: TranscriptionVideoUpload
  /** No longer shown; kept so callers need not change. */
  statusLabel?: string
  elapsed?: string
  elapsedMs?: number
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

  const overall = failed
    ? { tone: "destructive" as const, label: t("Paused") }
    : cancelled
      ? { tone: "secondary" as const, label: t("Cancelled") }
      : completed
        ? { tone: "success" as const, label: t("Completed") }
        : queued
          ? { tone: "warning" as const, label: t("Queued") }
          : { tone: "info" as const, label: t("In progress") }
  const stepStateLabel = (step: TranscriptionVideoPipelineStep) => {
    const isActive = currentStep?.key === step.key && !cancelled && !completed
    if (step.status === "completed") {
      const took = formatStepDuration(step.durationMs ?? 0, t)
      return took ? `${t("Completed")} · ${took}` : t("Completed")
    }
    if (step.status === "skipped") return t("Skipped")
    if (step.status === "failed") return t("Needs attention")
    if (step.status === "cancelled") return t("Cancelled")
    if (isActive)
      return queued
        ? t("Queued")
        : elapsed && measured.percent === null
          ? `${t("In progress")} · ${elapsed}`
          : t("In progress")
    return t("Pending")
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
          <FileVideo aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={upload.fileName}>
            {upload.fileName}
          </p>
          <p className="text-xs text-muted-foreground">
            {[formatSize(upload.expectedBytes), t("Video transcription")]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Badge dot variant={overall.tone}>
          {overall.label}
        </Badge>
      </div>

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <Frame>
          <Frame.Header>
            <Frame.Title>{t("Transcription progress")}</Frame.Title>
          </Frame.Header>
          <Frame.Panel aria-label={t("Transcription progress")} role="list">
            {visibleSteps.map((step, stepIndex) => {
              const complete = step.status === "completed"
              const skipped = step.status === "skipped"
              const active =
                currentStep?.key === step.key && !cancelled && !completed
              const error = step.status === "failed"
              const stopped = step.status === "cancelled"
              return (
                <Frame.Row
                  aria-current={active ? "step" : undefined}
                  key={step.key}
                  role="listitem"
                >
                  <Frame.Media
                    className={cn(
                      complete && "text-success",
                      active && !error && "text-primary",
                      error && "text-destructive"
                    )}
                  >
                    {error ? (
                      <CircleAlert aria-hidden="true" />
                    ) : complete ? (
                      <Check aria-hidden="true" />
                    ) : skipped ? (
                      <SkipForward aria-hidden="true" />
                    ) : stopped ? (
                      <X aria-hidden="true" />
                    ) : active && !queued ? (
                      <Spinner aria-hidden="true" className="size-4" />
                    ) : (
                      <span className="text-xs font-semibold tabular-nums">
                        {stepIndex + 1}
                      </span>
                    )}
                  </Frame.Media>
                  <Frame.Content>
                    <Frame.Title
                      as="p"
                      className={cn(
                        "overflow-visible! text-clip! whitespace-normal!",
                        !active && !complete && "text-muted-foreground"
                      )}
                    >
                      {presentation[step.key]?.label ?? step.key}
                    </Frame.Title>
                    <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                      {stepStateLabel(step)}
                    </Frame.Description>
                  </Frame.Content>
                </Frame.Row>
              )
            })}
          </Frame.Panel>
        </Frame>

        <Card className="min-w-0">
          <Card.Header>
            <div className="flex flex-wrap items-center gap-2">
              <Badge size="sm" variant="outline">
                {failed
                  ? t("Processing paused")
                  : cancelled
                    ? t("Cancelled")
                    : completed
                      ? t("Completed")
                      : currentStep?.key === "finalization"
                        ? t("Finishing up")
                        : t("Step {value0} of {value1}", {
                            value0: Math.max(0, index) + 1,
                            value1: visibleSteps.length,
                          })}
              </Badge>
            </div>
            <Card.Title aria-atomic="true" aria-live="polite" role="status">
              {title}
            </Card.Title>
            <Card.Description>{description}</Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            {running && measured.percent !== null ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 tabular-nums">
                  <span
                    aria-hidden="true"
                    className="text-2xl font-semibold tracking-tight"
                  >
                    {measured.percent}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {localizeDetail(measured.detail, t)}
                  </span>
                </div>
                <Progress
                  aria-label={t("{value0} progress", {
                    value0: current.label,
                  })}
                  value={measured.percent}
                />
                {elapsed ? (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {t("{value0} elapsed", { value0: elapsed })}
                    {" · "}
                    {elapsedMs !== undefined &&
                    measured.percent >= 3 &&
                    measured.percent < 100 &&
                    elapsedMs >= 4000
                      ? t("about {value0} left", {
                          value0: formatRemaining(
                            (elapsedMs * (100 - measured.percent)) /
                              measured.percent,
                            t
                          ),
                        })
                      : t("Estimating the remaining time…")}
                  </p>
                ) : null}
              </div>
            ) : null}
            {children}
          </Card.Content>
          {actions || running ? (
            <Card.Footer variant="panel">
              <div className="flex w-full flex-wrap items-center justify-between gap-3">
                {running ? (
                  <p className="min-w-0 text-xs text-muted-foreground">
                    {next
                      ? t("Next: {value0}", {
                          value0: presentation[next.key]?.title ?? next.key,
                        })
                      : currentStep?.key !== "finalization"
                        ? t("Next: save your transcript for review")
                        : t("Your transcript will open when it is ready.")}
                  </p>
                ) : (
                  <span />
                )}
                {actions}
              </div>
            </Card.Footer>
          ) : null}
        </Card>
      </div>

      <Alert
        tone={failed || cancelled ? "warning" : completed ? "success" : "info"}
        variant="plain"
      >
        <Alert.Description>
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
        </Alert.Description>
      </Alert>
    </div>
  )
}
