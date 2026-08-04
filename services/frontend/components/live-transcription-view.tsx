"use client"

import {
  Check,
  Copy,
  Headphones,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Share2,
  Square,
  Users,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ListeningOrb, type ListeningOrbState } from "@/components/listening-orb"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, socketURL } from "@/lib/api"
import type {
  Endpoint,
  TranscriptionJoinRequest,
  TranscriptionRecording,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSource,
  TranscriptionSpeaker,
  User,
} from "@/lib/types"

type Snapshot = {
  session: TranscriptionSession
  sources: TranscriptionSource[]
  speakers: TranscriptionSpeaker[]
  segments: TranscriptionSegment[]
  recordings: TranscriptionRecording[]
}

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
}: {
  sessionId: string | null
  sessions: TranscriptionSession[]
  endpoints: Endpoint[]
  user: User
  onSessionCreated: (session: TranscriptionSession) => void
  onSessionsChanged: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [partial, setPartial] = useState("")
  const [level, setLevel] = useState(0)
  const [createOpen, setCreateOpen] = useState(!sessionId)
  const [shareOpen, setShareOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [joinRequests, setJoinRequests] = useState<TranscriptionJoinRequest[]>([])
  const [title, setTitle] = useState("Room session")
  const [language, setLanguage] = useState("auto")
  const [recordAudio, setRecordAudio] = useState(false)
  const [selectedEndpoint, setSelectedEndpoint] = useState("")
  const [selectedDiarizationEndpoint, setSelectedDiarizationEndpoint] = useState("")
  const [starting, setStarting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [deviceLabel, setDeviceLabel] = useState("")
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  const viewerSocketRef = useRef<WebSocket | null>(null)
  const captureSocketRef = useRef<WebSocket | null>(null)
  const viewerAttemptRef = useRef(0)
  const captureAttemptRef = useRef(0)
  const sessionLoadRef = useRef(0)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const recordingUploadQueueRef = useRef<Promise<void>>(Promise.resolve())
  const completingRecordingsRef = useRef(new Set<string>())
  const levelTimerRef = useRef<number | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const realtimeEndpoints = useMemo(
    () => endpoints.filter((endpoint) => endpoint.capabilities["realtime-transcription"] || endpoint.providerType === "openai" || endpoint.providerType === "gemini"),
    [endpoints]
  )
  const diarizationEndpoints = useMemo(
    () => endpoints.filter((endpoint) => endpoint.capabilities.diarization || endpoint.providerType === "openai" || endpoint.providerType === "gemini"),
    [endpoints]
  )

  const effectiveSelectedEndpoint =
    selectedEndpoint ||
    realtimeEndpoints.find((endpoint) => endpoint.isDefault)?.id ||
    realtimeEndpoints[0]?.id ||
    ""
  const selectedDeviceName =
    devices.find((device) => device.deviceId === deviceLabel)?.label ||
    "System default"

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const next = await navigator.mediaDevices.enumerateDevices()
    setDevices(next.filter((device) => device.kind === "audioinput"))
  }, [])

  const completeRecording = useCallback((recordingId: string, uploads: Promise<void>) => {
    if (completingRecordingsRef.current.has(recordingId)) return
    completingRecordingsRef.current.add(recordingId)
    void uploads
      .then(() => api.post(`/api/v1/transcription/recordings/${recordingId}/complete`))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Audio upload could not be completed."))
      .finally(() => {
        completingRecordingsRef.current.delete(recordingId)
        if (recordingIdRef.current === recordingId) recordingIdRef.current = null
      })
  }, [])

  const closeCapture = useCallback(() => {
    captureAttemptRef.current += 1
    try {
      captureSocketRef.current?.send(JSON.stringify({ type: "transcription.stop" }))
    } catch {
      // The socket may already be closed.
    }
    captureSocketRef.current?.close()
    captureSocketRef.current = null
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
    else if (recordingIdRef.current) completeRecording(recordingIdRef.current, recordingUploadQueueRef.current)
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

  const closeViewer = useCallback(() => {
    viewerAttemptRef.current += 1
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
      if (!current) return next
      return {
        ...next,
        sources: next.sources.map((source) => {
          const existing = current.sources.find((item) => item.id === source.id)
          return existing ? { ...source, signalLevel: existing.signalLevel } : source
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
        setSnapshot((current) => current ? { ...current, session: { ...current.session, ...(data as Partial<TranscriptionSession>) } } : current)
        onSessionsChanged()
        return
      }
      if (event.type === "transcription.source") {
        setSnapshot((current) => current ? { ...current, sources: current.sources.map((source) => source.id === data.sourceId ? { ...source, status: data.status as TranscriptionSource["status"] } : source) } : current)
        return
      }
      if (event.type === "transcription.source.level") {
        const nextLevel = Number(data.level ?? 0)
        setLevel(nextLevel)
        setSnapshot((current) => current ? { ...current, sources: current.sources.map((source) => source.id === data.sourceId ? { ...source, signalLevel: nextLevel } : source) } : current)
        return
      }
      if (event.type === "transcription.partial") {
        setPartial(String(data.text ?? ""))
        return
      }
      if (event.type === "transcription.final") {
        const segment = data.segment as TranscriptionSegment | undefined
        if (!segment) return
        setPartial("")
        setSnapshot((current) => {
          if (!current) return current
          const hasSegment = current.segments.some((item) => item.id === segment.id)
          const segments = hasSegment
            ? current.segments.map((item) => item.id === segment.id ? { ...item, ...segment } : item)
            : [...current.segments, segment]
          return { ...current, segments: segments.sort((left, right) => left.startOffsetMs - right.startOffsetMs) }
        })
        onSessionsChanged()
        return
      }
      if (event.type === "transcription.segment.updated") {
        setSnapshot((current) => current ? { ...current, segments: current.segments.map((segment) => segment.id === data.segmentId ? { ...segment, speakerId: String(data.speakerId) } : segment) } : current)
        return
      }
      if (event.type === "transcription.speaker") {
        setSnapshot((current) => current ? { ...current, speakers: current.speakers.map((speaker) => speaker.id === data.speakerId ? { ...speaker, displayName: String(data.displayName ?? "") } : speaker) } : current)
        return
      }
      if (event.type === "error" || event.type === "transcription.diarization-error") {
        setError(String(data.message ?? "The transcription service reported an error."))
      }
    },
    [applySnapshot, onSessionsChanged]
  )

  const connectViewer = useCallback(async (id: string) => {
    closeViewer()
    const attempt = viewerAttemptRef.current
    const ticketResponse = await api.post<{ ticket: string }>("/api/v1/ws/tickets", { kind: "transcription-viewer", sessionId: id })
    if (viewerAttemptRef.current !== attempt) return
    const socket = new WebSocket(socketURL("/api/v1/ws/transcription", ticketResponse.ticket))
    viewerSocketRef.current = socket
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
        setError("The live transcription connection could not be established.")
      }
    }
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onclose = () => {
        if (viewerAttemptRef.current !== attempt) {
          resolve()
          return
        }
        reject(new Error("The live transcription connection closed."))
      }
    })
    if (viewerAttemptRef.current !== attempt || socket.readyState !== WebSocket.OPEN) {
      socket.close()
      return
    }
    socket.send(JSON.stringify({ type: "viewer.ready" }))
  }, [closeViewer, handleSocketEvent])

  const downsample = (input: Float32Array, sourceRate: number, targetRate: number) => {
    if (sourceRate === targetRate) return input
    const ratio = sourceRate / targetRate
    const output = new Float32Array(Math.round(input.length / ratio))
    for (let index = 0; index < output.length; index += 1) {
      const start = Math.floor(index * ratio)
      const end = Math.min(input.length, Math.ceil((index + 1) * ratio))
      let total = 0
      for (let inputIndex = start; inputIndex < end; inputIndex += 1) total += input[inputIndex]
      output[index] = end > start ? total / (end - start) : 0
    }
    return output
  }

  const encodePCM16 = (input: Float32Array) => {
    const buffer = new ArrayBuffer(input.length * 2)
    const view = new DataView(buffer)
    input.forEach((value, index) => {
      const sample = Math.max(-1, Math.min(1, value))
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    })
    return buffer
  }

  const beginAudio = useCallback(async (socket: WebSocket, session: TranscriptionSession, source: TranscriptionSource) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone capture.")
    const constraints: MediaStreamConstraints = { audio: deviceLabel ? { deviceId: { exact: deviceLabel } } : { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }
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
    worklet.port.onmessage = (message: MessageEvent<Float32Array>) => {
      if (socket.readyState !== WebSocket.OPEN) return
      const pcm = encodePCM16(downsample(message.data, context.sampleRate, 16000))
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
      const nextLevel = Math.min(1, Math.sqrt(total / levelBuffer.length) * 3.2)
      setLevel(nextLevel)
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "source.level", level: nextLevel }))
    }, 100)
    levelTimerRef.current = levelTimer
    void context.resume()
    if (session.recordAudio) {
      const recording = await api.post<{ recording: TranscriptionRecording }>("/api/v1/transcription/recordings/start", { sessionId: session.id, sourceId: source.id, mimeType: "audio/webm;codecs=opus" })
      const recordingId = recording.recording.id
      recordingIdRef.current = recordingId
      recordingUploadQueueRef.current = Promise.resolve()
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" })
      let part = 0
      let uploads = Promise.resolve()
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        const currentPart = part
        part += 1
        uploads = uploads.then(async () => {
          await api.binary(`/api/v1/transcription/recordings/${recordingId}/parts/${currentPart}`, event.data)
        })
        recordingUploadQueueRef.current = uploads
      }
      recorder.onstop = () => completeRecording(recordingId, uploads)
      recorder.start(5000)
      mediaRecorderRef.current = recorder
    }
    setCapturing(true)
  }, [completeRecording, deviceLabel, refreshDevices])

  const startCapture = useCallback(async (session: TranscriptionSession, source: TranscriptionSource) => {
    closeCapture()
    const attempt = captureAttemptRef.current
    const ticketResponse = await api.post<{ ticket: string }>("/api/v1/ws/tickets", { kind: "transcription-capture", sessionId: session.id, sourceId: source.id })
    if (captureAttemptRef.current !== attempt) return
    const socket = new WebSocket(socketURL("/api/v1/ws/transcription", ticketResponse.ticket))
    captureSocketRef.current = socket
    socket.onmessage = (message) => {
      if (captureAttemptRef.current !== attempt) return
      try {
        handleSocketEvent(JSON.parse(message.data) as SocketEvent)
      } catch {
        setError("Received an invalid capture event from the transcription server.")
      }
    }
    socket.onerror = () => {
      if (captureAttemptRef.current === attempt) {
        setError("The microphone connection could not be established.")
      }
    }
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onclose = () => {
        if (captureAttemptRef.current !== attempt) {
          resolve()
          return
        }
        reject(new Error("The microphone connection closed."))
      }
    })
    if (captureAttemptRef.current !== attempt || socket.readyState !== WebSocket.OPEN) {
      socket.close()
      return
    }
    socket.send(JSON.stringify({ type: "transcription.start", sessionId: session.id, sourceId: source.id }))
    try {
      await beginAudio(socket, session, source)
    } catch (caught) {
      if (captureAttemptRef.current === attempt) closeCapture()
      throw caught
    }
  }, [beginAudio, closeCapture, handleSocketEvent])

  const loadSession = useCallback(async (id: string) => {
    const requestId = sessionLoadRef.current + 1
    sessionLoadRef.current = requestId
    const isCurrentRequest = () => sessionLoadRef.current === requestId
    setLoading(true)
    setError("")
    try {
      const next = await api.get<Snapshot>(`/api/v1/transcription/sessions/${id}`)
      if (!isCurrentRequest()) return
      applySnapshot(next)
      setCreateOpen(false)
      await connectViewer(id)
      if (!isCurrentRequest()) return
      const requests = await api.get<{ requests: TranscriptionJoinRequest[] }>(`/api/v1/transcription/sessions/${id}/join-requests`)
      if (!isCurrentRequest()) return
      setJoinRequests(requests.requests)
    } catch (caught) {
      if (!isCurrentRequest()) return
      setError(caught instanceof Error ? caught.message : "The transcription session could not be loaded.")
    } finally {
      if (isCurrentRequest()) setLoading(false)
    }
  }, [applySnapshot, connectViewer])

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      queueMicrotask(() => {
        if (cancelled) return
        closeSockets()
        setSnapshot(null)
        setCreateOpen(true)
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
    if (!transcriptRef.current) return
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [snapshot?.segments.length, partial])

  const createSession = async () => {
    setStarting(true)
    setError("")
    try {
      const result = await api.post<{ session: TranscriptionSession; joinCode: string; expiresAt: string }>("/api/v1/transcription/sessions", { title, language, recordAudio, transcriptionEndpointId: effectiveSelectedEndpoint, diarizationEndpointId: selectedDiarizationEndpoint || undefined })
      const createdSession = { ...result.session, joinCode: result.joinCode, joinCodeExpiresAt: result.expiresAt }
      const source = await api.post<{ source: TranscriptionSource }>(`/api/v1/transcription/sessions/${result.session.id}/sources`, { name: "This laptop", kind: "browser", deviceLabel: selectedDeviceName })
      onSessionCreated(createdSession)
      setCreateOpen(false)
      const nextSnapshot: Snapshot = { session: createdSession, sources: [source.source], speakers: [], segments: [], recordings: [] }
      applySnapshot(nextSnapshot)
      await startCapture(result.session, source.source)
      await api.post(`/api/v1/transcription/sessions/${result.session.id}/resume`)
      onSessionsChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transcription session could not be started.")
    } finally {
      setStarting(false)
    }
  }

  const ensureCapture = async () => {
    if (!snapshot || capturing) return
    let source = snapshot.sources.find((item) => item.kind === "browser")
    if (!source) {
      const result = await api.post<{ source: TranscriptionSource }>(`/api/v1/transcription/sessions/${snapshot.session.id}/sources`, { name: "This laptop", kind: "browser", deviceLabel: selectedDeviceName })
      source = result.source
      setSnapshot((current) => current ? { ...current, sources: [...current.sources, source as TranscriptionSource] } : current)
    }
    await startCapture(snapshot.session, source)
    await api.post(`/api/v1/transcription/sessions/${snapshot.session.id}/resume`)
  }

  const pauseOrResume = async () => {
    if (!snapshot) return
    const action = snapshot.session.status === "paused" ? "resume" : "pause"
    await api.post(`/api/v1/transcription/sessions/${snapshot.session.id}/${action}`)
    setSnapshot((current) => current ? { ...current, session: { ...current.session, status: action === "pause" ? "paused" : "live" } } : current)
  }

  const stopSession = async () => {
    if (!snapshot) return
    closeCapture()
    await api.post(`/api/v1/transcription/sessions/${snapshot.session.id}/stop`)
    onSessionsChanged()
    await loadSession(snapshot.session.id)
  }

  const refreshJoinRequests = async () => {
    if (!snapshot) return
    const result = await api.get<{ requests: TranscriptionJoinRequest[] }>(`/api/v1/transcription/sessions/${snapshot.session.id}/join-requests`)
    setJoinRequests(result.requests)
  }

  const setJoinRequest = async (request: TranscriptionJoinRequest, status: "approve" | "deny") => {
    if (!snapshot) return
    await api.post(`/api/v1/transcription/join-requests/${request.id}/${status}`)
    await refreshJoinRequests()
  }

  const renameSpeaker = async (speaker: TranscriptionSpeaker) => {
    if (!snapshot) return
    const displayName = window.prompt("Name this speaker", speaker.displayName || speaker.label)
    if (displayName === null) return
    await api.patch(`/api/v1/transcription/sessions/${snapshot.session.id}/speakers/${speaker.id}`, { displayName })
    setSnapshot((current) => current ? { ...current, speakers: current.speakers.map((item) => item.id === speaker.id ? { ...item, displayName } : item) } : current)
  }

  const copyJoinCode = async () => {
    if (!snapshot?.session.joinCode) return
    await navigator.clipboard.writeText(snapshot.session.joinCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const rotateJoinCode = async () => {
    if (!snapshot) return
    try {
      const result = await api.post<{ joinCode: string; expiresAt: string }>(`/api/v1/transcription/sessions/${snapshot.session.id}/join-code`)
      setSnapshot((current) => current ? { ...current, session: { ...current.session, joinCode: result.joinCode, joinCodeExpiresAt: result.expiresAt } } : current)
      setShareOpen(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "A room code could not be generated.")
    }
  }

  const formatOffset = (value: number) => {
    const seconds = Math.max(0, Math.floor(value / 1000))
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  }

  const orbState: ListeningOrbState = error ? "error" : snapshot?.session.status === "paused" ? "paused" : capturing ? level > 0.12 ? "speaking" : "listening" : "idle"
  const latestSource = snapshot?.sources.slice().sort((left, right) => right.signalLevel - left.signalLevel)[0]
  const speakerById = new Map((snapshot?.speakers ?? []).map((speaker) => [speaker.id, speaker]))
  const sourceById = new Map((snapshot?.sources ?? []).map((source) => [source.id, source]))

  if (!sessionId && sessions.length > 0 && !createOpen) {
    return null
  }

  return (
    <div className="flex min-h-[calc(100svh-2rem)] min-w-0 flex-col gap-4">
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
            <EmptyDescription>Start a named session and connect microphones from other devices with a short approval code.</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setCreateOpen(true)}>
            <Play data-icon="inline-start" />
            New live session
          </Button>
        </Empty>
      ) : (
        <>
          <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Headphones aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate font-heading text-xl font-semibold tracking-tight">{snapshot.session.title}</h1>
                  <Badge variant={snapshot.session.status === "live" ? "default" : "secondary"}>{snapshot.session.status}</Badge>
                </div>
                <p className="truncate text-sm text-muted-foreground">{snapshot.session.language === "auto" ? "Automatic language" : snapshot.session.language} · {snapshot.session.segmentCount} finalized segments · Hosted by {user.displayName}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {snapshot.session.status !== "completed" && <Button onClick={() => void (snapshot.session.joinCode ? setShareOpen(true) : rotateJoinCode())} size="sm" variant="outline"><Share2 data-icon="inline-start" /> Share room</Button>}
              {!capturing && snapshot.session.status !== "completed" && (
                <Button onClick={() => void ensureCapture()} size="sm">
                  <Mic data-icon="inline-start" /> Start microphone
                </Button>
              )}
              {capturing && snapshot.session.status !== "completed" && (
                <Button onClick={() => void pauseOrResume()} size="sm" variant="outline">
                  {snapshot.session.status === "paused" ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}
                  {snapshot.session.status === "paused" ? "Resume" : "Pause"}
                </Button>
              )}
              {snapshot.session.status !== "completed" && (
                <Button onClick={() => void stopSession()} size="sm" variant="destructive">
                  <Square data-icon="inline-start" /> Stop
                </Button>
              )}
            </div>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex min-h-0 flex-col gap-4">
              <Card className="relative min-h-[20rem] flex-1 overflow-hidden bg-gradient-to-br from-primary/5 via-card to-card">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.08),transparent_56%)]" />
                <CardContent className="relative flex min-h-[20rem] flex-col items-center justify-center py-8">
                  <ListeningOrb className="max-h-[23rem]" level={level} state={orbState} />
                  <div className="-mt-5 text-center">
                    <p className="font-medium">{capturing ? (latestSource?.name ?? "Listening") : snapshot.session.status === "completed" ? "Session complete" : "Ready to listen"}</p>
                    <p className="text-sm text-muted-foreground">{capturing ? "Live audio is being processed" : snapshot.session.status === "paused" ? "Capture is paused" : error ? "Check the provider connection" : "Start a microphone to begin"}</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="min-h-0 flex-[1.1]">
                <CardHeader className="flex-row items-center justify-between border-b">
                  <div>
                    <CardTitle>Live transcript</CardTitle>
                    <CardDescription>Final text stays in order; the last line is provisional while the provider listens.</CardDescription>
                  </div>
                  {loading && <Spinner />}
                </CardHeader>
                <CardContent className="min-h-0 flex-1 p-0">
                  <div className="h-[22rem] overflow-y-auto p-4 lg:h-[calc(100%-1px)]" ref={transcriptRef}>
                    {snapshot.segments.length === 0 && !partial ? (
                      <div className="flex h-full min-h-40 items-center justify-center text-center text-sm text-muted-foreground">The transcript will appear here as people speak.</div>
                    ) : (
                      <div className="flex flex-col gap-4">
                        {snapshot.segments.map((segment) => {
                          const speaker = segment.speakerId ? speakerById.get(segment.speakerId) : undefined
                          const source = segment.sourceId ? sourceById.get(segment.sourceId) : undefined
                          return (
                            <div className="flex gap-3" key={segment.id}>
                              <Avatar className="mt-0.5 size-7 shrink-0">
                                <AvatarFallback>{speaker?.displayName?.slice(0, 1) ?? speaker?.label?.slice(-1) ?? "·"}</AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span className="font-medium text-foreground">{speaker?.displayName || speaker?.label || "Unassigned speaker"}</span>
                                  {source && <Badge variant="outline">{source.name}</Badge>}
                                  <span>{formatOffset(segment.startOffsetMs)}</span>
                                </div>
                                <p className="whitespace-pre-wrap text-sm leading-6">{segment.text}</p>
                              </div>
                            </div>
                          )
                        })}
                        {partial && <div className="border-l-2 border-primary/50 pl-3 text-sm leading-6 text-muted-foreground italic">{partial}</div>}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            <aside className="flex min-h-0 flex-col gap-4">
              <Card>
                <CardHeader className="flex-row items-center justify-between border-b">
                  <div>
                    <CardTitle className="flex items-center gap-2"><Mic data-icon="inline-start" /> Sources</CardTitle>
                    <CardDescription>{snapshot.sources.length} microphone{snapshot.sources.length === 1 ? "" : "s"} in this room</CardDescription>
                  </div>
                  <Badge variant="outline">{capturing ? "local live" : "viewer"}</Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 pt-4">
                  {snapshot.sources.length === 0 ? <p className="text-sm text-muted-foreground">No microphones have joined yet.</p> : snapshot.sources.map((source) => (
                    <div className="rounded-xl border bg-muted/20 p-3" key={source.id}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`size-2 shrink-0 rounded-full ${source.status === "connected" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                          <span className="truncate text-sm font-medium">{source.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{source.status}</span>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${Math.round(source.signalLevel * 100)}%` }} /></div>
                      {source.deviceLabel && <p className="mt-2 truncate text-xs text-muted-foreground">{source.deviceLabel}</p>}
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="min-h-0 flex-1">
                <CardHeader className="flex-row items-center justify-between border-b">
                  <div>
                    <CardTitle className="flex items-center gap-2"><Users data-icon="inline-start" /> Speakers</CardTitle>
                    <CardDescription>Anonymous labels can be corrected during review.</CardDescription>
                  </div>
                  <Badge variant="secondary">{snapshot.speakers.length}</Badge>
                </CardHeader>
                <CardContent className="flex min-h-32 flex-col gap-2 overflow-y-auto pt-4">
                  {snapshot.speakers.length === 0 ? <p className="text-sm text-muted-foreground">Speaker labels will arrive after a short audio window.</p> : snapshot.speakers.map((speaker) => (
                    <button className="flex items-center gap-3 rounded-xl border p-2 text-left transition-colors hover:bg-muted" key={speaker.id} onClick={() => void renameSpeaker(speaker)} type="button">
                      <Avatar className="size-8"><AvatarFallback>{speaker.displayName?.slice(0, 1) ?? speaker.label.slice(-1)}</AvatarFallback></Avatar>
                      <span className="min-w-0 flex-1 truncate text-sm">{speaker.displayName || speaker.label}</span>
                      <span className="text-xs text-muted-foreground">Rename</span>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {joinRequests.some((request) => request.status === "pending") && <Card>
                <CardHeader className="flex-row items-center justify-between border-b"><div><CardTitle>Join requests</CardTitle><CardDescription>Approve another microphone.</CardDescription></div><Button onClick={() => void refreshJoinRequests()} size="icon-sm" variant="ghost"><RefreshCw /></Button></CardHeader>
                <CardContent className="flex flex-col gap-2 pt-4">{joinRequests.filter((request) => request.status === "pending").map((request) => <div className="flex items-center gap-2" key={request.id}><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{request.sourceName}</p><p className="truncate text-xs text-muted-foreground">{request.deviceLabel || "Unknown device"}</p></div><Button aria-label={`Approve ${request.sourceName}`} onClick={() => void setJoinRequest(request, "approve")} size="icon-sm" variant="outline"><Check /></Button><Button aria-label={`Deny ${request.sourceName}`} onClick={() => void setJoinRequest(request, "deny")} size="icon-sm" variant="ghost"><X /></Button></div>)}</CardContent>
              </Card>}

              {snapshot.recordings.length > 0 && <Card><CardHeader><CardTitle>Audio tracks</CardTitle><CardDescription>Encrypted source recordings remain available until their retention date.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{snapshot.recordings.map((recording) => <div className="flex flex-col gap-2" key={recording.id}><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{sourceById.get(recording.sourceId)?.name ?? "Source"}</span><span>{recording.expiresAt ? `Until ${new Date(recording.expiresAt).toLocaleDateString()}` : ""}</span></div><audio controls preload="none" src={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080"}/api/v1/transcription/recordings/${recording.id}`} /></div>)}</CardContent></Card>}
            </aside>
          </div>
        </>
      )}

      <Dialog open={createOpen && !sessionId} onOpenChange={(open) => { setCreateOpen(open); if (open) void refreshDevices() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New live session</DialogTitle>
            <DialogDescription>Choose the endpoint and whether JustAI should retain source audio. Recording is off by default.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field><FieldLabel htmlFor="session-title">Session name</FieldLabel><Input id="session-title" onChange={(event) => setTitle(event.target.value)} value={title} /></Field>
            <Field><FieldLabel htmlFor="session-language">Language</FieldLabel><Input id="session-language" onChange={(event) => setLanguage(event.target.value || "auto")} placeholder="auto" value={language} /><FieldDescription>Use a BCP-47 code such as de or en, or auto.</FieldDescription></Field>
            <Field><FieldLabel>Realtime endpoint</FieldLabel><Select onValueChange={(value) => setSelectedEndpoint(value ?? "")} value={effectiveSelectedEndpoint}><SelectTrigger className="w-full"><SelectValue placeholder="Select a transcription endpoint" /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Transcription providers</SelectLabel>{realtimeEndpoints.map((endpoint) => <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name} · {endpoint.providerType}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            <Field><FieldLabel>Microphone</FieldLabel><Select onValueChange={(value) => setDeviceLabel(value === "default" ? "" : value ?? "")} value={deviceLabel || "default"}><SelectTrigger className="w-full"><SelectValue placeholder="System default" /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Audio inputs</SelectLabel><SelectItem value="default">System default</SelectItem>{devices.map((device, index) => <SelectItem key={device.deviceId || `audio-input-${index}`} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>Select which microphone this host browser should stream.</FieldDescription></Field>
            <Field><FieldLabel>Diarization endpoint</FieldLabel><Select onValueChange={(value) => setSelectedDiarizationEndpoint(value === "none" ? "" : value ?? "")} value={selectedDiarizationEndpoint || "none"}><SelectTrigger className="w-full"><SelectValue placeholder="Optional speaker separation" /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Speaker providers</SelectLabel><SelectItem value="none">No speaker separation</SelectItem>{diarizationEndpoints.map((endpoint) => <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name} · {endpoint.providerType}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>Labels arrive after a short rolling audio window and remain anonymous.</FieldDescription></Field>
            <div className="flex items-center justify-between rounded-xl border p-3"><div><p className="text-sm font-medium">Record source audio</p><p className="text-xs text-muted-foreground">Encrypted, source-separated tracks. Default retention: 30 days.</p></div><Switch aria-label="Record source audio" checked={recordAudio} onCheckedChange={setRecordAudio} /></div>
          </FieldGroup>
          <DialogFooter><Button onClick={() => setCreateOpen(false)} variant="outline">Cancel</Button><Button disabled={starting || !effectiveSelectedEndpoint} onClick={() => void createSession()}>{starting ? <><LoaderCircle className="animate-spin" data-icon="inline-start" /> Starting…</> : <><Play data-icon="inline-start" /> Start session</>}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Join this room</DialogTitle><DialogDescription>Open /transcription/join on another device. The microphone connects only after you approve it here.</DialogDescription></DialogHeader>
          <div className="flex items-center justify-between rounded-xl border bg-muted/30 p-4"><span className="font-mono text-2xl font-semibold tracking-[0.32em]">{snapshot?.session.joinCode ?? "--------"}</span><div className="flex items-center gap-2"><Button onClick={() => void rotateJoinCode()} size="sm" variant="outline">New code</Button>{snapshot?.session.joinCode && <Button aria-label="Copy room code" onClick={() => void copyJoinCode()} size="icon-sm" variant="outline">{copied ? <Check /> : <Copy />}</Button>}</div></div>
          <DialogFooter><Button onClick={() => setShareOpen(false)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
