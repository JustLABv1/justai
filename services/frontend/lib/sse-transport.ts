import { resolveAPIURL } from "@/lib/api"

type MessageHandler = ((event: MessageEvent<string>) => void) | null
type EventHandler = ((event: Event) => void) | null

export class SSETransportError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "stream_transport_error"
  ) {
    super(message)
    this.name = "SSETransportError"
  }
}

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

export class SSETransport {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSED = CLOSED

  readyState = CONNECTING
  onopen: EventHandler = null
  onmessage: MessageHandler = null
  onerror: EventHandler = null
  onclose: EventHandler = null
  ontransporterror: ((error: SSETransportError) => void) | null = null

  private source: EventSource | null = null
  private readonly path: string
  private streamId = ""
  private uploadToken = ""
  private pendingJSON: string[] = []
  private audioFrames: Uint8Array[] = []
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private audioUpload: Promise<void> = Promise.resolve()
  private controlUpload: Promise<void> = Promise.resolve()
  private controlSequence = 0
  private queuedAudioBytes = 0
  private droppedAudioFrames = 0
  private resumeToken = ""
  private lastEventId = "0"
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closeListeners = new Set<EventHandler>()
  private audioAbort = new AbortController()

  constructor(path: string) {
    this.path = resolveAPIURL(path)
    this.openSource(this.path)
  }

  private openSource(path: string) {
    const source = new EventSource(path, {
      withCredentials: true,
    })
    this.source = source
    source.onmessage = (event) => {
      if (event.lastEventId) this.lastEventId = event.lastEventId
      let value: {
        type?: string
        data?: { streamId?: string; uploadToken?: string; resumeToken?: string }
      }
      try {
        value = JSON.parse(event.data) as typeof value
      } catch {
        return
      }
      if (value.type === "transport.ready" || value.type === "transport.resumed") {
        this.streamId = String(value.data?.streamId ?? "")
        this.uploadToken = String(value.data?.uploadToken ?? "")
        this.resumeToken = String(value.data?.resumeToken ?? this.resumeToken)
        if (!this.streamId || !this.uploadToken) return
        this.readyState = OPEN
        this.reconnectAttempts = 0
        if (value.type === "transport.ready") this.onopen?.(new Event("open"))
        const queued = this.pendingJSON
        this.pendingJSON = []
        queued.forEach((payload) => this.send(payload))
        if (this.audioFrames.length > 0 && !this.audioTimer) {
          this.audioTimer = setTimeout(() => this.flushAudio(), 0)
        }
        return
      }
      this.onmessage?.(event)
    }
    source.onerror = () => {
      if (this.readyState === CLOSED) return
      source.close()
      if (this.resumeToken && this.reconnectAttempts < 5) {
        this.readyState = CONNECTING
        const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempts)
        this.reconnectAttempts += 1
        this.reportError(
          new SSETransportError(
            "The realtime stream was interrupted; reconnecting.",
            0,
            "stream_reconnecting"
          ),
          false
        )
        this.reconnectTimer = setTimeout(() => {
          const resumeURL = new URL(this.path)
          resumeURL.search = ""
          resumeURL.searchParams.set("resume", this.resumeToken)
          resumeURL.searchParams.set("lastEventId", this.lastEventId)
          this.openSource(resumeURL.toString())
        }, delay + Math.random() * 250)
        return
      }
      this.onerror?.(new Event("error"))
      this.close()
    }
  }

  send(value: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState === CLOSED) return
    if (typeof value === "string") {
      if (!this.streamId) {
        this.pendingJSON.push(value)
        return
      }
      let envelope: Record<string, unknown>
      try {
        envelope = JSON.parse(value) as Record<string, unknown>
      } catch {
        this.reportError(new SSETransportError("Invalid stream control JSON."))
        return
      }
      envelope.transportSequence = ++this.controlSequence
      const payload = JSON.stringify(envelope)
      this.controlUpload = this.controlUpload
        .then(() => this.postWithRetry("events", payload, "application/json", 2))
        .catch((caught) => this.reportError(this.toError(caught)))
      return
    }
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const frame = new Uint8Array(bytes)
    const maxQueuedAudioBytes = 1024 * 1024
    if (this.queuedAudioBytes + frame.byteLength > maxQueuedAudioBytes) {
      this.droppedAudioFrames += 1
      if (this.droppedAudioFrames === 1 || this.droppedAudioFrames % 25 === 0) {
        this.reportError(
          new SSETransportError(
            "The audio connection is slower than realtime; buffered audio was dropped.",
            0,
            "audio_backpressure"
          )
        )
      }
      return
    }
    this.audioFrames.push(frame)
    this.queuedAudioBytes += frame.byteLength
    if (!this.audioTimer) {
      this.audioTimer = setTimeout(() => this.flushAudio(), 80)
    }
  }

  close(notify = true) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.source?.close()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.audioTimer) clearTimeout(this.audioTimer)
    this.audioTimer = null
    this.audioFrames = []
    this.queuedAudioBytes = 0
    this.audioAbort.abort()
    if (notify) {
      const event = new Event("close")
      this.onclose?.(event)
      this.closeListeners.forEach((listener) => listener?.(event))
    }
  }

  addEventListener(type: "close", listener: EventHandler) {
    if (type === "close") this.closeListeners.add(listener)
  }

  private flushAudio() {
    this.audioTimer = null
    if (!this.streamId || this.readyState !== OPEN) return
    const frames = this.audioFrames
    this.audioFrames = []
    if (frames.length === 0) return
    const frameBytes = frames.reduce((total, frame) => total + frame.byteLength, 0)
    const size = frames.reduce((total, frame) => total + 4 + frame.byteLength, 0)
    const body = new Uint8Array(size)
    const view = new DataView(body.buffer)
    let offset = 0
    for (const frame of frames) {
      view.setUint32(offset, frame.byteLength)
      offset += 4
      body.set(frame, offset)
      offset += frame.byteLength
    }
    this.audioUpload = this.audioUpload
      .then(() => this.post("audio", body, "application/octet-stream"))
      .catch((caught) => this.reportError(this.toError(caught)))
      .finally(() => {
        this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - frameBytes)
      })
  }

  private async postWithRetry(
    kind: "events" | "audio",
    body: BodyInit,
    contentType: string,
    retries: number
  ) {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.post(kind, body, contentType)
        return
      } catch (caught) {
        lastError = caught
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
        }
      }
    }
    throw lastError
  }

  private async post(
    kind: "events" | "audio",
    body: BodyInit,
    contentType: string
  ) {
    const response = await fetch(
      resolveAPIURL(`/api/v1/streams/${this.streamId}/${kind}`),
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": contentType,
          "X-Stream-Token": this.uploadToken,
        },
        body,
        keepalive: kind === "events",
        signal: kind === "audio" ? this.audioAbort.signal : undefined,
      }
    )
    if (!response.ok) {
      let message = `Stream upload failed (${response.status}).`
      try {
        const payload = (await response.json()) as {
          error?: string | { message?: string; code?: string }
        }
        const detail =
          typeof payload.error === "string"
            ? payload.error
            : payload.error?.message
        if (detail) message = detail
      } catch {
        // Keep the status-based fallback.
      }
      throw new SSETransportError(message, response.status)
    }
  }

  private toError(caught: unknown) {
    return caught instanceof SSETransportError
      ? caught
      : new SSETransportError(
          caught instanceof Error ? caught.message : "The stream upload failed."
        )
  }

  private reportError(error: SSETransportError, emitGeneric = true) {
    if (this.readyState === CLOSED) return
    this.ontransporterror?.(error)
    if (emitGeneric) this.onerror?.(new CustomEvent("error", { detail: error }))
  }
}
