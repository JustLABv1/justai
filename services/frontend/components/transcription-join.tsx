"use client"

import { Check, LoaderCircle, Mic, Radio, ShieldCheck } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"

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
import { ListeningOrb } from "@/components/listening-orb"
import { Spinner } from "@/components/ui/spinner"
import { api, socketURL } from "@/lib/api"

type JoinState = "form" | "pending" | "approved" | "connected"

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

export function TranscriptionJoin() {
  const searchParams = useSearchParams()
  const [code, setCode] = useState(searchParams.get("code") ?? "")
  const [sourceName, setSourceName] = useState("")
  const [requestId, setRequestId] = useState("")
  const [pollToken, setPollToken] = useState("")
  const [state, setState] = useState<JoinState>("form")
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  const [level, setLevel] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const levelTimerRef = useRef<number | null>(null)
  const pollInFlightRef = useRef(false)

  const stopCapture = () => {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    socketRef.current?.close()
    socketRef.current = null
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    setLevel(0)
  }

  useEffect(() => () => stopCapture(), [])

  useEffect(() => {
    if (state !== "pending" || !requestId || !pollToken) return
    const timer = window.setInterval(() => {
      if (pollInFlightRef.current) return
      pollInFlightRef.current = true
      void api
        .get<{
          status: string
          sessionTitle?: string
          captureGrant?: string
          sourceId?: string
        }>(
          `/api/v1/transcription/join-requests/${requestId}?token=${encodeURIComponent(pollToken)}`
        )
        .then(async (result) => {
          setTitle(result.sessionTitle ?? "Live session")
          if (result.status === "denied" || result.status === "expired") {
            setError(
              result.status === "denied"
                ? "The host declined this microphone."
                : "This join request expired."
            )
            setState("form")
            return
          }
          if (
            result.status === "approved" &&
            result.captureGrant &&
            result.sourceId
          ) {
            window.clearInterval(timer)
            setState("approved")
            try {
              const ticket = await api.postWithAuth<{ ticket: string }>(
                "/api/v1/transcription/capture-tickets",
                result.captureGrant
              )
              const socket = new WebSocket(
                socketURL("/api/v1/ws/transcription", ticket.ticket)
              )
              socketRef.current = socket
              socket.onmessage = (message) => {
                try {
                  const event = JSON.parse(message.data) as {
                    type?: string
                    data?: { message?: string }
                  }
                  if (event.type === "error")
                    setError(
                      event.data?.message ??
                        "The transcription provider returned an error."
                    )
                } catch {
                  setError("The room sent an invalid event.")
                }
              }
              socket.onopen = async () => {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                      echoCancellation: false,
                      noiseSuppression: true,
                      autoGainControl: true,
                    },
                  })
                  streamRef.current = stream
                  const context = new AudioContext()
                  contextRef.current = context
                  await context.audioWorklet.addModule("/audio-worklet.js")
                  const source = context.createMediaStreamSource(stream)
                  const analyser = context.createAnalyser()
                  analyser.fftSize = 256
                  const node = new AudioWorkletNode(
                    context,
                    "justai-pcm-processor"
                  )
                  workletRef.current = node
                  const gain = context.createGain()
                  gain.gain.value = 0
                  source.connect(analyser)
                  source.connect(node)
                  node.connect(gain)
                  gain.connect(context.destination)
                  let sequence = 0
                  node.port.onmessage = (
                    message: MessageEvent<Float32Array>
                  ) => {
                    if (socket.readyState !== WebSocket.OPEN) return
                    const samples = downsample(
                      message.data,
                      context.sampleRate,
                      16000
                    )
                    const frame = new ArrayBuffer(17 + samples.length * 2)
                    const view = new DataView(frame)
                    view.setUint8(0, 1)
                    view.setBigUint64(1, BigInt(Date.now()), true)
                    view.setUint32(9, sequence, true)
                    view.setUint32(13, 16000, true)
                    samples.forEach((value, index) =>
                      view.setInt16(
                        17 + index * 2,
                        Math.max(-1, Math.min(1, value)) *
                          (value < 0 ? 0x8000 : 0x7fff),
                        true
                      )
                    )
                    sequence += 1
                    socket.send(frame)
                  }
                  const meter = new Uint8Array(analyser.fftSize)
                  levelTimerRef.current = window.setInterval(() => {
                    analyser.getByteTimeDomainData(meter)
                    let total = 0
                    meter.forEach((value) => {
                      const normalized = (value - 128) / 128
                      total += normalized * normalized
                    })
                    const nextLevel = Math.min(
                      1,
                      Math.sqrt(total / meter.length) * 3
                    )
                    setLevel(nextLevel)
                    if (socket.readyState === WebSocket.OPEN)
                      socket.send(
                        JSON.stringify({
                          type: "source.level",
                          level: nextLevel,
                        })
                      )
                  }, 100)
                  await context.resume()
                  socket.send(
                    JSON.stringify({
                      type: "transcription.start",
                      sourceId: result.sourceId,
                    })
                  )
                  setState("connected")
                } catch (caught) {
                  stopCapture()
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Microphone permission was denied."
                  )
                  setState("form")
                }
              }
              socket.onerror = () => {
                setError("The room connection failed.")
                stopCapture()
              }
              socket.onclose = () => {
                if (socketRef.current === socket) {
                  stopCapture()
                  setError("The room connection closed.")
                  setState("form")
                }
              }
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Microphone permission was denied."
              )
              setState("form")
            }
          }
        })
        .catch((caught) =>
          setError(
            caught instanceof Error
              ? caught.message
              : "The request could not be checked."
          )
        )
        .finally(() => {
          pollInFlightRef.current = false
        })
    }, 1500)
    return () => {
      window.clearInterval(timer)
      pollInFlightRef.current = false
    }
  }, [pollToken, requestId, state])

  const submit = async () => {
    if (submitting) return
    setError("")
    setSubmitting(true)
    try {
      const result = await api.post<{
        requestId: string
        pollToken: string
        sessionTitle: string
      }>("/api/v1/transcription/join-requests", {
        code: code.trim().toUpperCase(),
        sourceName: sourceName.trim() || "Room microphone",
        deviceLabel: navigator.userAgent,
      })
      setRequestId(result.requestId)
      setPollToken(result.pollToken)
      setTitle(result.sessionTitle)
      setState("pending")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The room code could not be accepted."
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8">
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
              : "Choose a name for this microphone. The host must approve the connection before any audio is sent."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Could not join</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {state === "form" && (
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
                  This name is shown beside every transcript segment from this
                  device.
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
                )}{" "}
                {submitting ? "Requesting…" : "Request to join"}
              </Button>
            </FieldGroup>
          )}
          {state === "pending" && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <Spinner />
              <div>
                <p className="font-medium">Waiting for host approval</p>
                <p className="text-sm text-muted-foreground">
                  No microphone audio is sent yet.
                </p>
              </div>
            </div>
          )}
          {state === "approved" && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <LoaderCircle className="animate-spin text-primary" />
              <p className="font-medium">Connecting microphone…</p>
            </div>
          )}
          {state === "connected" && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <ListeningOrb
                className="max-w-[15rem]"
                level={level}
                state={level > 0.12 ? "speaking" : "listening"}
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
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-150"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Check /> Keep this window open while speaking
              </div>
              <Button
                onClick={() => {
                  stopCapture()
                  setState("form")
                }}
                variant="outline"
              >
                Stop microphone
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
