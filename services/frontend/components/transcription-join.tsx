"use client"

import { Check, LoaderCircle, Mic, Radio, ShieldCheck } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"

import type { LiveTranscriptionSnapshot } from "@/components/live-transcription-orbit"
import { TranscriptionParticipantRoom } from "@/components/transcription-participant-room"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { VoiceOrb } from "@/components/assistant-ui/voice"
import { api, socketURL } from "@/lib/api"
import {
  mergeTranscriptionSegments,
  transcriptionJoinPath,
  upsertTranscriptionSource,
} from "@/lib/transcription"
import type {
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSource,
} from "@/lib/types"

type JoinState = "form" | "pending" | "approved" | "connected" | "paused"

type JoinSocketEvent = {
  type?: string
  data?: Record<string, unknown>
}

type JoinPollResult = {
  status: string
  sessionId?: string
  sessionTitle?: string
  captureGrant?: string
  sourceId?: string
}

type StoredJoin = {
  code: string
  requestId: string
  pollToken: string
  sourceName: string
}

const JOIN_STORAGE_PREFIX = "justai.transcription.join."

function downsample(
  input: Float32Array,
  sourceRate: number,
  targetRate: number
) {
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

function storageKey(code: string) {
  return `${JOIN_STORAGE_PREFIX}${code.trim().toUpperCase()}`
}

function saveStoredJoin(value: StoredJoin) {
  try {
    window.sessionStorage.setItem(storageKey(value.code), JSON.stringify(value))
  } catch {
    // Storage can be disabled; the current tab can still complete the join.
  }
}

function readStoredJoin(code: string, requestId: string) {
  try {
    const raw = window.sessionStorage.getItem(storageKey(code))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredJoin>
    if (
      value.code !== code.trim().toUpperCase() ||
      value.requestId !== requestId ||
      !value.pollToken ||
      !value.sourceName
    )
      return null
    return value as StoredJoin
  } catch {
    return null
  }
}

function clearStoredJoin(code: string) {
  try {
    window.sessionStorage.removeItem(storageKey(code))
  } catch {
    // Storage can be disabled.
  }
}

function replaceJoinURL(code: string, requestId?: string) {
  if (typeof window === "undefined") return
  const path = transcriptionJoinPath(code)
  const url = new URL(path, window.location.origin)
  if (requestId) url.searchParams.set("request", requestId)
  window.history.replaceState(null, "", `${url.pathname}${url.search}`)
}

function sourceStatus(value: unknown): TranscriptionSource["status"] {
  return ["pending", "connected", "paused", "disconnected", "stopped"].includes(
    String(value)
  )
    ? (String(value) as TranscriptionSource["status"])
    : "pending"
}

export function TranscriptionJoin() {
  const searchParams = useSearchParams()
  const initialCode = searchParams.get("code") ?? ""
  const requestFromURL = searchParams.get("request") ?? ""
  const [code, setCode] = useState(initialCode)
  const [sourceName, setSourceName] = useState("")
  const [requestId, setRequestId] = useState("")
  const [pollToken, setPollToken] = useState("")
  const [state, setState] = useState<JoinState>("form")
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  const [level, setLevel] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [snapshot, setSnapshot] = useState<LiveTranscriptionSnapshot | null>(
    null
  )
  const [partial, setPartial] = useState("")
  const [partialSourceId, setPartialSourceId] = useState<string | null>(null)
  const [partialSpeakerId, setPartialSpeakerId] = useState<string | null>(null)
  const [microphoneActive, setMicrophoneActive] = useState(false)
  const [currentSourceId, setCurrentSourceId] = useState<string | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelTimerRef = useRef<number | null>(null)
  const pollInFlightRef = useRef(false)
  const pollAttemptRef = useRef(0)
  const captureAttemptRef = useRef(0)
  const joinOperationRef = useRef(0)
  const mountedRef = useRef(true)
  const sourceIdRef = useRef<string | null>(null)
  const intentionalCloseRef = useRef(false)

  const stopAudio = useCallback(() => {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    workletRef.current?.disconnect()
    workletRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    setLevel(0)
    setMicrophoneActive(false)
  }, [])

  const applySnapshot = useCallback((next: LiveTranscriptionSnapshot) => {
    setSnapshot((current) => {
      const sameSession = current?.session.id === next.session.id
      const sources = next.sources.map((source) => {
        const existing = sameSession
          ? current?.sources.find((item) => item.id === source.id)
          : undefined
        return existing
          ? { ...source, signalLevel: existing.signalLevel }
          : source
      })
      return {
        ...next,
        sources,
        segments: mergeTranscriptionSegments(
          sameSession ? current?.segments || [] : [],
          next.segments
        ),
      }
    })
    setTitle(next.session.title)
  }, [])

  const handleRoomEvent = useCallback(
    (event: JoinSocketEvent) => {
      const data = event.data ?? {}
      if (event.type === "transcription.snapshot") {
        applySnapshot(data as unknown as LiveTranscriptionSnapshot)
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
        return
      }
      if (event.type === "transcription.source") {
        const sourceId = String(data.sourceId ?? "")
        if (!sourceId) return
        const sourceData =
          data.source && typeof data.source === "object"
            ? (data.source as Partial<TranscriptionSource>)
            : {}
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sources: upsertTranscriptionSource(
                  current.sources,
                  { ...sourceData, id: sourceId },
                  sourceStatus(data.status ?? sourceData.status)
                ),
              }
            : current
        )
        return
      }
      if (event.type === "transcription.source.level") {
        const sourceId = String(data.sourceId ?? "")
        const nextLevel = Math.max(0, Math.min(1, Number(data.level ?? 0)))
        if (sourceId === sourceIdRef.current) setLevel(nextLevel)
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
        setSnapshot((current) => {
          if (
            !current ||
            (segment.sessionId && current.session.id !== segment.sessionId)
          )
            return current
          return {
            ...current,
            segments: mergeTranscriptionSegments(current.segments, [segment]),
          }
        })
        return
      }
      if (event.type === "transcription.segment.updated") {
        const segmentId = String(data.segmentId ?? "")
        const speakerId = String(data.speakerId ?? "")
        if (!segmentId || !speakerId) return
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
        const speakerId = String(data.speakerId ?? "")
        setSnapshot((current) =>
          current
            ? {
                ...current,
                speakers: current.speakers.map((speaker) =>
                  speaker.id === speakerId
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
    [applySnapshot]
  )

  const startMicrophone = useCallback(
    async (attempt = captureAttemptRef.current) => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new Error("The room connection is not ready yet.")
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("This browser does not support microphone capture.")

      const isCurrent = () =>
        mountedRef.current &&
        !intentionalCloseRef.current &&
        captureAttemptRef.current === attempt &&
        socketRef.current === socket &&
        socket.readyState === WebSocket.OPEN
      let stream: MediaStream | null = null
      let context: AudioContext | null = null
      let node: AudioWorkletNode | null = null
      let analyser: AnalyserNode | null = null
      let levelTimer: number | null = null
      const cleanupLocal = () => {
        if (levelTimer !== null) {
          window.clearInterval(levelTimer)
          if (levelTimerRef.current === levelTimer) levelTimerRef.current = null
          levelTimer = null
        }
        node?.disconnect()
        if (workletRef.current === node) workletRef.current = null
        analyser?.disconnect()
        if (analyserRef.current === analyser) analyserRef.current = null
        stream?.getTracks().forEach((track) => track.stop())
        if (streamRef.current === stream) streamRef.current = null
        if (contextRef.current === context) contextRef.current = null
        void context?.close()
        context = null
      }
      stopAudio()
      if (!isCurrent()) return
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      streamRef.current = stream
      try {
        context = new AudioContext()
      } catch (caught) {
        cleanupLocal()
        throw caught
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      contextRef.current = context
      try {
        await context!.audioWorklet.addModule("/audio-worklet.js")
      } catch (caught) {
        cleanupLocal()
        throw caught
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      const source = context!.createMediaStreamSource(stream)
      analyser = context!.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser
      node = new AudioWorkletNode(context!, "justai-pcm-processor")
      workletRef.current = node
      const gain = context!.createGain()
      gain.gain.value = 0
      source.connect(analyser)
      source.connect(node)
      node.connect(gain)
      gain.connect(context!.destination)
      let sequence = 0
      node.port.onmessage = (message: MessageEvent<Float32Array>) => {
        if (!isCurrent()) return
        const samples = downsample(message.data, context!.sampleRate, 16000)
        const frame = new ArrayBuffer(17 + samples.length * 2)
        const view = new DataView(frame)
        view.setUint8(0, 1)
        view.setBigUint64(1, BigInt(Date.now()), true)
        view.setUint32(9, sequence, true)
        view.setUint32(13, 16000, true)
        samples.forEach((value, index) =>
          view.setInt16(
            17 + index * 2,
            Math.max(-1, Math.min(1, value)) * (value < 0 ? 0x8000 : 0x7fff),
            true
          )
        )
        sequence += 1
        socket.send(frame)
      }
      const meter = new Uint8Array(analyser.fftSize)
      levelTimer = window.setInterval(() => {
        if (!isCurrent()) return
        analyser.getByteTimeDomainData(meter)
        let total = 0
        meter.forEach((value) => {
          const normalized = (value - 128) / 128
          total += normalized * normalized
        })
        const nextLevel = Math.min(1, Math.sqrt(total / meter.length) * 3)
        setLevel(nextLevel)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "source.level", level: nextLevel })
          )
      }, 100)
      levelTimerRef.current = levelTimer
      try {
        await context!.resume()
      } catch (caught) {
        cleanupLocal()
        throw caught
      }
      if (!isCurrent()) {
        cleanupLocal()
        return
      }
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error(
          "The room connection closed while opening the microphone."
        )
      socket.send(JSON.stringify({ type: "source.resume" }))
      setMicrophoneActive(true)
      setState("connected")
    },
    [stopAudio]
  )

  const connectCapture = useCallback(
    async (captureGrant: string, sourceId: string) => {
      if (socketRef.current) return
      const attempt = captureAttemptRef.current + 1
      captureAttemptRef.current = attempt
      intentionalCloseRef.current = false
      sourceIdRef.current = sourceId
      setCurrentSourceId(sourceId)
      setState("approved")
      const ticket = await api.postWithAuth<{ ticket: string }>(
        "/api/v1/transcription/capture-tickets",
        captureGrant
      )
      if (
        !mountedRef.current ||
        intentionalCloseRef.current ||
        captureAttemptRef.current !== attempt
      )
        return
      const socket = new WebSocket(
        socketURL("/api/v1/ws/transcription", ticket.ticket)
      )
      socketRef.current = socket
      socket.onmessage = (message) => {
        if (
          captureAttemptRef.current !== attempt ||
          intentionalCloseRef.current
        )
          return
        try {
          handleRoomEvent(JSON.parse(message.data) as JoinSocketEvent)
        } catch {
          setError("The room sent an invalid event.")
        }
      }
      socket.onerror = () => {
        if (
          captureAttemptRef.current === attempt &&
          !intentionalCloseRef.current
        )
          setError("The room connection failed; reconnecting…")
      }
      socket.onclose = () => {
        if (socketRef.current !== socket) return
        socketRef.current = null
        stopAudio()
        if (
          captureAttemptRef.current !== attempt ||
          intentionalCloseRef.current
        )
          return
        setError("The room connection closed; reconnecting…")
        setState("pending")
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = window.setTimeout(() => {
          if (settled) return
          settled = true
          socket.close()
          reject(new Error("The room connection took too long to connect."))
        }, 15_000)
        socket.onopen = () => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          resolve()
        }
        socket.addEventListener("close", () => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          if (
            captureAttemptRef.current !== attempt ||
            intentionalCloseRef.current
          ) {
            resolve()
            return
          }
          reject(new Error("The room connection closed before connecting."))
        })
      })
      if (
        !mountedRef.current ||
        intentionalCloseRef.current ||
        captureAttemptRef.current !== attempt ||
        socketRef.current !== socket
      ) {
        socket.close()
        if (socketRef.current === socket) socketRef.current = null
        return
      }
      try {
        await startMicrophone(attempt)
      } catch (caught) {
        if (captureAttemptRef.current === attempt) {
          intentionalCloseRef.current = true
          socket.close()
          if (socketRef.current === socket) socketRef.current = null
          stopAudio()
        }
        throw caught
      }
    },
    [handleRoomEvent, startMicrophone, stopAudio]
  )

  const pollRequest = useCallback(
    async (attempt = pollAttemptRef.current) => {
      if (!requestId || !pollToken || pollInFlightRef.current) return
      pollInFlightRef.current = true
      const isCurrent = () =>
        mountedRef.current && pollAttemptRef.current === attempt
      try {
        const result = await api.get<JoinPollResult>(
          `/api/v1/transcription/join-requests/${requestId}?token=${encodeURIComponent(pollToken)}`
        )
        if (!isCurrent()) return
        setTitle(result.sessionTitle ?? "Live session")
        if (result.status === "denied" || result.status === "expired") {
          setError(
            result.status === "denied"
              ? "The host declined this microphone."
              : "This join request expired."
          )
          clearStoredJoin(code)
          replaceJoinURL(code)
          setSnapshot(null)
          setState("form")
          return
        }
        if (
          result.status === "approved" &&
          result.captureGrant &&
          result.sourceId &&
          !socketRef.current
        ) {
          try {
            await connectCapture(result.captureGrant, result.sourceId)
            if (!isCurrent()) return
          } catch (caught) {
            if (!isCurrent()) return
            setError(
              caught instanceof Error
                ? caught.message
                : "The microphone could not be connected."
            )
            setState("pending")
          }
        }
      } catch (caught) {
        if (!isCurrent()) return
        setError(
          caught instanceof Error
            ? caught.message
            : "The join request could not be checked."
        )
      } finally {
        if (isCurrent()) pollInFlightRef.current = false
      }
    },
    [code, connectCapture, pollToken, requestId]
  )

  useEffect(() => {
    if (state !== "pending" || !requestId || !pollToken) return
    const attempt = pollAttemptRef.current + 1
    pollAttemptRef.current = attempt
    const initialPoll = window.setTimeout(() => void pollRequest(attempt), 0)
    const timer = window.setInterval(() => void pollRequest(attempt), 1500)
    return () => {
      pollAttemptRef.current += 1
      window.clearTimeout(initialPoll)
      window.clearInterval(timer)
      pollInFlightRef.current = false
    }
  }, [pollRequest, pollToken, requestId, state])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const normalizedCode = initialCode.trim().toUpperCase()
      if (normalizedCode && requestFromURL) {
        const stored = readStoredJoin(normalizedCode, requestFromURL)
        if (stored) {
          setCode(stored.code)
          setSourceName(stored.sourceName)
          setRequestId(stored.requestId)
          setPollToken(stored.pollToken)
          setState("pending")
        }
      }
      setRestoring(false)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [initialCode, requestFromURL])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      joinOperationRef.current += 1
      pollAttemptRef.current += 1
      captureAttemptRef.current += 1
      intentionalCloseRef.current = true
      try {
        socketRef.current?.send(JSON.stringify({ type: "transcription.stop" }))
      } catch {
        // The socket may already be closed.
      }
      socketRef.current?.close()
      socketRef.current = null
      stopAudio()
    }
  }, [stopAudio])

  const submit = async () => {
    if (submitting) return
    const operation = joinOperationRef.current + 1
    joinOperationRef.current = operation
    const normalizedCode = code.trim().toUpperCase()
    const normalizedName = sourceName.trim() || "Room microphone"
    setError("")
    setSubmitting(true)
    try {
      const result = await api.post<{
        requestId: string
        pollToken: string
        sessionTitle: string
      }>("/api/v1/transcription/join-requests", {
        code: normalizedCode,
        sourceName: normalizedName,
        deviceLabel: navigator.userAgent,
      })
      if (!mountedRef.current || joinOperationRef.current !== operation) return
      const stored: StoredJoin = {
        code: normalizedCode,
        requestId: result.requestId,
        pollToken: result.pollToken,
        sourceName: normalizedName,
      }
      saveStoredJoin(stored)
      replaceJoinURL(normalizedCode, result.requestId)
      setCode(normalizedCode)
      setSourceName(normalizedName)
      setRequestId(result.requestId)
      setPollToken(result.pollToken)
      setTitle(result.sessionTitle)
      setState("pending")
    } catch (caught) {
      if (!mountedRef.current || joinOperationRef.current !== operation) return
      setError(
        caught instanceof Error
          ? caught.message
          : "The room code could not be accepted."
      )
    } finally {
      if (mountedRef.current && joinOperationRef.current === operation)
        setSubmitting(false)
    }
  }

  const toggleMicrophone = async () => {
    if (microphoneActive) {
      captureAttemptRef.current += 1
      stopAudio()
      if (socketRef.current?.readyState === WebSocket.OPEN)
        socketRef.current.send(JSON.stringify({ type: "source.pause" }))
      setState("paused")
      return
    }
    setError("")
    const attempt = captureAttemptRef.current + 1
    captureAttemptRef.current = attempt
    try {
      await startMicrophone(attempt)
    } catch (caught) {
      if (
        !mountedRef.current ||
        intentionalCloseRef.current ||
        captureAttemptRef.current !== attempt
      )
        return
      setError(
        caught instanceof Error
          ? caught.message
          : "The microphone could not be started."
      )
    }
  }

  const leaveRoom = () => {
    joinOperationRef.current += 1
    pollAttemptRef.current += 1
    captureAttemptRef.current += 1
    intentionalCloseRef.current = true
    setSubmitting(false)
    try {
      socketRef.current?.send(JSON.stringify({ type: "transcription.stop" }))
    } catch {
      // The socket may already be closed.
    }
    socketRef.current?.close()
    socketRef.current = null
    stopAudio()
    clearStoredJoin(code)
    replaceJoinURL(code)
    sourceIdRef.current = null
    setCurrentSourceId(null)
    setSnapshot(null)
    setPartial("")
    setPartialSourceId(null)
    setPartialSpeakerId(null)
    setState("form")
    setError("")
  }

  if (restoring) {
    return <main className="min-h-svh flex-1 bg-background" />
  }

  if (snapshot && state !== "form") {
    return (
      <TranscriptionParticipantRoom
        connectionState={
          state === "pending"
            ? "connecting"
            : state === "paused"
              ? "paused"
              : "connected"
        }
        currentSourceId={currentSourceId}
        error={error}
        level={level}
        microphoneActive={microphoneActive}
        onLeaveRoom={leaveRoom}
        onToggleMicrophone={toggleMicrophone}
        partial={partial}
        partialSourceId={partialSourceId}
        partialSpeakerId={partialSpeakerId}
        snapshot={snapshot}
      />
    )
  }

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Radio />
          </div>
          <CardTitle>
            {state === "connected"
              ? "Microphone connected"
              : "Join live transcription"}
          </CardTitle>
          <CardDescription>
            {state === "connected"
              ? `You are sending audio to ${title}. Keep this tab open.`
              : "Choose a unique microphone name. The host must approve the connection before any audio is sent."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not join</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {state === "form" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="room-code">Room code</FieldLabel>
                <Input
                  autoComplete="one-time-code"
                  id="room-code"
                  maxLength={8}
                  onChange={(event) =>
                    setCode(event.target.value.toUpperCase())
                  }
                  placeholder="8 characters"
                  value={code}
                />
                <FieldDescription>
                  The room link keeps this code in the address bar for
                  refreshes.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="source-name">Microphone name</FieldLabel>
                <Input
                  id="source-name"
                  onChange={(event) => setSourceName(event.target.value)}
                  placeholder="Conference room mic"
                  value={sourceName}
                />
                <FieldDescription>
                  This name must be unique in the room and appears beside your
                  transcript.
                </FieldDescription>
              </Field>
              <Button
                disabled={submitting || code.trim().length < 6}
                onClick={() => void submit()}
              >
                {submitting ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Mic data-icon="inline-start" />
                )}
                {submitting ? "Requesting…" : "Request to join"}
              </Button>
            </FieldGroup>
          ) : null}
          {state === "pending" ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <Spinner />
              <div>
                <p className="font-medium">Waiting for host approval</p>
                <p className="text-sm text-muted-foreground">
                  No microphone audio is sent yet. This page will reconnect
                  after approval.
                </p>
              </div>
            </div>
          ) : null}
          {state === "approved" ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <LoaderCircle className="animate-spin text-primary" />
              <p className="font-medium">Connecting microphone…</p>
            </div>
          ) : null}
          {state === "paused" ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <VoiceOrb className="size-40" state="idle" volume={0} />
              <div>
                <p className="font-medium">Microphone paused</p>
                <p className="text-sm text-muted-foreground">
                  You remain in the room and can restart capture at any time.
                </p>
              </div>
              <Button onClick={() => void toggleMicrophone()}>
                <Mic data-icon="inline-start" /> Start microphone
              </Button>
            </div>
          ) : null}
          {state === "connected" && !snapshot ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <VoiceOrb
                className="size-40"
                state={level > 0.12 ? "speaking" : "listening"}
                volume={level}
              />
              <div>
                <p className="font-medium">{sourceName || "Room microphone"}</p>
                <p className="text-sm text-muted-foreground">
                  Signal {Math.round(level * 100)}% · audio is live
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck /> Approved by the session host
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Check /> Keep this window open while speaking
              </div>
              <Button onClick={() => void toggleMicrophone()} variant="outline">
                Stop microphone
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  )
}
