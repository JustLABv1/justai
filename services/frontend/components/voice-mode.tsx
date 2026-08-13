"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  AudioLines,
  Check,
  Loader2,
  Mic,
  MicOff,
  ShieldCheck,
  Volume2,
  X,
  XCircle,
} from "lucide-react"

import Strands from "@/components/Strands"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { api, socketURL } from "@/lib/api"
import type { Conversation, Endpoint } from "@/lib/types"
import { cn } from "@/lib/utils"

type VoiceActivity =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "awaiting approval"
  | "speaking"
  | "error"

type VoiceSocketEvent = {
  type: string
  data?: Record<string, unknown>
}

type Approval = {
  approvalId: string
  callId?: string
  serverName?: string
  toolName?: string
  arguments?: Record<string, unknown>
  deciding?: boolean
}

type Props = {
  open: boolean
  conversationId: string | null
  endpoints: Endpoint[]
  onClose: () => void
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
}

function isTranscriptionEndpoint(endpoint: Endpoint) {
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, "transcription")) {
    return Boolean(capabilities.transcription)
  }
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "chunked-transcription")
  ) {
    return Boolean(capabilities["chunked-transcription"])
  }
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "realtime-transcription")
  ) {
    return Boolean(capabilities["realtime-transcription"])
  }
  return (
    endpoint.providerType === "openai" || endpoint.providerType === "gemini"
  )
}

function downsample(
  input: Float32Array,
  sourceRate: number,
  targetRate: number
) {
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const length = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.ceil((index + 1) * ratio))
    let total = 0
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      total += input[inputIndex]
    }
    output[index] = end > start ? total / (end - start) : 0
  }
  return output
}

function rms(input: Float32Array) {
  if (input.length === 0) return 0
  let total = 0
  for (const value of input) total += value * value
  return Math.sqrt(total / input.length)
}

function encodePCM16(input: Float32Array) {
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

function encodeAudioFrame(pcm: ArrayBuffer, sequence: number) {
  const frame = new ArrayBuffer(17 + pcm.byteLength)
  const view = new DataView(frame)
  view.setUint8(0, 1)
  view.setBigUint64(1, BigInt(Date.now()), true)
  view.setUint32(9, sequence, true)
  view.setUint32(13, 16000, true)
  new Uint8Array(frame, 17).set(new Uint8Array(pcm))
  return frame
}

function activityLabel(activity: VoiceActivity) {
  switch (activity) {
    case "awaiting approval":
      return "Approval needed"
    case "transcribing":
      return "Transcribing"
    case "thinking":
      return "Thinking"
    case "speaking":
      return "Speaking"
    case "listening":
      return "Listening"
    case "error":
      return "Needs attention"
    default:
      return "Voice Mode"
  }
}

export function VoiceMode({
  open,
  conversationId,
  endpoints,
  onClose,
  onConversationCreated,
  onConversationUpdated,
}: Props) {
  const [activity, setActivity] = useState<VoiceActivity>("idle")
  const [partialTranscript, setPartialTranscript] = useState("")
  const [lastTranscript, setLastTranscript] = useState("")
  const [assistantText, setAssistantText] = useState("")
  const [inputLevel, setInputLevel] = useState(0)
  const [outputLevel, setOutputLevel] = useState(0)
  const [error, setError] = useState("")
  const [approval, setApproval] = useState<Approval | null>(null)
  const [connected, setConnected] = useState(false)
  const [sessionActive, setSessionActive] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelTimerRef = useRef<number | null>(null)
  const conversationRef = useRef(conversationId)
  const sessionStartedRef = useRef(false)
  const speakingRef = useRef(false)
  const mountedRef = useRef(true)
  const bargeInRef = useRef(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const outputContextRef = useRef<AudioContext | null>(null)
  const outputAnalyserRef = useRef<AnalyserNode | null>(null)
  const outputSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const outputFrameRef = useRef<number | null>(null)
  const outputObjectUrlRef = useRef<string | null>(null)

  const chatEndpoint = useMemo(() => {
    const chatEndpoints = endpoints.filter(
      (endpoint) => endpoint.enabled && endpoint.capabilities?.chat
    )
    return chatEndpoints.find((endpoint) => endpoint.isDefault) ?? chatEndpoints[0]
  }, [endpoints])
  const transcriptionEndpoint = useMemo(
    () => endpoints.find(isTranscriptionEndpoint),
    [endpoints]
  )

  useEffect(() => {
    conversationRef.current = conversationId
  }, [conversationId])

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(event))
  }, [])

  const stopOutput = useCallback(() => {
    if (outputFrameRef.current !== null) {
      cancelAnimationFrame(outputFrameRef.current)
      outputFrameRef.current = null
    }
    const audio = audioRef.current
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
    }
    outputSourceRef.current?.disconnect()
    outputAnalyserRef.current?.disconnect()
    outputSourceRef.current = null
    outputAnalyserRef.current = null
    void outputContextRef.current?.close()
    outputContextRef.current = null
    if (outputObjectUrlRef.current) {
      URL.revokeObjectURL(outputObjectUrlRef.current)
      outputObjectUrlRef.current = null
    }
    if (typeof window !== "undefined") window.speechSynthesis?.cancel()
    audioRef.current = null
    speakingRef.current = false
    setOutputLevel(0)
  }, [])

  const finishSpeaking = useCallback(() => {
    if (outputFrameRef.current !== null) {
      cancelAnimationFrame(outputFrameRef.current)
      outputFrameRef.current = null
    }
    outputSourceRef.current?.disconnect()
    outputAnalyserRef.current?.disconnect()
    void outputContextRef.current?.close()
    outputSourceRef.current = null
    outputAnalyserRef.current = null
    outputContextRef.current = null
    if (outputObjectUrlRef.current) {
      URL.revokeObjectURL(outputObjectUrlRef.current)
      outputObjectUrlRef.current = null
    }
    audioRef.current = null
    speakingRef.current = false
    setOutputLevel(0)
    if (sessionStartedRef.current && mountedRef.current)
      setActivity("listening")
  }, [])

  const speakWithBrowser = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) {
        finishSpeaking()
        return
      }
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      const startedAt = performance.now()
      const animate = (now: number) => {
        if (!speakingRef.current) return
        setOutputLevel(
          0.25 +
            Math.min(
              0.55,
              0.2 + Math.abs(Math.sin((now - startedAt) / 120)) * 0.4
            )
        )
        outputFrameRef.current = requestAnimationFrame(animate)
      }
      utterance.onstart = () => {
        speakingRef.current = true
        setActivity("speaking")
        outputFrameRef.current = requestAnimationFrame(animate)
      }
      utterance.onend = finishSpeaking
      utterance.onerror = finishSpeaking
      window.speechSynthesis.speak(utterance)
    },
    [finishSpeaking]
  )

  const playSpeechBlob = useCallback(
    async (blob: Blob, fallbackText: string) => {
      if (!sessionStartedRef.current || !mountedRef.current) return
      stopOutput()
      const objectUrl = URL.createObjectURL(blob)
      outputObjectUrlRef.current = objectUrl
      const audio = new Audio(objectUrl)
      audioRef.current = audio
      audio.preload = "auto"
      try {
        const context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        const source = context.createMediaElementSource(audio)
        source.connect(analyser)
        analyser.connect(context.destination)
        outputContextRef.current = context
        outputAnalyserRef.current = analyser
        outputSourceRef.current = source
        const levelBuffer = new Uint8Array(analyser.fftSize)
        const monitor = () => {
          if (!speakingRef.current) return
          analyser.getByteTimeDomainData(levelBuffer)
          let total = 0
          levelBuffer.forEach((value) => {
            const normalized = (value - 128) / 128
            total += normalized * normalized
          })
          setOutputLevel(
            Math.min(1, Math.sqrt(total / levelBuffer.length) * 3.5)
          )
          outputFrameRef.current = requestAnimationFrame(monitor)
        }
        audio.onplay = () => {
          speakingRef.current = true
          setActivity("speaking")
          void context.resume()
          outputFrameRef.current = requestAnimationFrame(monitor)
        }
        audio.onended = finishSpeaking
        audio.onerror = () => speakWithBrowser(fallbackText)
        await context.resume()
        await audio.play()
      } catch {
        speakWithBrowser(fallbackText)
      }
    },
    [finishSpeaking, speakWithBrowser, stopOutput]
  )

  const speakResponse = useCallback(
    async (text: string) => {
      if (!text.trim() || !sessionStartedRef.current) return
      setActivity("speaking")
      try {
        const blob = await api.postBlob("/api/v1/voice/speech", {
          text,
          endpointId: chatEndpoint?.id ?? "",
        })
        await playSpeechBlob(blob, text)
      } catch {
        speakWithBrowser(text)
      }
    },
    [chatEndpoint, playSpeechBlob, speakWithBrowser]
  )

  const cleanup = useCallback(() => {
    sessionStartedRef.current = false
    setSessionActive(false)
    setConnected(false)
    stopOutput()
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    workletRef.current?.disconnect()
    analyserRef.current?.disconnect()
    workletRef.current = null
    analyserRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    socketRef.current?.close()
    socketRef.current = null
    setInputLevel(0)
    setOutputLevel(0)
    setActivity("idle")
    setError("")
    setPartialTranscript("")
    setLastTranscript("")
    setAssistantText("")
    setApproval(null)
  }, [stopOutput])

  const handleSocketMessage = useCallback(
    (message: MessageEvent<string>) => {
      let envelope: VoiceSocketEvent
      try {
        envelope = JSON.parse(message.data) as VoiceSocketEvent
      } catch {
        return
      }
      const data = envelope.data ?? {}
      switch (envelope.type) {
        case "session.ready":
          setConnected(true)
          setActivity("listening")
          break
        case "input.transcript.partial":
          setPartialTranscript(String(data.text ?? ""))
          setActivity("transcribing")
          break
        case "input.transcript.final":
          setLastTranscript(String(data.text ?? ""))
          setPartialTranscript("")
          setAssistantText("")
          setActivity("thinking")
          break
        case "message.accepted":
        case "retrieval.started":
        case "retrieval.completed":
          setActivity("thinking")
          break
        case "message.delta":
          setAssistantText((current) => current + String(data.delta ?? ""))
          setActivity("speaking")
          break
        case "tool.approval_required":
          setApproval({
            approvalId: String(data.approvalId ?? ""),
            callId: String(data.callId ?? ""),
            serverName: String(data.serverName ?? "MCP server"),
            toolName: String(data.toolName ?? "MCP tool"),
            arguments: (data.arguments ?? {}) as Record<string, unknown>,
          })
          setActivity("awaiting approval")
          break
        case "tool.completed":
          setApproval(null)
          setActivity("thinking")
          break
        case "message.completed":
          setAssistantText(String(data.content ?? ""))
          setApproval(null)
          onConversationUpdated?.()
          void speakResponse(String(data.content ?? ""))
          break
        case "turn.cancelled":
          setApproval(null)
          setActivity("listening")
          break
        case "error":
          setError(
            String(data.message ?? "The voice session returned an error.")
          )
          setApproval(null)
          setActivity("error")
          break
      }
    },
    [onConversationUpdated, speakResponse]
  )

  const interruptOutput = useCallback(() => {
    if (!speakingRef.current || bargeInRef.current) return
    bargeInRef.current = true
    stopOutput()
    sendEvent({ type: "turn.cancel", data: {} })
    setActivity("listening")
    window.setTimeout(() => {
      bargeInRef.current = false
    }, 300)
  }, [sendEvent, stopOutput])

  const startAudio = useCallback(
    async (socket: WebSocket, stream: MediaStream) => {
      const context = new AudioContext()
      audioContextRef.current = context
      await context.audioWorklet.addModule("/audio-worklet.js")
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      const worklet = new AudioWorkletNode(context, "justai-pcm-processor")
      const silentGain = context.createGain()
      silentGain.gain.value = 0
      source.connect(analyser)
      source.connect(worklet)
      worklet.connect(silentGain)
      silentGain.connect(context.destination)
      analyserRef.current = analyser
      workletRef.current = worklet
      let sequence = 0
      let voiceUntil = 0
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (socket.readyState !== WebSocket.OPEN || !sessionStartedRef.current)
          return
        const samples = downsample(event.data, context.sampleRate, 16000)
        const level = rms(samples)
        const now = performance.now()
        if (level >= 0.01) voiceUntil = now + 650
        if (speakingRef.current && level >= 0.08) interruptOutput()
        if (now > voiceUntil) return
        socket.send(encodeAudioFrame(encodePCM16(samples), sequence))
        sequence += 1
      }
      const levelBuffer = new Uint8Array(analyser.fftSize)
      levelTimerRef.current = window.setInterval(() => {
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
        setInputLevel(nextLevel)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "source.level", level: nextLevel })
          )
        }
      }, 100)
      await context.resume()
    },
    [interruptOutput]
  )

  const startSession = useCallback(async () => {
    if (sessionStartedRef.current) return
    setError("")
    setActivity("thinking")
    if (!chatEndpoint) {
      setError("Connect a chat endpoint before starting Voice Mode.")
      setActivity("error")
      return
    }
    if (!transcriptionEndpoint) {
      setError("Voice input needs a configured transcription-capable endpoint.")
      setActivity("error")
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support microphone capture.")
      setActivity("error")
      return
    }
    try {
      let activeConversationId = conversationRef.current
      if (!activeConversationId) {
        const response = await api.post<{ conversation: Conversation }>(
          "/api/v1/conversations"
        )
        activeConversationId = response.conversation.id
        conversationRef.current = activeConversationId
        onConversationCreated?.(response.conversation)
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream
      const ticket = await api.post<{ ticket: string }>("/api/v1/ws/tickets", {
        kind: "voice",
        conversationId: activeConversationId,
      })
      const socket = new WebSocket(socketURL("/api/v1/ws/voice", ticket.ticket))
      socketRef.current = socket
      let socketOpened = false
      let rejectOpen: ((reason?: unknown) => void) | null = null
      let openTimer: number | null = null
      socket.onmessage = handleSocketMessage
      socket.onerror = () => {
        if (mountedRef.current) {
          setError("The voice connection could not be established.")
          setActivity("error")
        }
        if (!socketOpened) rejectOpen?.(new Error("Could not connect to the voice socket"))
      }
      socket.onclose = () => {
        if (!socketOpened) {
          if (openTimer !== null) window.clearTimeout(openTimer)
          if (socketRef.current === socket) socketRef.current = null
          rejectOpen?.(new Error("The voice socket closed before connecting"))
          return
        }
        if (mountedRef.current && sessionStartedRef.current) {
          // Release the microphone and reset the composer after an unexpected
          // disconnect; otherwise the dialog remains stuck in an active state
          // with no socket available for another turn.
          cleanup()
          setConnected(false)
          setError("The voice connection closed.")
          setActivity("error")
        }
      }
      await new Promise<void>((resolve, reject) => {
        rejectOpen = reject
        socket.onopen = () => {
          socketOpened = true
          rejectOpen = null
          if (openTimer !== null) window.clearTimeout(openTimer)
          resolve()
        }
        openTimer = window.setTimeout(() => {
          socket.close()
          reject(new Error("The voice socket took too long to connect"))
        }, 15_000)
      })
      sessionStartedRef.current = true
      setSessionActive(true)
      socket.send(
        JSON.stringify({
          type: "session.start",
          requestId: "voice-session",
          data: {
            conversationId: activeConversationId,
            endpointId: chatEndpoint.id,
            transcriptionEndpointId: transcriptionEndpoint.id,
            language: "auto",
          },
        })
      )
      await startAudio(socket, stream)
      setConnected(true)
      setActivity("listening")
    } catch (caught) {
      cleanup()
      setActivity("error")
      setError(
        caught instanceof Error ? caught.message : "Voice Mode could not start."
      )
    }
  }, [
    chatEndpoint,
    cleanup,
    handleSocketMessage,
    onConversationCreated,
    startAudio,
    transcriptionEndpoint,
  ])

  const closeSession = useCallback(() => {
    if (sessionStartedRef.current) {
      sendEvent({ type: "turn.cancel", data: {} })
      sendEvent({ type: "session.stop", data: {} })
    }
    cleanup()
    onClose()
  }, [cleanup, onClose, sendEvent])

  const decideApproval = useCallback(
    (approved: boolean) => {
      if (!approval || approval.deciding) return
      setApproval((current) =>
        current ? { ...current, deciding: true } : current
      )
      sendEvent({
        type: "tool.decision",
        data: { approvalId: approval.approvalId, approved },
      })
      setActivity("thinking")
    },
    [approval, sendEvent]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [cleanup])

  if (!open) return null

  const visualEnergy = Math.min(
    2.4,
    0.65 + inputLevel * 2.1 + outputLevel * 1.7
  )
  const isActive = activity !== "idle" && activity !== "error"

  return (
    <div
      aria-label="JustAI Voice Mode"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex min-h-svh flex-col overflow-y-auto bg-background text-foreground"
      role="dialog"
    >
      <header className="flex items-center justify-between border-b px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <AudioLines aria-hidden="true" size={17} />
          </div>
          <div>
            <p className="text-sm font-medium">Voice Mode</p>
            <p className="text-xs text-muted-foreground">
              {connected ? "Connected to JustAI" : "Conversation control"}
            </p>
          </div>
        </div>
        <Button
          aria-label="Close Voice Mode"
          onClick={closeSession}
          size="icon"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-4 py-6 sm:px-8 sm:py-10">
        <div className="flex w-full max-w-3xl flex-wrap items-center justify-center gap-2">
          <Badge variant={activity === "error" ? "destructive" : "secondary"}>
            {activity === "speaking" ? (
              <Volume2 aria-hidden="true" />
            ) : (
              <Mic aria-hidden="true" />
            )}
            {activityLabel(activity)}
          </Badge>
          {chatEndpoint && <Badge variant="outline">{chatEndpoint.name}</Badge>}
          {transcriptionEndpoint && (
            <Badge variant="outline">
              {transcriptionEndpoint.name} · input
            </Badge>
          )}
        </div>

        <div className="relative my-5 flex aspect-square w-full max-w-[min(76vw,34rem)] items-center justify-center overflow-hidden rounded-full border bg-muted/20 shadow-2xl shadow-primary/10 sm:my-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_62%)]" />
          <Strands
            amplitude={visualEnergy}
            className="absolute inset-0"
            colors={["#7c3aed", "#06b6d4", "#f59e0b", "#ec4899"]}
            count={isActive ? 5 : 3}
            glow={2.2 + outputLevel * 2}
            intensity={0.48 + inputLevel * 0.55 + outputLevel * 0.55}
            opacity={
              0.72 + Math.min(0.25, inputLevel * 0.2 + outputLevel * 0.2)
            }
            speed={0.35 + inputLevel * 0.45 + outputLevel * 0.65}
            thickness={0.65 + outputLevel * 0.35}
          />
          <div className="relative z-10 flex size-24 items-center justify-center rounded-full border bg-background/70 shadow-lg backdrop-blur sm:size-28">
            {activity === "error" ? (
              <AlertCircle className="text-destructive" size={30} />
            ) : activity === "speaking" ? (
              <Volume2 className="text-primary" size={30} />
            ) : activity === "thinking" || activity === "awaiting approval" ? (
              <Loader2 className="animate-spin text-primary" size={30} />
            ) : activity === "listening" || activity === "transcribing" ? (
              <Mic className="text-primary" size={30} />
            ) : (
              <MicOff className="text-muted-foreground" size={30} />
            )}
          </div>
        </div>

        <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-2">
          <Card className="min-h-28 bg-card/70">
            <CardHeader className="pb-2">
              <CardDescription>You</CardDescription>
              <CardTitle className="text-sm font-normal text-foreground">
                {partialTranscript ||
                  lastTranscript ||
                  (isActive
                    ? "Listening for your next request…"
                    : "Start when you are ready.")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-100"
                  style={{ width: `${Math.round(inputLevel * 100)}%` }}
                />
              </div>
            </CardContent>
          </Card>
          <Card className="min-h-28 bg-card/70">
            <CardHeader className="pb-2">
              <CardDescription>JustAI</CardDescription>
              <CardTitle className="text-sm font-normal text-foreground">
                {assistantText ||
                  (isActive
                    ? "I’ll respond here and read the answer aloud."
                    : "Your answer will appear here.")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-secondary-foreground transition-[width] duration-100"
                  style={{ width: `${Math.round(outputLevel * 100)}%` }}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {approval && (
          <Card className="mt-4 w-full max-w-3xl border-primary/40 shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="text-primary" size={17} />
                Approve MCP action?
              </CardTitle>
              <CardDescription>
                {approval.serverName} wants to run{" "}
                <span className="font-medium text-foreground">
                  {approval.toolName}
                </span>
                . Voice approval alone is not enough; choose an action below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-32 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                {JSON.stringify(approval.arguments ?? {}, null, 2)}
              </pre>
            </CardContent>
            <CardFooter className="gap-2">
              <Button
                disabled={approval.deciding}
                onClick={() => decideApproval(false)}
                variant="outline"
              >
                <XCircle aria-hidden="true" />
                Decline
              </Button>
              <Button
                disabled={approval.deciding}
                onClick={() => decideApproval(true)}
              >
                {approval.deciding ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                Approve action
              </Button>
            </CardFooter>
          </Card>
        )}

        {error && (
          <Alert className="mt-4 w-full max-w-3xl" variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Voice Mode needs attention</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {!sessionActive ? (
            <Button
              className="min-w-40"
              onClick={() => void startSession()}
              size="lg"
            >
              <Mic aria-hidden="true" />
              Start listening
            </Button>
          ) : (
            <Button
              className={cn(
                "min-w-40",
                activity === "speaking" && "border-primary"
              )}
              onClick={closeSession}
              size="lg"
              variant="outline"
            >
              <X aria-hidden="true" />
              End Voice Mode
            </Button>
          )}
        </div>
        <p className="mt-3 max-w-xl text-center text-xs text-muted-foreground">
          Microphone audio is streamed for transcription only and is not stored.
          Every MCP action pauses here for your explicit approval unless the
          server is explicitly trusted for read-only tools.
        </p>
      </main>
    </div>
  )
}
