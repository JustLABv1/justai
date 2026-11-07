"use client"

import { useTranslations } from "@/components/locale-provider"
import { useEffect, useRef } from "react"
import { Alert } from "@/components/panelui/alert"
import { Frame } from "@/components/panelui/frame"
import type {
  TranscriptionSegment,
  TranscriptionSpeaker,
  TranscriptionVideoUpload,
} from "@/lib/types"
import styles from "./video-processing-progress.module.css"

function timestamp(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}

export function VideoProcessingOutput({
  step,
  upload,
  segments,
  speakers,
  error,
}: {
  step: string
  upload: TranscriptionVideoUpload
  segments: TranscriptionSegment[]
  speakers: TranscriptionSpeaker[]
  error?: string
}) {
  const { t } = useTranslations()

  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const parallel = upload.pipeline?.find(
    (item) => item.key === "transcription"
  )?.parallel
  const preview = parallel?.previewSegments ?? []
  const blocks = (
    step === "grammar"
      ? segments
          .filter((s) => s.polishedText?.trim())
          .map((s) => ({ ...s, text: s.polishedText! }))
      : preview.length > 0
        ? preview
        : segments
  )
    .filter((s) => s.text.trim())
    .slice()
    .sort((a, b) => (a.startOffsetMs ?? 0) - (b.startOffsetMs ?? 0))
    .map((block, index) => ({
      ...block,
      key:
        "id" in block
          ? String(block.id)
          : `${block.startOffsetMs}:${block.endOffsetMs}:${index}`,
    }))
    .slice(-200)
  const lastBlock = blocks.at(-1)
  useEffect(() => {
    following.current = true
  }, [step])
  useEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight
  }, [step, blocks.length, lastBlock?.text])
  const heading =
    upload.status === "queued"
      ? t("Waiting to start")
      : step === "upload"
        ? t("Uploading your recording")
        : step === "transcription"
          ? t("Incoming transcript")
          : step === "diarization"
            ? t("Detected speakers")
            : step === "grammar"
              ? t("Corrected transcript")
              : t("Preparing the result")
  const count =
    step === "transcription" && parallel?.sliceCount
      ? t("{value0} / {value1} blocks processed", {
          value0: parallel.completedSlices ?? 0,
          value1: parallel.sliceCount,
        })
      : step === "diarization" && speakers.length
        ? t("{value0} speakers", { value0: speakers.length })
        : (step === "transcription" || step === "grammar") && blocks.length
          ? t("{value0} text blocks", { value0: blocks.length })
          : null
  const muted = "text-sm text-muted-foreground"
  return (
    <Frame aria-label={t("Current step output")}>
      <Frame.Header>
        <Frame.Title>{heading}</Frame.Title>
        {count ? (
          <Frame.Action>
            <span role="status">{count}</span>
          </Frame.Action>
        ) : null}
      </Frame.Header>
      <Frame.Panel>
        {error ? (
          <Frame.Row>
            <Frame.Content>
              <Alert tone="destructive" variant="plain">
                <Alert.Title>{t("Processing needs attention")}</Alert.Title>
                <Alert.Description>{t(error)}</Alert.Description>
              </Alert>
            </Frame.Content>
          </Frame.Row>
        ) : null}
        {upload.status === "queued" ? (
          <Frame.Row>
            <Frame.Content>
              <p className={muted}>
                {upload.workerStatus?.queuePosition
                  ? t(
                      "Position {value0} in the queue. Processing starts when a worker is available.",
                      { value0: upload.workerStatus.queuePosition }
                    )
                  : t(
                      "Your video is queued. Processing will start automatically."
                    )}
              </p>
            </Frame.Content>
          </Frame.Row>
        ) : step === "upload" ? (
          <Frame.Row>
            <Frame.Content>
              <Frame.Title as="p">{upload.fileName}</Frame.Title>
              <Frame.Description>
                {(upload.bytes / 1048576).toFixed(1)} /{" "}
                {(upload.expectedBytes / 1048576).toFixed(1)} {t("MB uploaded")}
              </Frame.Description>
            </Frame.Content>
          </Frame.Row>
        ) : step === "transcription" || step === "grammar" ? (
          blocks.length ? (
            <Frame.Row className="items-start">
              <div
                ref={viewport}
                onScroll={() => {
                  const el = viewport.current
                  if (el)
                    following.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight < 40
                }}
                tabIndex={0}
                aria-label={heading}
                className="flex max-h-72 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              >
                {blocks.map((block) => (
                  <div
                    key={block.key}
                    className={`${styles.result} grid grid-cols-[3rem_minmax(0,1fr)] gap-2`}
                  >
                    <p className="pt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                      {timestamp(block.startOffsetMs ?? 0)}
                    </p>
                    <p className="text-sm leading-6">{block.text}</p>
                  </div>
                ))}
              </div>
            </Frame.Row>
          ) : (
            <Frame.Row>
              <Frame.Content>
                <p className={muted}>
                  {step === "grammar"
                    ? t(
                        "Corrected paragraphs will appear when they are available."
                      )
                    : t("Text blocks will appear here as they arrive.")}
                </p>
              </Frame.Content>
            </Frame.Row>
          )
        ) : step === "diarization" ? (
          speakers.length ? (
            speakers.map((speaker) => (
              <Frame.Row className={styles.result} key={speaker.id}>
                <Frame.Content>
                  <Frame.Title as="p">
                    {speaker.displayName || speaker.label}
                  </Frame.Title>
                </Frame.Content>
              </Frame.Row>
            ))
          ) : (
            <Frame.Row>
              <Frame.Content>
                <p className={muted}>
                  {error
                    ? t(
                        "No speaker assignments are available. Retry or continue without speaker separation."
                      )
                    : t(
                        "Speaker assignments will appear when recognition finishes."
                      )}
                </p>
              </Frame.Content>
            </Frame.Row>
          )
        ) : (
          <Frame.Row>
            <Frame.Content>
              <p className={muted}>
                {segments.length} {t("transcript segments and")}{" "}
                {speakers.length}{" "}
                {t("speakers. Saving the transcript for review and export.")}
              </p>
            </Frame.Content>
          </Frame.Row>
        )}
      </Frame.Panel>
      {(step === "transcription" || step === "grammar") && blocks.length > 0 ? (
        <p className="px-1 pt-2 text-xs text-muted-foreground">
          {t("Preview · text and speaker assignments may still change.")}
        </p>
      ) : null}
    </Frame>
  )
}
