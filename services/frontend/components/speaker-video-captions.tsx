"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ImageIcon, LoaderCircle } from "lucide-react"
import Image from "next/image"
import { api } from "@/lib/api"
import type { Endpoint, TranscriptionSpeaker } from "@/lib/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

type CaptionRun = {
  id: string
  status: "queued" | "processing" | "completed" | "failed" | "cancelled"
  frames: { speakerId: string; label: string; offsetMs: number }[]
  observations: {
    frameIndex: number
    name: string
    caption: string
    error?: string
  }[]
  results: {
    speakerId: string
    name: string
    confidence: number
    evidence: string
    frameIndices: number[]
    applied: boolean
    conflict: boolean
  }[]
  errorMessage?: string
}
function timestamp(ms: number) {
  const seconds = Math.floor(ms / 1000)
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":")
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not load name caption analysis."
}

export function SpeakerVideoCaptions({
  sessionId,
  available,
  speakers,
  onSpeakersChange,
  onSeek,
}: {
  sessionId: string
  available: boolean
  speakers: TranscriptionSpeaker[]
  onSpeakersChange: (speakers: TranscriptionSpeaker[]) => void
  onSeek: (offsetMs: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [run, setRun] = useState<CaptionRun | null>(null)
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [endpointId, setEndpointId] = useState("")
  const [model, setModel] = useState("")
  const [budget, setBudget] = useState("24")
  const [autoApply, setAutoApply] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadingEndpoints, setLoadingEndpoints] = useState(false)
  const [error, setError] = useState("")
  const [imageIndex, setImageIndex] = useState<number | null>(null)
  const [imageURL, setImageURL] = useState("")
  const [imageError, setImageError] = useState("")
  const appliedRun = useRef("")
  const changeRef = useRef(onSpeakersChange)
  useEffect(() => {
    changeRef.current = onSpeakersChange
  }, [onSpeakersChange])
  const base = `/api/v1/transcription/sessions/${sessionId}`
  const runId = run?.id
  const active = run?.status === "queued" || run?.status === "processing"

  const acceptRun = useCallback(
    async (next: CaptionRun | null, signal?: AbortSignal) => {
      if (signal?.aborted) return
      if (next?.status === "completed" && appliedRun.current !== next.id) {
        const snapshot = await api.get<{ speakers: TranscriptionSpeaker[] }>(
          base,
          { signal }
        )
        if (!signal?.aborted) {
          changeRef.current(snapshot.speakers)
          appliedRun.current = next.id
        }
      }
      // Finish the snapshot refresh before stopping the polling effect. Its
      // cleanup aborts this request when the run becomes terminal.
      if (!signal?.aborted) setRun(next)
    },
    [base]
  )

  useEffect(() => {
    const controller = new AbortController()
    api
      .get<{ run: CaptionRun | null }>(`${base}/speaker-captions`, {
        signal: controller.signal,
      })
      .then((result) => acceptRun(result.run, controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error))
      })
    return () => controller.abort()
  }, [base, acceptRun])

  useEffect(() => {
    if (!active || !runId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await api.get<{ run: CaptionRun }>(
          `${base}/speaker-captions/${runId}`,
          { signal: controller.signal }
        )
        await acceptRun(result.run, controller.signal)
        if (!controller.signal.aborted) setError("")
      } catch (error) {
        if (!controller.signal.aborted) setError(message(error))
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [active, runId, base, acceptRun]) // Progress updates do not restart the timer.

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    api
      .get<{ endpoints: Endpoint[] }>("/api/v1/endpoints", {
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return
        const options = result.endpoints.filter(
          (endpoint) =>
            endpoint.enabled &&
            (endpoint.capabilities.vision || endpoint.capabilities.multimodal)
        )
        setEndpoints(options)
        setEndpointId((current) =>
          options.some((endpoint) => endpoint.id === current)
            ? current
            : (options[0]?.id ?? "")
        )
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingEndpoints(false)
      })
    return () => controller.abort()
  }, [open])

  useEffect(() => {
    if (imageIndex === null || !runId) return
    const controller = new AbortController()
    let objectURL = ""
    api
      .getBlob(`${base}/speaker-captions/${runId}/frames/${imageIndex}`, {
        signal: controller.signal,
      })
      .then((blob) => {
        if (controller.signal.aborted) return
        objectURL = URL.createObjectURL(blob)
        setImageURL(objectURL)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setImageError(message(error))
      })
    return () => {
      controller.abort()
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [imageIndex, runId, base])

  async function start() {
    setBusy(true)
    setError("")
    try {
      const result = await api.post<{ run: CaptionRun }>(
        `${base}/speaker-captions`,
        { endpointId, model, frameBudget: Number(budget), autoApply }
      )
      await acceptRun(result.run)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  async function cancel() {
    if (!run) return
    setBusy(true)
    setError("")
    try {
      await api.delete(`${base}/speaker-captions/${run.id}`)
      const result = await api.get<{ run: CaptionRun }>(
        `${base}/speaker-captions/${run.id}`
      )
      await acceptRun(result.run)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const endpoint = endpoints.find((item) => item.id === endpointId)
  const analyzed = run?.observations.length ?? 0
  const total = run?.frames.length ?? 0
  const image = imageIndex === null ? null : run?.frames[imageIndex]
  const observation =
    imageIndex === null
      ? null
      : run?.observations.find((item) => item.frameIndex === imageIndex)
  const failedImages =
    run?.observations.filter((item) => item.error).length ?? 0

  return (
    <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">Names from video captions</p>
          <p className="text-xs text-muted-foreground">
            Match printed name captions to speaker turns.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setLoadingEndpoints(true)
            setOpen(true)
          }}
        >
          <ImageIcon className="size-4" />
          {active
            ? "View analysis"
            : run
              ? "Review captions"
              : "Read name captions"}
        </Button>
      </div>
      {active && (
        <div role="status" className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {run?.status === "queued"
              ? "Queued · waiting for an analysis worker"
              : `Reading name captions · ${analyzed} of ${total} images analyzed`}
          </p>
          <Progress
            aria-label="Name caption analysis"
            value={total ? (analyzed / total) * 100 : 0}
          />
        </div>
      )}
      {!available && !active && (
        <p className="text-xs text-muted-foreground">
          Analysis requires a completed video with an available source file.
        </p>
      )}
      {error && !open && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Read speaker name captions</DialogTitle>
            <DialogDescription>
              Read visible text in the lower half of selected video frames and
              match it to audio speaker labels. Manually named speakers stay
              unchanged.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {run && (
            <div
              className="space-y-3 rounded-lg bg-muted/50 p-3 text-sm"
              aria-live="polite"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">
                  {active
                    ? run.status === "queued"
                      ? "Waiting to start"
                      : "Reading name captions"
                    : run.status === "completed"
                      ? "Caption analysis complete"
                      : run.status === "cancelled"
                        ? "Analysis cancelled"
                        : "Analysis failed"}
                </p>
                {active && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={cancel}
                  >
                    Cancel analysis
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground">
                {analyzed} of {total} images analyzed
                {failedImages ? ` · ${failedImages} could not be read` : ""}
              </p>
              {active && (
                <>
                  <Progress
                    aria-label="Name caption analysis"
                    value={total ? (analyzed / total) * 100 : 0}
                  />
                  <p className="text-xs text-muted-foreground">
                    You can leave this page. Analysis continues in the
                    background.
                  </p>
                </>
              )}
              {run.errorMessage && (
                <p role="alert" className="text-destructive">
                  {run.errorMessage}
                </p>
              )}
              {run.status === "completed" && !run.results.length && (
                <p>
                  No reliable name captions were found. Existing speaker names
                  remain unchanged.
                </p>
              )}
              {run.results.map((result) => (
                <div
                  key={result.speakerId}
                  className="space-y-2 rounded-md bg-background p-3"
                >
                  <p className="font-medium">
                    {speakers.find((item) => item.id === result.speakerId)
                      ?.label ?? "Speaker"}{" "}
                    → {result.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {result.applied
                      ? "Automatically applied"
                      : result.conflict
                        ? "Conflicting captions · review before accepting"
                        : "Suggestion · accept or dismiss in the speaker list"}{" "}
                    · {Math.round(result.confidence * 100)}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {result.evidence}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {result.frameIndices.map((index) => (
                      <Button
                        key={index}
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setImageURL("")
                          setImageError("")
                          setImageIndex(index)
                        }}
                      >
                        <ImageIcon className="size-4" />
                        {timestamp(run.frames[index].offsetMs)}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!active && (
            <div className="space-y-4">
              <Field>
                <FieldLabel htmlFor="caption-endpoint">
                  Vision endpoint
                </FieldLabel>
                <Select
                  value={endpointId}
                  onValueChange={(value) => {
                    setEndpointId(value ?? "")
                    setModel("")
                  }}
                  items={endpoints.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                >
                  <SelectTrigger id="caption-endpoint" className="w-full">
                    <SelectValue
                      placeholder={
                        loadingEndpoints
                          ? "Loading endpoints…"
                          : "Select a vision endpoint"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {endpoints.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {!loadingEndpoints && !endpoints.length && (
                <p className="text-sm text-muted-foreground">
                  Configure an enabled endpoint with vision capability in
                  Settings → Endpoints to read video images.
                </p>
              )}
              <Field>
                <FieldLabel htmlFor="caption-model">Vision model</FieldLabel>
                <Input
                  id="caption-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={
                    endpoint?.visionModel ||
                    endpoint?.chatModel ||
                    "Enter a vision model"
                  }
                  maxLength={200}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="caption-budget">Maximum images</FieldLabel>
                <Select
                  value={budget}
                  onValueChange={(value) => setBudget(value ?? "24")}
                  items={[
                    { value: "12", label: "12 images" },
                    { value: "24", label: "24 images" },
                    { value: "48", label: "48 images" },
                  ]}
                >
                  <SelectTrigger id="caption-budget" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[12, 24, 48].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value} images
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Up to four images per unnamed speaker. The budget stays fixed
                  for long videos; each image uses one model request.
                </p>
              </Field>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <label
                    htmlFor="caption-auto-apply"
                    className="text-sm font-medium"
                  >
                    Apply consistent matches automatically
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Requires at least three matching images across two speech
                    turns, with no conflicting name.
                  </p>
                </div>
                <Switch
                  id="caption-auto-apply"
                  checked={autoApply}
                  onCheckedChange={setAutoApply}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Selected frame crops are sent to the chosen endpoint when you
                start. This reads printed names; it does not identify faces.
              </p>
              <Button
                className="w-full"
                disabled={
                  busy ||
                  loadingEndpoints ||
                  !available ||
                  !endpointId ||
                  !(
                    model.trim() ||
                    endpoint?.visionModel ||
                    endpoint?.chatModel
                  )
                }
                onClick={start}
              >
                {busy && <LoaderCircle className="size-4 animate-spin" />}
                {run ? "Start new analysis" : "Start caption analysis"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={imageIndex !== null}
        onOpenChange={(value) => {
          if (!value) setImageIndex(null)
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Caption evidence · {timestamp(image?.offsetMs ?? 0)}
            </DialogTitle>
            <DialogDescription>
              {observation?.caption || "Selected lower-third video crop"}
            </DialogDescription>
          </DialogHeader>
          {imageError ? (
            <p role="alert" className="text-sm text-destructive">
              {imageError}
            </p>
          ) : imageURL ? (
            <Image
              width={960}
              height={540}
              unoptimized
              src={imageURL}
              alt={`Video caption at ${timestamp(image?.offsetMs ?? 0)}: ${observation?.caption ?? ""}`}
              className="max-h-[60dvh] w-full rounded-lg object-contain"
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Loading evidence image…
            </p>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              if (image) onSeek(image.offsetMs)
              setImageIndex(null)
              setOpen(false)
            }}
          >
            Go to this moment in video
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
