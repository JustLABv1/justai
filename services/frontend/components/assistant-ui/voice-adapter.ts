"use client"

import {
  createVoiceSession,
  type RealtimeVoiceAdapter,
  type ToolCallMessagePartProps,
  type VoiceSessionHelpers,
  type VoiceSessionControls,
} from "@assistant-ui/react"
import { api, socketURL } from "@/lib/api"

type VoiceEnvelope = { type: string; data?: Record<string, unknown> }

type VoiceAdapterOptions = {
  conversationId: string | null
  chatEndpointId?: string
  transcriptionEndpointId?: string
  onConversationCreated?: (id: string) => void
  onConversationUpdated?: () => void
  onToolApproval?: (approval: ToolCallMessagePartProps | null) => void
  onError?: (error: Error) => void
}

function toVoiceError(caught: unknown, fallback = "The voice session failed.") {
  if (caught instanceof Error) return caught
  if (typeof caught === "string" && caught.trim()) return new Error(caught)
  return new Error(fallback)
}

function downsample(
  input: Float32Array,
  sourceRate: number,
  targetRate: number
) {
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.ceil((index + 1) * ratio))
    let total = 0
    for (let cursor = start; cursor < end; cursor += 1) {
      total += input[cursor] ?? 0
    }
    output[index] = end > start ? total / (end - start) : 0
  }
  return output
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

function audioContextConstructor() {
  if (typeof window === "undefined") return null
  const browserWindow = window as Window & {
    webkitAudioContext?: typeof AudioContext
  }
  return window.AudioContext ?? browserWindow.webkitAudioContext ?? null
}

async function setupVoiceSession(
  options: VoiceAdapterOptions,
  helpers: VoiceSessionHelpers
): Promise<VoiceSessionControls> {
  // Create and resume the context before the first network/permission await.
  // Otherwise browsers can reject AudioContext.resume() because the original
  // microphone click's user activation has already expired.
  const AudioContextConstructor = audioContextConstructor()
  if (!AudioContextConstructor) {
    throw new Error("This browser does not support audio capture.")
  }
  const audioContext = new AudioContextConstructor()
  void audioContext.resume().catch(() => undefined)

  let stream: MediaStream | null = null
  let socket: WebSocket | null = null
  let worklet: AudioWorkletNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let silentGain: GainNode | null = null
  let outputAudio: HTMLAudioElement | null = null
  let outputURL = ""
  let playbackToken = 0
  let closed = false
  let createdConversationId: string | null = null
  let conversationNotified = false
  let sequence = 0
  let assistantText = ""
  let voiceMode: RealtimeVoiceAdapter.Mode = "listening"
  let micResumeAt = 0
  let bargeInFrames = 0
  let resolveOpen: (() => void) | null = null
  let rejectOpen: ((error: Error) => void) | null = null
  let openSettled = false

  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = () => {
      openSettled = true
      resolve()
    }
    rejectOpen = (error) => {
      openSettled = true
      reject(error)
    }
  })

  const setMode = (mode: RealtimeVoiceAdapter.Mode) => {
    voiceMode = mode
    helpers.emitMode(mode)
  }

  const sendJSON = (value: unknown) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || closed) return
    socket.send(JSON.stringify(value))
  }

  const notifyConversationCreated = () => {
    if (!createdConversationId || conversationNotified) return
    conversationNotified = true
    options.onConversationCreated?.(createdConversationId)
  }

  // Audio produced by the assistant must never be allowed to become the next
  // user turn. Stop both playback paths (server TTS and browser speech
  // synthesis) and invalidate any TTS request that is still in flight.
  const clearAssistantPlayback = () => {
    const audio = outputAudio
    outputAudio = null
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
    }
    if (outputURL) URL.revokeObjectURL(outputURL)
    outputURL = ""
    if (typeof window !== "undefined") window.speechSynthesis?.cancel()
  }

  const stopAssistantPlayback = () => {
    playbackToken += 1
    clearAssistantPlayback()
  }

  const finishAssistantPlayback = (token: number) => {
    if (token !== playbackToken || closed) return
    clearAssistantPlayback()
    setMode("listening")
  }

  const closeResources = (sendStop = true) => {
    if (closed) return
    if (sendStop) {
      sendJSON({ type: "turn.cancel", data: {} })
      sendJSON({ type: "session.stop", data: {} })
    }
    closed = true
    options.onToolApproval?.(null)
    stopAssistantPlayback()
    if (socket && socket.readyState === WebSocket.OPEN) socket.close()
    worklet?.disconnect()
    source?.disconnect()
    silentGain?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
    void audioContext.close().catch(() => undefined)
    // Keep the runtime mounted for the whole voice session. The root route is
    // promoted only after the session ends, otherwise changing the thread id
    // would tear down the live microphone/WebSocket session.
    notifyConversationCreated()
  }

  try {
    let conversationId = options.conversationId
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.")
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    if (!conversationId) {
      const response = await api.post<{ conversation: { id: string } }>(
        "/api/v1/conversations"
      )
      conversationId = response.conversation.id
      createdConversationId = conversationId
    }
    const ticket = await api.post<{ ticket: string }>("/api/v1/ws/tickets", {
      kind: "voice",
      conversationId,
    })
    socket = new WebSocket(socketURL("/api/v1/ws/voice", ticket.ticket))

    socket.onopen = () => {
      resolveOpen?.()
      sendJSON({
        type: "session.start",
        requestId: "voice-session",
        data: {
          conversationId,
          endpointId: options.chatEndpointId ?? "",
          transcriptionEndpointId: options.transcriptionEndpointId ?? "",
          language: "auto",
        },
      })
    }
    socket.onerror = () => {
      const error = new Error("The voice connection could not be established.")
      if (!openSettled) {
        rejectOpen?.(error)
      } else if (!closed) {
        options.onError?.(error)
        closeResources(false)
        helpers.end("error", error)
      }
    }
    socket.onclose = () => {
      const error = new Error("The voice connection closed unexpectedly.")
      if (!openSettled) {
        rejectOpen?.(error)
        return
      }
      if (closed) return
      closeResources(false)
      options.onError?.(error)
      helpers.end("error", error)
    }

    const speak = async (text: string) => {
      if (!text.trim() || closed) return
      stopAssistantPlayback()
      bargeInFrames = 0
      const token = playbackToken
      setMode("speaking")

      const speakWithBrowser = () => {
        if (closed || token !== playbackToken) return
        if (typeof window !== "undefined" && window.speechSynthesis) {
          const utterance = new SpeechSynthesisUtterance(text)
          utterance.onend = () => finishAssistantPlayback(token)
          utterance.onerror = () => finishAssistantPlayback(token)
          window.speechSynthesis.speak(utterance)
        } else {
          finishAssistantPlayback(token)
        }
      }

      try {
        const blob = await api.postBlob("/api/v1/voice/speech", {
          text,
          endpointId: options.chatEndpointId ?? "",
        })
        // Barge-in can happen while the speech endpoint is still producing
        // audio. Do not start stale playback after the user has interrupted.
        if (closed || token !== playbackToken) return
        outputURL = URL.createObjectURL(blob)
        const audio = new Audio(outputURL)
        outputAudio = audio
        audio.onended = () => {
          finishAssistantPlayback(token)
        }
        audio.onerror = () => {
          speakWithBrowser()
        }
        await audio.play()
      } catch {
        speakWithBrowser()
      }
    }

    socket.onmessage = (event: MessageEvent<string>) => {
      let envelope: VoiceEnvelope
      try {
        envelope = JSON.parse(event.data) as VoiceEnvelope
      } catch {
        return
      }
      const data = envelope.data ?? {}
      switch (envelope.type) {
        case "session.ready":
          helpers.setStatus({ type: "running" })
          setMode("listening")
          break
        case "input.transcript.partial":
          helpers.emitTranscript({
            role: "user",
            text: String(data.text ?? ""),
            isFinal: false,
          })
          setMode("listening")
          break
        case "input.transcript.final":
          helpers.emitTranscript({
            role: "user",
            text: String(data.text ?? ""),
            isFinal: true,
          })
          setMode("speaking")
          break
        case "message.delta":
          assistantText += String(data.delta ?? "")
          helpers.emitTranscript({
            role: "assistant",
            text: assistantText,
            isFinal: false,
          })
          setMode("speaking")
          break
        case "message.completed":
          assistantText = String(data.content ?? assistantText)
          helpers.emitTranscript({
            role: "assistant",
            text: assistantText,
            isFinal: true,
          })
          void speak(assistantText)
          options.onConversationUpdated?.()
          assistantText = ""
          setMode("speaking")
          break
        case "tool.approval_required": {
          const approvalId = String(data.approvalId ?? "")
          const callId = String(data.callId ?? "")
          const toolName = String(data.toolName ?? "MCP tool")
          const args = (
            data.arguments && typeof data.arguments === "object"
              ? data.arguments
              : {}
          ) as ToolCallMessagePartProps["args"]
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
              const approved =
                "approved" in response
                  ? response.approved
                  : !response.optionId.startsWith("reject")
              const reason = response.reason
              sendJSON({
                type: approved ? "tool.approve" : "tool.reject",
                data: { approvalId, approved, reason },
              })
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
        case "turn.cancelled":
          // The server may acknowledge a local barge-in after the TTS request
          // has already completed. Stop any late playback as well.
          stopAssistantPlayback()
          setMode("listening")
          micResumeAt = performance.now() + 240
          break
        case "error": {
          const error = toVoiceError(
            data.message,
            "The voice session returned an error."
          )
          options.onError?.(error)
          closeResources(false)
          helpers.end("error", error)
          break
        }
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
      if (!socket || socket.readyState !== WebSocket.OPEN || closed) return
      const samples = downsample(event.data, audioContext.sampleRate, 16000)
      let total = 0
      samples.forEach((value) => {
        total += value * value
      })
      const level = Math.min(
        1,
        Math.sqrt(total / Math.max(samples.length, 1)) * 3.2
      )
      helpers.emitVolume(level)

      const now = performance.now()
      if (voiceMode === "speaking") {
        // While the assistant is speaking, never forward microphone audio to
        // Whisper. We still inspect the local level so the user can barge in,
        // then discard the triggering frame and the TTS tail before resuming
        // real microphone frames. This is the important echo-loop guard.
        if (level >= 0.08) bargeInFrames += 1
        else bargeInFrames = 0

        if (bargeInFrames >= 3) {
          bargeInFrames = 0
          stopAssistantPlayback()
          sendJSON({ type: "turn.cancel", data: {} })
          setMode("listening")
          micResumeAt = now + 240
        }

        if (voiceMode === "speaking" || now < micResumeAt) {
          const silence = new Float32Array(samples.length)
          socket.send(encodeAudioFrame(encodePCM16(silence), sequence++))
          return
        }
      } else {
        bargeInFrames = 0
        if (now < micResumeAt) {
          const silence = new Float32Array(samples.length)
          socket.send(encodeAudioFrame(encodePCM16(silence), sequence++))
          return
        }
      }
      // Keep sending PCM silence frames to the backend. The backend uses the
      // arrival of those frames to detect the end of a speech turn and flush
      // Whisper/Voxtral transcription. It still drops the silent samples
      // before forwarding them to the provider, so this does not create
      // provider-side hallucinations.
      socket.send(encodeAudioFrame(encodePCM16(samples), sequence++))
    }
    await audioContext.resume()

    return {
      disconnect: () => {
        closeResources()
        helpers.end("cancelled")
      },
      mute: () => {
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = false
        })
        helpers.emitMode("listening")
      },
      unmute: () => {
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = true
        })
        helpers.emitMode("listening")
      },
    }
  } catch (caught) {
    closeResources(false)
    throw caught
  }
}

export function createJustAIVoiceAdapter(
  options: VoiceAdapterOptions
): RealtimeVoiceAdapter {
  return {
    connect: ({ abortSignal }) =>
      createVoiceSession({ abortSignal }, async (helpers) => {
        try {
          return await setupVoiceSession(options, helpers)
        } catch (caught) {
          const error = toVoiceError(caught)
          options.onError?.(error)
          throw error
        }
      }),
  }
}
