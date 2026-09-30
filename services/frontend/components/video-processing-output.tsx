"use client"

import { useEffect, useRef } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
      ? "Waiting to start"
      : step === "upload"
        ? "Uploading your recording"
        : step === "transcription"
          ? "Incoming transcript"
          : step === "diarization"
            ? "Detected speakers"
            : step === "grammar"
              ? "Corrected transcript"
              : "Preparing the result"
  return (
    <section
      aria-label="Current step output"
      className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{heading}</h3>
        <span role="status" className="text-xs text-muted-foreground">
          {step === "transcription" && parallel?.sliceCount
            ? `${parallel.completedSlices ?? 0} / ${parallel.sliceCount} blocks processed`
            : step === "diarization" && speakers.length
              ? `${speakers.length} speakers`
              : (step === "transcription" || step === "grammar") &&
                  blocks.length
                ? `${blocks.length} text blocks`
                : null}
        </span>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Processing needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {upload.status === "queued" ? (
        <p className="text-sm text-muted-foreground">
          {upload.workerStatus?.queuePosition
            ? `Position ${upload.workerStatus.queuePosition} in the queue. Processing starts when a worker is available.`
            : "Your video is queued. Processing will start automatically."}
        </p>
      ) : step === "upload" ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="truncate">{upload.fileName}</p>
          <p className="text-muted-foreground">
            {(upload.bytes / 1048576).toFixed(1)} /{" "}
            {(upload.expectedBytes / 1048576).toFixed(1)} MB uploaded
          </p>
        </div>
      ) : step === "transcription" || step === "grammar" ? (
        blocks.length ? (
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
            className="flex max-h-64 flex-col gap-3 overflow-y-auto overscroll-contain rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          >
            {blocks.map((block) => (
              <div key={block.key} className={styles.result}>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">
                  {timestamp(block.startOffsetMs ?? 0)}
                </p>
                <p className="text-sm leading-6">{block.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {step === "grammar"
              ? "Corrected paragraphs will appear when they are available."
              : "Text blocks will appear here as they arrive."}
          </p>
        )
      ) : step === "diarization" ? (
        speakers.length ? (
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            {speakers.map((s) => (
              <li className={styles.result} key={s.id}>
                {s.displayName || s.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {error
              ? "No speaker assignments are available. Retry or continue without speaker separation."
              : "Speaker assignments will appear when recognition finishes."}
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          {segments.length} transcript segments and {speakers.length} speakers.
          Saving the transcript for review and export.
        </p>
      )}
      {(step === "transcription" || step === "grammar") && blocks.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Preview · text and speaker assignments may still change.
        </p>
      ) : null}
    </section>
  )
}
