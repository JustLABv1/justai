"use client"

import { Check, Copy, LoaderCircle, Play, Radio } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  LiveTranscriptionOrbit,
  type LiveTranscriptionSnapshot,
} from "@/components/live-transcription-orbit"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api, socketURL } from "@/lib/api"
import {
  mergeTranscriptionSegments,
  upsertTranscriptionSource,
} from "@/lib/transcription"
import type {
  Endpoint,
  TranscriptionJoinRequest,
  TranscriptionRecording,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSource,
  User,
} from "@/lib/types"

type Snapshot = LiveTranscriptionSnapshot

type SocketEvent = {
  type: string
  data?: Record<string, unknown>
}

export function LiveTranscriptionView({
  sessionId,
  sessions,
  endpoints,
  user,
  onSessionCreated,
  onSessionsChanged,
  createSessionRequested = false,
  onCreateSessionRequestHandled,
}: {
  sessionId: string | null
  sessions: TranscriptionSession[]
  endpoints: Endpoint[]
  user: User
  onSessionCreated: (session: TranscriptionSession) => void
  onSessionsChanged: () => void
  createSessionRequested?: boolean
  onCreateSessionRequestHandled?: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [partial, setPartial] = useState("")
  const [partialSourceId, setPartialSourceId] = useState<string | null>(null)
  const [partialSpeakerId, setPartialSpeakerId] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [joinRequests, setJoinRequests] = useState<TranscriptionJoinRequest[]>(
    []
  )
  const [title, setTitle] = useState("Room session")
  const [language, setLanguage] = useState("auto")
  const [recordAudio, setRecordAudio] = useState(false)
  const [selectedEndpoint, setSelectedEndpoint] = useState("")
  const [selectedDiarizationEndpoint, setSelectedDiarizationEndpoint] =
    useState("")
  const [starting, setStarting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [deviceLabel, setDeviceLabel] = useState("")
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  const viewerSocketRef = useRef<WebSocket | null>(null)
  const captureSocketRef = useRef<WebSocket | null>(null)
  const connectViewerRef = useRef<
    (id: string, reconnect?: boolean) => Promise<void>
  >(() => Promise.resolve())
  const viewerAttemptRef = useRef(0)
  const viewerReconnectTimerRef = useRef<number | null>(null)
  const viewerReconnectAttemptsRef = useRef(0)
  const captureAttemptRef = useRef(0)
  const captureSourceIdRef = useRef<string | null>(null)
  const sessionLoadRef = useRef(0)
  const pendingFinalSegmentsRef = useRef(
    new Map<string, TranscriptionSegment>()
  )
  const pendingSpeakerUpdatesRef = useRef(new Map<string, string>())
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const recordingUploadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const completingRecordingsRef = useRef(new Set<string>())
  const levelTimerRef = useRef<number | null>(null)
  const transcriptionEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled && endpointSupportsTranscription(endpoint)
      ),
    [endpoints]
  )
  const diarizationEndpoints = useMemo(
    () =>
      endpoints.filter((endpoint) =>
        endpointSupportsCapability(endpoint, "diarization")
      ),
    [endpoints]
  )

  const effectiveSelectedEndpoint =
    selectedEndpoint ||
    transcriptionEndpoints.find((endpoint) => endpoint.isDefault)?.id ||
    transcriptionEndpoints[0]?.id ||
    ""
  const selectedDeviceName =
    devices.find((device) => device.deviceId === deviceLabel)?.label ||
    "System default"

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const next = await navigator.mediaDevices.enumerateDevices()
      setDevices(next.filter((device) => device.kind === "audioinput"))
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Audio input devices could not be listed."
      )
    }
  }, [])

  const completeRecording = useCallback(
    (recordingId: string, uploads: Promise<void>) => {
      if (completingRecordingsRef.current.has(recordingId)) return
      completingRecordingsRef.current.add(recordingId)
      void uploads
        .then(() =>
          api.post(`/api/v1/transcription/recordings/${recordingId}/complete`)
        )
        .catch((caught) =>
          setError(
            caught instanceof Error
              ? caught.message
              : "Audio upload could not be completed."
          )
        )
        .finally(() => {
          completingRecordingsRef.current.delete(recordingId)
          if (recordingIdRef.current === recordingId)
            recordingIdRef.current = null
        })
    },
    []
  )

  const closeCapture = useCallback(() => {
    captureAttemptRef.current += 1
    try {
      captureSocketRef.current?.send(
        JSON.stringify({ type: "transcription.stop" })
      )
    } catch {
      // The socket may already be closed.
    }
    captureSocketRef.current?.close()
    captureSocketRef.current = null
    captureSourceIdRef.current = null
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
    else if (recordingIdRef.current)
      completeRecording(recordingIdRef.current, recordingUploadQueueRef.current)
    mediaRecorderRef.current = null
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    workletRef.current?.disconnect()
    workletRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    audioStreamRef.current?.getTracks().forEach((track) => track.stop())
    audioStreamRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    setCapturing(false)
    setLevel(0)
  }, [completeRecording])

  const closeViewer = useCallback((resetReconnect = true) => {
    viewerAttemptRef.current += 1
    if (viewerReconnectTimerRef.current !== null) {
      window.clearTimeout(viewerReconnectTimerRef.current)
      viewerReconnectTimerRef.current = null
    }
    if (resetReconnect) viewerReconnectAttemptsRef.current = 0
    viewerSocketRef.current?.close()
    viewerSocketRef.current = null
  }, [])

  const closeSockets = useCallback(() => {
    closeCapture()
    closeViewer()
  }, [closeCapture, closeViewer])

  useEffect(() => () => closeSockets(), [closeSockets])

  const applySnapshot = useCallback((next: Snapshot) => {
    setSnapshot((current) => {
      const sameSession = current?.session.id === next.session.id
      const pendingSegments = [
        ...pendingFinalSegmentsRef.current.values(),
      ].filter((segment) => segment.sessionId === next.session.id)
      const mergedSegments = mergeTranscriptionSegments(
        sameSession ? current?.segments || [] : [],
        next.segments,
        pendingSegments
      ).map((segment) => {
        const speakerId = pendingSpeakerUpdatesRef.current.get(segment.id)
        return speakerId ? { ...segment, speakerId } : segment
      })
      for (const segment of pendingSegments) {
        pendingFinalSegmentsRef.current.delete(segment.id)
      }
      for (const segment of mergedSegments) {
        if (pendingSpeakerUpdatesRef.current.has(segment.id)) {
          pendingSpeakerUpdatesRef.current.delete(segment.id)
        }
      }
      if (!sameSession) {
        return { ...next, segments: mergedSegments }
      }
      return {
        ...next,
        segments: mergedSegments,
        sources: next.sources.map((source) => {
          const existing = current.sources.find((item) => item.id === source.id)
          return existing
            ? { ...source, signalLevel: existing.signalLevel }
            : source
        }),
      }
    })
  }, [])

  const handleSocketEvent = useCallback(
    (event: SocketEvent) => {
      const data = event.data ?? {}
      if (event.type === "transcription.snapshot") {
        applySnapshot(data as unknown as Snapshot)
        return
      }
      if (event.type === "transcription.session") {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                session: {
                  ...current.session,
                  ...(data as Partial<TranscriptionSession>),
                },
              }
            : current
        )
        onSessionsChanged()
        return
      }
      if (event.type === "transcription.join-request") {
        const requestId = String(data.requestId ?? "")
        const status = String(data.status ?? "pending")
        if (
          !requestId ||
          !["pending", "approved", "denied", "expired"].includes(status)
        )
          return
        setJoinRequests((current) => {
          const nextStatus = status as TranscriptionJoinRequest["status"]
          const index = current.findIndex((request) => request.id === requestId)
          if (index < 0 && nextStatus !== "pending") return current
          if (index < 0) {
            return [
              {
                id: requestId,
                sourceName: String(data.sourceName ?? "Room microphone"),
                deviceLabel: String(data.deviceLabel ?? ""),
                status: nextStatus,
                sourceId: null,
                expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                createdAt: new Date().toISOString(),
              },
              ...current,
            ]
          }
          return current.map((request, requestIndex) =>
            requestIndex === index
              ? { ...request, status: nextStatus }
              : request
          )
        })
        return
      }
      if (event.type === "transcription.source") {
		const sourceId = String(data.sourceId ?? "")
		const sourceData = data.source as Partial<TranscriptionSource> | undefined
		const status = String(
		  data.status ?? sourceData?.status ?? "connected"
		) as TranscriptionSource["status"]
		if (!sourceId) return
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: upsertTranscriptionSource(
                  current.sources,
                  { ...sourceData, id: sourceId },
                  status
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.source.level") {
		const sourceId = String(data.sourceId ?? "")
        const nextLevel = Number(data.level ?? 0)
		if (captureSourceIdRef.current === sourceId) setLevel(nextLevel)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: current.sources.map((source) =>
                  source.id === sourceId
                    ? { ...source, signalLevel: nextLevel }
                    : source
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.partial") {
        setPartial(String(data.text ?? ""))
        setPartialSourceId(data.sourceId ? String(data.sourceId) : null)
        setPartialSpeakerId(data.speakerId ? String(data.speakerId) : null)
        return
      }
      if (event.type === "transcription.final") {
        const segment = data.segment as TranscriptionSegment | undefined
        if (!segment) return
        setPartial("")
        setPartialSourceId(null)
        setPartialSpeakerId(null)
        pendingFinalSegmentsRef.current.set(segment.id, segment)
        setSnapshot((current) => {
          if (
            !current ||
            (segment.sessionId && current.session.id !== segment.sessionId)
          )
            return current
          pendingFinalSegmentsRef.current.delete(segment.id)
          return {
            ...current,
            segments: mergeTranscriptionSegments(current.segments, [segment]),
          }
        })
        onSessionsChanged()
        return
      }
      if (event.type === "transcription.segment.updated") {
        const segmentId = String(data.segmentId ?? "")
        const speakerId = String(data.speakerId ?? "")
        if (!segmentId || !speakerId) return
        pendingSpeakerUpdatesRef.current.set(segmentId, speakerId)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                segments: current.segments.map((segment) =>
                  segment.id === segmentId ? { ...segment, speakerId } : segment
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.speaker") {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                speakers: current.speakers.map((speaker) =>
                  speaker.id === data.speakerId
                    ? {
                        ...speaker,
                        displayName: String(data.displayName ?? ""),
                      }
                    : speaker
                ),
              }
            : current
        )
        return
      }
      if (
        event.type === "error" ||
        event.type === "transcription.diarization-error"
      ) {
        setError(
          String(data.message ?? "The transcription service reported an error.")
        )
      }
    },
    [applySnapshot, onSessionsChanged]
  )

  const connectViewer = useCallback(
    async (id: string, reconnect = false) => {
      if (!reconnect) viewerReconnectAttemptsRef.current = 0
      closeViewer(!reconnect)
      const attempt = viewerAttemptRef.current
      const ticketResponse = await api.post<{ ticket: string }>(
        "/api/v1/ws/tickets",
        { kind: "transcription-viewer", sessionId: id }
      )
      if (viewerAttemptRef.current !== attempt) return
      const socket = new WebSocket(
        socketURL("/api/v1/ws/transcription", ticketResponse.ticket)
      )
      viewerSocketRef.current = socket
      let opened = false
      let openTimer: number | null = null
      socket.onmessage = (message) => {
        if (viewerAttemptRef.current !== attempt) return
        try {
          handleSocketEvent(JSON.parse(message.data) as SocketEvent)
        } catch {
          setError("Received an invalid event from the transcription server.")
        }
      }
      socket.onerror = () => {
        if (viewerAttemptRef.current === attempt) {
          setError(
            "The live transcription connection could not be established."
          )
        }
      }
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
          opened = true
          if (openTimer !== null) window.clearTimeout(openTimer)
          setError("")
          resolve()
        }
        socket.onclose = () => {
          if (openTimer !== null) window.clearTimeout(openTimer)
          if (viewerSocketRef.current === socket) viewerSocketRef.current = null
          if (viewerAttemptRef.current !== attempt) {
            resolve()
            return
          }
          if (opened) {
            setError("The live transcription connection dropped; reconnecting…")
            const retry = viewerReconnectAttemptsRef.current
            if (retry < 5) {
              viewerReconnectAttemptsRef.current = retry + 1
              viewerReconnectTimerRef.current = window.setTimeout(
                () => {
                  viewerReconnectTimerRef.current = null
                  if (viewerAttemptRef.current === attempt) {
                    void connectViewerRef
                      .current(id, true)
                      .catch(() => undefined)
                  }
                },
                Math.min(15_000, 1000 * 2 ** retry)
              )
            }
          }
          reject(new Error("The live transcription connection closed."))
        }
        openTimer = window.setTimeout(() => {
          socket.close()
          reject(
            new Error("The live transcription socket took too long to connect.")
          )
        }, 15_000)
      })
      if (
        viewerAttemptRef.current !== attempt ||
        socket.readyState !== WebSocket.OPEN
      ) {
        socket.close()
        return
      }
      socket.send(JSON.stringify({ type: "viewer.ready" }))
    },
    [closeViewer, handleSocketEvent]
  )

  useEffect(() => {
    connectViewerRef.current = connectViewer
  }, [connectViewer])

  const downsample = (
    input: Float32Array,
    sourceRate: number,
    targetRate: number
  ) => {
    if (sourceRate === targetRate) return input
    const ratio = sourceRate / targetRate
    const output = new Float32Array(Math.round(input.length / ratio))
    for (let index = 0; index < output.length; index += 1) {
      const start = Math.floor(index * ratio)
      const end = Math.min(input.length, Math.ceil((index + 1) * ratio))
      let total = 0
      for (let inputIndex = start; inputIndex < end; inputIndex += 1)
        total += input[inputIndex]
      output[index] = end > start ? total / (end - start) : 0
    }
    return output
  }

  const encodePCM16 = (input: Float32Array) => {
    const buffer = new ArrayBuffer(input.length * 2)
    const view = new DataView(buffer)
    input.forEach((value, index) => {
      const sample = Math.max(-1, Math.min(1, value))
      view.setInt16(
        index * 2,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      )
    })
    return buffer
  }

  const calculateRMS = (input: Float32Array) => {
    if (input.length === 0) return 0
    let total = 0
    input.forEach((value) => {
      total += value * value
    })
    return Math.sqrt(total / input.length)
  }

  const beginAudio = useCallback(
    async (
      socket: WebSocket,
      session: TranscriptionSession,
      source: TranscriptionSource
    ) => {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("This browser does not support microphone capture.")
      const constraints: MediaStreamConstraints = {
        audio: {
          ...(deviceLabel ? { deviceId: { exact: deviceLabel } } : {}),
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      audioStreamRef.current = stream
      void refreshDevices()
      const context = new AudioContext()
      audioContextRef.current = context
      await context.audioWorklet.addModule("/audio-worklet.js")
      const sourceNode = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      const worklet = new AudioWorkletNode(context, "justai-pcm-processor")
      const silentGain = context.createGain()
      silentGain.gain.value = 0
      sourceNode.connect(analyser)
      sourceNode.connect(worklet)
      worklet.connect(silentGain)
      silentGain.connect(context.destination)
      analyserRef.current = analyser
      workletRef.current = worklet
      let sequence = 0
      let voiceUntil = 0
      const voiceThreshold = 0.01
      const voiceHangoverMs = 650
      worklet.port.onmessage = (message: MessageEvent<Float32Array>) => {
        if (socket.readyState !== WebSocket.OPEN) return
        const samples = downsample(message.data, context.sampleRate, 16000)
        const rms = calculateRMS(samples)
        const now = performance.now()
        if (rms >= voiceThreshold) voiceUntil = now + voiceHangoverMs
        if (now > voiceUntil) return
        const pcm = encodePCM16(samples)
        const frame = new ArrayBuffer(17 + pcm.byteLength)
        const view = new DataView(frame)
        view.setUint8(0, 1)
        view.setBigUint64(1, BigInt(Date.now()), true)
        view.setUint32(9, sequence, true)
        view.setUint32(13, 16000, true)
        new Uint8Array(frame, 17).set(new Uint8Array(pcm))
        sequence += 1
        socket.send(frame)
      }
      const levelBuffer = new Uint8Array(analyser.fftSize)
      const levelTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(levelBuffer)
        let total = 0
        levelBuffer.forEach((value) => {
          const normalized = (value - 128) / 128
          total += normalized * normalized
        })
        const nextLevel = Math.min(
          1,
          Math.sqrt(total / levelBuffer.length) * 3.2
        )
        setLevel(nextLevel)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "source.level", level: nextLevel })
          )
      }, 100)
      levelTimerRef.current = levelTimer
      void context.resume()
      if (session.recordAudio) {
        const recording = await api.post<{ recording: TranscriptionRecording }>(
          "/api/v1/transcription/recordings/start",
          {
            sessionId: session.id,
            sourceId: source.id,
            mimeType: "audio/webm;codecs=opus",
          }
        )
        const recordingId = recording.recording.id
        recordingIdRef.current = recordingId
        recordingUploadQueueRef.current = Promise.resolve()
        const recorder = new MediaRecorder(stream, {
          mimeType: "audio/webm;codecs=opus",
        })
        let part = 0
        let uploads = Promise.resolve()
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return
          const currentPart = part
          part += 1
          uploads = uploads.then(async () => {
            await api.binary(
              `/api/v1/transcription/recordings/${recordingId}/parts/${currentPart}`,
              event.data
            )
          })
          recordingUploadQueueRef.current = uploads
        }
        recorder.onstop = () => completeRecording(recordingId, uploads)
        recorder.start(5000)
        mediaRecorderRef.current = recorder
      }
      setCapturing(true)
    },
    [completeRecording, deviceLabel, refreshDevices]
  )

  const startCapture = useCallback(
    async (session: TranscriptionSession, source: TranscriptionSource) => {
      closeCapture()
      const attempt = captureAttemptRef.current
      const ticketResponse = await api.post<{ ticket: string }>(
        "/api/v1/ws/tickets",
        {
          kind: "transcription-capture",
          sessionId: session.id,
          sourceId: source.id,
        }
      )
      if (captureAttemptRef.current !== attempt) return
      captureSourceIdRef.current = source.id
      const socket = new WebSocket(
        socketURL("/api/v1/ws/transcription", ticketResponse.ticket)
      )
      captureSocketRef.current = socket
      socket.onmessage = (message) => {
        if (captureAttemptRef.current !== attempt) return
        try {
          handleSocketEvent(JSON.parse(message.data) as SocketEvent)
        } catch {
          setError(
            "Received an invalid capture event from the transcription server."
          )
        }
      }
      socket.onerror = () => {
        if (captureAttemptRef.current === attempt) {
          setError("The microphone connection could not be established.")
        }
      }
      let socketOpened = false
      let rejectOpen: ((reason?: unknown) => void) | null = null
      let openTimer: number | null = null
      await new Promise<void>((resolve, reject) => {
        rejectOpen = reject
        socket.onopen = () => {
          socketOpened = true
          rejectOpen = null
          if (openTimer !== null) window.clearTimeout(openTimer)
          resolve()
        }
        socket.onclose = () => {
          if (openTimer !== null) window.clearTimeout(openTimer)
          if (captureSocketRef.current === socket)
            captureSocketRef.current = null
          if (captureAttemptRef.current !== attempt) {
            resolve()
            return
          }
          if (!socketOpened) {
            rejectOpen?.(
              new Error("The microphone connection closed before connecting.")
            )
            return
          }
          reject(new Error("The microphone connection closed."))
        }
        openTimer = window.setTimeout(() => {
          socket.close()
          reject(new Error("The microphone socket took too long to connect."))
        }, 15_000)
      })
      if (
        captureAttemptRef.current !== attempt ||
        socket.readyState !== WebSocket.OPEN
      ) {
        socket.close()
        return
      }
      socket.onclose = () => {
        if (captureAttemptRef.current !== attempt) return
        closeCapture()
        setError(
          "The microphone connection dropped. Restart the microphone to reconnect."
        )
      }
      socket.send(
        JSON.stringify({
          type: "transcription.start",
          sessionId: session.id,
          sourceId: source.id,
        })
      )
      try {
        await beginAudio(socket, session, source)
      } catch (caught) {
        if (captureAttemptRef.current === attempt) closeCapture()
        throw caught
      }
    },
    [beginAudio, closeCapture, handleSocketEvent]
  )

  const loadSession = useCallback(
    async (id: string) => {
      const requestId = sessionLoadRef.current + 1
      sessionLoadRef.current = requestId
      const isCurrentRequest = () => sessionLoadRef.current === requestId
      setLoading(true)
      setError("")
      try {
        const next = await api.get<Snapshot>(
          `/api/v1/transcription/sessions/${id}`
        )
        if (!isCurrentRequest()) return
        applySnapshot(next)
        setCreateOpen(false)
        await connectViewer(id)
        if (!isCurrentRequest()) return
        const requests = await api.get<{
          requests: TranscriptionJoinRequest[]
        }>(`/api/v1/transcription/sessions/${id}/join-requests`)
        if (!isCurrentRequest()) return
        setJoinRequests(requests.requests)
      } catch (caught) {
        if (!isCurrentRequest()) return
        setError(
          caught instanceof Error
            ? caught.message
            : "The transcription session could not be loaded."
        )
      } finally {
        if (isCurrentRequest()) setLoading(false)
      }
    },
    [applySnapshot, connectViewer]
  )

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      queueMicrotask(() => {
        if (cancelled) return
        closeSockets()
        pendingFinalSegmentsRef.current.clear()
        pendingSpeakerUpdatesRef.current.clear()
        setSnapshot(null)
        setPartial("")
        setPartialSourceId(null)
        setPartialSpeakerId(null)
        setCreateOpen(false)
      })
      return () => {
        cancelled = true
      }
    }
    queueMicrotask(() => {
      if (!cancelled) void loadSession(sessionId)
    })
    return () => {
      cancelled = true
      sessionLoadRef.current += 1
      closeSockets()
    }
  }, [closeSockets, loadSession, sessionId])

  useEffect(() => {
    if (!createSessionRequested || sessionId) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setCreateOpen(true)
      void refreshDevices()
      onCreateSessionRequestHandled?.()
    })
    return () => {
      cancelled = true
    }
  }, [
    createSessionRequested,
    onCreateSessionRequestHandled,
    refreshDevices,
    sessionId,
  ])

  const createSession = async () => {
    setStarting(true)
    setError("")
    try {
      const result = await api.post<{
        session: TranscriptionSession
        joinCode: string
        expiresAt: string
      }>("/api/v1/transcription/sessions", {
        title,
        language,
        recordAudio,
        transcriptionEndpointId: effectiveSelectedEndpoint,
        diarizationEndpointId: selectedDiarizationEndpoint || undefined,
      })
      const createdSession = {
        ...result.session,
        joinCode: result.joinCode,
        joinCodeExpiresAt: result.expiresAt,
      }
      const source = await api.post<{ source: TranscriptionSource }>(
        `/api/v1/transcription/sessions/${result.session.id}/sources`,
        {
          name: "This laptop",
          kind: "browser",
          deviceLabel: selectedDeviceName,
        }
      )
      onSessionCreated(createdSession)
      setCreateOpen(false)
      const nextSnapshot: Snapshot = {
        session: createdSession,
        sources: [source.source],
        speakers: [],
        segments: [],
        recordings: [],
      }
      applySnapshot(nextSnapshot)
      await startCapture(result.session, source.source)
      await api.post(
        `/api/v1/transcription/sessions/${result.session.id}/resume`
      )
      onSessionsChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcription session could not be started."
      )
    } finally {
      setStarting(false)
    }
  }

  const ensureCapture = async () => {
    if (!snapshot || capturing) return
    try {
      let source = snapshot.sources.find((item) => item.kind === "browser")
      if (!source) {
        const result = await api.post<{ source: TranscriptionSource }>(
          `/api/v1/transcription/sessions/${snapshot.session.id}/sources`,
          {
            name: "This laptop",
            kind: "browser",
            deviceLabel: selectedDeviceName,
          }
        )
        source = result.source
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: [...current.sources, source as TranscriptionSource],
              }
            : current
        )
      }
      await startCapture(snapshot.session, source)
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/resume`
      )
      setSnapshot((current) =>
        current
          ? { ...current, session: { ...current.session, status: "live" } }
          : current
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The microphone could not be started."
      )
    }
  }

  const pauseOrResume = async () => {
    if (!snapshot) return
    try {
      const action = snapshot.session.status === "paused" ? "resume" : "pause"
      if (action === "pause") closeCapture()
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/${action}`
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                status: action === "pause" ? "paused" : "live",
              },
            }
          : current
      )
      if (action === "resume") await ensureCapture()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcription session could not be updated."
      )
    }
  }

  const stopSession = async () => {
    if (!snapshot) return
    try {
      closeCapture()
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/stop`
      )
      onSessionsChanged()
      await loadSession(snapshot.session.id)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcription session could not be stopped."
      )
    }
  }

  const refreshJoinRequests = async () => {
    if (!snapshot) return
    try {
      const result = await api.get<{ requests: TranscriptionJoinRequest[] }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/join-requests`
      )
      setJoinRequests(result.requests)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Join requests could not be refreshed."
      )
    }
  }

  const setJoinRequest = async (
    request: TranscriptionJoinRequest,
    status: "approve" | "deny"
  ) => {
    if (!snapshot) return
    try {
      await api.post(
        `/api/v1/transcription/join-requests/${request.id}/${status}`
      )
      await refreshJoinRequests()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The join request could not be updated."
      )
    }
  }

  const renameSpeaker = async (speakerId: string, displayName: string) => {
    if (!snapshot) return
    const trimmedName = displayName.trim()
    if (!trimmedName) return
    try {
      await api.patch(
        `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/${speakerId}`,
        { displayName: trimmedName }
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              speakers: current.speakers.map((item) =>
                item.id === speakerId
                  ? { ...item, displayName: trimmedName }
                  : item
              ),
            }
          : current
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The speaker name could not be saved."
      )
    }
  }

  const copyJoinCode = async () => {
    if (!snapshot?.session.joinCode) return
    try {
      await navigator.clipboard.writeText(snapshot.session.joinCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The room code could not be copied."
      )
    }
  }

  const rotateJoinCode = async () => {
    if (!snapshot) return
    try {
      const result = await api.post<{ joinCode: string; expiresAt: string }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/join-code`
      )
      setSnapshot((current) =>
        current
          ? {
              ...current,
              session: {
                ...current.session,
                joinCode: result.joinCode,
                joinCodeExpiresAt: result.expiresAt,
              },
            }
          : current
      )
      setShareOpen(true)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "A room code could not be generated."
      )
    }
  }

  return (
    <div className="flex min-h-[calc(100svh-2rem)] w-full min-w-0 flex-1 flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Live transcription needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        <Empty className="min-h-[calc(100svh-8rem)] border-0">
          <EmptyHeader>
            <div className="mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Radio aria-hidden="true" />
            </div>
            <EmptyTitle>Listen to the room</EmptyTitle>
            <EmptyDescription>
              {sessions.length > 0
                ? "Select a session from the sidebar, or start a new room."
                : "Start a named session and connect microphones from other devices with a short approval code."}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            onClick={() => {
              setCreateOpen(true)
              void refreshDevices()
            }}
          >
            <Play data-icon="inline-start" />
            New live session
          </Button>
        </Empty>
      ) : (
        <LiveTranscriptionOrbit
          capturing={capturing}
          joinRequests={joinRequests}
          level={level}
          loading={loading}
          onPauseOrResume={pauseOrResume}
          onRefreshJoinRequests={refreshJoinRequests}
          onRenameSpeaker={renameSpeaker}
          onSetJoinRequest={setJoinRequest}
          onShare={() =>
            void (snapshot.session.joinCode
              ? setShareOpen(true)
              : rotateJoinCode())
          }
          onStartCapture={ensureCapture}
          onStopSession={stopSession}
          partial={partial}
          partialSourceId={partialSourceId}
          partialSpeakerId={partialSpeakerId}
          snapshot={snapshot}
          user={user}
        />
      )}

      <Dialog
        open={createOpen && !sessionId}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (open) void refreshDevices()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New live session</DialogTitle>
            <DialogDescription>
              Choose the endpoint and whether JustAI should retain source audio.
              Recording is off by default.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="session-title">Session name</FieldLabel>
              <Input
                id="session-title"
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="session-language">Language</FieldLabel>
              <Input
                id="session-language"
                onChange={(event) => setLanguage(event.target.value || "auto")}
                placeholder="auto"
                value={language}
              />
              <FieldDescription>
                Use a BCP-47 code such as de or en, or auto.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Transcription endpoint</FieldLabel>
              <Select
                onValueChange={(value) => setSelectedEndpoint(value ?? "")}
                value={effectiveSelectedEndpoint}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a transcription endpoint" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Transcription providers</SelectLabel>
                    {transcriptionEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} · {endpoint.providerType} ·{" "}
                        {transcriptionModeLabel(endpoint)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Native providers use Realtime WebSockets. Whisper-style gateways
                use rolling HTTP chunks.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Microphone</FieldLabel>
              <Select
                onValueChange={(value) =>
                  setDeviceLabel(value === "default" ? "" : (value ?? ""))
                }
                value={deviceLabel || "default"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="System default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Audio inputs</SelectLabel>
                    <SelectItem value="default">System default</SelectItem>
                    {devices.map((device, index) => (
                      <SelectItem
                        key={device.deviceId || `audio-input-${index}`}
                        value={device.deviceId}
                      >
                        {device.label || `Microphone ${index + 1}`}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Select which microphone this host browser should stream.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Diarization endpoint</FieldLabel>
              <Select
                onValueChange={(value) =>
                  setSelectedDiarizationEndpoint(
                    value === "none" ? "" : (value ?? "")
                  )
                }
                value={selectedDiarizationEndpoint || "none"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Optional speaker separation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Speaker providers</SelectLabel>
                    <SelectItem value="none">No speaker separation</SelectItem>
                    {diarizationEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} · {endpoint.providerType}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Labels arrive after a short rolling audio window and remain
                anonymous.
              </FieldDescription>
            </Field>
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div>
                <p className="text-sm font-medium">Record source audio</p>
                <p className="text-xs text-muted-foreground">
                  Encrypted, source-separated tracks. Default retention: 30
                  days.
                </p>
              </div>
              <Switch
                aria-label="Record source audio"
                checked={recordAudio}
                onCheckedChange={setRecordAudio}
              />
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={() => setCreateOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={starting || !effectiveSelectedEndpoint}
              onClick={() => void createSession()}
            >
              {starting ? (
                <>
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />{" "}
                  Starting…
                </>
              ) : (
                <>
                  <Play data-icon="inline-start" /> Start session
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Join this room</DialogTitle>
            <DialogDescription>
              Open /transcription/join on another device. The microphone
              connects only after you approve it here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between rounded-xl border bg-muted/30 p-4">
            <span className="font-mono text-2xl font-semibold tracking-[0.32em]">
              {snapshot?.session.joinCode ?? "--------"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void rotateJoinCode()}
                size="sm"
                variant="outline"
              >
                New code
              </Button>
              {snapshot?.session.joinCode && (
                <Button
                  aria-label="Copy room code"
                  onClick={() => void copyJoinCode()}
                  size="icon-sm"
                  variant="outline"
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShareOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function transcriptionModeLabel(endpoint: Endpoint) {
  const realtime = endpointSupportsCapability(
    endpoint,
    "realtime-transcription"
  )
  const whisperGateway =
    endpoint.providerType === "openai-compatible" &&
    /whisper/i.test(endpoint.transcriptionModel ?? "")
  const chunked = Boolean(
    endpoint.capabilities["chunked-transcription"] ||
    (endpoint.capabilities.transcription && (!realtime || whisperGateway))
  )
  if (chunked) return "HTTP chunks"
  return "Realtime"
}

function endpointSupportsTranscription(endpoint: Endpoint) {
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, "transcription")) {
    return Boolean(capabilities.transcription)
  }
  if (capabilities["chunked-transcription"]) return true
  if (capabilities["realtime-transcription"]) return true
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "chunked-transcription")
  ) {
    return false
  }
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "realtime-transcription")
  ) {
    return false
  }
  return (
    endpoint.providerType === "openai" || endpoint.providerType === "gemini"
  )
}

function endpointSupportsCapability(endpoint: Endpoint, capability: string) {
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, capability)) {
    return Boolean(capabilities[capability])
  }
  return (
    (capability === "realtime-transcription" || capability === "diarization") &&
    (endpoint.providerType === "openai" || endpoint.providerType === "gemini")
  )
}
