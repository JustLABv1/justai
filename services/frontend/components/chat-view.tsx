"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bot, Mic, MicOff } from "lucide-react"

import Ai04, { type Ai04Action } from "@/components/ai-04"
import {
  Attachment,
  AttachmentActions,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { api, socketURL } from "@/lib/api"
import type { ChatMessage, Citation, Endpoint, ViewId } from "@/lib/types"

type SocketEnvelope = {
  type: string
  data?: Record<string, unknown>
}

type Props = {
  endpoints: Endpoint[]
  onNavigate?: (view: ViewId) => void
}

const demoResponse =
  "This is a local demo response. Start the Go backend and connect an endpoint to stream a real model response."

export function ChatView({ endpoints, onNavigate }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [connectionState, setConnectionState] = useState("Ready")
  const [activeAssistantId, setActiveAssistantId] = useState("")
  const [recording, setRecording] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [transcriptionStatus, setTranscriptionStatus] = useState("Ready")
  const socketRef = useRef<WebSocket | null>(null)
  const transcriptionSocketRef = useRef<WebSocket | null>(null)
  const assistantIdRef = useRef("")
  const requestRef = useRef(0)
  const responseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const finalTranscriptRef = useRef("")
  const partialTranscriptRef = useRef("")
  const startingTranscriptionRef = useRef(false)

  const activeEndpoint =
    endpoints.find((endpoint) => endpoint.isDefault) ?? endpoints[0]

  const cleanupTranscriptionResources = useCallback(() => {
    transcriptionSocketRef.current?.close()
    transcriptionSocketRef.current = null
    audioProcessorRef.current?.disconnect()
    audioProcessorRef.current = null
    audioSourceRef.current?.disconnect()
    audioSourceRef.current = null
    audioStreamRef.current?.getTracks().forEach((track) => track.stop())
    audioStreamRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      socketRef.current?.close()
      if (responseTimerRef.current) clearTimeout(responseTimerRef.current)
      cleanupTranscriptionResources()
    }
  }, [cleanupTranscriptionResources])

  const updateAssistant = useCallback(
    (update: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantIdRef.current ? update(message) : message
        )
      )
    },
    []
  )

  const handleSocketMessage = useCallback(
    (event: MessageEvent<string>) => {
      let envelope: SocketEnvelope
      try {
        envelope = JSON.parse(event.data) as SocketEnvelope
      } catch {
        return
      }

      const data = envelope.data ?? {}
      if (envelope.type === "session.ready") setConnectionState("Connected")
      if (envelope.type === "message.accepted") setConnectionState("Thinking")
      if (envelope.type === "message.delta") {
        setStreaming(true)
        updateAssistant((message) => ({
          ...message,
          content: message.content + String(data.delta ?? ""),
        }))
      }
      if (envelope.type === "retrieval.completed") {
        updateAssistant((message) => ({
          ...message,
          citations: (data.citations ?? []) as Citation[],
        }))
      }
      if (envelope.type === "message.completed") {
        setStreaming(false)
        setConnectionState("Connected")
        if (typeof data.content === "string")
          updateAssistant((message) => ({
            ...message,
            content: data.content as string,
          }))
      }
      if (envelope.type === "error") {
        setStreaming(false)
        setConnectionState("Needs attention")
        updateAssistant((message) => ({
          ...message,
          content: String(data.message ?? "The model returned an error."),
        }))
      }
    },
    [updateAssistant]
  )

  const handleTranscriptionMessage = useCallback(
    (event: MessageEvent<string>) => {
      let envelope: SocketEnvelope
      try {
        envelope = JSON.parse(event.data) as SocketEnvelope
      } catch {
        return
      }

      const data = envelope.data ?? {}
      const text = String(data.text ?? "").trim()
      if (envelope.type === "transcription.ready") {
        setTranscriptionStatus("Listening")
        return
      }
      if (envelope.type === "transcription.partial" && text) {
        partialTranscriptRef.current = text.startsWith("Listening…")
          ? text
          : [partialTranscriptRef.current, text].filter(Boolean).join(" ")
        setTranscript(
          [finalTranscriptRef.current, partialTranscriptRef.current]
            .filter(Boolean)
            .join(" ")
        )
        return
      }
      if (envelope.type === "transcription.final") {
        if (text) {
          finalTranscriptRef.current = [finalTranscriptRef.current, text]
            .filter(Boolean)
            .join(" ")
          partialTranscriptRef.current = ""
          setTranscript(finalTranscriptRef.current)
        }
        setTranscriptionStatus("Listening")
        return
      }
      if (envelope.type === "transcription.stopped") {
        setTranscriptionStatus("Ready")
        return
      }
      if (envelope.type === "error") {
        setRecording(false)
        setTranscriptionStatus("Needs attention")
        setTranscript(text || "The transcription endpoint returned an error.")
      }
    },
    []
  )

  const stopTranscription = useCallback(() => {
    if (transcriptionSocketRef.current?.readyState === WebSocket.OPEN) {
      transcriptionSocketRef.current.send(
        JSON.stringify({ type: "transcription.stop" })
      )
    }
    cleanupTranscriptionResources()
    setRecording(false)
    setTranscriptionStatus("Ready")
  }, [cleanupTranscriptionResources])

  async function toggleTranscription() {
    if (recording) {
      stopTranscription()
      return
    }
    if (startingTranscriptionRef.current) return
    if (!activeEndpoint) {
      setTranscript(
        "Connect an endpoint with transcription enabled to start live transcription."
      )
      setTranscriptionStatus("Endpoint required")
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setTranscript("This browser does not expose microphone access.")
      setTranscriptionStatus("Needs attention")
      return
    }

    startingTranscriptionRef.current = true
    setTranscriptionStatus("Starting")
    setTranscript("")
    finalTranscriptRef.current = ""
    partialTranscriptRef.current = ""

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream
      const response = await api.post<{ ticket: string }>(
        "/api/v1/ws/tickets",
        { kind: "transcription" }
      )
      const socket = new WebSocket(
        socketURL("/api/v1/ws/transcription", response.ticket)
      )
      socket.onmessage = handleTranscriptionMessage
      socket.onclose = () => {
        setRecording(false)
        setTranscriptionStatus("Ready")
      }

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () =>
          reject(new Error("Could not connect to the transcription socket"))
      })

      transcriptionSocketRef.current = socket
      socket.send(
        JSON.stringify({
          type: "transcription.start",
          endpointId: activeEndpoint.id,
          model: activeEndpoint.transcriptionModel ?? "",
        })
      )

      const audioContextConstructor =
        window.AudioContext ??
        (window as Window & {
          webkitAudioContext?: typeof AudioContext
        }).webkitAudioContext
      if (!audioContextConstructor) {
        throw new Error("This browser does not support the Web Audio API")
      }
      const audioContext = new audioContextConstructor()
      await audioContext.resume()
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const mute = audioContext.createGain()
      mute.gain.value = 0
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        const samples = downsample(input, audioContext.sampleRate, 24_000)
        socket.send(encodePCM16(samples))
      }
      source.connect(processor)
      processor.connect(mute)
      mute.connect(audioContext.destination)
      audioContextRef.current = audioContext
      audioSourceRef.current = source
      audioProcessorRef.current = processor
      setRecording(true)
      setTranscriptionStatus("Listening")
    } catch {
      cleanupTranscriptionResources()
      setRecording(false)
      setTranscriptionStatus("Needs attention")
      setTranscript(
        "Live transcription needs microphone permission and a connected transcription endpoint."
      )
    } finally {
      startingTranscriptionRef.current = false
    }
  }

  function handleAction(action: Ai04Action) {
    if (action === "transcription") {
      void toggleTranscription()
      return
    }
    onNavigate?.(action)
  }

  async function openChatSocket() {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      return socketRef.current

    const response = await api.post<{ ticket: string }>("/api/v1/ws/tickets", {
      kind: "chat",
    })
    const socket = new WebSocket(socketURL("/api/v1/ws/chat", response.ticket))
    socket.onmessage = handleSocketMessage
    socket.onclose = () => setConnectionState("Offline")
    socket.onerror = () => setConnectionState("Needs attention")

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () =>
        reject(new Error("Could not connect to the chat socket"))
    })

    socketRef.current = socket
    socket.send(
      JSON.stringify({
        type: "session.start",
        requestId: "session",
        data: { endpointId: activeEndpoint?.id ?? "" },
      })
    )
    return socket
  }

  async function sendMessage(content: string) {
    const prompt = content.trim()
    if (!prompt || streaming) return

    const requestId = `request-${++requestRef.current}`
    const assistantId = `assistant-${requestId}`
    assistantIdRef.current = assistantId
    setActiveAssistantId(assistantId)
    setMessages((current) => [
      ...current,
      { id: `user-${requestId}`, role: "user", content: prompt },
      { id: assistantId, role: "assistant", content: "" },
    ])
    setStreaming(true)
    setConnectionState("Connecting")

    try {
      const socket = await openChatSocket()
      socket.send(
        JSON.stringify({
          type: "message.send",
          requestId,
          data: {
            content: prompt,
            endpointId: activeEndpoint?.id ?? "",
          },
        })
      )
    } catch {
      setConnectionState("Demo response")
      responseTimerRef.current = setTimeout(() => {
        setStreaming(false)
        updateAssistant((message) => ({ ...message, content: demoResponse }))
      }, 350)
    }
  }

  if (messages.length === 0) {
    return (
      <div className="flex min-h-[calc(100svh-4rem)] items-center justify-center">
        <div className="w-full">
          {transcript && (
            <TranscriptionCard
              recording={recording}
              status={transcriptionStatus}
              transcript={transcript}
              onToggle={() => void toggleTranscription()}
            />
          )}
          <Ai04
            onAction={handleAction}
            onSubmit={(prompt) => void sendMessage(prompt)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100svh-4rem)] min-w-0 flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
              {messages.map((message) => (
                <MessageScrollerItem key={message.id}>
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageAvatar
                      className={
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground"
                      }
                    >
                      {message.role === "user" ? (
                        <span className="text-xs font-semibold">You</span>
                      ) : (
                        <Bot aria-hidden="true" />
                      )}
                    </MessageAvatar>
                    <MessageContent>
                      <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                        <span>
                          {message.role === "user" ? "You" : "JustAI"}
                        </span>
                        {message.role === "assistant" && (
                          <Badge
                            className="h-5 px-1.5 text-[10px]"
                            variant="outline"
                          >
                            assistant
                          </Badge>
                        )}
                      </div>
                      <Bubble
                        align={message.role === "user" ? "end" : "start"}
                        variant={message.role === "user" ? "default" : "muted"}
                      >
                        <BubbleContent className="whitespace-pre-wrap">
                          {message.content ||
                            (streaming && message.id === activeAssistantId ? (
                              <Spinner />
                            ) : null)}
                        </BubbleContent>
                      </Bubble>
                      {!!message.citations?.length && (
                        <div className="flex flex-wrap gap-1.5 px-3">
                          {message.citations.map((citation) => (
                            <Badge
                              className="max-w-full truncate font-normal"
                              key={`${citation.sourceId}-${citation.chunkIndex}`}
                              variant="secondary"
                            >
                              {citation.title}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-8 sm:pb-6">
        {transcript && (
          <TranscriptionCard
            recording={recording}
            status={transcriptionStatus}
            transcript={transcript}
            onToggle={() => void toggleTranscription()}
          />
        )}
        <Ai04 compact onSubmit={(prompt) => void sendMessage(prompt)} />
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          {connectionState} · Responses use your connected JustAI endpoint.
        </p>
      </div>
    </div>
  )
}

function TranscriptionCard({
  recording,
  status,
  transcript,
  onToggle,
}: {
  recording: boolean
  status: string
  transcript: string
  onToggle: () => void
}) {
  return (
    <Attachment
      className="mb-3 w-full"
      state={recording ? "processing" : "done"}
    >
      <AttachmentMedia>
        {recording ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{status}</AttachmentTitle>
        <AttachmentDescription className="whitespace-normal">
          {transcript}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          aria-label={recording ? "Stop live transcription" : "Start live transcription"}
          onClick={onToggle}
          title={recording ? "Stop live transcription" : "Start live transcription"}
        >
          {recording ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

function downsample(
  input: Float32Array,
  sourceRate: number,
  targetRate: number
) {
  if (targetRate === sourceRate) return input

  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.round(input.length / ratio))
  let inputOffset = 0

  for (let outputOffset = 0; outputOffset < output.length; outputOffset++) {
    const nextInputOffset = Math.min(
      input.length,
      Math.round((outputOffset + 1) * ratio)
    )
    let sum = 0
    let count = 0
    for (; inputOffset < nextInputOffset; inputOffset++) {
      sum += input[inputOffset]
      count++
    }
    output[outputOffset] = count > 0 ? sum / count : 0
  }
  return output
}

function encodePCM16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  for (let index = 0; index < input.length; index++) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return buffer
}
