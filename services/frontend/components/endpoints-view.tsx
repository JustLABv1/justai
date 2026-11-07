"use client"
import { ToastFeedback } from "@/components/toast-feedback"

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

import { cn } from "@/lib/utils"
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
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/panelui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Input } from "@/components/panelui/input"
import { Card } from "@/components/panelui/card"
import { Chip } from "@/components/panelui/chip"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { Menu } from "@/components/panelui/menu"
import { EndpointCreationWizard } from "@/components/endpoint-creation-wizard"
import { EndpointBadge } from "@/components/endpoint-badge"

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
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoRemoved, setLogoRemoved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState("")
  const [notice, setNotice] = useState("")
  const [search, setSearch] = useState("")
  // "auto" hides platform endpoints while the workspace has its own.
  const [scopeFilter, setScopeFilter] = useState("auto")
  const [statusFilter, setStatusFilter] = useState("all")
  const [kindFilter, setKindFilter] = useState<"all" | EndpointKind>("all")
  const [removeTarget, setRemoveTarget] = useState<Endpoint | null>(null)
  const createRequestRef = useRef(createRequest ?? 0)
  const [supportedProviders, setSupportedProviders] = useState<
    SupportedProvider[]
  >(fallbackSupportedProviders)
  const endpointPath = apiBasePath.replace(/\/+$/, "")
  const isPlatformCatalog = apiBasePath.startsWith("/api/v1/admin/")

  const hasOwnEndpoints = endpoints.some(
    (endpoint) => endpoint.scopeType !== "global"
  )
  const effectiveScope =
    scopeFilter === "auto" ? (hasOwnEndpoints ? "own" : "all") : scopeFilter
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
        effectiveScope === "all" ||
        (effectiveScope === "own"
          ? endpoint.scopeType !== "global"
          : endpoint.scopeType === effectiveScope)
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
  }, [endpoints, kindFilter, effectiveScope, search, statusFilter])

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
    setLogoFile(null)
    setLogoRemoved(false)
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
      let saved = result
      let logoError = ""
      try {
        if (logoFile) {
          const body = new FormData()
          body.set("logo", logoFile)
          saved = await api.upload<Endpoint>(
            `${endpointPath}/${result.id}/logo`,
            body
          )
        } else if (logoRemoved && editingEndpoint?.logoUrl) {
          saved = await api.delete<Endpoint>(
            `${endpointPath}/${result.id}/logo`
          )
        }
      } catch (caught) {
        // The endpoint itself is saved; only the logo needs another attempt.
        logoError =
          caught instanceof Error
            ? caught.message
            : "The logo could not be saved."
      }
      onChange(
        editingEndpoint
          ? endpoints.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...endpoints]
      )
      if (logoError) {
        notifyError(
          "Endpoint logo could not be saved",
          new Error(logoError),
          "The logo could not be saved."
        )
      }
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
      {notice && <ToastFeedback message={notice} type={"destructive"} />}

      <EndpointTable
        endpoints={endpoints}
        visibleEndpoints={visibleEndpoints}
        isPlatformCatalog={isPlatformCatalog}
        hasManagedEndpoints={endpoints.some(
          (item) => item.scopeType === "global"
        )}
        busyId={busyId}
        search={search}
        scopeFilter={effectiveScope}
        scopeAuto={scopeFilter === "auto"}
        statusFilter={statusFilter}
        kindFilter={kindFilter}
        onSearchChange={setSearch}
        onScopeChange={setScopeFilter}
        onStatusChange={setStatusFilter}
        onKindChange={setKindFilter}
        onClearFilters={() => {
          setSearch("")
          setScopeFilter("auto")
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
        logoFile={logoFile}
        logoRemoved={logoRemoved}
        onLogoChange={(file) => {
          setLogoFile(file)
          if (file) setLogoRemoved(false)
        }}
        onLogoRemove={() => {
          setLogoFile(null)
          setLogoRemoved(true)
        }}
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
          <AlertDialogTitle>{t("Remove endpoint?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Remove “")}
            {removeTarget?.name}
            {t(
              "”? Existing conversations keep their stored messages, but new requests will no longer route here."
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>
              {t("Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!removeTarget || Boolean(busyId)}
              tone="destructive"
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
  scopeAuto,
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
  scopeAuto: boolean
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
  const { t, locale } = useTranslations()

  const filterKey = JSON.stringify([
    search,
    scopeFilter,
    statusFilter,
    kindFilter,
  ])
  const [pagination, setPagination] = useState({ key: filterKey, page: 1 })
  const pageSize = 12
  const pageCount = Math.max(1, Math.ceil(visibleEndpoints.length / pageSize))
  const page = Math.min(
    pagination.key === filterKey ? pagination.page : 1,
    pageCount
  )
  const pageEndpoints = visibleEndpoints.slice(
    (page - 1) * pageSize,
    page * pageSize
  )
  const filtering =
    Boolean(search) ||
    !scopeAuto ||
    statusFilter !== "all" ||
    kindFilter !== "all"
  // A handful of endpoints needs no filters; they appear as the list grows.
  const showSearch = endpoints.length > 4 || Boolean(search)
  const showFilters = endpoints.length > 0
  const capabilityLabel = (capability: string) =>
    t(
      (
        {
          chat: "Chat",
          vision: "Vision",
          embeddings: "Embeddings",
          embedding: "Embeddings",
          "image-generation": "Images",
          transcription: "Transcription",
          "realtime-transcription": "Live transcription",
          diarization: "Speaker separation",
          speech: "Speech",
          tts: "Text-to-speech",
          tools: "Tools",
          multimodal: "Multimodal",
        } as Record<string, string>
      )[capability] ?? capability
    )
  const enabledCount = endpoints.filter((endpoint) => endpoint.enabled).length

  return (
    <div className="flex flex-col gap-4">
      {(showFilters || showCreateAction) && (
        <div className="flex flex-wrap items-center gap-2">
          {showFilters && (
            <>
              {showSearch && (
                <Input.Group className="w-full sm:w-72">
                  <Input.Addon>
                    <Search aria-hidden="true" />
                  </Input.Addon>
                  <Input
                    aria-label={t("Search endpoints")}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder={t("Search name, provider, model…")}
                    type="search"
                    value={search}
                  />
                </Input.Group>
              )}
              <Chip.Group
                aria-label={t("Filter endpoint type")}
                multiple={false}
                onValueChange={(value) =>
                  onKindChange((value[0] as "all" | EndpointKind) ?? "all")
                }
                value={[kindFilter]}
              >
                <Chip size="sm" value="all">
                  {t("All")}
                </Chip>
                <Chip size="sm" value="llm">
                  LLM
                </Chip>
                <Chip size="sm" value="diarization">
                  {t("Diarization")}
                </Chip>
              </Chip.Group>
              <div className="ms-auto flex flex-wrap items-center gap-2">
                <Chip.Group
                  aria-label={t("Filter endpoint scope")}
                  multiple={false}
                  onValueChange={(value) => onScopeChange(value[0] ?? "all")}
                  value={[scopeFilter]}
                >
                  <Chip size="sm" value="own">
                    {t("Own")}
                  </Chip>
                  <Chip size="sm" value="global">
                    {t("Platform")}
                  </Chip>
                  <Chip size="sm" value="all">
                    {t("All")}
                  </Chip>
                </Chip.Group>
                <Select
                  value={statusFilter}
                  onValueChange={(value) => onStatusChange(value ?? "all")}
                >
                  <SelectTrigger
                    aria-label={t("Filter endpoint status")}
                    className="w-40"
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
                {filtering && (
                  <Button size="sm" variant="ghost" onClick={onClearFilters}>
                    {t("Clear filters")}
                  </Button>
                )}
              </div>
            </>
          )}
          {showCreateAction && (
            <Button
              className={showFilters ? undefined : "ms-auto"}
              onClick={() => onCreate()}
              size="sm"
            >
              <Plus data-icon="inline-start" />
              {t("Add endpoint")}
            </Button>
          )}
        </div>
      )}

      {endpoints.length > 0 && !filtering && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t("{value0} endpoints · {value1} active", {
            value0: endpoints.length,
            value1: enabledCount,
          })}
        </p>
      )}

      {visibleEndpoints.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
                ? { label: t("Check failed"), variant: "destructive" as const }
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
            const busy = busyId === endpoint.id
            return (
              <Card
                className={cn("min-w-0", !endpoint.enabled && "opacity-80")}
                key={endpoint.id}
              >
                <Card.Header>
                  <div className="flex items-start gap-3">
                    <EndpointBadge
                      name={endpoint.name}
                      logoUrl={endpoint.logoUrl}
                      fallback={
                        <ProviderIcon provider={endpoint.providerType} />
                      }
                      className="size-10 shrink-0 rounded-xl bg-muted text-muted-foreground [&_svg]:size-5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        {manageable ? (
                          <button
                            className="min-w-0 truncate rounded-sm text-left text-base font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => onEdit(endpoint)}
                            type="button"
                          >
                            {endpoint.name}
                          </button>
                        ) : (
                          <p className="min-w-0 truncate text-base font-semibold">
                            {endpoint.name}
                          </p>
                        )}
                        {managed && (
                          <LockKeyhole
                            aria-label={
                              isPlatformCatalog
                                ? t("Platform catalog")
                                : t("Managed by platform")
                            }
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                        {endpoint.isDefault && (
                          <Badge size="sm" variant="info">
                            {t("Default")}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {details.label}
                        {" · "}
                        {endpointKindFor(endpoint) === "diarization"
                          ? t("Diarization")
                          : "LLM"}
                        {" · "}
                        {scopeLabel}
                      </p>
                    </div>
                    <Menu>
                      <Menu.Trigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="-me-1 -mt-1 shrink-0"
                            aria-label={t("{value0} for {value1}", {
                              value0: manageable ? t("Actions") : t("Test"),
                              value1: endpoint.name,
                            })}
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Menu.Trigger>
                      <Menu.Content align="end">
                        <Menu.Group>
                          <Menu.Item
                            disabled={!endpoint.enabled || busy}
                            onClick={() => void onTest(endpoint)}
                          >
                            <Radio aria-hidden="true" />{" "}
                            {t("Test capabilities")}
                          </Menu.Item>
                          {manageable && (
                            <>
                              <Menu.Separator />
                              {!endpoint.isDefault && (
                                <Menu.Item
                                  disabled={busy}
                                  onClick={() => onSetDefault(endpoint)}
                                >
                                  <CheckCircle2 aria-hidden="true" />{" "}
                                  {t("Set default")}
                                </Menu.Item>
                              )}
                              <Menu.Item
                                disabled={busy}
                                onClick={() => onEdit(endpoint)}
                              >
                                <Pencil aria-hidden="true" /> {t("Edit")}
                              </Menu.Item>
                              <Menu.Item
                                disabled={busy}
                                variant="destructive"
                                onClick={() => onRemove(endpoint)}
                              >
                                <Trash2 aria-hidden="true" /> {t("Remove")}
                              </Menu.Item>
                            </>
                          )}
                        </Menu.Group>
                      </Menu.Content>
                    </Menu>
                  </div>
                </Card.Header>
                <Card.Content className="flex flex-col gap-3">
                  <p
                    className="truncate rounded-lg bg-muted/60 px-2.5 py-1.5 font-mono text-xs"
                    title={endpoint.baseUrl}
                  >
                    {modelLabel}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      dot
                      size="sm"
                      title={t(endpointHealthSummary(endpoint))}
                      variant={status.variant}
                    >
                      {status.label}
                    </Badge>

                    {capabilities.slice(0, 4).map((capability) => (
                      <Badge key={capability} size="sm" variant="secondary">
                        {capabilityLabel(capability)}
                      </Badge>
                    ))}
                    {capabilities.length > 4 && (
                      <Badge
                        size="sm"
                        title={capabilities
                          .slice(4)
                          .map(capabilityLabel)
                          .join(", ")}
                        variant="secondary"
                      >
                        +{capabilities.length - 4}
                      </Badge>
                    )}
                  </div>
                </Card.Content>
                <Card.Footer variant="panel">
                  <div className="flex w-full flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {endpoint.lastTestedAt
                        ? t("Tested {value0}", {
                            value0: new Date(
                              endpoint.lastTestedAt
                            ).toLocaleDateString(locale),
                          })
                        : t("Not tested")}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={!endpoint.enabled || busy}
                        onClick={() => void onTest(endpoint)}
                        size="sm"
                        variant="outline"
                      >
                        {busy ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <Radio data-icon="inline-start" />
                        )}
                        {t("Test")}
                      </Button>
                      {manageable && (
                        <Switch
                          aria-label={t(
                            endpoint.enabled ? "Disable" : "Enable"
                          )}
                          checked={endpoint.enabled}
                          disabled={busy}
                          onCheckedChange={() => onToggle(endpoint)}
                        />
                      )}
                    </div>
                  </div>
                </Card.Footer>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card className="border-dashed">
          <Card.Content className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
            <span className="rounded-full bg-muted p-3 text-muted-foreground">
              <Cloud aria-hidden="true" className="size-6" />
            </span>
            <div className="flex max-w-md flex-col gap-1">
              <p className="font-medium">
                {resourceError && endpoints.length === 0
                  ? t("Endpoint inventory unavailable")
                  : endpoints.length === 0
                    ? t("No endpoints yet")
                    : t("No endpoints match these filters")}
              </p>
              <p className="text-sm text-muted-foreground">
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
              <Button variant="outline" onClick={onRetryResource}>
                {t("Retry")}
              </Button>
            ) : endpoints.length === 0 && !resourceError ? (
              <Button
                variant="outline"
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
              <Button variant="outline" onClick={onClearFilters}>
                {t("Clear filters")}
              </Button>
            ) : null}
          </Card.Content>
        </Card>
      )}

      {pageCount > 1 && (
        <nav
          aria-label={t("Endpoint pagination")}
          className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"
        >
          <span aria-live="polite">
            {t("{start}–{end} of {total}", {
              start: (page - 1) * pageSize + 1,
              end: Math.min(page * pageSize, visibleEndpoints.length),
              total: visibleEndpoints.length,
            })}
          </span>
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
        </nav>
      )}
      {hasManagedEndpoints && !isPlatformCatalog && (
        <p className="text-xs text-muted-foreground">
          {t(
            "Locked endpoints are managed by the platform and can only be changed in the Platform Admin catalog."
          )}
        </p>
      )}
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
