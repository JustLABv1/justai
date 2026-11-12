"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ImageIcon } from "lucide-react"
import Image from "next/image"
import { api } from "@/lib/api"
import type { Endpoint, TranscriptionSpeaker } from "@/lib/types"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Dialog } from "@/components/panelui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import { Tooltip } from "@/components/panelui/tooltip"
import { Progress } from "@/components/ui/progress"

export type CaptionRun = {
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
  onRunChange,
  selectedImage,
  onSelectImage,
  onResolveSuggestion,
  actionSlot,
}: {
  sessionId: string
  available: boolean
  speakers: TranscriptionSpeaker[]
  onSpeakersChange: (speakers: TranscriptionSpeaker[]) => void
  onSeek: (offsetMs: number) => void
  onRunChange: (run: CaptionRun | null) => void
  selectedImage: { runId: string; index: number } | null
  onSelectImage: (image: { runId: string; index: number } | null) => void
  onResolveSuggestion: (
    speaker: TranscriptionSpeaker,
    accept: boolean
  ) => Promise<boolean>
  /** Where the quiet icon button goes when the full notice is not needed. */
  actionSlot?: HTMLElement | null
}) {
  const { t } = useTranslations()

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
  const [imageState, setImageState] = useState<{
    selection: typeof selectedImage
    url: string
    error: string
  } | null>(null)
  const imageURL =
    imageState?.selection === selectedImage ? (imageState?.url ?? "") : ""
  const imageError =
    imageState?.selection === selectedImage ? (imageState?.error ?? "") : ""
  const appliedRun = useRef("")
  const changeRef = useRef(onSpeakersChange)
  useEffect(() => {
    changeRef.current = onSpeakersChange
  }, [onSpeakersChange])
  const base = `/api/v1/transcription/sessions/${sessionId}`
  const runId = run?.id
  const imageIndex =
    selectedImage?.runId === runId ? (selectedImage?.index ?? null) : null
  const active = run?.status === "queued" || run?.status === "processing"

  useEffect(() => {
    onRunChange(run)
  }, [run, onRunChange])

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
        setImageState({ selection: selectedImage, url: objectURL, error: "" })
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setImageState({
            selection: selectedImage,
            url: "",
            error: message(error),
          })
      })
    return () => {
      controller.abort()
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [imageIndex, runId, base, selectedImage])

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
  const imageSpeaker = speakers.find(
    (speaker) => speaker.id === image?.speakerId
  )
  const imageSuggestion = run?.results.find(
    (result) =>
      result.speakerId === imageSpeaker?.id &&
      result.name === imageSpeaker?.suggestedName &&
      imageIndex !== null &&
      result.frameIndices.includes(imageIndex)
  )
  const observation =
    imageIndex === null
      ? null
      : run?.observations.find((item) => item.frameIndex === imageIndex)
  const failedImages =
    run?.observations.filter((item) => item.error).length ?? 0

  // Only call attention to this when something is left to do or went wrong;
  // a finished, clean run folds into a quiet icon button.
  const unnamedSpeakers = speakers.some(
    (speaker) => !speaker.displayName?.trim()
  )
  const needsAttention =
    active ||
    run?.status === "failed" ||
    run?.status === "cancelled" ||
    Boolean(run?.errorMessage) ||
    failedImages > 0 ||
    (run?.status === "completed" && !run.results.length) ||
    (!run && unnamedSpeakers) ||
    (Boolean(error) && !open)
  const openLabel = run ? t("Review captions") : t("Read name captions")

  const statusLabel = active
    ? run?.status === "queued"
      ? t("Waiting to start")
      : t("Reading name captions")
    : run?.status === "completed"
      ? t("Caption analysis complete")
      : run?.status === "cancelled"
        ? t("Analysis cancelled")
        : t("Analysis failed")

  return (
    <>
      {needsAttention ? (
        <Alert tone="neutral" variant="plain">
          <Alert.Icon>
            <ImageIcon aria-hidden="true" />
          </Alert.Icon>
          <Alert.Title>{t("Names from video captions")}</Alert.Title>
          <Alert.Description>
            {t("Match printed name captions to speaker turns.")}
          </Alert.Description>
          {active ? (
            <div role="status" className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {run?.status === "queued"
                  ? t("Queued · waiting for an analysis worker")
                  : t(
                      "Reading name captions · {value0} of {value1} images analyzed",
                      { value0: analyzed, value1: total }
                    )}
              </p>
              <Progress
                aria-label={t("Name caption analysis")}
                value={total ? (analyzed / total) * 100 : 0}
              />
            </div>
          ) : null}
          {!available && !active ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                "Analysis requires a completed video with an available source file."
              )}
            </p>
          ) : null}
          {error && !open ? (
            <ToastFeedback message={error} type="destructive" />
          ) : null}
          <Alert.Actions>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadingEndpoints(true)
                setOpen(true)
              }}
            >
              {active
                ? t("View analysis")
                : run
                  ? t("Review captions")
                  : t("Read name captions")}
            </Button>
          </Alert.Actions>
        </Alert>
      ) : actionSlot ? (
        createPortal(
          <Tooltip.Provider>
            <Tooltip>
              <Tooltip.Trigger
                render={
                  <Button
                    aria-label={openLabel}
                    onClick={() => {
                      setLoadingEndpoints(true)
                      setOpen(true)
                    }}
                    size="icon-sm"
                    variant="outline"
                  />
                }
              >
                <ImageIcon aria-hidden="true" />
              </Tooltip.Trigger>
              <Tooltip.Content>{openLabel}</Tooltip.Content>
            </Tooltip>
          </Tooltip.Provider>,
          actionSlot
        )
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content className="sm:max-w-xl">
          <Dialog.Header
            title={t("Read speaker name captions")}
            description={t(
              "Read visible text in the lower half of selected video frames and match it to audio speaker labels. Manually named speakers stay unchanged."
            )}
          />
          <Dialog.Body className="flex flex-col gap-4">
            {error ? (
              <Alert tone="destructive" variant="plain">
                <Alert.Description>{t(error)}</Alert.Description>
              </Alert>
            ) : null}
            {run ? (
              <Frame aria-live="polite">
                <Frame.Header>
                  <Frame.Title>{statusLabel}</Frame.Title>
                  <Frame.Description>
                    {analyzed} {t("of")} {total} {t("images analyzed")}
                    {failedImages
                      ? t(" · {value0} could not be read", {
                          value0: failedImages,
                        })
                      : ""}
                  </Frame.Description>
                  {active ? (
                    <Frame.Action>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={cancel}
                      >
                        {t("Cancel analysis")}
                      </Button>
                    </Frame.Action>
                  ) : null}
                </Frame.Header>
                <Frame.Panel>
                  {active ? (
                    <Frame.Row>
                      <Frame.Content>
                        <Progress
                          aria-label={t("Name caption analysis")}
                          value={total ? (analyzed / total) * 100 : 0}
                        />
                        <Frame.Description className="mt-2">
                          {t(
                            "You can leave this page. Analysis continues in the background."
                          )}
                        </Frame.Description>
                      </Frame.Content>
                    </Frame.Row>
                  ) : null}
                  {run.errorMessage ? (
                    <Frame.Row>
                      <Frame.Content>
                        <p role="alert" className="text-sm text-destructive">
                          {run.errorMessage}
                        </p>
                      </Frame.Content>
                    </Frame.Row>
                  ) : null}
                  {run.status === "completed" && !run.results.length ? (
                    <Frame.Row>
                      <Frame.Content>
                        <Frame.Description>
                          {t(
                            "No reliable name captions were found. Existing speaker names remain unchanged."
                          )}
                        </Frame.Description>
                      </Frame.Content>
                    </Frame.Row>
                  ) : null}
                  {run.results.map((result) => (
                    <Frame.Row key={result.speakerId}>
                      <Frame.Content>
                        <Frame.Title as="p">
                          {speakers.find((item) => item.id === result.speakerId)
                            ?.label ?? t("Speaker")}{" "}
                          → {result.name}
                        </Frame.Title>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge
                            size="sm"
                            variant={
                              result.applied
                                ? "success"
                                : result.conflict
                                  ? "warning"
                                  : "info"
                            }
                          >
                            {result.applied
                              ? t("Automatically applied")
                              : result.conflict
                                ? t(
                                    "Conflicting captions · review before accepting"
                                  )
                                : t(
                                    "Suggestion · accept or dismiss in the speaker list"
                                  )}
                          </Badge>
                          <Badge size="sm" variant="outline">
                            {Math.round(result.confidence * 100)}%
                          </Badge>
                        </div>
                        <Frame.Description className="mt-1.5">
                          {result.evidence}
                        </Frame.Description>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {result.frameIndices.map((index) => (
                            <Button
                              key={index}
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                onSelectImage({ runId: run.id, index })
                              }}
                            >
                              <ImageIcon data-icon="inline-start" />
                              {timestamp(run.frames[index].offsetMs)}
                            </Button>
                          ))}
                        </div>
                      </Frame.Content>
                    </Frame.Row>
                  ))}
                </Frame.Panel>
              </Frame>
            ) : null}
            {!active ? (
              <div className="flex flex-col gap-4">
                <Field>
                  <FieldLabel>{t("Vision endpoint")}</FieldLabel>
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
                    <SelectTrigger className="w-full">
                      <SelectValue
                        placeholder={
                          loadingEndpoints
                            ? t("Loading endpoints…")
                            : t("Select a vision endpoint")
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
                  {!loadingEndpoints && !endpoints.length ? (
                    <FieldDescription>
                      {t(
                        "Configure an enabled endpoint with vision capability in Settings → Endpoints to read video images."
                      )}
                    </FieldDescription>
                  ) : null}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>{t("Vision model")}</FieldLabel>
                    <Input
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
                    <FieldLabel>{t("Maximum images")}</FieldLabel>
                    <Select
                      value={budget}
                      onValueChange={(value) => setBudget(value ?? "24")}
                      items={[
                        { value: "12", label: "12 images" },
                        { value: "24", label: "24 images" },
                        { value: "48", label: "48 images" },
                      ]}
                    >
                      <SelectTrigger className="w-full">
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
                  </Field>
                </div>
                <p className="-mt-2 text-xs text-muted-foreground">
                  {t(
                    "Up to four images per unnamed speaker. The budget stays fixed for long videos; each image uses one model request."
                  )}
                </p>
                <Frame>
                  <Frame.Panel>
                    <Frame.Row>
                      <Frame.Content>
                        <Frame.Title as="p">
                          {t("Apply consistent matches automatically")}
                        </Frame.Title>
                        <Frame.Description>
                          {t(
                            "Requires at least three matching images across two speech turns, with no conflicting name."
                          )}
                        </Frame.Description>
                      </Frame.Content>
                      <Frame.Actions>
                        <Switch
                          aria-label={t(
                            "Apply consistent matches automatically"
                          )}
                          checked={autoApply}
                          onCheckedChange={setAutoApply}
                        />
                      </Frame.Actions>
                    </Frame.Row>
                  </Frame.Panel>
                </Frame>
                <Alert tone="info" variant="plain">
                  <Alert.Description>
                    {t(
                      "Selected frame crops are sent to the chosen endpoint when you start. This reads printed names; it does not identify faces."
                    )}
                  </Alert.Description>
                </Alert>
              </div>
            ) : null}
          </Dialog.Body>
          {!active ? (
            <Dialog.Footer>
              <Dialog.Close render={<Button variant="secondary" />}>
                {t("Cancel")}
              </Dialog.Close>
              <Button
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
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {run ? t("Start new analysis") : t("Start caption analysis")}
              </Button>
            </Dialog.Footer>
          ) : null}
        </Dialog.Content>
      </Dialog>

      <Dialog
        open={imageIndex !== null}
        onOpenChange={(value) => {
          if (!value) onSelectImage(null)
        }}
      >
        <Dialog.Content className="sm:max-w-3xl">
          <Dialog.Header
            title={`${t("Caption evidence ·")} ${timestamp(image?.offsetMs ?? 0)}`}
            description={
              observation?.caption || "Selected lower-third video crop"
            }
          />
          <Dialog.Body>
            {imageError ? (
              <Alert tone="destructive" variant="plain">
                <Alert.Description>{t(imageError)}</Alert.Description>
              </Alert>
            ) : imageURL ? (
              <Image
                width={960}
                height={540}
                unoptimized
                src={imageURL}
                alt={t("Video caption at {value0}: {value1}", {
                  value0: timestamp(image?.offsetMs ?? 0),
                  value1: observation?.caption ?? "",
                })}
                className="max-h-[60dvh] w-full rounded-xl object-contain"
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {t("Loading evidence image…")}
              </p>
            )}
          </Dialog.Body>
          <Dialog.Footer className="flex-wrap [&>button]:h-auto [&>button]:min-h-11 [&>button]:min-w-0 [&>button]:basis-48 [&>button]:py-3 [&>button]:break-words [&>button]:whitespace-normal">
            {imageSpeaker?.suggestedName && imageSuggestion ? (
              <>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await onResolveSuggestion(imageSpeaker, false))
                      onSelectImage(null)
                  }}
                >
                  {t("Dismiss suggestion")}
                </Button>
                <Button
                  onClick={async () => {
                    if (await onResolveSuggestion(imageSpeaker, true))
                      onSelectImage(null)
                  }}
                >
                  {t("Accept name {value0}", {
                    value0: imageSpeaker.suggestedName,
                  })}
                </Button>
              </>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                if (image) onSeek(image.offsetMs)
                onSelectImage(null)
                setOpen(false)
              }}
            >
              {t("Go to this moment in video")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  )
}
