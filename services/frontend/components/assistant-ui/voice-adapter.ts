"use client"

import {
  createVoiceSession,
  type RealtimeVoiceAdapter,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react"
import { api, socketURL } from "@/lib/api"

type VoiceEnvelope = { type: string; data?: Record<string, unknown> }

function downsample(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.ceil((index + 1) * ratio))
    let total = 0
    for (let cursor = start; cursor < end; cursor += 1) total += input[cursor] ?? 0
    output[index] = end > start ? total / (end - start) : 0
  }
  return output
}

function encodePCM16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  input.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
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

export function createJustAIVoiceAdapter(options: {
  conversationId: string | null
  chatEndpointId?: string
  transcriptionEndpointId?: string
  onConversationCreated?: (id: string) => void
  onToolApproval?: (approval: ToolCallMessagePartProps | null) => void
}): RealtimeVoiceAdapter {
  return {
    connect: ({ abortSignal }) =>
      createVoiceSession({ abortSignal }, async (helpers) => {
        let conversationId = options.conversationId
        if (!conversationId) {
          const response = await api.post<{ conversation: { id: string } }>("/api/v1/conversations")
          conversationId = response.conversation.id
          options.onConversationCreated?.(conversationId)
        }
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone capture.")
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        const ticket = await api.post<{ ticket: string }>("/api/v1/ws/tickets", { kind: "voice", conversationId })
        const socket = new WebSocket(socketURL("/api/v1/ws/voice", ticket.ticket))
        const audioContext = new AudioContext()
        let worklet: AudioWorkletNode | null = null
        let source: MediaStreamAudioSourceNode | null = null
        let silentGain: GainNode | null = null
        let sequence = 0
        let assistantText = ""
        let voiceMode: RealtimeVoiceAdapter.Mode = "listening"
        let outputAudio: HTMLAudioElement | null = null
        let outputURL = ""
        let closed = false
        let resolveOpen: (() => void) | null = null
        let rejectOpen: ((error: Error) => void) | null = null
        const opened = new Promise<void>((resolve, reject) => {
          resolveOpen = resolve
          rejectOpen = reject
        })

        socket.onopen = () => {
          resolveOpen?.()
          socket.send(JSON.stringify({ type: "session.start", requestId: "voice-session", data: { conversationId, endpointId: options.chatEndpointId ?? "", transcriptionEndpointId: options.transcriptionEndpointId ?? "", language: "auto" } }))
        }
        socket.onerror = () => rejectOpen?.(new Error("The voice connection could not be established."))
        socket.onclose = () => {
          options.onToolApproval?.(null)
          outputAudio?.pause()
          if (outputURL) URL.revokeObjectURL(outputURL)
          if (!closed) helpers.end("error", new Error("The voice connection closed."))
        }
        const setMode = (mode: RealtimeVoiceAdapter.Mode) => {
          voiceMode = mode
          helpers.emitMode(mode)
        }
        const speak = async (text: string) => {
          if (!text.trim() || closed) return
          setMode("speaking")
          try {
            const blob = await api.postBlob("/api/v1/voice/speech", {
              text,
              endpointId: options.chatEndpointId ?? "",
            })
            if (closed) return
            outputURL = URL.createObjectURL(blob)
            outputAudio = new Audio(outputURL)
            outputAudio.onended = () => {
              if (outputURL) URL.revokeObjectURL(outputURL)
              outputURL = ""
              outputAudio = null
              setMode("listening")
            }
            outputAudio.onerror = () => {
              if (typeof window !== "undefined" && window.speechSynthesis) {
                const utterance = new SpeechSynthesisUtterance(text)
                utterance.onend = () => setMode("listening")
                utterance.onerror = () => setMode("listening")
                window.speechSynthesis.speak(utterance)
              } else {
                setMode("listening")
              }
            }
            await outputAudio.play()
          } catch {
            if (typeof window !== "undefined" && window.speechSynthesis) {
              const utterance = new SpeechSynthesisUtterance(text)
              utterance.onend = () => setMode("listening")
              utterance.onerror = () => setMode("listening")
              window.speechSynthesis.speak(utterance)
            } else {
              setMode("listening")
            }
          }
        }
        socket.onmessage = (event: MessageEvent<string>) => {
          let envelope: VoiceEnvelope
          try { envelope = JSON.parse(event.data) as VoiceEnvelope } catch { return }
          const data = envelope.data ?? {}
          switch (envelope.type) {
            case "session.ready":
              helpers.setStatus({ type: "running" })
              setMode("listening")
              break
            case "input.transcript.partial":
              helpers.emitTranscript({ role: "user", text: String(data.text ?? ""), isFinal: false })
              setMode("listening")
              break
            case "input.transcript.final":
              helpers.emitTranscript({ role: "user", text: String(data.text ?? ""), isFinal: true })
              setMode("speaking")
              break
            case "message.delta":
              assistantText += String(data.delta ?? "")
              helpers.emitTranscript({ role: "assistant", text: assistantText, isFinal: false })
              setMode("speaking")
              break
            case "message.completed":
              assistantText = String(data.content ?? assistantText)
              helpers.emitTranscript({ role: "assistant", text: assistantText, isFinal: true })
              void speak(assistantText)
              assistantText = ""
              setMode("speaking")
              break
            case "tool.approval_required": {
              const approvalId = String(data.approvalId ?? "")
              const callId = String(data.callId ?? "")
              const toolName = String(data.toolName ?? "MCP tool")
              const args = (data.arguments && typeof data.arguments === "object" ? data.arguments : {}) as ToolCallMessagePartProps["args"]
              options.onToolApproval?.({
                type: "tool-call",
                toolCallId: callId,
                toolName,
                args,
                argsText: JSON.stringify(args, null, 2),
                status: { type: "requires-action", reason: "interrupt" },
                approval: { id: approvalId },
                addResult: () => undefined,
                resume: () => undefined,
                respondToApproval: (response) => {
                  const approved = "approved" in response
                    ? response.approved
                    : !response.optionId.startsWith("reject")
                  const reason = response.reason
                  socket.send(JSON.stringify({
                    type: approved ? "tool.approve" : "tool.reject",
                    data: { approvalId, approved, reason },
                  }))
                  if (!approved) options.onToolApproval?.(null)
                },
              })
              setMode("speaking")
              break
            }
            case "tool.completed":
              options.onToolApproval?.(null)
              setMode("speaking")
              break
            case "error":
              helpers.end("error", new Error(String(data.message ?? "The voice session returned an error.")))
              break
          }
        }

        await opened
        await audioContext.audioWorklet.addModule("/audio-worklet.js")
        source = audioContext.createMediaStreamSource(stream)
        worklet = new AudioWorkletNode(audioContext, "justai-pcm-processor")
        silentGain = audioContext.createGain()
        silentGain.gain.value = 0
        source.connect(worklet)
        worklet.connect(silentGain)
        silentGain.connect(audioContext.destination)
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (socket.readyState !== WebSocket.OPEN || closed) return
          const samples = downsample(event.data, audioContext.sampleRate, 16000)
          let total = 0
          samples.forEach((value) => { total += value * value })
          const level = Math.min(1, Math.sqrt(total / Math.max(samples.length, 1)) * 3.2)
          helpers.emitVolume(level)
          if (voiceMode === "speaking" && level >= 0.08) {
            socket.send(JSON.stringify({ type: "turn.cancel", data: {} }))
            setMode("listening")
          }
          if (level < 0.01) return
          socket.send(encodeAudioFrame(encodePCM16(samples), sequence++))
        }
        await audioContext.resume()

        const close = () => {
          if (closed) return
          closed = true
          options.onToolApproval?.(null)
          outputAudio?.pause()
          if (outputURL) URL.revokeObjectURL(outputURL)
          socket.send(JSON.stringify({ type: "turn.cancel", data: {} }))
          socket.send(JSON.stringify({ type: "session.stop", data: {} }))
          socket.close()
          worklet?.disconnect()
          source?.disconnect()
          silentGain?.disconnect()
          stream.getTracks().forEach((track) => track.stop())
          void audioContext.close()
        }
        return {
          disconnect: () => { close(); helpers.end("cancelled") },
          mute: () => { stream.getAudioTracks().forEach((track) => { track.enabled = false }); helpers.emitMode("listening") },
          unmute: () => { stream.getAudioTracks().forEach((track) => { track.enabled = true }); helpers.emitMode("listening") },
        }
      }),
  }
}
