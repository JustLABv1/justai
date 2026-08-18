"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type Props = {
  endpoints: Endpoint[]
  onChange: (endpoints: Endpoint[]) => void
  organizationRole?: string
  userId?: string
  platformAdmin?: boolean
  apiBasePath?: string
  defaultScopeType?: "global" | "organization" | "user"
  createRequest?: number
}

type EndpointForm = {
  name: string
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
  toolCalling: boolean
  vision: boolean
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
  toolCalling: false,
  vision: false,
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
  pyannote: {
    label: "Pyannote (self-hosted)",
    description: "A dedicated pyannote.audio speaker-diarization service.",
    baseUrl: "http://localhost:8000",
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
  apiBasePath = "/api/v1/endpoints",
  defaultScopeType,
  createRequest,
}: Props) {
  const [open, setOpen] = useState(false)
  const [editingEndpoint, setEditingEndpoint] = useState<Endpoint | null>(null)
  const [form, setForm] = useState<EndpointForm>(defaults)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState("")
  const [notice, setNotice] = useState("")
  const [removeTarget, setRemoveTarget] = useState<Endpoint | null>(null)
  const [discoveredModels, setDiscoveredModels] = useState<
    DiscoveredChatModel[]
  >([])
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [advancedConnectionOpen, setAdvancedConnectionOpen] = useState(false)
  const [additionalModelsOpen, setAdditionalModelsOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const discoveryRequestRef = useRef(0)
  const createRequestRef = useRef(createRequest ?? 0)
  const [capabilityMatrix, setCapabilityMatrix] = useState<
    Record<string, string[]>
  >({})
  const endpointPath = apiBasePath.replace(/\/+$/, "")
  const isPlatformCatalog = apiBasePath.startsWith("/api/v1/admin/")

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
    if (endpoint.scopeType === "global") {
      return platformAdmin && isPlatformCatalog
    }
    if (platformAdmin) return true
    if (userId === undefined && organizationRole === undefined) return true
    if (endpoint.scopeType === "user") return endpoint.scopeId === userId
    if (endpoint.scopeType === "organization") return canManageOrganization
    return false
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
    const pyannote = provider === "pyannote"
    setForm((current) => ({
      ...current,
      providerType: provider,
      baseUrl: providerDetails[provider]?.baseUrl ?? current.baseUrl,
      realtimeTranscription: nativeTranscription,
      chunkedTranscription: false,
      diarization: nativeTranscription || pyannote,
      diarizationModel: pyannote
        ? current.diarizationModel || "pyannote/speaker-diarization-3.1"
        : current.diarizationModel,
      timeoutSeconds: pyannote ? 1800 : current.timeoutSeconds,
      toolCalling: provider === "openai",
    }))
    setDiscoveredModels([])
  }

  const resetEditor = useCallback(() => {
    discoveryRequestRef.current += 1
    setEditingEndpoint(null)
    setDiscoveredModels([])
    setDiscoveringModels(false)
    setAdvancedConnectionOpen(false)
    setAdditionalModelsOpen(false)
    setRuntimeOpen(false)
    setForm({
      ...defaults,
      scopeType:
        defaultScopeType ??
        (canManageOrganization ? defaults.scopeType : "user"),
    })
  }, [canManageOrganization, defaultScopeType])

  const openCreate = useCallback(() => {
    resetEditor()
    setNotice("")
    setOpen(true)
  }, [resetEditor])

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

  function openEdit(endpoint: Endpoint) {
    setEditingEndpoint(endpoint)
    setAdvancedConnectionOpen(false)
    setAdditionalModelsOpen(false)
    setRuntimeOpen(false)
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
      scopeId: endpoint.scopeId ?? "",
      baseUrl: endpoint.baseUrl,
      apiPath: endpoint.apiPath ?? "",
      apiVersion: endpoint.apiVersion ?? "",
      chatModel: endpoint.chatModel ?? "",
      visionModel: endpoint.visionModel ?? "",
      embeddingModel: endpoint.embeddingModel ?? "",
      imageModel: endpoint.imageModel ?? "gpt-image-1",
      transcriptionModel: endpoint.transcriptionModel ?? "",
      diarizationModel: endpoint.diarizationModel ?? "",
      speechModel: endpoint.speechModel ?? "",
      timeoutSeconds: endpoint.timeoutSeconds || defaults.timeoutSeconds,
      maxOutputTokens: endpoint.maxOutputTokens || defaults.maxOutputTokens,
      temperature: endpoint.temperature || defaults.temperature,
      realtimeTranscription: Boolean(
        endpoint.capabilities["realtime-transcription"] && !chunkedTranscription
      ),
      chunkedTranscription,
      diarization: Boolean(endpoint.capabilities.diarization),
      toolCalling: Boolean(endpoint.capabilities["tool-calling"]),
      vision: Boolean(endpoint.capabilities.vision),
      credential: "",
      enabled: endpoint.enabled,
      isDefault: endpoint.isDefault,
    })
    setNotice("")
    setOpen(true)
    if (endpoint.enabled && endpoint.capabilities.chat)
      void discoverModels(endpoint.id)
  }

  async function discoverModels(endpointId: string) {
    const requestId = ++discoveryRequestRef.current
    setDiscoveringModels(true)
    setNotice("")
    try {
      const result = await api.get<{
        models?: DiscoveredChatModel[]
        configuredModel?: string
      }>(`${endpointPath}/${endpointId}/models`)
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
        chat: form.providerType !== "pyannote",
        embeddings: Boolean(form.embeddingModel),
        "image-generation":
          supports(form.providerType, "image-generation") &&
          Boolean(form.imageModel.trim()),
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
        vision: supports(form.providerType, "vision") && form.vision,
        tts: supports(form.providerType, "tts") && Boolean(form.speechModel),
      }
      const payload = {
        ...form,
        scopeId: form.scopeId.trim() || null,
        capabilities,
      }
      const result = editingEndpoint
        ? await api.patch<Endpoint>(
            `${endpointPath}/${editingEndpoint.id}`,
            payload
          )
        : await api.post<Endpoint>(endpointPath, {
            ...payload,
            isDefault:
              form.providerType === "pyannote"
                ? false
                : form.isDefault || endpoints.length === 0,
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
      }>(`${endpointPath}/${endpoint.id}/test`)
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
    setBusyId(endpoint.id)
    try {
      await api.delete(`${endpointPath}/${endpoint.id}`)
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
      .patch<Endpoint>(`${endpointPath}/${endpoint.id}`, {
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
      .patch<Endpoint>(`${endpointPath}/${endpoint.id}`, {
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

  const chatCapable = form.providerType !== "pyannote"
  const hasAdditionalModels =
    supports(form.providerType, "vision") ||
    supports(form.providerType, "embeddings") ||
    supports(form.providerType, "image-generation") ||
    supports(form.providerType, "realtime-transcription") ||
    supports(form.providerType, "chunked-transcription") ||
    supports(form.providerType, "diarization") ||
    supports(form.providerType, "tts")

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      {!isPlatformCatalog &&
        endpoints.some((item) => item.scopeType === "global") && (
          <div className="flex items-start gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3 text-sm">
            <LockKeyhole
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">Platform-managed endpoints</p>
              <p className="mt-1 text-muted-foreground">
                These endpoints are inherited by this workspace and can only be
                changed from the Platform Admin catalog.
              </p>
            </div>
          </div>
        )}

      <div className="grid gap-3 lg:grid-cols-2">
        {endpoints.map((endpoint) => {
          const details =
            providerDetails[endpoint.providerType] ??
            providerDetails["openai-compatible"]
          const modelLabel =
            endpoint.chatModel ||
            endpoint.diarizationModel ||
            "model selected at request time"
          const manageable = canManageEndpoint(endpoint)
          return (
            <Card key={endpoint.id} size="sm" className="gap-0">
              <CardHeader className="flex-row items-start gap-3 border-b pb-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <ProviderIcon provider={endpoint.providerType} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{endpoint.name}</CardTitle>
                    {endpoint.isDefault && (
                      <Badge variant="outline">Default</Badge>
                    )}
                  </div>
                  <CardDescription className="mt-1 flex flex-col gap-0.5">
                    <span>
                      {details.label} · {modelLabel}
                    </span>
                    {endpoint.capabilities?.vision && (
                      <span className="text-xs">
                        Vision:{" "}
                        {endpoint.visionModel ||
                          endpoint.chatModel ||
                          "uses chat model"}
                      </span>
                    )}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-3">
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {endpoint.scopeType === "global" ? (
                    <Badge variant="outline" className="gap-1.5">
                      <LockKeyhole aria-hidden="true" />
                      {isPlatformCatalog
                        ? "Platform catalog"
                        : "Platform-managed"}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">
                      {endpoint.scopeType === "organization"
                        ? "Workspace"
                        : "Personal"}
                    </Badge>
                  )}
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
                    <p
                      className="mt-1 truncate font-mono text-xs"
                      title={endpoint.baseUrl}
                    >
                      {endpoint.baseUrl}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Capabilities
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
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
                <div className="flex items-center justify-end border-t pt-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`${manageable ? "Actions" : "Test"} for ${endpoint.name}`}
                        />
                      }
                    >
                      <MoreHorizontal
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      {manageable ? "Actions" : "Test"}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={!endpoint.enabled || busyId === endpoint.id}
                        onClick={() => void testEndpoint(endpoint)}
                      >
                        <Radio aria-hidden="true" /> Test capabilities
                      </DropdownMenuItem>
                      {manageable && (
                        <>
                          <DropdownMenuSeparator />
                          {!endpoint.isDefault && (
                            <DropdownMenuItem
                              disabled={busyId === endpoint.id}
                              onClick={() => setDefaultEndpoint(endpoint)}
                            >
                              <CheckCircle2 aria-hidden="true" /> Set default
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            disabled={busyId === endpoint.id}
                            className={
                              endpoint.enabled
                                ? "text-destructive focus:text-destructive"
                                : "text-primary focus:text-primary"
                            }
                            onClick={() => toggleEndpoint(endpoint)}
                          >
                            {endpoint.enabled ? "Disable" : "Enable"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busyId === endpoint.id}
                            onClick={() => openEdit(endpoint)}
                          >
                            <Pencil aria-hidden="true" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busyId === endpoint.id}
                            variant="destructive"
                            onClick={() => setRemoveTarget(endpoint)}
                          >
                            <Trash2 aria-hidden="true" /> Remove
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
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
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {editingEndpoint
                ? "Edit LLM endpoint"
                : "Connect an LLM endpoint"}
            </DialogTitle>
            <DialogDescription>
              {editingEndpoint
                ? "Update the connection and model routing. Optional behavior is grouped under advanced settings."
                : "Start with the provider connection and chat model. Optional model mappings and runtime controls are grouped below."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={saveEndpoint}
            className="flex min-h-0 flex-col overflow-hidden"
          >
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <FieldGroup>
                <section className="rounded-xl border p-4">
                  <div className="mb-4 flex flex-col gap-1">
                    <p className="text-sm font-medium">Connection</p>
                    <p className="text-sm text-muted-foreground">
                      The only details needed to connect this provider.
                    </p>
                  </div>
                  <FieldGroup>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="endpoint-name">
                          Display name
                        </FieldLabel>
                        <Input
                          id="endpoint-name"
                          value={form.name}
                          onChange={(event) =>
                            update("name", event.target.value)
                          }
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
                        <FieldDescription>
                          {providerDetails[form.providerType]?.description}
                        </FieldDescription>
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel>Visibility</FieldLabel>
                      <Select
                        disabled={Boolean(editingEndpoint)}
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
                              Workspace
                            </SelectItem>
                          )}
                          <SelectItem value="user">Only me</SelectItem>
                          {platformAdmin && isPlatformCatalog && (
                            <SelectItem value="global">
                              Global (platform admin)
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        Choose who can use this endpoint. Its scope cannot be
                        changed after creation.
                      </FieldDescription>
                    </Field>
                    {platformAdmin && form.scopeType !== "global" && (
                      <Field>
                        <FieldLabel htmlFor="endpoint-scope-id">
                          Scope ID
                        </FieldLabel>
                        <Input
                          id="endpoint-scope-id"
                          value={form.scopeId}
                          onChange={(event) =>
                            update("scopeId", event.target.value)
                          }
                          placeholder="Organization or user UUID"
                          required
                          readOnly={Boolean(editingEndpoint)}
                        />
                        <FieldDescription>
                          {editingEndpoint
                            ? "An endpoint's scope is fixed after creation."
                            : "Platform administrators can assign this endpoint to a specific organization or user."}
                        </FieldDescription>
                      </Field>
                    )}
                    <Field>
                      <FieldLabel htmlFor="endpoint-url">Base URL</FieldLabel>
                      <Input
                        id="endpoint-url"
                        value={form.baseUrl}
                        onChange={(event) =>
                          update("baseUrl", event.target.value)
                        }
                        placeholder="https://api.openai.com/v1"
                        required
                      />
                      <FieldDescription>
                        Use the suggested URL for a hosted provider, or replace
                        it with your self-hosted gateway.
                      </FieldDescription>
                    </Field>
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
                        Leave empty for local runtimes or providers that use a
                        different authentication flow.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </section>

                <section className="rounded-xl border p-4">
                  <div className="mb-4 flex flex-col gap-1">
                    <p className="text-sm font-medium">
                      {chatCapable ? "Models" : "Diarization"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {chatCapable
                        ? "Choose the model JustAI should use for chat by default."
                        : "Configure the speaker-diarization service used by video transcription."}
                    </p>
                  </div>
                  <FieldGroup>
                    {chatCapable && (
                      <Field>
                        <div className="flex items-center justify-between gap-3">
                          <FieldLabel htmlFor="endpoint-chat-model">
                            Chat model
                          </FieldLabel>
                          {editingEndpoint && (
                            <Button
                              className="h-7 gap-1.5 px-2.5 text-xs"
                              disabled={discoveringModels}
                              onClick={() =>
                                void discoverModels(editingEndpoint.id)
                              }
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              <RefreshCw
                                className={
                                  discoveringModels ? "animate-spin" : ""
                                }
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                              {discoveringModels
                                ? "Discovering…"
                                : "Discover models"}
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
                          This is the default chat model. Discovery works when
                          the provider exposes a model catalog; manual IDs work
                          with compatible gateways too.
                        </FieldDescription>
                      </Field>
                    )}

                    {hasAdditionalModels && (
                      <Collapsible
                        className="rounded-lg border"
                        open={additionalModelsOpen}
                        onOpenChange={setAdditionalModelsOpen}
                      >
                        <CollapsibleTrigger
                          render={
                            <Button
                              className="h-auto w-full justify-between rounded-lg px-3 py-2.5 text-left hover:bg-muted/50"
                              size="sm"
                              type="button"
                              variant="ghost"
                            />
                          }
                        >
                          <span className="flex min-w-0 flex-col items-start gap-0.5">
                            <span className="font-medium">
                              Additional models
                            </span>
                            <span className="text-xs font-normal text-muted-foreground">
                              Optional vision, embeddings, transcription, and
                              image, speech mappings
                            </span>
                          </span>
                          {additionalModelsOpen ? (
                            <ChevronDown aria-hidden="true" />
                          ) : (
                            <ChevronRight aria-hidden="true" />
                          )}
                        </CollapsibleTrigger>
                        <CollapsibleContent className="border-t px-3 py-4">
                          <FieldGroup>
                            {supports(form.providerType, "vision") && (
                              <Field>
                                <FieldLabel htmlFor="endpoint-vision-model">
                                  Vision model
                                </FieldLabel>
                                <Input
                                  id="endpoint-vision-model"
                                  list="endpoint-chat-model-options"
                                  value={form.visionModel}
                                  onChange={(event) =>
                                    update("visionModel", event.target.value)
                                  }
                                  placeholder="e.g. gpt-4o or gemini-2.5-flash"
                                />
                                <FieldDescription>
                                  Used automatically when a chat includes an
                                  image. Leave empty to reuse the chat model.
                                </FieldDescription>
                              </Field>
                            )}
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
                            {supports(
                              form.providerType,
                              "image-generation"
                            ) && (
                              <Field>
                                <FieldLabel htmlFor="endpoint-image-model">
                                  Image generation model
                                </FieldLabel>
                                <Input
                                  id="endpoint-image-model"
                                  value={form.imageModel}
                                  onChange={(event) =>
                                    update("imageModel", event.target.value)
                                  }
                                  placeholder="gpt-image-1"
                                />
                                <FieldDescription>
                                  Used by the Image Studio for generation and
                                  editing.
                                </FieldDescription>
                              </Field>
                            )}
                            {(supports(
                              form.providerType,
                              "realtime-transcription"
                            ) ||
                              supports(
                                form.providerType,
                                "chunked-transcription"
                              )) && (
                              <Field>
                                <FieldLabel htmlFor="endpoint-transcription">
                                  Transcription model
                                </FieldLabel>
                                <Input
                                  id="endpoint-transcription"
                                  value={form.transcriptionModel}
                                  onChange={(event) => {
                                    const transcriptionModel =
                                      event.target.value
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
                                    update(
                                      "diarizationModel",
                                      event.target.value
                                    )
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
                                <FieldDescription>
                                  Optional text-to-speech model.
                                </FieldDescription>
                              </Field>
                            )}
                          </FieldGroup>
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </FieldGroup>
                </section>

                <Collapsible
                  className="rounded-xl border"
                  open={advancedConnectionOpen}
                  onOpenChange={setAdvancedConnectionOpen}
                >
                  <CollapsibleTrigger
                    render={
                      <Button
                        className="h-auto w-full justify-between rounded-xl px-4 py-3 text-left hover:bg-muted/50"
                        size="sm"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                      <span className="font-medium">
                        Advanced connection settings
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        Custom API paths and version headers for gateways
                      </span>
                    </span>
                    {advancedConnectionOpen ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="border-t px-4 py-4">
                    <FieldGroup>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor="endpoint-api-path">
                            API path (optional)
                          </FieldLabel>
                          <Input
                            id="endpoint-api-path"
                            value={form.apiPath}
                            onChange={(event) =>
                              update("apiPath", event.target.value)
                            }
                            placeholder="/v1"
                          />
                          <FieldDescription>
                            Override the provider&apos;s default chat route when
                            using a gateway.
                          </FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="endpoint-api-version">
                            API version (optional)
                          </FieldLabel>
                          <Input
                            id="endpoint-api-version"
                            value={form.apiVersion}
                            onChange={(event) =>
                              update("apiVersion", event.target.value)
                            }
                            placeholder="2024-06-20"
                          />
                          <FieldDescription>
                            Used by providers that require an explicit API
                            version header or path.
                          </FieldDescription>
                        </Field>
                      </div>
                    </FieldGroup>
                  </CollapsibleContent>
                </Collapsible>

                <Collapsible
                  className="rounded-xl border"
                  open={runtimeOpen}
                  onOpenChange={setRuntimeOpen}
                >
                  <CollapsibleTrigger
                    render={
                      <Button
                        className="h-auto w-full justify-between rounded-xl px-4 py-3 text-left hover:bg-muted/50"
                        size="sm"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                      <span className="font-medium">
                        Runtime &amp; capabilities
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        Timeouts, feature switches, and endpoint defaults
                      </span>
                    </span>
                    {runtimeOpen ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="border-t px-4 py-4">
                    <FieldGroup>
                      <div className="grid gap-4 rounded-xl border p-3 sm:grid-cols-3">
                        <Field>
                          <FieldLabel htmlFor="endpoint-timeout">
                            Timeout (seconds)
                          </FieldLabel>
                          <Input
                            id="endpoint-timeout"
                            type="number"
                            min={1}
                            value={form.timeoutSeconds}
                            onChange={(event) =>
                              update(
                                "timeoutSeconds",
                                Number(event.target.value)
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="endpoint-max-tokens">
                            Max output tokens
                          </FieldLabel>
                          <Input
                            id="endpoint-max-tokens"
                            type="number"
                            min={1}
                            value={form.maxOutputTokens}
                            onChange={(event) =>
                              update(
                                "maxOutputTokens",
                                Number(event.target.value)
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="endpoint-temperature">
                            Temperature
                          </FieldLabel>
                          <Input
                            id="endpoint-temperature"
                            type="number"
                            min={0}
                            max={2}
                            step={0.1}
                            value={form.temperature}
                            onChange={(event) =>
                              update("temperature", Number(event.target.value))
                            }
                          />
                        </Field>
                        <FieldDescription className="sm:col-span-3">
                          These settings are shared by organization and
                          platform-admin endpoint configuration.
                        </FieldDescription>
                      </div>
                      <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2 lg:grid-cols-4">
                        {supports(
                          form.providerType,
                          "realtime-transcription"
                        ) && (
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
                        {supports(
                          form.providerType,
                          "chunked-transcription"
                        ) && (
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
                        {supports(form.providerType, "vision") && (
                          <label className="flex items-start justify-between gap-3">
                            <span>
                              <span className="block text-sm font-medium">
                                Image input
                              </span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                Enable image messages for a vision-capable
                                model.
                              </span>
                            </span>
                            <Switch
                              aria-label="Enable image input"
                              checked={form.vision}
                              onCheckedChange={(checked) =>
                                update("vision", checked)
                              }
                            />
                          </label>
                        )}
                      </div>
                      <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
                        <label className="flex items-center justify-between gap-3">
                          <span>
                            <span className="block text-sm font-medium">
                              Enabled
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              Allow this endpoint to be selected.
                            </span>
                          </span>
                          <Switch
                            aria-label="Enable endpoint"
                            checked={form.enabled}
                            onCheckedChange={(checked) =>
                              update("enabled", checked)
                            }
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
                    </FieldGroup>
                  </CollapsibleContent>
                </Collapsible>
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

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busyId) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove “{removeTarget?.name}”? Existing conversations keep their
              stored messages, but new requests will no longer route here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!removeTarget || Boolean(busyId)}
              variant="destructive"
              onClick={() => {
                const target = removeTarget
                setRemoveTarget(null)
                if (target) void removeEndpoint(target)
              }}
            >
              Remove endpoint
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
