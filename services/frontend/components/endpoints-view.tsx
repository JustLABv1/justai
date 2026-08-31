"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  CircleAlert,
  Cloud,
  KeyRound,
  LockKeyhole,
  MessageSquare,
  Mic2,
  MoreHorizontal,
  Pencil,
  Radio,
  Search,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react"

import { api } from "@/lib/api"
import {
  buildEndpointCapabilities,
  defaults,
  endpointKindFor,
  fallbackSupportedProviders,
  isWhisperGateway,
  providerDetails,
  providerSupports,
  timeoutForProvider,
  type EndpointForm,
  type SupportedProvider,
} from "@/lib/endpoint-logic"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { Endpoint, EndpointKind } from "@/lib/types"
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
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EndpointCreationWizard } from "@/components/endpoint-creation-wizard"

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
  const [search, setSearch] = useState("")
  const [scopeFilter, setScopeFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [kindFilter, setKindFilter] = useState<"all" | EndpointKind>("all")
  const [removeTarget, setRemoveTarget] = useState<Endpoint | null>(null)
  const createRequestRef = useRef(createRequest ?? 0)
  const [supportedProviders, setSupportedProviders] = useState<
    SupportedProvider[]
  >(fallbackSupportedProviders)
  const endpointPath = apiBasePath.replace(/\/+$/, "")
  const isPlatformCatalog = apiBasePath.startsWith("/api/v1/admin/")

  const visibleEndpoints = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return endpoints.filter((endpoint) => {
      const matchesSearch =
        !normalizedSearch ||
        [
          endpoint.name,
          endpoint.providerType,
          endpoint.chatModel,
          endpoint.diarizationModel,
          endpoint.baseUrl,
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalizedSearch))
      const matchesScope =
        scopeFilter === "all" || endpoint.scopeType === scopeFilter
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "enabled" ? endpoint.enabled : !endpoint.enabled)
      const matchesKind =
        kindFilter === "all" ||
        endpointKindFor(endpoint) === kindFilter ||
        (kindFilter === "llm" && endpoint.capabilities.chat) ||
        (kindFilter === "diarization" && endpoint.capabilities.diarization)
      return matchesSearch && matchesScope && matchesStatus && matchesKind
    })
  }, [endpoints, kindFilter, scopeFilter, search, statusFilter])

  useEffect(() => {
    void api
      .get<{ providers: SupportedProvider[] }>("/api/v1/providers/supported")
      .then((result) => {
        if (result.providers.length > 0) setSupportedProviders(result.providers)
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
    providerSupports(supportedProviders, provider, capability)
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
    const pyannote = provider === "pyannote"
    setForm((current) => ({
      ...current,
      providerType: provider,
      baseUrl: providerDetails[provider]?.baseUrl ?? current.baseUrl,
      endpointKind: pyannote ? "diarization" : current.endpointKind,
      realtimeTranscription: false,
      chunkedTranscription: false,
      diarization: current.endpointKind === "diarization" || pyannote,
      useForChat: pyannote
        ? false
        : current.endpointKind === "llm" || current.useForChat,
      diarizationModel: pyannote
        ? current.diarizationModel || "pyannote/speaker-diarization-3.1"
        : current.diarizationModel,
      timeoutSeconds: timeoutForProvider(provider, current.timeoutSeconds),
      toolCalling: provider === "openai",
    }))
  }

  const resetEditor = useCallback(() => {
    setEditingEndpoint(null)
    setForm({
      ...defaults,
      scopeType:
        defaultScopeType ??
        (canManageOrganization ? defaults.scopeType : "user"),
    })
  }, [canManageOrganization, defaultScopeType])

  const openCreate = useCallback(
    (preferredKind?: EndpointKind) => {
      resetEditor()
      if (preferredKind) {
        setForm((current) => ({
          ...current,
          endpointKind: preferredKind,
          useForChat: preferredKind === "llm",
          diarization: preferredKind === "diarization",
        }))
      }
      setNotice("")
      setOpen(true)
    },
    [resetEditor]
  )

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

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
      endpointKind: endpointKindFor(endpoint),
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
      temperature: endpoint.temperature ?? defaults.temperature,
      realtimeTranscription: Boolean(
        endpoint.capabilities["realtime-transcription"] && !chunkedTranscription
      ),
      chunkedTranscription,
      diarization: Boolean(endpoint.capabilities.diarization),
      useForChat: Boolean(endpoint.capabilities.chat),
      toolCalling: Boolean(endpoint.capabilities["tool-calling"]),
      vision: Boolean(endpoint.capabilities.vision),
      credential: "",
      enabled: endpoint.enabled,
      isDefault: endpoint.isDefault,
    })
    setNotice("")
    setOpen(true)
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
      const capabilities = buildEndpointCapabilities(form, supports)
      const payload = {
        ...form,
        scopeId: form.scopeId.trim() || null,
        capabilities,
      }
      const hasChatDefault = endpoints.some(
        (endpoint) => endpoint.enabled && endpoint.capabilities.chat
      )
      const result = editingEndpoint
        ? await api.patch<Endpoint>(
            `${endpointPath}/${editingEndpoint.id}`,
            payload
          )
        : await api.post<Endpoint>(endpointPath, {
            ...payload,
            isDefault: !capabilities.chat
              ? false
              : form.isDefault || !hasChatDefault,
          })
      onChange(
        editingEndpoint
          ? endpoints.map((item) => (item.id === result.id ? result : item))
          : [result, ...endpoints]
      )
      notifySuccess(
        editingEndpoint ? "Endpoint updated" : "Endpoint connected",
        `${result.name} is ready for routing.`
      )
      closeEditor()
    } catch (caught) {
      setNotice(
        notifyError(
          "Endpoint could not be saved",
          caught,
          "The endpoint could not be saved."
        )
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
      const message =
        failed.length === 0
          ? `${endpoint.name} capability checks completed.`
          : `${endpoint.name} has ${failed.length} failing capability check${failed.length === 1 ? "" : "s"}.`
      if (failed.length === 0) {
        notifySuccess("Endpoint checks completed", message)
      } else {
        setNotice(message)
        notifyError("Endpoint checks found issues", new Error(message), message)
      }
    } catch (caught) {
      setNotice(
        notifyError(
          "Endpoint test failed",
          caught,
          `${endpoint.name} could not be reached. Check its URL and credential.`
        )
      )
    }
  }

  async function removeEndpoint(endpoint: Endpoint) {
    setBusyId(endpoint.id)
    try {
      await api.delete(`${endpointPath}/${endpoint.id}`)
      onChange(endpoints.filter((item) => item.id !== endpoint.id))
      notifySuccess(
        "Endpoint removed",
        `${endpoint.name} is no longer available.`
      )
    } catch (caught) {
      setNotice(
        notifyError(
          "Endpoint could not be removed",
          caught,
          "The endpoint could not be removed."
        )
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
      .then(() =>
        notifySuccess(`Endpoint ${endpoint.enabled ? "disabled" : "enabled"}`)
      )
      .catch((caught) => {
        setNotice(
          notifyError(
            "Endpoint could not be updated",
            caught,
            "The endpoint could not be updated."
          )
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
      .then(() =>
        notifySuccess(
          "Default endpoint updated",
          `${endpoint.name} is now the default.`
        )
      )
      .catch((caught) => {
        setNotice(
          notifyError(
            "Default endpoint could not be changed",
            caught,
            "The default endpoint could not be changed."
          )
        )
      })
      .finally(() => {
        setBusyId("")
      })
  }

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

      <EndpointTable
        endpoints={endpoints}
        visibleEndpoints={visibleEndpoints}
        isPlatformCatalog={isPlatformCatalog}
        busyId={busyId}
        search={search}
        scopeFilter={scopeFilter}
        statusFilter={statusFilter}
        kindFilter={kindFilter}
        onSearchChange={setSearch}
        onScopeChange={setScopeFilter}
        onStatusChange={setStatusFilter}
        onKindChange={setKindFilter}
        canManageEndpoint={canManageEndpoint}
        onTest={testEndpoint}
        onSetDefault={setDefaultEndpoint}
        onToggle={toggleEndpoint}
        onEdit={openEdit}
        onRemove={setRemoveTarget}
        onCreate={openCreate}
      />

      <EndpointCreationWizard
        key={`${open ? "open" : "closed"}-${editingEndpoint?.id ?? "new"}`}
        open={open}
        onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : closeEditor())}
        editingEndpoint={editingEndpoint}
        form={form}
        setForm={setForm}
        update={update}
        providers={supportedProviders}
        endpointPath={endpointPath}
        canManageOrganization={canManageOrganization}
        platformAdmin={platformAdmin}
        isPlatformCatalog={isPlatformCatalog}
        saving={saving}
        notice={notice}
        onSelectProvider={selectProvider}
        onSave={saveEndpoint}
        onClose={closeEditor}
      />

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

function EndpointTable({
  endpoints,
  visibleEndpoints,
  isPlatformCatalog,
  busyId,
  search,
  scopeFilter,
  statusFilter,
  kindFilter,
  onSearchChange,
  onScopeChange,
  onStatusChange,
  onKindChange,
  canManageEndpoint,
  onTest,
  onSetDefault,
  onToggle,
  onEdit,
  onRemove,
  onCreate,
}: {
  endpoints: Endpoint[]
  visibleEndpoints: Endpoint[]
  isPlatformCatalog: boolean
  busyId: string
  search: string
  scopeFilter: string
  statusFilter: string
  kindFilter: "all" | EndpointKind
  onSearchChange: (value: string) => void
  onScopeChange: (value: string) => void
  onStatusChange: (value: string) => void
  onKindChange: (value: "all" | EndpointKind) => void
  canManageEndpoint: (endpoint: Endpoint) => boolean
  onTest: (endpoint: Endpoint) => Promise<void>
  onSetDefault: (endpoint: Endpoint) => void
  onToggle: (endpoint: Endpoint) => void
  onEdit: (endpoint: Endpoint) => void
  onRemove: (endpoint: Endpoint) => void
  onCreate: (kind?: EndpointKind) => void
}) {
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Endpoint inventory</CardTitle>
          <CardDescription>
            {visibleEndpoints.length} of {endpoints.length} endpoint
            {endpoints.length === 1 ? "" : "s"} shown. Open a row to edit
            connection details.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" /> Live catalog
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="border-y px-4 pt-3">
          <Tabs
            value={kindFilter}
            onValueChange={(value) =>
              onKindChange((value as "all" | EndpointKind) ?? "all")
            }
          >
            <TabsList aria-label="Filter endpoint type" variant="line">
              <TabsTrigger value="all">All endpoints</TabsTrigger>
              <TabsTrigger value="llm">
                <MessageSquare aria-hidden="true" /> LLM
              </TabsTrigger>
              <TabsTrigger value="diarization">
                <Mic2 aria-hidden="true" /> Diarization
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex flex-wrap gap-2 border-y px-4 py-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search endpoints"
              className="h-9 pl-8"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search name, provider, model…"
              value={search}
            />
          </div>
          <Select
            value={scopeFilter}
            onValueChange={(value) => onScopeChange(value ?? "all")}
          >
            <SelectTrigger
              aria-label="Filter endpoint scope"
              className="h-9 w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All scopes</SelectItem>
              <SelectItem value="global">Global</SelectItem>
              <SelectItem value="organization">Workspace</SelectItem>
              <SelectItem value="user">Personal</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(value) => onStatusChange(value ?? "all")}
          >
            <SelectTrigger
              aria-label="Filter endpoint status"
              className="h-9 w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {visibleEndpoints.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Endpoint</th>
                  <th className="px-4 py-3 font-medium">Scope</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Capabilities</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEndpoints.map((endpoint) => {
                  const details =
                    providerDetails[endpoint.providerType] ??
                    providerDetails["openai-compatible"]
                  const modelLabel =
                    endpoint.chatModel ||
                    endpoint.diarizationModel ||
                    "model selected at request time"
                  const manageable = canManageEndpoint(endpoint)
                  const capabilities = Object.entries(
                    endpoint.capabilities ?? {}
                  )
                    .filter(([, enabled]) => enabled)
                    .map(([capability]) => capability)
                  return (
                    <tr className="border-b last:border-0" key={endpoint.id}>
                      <td className="max-w-[280px] px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                            <ProviderIcon provider={endpoint.providerType} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate font-medium">
                                {endpoint.name}
                              </p>
                              {endpoint.isDefault && (
                                <Badge variant="outline">Default</Badge>
                              )}
                              <Badge variant="secondary">
                                {endpointKindFor(endpoint) === "diarization"
                                  ? "Diarization"
                                  : "LLM"}
                              </Badge>
                              {endpointKindFor(endpoint) === "llm" &&
                                endpoint.capabilities.diarization && (
                                  <Badge variant="outline">Dual role</Badge>
                                )}
                              {endpointKindFor(endpoint) === "diarization" &&
                                endpoint.capabilities.chat && (
                                  <Badge variant="outline">Dual role</Badge>
                                )}
                            </div>
                            <p
                              className="truncate text-muted-foreground"
                              title={endpoint.baseUrl}
                            >
                              {details.label} · {modelLabel}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            endpoint.scopeType === "global"
                              ? "outline"
                              : "secondary"
                          }
                        >
                          {endpoint.scopeType === "global" && (
                            <LockKeyhole aria-hidden="true" />
                          )}
                          {endpoint.scopeType === "global"
                            ? isPlatformCatalog
                              ? "Platform catalog"
                              : "Platform-managed"
                            : endpoint.scopeType === "organization"
                              ? "Workspace"
                              : "Personal"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="gap-1.5">
                            <span
                              className={`size-1.5 rounded-full ${endpoint.enabled ? "bg-primary" : "bg-muted-foreground"}`}
                            />
                            {endpoint.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                          {endpoint.credentialConfigured && (
                            <Badge variant="outline" title="Credential stored">
                              <KeyRound aria-hidden="true" /> Credential
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex max-w-[250px] flex-wrap gap-1">
                          {capabilities.slice(0, 3).map((capability) => (
                            <Badge
                              key={capability}
                              variant="outline"
                              className="text-[10px]"
                            >
                              {capability}
                            </Badge>
                          ))}
                          {capabilities.length > 3 && (
                            <Badge variant="secondary" className="text-[10px]">
                              +{capabilities.length - 3}
                            </Badge>
                          )}
                          {capabilities.length === 0 && (
                            <span className="text-muted-foreground">
                              None configured
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`${manageable ? "Actions" : "Test"} for ${endpoint.name}`}
                              />
                            }
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={
                                !endpoint.enabled || busyId === endpoint.id
                              }
                              onClick={() => void onTest(endpoint)}
                            >
                              <Radio aria-hidden="true" /> Test capabilities
                            </DropdownMenuItem>
                            {manageable && (
                              <>
                                <DropdownMenuSeparator />
                                {!endpoint.isDefault && (
                                  <DropdownMenuItem
                                    disabled={busyId === endpoint.id}
                                    onClick={() => onSetDefault(endpoint)}
                                  >
                                    <CheckCircle2 aria-hidden="true" /> Set
                                    default
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  disabled={busyId === endpoint.id}
                                  className={
                                    endpoint.enabled
                                      ? "text-destructive focus:text-destructive"
                                      : "text-primary focus:text-primary"
                                  }
                                  onClick={() => onToggle(endpoint)}
                                >
                                  {endpoint.enabled ? "Disable" : "Enable"}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={busyId === endpoint.id}
                                  onClick={() => onEdit(endpoint)}
                                >
                                  <Pencil aria-hidden="true" /> Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={busyId === endpoint.id}
                                  variant="destructive"
                                  onClick={() => onRemove(endpoint)}
                                >
                                  <Trash2 aria-hidden="true" /> Remove
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
              <Cloud aria-hidden="true" />
            </div>
            <div>
              <p className="font-medium">
                {endpoints.length === 0
                  ? "No endpoints yet"
                  : "No endpoints match these filters"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {endpoints.length === 0
                  ? "Connect a provider to make it available for model routing."
                  : "Try a different search or clear the scope and status filters."}
              </p>
            </div>
            {endpoints.length === 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onCreate(kindFilter === "all" ? undefined : kindFilter)
                }
              >
                Add your first{" "}
                {kindFilter === "diarization"
                  ? "diarization service"
                  : "model endpoint"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
