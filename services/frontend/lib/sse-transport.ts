import { resolveAPIURL } from "@/lib/api"

type MessageHandler = ((event: MessageEvent<string>) => void) | null
type EventHandler = ((event: Event) => void) | null

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

  private readonly source: EventSource
  private streamId = ""
  private pendingJSON: string[] = []
  private audioFrames: Uint8Array[] = []
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private audioUpload: Promise<void> = Promise.resolve()
  private closeListeners = new Set<EventHandler>()

  constructor(path: string) {
    this.source = new EventSource(resolveAPIURL(path), {
      withCredentials: true,
    })
    this.source.onmessage = (event) => {
      let value: { type?: string; data?: { streamId?: string } }
      try {
        value = JSON.parse(event.data) as typeof value
      } catch {
        return
      }
      if (value.type === "transport.ready") {
        this.streamId = String(value.data?.streamId ?? "")
        if (!this.streamId) return
        this.readyState = OPEN
        this.onopen?.(new Event("open"))
        const queued = this.pendingJSON
        this.pendingJSON = []
        queued.forEach((payload) => this.send(payload))
        return
      }
      this.onmessage?.(event)
    }
    this.source.onerror = (event) => {
      if (this.readyState === CLOSED) return
      this.onerror?.(event)
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
      void this.post("events", value, "application/json")
      return
    }
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.audioFrames.push(new Uint8Array(bytes))
    if (!this.audioTimer) {
      this.audioTimer = setTimeout(() => this.flushAudio(), 80)
    }
  }

  close(notify = true) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.source.close()
    if (this.audioTimer) clearTimeout(this.audioTimer)
    this.audioTimer = null
    this.audioFrames = []
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
      .catch(() => undefined)
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
        headers: { "Content-Type": contentType },
        body,
        keepalive: kind === "events",
      }
    )
    if (!response.ok && this.readyState !== CLOSED) {
      this.onerror?.(new Event("error"))
    }
  }
}
