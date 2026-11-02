"use client"

import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  CircleAlert,
  Cloud,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plus,
  Radio,
  Server,
  Search,
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
  showCreateAction?: boolean
  resourceError?: string
  onRetryResource?: () => void
}

function endpointHealthSummary(endpoint: Endpoint) {
  const results = Object.entries(endpoint.lastTestResults ?? {})
  const checks = results
    .map(([capability, result]) => {
      if (result.tested) {
        return `${capability}: ${result.ok ? "ok" : result.error || "failed"}`
      }
      return `${capability}: ${result.note || "not probed"}`
    })
    .join("; ")
  return [
    endpoint.lastTestedAt
      ? `Last tested ${new Date(endpoint.lastTestedAt).toLocaleString()}`
      : "Not tested",
    endpoint.lastTestError,
    checks,
  ]
    .filter(Boolean)
    .join(" · ")
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
  showCreateAction = false,
  resourceError,
  onRetryResource,
}: Props) {
  const { t } = useTranslations()

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
      isDefault: pyannote ? false : current.isDefault,
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
      const result = editingEndpoint
        ? await api.patch<Endpoint>(
            `${endpointPath}/${editingEndpoint.id}`,
            payload
          )
        : await api.post<Endpoint>(endpointPath, {
            ...payload,
            isDefault: capabilities.chat && form.isDefault,
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
    setBusyId(endpoint.id)
    setNotice("")
    try {
      const result = await api.post<{
        endpoint?: Endpoint
        results?: Record<
          string,
          {
            ok: boolean
            supported: boolean
            tested: boolean
            error?: string
            note?: string
          }
        >
      }>(`${endpointPath}/${endpoint.id}/test`)
      const testedEndpoint = result.endpoint
      if (testedEndpoint) {
        onChange(
          endpoints.map((item) =>
            item.id === testedEndpoint.id ? testedEndpoint : item
          )
        )
      }
      const failed = Object.entries(result.results ?? {}).filter(
        ([, value]) => value.tested && !value.ok
      )
      const failedDetails = failed
        .map(
          ([capability, value]) => `${capability}: ${value.error ?? "failed"}`
        )
        .join("; ")
      const message =
        failed.length === 0
          ? `${endpoint.name} capability checks completed.`
          : `${endpoint.name} has ${failed.length} failing capability check${failed.length === 1 ? "" : "s"}. ${failedDetails}`
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
    } finally {
      setBusyId("")
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
      {resourceError && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <span>
            {t("Endpoints could not be loaded.")} {t(resourceError)}
          </span>
          {onRetryResource && (
            <Button size="sm" variant="outline" onClick={onRetryResource}>
              {t("Retry")}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {t(notice)}
        </div>
      )}

      <EndpointTable
        endpoints={endpoints}
        visibleEndpoints={visibleEndpoints}
        isPlatformCatalog={isPlatformCatalog}
        hasManagedEndpoints={endpoints.some(
          (item) => item.scopeType === "global"
        )}
        busyId={busyId}
        search={search}
        scopeFilter={scopeFilter}
        statusFilter={statusFilter}
        kindFilter={kindFilter}
        onSearchChange={setSearch}
        onScopeChange={setScopeFilter}
        onStatusChange={setStatusFilter}
        onKindChange={setKindFilter}
        onClearFilters={() => {
          setSearch("")
          setScopeFilter("all")
          setStatusFilter("all")
          setKindFilter("all")
        }}
        canManageEndpoint={canManageEndpoint}
        onTest={testEndpoint}
        onSetDefault={setDefaultEndpoint}
        onToggle={toggleEndpoint}
        onEdit={openEdit}
        onRemove={setRemoveTarget}
        onCreate={openCreate}
        showCreateAction={showCreateAction}
        resourceError={resourceError}
        onRetryResource={onRetryResource}
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
            <AlertDialogTitle>{t("Remove endpoint?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Remove “")}
              {removeTarget?.name}
              {t(
                "”? Existing conversations keep their stored messages, but new requests will no longer route here."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>
              {t("Cancel")}
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
              {t("Remove endpoint")}
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
  hasManagedEndpoints,
  busyId,
  search,
  scopeFilter,
  statusFilter,
  kindFilter,
  onSearchChange,
  onScopeChange,
  onStatusChange,
  onKindChange,
  onClearFilters,
  canManageEndpoint,
  onTest,
  onSetDefault,
  onToggle,
  onEdit,
  onRemove,
  onCreate,
  showCreateAction,
  resourceError,
  onRetryResource,
}: {
  endpoints: Endpoint[]
  visibleEndpoints: Endpoint[]
  isPlatformCatalog: boolean
  hasManagedEndpoints: boolean
  busyId: string
  search: string
  scopeFilter: string
  statusFilter: string
  kindFilter: "all" | EndpointKind
  onSearchChange: (value: string) => void
  onScopeChange: (value: string) => void
  onStatusChange: (value: string) => void
  onKindChange: (value: "all" | EndpointKind) => void
  onClearFilters: () => void
  canManageEndpoint: (endpoint: Endpoint) => boolean
  onTest: (endpoint: Endpoint) => Promise<void>
  onSetDefault: (endpoint: Endpoint) => void
  onToggle: (endpoint: Endpoint) => void
  onEdit: (endpoint: Endpoint) => void
  onRemove: (endpoint: Endpoint) => void
  showCreateAction?: boolean
  onCreate: (kind?: EndpointKind) => void
  resourceError?: string
  onRetryResource?: () => void
}) {
  const { t } = useTranslations()

  const filterKey = JSON.stringify([
    search,
    scopeFilter,
    statusFilter,
    kindFilter,
  ])
  const [pagination, setPagination] = useState({ key: filterKey, page: 1 })
  const pageCount = Math.max(1, Math.ceil(visibleEndpoints.length / 20))
  const page = Math.min(
    pagination.key === filterKey ? pagination.page : 1,
    pageCount
  )
  const pageEndpoints = visibleEndpoints.slice((page - 1) * 20, page * 20)
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 px-4">
        <div className="relative min-w-48 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t("Search endpoints")}
            className="h-8 pl-8"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("Search name, provider, model…")}
            type="search"
            value={search}
          />
        </div>
        <Tabs
          value={kindFilter}
          onValueChange={(value) =>
            onKindChange((value as "all" | EndpointKind) ?? "all")
          }
        >
          <TabsList aria-label={t("Filter endpoint type")}>
            <TabsTrigger value="all">{t("All")}</TabsTrigger>
            <TabsTrigger value="llm">LLM</TabsTrigger>
            <TabsTrigger value="diarization">{t("Diarization")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <>
          <Select
            value={scopeFilter}
            onValueChange={(value) => onScopeChange(value ?? "all")}
          >
            <SelectTrigger
              aria-label={t("Filter endpoint scope")}
              className="h-8 min-w-32"
              size="sm"
            >
              <SelectValue>
                {t(
                  scopeFilter === "global"
                    ? "Global"
                    : scopeFilter === "organization"
                      ? "Workspace"
                      : scopeFilter === "user"
                        ? "Personal"
                        : "All scopes"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("All scopes")}</SelectItem>
                <SelectItem value="global">{t("Global")}</SelectItem>
                <SelectItem value="organization">{t("Workspace")}</SelectItem>
                <SelectItem value="user">{t("Personal")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(value) => onStatusChange(value ?? "all")}
          >
            <SelectTrigger
              aria-label={t("Filter endpoint status")}
              className="h-8 min-w-32"
              size="sm"
            >
              <SelectValue>
                {t(
                  statusFilter === "enabled"
                    ? "Enabled"
                    : statusFilter === "disabled"
                      ? "Disabled"
                      : "All statuses"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("All statuses")}</SelectItem>
                <SelectItem value="enabled">{t("Enabled")}</SelectItem>
                <SelectItem value="disabled">{t("Disabled")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </>
        {(search ||
          scopeFilter !== "all" ||
          statusFilter !== "all" ||
          kindFilter !== "all") && (
          <Button size="sm" variant="ghost" onClick={onClearFilters}>
            {t("Clear filters")}
          </Button>
        )}
        {showCreateAction && (
          <Button size="sm" onClick={() => onCreate()}>
            <Plus data-icon="inline-start" />
            {t("Add endpoint")}
          </Button>
        )}
      </div>
      {visibleEndpoints.length > 0 ? (
        <div className="min-w-0 overflow-x-auto px-4">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="p-2">{t("Endpoint")}</th>
                <th className="p-2">{t("Endpoint type")}</th>
                <th className="p-2">{t("Scope")}</th>
                <th className="p-2">{t("Status")}</th>
                <th className="p-2 text-right">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {pageEndpoints.map((endpoint) => {
                const details =
                  providerDetails[endpoint.providerType] ??
                  providerDetails["openai-compatible"]
                const modelLabel =
                  endpoint.chatModel ||
                  endpoint.diarizationModel ||
                  t("Model selected at request time")
                const manageable = canManageEndpoint(endpoint)
                const managed = endpoint.scopeType === "global"
                const capabilities = Object.entries(endpoint.capabilities ?? {})
                  .filter(([, enabled]) => enabled)
                  .map(([capability]) => capability)
                const failed = endpoint.lastTestOk === false
                const status = !endpoint.enabled
                  ? { label: t("Disabled"), variant: "secondary" as const }
                  : failed
                    ? {
                        label: t("Check failed"),
                        variant: "destructive" as const,
                      }
                    : endpoint.lastTestedAt
                      ? { label: t("Healthy"), variant: "success" as const }
                      : { label: t("Not tested"), variant: "outline" as const }
                const scopeLabel = t(
                  endpoint.scopeType === "organization"
                    ? "Workspace"
                    : endpoint.scopeType === "user"
                      ? "Personal"
                      : "Global"
                )
                return (
                  <tr
                    className="border-b border-border last:border-0"
                    key={endpoint.id}
                  >
                    <td className="max-w-xs p-2">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <ProviderIcon provider={endpoint.providerType} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {manageable ? (
                              <button
                                className="truncate rounded-sm text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => onEdit(endpoint)}
                                type="button"
                              >
                                {endpoint.name}
                              </button>
                            ) : (
                              <p className="truncate text-sm font-medium">
                                {endpoint.name}
                              </p>
                            )}
                            {endpoint.isDefault && (
                              <Badge variant="outline">{t("Default")}</Badge>
                            )}
                          </div>
                          <p
                            className="truncate text-xs text-muted-foreground"
                            title={[
                              endpoint.baseUrl,
                              capabilities.length
                                ? t("Capabilities: {value0}", {
                                    value0: capabilities.join(", "),
                                  })
                                : t("No capabilities configured"),
                            ].join("\n")}
                          >
                            {details.label} · {modelLabel}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="p-2">
                      <Badge variant="secondary">
                        {endpointKindFor(endpoint) === "diarization"
                          ? t("Diarization")
                          : "LLM"}
                      </Badge>
                    </td>
                    <td className="p-2">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        {managed && (
                          <LockKeyhole
                            className="size-3.5"
                            aria-label={
                              isPlatformCatalog
                                ? t("Platform catalog")
                                : t("Managed by platform")
                            }
                          />
                        )}
                        {scopeLabel}
                      </span>
                    </td>
                    <td className="p-2">
                      <Badge
                        variant={status.variant}
                        title={t(endpointHealthSummary(endpoint))}
                      >
                        {status.label}
                      </Badge>
                    </td>
                    <td className="p-2">
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("{value0} for {value1}", {
                                  value0: manageable ? t("Actions") : t("Test"),
                                  value1: endpoint.name,
                                })}
                              />
                            }
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                disabled={
                                  !endpoint.enabled || busyId === endpoint.id
                                }
                                onClick={() => void onTest(endpoint)}
                              >
                                <Radio aria-hidden="true" />{" "}
                                {t("Test capabilities")}
                              </DropdownMenuItem>
                              {manageable && (
                                <>
                                  <DropdownMenuSeparator />
                                  {!endpoint.isDefault && (
                                    <DropdownMenuItem
                                      disabled={busyId === endpoint.id}
                                      onClick={() => onSetDefault(endpoint)}
                                    >
                                      <CheckCircle2 aria-hidden="true" />{" "}
                                      {t("Set default")}
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
                                    {endpoint.enabled
                                      ? t("Disable")
                                      : t("Enable")}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={busyId === endpoint.id}
                                    onClick={() => onEdit(endpoint)}
                                  >
                                    <Pencil aria-hidden="true" /> {t("Edit")}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={busyId === endpoint.id}
                                    variant="destructive"
                                    onClick={() => onRemove(endpoint)}
                                  >
                                    <Trash2 aria-hidden="true" /> {t("Remove")}
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 border-t border-border/60 px-4 py-8 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Cloud aria-hidden="true" />
          </div>
          <div>
            <p className="font-medium">
              {resourceError && endpoints.length === 0
                ? t("Endpoint inventory unavailable")
                : endpoints.length === 0
                  ? t("No endpoints yet")
                  : t("No endpoints match these filters")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {resourceError && endpoints.length === 0
                ? t(
                    "JustAI could not load the endpoint catalog. Retry to check again."
                  )
                : endpoints.length === 0
                  ? t(
                      "Connect a provider to make it available for model routing."
                    )
                  : t("Try a different search or clear the filters.")}
            </p>
          </div>
          {resourceError && endpoints.length === 0 && onRetryResource ? (
            <Button variant="outline" size="sm" onClick={onRetryResource}>
              {t("Retry")}
            </Button>
          ) : endpoints.length === 0 && !resourceError ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onCreate(kindFilter === "all" ? undefined : kindFilter)
              }
            >
              {t("Add your first")}{" "}
              {kindFilter === "diarization"
                ? t("diarization service")
                : t("model endpoint")}
            </Button>
          ) : endpoints.length > 0 ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t("Clear filters")}
            </Button>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {visibleEndpoints.length
            ? t("{start}–{end} of {total}", {
                start: (page - 1) * 20 + 1,
                end: Math.min(page * 20, visibleEndpoints.length),
                total: visibleEndpoints.length,
              })
            : t("No endpoints match these filters")}
        </span>
        {pageCount > 1 && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 1}
              onClick={() => setPagination({ key: filterKey, page: page - 1 })}
            >
              {t("Previous page")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page === pageCount}
              onClick={() => setPagination({ key: filterKey, page: page + 1 })}
            >
              {t("Next page")}
            </Button>
          </div>
        )}
      </div>
      {hasManagedEndpoints && !isPlatformCatalog && (
        <p className="px-4 text-xs text-muted-foreground">
          {t(
            "Locked endpoints are managed by the platform and can only be changed in the Platform Admin catalog."
          )}
        </p>
      )}
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
