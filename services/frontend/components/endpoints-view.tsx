"use client"

import { useEffect, useRef, useState } from "react"
import {
  CheckCircle2,
  CircleAlert,
  Cloud,
  KeyRound,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react"

import { api } from "@/lib/api"
import type { Endpoint } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"

type Props = {
  endpoints: Endpoint[]
  onChange: (endpoints: Endpoint[]) => void
  organizationRole?: string
  userId?: string
  platformAdmin?: boolean
}

type EndpointForm = {
  name: string
  providerType: string
  scopeType: string
  baseUrl: string
  apiPath: string
  chatModel: string
  embeddingModel: string
  transcriptionModel: string
  diarizationModel: string
  speechModel: string
  realtimeTranscription: boolean
  chunkedTranscription: boolean
  diarization: boolean
  toolCalling: boolean
  credential: string
  enabled: boolean
  isDefault: boolean
}

type DiscoveredChatModel = {
  id: string
  name?: string
  ownedBy?: string
}

const defaults: EndpointForm = {
  name: "My endpoint",
  providerType: "openai-compatible",
  scopeType: "organization",
  baseUrl: "http://localhost:4000/v1",
  apiPath: "",
  chatModel: "",
  embeddingModel: "",
  transcriptionModel: "",
  diarizationModel: "",
  speechModel: "",
  realtimeTranscription: false,
  chunkedTranscription: false,
  diarization: false,
  toolCalling: false,
  credential: "",
  enabled: true,
  isDefault: false,
}

const providerDetails: Record<
  string,
  { label: string; description: string; baseUrl: string }
> = {
  openai: {
    label: "OpenAI",
    description: "Native Chat Completions and Realtime transcription.",
    baseUrl: "https://api.openai.com/v1",
  },
  gemini: {
    label: "Google Gemini",
    description: "Native Gemini generateContent endpoint.",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  anthropic: {
    label: "Anthropic",
    description: "Native Messages API endpoint.",
    baseUrl: "https://api.anthropic.com",
  },
  ollama: {
    label: "Ollama",
    description: "Local Ollama chat and embedding models.",
    baseUrl: "http://localhost:11434",
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    description: "LiteLLM, vLLM, LM Studio, OpenRouter, or another gateway.",
    baseUrl: "http://localhost:4000/v1",
  },
  mock: {
    label: "JustAI demo",
    description: "A local response stream for exploring the UI.",
    baseUrl: "http://mock.local",
  },
}

function isWhisperGateway(providerType: string, model: string) {
  return providerType === "openai-compatible" && /whisper/i.test(model)
}

export function EndpointsView({
  endpoints,
  onChange,
  organizationRole,
  userId,
  platformAdmin = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [editingEndpoint, setEditingEndpoint] = useState<Endpoint | null>(null)
  const [form, setForm] = useState<EndpointForm>(defaults)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState("")
  const [notice, setNotice] = useState("")
  const [discoveredModels, setDiscoveredModels] = useState<
    DiscoveredChatModel[]
  >([])
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const discoveryRequestRef = useRef(0)
  const [capabilityMatrix, setCapabilityMatrix] = useState<
    Record<string, string[]>
  >({})

  useEffect(() => {
    void api
      .get<{ providers: Array<{ id: string; capabilities: string[] }> }>(
        "/api/v1/providers/supported"
      )
      .then((result) => {
        const next = Object.fromEntries(
          result.providers.map((provider) => [
            provider.id,
            provider.capabilities,
          ])
        )
        if (Object.keys(next).length > 0) setCapabilityMatrix(next)
      })
      .catch((caught) => {
        setNotice(
          caught instanceof Error
            ? caught.message
            : "Provider capabilities could not be loaded."
        )
      })
  }, [])

  const supports = (provider: string, capability: string) =>
    capabilityMatrix[provider]?.includes(capability) ?? false
  const canManageOrganization =
    platformAdmin ||
    organizationRole === "owner" ||
    organizationRole === "admin"
  const canManageEndpoint = (endpoint: Endpoint) => {
    if (userId === undefined && organizationRole === undefined) return true
    if (endpoint.scopeType === "user") return endpoint.scopeId === userId
    if (endpoint.scopeType === "organization") return canManageOrganization
    return platformAdmin
  }

  function update<K extends keyof EndpointForm>(
    key: K,
    value: EndpointForm[K]
  ) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function selectProvider(value: string | null) {
    const provider = value ?? "openai-compatible"
    const nativeTranscription = provider === "openai" || provider === "gemini"
    setForm((current) => ({
      ...current,
      providerType: provider,
      baseUrl: providerDetails[provider]?.baseUrl ?? current.baseUrl,
      realtimeTranscription: nativeTranscription,
      chunkedTranscription: false,
      diarization: nativeTranscription,
      toolCalling: provider === "openai",
    }))
    setDiscoveredModels([])
  }

  function resetEditor() {
    discoveryRequestRef.current += 1
    setEditingEndpoint(null)
    setDiscoveredModels([])
    setDiscoveringModels(false)
    setForm({
      ...defaults,
      scopeType: canManageOrganization ? defaults.scopeType : "user",
    })
  }

  function openCreate() {
    resetEditor()
    setNotice("")
    setOpen(true)
  }

  function openEdit(endpoint: Endpoint) {
    setEditingEndpoint(endpoint)
    const whisperGateway = isWhisperGateway(
      endpoint.providerType,
      endpoint.transcriptionModel ?? ""
    )
    const chunkedTranscription = Boolean(
      endpoint.capabilities["chunked-transcription"] ||
      whisperGateway ||
      (!endpoint.capabilities["realtime-transcription"] &&
        endpoint.capabilities.transcription)
    )
    setForm({
      name: endpoint.name,
      providerType: endpoint.providerType,
      scopeType: endpoint.scopeType,
      baseUrl: endpoint.baseUrl,
      apiPath: endpoint.apiPath ?? "",
      chatModel: endpoint.chatModel ?? "",
      embeddingModel: endpoint.embeddingModel ?? "",
      transcriptionModel: endpoint.transcriptionModel ?? "",
      diarizationModel: endpoint.diarizationModel ?? "",
      speechModel: endpoint.speechModel ?? "",
      realtimeTranscription: Boolean(
        endpoint.capabilities["realtime-transcription"] && !chunkedTranscription
      ),
      chunkedTranscription,
      diarization: Boolean(endpoint.capabilities.diarization),
      toolCalling: Boolean(endpoint.capabilities["tool-calling"]),
      credential: "",
      enabled: endpoint.enabled,
      isDefault: endpoint.isDefault,
    })
    setNotice("")
    setOpen(true)
    if (endpoint.enabled) void discoverModels(endpoint.id)
  }

  async function discoverModels(endpointId: string) {
    const requestId = ++discoveryRequestRef.current
    setDiscoveringModels(true)
    setNotice("")
    try {
      const result = await api.get<{
        models?: DiscoveredChatModel[]
        configuredModel?: string
      }>(`/api/v1/endpoints/${endpointId}/models`)
      if (requestId !== discoveryRequestRef.current) return
      const models = (result.models ?? []).filter((model) => model.id?.trim())
      setDiscoveredModels(models)
      if (models.length > 0) {
        setForm((current) => ({
          ...current,
          chatModel:
            current.chatModel || result.configuredModel || models[0].id,
        }))
      } else {
        setNotice(
          "The endpoint returned no models. You can enter a model ID manually."
        )
      }
    } catch (caught) {
      if (requestId !== discoveryRequestRef.current) return
      setDiscoveredModels([])
      setNotice(
        caught instanceof Error
          ? `Model discovery failed: ${caught.message}`
          : "Model discovery failed. Enter a model ID manually."
      )
    } finally {
      if (requestId !== discoveryRequestRef.current) return
      setDiscoveringModels(false)
    }
  }

  function closeEditor() {
    setOpen(false)
    resetEditor()
  }

  async function saveEndpoint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setNotice("")
    try {
      const capabilities = {
        chat: true,
        embeddings: Boolean(form.embeddingModel),
        "realtime-transcription":
          supports(form.providerType, "realtime-transcription") &&
          form.realtimeTranscription,
        "chunked-transcription":
          supports(form.providerType, "chunked-transcription") &&
          form.chunkedTranscription,
        diarization:
          supports(form.providerType, "diarization") &&
          form.diarization &&
          Boolean(form.diarizationModel),
        "tool-calling":
          supports(form.providerType, "tool-calling") && form.toolCalling,
        tts: supports(form.providerType, "tts") && Boolean(form.speechModel),
      }
      const payload = {
        ...form,
        capabilities,
      }
      const result = editingEndpoint
        ? await api.patch<Endpoint>(
            `/api/v1/endpoints/${editingEndpoint.id}`,
            payload
          )
        : await api.post<Endpoint>("/api/v1/endpoints", {
            ...payload,
            isDefault: form.isDefault || endpoints.length === 0,
          })
      onChange(
        editingEndpoint
          ? endpoints.map((item) => (item.id === result.id ? result : item))
          : [result, ...endpoints]
      )
      closeEditor()
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The endpoint could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }

  async function testEndpoint(endpoint: Endpoint) {
    try {
      const result = await api.post<{
        results?: Record<
          string,
          { ok: boolean; supported: boolean; tested: boolean; error?: string }
        >
      }>(`/api/v1/endpoints/${endpoint.id}/test`)
      const failed = Object.entries(result.results ?? {}).filter(
        ([, value]) => value.tested && !value.ok
      )
      setNotice(
        failed.length === 0
          ? `${endpoint.name} capability checks completed.`
          : `${endpoint.name} has ${failed.length} failing capability check${failed.length === 1 ? "" : "s"}.`
      )
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : `${endpoint.name} could not be reached. Check its URL and credential.`
      )
    }
  }

  async function removeEndpoint(endpoint: Endpoint) {
    if (
      !window.confirm(
        `Remove ${endpoint.name}? Existing conversations will keep their stored messages.`
      )
    )
      return
    setBusyId(endpoint.id)
    try {
      await api.delete(`/api/v1/endpoints/${endpoint.id}`)
      onChange(endpoints.filter((item) => item.id !== endpoint.id))
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The endpoint could not be removed."
      )
    } finally {
      setBusyId("")
    }
  }

  function toggleEndpoint(endpoint: Endpoint) {
    setBusyId(endpoint.id)
    void api
      .patch<Endpoint>(`/api/v1/endpoints/${endpoint.id}`, {
        enabled: !endpoint.enabled,
      })
      .then((updated) =>
        onChange(
          endpoints.map((item) => (item.id === endpoint.id ? updated : item))
        )
      )
      .catch((caught) => {
        setNotice(
          caught instanceof Error
            ? caught.message
            : "The endpoint could not be updated."
        )
      })
      .finally(() => {
        setBusyId("")
      })
  }

  function setDefaultEndpoint(endpoint: Endpoint) {
    setBusyId(endpoint.id)
    void api
      .patch<Endpoint>(`/api/v1/endpoints/${endpoint.id}`, {
        isDefault: true,
        enabled: true,
      })
      .then((updated) =>
        onChange(
          endpoints.map((item) =>
            item.id === endpoint.id ? updated : { ...item, isDefault: false }
          )
        )
      )
      .catch((caught) => {
        setNotice(
          caught instanceof Error
            ? caught.message
            : "The default endpoint could not be changed."
        )
      })
      .finally(() => {
        setBusyId("")
      })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="secondary">Model layer</Badge>
            <span className="text-xs text-muted-foreground">
              {endpoints.length} connected
            </span>
          </div>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">
            Endpoints that fit your stack
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Connect native providers, local runtimes, or OpenAI-compatible
            gateways. Keys are encrypted by the backend and never sent to the
            browser.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add endpoint
        </Button>
      </div>

      {notice && (
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {endpoints.map((endpoint) => {
          const details =
            providerDetails[endpoint.providerType] ??
            providerDetails["openai-compatible"]
          const manageable = canManageEndpoint(endpoint)
          return (
            <Card key={endpoint.id} className="overflow-hidden">
              <CardHeader className="flex-row items-start gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                  <ProviderIcon provider={endpoint.providerType} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{endpoint.name}</CardTitle>
                    {endpoint.isDefault && (
                      <Badge variant="outline">Default</Badge>
                    )}
                  </div>
                  <CardDescription className="mt-1">
                    {details.label} ·{" "}
                    {endpoint.chatModel || "model selected at request time"}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{endpoint.scopeType}</Badge>
                  <Badge variant="outline" className="gap-1.5">
                    <span
                      className={`size-1.5 rounded-full ${endpoint.enabled ? "bg-primary" : "bg-muted-foreground"}`}
                    />
                    {endpoint.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  {endpoint.credentialConfigured && (
                    <Badge variant="outline" className="gap-1.5">
                      <KeyRound aria-hidden="true" />
                      Credential stored
                    </Badge>
                  )}
                </div>
                <Separator className="my-4" />
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Base URL</p>
                    <p className="mt-1 truncate font-mono text-xs">
                      {endpoint.baseUrl}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Capabilities
                    </p>
                    <div className="mt-1 flex gap-1.5">
                      {Object.entries(endpoint.capabilities ?? {})
                        .filter(([, enabled]) => enabled)
                        .map(([capability]) => (
                          <Badge
                            key={capability}
                            variant="outline"
                            className="text-[10px]"
                          >
                            {capability}
                          </Badge>
                        ))}
                    </div>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!endpoint.enabled || busyId === endpoint.id}
                    onClick={() => void testEndpoint(endpoint)}
                  >
                    <Radio data-icon="inline-start" aria-hidden="true" />
                    Test capabilities
                  </Button>
                  {manageable && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === endpoint.id}
                        onClick={() => toggleEndpoint(endpoint)}
                      >
                        {endpoint.enabled ? "Disable" : "Enable"}
                      </Button>
                      {!endpoint.isDefault && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === endpoint.id}
                          onClick={() => setDefaultEndpoint(endpoint)}
                        >
                          Set default
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === endpoint.id}
                        onClick={() => openEdit(endpoint)}
                      >
                        <Pencil data-icon="inline-start" aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === endpoint.id}
                        className="ml-auto text-muted-foreground"
                        onClick={() => void removeEndpoint(endpoint)}
                      >
                        <Trash2 data-icon="inline-start" aria-hidden="true" />
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
        {endpoints.length === 0 && (
          <Card className="border-dashed lg:col-span-2">
            <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <Cloud aria-hidden="true" />
              </div>
              <div>
                <p className="font-medium">No custom endpoints yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  The backend seeds a JustAI demo endpoint for first-run chat.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={openCreate}>
                Connect your first model
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : closeEditor())}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingEndpoint ? "Edit LLM endpoint" : "Add an LLM endpoint"}
            </DialogTitle>
            <DialogDescription>
              {editingEndpoint
                ? "Update the provider, model, capabilities, or credential for this endpoint."
                : "Choose a native provider or point JustAI at a compatible gateway such as LiteLLM, Ollama, or OpenRouter."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={saveEndpoint}
            className="flex min-h-0 flex-col overflow-hidden"
          >
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="endpoint-name">
                      Display name
                    </FieldLabel>
                    <Input
                      id="endpoint-name"
                      value={form.name}
                      onChange={(event) => update("name", event.target.value)}
                      placeholder="Team GPT"
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Provider</FieldLabel>
                    <Select
                      value={form.providerType}
                      onValueChange={selectProvider}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(providerDetails).map(
                          ([value, details]) => (
                            <SelectItem key={value} value={value}>
                              {details.label}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field>
                  <FieldLabel>Visibility</FieldLabel>
                  <Select
                    value={form.scopeType}
                    onValueChange={(value) =>
                      update(
                        "scopeType",
                        value ??
                          (canManageOrganization ? "organization" : "user")
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {canManageOrganization && (
                        <SelectItem value="organization">
                          Organization
                        </SelectItem>
                      )}
                      <SelectItem value="user">Only me</SelectItem>
                      {platformAdmin && (
                        <SelectItem value="global">
                          Global (platform admin)
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Routing precedence is explicit selection, personal,
                    organization, then global.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="endpoint-url">Base URL</FieldLabel>
                  <Input
                    id="endpoint-url"
                    value={form.baseUrl}
                    onChange={(event) => update("baseUrl", event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    required
                  />
                  <FieldDescription>
                    {providerDetails[form.providerType]?.description}
                  </FieldDescription>
                </Field>
                <Field>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor="endpoint-chat-model">
                      Chat model
                    </FieldLabel>
                    {editingEndpoint && (
                      <Button
                        className="h-7 gap-1.5 px-2.5 text-xs"
                        disabled={discoveringModels}
                        onClick={() => void discoverModels(editingEndpoint.id)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <RefreshCw
                          className={discoveringModels ? "animate-spin" : ""}
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {discoveringModels ? "Discovering…" : "Discover models"}
                      </Button>
                    )}
                  </div>
                  <div className="relative">
                    <Input
                      id="endpoint-chat-model"
                      list="endpoint-chat-model-options"
                      value={form.chatModel}
                      onChange={(event) =>
                        update("chatModel", event.target.value)
                      }
                      placeholder="e.g. gemma-3-27b-it or gpt-4o-mini"
                    />
                    {discoveredModels.length > 0 && (
                      <datalist id="endpoint-chat-model-options">
                        {discoveredModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name ?? model.id}
                          </option>
                        ))}
                      </datalist>
                    )}
                  </div>
                  <FieldDescription>
                    This is the default chat model for the endpoint. Discovery
                    uses the provider catalog when available; manual model IDs
                    work with compatible gateways too.
                  </FieldDescription>
                </Field>
                {supports(form.providerType, "embeddings") && (
                  <Field>
                    <FieldLabel htmlFor="endpoint-embedding">
                      Embedding model
                    </FieldLabel>
                    <Input
                      id="endpoint-embedding"
                      value={form.embeddingModel}
                      onChange={(event) =>
                        update("embeddingModel", event.target.value)
                      }
                      placeholder="text-embedding-3-small"
                    />
                  </Field>
                )}
                {(supports(form.providerType, "realtime-transcription") ||
                  supports(form.providerType, "chunked-transcription")) && (
                  <Field>
                    <FieldLabel htmlFor="endpoint-transcription">
                      Transcription model
                    </FieldLabel>
                    <Input
                      id="endpoint-transcription"
                      value={form.transcriptionModel}
                      onChange={(event) => {
                        const transcriptionModel = event.target.value
                        const whisperGateway = isWhisperGateway(
                          form.providerType,
                          transcriptionModel
                        )
                        setForm((current) => ({
                          ...current,
                          transcriptionModel,
                          ...(whisperGateway
                            ? {
                                chunkedTranscription: true,
                                realtimeTranscription: false,
                              }
                            : {}),
                        }))
                      }}
                      placeholder="whisper-large-v3-turbo"
                    />
                    <FieldDescription>
                      Realtime or /audio/transcriptions model.
                    </FieldDescription>
                  </Field>
                )}
                {supports(form.providerType, "diarization") && (
                  <Field>
                    <FieldLabel htmlFor="endpoint-diarization">
                      Diarization model
                    </FieldLabel>
                    <Input
                      id="endpoint-diarization"
                      value={form.diarizationModel}
                      onChange={(event) =>
                        update("diarizationModel", event.target.value)
                      }
                      placeholder="gpt-4o-transcribe-diarize"
                    />
                    <FieldDescription>
                      Delayed speaker labeling.
                    </FieldDescription>
                  </Field>
                )}
                {supports(form.providerType, "tts") && (
                  <Field>
                    <FieldLabel htmlFor="endpoint-speech">
                      Speech model
                    </FieldLabel>
                    <Input
                      id="endpoint-speech"
                      value={form.speechModel}
                      onChange={(event) =>
                        update("speechModel", event.target.value)
                      }
                      placeholder="gpt-4o-mini-tts"
                    />
                    <FieldDescription>Optional TTS model.</FieldDescription>
                  </Field>
                )}
                <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2 lg:grid-cols-4">
                  {supports(form.providerType, "realtime-transcription") && (
                    <label className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block text-sm font-medium">
                          Realtime transcription
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Native provider WebSocket.
                        </span>
                      </span>
                      <Switch
                        aria-label="Enable realtime transcription"
                        checked={form.realtimeTranscription}
                        onCheckedChange={(checked) =>
                          setForm((current) => ({
                            ...current,
                            realtimeTranscription: checked,
                            chunkedTranscription: checked
                              ? false
                              : current.chunkedTranscription,
                          }))
                        }
                      />
                    </label>
                  )}
                  {supports(form.providerType, "chunked-transcription") && (
                    <label className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block text-sm font-medium">
                          Chunked HTTP transcription
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Rolling Whisper windows.
                        </span>
                      </span>
                      <Switch
                        aria-label="Enable chunked HTTP transcription"
                        checked={form.chunkedTranscription}
                        onCheckedChange={(checked) =>
                          setForm((current) => ({
                            ...current,
                            chunkedTranscription: checked,
                            realtimeTranscription: checked
                              ? false
                              : current.realtimeTranscription,
                          }))
                        }
                      />
                    </label>
                  )}
                  {supports(form.providerType, "diarization") && (
                    <label className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block text-sm font-medium">
                          Speaker diarization
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Identify anonymous speakers.
                        </span>
                      </span>
                      <Switch
                        aria-label="Enable speaker diarization"
                        checked={form.diarization}
                        onCheckedChange={(checked) =>
                          update("diarization", checked)
                        }
                      />
                    </label>
                  )}
                  {supports(form.providerType, "tool-calling") && (
                    <label className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block text-sm font-medium">
                          Tool calling
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Allow approved MCP actions.
                        </span>
                      </span>
                      <Switch
                        aria-label="Enable tool calling"
                        checked={form.toolCalling}
                        onCheckedChange={(checked) =>
                          update("toolCalling", checked)
                        }
                      />
                    </label>
                  )}
                </div>
                <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
                  <label className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block text-sm font-medium">Enabled</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Allow this endpoint to be selected.
                      </span>
                    </span>
                    <Switch
                      aria-label="Enable endpoint"
                      checked={form.enabled}
                      onCheckedChange={(checked) => update("enabled", checked)}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block text-sm font-medium">
                        Default endpoint
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Use for new chat sessions.
                      </span>
                    </span>
                    <Switch
                      aria-label="Set as default endpoint"
                      checked={form.isDefault}
                      onCheckedChange={(checked) =>
                        update("isDefault", checked)
                      }
                    />
                  </label>
                </div>
                <Field>
                  <FieldLabel htmlFor="endpoint-key">
                    API key or token
                  </FieldLabel>
                  <Input
                    id="endpoint-key"
                    type="password"
                    value={form.credential}
                    onChange={(event) =>
                      update("credential", event.target.value)
                    }
                    placeholder="Stored encrypted by JustAI"
                    autoComplete="off"
                  />
                  <FieldDescription>
                    For local runtimes this can stay empty. OAuth-ready MCP
                    credentials follow the same encrypted storage boundary.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={closeEditor}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? "Saving…"
                  : editingEndpoint
                    ? "Save changes"
                    : "Save endpoint"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "ollama") return <Server aria-hidden="true" />
  if (provider === "mock") return <Sparkles aria-hidden="true" />
  return provider === "anthropic" ? (
    <CircleAlert aria-hidden="true" />
  ) : (
    <CheckCircle2 aria-hidden="true" />
  )
}
