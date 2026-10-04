"use client"

import { useEffect, useRef, useState } from "react"
import { useAui } from "@assistant-ui/react"
import { Button } from "@/components/ui/button"
import { api, resolveAPIURL } from "@/lib/api"
import { parseToolResult } from "@/lib/file-result-logic"
import {
  uploadVideoParts,
  type VideoUploadPartResult,
} from "@/lib/video-upload"
import type {
  TranscriptionSession,
  TranscriptionVideoUpload,
} from "@/lib/types"

type Snapshot = {
  session: TranscriptionSession
  videoUpload?: TranscriptionVideoUpload
}

export function TranscriptionCard({ value }: { value: unknown }) {
  const parsed = parseToolResult(value)
  const result =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null
  const id = typeof result?.sessionId === "string" ? result.sessionId : ""
  const aui = useAui()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState("")
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    const refresh = async () => {
      try {
        const next = await api.get<Snapshot>(
          `/api/v1/transcription/sessions/${id}`
        )
        if (active) {
          setSnapshot(next)
          setError("")
        }
      } catch (caught) {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load transcription"
          )
      }
    }
    void refresh()
    const timer = setInterval(() => {
      if (!controller.current) void refresh()
    }, 4000)
    return () => {
      active = false
      clearInterval(timer)
      controller.current?.abort()
    }
  }, [id])

  if (!id) return null
  const upload = snapshot?.videoUpload
  const complete =
    snapshot?.session.status === "completed" || upload?.status === "completed"
  const canUpload =
    snapshot &&
    (!upload || ["uploading", "failed"].includes(upload.status)) &&
    !complete

  async function start() {
    if (!file || !snapshot || busy) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError("")
    try {
      const initialized =
        upload?.status === "uploading"
          ? await api.get<{
              upload: TranscriptionVideoUpload
              uploadedParts?: VideoUploadPartResult[]
            }>(`/api/v1/transcription/video-uploads/${upload.id}`)
          : await api.post<{
              upload: TranscriptionVideoUpload
              uploadedParts?: VideoUploadPartResult[]
            }>(`/api/v1/transcription/sessions/${id}/video-uploads`, {
              fileName: file.name,
              mimeType: file.type || "application/octet-stream",
              fileBytes: file.size,
            })
      if (
        initialized.upload.fileName !== file.name ||
        initialized.upload.expectedBytes !== file.size
      )
        throw new Error("Choose the original video to resume this upload.")
      setSnapshot({ ...snapshot, videoUpload: initialized.upload })
      const parts = await uploadVideoParts({
        uploadId: initialized.upload.id,
        file,
        partSize: initialized.upload.partSize,
        partCount: initialized.upload.partCount,
        contentType: initialized.upload.mimeType,
        signal: abort.signal,
        organizationId: api.getOrganizationId() || undefined,
        resolvePartURL: resolveAPIURL,
        uploadedParts: initialized.uploadedParts,
        onProgress: (next) => setProgress(next.percent),
      })
      await api.post(
        `/api/v1/transcription/video-uploads/${initialized.upload.id}/complete`,
        { parts }
      )
      setFile(null)
      setSnapshot(
        await api.get<Snapshot>(`/api/v1/transcription/sessions/${id}`)
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed")
    } finally {
      controller.current = null
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Video transcription"
      className="my-3 flex max-w-2xl flex-col gap-3 rounded-2xl bg-card p-4"
    >
      <p className="font-medium">
        {snapshot?.session.title ||
          String(result?.title || "Video transcription")}
      </p>
      <p className="text-sm text-muted-foreground" role="status">
        {busy
          ? `Uploading ${Math.round(progress)}%`
          : complete
            ? "Transcript ready. Ask questions, summarize it, or export it in chat."
            : upload
              ? `${upload.stage || upload.status} · ${Math.round(upload.progress)}%`
              : "Choose a video to transcribe. Language is detected automatically unless specified."}
      </p>
      {canUpload && (
        <>
          <label className="flex flex-col gap-2 text-sm">
            {upload?.status === "uploading"
              ? `Resume with ${upload.fileName}`
              : "Video file"}
            <input
              type="file"
              accept=".mp4,.mov,.m4v,.webm,.mkv,.avi,.mpeg,.mpg,.wmv"
              disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="rounded-lg bg-muted p-2 focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
          <Button disabled={!file || busy} onClick={() => void start()}>
            {busy
              ? "Uploading…"
              : upload?.status === "uploading"
                ? "Resume upload"
                : "Upload and transcribe"}
          </Button>
        </>
      )}
      {busy && (
        <Button variant="secondary" onClick={() => controller.current?.abort()}>
          Pause upload
        </Button>
      )}
      {complete && (
        <Button
          onClick={() =>
            aui.thread
              .composer()
              .setText(
                `Summarize transcription ${id}. Read its transcript with get_transcription first.`
              )
          }
        >
          Discuss transcript
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {upload?.error && (
        <p role="alert" className="text-sm text-destructive">
          {upload.error}
        </p>
      )}
      <a
        href={`/video-transcription/${id}`}
        className="text-sm text-primary underline"
      >
        Open transcription workspace
      </a>
    </section>
  )
}
