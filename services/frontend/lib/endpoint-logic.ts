import type { Endpoint, EndpointKind } from "@/lib/types"

export type EndpointForm = {
  name: string
  endpointKind: EndpointKind
  providerType: string
  scopeType: string
  scopeId: string
  baseUrl: string
  apiPath: string
  apiVersion: string
  chatModel: string
  visionModel: string
  embeddingModel: string
  imageModel: string
  transcriptionModel: string
  diarizationModel: string
  speechModel: string
  timeoutSeconds: number
  maxOutputTokens: number
  temperature: number
  realtimeTranscription: boolean
  chunkedTranscription: boolean
  diarization: boolean
  useForChat: boolean
  toolCalling: boolean
  vision: boolean
  credential: string
  enabled: boolean
  isDefault: boolean
}

export type DiscoveredChatModel = {
  id: string
  name?: string
  ownedBy?: string
}

export type SupportedProvider = {
  id: string
  name?: string
  kind?: string
  examples?: string[]
  capabilities: string[]
  endpointKinds?: EndpointKind[]
}

export type ProviderDetails = {
  label: string
  description: string
  baseUrl: string
  capabilities: string[]
  endpointKinds: EndpointKind[]
}

export const defaults: EndpointForm = {
  name: "My endpoint",
  endpointKind: "llm",
  providerType: "openai-compatible",
  scopeType: "organization",
  scopeId: "",
  baseUrl: "http://localhost:4000/v1",
  apiPath: "",
  apiVersion: "",
  chatModel: "",
  visionModel: "",
  embeddingModel: "",
  imageModel: "gpt-image-1",
  transcriptionModel: "",
  diarizationModel: "",
  speechModel: "",
  timeoutSeconds: 120,
  maxOutputTokens: 2048,
  temperature: 0.2,
  realtimeTranscription: false,
  chunkedTranscription: false,
  diarization: false,
  useForChat: true,
  toolCalling: false,
  vision: false,
  credential: "",
  enabled: true,
  isDefault: false,
}

export const providerDetails: Record<string, ProviderDetails> = {
  openai: {
    label: "OpenAI",
    description: "Native Chat Completions and Realtime transcription.",
    baseUrl: "https://api.openai.com/v1",
    capabilities: [
      "chat",
      "vision",
      "image-generation",
      "embeddings",
      "transcription",
      "realtime-transcription",
      "diarization",
      "tool-calling",
      "tts",
    ],
    endpointKinds: ["llm", "diarization"],
  },
  gemini: {
    label: "Google Gemini",
    description: "Native Gemini generateContent endpoint.",
    baseUrl: "https://generativelanguage.googleapis.com",
    capabilities: [
      "chat",
      "vision",
      "embeddings",
      "transcription",
      "realtime-transcription",
      "diarization",
    ],
    endpointKinds: ["llm", "diarization"],
  },
  anthropic: {
    label: "Anthropic",
    description: "Native Messages API endpoint.",
    baseUrl: "https://api.anthropic.com",
    capabilities: ["chat", "vision"],
    endpointKinds: ["llm"],
  },
  ollama: {
    label: "Ollama",
    description: "Local Ollama chat and embedding models.",
    baseUrl: "http://localhost:11434",
    capabilities: ["chat", "vision", "embeddings"],
    endpointKinds: ["llm"],
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    description: "LiteLLM, vLLM, LM Studio, OpenRouter, or another gateway.",
    baseUrl: "http://localhost:4000/v1",
    capabilities: [
      "chat",
      "vision",
      "image-generation",
      "embeddings",
      "transcription",
      "realtime-transcription",
      "chunked-transcription",
      "diarization",
      "tool-calling",
      "tts",
    ],
    endpointKinds: ["llm", "diarization"],
  },
  pyannote: {
    label: "Pyannote (self-hosted)",
    description: "A dedicated pyannote.audio speaker-diarization service.",
    baseUrl: "http://localhost:8000",
    capabilities: ["diarization"],
    endpointKinds: ["diarization"],
  },
  mock: {
    label: "JustAI demo",
    description: "A local response stream for exploring the UI.",
    baseUrl: "http://mock.local",
    capabilities: ["chat"],
    endpointKinds: ["llm"],
  },
}

export const fallbackSupportedProviders: SupportedProvider[] = Object.entries(
  providerDetails
).map(([id, details]) => ({
  id,
  name: details.label,
  capabilities: details.capabilities,
  endpointKinds: details.endpointKinds,
}))

export function isWhisperGateway(providerType: string, model: string) {
  return providerType === "openai-compatible" && /whisper/i.test(model)
}

export function endpointKindFor(endpoint: Endpoint): EndpointKind {
  if (
    endpoint.endpointKind === "diarization" ||
    endpoint.endpointKind === "llm"
  ) {
    return endpoint.endpointKind
  }
  return endpoint.capabilities.chat ? "llm" : "diarization"
}

export function providerSupports(
  providers: SupportedProvider[],
  providerId: string,
  capability: string
) {
  const provider = providers.find((item) => item.id === providerId)
  if (provider) return provider.capabilities.includes(capability)
  return providerDetails[providerId]?.capabilities.includes(capability) ?? false
}

export function providerSupportsKind(
  providers: SupportedProvider[],
  providerId: string,
  endpointKind: EndpointKind
) {
  const provider = providers.find((item) => item.id === providerId)
  const kinds =
    provider?.endpointKinds ?? providerDetails[providerId]?.endpointKinds
  if (kinds?.length) return kinds.includes(endpointKind)
  return (
    endpointKind === "llm" ||
    providerSupports(providers, providerId, "diarization")
  )
}

export function providersForKind(
  providers: SupportedProvider[],
  endpointKind: EndpointKind
) {
  return providers.filter((provider) =>
    providerSupportsKind(providers, provider.id, endpointKind)
  )
}

export function buildEndpointCapabilities(
  form: EndpointForm,
  supports: (provider: string, capability: string) => boolean
) {
  const chat = form.endpointKind === "llm" || form.useForChat
  const hasRealtimeTranscription =
    supports(form.providerType, "realtime-transcription") &&
    form.realtimeTranscription &&
    Boolean(form.transcriptionModel.trim())
  const hasChunkedTranscription =
    supports(form.providerType, "chunked-transcription") &&
    form.chunkedTranscription &&
    Boolean(form.transcriptionModel.trim())
  const hasTranscription =
    supports(form.providerType, "transcription") &&
    Boolean(form.transcriptionModel.trim()) &&
    (hasRealtimeTranscription || hasChunkedTranscription)

  return {
    chat,
    embeddings:
      supports(form.providerType, "embeddings") &&
      Boolean(form.embeddingModel.trim()),
    "image-generation":
      supports(form.providerType, "image-generation") &&
      Boolean(form.imageModel.trim()),
    transcription: hasTranscription,
    "realtime-transcription": hasRealtimeTranscription,
    "chunked-transcription": hasChunkedTranscription,
    diarization:
      form.endpointKind === "diarization" ||
      (supports(form.providerType, "diarization") &&
        form.diarization &&
        Boolean(form.diarizationModel.trim())),
    "tool-calling":
      supports(form.providerType, "tool-calling") && form.toolCalling,
    vision: supports(form.providerType, "vision") && form.vision,
    tts: supports(form.providerType, "tts") && Boolean(form.speechModel.trim()),
  }
}
