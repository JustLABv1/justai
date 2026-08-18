import assert from "node:assert/strict"
import test from "node:test"

import {
  buildEndpointCapabilities,
  defaults,
  endpointKindFor,
  fallbackSupportedProviders,
  providerSupportsKind,
  providersForKind,
  type EndpointForm,
} from "../lib/endpoint-logic.ts"

const supports = (provider: string, capability: string) =>
  fallbackSupportedProviders
    .find((item) => item.id === provider)
    ?.capabilities.includes(capability) ?? false

function form(overrides: Partial<EndpointForm> = {}): EndpointForm {
  return { ...defaults, ...overrides }
}

test("keeps LLM and diarization setup lanes distinct", () => {
  const llmProviders = providersForKind(fallbackSupportedProviders, "llm")
  const diarizationProviders = providersForKind(
    fallbackSupportedProviders,
    "diarization"
  )

  assert.ok(llmProviders.some((provider) => provider.id === "anthropic"))
  assert.ok(!llmProviders.some((provider) => provider.id === "pyannote"))
  assert.ok(diarizationProviders.some((provider) => provider.id === "pyannote"))
  assert.ok(
    !diarizationProviders.some((provider) => provider.id === "anthropic")
  )
  assert.equal(
    providerSupportsKind(
      fallbackSupportedProviders,
      "openai-compatible",
      "diarization"
    ),
    true
  )
})

test("builds a chat-only LLM capability map by default", () => {
  const capabilities = buildEndpointCapabilities(
    form({ providerType: "openai", chatModel: "gpt-4o-mini" }),
    supports
  )

  assert.equal(capabilities.chat, true)
  assert.equal(capabilities.diarization, false)
  assert.equal(capabilities.embeddings, false)
})

test("allows a diarization endpoint to be dual purpose", () => {
  const diarization = buildEndpointCapabilities(
    form({
      endpointKind: "diarization",
      providerType: "openai-compatible",
      diarizationModel: "speaker-model",
      useForChat: false,
    }),
    supports
  )
  const dual = buildEndpointCapabilities(
    form({
      endpointKind: "diarization",
      providerType: "openai-compatible",
      diarizationModel: "speaker-model",
      chatModel: "local-chat",
      useForChat: true,
    }),
    supports
  )

  assert.equal(diarization.diarization, true)
  assert.equal(diarization.chat, false)
  assert.equal(dual.diarization, true)
  assert.equal(dual.chat, true)
})

test("uses stored endpoint kind and safely falls back for legacy data", () => {
  assert.equal(
    endpointKindFor({
      endpointKind: "diarization",
      capabilities: { chat: true },
    } as never),
    "diarization"
  )
  assert.equal(
    endpointKindFor({
      endpointKind: "",
      capabilities: { diarization: true },
    } as never),
    "diarization"
  )
  assert.equal(
    endpointKindFor({
      endpointKind: "",
      capabilities: { chat: true },
    } as never),
    "llm"
  )
})
