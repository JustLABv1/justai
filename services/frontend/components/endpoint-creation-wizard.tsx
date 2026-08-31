"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Layers3,
  Link2,
  ListChecks,
  MessageSquare,
  Mic2,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react"

import { api } from "@/lib/api"
import type { Endpoint, EndpointKind } from "@/lib/types"
import {
  buildEndpointCapabilities,
  isWhisperGateway,
  providerDetails,
  providerSupports,
  providersForKind,
  timeoutForProvider,
  type DiscoveredChatModel,
  type EndpointForm,
  type SupportedProvider,
} from "@/lib/endpoint-logic"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

type WizardStep = "type" | "connection" | "configure" | "review"

type PreflightState = "idle" | "checking" | "passed" | "failed"

type PreflightResponse = {
  ok: boolean
  configuredModel?: string
  models?: DiscoveredChatModel[]
  checks?: {
    connection?: { ok?: boolean; message?: string }
    models?: { ok?: boolean; message?: string }
  }
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingEndpoint: Endpoint | null
  form: EndpointForm
  setForm: Dispatch<SetStateAction<EndpointForm>>
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
  providers: SupportedProvider[]
  endpointPath: string
  canManageOrganization: boolean
  platformAdmin: boolean
  isPlatformCatalog: boolean
  saving: boolean
  notice?: string
  onSelectProvider: (value: string | null) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void | Promise<void>
  onClose: () => void
}

const steps: Array<{
  id: WizardStep
  label: string
  description: string
  icon: typeof WandSparkles
}> = [
  {
    id: "type",
    label: "Choose a lane",
    description: "Tell JustAI what this endpoint is for.",
    icon: WandSparkles,
  },
  {
    id: "connection",
    label: "Connect provider",
    description: "Add the URL, scope, and credential.",
    icon: Link2,
  },
  {
    id: "configure",
    label: "Configure models",
    description: "Map only the models and capabilities you need.",
    icon: SlidersHorizontal,
  },
  {
    id: "review",
    label: "Verify & review",
    description: "Check the provider before saving.",
    icon: ShieldCheck,
  },
]

const stepIndex = (step: WizardStep) =>
  steps.findIndex((item) => item.id === step)

function displayProvider(provider: SupportedProvider) {
  return provider.name ?? providerDetails[provider.id]?.label ?? provider.id
}

function capabilityLabel(capability: string) {
  return capability
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function modelOptions(models: DiscoveredChatModel[], configured: string) {
  const values = new Map<string, DiscoveredChatModel>()
  for (const model of models) {
    if (model.id?.trim()) values.set(model.id, model)
  }
  if (configured.trim())
    values.set(configured.trim(), { id: configured.trim() })
  return [...values.values()]
}

function formSignature(form: EndpointForm) {
  let credentialHash = 2166136261
  for (let index = 0; index < form.credential.length; index += 1) {
    credentialHash ^= form.credential.charCodeAt(index)
    credentialHash = Math.imul(credentialHash, 16777619)
  }
  return JSON.stringify({
    ...form,
    credential: `${form.credential.length}:${credentialHash >>> 0}`,
  })
}

function CapabilitySwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border bg-card px-3 py-2.5",
        disabled && "opacity-55"
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

export function EndpointCreationWizard({
  open,
  onOpenChange,
  editingEndpoint,
  form,
  setForm,
  update,
  providers,
  endpointPath,
  canManageOrganization,
  platformAdmin,
  isPlatformCatalog,
  saving,
  notice,
  onSelectProvider,
  onSave,
  onClose,
}: Props) {
  const [step, setStep] = useState<WizardStep>("type")
  const [maxVisitedStep, setMaxVisitedStep] = useState(0)
  const [advancedConnectionOpen, setAdvancedConnectionOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [preflightState, setPreflightState] = useState<PreflightState>("idle")
  const [preflightMessage, setPreflightMessage] = useState("")
  const [preflightModels, setPreflightModels] = useState<DiscoveredChatModel[]>(
    []
  )
  const [verifiedSignature, setVerifiedSignature] = useState("")
  const [verificationOverride, setVerificationOverride] = useState(false)

  useEffect(() => {
    if (form.providerType === "pyannote") {
      setRuntimeOpen(true)
    }
  }, [form.providerType])

  const isEditing = Boolean(editingEndpoint)
  const availableProviders = useMemo(() => {
    const matching = providersForKind(providers, form.endpointKind)
    if (matching.some((provider) => provider.id === form.providerType)) {
      return matching
    }
    const selected = providers.find(
      (provider) => provider.id === form.providerType
    )
    return selected ? [selected, ...matching] : matching
  }, [form.endpointKind, form.providerType, providers])
  const supports = useCallback(
    (provider: string, capability: string) =>
      providerSupports(providers, provider, capability),
    [providers]
  )
  const capabilities = useMemo(
    () => buildEndpointCapabilities(form, supports),
    [form, supports]
  )
  const signature = useMemo(() => formSignature(form), [form])
  const verificationIsCurrent = verifiedSignature === signature
  const canSave =
    verificationIsCurrent &&
    (preflightState === "passed" || verificationOverride)
  const currentIndex = stepIndex(step)
  const options = modelOptions(preflightModels, form.chatModel)
  const selectedProvider =
    providerDetails[form.providerType] ?? providerDetails["openai-compatible"]

  function selectKind(endpointKind: EndpointKind) {
    if (isEditing) return
    const firstProvider = providersForKind(providers, endpointKind)[0]
    const providerType = firstProvider?.id ?? form.providerType
    const provider = providerDetails[providerType]
    setForm((current) => ({
      ...current,
      endpointKind,
      providerType,
      baseUrl: provider?.baseUrl ?? current.baseUrl,
      useForChat: endpointKind === "llm",
      diarization: endpointKind === "diarization" || current.diarization,
      timeoutSeconds: timeoutForProvider(providerType, current.timeoutSeconds),
      isDefault: endpointKind === "llm" ? current.isDefault : false,
    }))
  }

  function goTo(nextStep: WizardStep) {
    const nextIndex = stepIndex(nextStep)
    setStep(nextStep)
    setMaxVisitedStep((current) => Math.max(current, nextIndex))
  }

  function nextStep() {
    if (step === "type") return goTo("connection")
    if (step === "connection") return goTo("configure")
    if (step === "configure") return goTo("review")
  }

  function previousStep() {
    if (step === "connection") return goTo("type")
    if (step === "configure") return goTo("connection")
    if (step === "review") return goTo("configure")
  }

  function validateBeforeNext() {
    if (step === "connection") {
      if (!form.name.trim()) {
        setPreflightMessage(
          "Give this endpoint a name so it is easy to find later."
        )
        return false
      }
      if (!form.baseUrl.trim()) {
        setPreflightMessage("Add the provider base URL before continuing.")
        return false
      }
    }
    if (
      step === "configure" &&
      form.endpointKind === "diarization" &&
      !capabilities.diarization
    ) {
      setPreflightMessage(
        "Diarization needs a supported diarization capability."
      )
      return false
    }
    setPreflightMessage("")
    return true
  }

  async function checkConnection() {
    setPreflightState("checking")
    setPreflightMessage("")
    setVerificationOverride(false)
    try {
      const result = await api.post<PreflightResponse>(
        `${endpointPath}/preflight`,
        {
          ...form,
          endpointId: editingEndpoint?.id,
          scopeId: form.scopeId.trim() || null,
          capabilities,
        }
      )
      const models = (result.models ?? []).filter((model) => model.id?.trim())
      setPreflightModels(models)
      if (result.ok) {
        setPreflightState("passed")
        setPreflightMessage(
          result.checks?.models?.message ??
            result.checks?.connection?.message ??
            "Provider is reachable."
        )
        let verifiedForm = form
        const discoveredChatModel =
          (form.endpointKind === "llm" || form.useForChat) &&
          !form.chatModel.trim() &&
          result.configuredModel?.trim()
            ? result.configuredModel
            : (form.endpointKind === "llm" || form.useForChat) &&
                !form.chatModel.trim()
              ? models[0]?.id
              : undefined
        if (discoveredChatModel) {
          verifiedForm = { ...form, chatModel: discoveredChatModel }
          setForm(verifiedForm)
        }
        setVerifiedSignature(formSignature(verifiedForm))
      } else {
        setPreflightState("failed")
        setVerifiedSignature(signature)
        setPreflightMessage(
          result.checks?.connection?.message ??
            "The provider could not be verified."
        )
      }
    } catch (caught) {
      setPreflightState("failed")
      setPreflightMessage(
        caught instanceof Error
          ? caught.message
          : "The provider could not be verified."
      )
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (step !== "review") {
      event.preventDefault()
      if (validateBeforeNext()) nextStep()
      return
    }
    if (!canSave) {
      event.preventDefault()
      setPreflightMessage(
        preflightState === "failed"
          ? "Verification failed. Review the connection or explicitly continue without verification."
          : "Check the connection before saving this endpoint."
      )
      return
    }
    void onSave(event)
  }

  function continueWithoutVerification() {
    setVerificationOverride(true)
    setVerifiedSignature(signature)
    setPreflightMessage(
      "You can save this endpoint without a successful preflight. JustAI will use the saved connection as configured."
    )
  }

  const stepContent =
    step === "type" ? (
      <TypeStep
        endpointKind={form.endpointKind}
        locked={isEditing}
        onSelect={selectKind}
      />
    ) : step === "connection" ? (
      <ConnectionStep
        form={form}
        update={update}
        providers={availableProviders}
        selectedProvider={selectedProvider}
        canManageOrganization={canManageOrganization}
        platformAdmin={platformAdmin}
        isPlatformCatalog={isPlatformCatalog}
        isEditing={isEditing}
        advancedOpen={advancedConnectionOpen}
        onAdvancedOpenChange={setAdvancedConnectionOpen}
        onSelectProvider={onSelectProvider}
      />
    ) : step === "configure" ? (
      <ConfigureStep
        form={form}
        setForm={setForm}
        update={update}
        supports={supports}
        preflightModels={preflightModels}
        options={options}
        runtimeOpen={runtimeOpen}
        onRuntimeOpenChange={setRuntimeOpen}
      />
    ) : (
      <ReviewStep
        form={form}
        endpointKind={form.endpointKind}
        providerLabel={selectedProvider.label}
        capabilities={capabilities}
        preflightState={preflightState}
        preflightMessage={preflightMessage}
        modelCount={preflightModels.length}
        verificationOverride={verificationOverride}
        verificationIsCurrent={verificationIsCurrent}
        notice={notice}
        onCheck={checkConnection}
        onContinueWithoutVerification={continueWithoutVerification}
      />
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4 sm:px-6">
          <div className="flex items-start gap-3 pr-8">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              {form.endpointKind === "diarization" ? (
                <Mic2 aria-hidden="true" />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle>
                {isEditing ? "Edit endpoint" : "Add an endpoint"}
              </DialogTitle>
              <DialogDescription>
                {isEditing
                  ? "Review the same guided setup used when this endpoint was created. Its lane stays fixed."
                  : "A short guided setup keeps chat models and diarization services easy to configure."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          id="endpoint-creation-form"
          className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[13rem_minmax(0,1fr)] md:grid-rows-1"
          onSubmit={handleSubmit}
        >
          <nav
            aria-label="Endpoint setup steps"
            className="border-b px-4 py-3 md:border-r md:border-b-0 md:px-3 md:py-5"
          >
            <div className="flex gap-1 overflow-x-auto md:flex-col md:gap-1.5">
              {steps.map((item, index) => {
                const Icon = item.icon
                const active = item.id === step
                const available = index <= maxVisitedStep || index === 0
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!available}
                    aria-current={active ? "step" : undefined}
                    onClick={() => available && goTo(item.id)}
                    className={cn(
                      "group flex min-w-[8.75rem] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors md:min-w-0",
                      active
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      !available && "pointer-events-none opacity-45"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md border",
                        active
                          ? "border-primary/40 bg-background text-primary"
                          : "border-border bg-muted/40"
                      )}
                    >
                      {index < maxVisitedStep ? (
                        <Check className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Icon className="size-3.5" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {item.label}
                      </span>
                      <span className="hidden truncate text-[10px] text-muted-foreground md:block">
                        {item.description}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </nav>

          <div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            <div className="mx-auto w-full max-w-3xl">{stepContent}</div>
          </div>
        </form>

        <DialogFooter className="border-t px-5 py-3 sm:px-6">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {currentIndex > 0 && (
            <Button type="button" variant="ghost" onClick={previousStep}>
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              Back
            </Button>
          )}
          {step !== "review" ? (
            <Button
              type="submit"
              form="endpoint-creation-form"
              onClick={(event) => {
                event.preventDefault()
                if (validateBeforeNext()) nextStep()
              }}
            >
              Continue
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          ) : (
            <Button
              type="submit"
              form="endpoint-creation-form"
              disabled={saving || !canSave}
            >
              {saving
                ? "Saving…"
                : isEditing
                  ? "Save changes"
                  : "Save endpoint"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TypeStep({
  endpointKind,
  locked,
  onSelect,
}: {
  endpointKind: EndpointKind
  locked: boolean
  onSelect: (kind: EndpointKind) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-medium">What are you connecting?</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick the primary job for this endpoint. The same provider can be saved
          in both lanes when it serves both jobs.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TypeCard
          active={endpointKind === "llm"}
          disabled={locked}
          icon={<MessageSquare aria-hidden="true" />}
          title="LLM"
          description="Chat, vision, embeddings, image generation, transcription, TTS, and optional diarization."
          onClick={() => onSelect("llm")}
        />
        <TypeCard
          active={endpointKind === "diarization"}
          disabled={locked}
          icon={<Mic2 aria-hidden="true" />}
          title="Diarization"
          description="Speaker identification for transcription pipelines, with optional chat on providers that support it."
          onClick={() => onSelect("diarization")}
        />
      </div>
      <Alert>
        <Layers3 aria-hidden="true" />
        <AlertTitle>Capabilities stay flexible</AlertTitle>
        <AlertDescription>
          This label controls setup and inventory. Runtime routing still follows
          the capabilities you enable, so one endpoint can appear in both views.
        </AlertDescription>
      </Alert>
      {locked && (
        <p className="text-xs text-muted-foreground">
          Endpoint type is fixed after creation so existing routing remains
          predictable.
        </p>
      )}
    </div>
  )
}

function TypeCard({
  active,
  disabled,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean
  disabled: boolean
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex min-h-40 flex-col items-start gap-4 rounded-xl border p-4 text-left transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "hover:bg-muted/50",
        disabled && "cursor-default opacity-80"
      )}
    >
      <span
        className={cn(
          "flex size-9 items-center justify-center rounded-lg",
          active ? "bg-primary text-primary-foreground" : "bg-muted"
        )}
      >
        {icon}
      </span>
      <span>
        <span className="flex items-center gap-2 font-medium">
          {title}
          {active && (
            <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

function ConnectionStep({
  form,
  update,
  providers,
  selectedProvider,
  canManageOrganization,
  platformAdmin,
  isPlatformCatalog,
  isEditing,
  advancedOpen,
  onAdvancedOpenChange,
  onSelectProvider,
}: {
  form: EndpointForm
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
  providers: SupportedProvider[]
  selectedProvider: (typeof providerDetails)[string]
  canManageOrganization: boolean
  platformAdmin: boolean
  isPlatformCatalog: boolean
  isEditing: boolean
  advancedOpen: boolean
  onAdvancedOpenChange: (open: boolean) => void
  onSelectProvider: (value: string | null) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-medium">Connect the provider</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Start with the few values that identify the service. Advanced route
          overrides stay available below if your gateway needs them.
        </p>
      </div>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Connection details</CardTitle>
          <CardDescription>
            {form.endpointKind === "diarization"
              ? "This service will be used for speaker labeling."
              : "This provider will be used for model-backed AI features."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="endpoint-name">Display name</FieldLabel>
                <Input
                  id="endpoint-name"
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  placeholder={
                    form.endpointKind === "diarization"
                      ? "Speaker service"
                      : "Team GPT"
                  }
                  required
                />
              </Field>
              <Field>
                <FieldLabel>Provider</FieldLabel>
                <Select
                  value={form.providerType}
                  onValueChange={onSelectProvider}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {displayProvider(provider)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {selectedProvider.description}
                  {providers.find(
                    (provider) => provider.id === form.providerType
                  )?.examples?.length
                    ? ` Examples: ${providers.find((provider) => provider.id === form.providerType)?.examples?.join(", ")}.`
                    : ""}
                </FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel>Visibility</FieldLabel>
              <Select
                disabled={isEditing}
                value={form.scopeType}
                onValueChange={(value) =>
                  update(
                    "scopeType",
                    value ?? (canManageOrganization ? "organization" : "user")
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {canManageOrganization && (
                    <SelectItem value="organization">Workspace</SelectItem>
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
                Choose who can use this endpoint. Its scope cannot be changed
                after creation.
              </FieldDescription>
            </Field>
            {platformAdmin && form.scopeType !== "global" && (
              <Field>
                <FieldLabel htmlFor="endpoint-scope-id">Scope ID</FieldLabel>
                <Input
                  id="endpoint-scope-id"
                  value={form.scopeId}
                  onChange={(event) => update("scopeId", event.target.value)}
                  placeholder="Organization or user UUID"
                  required
                  readOnly={isEditing}
                />
                <FieldDescription>
                  {isEditing
                    ? "An endpoint&apos;s scope is fixed after creation."
                    : "Platform administrators can assign this endpoint to a specific organization or user."}
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="endpoint-url">Base URL</FieldLabel>
              <Input
                id="endpoint-url"
                value={form.baseUrl}
                onChange={(event) => update("baseUrl", event.target.value)}
                placeholder={selectedProvider.baseUrl}
                required
              />
              <FieldDescription>
                {selectedProvider.baseUrl} is the suggested default; local
                services and gateways can use their own URL.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="endpoint-key">API key or token</FieldLabel>
              <div className="relative">
                <KeyRound
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="endpoint-key"
                  className="pl-8"
                  type="password"
                  value={form.credential}
                  onChange={(event) => update("credential", event.target.value)}
                  placeholder="Stored encrypted by JustAI"
                  autoComplete="off"
                />
              </div>
              <FieldDescription>
                Leave empty for local runtimes. When editing, an empty field
                keeps the stored credential.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Collapsible
        className="rounded-xl border"
        open={advancedOpen}
        onOpenChange={onAdvancedOpenChange}
      >
        <CollapsibleTrigger
          render={
            <Button
              className="h-auto w-full justify-start rounded-xl px-4 py-3 text-left hover:bg-muted/50"
              size="sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <Server data-icon="inline-start" aria-hidden="true" />
          <span>
            <span className="block font-medium">Advanced connection</span>
            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
              Custom API path and version headers
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="endpoint-api-path">
                API path (optional)
              </FieldLabel>
              <Input
                id="endpoint-api-path"
                value={form.apiPath}
                onChange={(event) => update("apiPath", event.target.value)}
                placeholder="/v1"
              />
              <FieldDescription>
                Override the provider&apos;s default route.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="endpoint-api-version">
                API version (optional)
              </FieldLabel>
              <Input
                id="endpoint-api-version"
                value={form.apiVersion}
                onChange={(event) => update("apiVersion", event.target.value)}
                placeholder="2024-06-20"
              />
              <FieldDescription>
                Used by providers that require a version header.
              </FieldDescription>
            </Field>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ConfigureStep({
  form,
  setForm,
  update,
  supports,
  preflightModels,
  options,
  runtimeOpen,
  onRuntimeOpenChange,
}: {
  form: EndpointForm
  setForm: Dispatch<SetStateAction<EndpointForm>>
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
  supports: (provider: string, capability: string) => boolean
  preflightModels: DiscoveredChatModel[]
  options: DiscoveredChatModel[]
  runtimeOpen: boolean
  onRuntimeOpenChange: (open: boolean) => void
}) {
  const chatAvailable = form.endpointKind === "llm" || form.useForChat
  const transcriptionAvailable =
    supports(form.providerType, "realtime-transcription") ||
    supports(form.providerType, "chunked-transcription")
  const hasOptionalModels =
    supports(form.providerType, "vision") ||
    supports(form.providerType, "embeddings") ||
    supports(form.providerType, "image-generation") ||
    transcriptionAvailable ||
    supports(form.providerType, "diarization") ||
    supports(form.providerType, "tts")

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-medium">
          {form.endpointKind === "diarization"
            ? "Configure the diarization service"
            : "Configure models and capabilities"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {form.endpointKind === "diarization"
            ? "Choose the speaker-labeling model and decide whether this same endpoint should also handle chat."
            : "Chat is the primary LLM capability. Add optional model mappings only when this provider will serve those jobs."}
        </p>
      </div>

      {form.endpointKind === "diarization" ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic2 aria-hidden="true" /> Diarization model
            </CardTitle>
            <CardDescription>
              Used to identify anonymous speakers in transcription workflows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="endpoint-diarization-model">
                  Model or service identifier
                </FieldLabel>
                <Input
                  id="endpoint-diarization-model"
                  value={form.diarizationModel}
                  onChange={(event) =>
                    update("diarizationModel", event.target.value)
                  }
                  placeholder={
                    form.providerType === "pyannote"
                      ? "pyannote/speaker-diarization-3.1"
                      : "gpt-4o-transcribe-diarize"
                  }
                />
                <FieldDescription>
                  Pyannote services can leave this empty when the service
                  selects its own loaded pipeline.
                </FieldDescription>
              </Field>
              {supports(form.providerType, "chat") && (
                <CapabilitySwitch
                  label="Also use this endpoint for chat"
                  description="Save it in both the diarization and LLM inventory views."
                  checked={form.useForChat}
                  onCheckedChange={(checked) => update("useForChat", checked)}
                />
              )}
              {chatAvailable && (
                <ModelField
                  id="endpoint-diarization-chat-model"
                  label="Chat model (optional)"
                  value={form.chatModel}
                  onChange={(value) => update("chatModel", value)}
                  options={options}
                  description="Optional chat capability for a dual-purpose endpoint."
                  placeholder="e.g. gpt-4o-mini"
                />
              )}
            </FieldGroup>
          </CardContent>
        </Card>
      ) : (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare aria-hidden="true" /> Chat model
            </CardTitle>
            <CardDescription>
              This is the model JustAI uses for chat by default. You can enter
              it manually or choose from the provider catalog after
              verification.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ModelField
              id="endpoint-chat-model"
              label="Default chat model"
              value={form.chatModel}
              onChange={(value) => update("chatModel", value)}
              options={options}
              description={
                preflightModels.length > 0
                  ? `${preflightModels.length} models available from the latest check.`
                  : "Model discovery happens in the final verification step."
              }
              placeholder="e.g. gpt-4o-mini or gemma-3-27b-it"
            />
          </CardContent>
        </Card>
      )}

      {form.endpointKind === "llm" && hasOptionalModels && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Optional capabilities</CardTitle>
            <CardDescription>
              These stay off until you map a model or explicitly enable the
              capability.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {supports(form.providerType, "vision") && (
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
                  <CapabilitySwitch
                    label="Vision / image input"
                    description="Allow image messages for a vision-capable model."
                    checked={form.vision}
                    onCheckedChange={(checked) => update("vision", checked)}
                  />
                  <Field>
                    <FieldLabel htmlFor="endpoint-vision-model">
                      Vision model (optional)
                    </FieldLabel>
                    <Input
                      id="endpoint-vision-model"
                      list="endpoint-model-options"
                      value={form.visionModel}
                      onChange={(event) =>
                        update("visionModel", event.target.value)
                      }
                      placeholder="Reuse chat model"
                    />
                  </Field>
                </div>
              )}
              {supports(form.providerType, "embeddings") && (
                <Field>
                  <FieldLabel htmlFor="endpoint-embedding-model">
                    Embedding model
                  </FieldLabel>
                  <Input
                    id="endpoint-embedding-model"
                    value={form.embeddingModel}
                    onChange={(event) =>
                      update("embeddingModel", event.target.value)
                    }
                    placeholder="text-embedding-3-small"
                  />
                  <FieldDescription>
                    Needed when this endpoint should power knowledge search.
                  </FieldDescription>
                </Field>
              )}
              {supports(form.providerType, "image-generation") && (
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
                    Used by Image Studio for generation and editing.
                  </FieldDescription>
                </Field>
              )}
              {transcriptionAvailable && (
                <div className="grid gap-3 rounded-lg border p-3">
                  <Field>
                    <FieldLabel htmlFor="endpoint-transcription-model">
                      Transcription model
                    </FieldLabel>
                    <Input
                      id="endpoint-transcription-model"
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
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {supports(form.providerType, "realtime-transcription") && (
                      <CapabilitySwitch
                        label="Realtime transcription"
                        description="Native provider WebSocket."
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
                    )}
                    {supports(form.providerType, "chunked-transcription") && (
                      <CapabilitySwitch
                        label="Chunked HTTP transcription"
                        description="Rolling Whisper windows."
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
                    )}
                  </div>
                </div>
              )}
              {supports(form.providerType, "diarization") && (
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
                  <CapabilitySwitch
                    label="Speaker diarization"
                    description="Identify anonymous speakers alongside transcription."
                    checked={form.diarization}
                    onCheckedChange={(checked) =>
                      update("diarization", checked)
                    }
                  />
                  <Field>
                    <FieldLabel htmlFor="endpoint-llm-diarization-model">
                      Diarization model
                    </FieldLabel>
                    <Input
                      id="endpoint-llm-diarization-model"
                      value={form.diarizationModel}
                      onChange={(event) =>
                        update("diarizationModel", event.target.value)
                      }
                      placeholder="gpt-4o-transcribe-diarize"
                    />
                  </Field>
                </div>
              )}
              {supports(form.providerType, "tts") && (
                <Field>
                  <FieldLabel htmlFor="endpoint-speech-model">
                    Speech model
                  </FieldLabel>
                  <Input
                    id="endpoint-speech-model"
                    value={form.speechModel}
                    onChange={(event) =>
                      update("speechModel", event.target.value)
                    }
                    placeholder="gpt-4o-mini-tts"
                  />
                </Field>
              )}
              {supports(form.providerType, "tool-calling") && (
                <CapabilitySwitch
                  label="Tool calling"
                  description="Allow approved MCP actions for chat requests."
                  checked={form.toolCalling}
                  onCheckedChange={(checked) => update("toolCalling", checked)}
                />
              )}
            </FieldGroup>
          </CardContent>
        </Card>
      )}

      <Collapsible
        className="rounded-xl border"
        open={runtimeOpen}
        onOpenChange={onRuntimeOpenChange}
      >
        <CollapsibleTrigger
          render={
            <Button
              className="h-auto w-full justify-start rounded-xl px-4 py-3 text-left hover:bg-muted/50"
              size="sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
          <span>
            <span className="block font-medium">Runtime settings</span>
            <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
              Timeout, output limits, availability, and defaults
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t px-4 py-4">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="endpoint-timeout">
                  Timeout (seconds)
                </FieldLabel>
                <Input
                  id="endpoint-timeout"
                  type="number"
                  min={1}
                  step={1}
                  value={form.timeoutSeconds}
                  onChange={(event) =>
                    update("timeoutSeconds", Number(event.target.value))
                  }
                />
                {form.providerType === "pyannote" && (
                  <FieldDescription>
                    Maximum time JustAI waits for one full-video diarization.
                    The default is 30 minutes; increase it for long videos or
                    CPU-only deployments.
                  </FieldDescription>
                )}
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
                    update("maxOutputTokens", Number(event.target.value))
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
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <CapabilitySwitch
                label="Enabled"
                description="Allow this endpoint to be selected by routing."
                checked={form.enabled}
                onCheckedChange={(checked) => update("enabled", checked)}
              />
              <CapabilitySwitch
                label="Default chat endpoint"
                description={
                  form.endpointKind === "llm" || form.useForChat
                    ? "Use for new chat sessions."
                    : "Only chat-capable endpoints can be the default."
                }
                checked={form.isDefault}
                disabled={!chatAvailable}
                onCheckedChange={(checked) => update("isDefault", checked)}
              />
            </div>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ModelField({
  id,
  label,
  value,
  onChange,
  options,
  description,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: DiscoveredChatModel[]
  description: string
  placeholder: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        list={options.length > 0 ? "endpoint-model-options" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {options.length > 0 && (
        <datalist id="endpoint-model-options">
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name ?? model.id}
            </option>
          ))}
        </datalist>
      )}
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function ReviewStep({
  form,
  endpointKind,
  providerLabel,
  capabilities,
  preflightState,
  preflightMessage,
  modelCount,
  verificationOverride,
  verificationIsCurrent,
  notice,
  onCheck,
  onContinueWithoutVerification,
}: {
  form: EndpointForm
  endpointKind: EndpointKind
  providerLabel: string
  capabilities: Record<string, boolean>
  preflightState: PreflightState
  preflightMessage: string
  modelCount: number
  verificationOverride: boolean
  verificationIsCurrent: boolean
  notice?: string
  onCheck: () => void
  onContinueWithoutVerification: () => void
}) {
  const enabledCapabilities = Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([capability]) => capability)
  const modelLabel =
    endpointKind === "diarization"
      ? form.diarizationModel || "Service-selected pipeline"
      : form.chatModel || "Selected at request time"

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-medium">Verify and review</p>
        <p className="mt-1 text-xs text-muted-foreground">
          JustAI will run a safe provider check without saving the endpoint or
          its credential.
        </p>
      </div>

      {notice && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Endpoint could not be saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListChecks aria-hidden="true" /> Setup summary
          </CardTitle>
          <CardDescription>
            Confirm the values that will be saved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <SummaryItem
              label="Lane"
              value={endpointKind === "diarization" ? "Diarization" : "LLM"}
            />
            <SummaryItem label="Provider" value={providerLabel} />
            <SummaryItem label="Name" value={form.name || "Unnamed endpoint"} />
            <SummaryItem label="Model" value={modelLabel} />
            <SummaryItem label="Base URL" value={form.baseUrl} wide />
            <SummaryItem
              label="Visibility"
              value={scopeLabel(form.scopeType)}
            />
          </dl>
          <div className="mt-4 border-t pt-4">
            <p className="mb-2 text-xs font-medium">Enabled capabilities</p>
            <div className="flex flex-wrap gap-1.5">
              {enabledCapabilities.length > 0 ? (
                enabledCapabilities.map((capability) => (
                  <Badge key={capability} variant="secondary">
                    {capabilityLabel(capability)}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">
                  No optional capabilities selected.
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {preflightState === "passed" ? (
              <CheckCircle2 className="text-primary" aria-hidden="true" />
            ) : preflightState === "failed" ? (
              <CircleAlert className="text-destructive" aria-hidden="true" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}
            Connection check
          </CardTitle>
          <CardDescription>
            {modelCount > 0
              ? `${modelCount} model${modelCount === 1 ? "" : "s"} discovered from the provider.`
              : "Model discovery is attempted where the provider exposes a safe catalog."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {preflightState === "passed" && verificationIsCurrent && (
            <Alert>
              <CheckCircle2 aria-hidden="true" />
              <AlertTitle>Provider verified</AlertTitle>
              <AlertDescription>
                {preflightMessage || "Provider is reachable."}
              </AlertDescription>
            </Alert>
          )}
          {preflightState === "passed" && !verificationIsCurrent && (
            <Alert>
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Setup changed after verification</AlertTitle>
              <AlertDescription>
                Check the connection again to verify the updated provider or
                model settings.
              </AlertDescription>
            </Alert>
          )}
          {preflightState === "failed" && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Verification needs attention</AlertTitle>
              <AlertDescription>
                {preflightMessage || "The provider could not be reached."}
              </AlertDescription>
            </Alert>
          )}
          {preflightState === "checking" && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Spinner aria-hidden="true" /> Checking provider and looking for
              models…
            </div>
          )}
          {preflightState === "idle" && (
            <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              Check the connection to unlock saving. This does not persist a
              draft or expose the credential.
            </p>
          )}
          {preflightMessage &&
            preflightState !== "passed" &&
            preflightState !== "failed" && (
              <p className="text-xs text-destructive">{preflightMessage}</p>
            )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCheck}
              disabled={preflightState === "checking"}
            >
              <RefreshCw
                data-icon="inline-start"
                className={preflightState === "checking" ? "animate-spin" : ""}
                aria-hidden="true"
              />
              {preflightState === "checking"
                ? "Checking…"
                : preflightState === "passed"
                  ? "Check again"
                  : "Check connection"}
            </Button>
            {preflightState === "failed" &&
              (!verificationOverride || !verificationIsCurrent) && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onContinueWithoutVerification}
                >
                  Continue without verification
                </Button>
              )}
          </div>
          {verificationOverride && verificationIsCurrent && (
            <p className="text-xs text-muted-foreground">
              Verification was skipped by choice. Saving will use the connection
              exactly as entered.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryItem({
  label,
  value,
  wide = false,
}: {
  label: string
  value: string
  wide?: boolean
}) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1 truncate text-xs" title={value}>
        {value}
      </dd>
    </div>
  )
}

function scopeLabel(scopeType: string) {
  if (scopeType === "global") return "Platform catalog"
  if (scopeType === "organization") return "Workspace"
  return "Only me"
}
