"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import { useTranslations } from "@/components/locale-provider"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react"
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ImagePlus,
  KeyRound,
  MessageSquare,
  Mic2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react"

import { api } from "@/lib/api"
import { EndpointBadge } from "@/components/endpoint-badge"
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
import { Alert as PuAlert } from "@/components/panelui/alert"
import { ChoiceCards } from "@/components/panelui/choice-cards"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Sheet } from "@/components/panelui/sheet"
import { Button } from "@/components/panelui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/panelui/card"
import { Dialog } from "@/components/panelui/dialog"
import { Field } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { RadioGroup } from "@/components/panelui/radio-group"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"

type WizardStep = "type" | "connection" | "review"

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
  logoFile: File | null
  logoRemoved: boolean
  onLogoChange: (file: File | null) => void
  onLogoRemove: () => void
  onSelectProvider: (value: string | null) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void | Promise<void>
  onClose: () => void
}

const stepOrder: WizardStep[] = ["type", "connection", "review"]

function displayProvider(provider: SupportedProvider) {
  return provider.name ?? providerDetails[provider.id]?.label ?? provider.id
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
    endpointKind: form.endpointKind,
    providerType: form.providerType,
    scopeType: form.scopeType,
    scopeId: form.scopeId,
    baseUrl: form.baseUrl,
    apiPath: form.apiPath,
    apiVersion: form.apiVersion,
    chatModel: form.chatModel,
    visionModel: form.visionModel,
    embeddingModel: form.embeddingModel,
    imageModel: form.imageModel,
    transcriptionModel: form.transcriptionModel,
    diarizationModel: form.diarizationModel,
    speechModel: form.speechModel,
    realtimeTranscription: form.realtimeTranscription,
    chunkedTranscription: form.chunkedTranscription,
    diarization: form.diarization,
    useForChat: form.useForChat,
    toolCalling: form.toolCalling,
    vision: form.vision,
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
    <Frame.Row className={cn(disabled && "opacity-55")}>
      <Frame.Content>
        <Frame.Title
          as="p"
          className="overflow-visible! text-clip! whitespace-normal!"
        >
          {label}
        </Frame.Title>
        <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
          {description}
        </Frame.Description>
      </Frame.Content>
      <Frame.Actions>
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </Frame.Actions>
    </Frame.Row>
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
  logoFile,
  logoRemoved,
  onLogoChange,
  onLogoRemove,
  onSelectProvider,
  onSave,
  onClose,
}: Props) {
  const { t } = useTranslations()

  const [step, setStep] = useState<WizardStep>(
    editingEndpoint ? "review" : "type"
  )
  const formRef = useRef<HTMLFormElement>(null)
  const pendingAutoSave = useRef(false)
  const [preflightState, setPreflightState] = useState<PreflightState>("idle")
  const [preflightMessage, setPreflightMessage] = useState("")
  const [validationMessage, setValidationMessage] = useState("")
  const [preflightModels, setPreflightModels] = useState<DiscoveredChatModel[]>(
    []
  )
  const [verifiedSignature, setVerifiedSignature] = useState("")
  const [verificationOverride, setVerificationOverride] = useState(false)

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
  // Wait for the verified model and form state to commit before submitting.
  useEffect(() => {
    if (open && canSave && pendingAutoSave.current) {
      pendingAutoSave.current = false
      formRef.current?.requestSubmit()
    }
  }, [open, canSave, signature])

  const currentIndex = stepOrder.indexOf(step)
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
    setStep(nextStep)
  }

  function nextStep() {
    const next = stepOrder[stepOrder.indexOf(step) + 1]
    if (next) goTo(next)
  }

  function previousStep() {
    const previous = stepOrder[stepOrder.indexOf(step) - 1]
    if (previous) goTo(previous)
  }

  function validateConnectionStep() {
    if (!form.name.trim()) {
      setValidationMessage(
        "Give this endpoint a name so it is easy to find later."
      )
      return false
    }
    if (!form.baseUrl.trim()) {
      setValidationMessage("Add the provider base URL before continuing.")
      return false
    }
    return true
  }

  function validateConfigureStep() {
    if (form.endpointKind === "diarization" && !capabilities.diarization) {
      setValidationMessage(
        "Diarization needs a supported diarization capability."
      )
      return false
    }
    return true
  }

  function validateBehaviorStep() {
    if (!Number.isFinite(form.timeoutSeconds) || form.timeoutSeconds < 1) {
      setValidationMessage("Timeout must be at least 1 second.")
      return false
    }
    if (!Number.isFinite(form.maxOutputTokens) || form.maxOutputTokens < 1) {
      setValidationMessage("Max output tokens must be at least 1.")
      return false
    }
    if (
      !Number.isFinite(form.temperature) ||
      form.temperature < 0 ||
      form.temperature > 2
    ) {
      setValidationMessage("Temperature must be between 0 and 2.")
      return false
    }
    return true
  }

  function validateBeforeNext() {
    if (step === "connection" && !validateConnectionStep()) return false
    setValidationMessage("")
    return true
  }

  function validateBeforeSave() {
    if (!validateConnectionStep()) return false
    if (!validateConfigureStep()) return false
    if (!validateBehaviorStep()) return false
    setValidationMessage("")
    return true
  }

  async function checkConnection(): Promise<boolean> {
    if (!validateBeforeSave()) return false
    setPreflightState("checking")
    setPreflightMessage("")
    setValidationMessage("")
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
        return true
      } else {
        setPreflightState("failed")
        setVerifiedSignature(signature)
        setPreflightMessage(
          result.checks?.connection?.message ??
            t("The provider could not be verified.")
        )
        return false
      }
    } catch (caught) {
      setVerifiedSignature(signature)
      setPreflightState("failed")
      setPreflightMessage(
        caught instanceof Error
          ? caught.message
          : t("The provider could not be verified.")
      )
      return false
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!isEditing && step !== "review") {
      event.preventDefault()
      if (validateBeforeNext()) nextStep()
      return
    }
    if (saving || preflightState === "checking" || !validateBeforeSave()) {
      event.preventDefault()
      return
    }
    if (!canSave) {
      event.preventDefault()
      setPreflightMessage(
        preflightState === "failed"
          ? t(
              "Verification failed. Review the connection or explicitly continue without verification."
            )
          : t("Check the connection before saving this endpoint.")
      )
      return
    }
    void onSave(event)
  }

  /** Save: check the connection first when it has not been checked since the last change. */
  async function saveNow() {
    if (!validateBeforeSave()) return
    if (canSave) {
      formRef.current?.requestSubmit()
      return
    }
    pendingAutoSave.current = true
    if (!(await checkConnection())) pendingAutoSave.current = false
  }

  function saveWithoutVerification() {
    pendingAutoSave.current = true
    continueWithoutVerification()
  }

  function continueWithoutVerification() {
    setVerificationOverride(true)
    setVerifiedSignature(signature)
    setPreflightMessage(
      "You can save this endpoint without a successful preflight. JustAI will use the saved connection as configured."
    )
  }

  const connectionProps = {
    form,
    update,
    providers: availableProviders,
    selectedProvider,
    canManageOrganization,
    platformAdmin,
    isPlatformCatalog,
    isEditing,
    existingLogoUrl: logoRemoved ? undefined : editingEndpoint?.logoUrl,
    logoFile,
    onLogoChange,
    onLogoRemove,
    onSelectProvider,
  }
  const advancedSettings = (
    <Collapsible>
      <Frame variant="plain">
        <Frame.Header>
          <Frame.Title>{t("Advanced settings")}</Frame.Title>
          <Frame.Description>
            {t("Optional capabilities, API routing and runtime limits.")}
          </Frame.Description>
          <Frame.Action>
            <CollapsibleTrigger
              render={<Button variant="ghost" size="sm" />}
              className="group/advanced"
              aria-label={t("Advanced settings")}
            >
              <ChevronDown
                aria-hidden="true"
                className="size-4 transition-transform group-data-[panel-open]/advanced:rotate-180"
              />
            </CollapsibleTrigger>
          </Frame.Action>
        </Frame.Header>
      </Frame>
      <CollapsibleContent>
        <div className="flex flex-col gap-6 pt-5">
          <ConnectionStep part="advanced" {...connectionProps} />
          <ConfigureStep
            part="advanced"
            compact
            form={form}
            options={options}
            preflightModels={preflightModels}
            setForm={setForm}
            supports={supports}
            update={update}
          />
          <BehaviorStep compact form={form} update={update} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
  const verification = (
    <ReviewStep
      form={form}
      endpointKind={form.endpointKind}
      providerLabel={selectedProvider.label}
      isEditing={isEditing}
      preflightState={preflightState}
      preflightMessage={preflightMessage}
      validationMessage={validationMessage}
      modelCount={preflightModels.length}
      verificationOverride={verificationOverride}
      verificationIsCurrent={verificationIsCurrent}
      notice={notice}
      onCheck={() => void checkConnection()}
      onContinueWithoutVerification={continueWithoutVerification}
    />
  )
  const stepLabels: Record<WizardStep, string> = {
    type: t("Endpoint type"),
    connection: t("Connection"),
    review: t("Check & save"),
  }
  const stepDescriptions: Record<WizardStep, string> = {
    type: t("What do you want to connect?"),
    connection: t("Where is it, and who may use it?"),
    review: t("Check the connection, then save."),
  }

  const validationAlert = validationMessage &&
    (isEditing || step !== "review") && (
      <PuAlert tone="destructive" variant="plain">
        <PuAlert.Title>{t("Check this step")}</PuAlert.Title>
        <PuAlert.Description>{t(validationMessage)}</PuAlert.Description>
      </PuAlert>
    )

  if (isEditing) {
    const failed = preflightState === "failed" && verificationIsCurrent
    return (
      <Sheet open={open} onOpenChange={onOpenChange} side="right">
        <Sheet.Content className="w-[min(40rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header>
            <Sheet.Title>{t("Edit endpoint")}</Sheet.Title>
            <Sheet.Description>
              {form.name || editingEndpoint?.name} · {selectedProvider.label}
            </Sheet.Description>
          </Sheet.Header>
          <form
            className="contents"
            id="endpoint-edit-form"
            onSubmit={handleSubmit}
            ref={formRef}
          >
            <fieldset
              disabled={saving || preflightState === "checking"}
              className="contents"
            >
              <Sheet.Body className="flex flex-col gap-7">
                {validationAlert}
                <section className="flex flex-col gap-4">
                  <h3 className="text-sm font-semibold">{t("Connection")}</h3>
                  <ConnectionStep part="core" {...connectionProps} />
                </section>
                {
                  <section className="flex flex-col gap-4">
                    <h3 className="text-sm font-semibold">{t("Models")}</h3>
                    <ConfigureStep
                      compact
                      form={form}
                      options={options}
                      preflightModels={preflightModels}
                      setForm={setForm}
                      supports={supports}
                      update={update}
                    />
                  </section>
                }
                <AvailabilitySettings form={form} update={update} />
                {advancedSettings}
                {preflightState === "passed" && verificationIsCurrent ? (
                  <PuAlert tone="success" variant="plain">
                    <PuAlert.Description>
                      {t(preflightMessage || "Provider is reachable.")}
                    </PuAlert.Description>
                  </PuAlert>
                ) : failed ? (
                  <PuAlert tone="destructive" variant="plain">
                    <PuAlert.Title>
                      {t("The provider could not be verified.")}
                    </PuAlert.Title>
                    <PuAlert.Description>
                      {preflightMessage}
                    </PuAlert.Description>
                    <PuAlert.Actions>
                      <Button
                        onClick={saveWithoutVerification}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("Save anyway")}
                      </Button>
                    </PuAlert.Actions>
                  </PuAlert>
                ) : null}
                {notice && (
                  <ToastFeedback message={notice} type={"destructive"} />
                )}
              </Sheet.Body>
            </fieldset>
          </form>
          <Sheet.Footer className="sm:flex-row sm:items-center">
            <Button
              disabled={preflightState === "checking" || saving}
              onClick={() => void checkConnection()}
              className="sm:mr-auto"
              type="button"
              variant="outline"
            >
              {preflightState === "checking" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
              )}
              {t("Test connection")}
            </Button>
            <Button onClick={onClose} type="button" variant="secondary">
              {t("Cancel")}
            </Button>
            <Button
              disabled={saving || preflightState === "checking"}
              onClick={() => void saveNow()}
              type="button"
            >
              {saving ? t("Saving…") : t("Save changes")}
            </Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="sm:max-w-2xl">
        <Dialog.Header
          title={t("Add an endpoint")}
          description={stepDescriptions[step]}
        />
        <form
          className="contents"
          id="endpoint-creation-form"
          onSubmit={handleSubmit}
          ref={formRef}
        >
          <fieldset
            disabled={saving || preflightState === "checking"}
            className="contents"
          >
            <Dialog.Body>
              <div
                aria-label={t(
                  "Endpoint setup progress: step {value0} of {value1}",
                  { value0: currentIndex + 1, value1: stepOrder.length }
                )}
                className="flex items-center gap-3"
                role="group"
              >
                <div className="flex flex-1 gap-1.5">
                  {stepOrder.map((item, index) => (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1 flex-1 rounded-full bg-muted transition-colors",
                        index <= currentIndex && "bg-primary"
                      )}
                      key={item}
                    />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t("Step")} {currentIndex + 1} {t("of")} {stepOrder.length}
                  </span>
                  {" · "}
                  {stepLabels[step]}
                </span>
              </div>
              {validationAlert}
              {step === "type" ? (
                <TypeStep
                  endpointKind={form.endpointKind}
                  locked={isEditing}
                  onSelect={selectKind}
                />
              ) : step === "connection" ? (
                <ConnectionStep part="core" {...connectionProps} />
              ) : (
                <>
                  <ConfigureStep
                    compact
                    form={form}
                    options={options}
                    preflightModels={preflightModels}
                    setForm={setForm}
                    supports={supports}
                    update={update}
                  />
                  <AvailabilitySettings form={form} update={update} />
                  {verification}
                  {advancedSettings}
                </>
              )}
            </Dialog.Body>
          </fieldset>
        </form>
        <Dialog.Footer>
          <Button onClick={onClose} type="button" variant="secondary">
            {t("Cancel")}
          </Button>
          {currentIndex > 0 && (
            <Button
              disabled={saving || preflightState === "checking"}
              onClick={previousStep}
              type="button"
              variant="ghost"
            >
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              {t("Back")}
            </Button>
          )}
          {step !== "review" ? (
            <Button
              onClick={() => {
                if (validateBeforeNext()) nextStep()
              }}
              type="button"
            >
              {t("Continue")}
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          ) : (
            <Button
              disabled={saving || preflightState === "checking"}
              onClick={() => void saveNow()}
              type="button"
            >
              {saving ? t("Saving…") : t("Save endpoint")}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
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
  const { t } = useTranslations()

  return (
    <ChoiceCards
      aria-label={t("What are you connecting?")}
      aspect="16 / 5"
      columns={2}
      disabled={locked}
      onValueChange={(value) => onSelect(value as EndpointKind)}
      value={endpointKind}
    >
      <ChoiceCards.Item value="llm">
        <ChoiceCards.Media>
          <MessageSquare aria-hidden="true" className="size-8" />
        </ChoiceCards.Media>
        <ChoiceCards.Label>{t("Language model")}</ChoiceCards.Label>
        <ChoiceCards.Description>
          {t("Chat, vision, embeddings, images, transcription and speech.")}
        </ChoiceCards.Description>
      </ChoiceCards.Item>
      <ChoiceCards.Item value="diarization">
        <ChoiceCards.Media>
          <Mic2 aria-hidden="true" className="size-8" />
        </ChoiceCards.Media>
        <ChoiceCards.Label>{t("Speaker separation")}</ChoiceCards.Label>
        <ChoiceCards.Description>
          {t("Tells speakers apart in transcriptions.")}
        </ChoiceCards.Description>
      </ChoiceCards.Item>
    </ChoiceCards>
  )
}

function ConnectionStep({
  part,
  form,
  update,
  providers,
  selectedProvider,
  canManageOrganization,
  platformAdmin,
  isPlatformCatalog,
  isEditing,
  existingLogoUrl,
  logoFile,
  onLogoChange,
  onLogoRemove,
  onSelectProvider,
}: {
  part: "core" | "advanced"
  form: EndpointForm
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
  providers: SupportedProvider[]
  selectedProvider: (typeof providerDetails)[string]
  canManageOrganization: boolean
  platformAdmin: boolean
  isPlatformCatalog: boolean
  isEditing: boolean
  existingLogoUrl?: string
  logoFile: File | null
  onLogoChange: (file: File | null) => void
  onLogoRemove: () => void
  onSelectProvider: (value: string | null) => void
}) {
  const { t } = useTranslations()
  const logoInputRef = useRef<HTMLInputElement>(null)
  const [logoPreviews, setLogoPreviews] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!logoFile) return
    const key = `${logoFile.name}:${logoFile.size}:${logoFile.lastModified}`
    const reader = new FileReader()
    reader.onload = () =>
      setLogoPreviews((current) => ({
        ...current,
        [key]: String(reader.result),
      }))
    reader.readAsDataURL(logoFile)
    return () => reader.abort()
  }, [logoFile])
  const logoPreview = logoFile
    ? (logoPreviews[
        `${logoFile.name}:${logoFile.size}:${logoFile.lastModified}`
      ] ?? "")
    : ""
  const shownLogo = logoPreview || existingLogoUrl

  const logoField = (
    <Frame>
      <Frame.Header>
        <Frame.Title>{t("Logo")}</Frame.Title>
      </Frame.Header>
      <Frame.Panel>
        <Frame.Row>
          <EndpointBadge
            name={form.name || "?"}
            logoUrl={shownLogo}
            className="size-12 shrink-0"
          />
          <Frame.Content>
            <input
              ref={logoInputRef}
              id="endpoint-logo"
              aria-label={t("Logo")}
              type="file"
              className="sr-only"
              accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
              onChange={(event) => {
                onLogoChange(event.target.files?.[0] ?? null)
                event.target.value = ""
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Shown in the model picker. Without a logo, initials are used. PNG, JPEG, GIF, WebP, or ICO · Max 2 MB"
              )}
            </p>
            <div className="flex flex-wrap gap-2 pt-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => logoInputRef.current?.click()}
              >
                <ImagePlus data-icon="inline-start" aria-hidden="true" />
                {shownLogo ? t("Replace logo") : t("Choose logo")}
              </Button>
              {shownLogo && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onLogoRemove}
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  {t("Remove logo")}
                </Button>
              )}
            </div>
          </Frame.Content>
        </Frame.Row>
      </Frame.Panel>
    </Frame>
  )

  if (part === "advanced") {
    return (
      <div className="flex flex-col gap-5">
        <Frame>
          <Frame.Header>
            <Frame.Title>{t("API routing")}</Frame.Title>
            <Frame.Description>
              {t(
                "Optional overrides for custom gateways, proxy paths, and providers that require an API version."
              )}
            </Frame.Description>
          </Frame.Header>
          <Frame.Panel className="p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <Field.Label>{t("API path (optional)")}</Field.Label>
                <Input
                  id="endpoint-api-path"
                  value={form.apiPath}
                  onChange={(event) => update("apiPath", event.target.value)}
                  placeholder="/v1"
                />
                <Field.Description>
                  {t("Override the provider's default route.")}
                </Field.Description>
              </Field>
              <Field>
                <Field.Label>{t("API version (optional)")}</Field.Label>
                <Input
                  id="endpoint-api-version"
                  value={form.apiVersion}
                  onChange={(event) => update("apiVersion", event.target.value)}
                  placeholder="2024-06-20"
                />
                <Field.Description>
                  {t("Sent to providers that require a version header.")}
                </Field.Description>
              </Field>
            </div>
          </Frame.Panel>
        </Frame>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        {logoField}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <Field.Label>{t("Display name")}</Field.Label>
            <Input
              id="endpoint-name"
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder={
                form.endpointKind === "diarization"
                  ? t("Speaker service")
                  : t("Team GPT")
              }
              required
            />
          </Field>
          <Field>
            <Field.Label>{t("Provider")}</Field.Label>
            <Select value={form.providerType} onValueChange={onSelectProvider}>
              <SelectTrigger id="endpoint-provider" className="w-full">
                <SelectValue>
                  {displayProvider(
                    providers.find(
                      (provider) => provider.id === form.providerType
                    ) ?? { id: form.providerType, capabilities: [] }
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {displayProvider(provider)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Field.Description>
              {t(selectedProvider.description)}
              {providers.find((provider) => provider.id === form.providerType)
                ?.examples?.length
                ? t(" Examples: {value0}.", {
                    value0: providers
                      .find((provider) => provider.id === form.providerType)
                      ?.examples?.join(", "),
                  })
                : ""}
            </Field.Description>
          </Field>
        </div>
        <Field>
          <Field.Label>{t("Base URL")}</Field.Label>
          <Input
            id="endpoint-url"
            value={form.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
            placeholder={selectedProvider.baseUrl}
            required
          />
          <Field.Description>
            {selectedProvider.baseUrl}{" "}
            {t(
              "is the suggested default; local services and gateways can use their own URL."
            )}
          </Field.Description>
        </Field>
        <Field>
          <Field.Label>{t("API key or token")}</Field.Label>
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
              placeholder={t("Stored encrypted by JustAI")}
              autoComplete="off"
            />
          </div>
          <Field.Description>
            {t(
              "Leave empty for local runtimes. When editing, an empty field keeps the stored credential."
            )}
          </Field.Description>
        </Field>
        <Field>
          <Field.Label>{t("Visibility")}</Field.Label>
          {isEditing || isPlatformCatalog ? (
            <p className="text-sm">
              {form.scopeType === "organization"
                ? t("Workspace")
                : form.scopeType === "user"
                  ? t("Only me")
                  : t("Global (platform admin)")}
            </p>
          ) : (
            <RadioGroup
              aria-label={t("Visibility")}
              className="sm:grid sm:grid-cols-2"
              value={form.scopeType}
              onValueChange={(value) => update("scopeType", value)}
            >
              <RadioGroup.Card
                value="user"
                appearance="filled"
                aria-label={t("Only me")}
              >
                <RadioGroup.CardBody>
                  <RadioGroup.CardTitle>{t("Only me")}</RadioGroup.CardTitle>
                </RadioGroup.CardBody>
              </RadioGroup.Card>
              {canManageOrganization && (
                <RadioGroup.Card
                  value="organization"
                  appearance="filled"
                  aria-label={t("Workspace")}
                >
                  <RadioGroup.CardBody>
                    <RadioGroup.CardTitle>
                      {t("Workspace")}
                    </RadioGroup.CardTitle>
                  </RadioGroup.CardBody>
                </RadioGroup.Card>
              )}
            </RadioGroup>
          )}
          <Field.Description>
            {t(
              "Choose who can use this endpoint. Its scope cannot be changed after creation."
            )}
          </Field.Description>
        </Field>
        {platformAdmin && isPlatformCatalog && form.scopeType !== "global" && (
          <Field>
            <Field.Label>{t("Scope ID")}</Field.Label>
            <Input
              id="endpoint-scope-id"
              value={form.scopeId}
              onChange={(event) => update("scopeId", event.target.value)}
              placeholder={t("Organization or user UUID")}
              required
              readOnly={isEditing}
            />
            <Field.Description>
              {isEditing
                ? t("An endpoint's scope is fixed after creation.")
                : t(
                    "Platform administrators can assign this endpoint to a specific organization or user."
                  )}
            </Field.Description>
          </Field>
        )}
      </div>
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
  compact = false,
  part = "primary",
}: {
  compact?: boolean
  part?: "primary" | "advanced"
  form: EndpointForm
  setForm: Dispatch<SetStateAction<EndpointForm>>
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
  supports: (provider: string, capability: string) => boolean
  preflightModels: DiscoveredChatModel[]
  options: DiscoveredChatModel[]
}) {
  const { t } = useTranslations()

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
      {!compact && (
        <div>
          <p className="text-sm font-medium">
            {form.endpointKind === "diarization"
              ? t("Configure the diarization service")
              : t("Configure models and capabilities")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {form.endpointKind === "diarization"
              ? t(
                  "Choose the speaker-labeling model and decide whether this same endpoint should also handle chat."
                )
              : t(
                  "Chat is the primary LLM capability. Add optional model mappings only when this provider will serve those jobs."
                )}
          </p>
        </div>
      )}

      {part === "primary" &&
        (form.endpointKind === "diarization" ? (
          <Frame>
            <Frame.Header>
              <Frame.Title>{t("Diarization model")}</Frame.Title>
              <Frame.Description>
                {t(
                  "Used to identify anonymous speakers in transcription workflows."
                )}
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="p-4">
              <div className="flex flex-col gap-4">
                <Field>
                  <Field.Label>{t("Model or service identifier")}</Field.Label>
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
                  <Field.Description>
                    {t(
                      "Pyannote services can leave this empty when the service selects its own loaded pipeline."
                    )}
                  </Field.Description>
                </Field>
                {supports(form.providerType, "chat") && (
                  <CapabilitySwitch
                    label={t("Also use this endpoint for chat")}
                    description={t(
                      "Save it in both the diarization and LLM inventory views."
                    )}
                    checked={form.useForChat}
                    onCheckedChange={(checked) =>
                      setForm((current) => ({
                        ...current,
                        useForChat: checked,
                        isDefault: checked ? current.isDefault : false,
                      }))
                    }
                  />
                )}
                {chatAvailable && (
                  <ModelField
                    id="endpoint-diarization-chat-model"
                    label={t("Chat model (optional)")}
                    value={form.chatModel}
                    onChange={(value) => update("chatModel", value)}
                    options={options}
                    description={t(
                      "Optional chat capability for a dual-purpose endpoint."
                    )}
                    placeholder="e.g. gpt-4o-mini"
                  />
                )}
              </div>
            </Frame.Panel>
          </Frame>
        ) : (
          <Frame>
            <Frame.Header>
              <Frame.Title>{t("Chat model")}</Frame.Title>
              <Frame.Description>
                {t(
                  "This is the model JustAI uses for chat by default. You can enter it manually or choose from the provider catalog after verification."
                )}
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="p-4">
              <ModelField
                id="endpoint-chat-model"
                label={t("Default chat model")}
                value={form.chatModel}
                onChange={(value) => update("chatModel", value)}
                options={options}
                description={
                  preflightModels.length > 0
                    ? t("{value0} models available from the latest check.", {
                        value0: preflightModels.length,
                      })
                    : t(
                        "Model discovery happens in the final verification step."
                      )
                }
                placeholder="e.g. gpt-4o-mini or gemma-3-27b-it"
              />
            </Frame.Panel>
          </Frame>
        ))}

      {part === "advanced" &&
        form.endpointKind === "llm" &&
        hasOptionalModels && (
          <Frame>
            <Frame.Header>
              <Frame.Title>{t("Optional capabilities")}</Frame.Title>
              <Frame.Description>
                {t(
                  "These stay off until you map a model or explicitly enable the capability."
                )}
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel className="p-4">
              <div className="flex flex-col gap-4">
                {supports(form.providerType, "vision") && (
                  <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                    <CapabilitySwitch
                      label={t("Vision / image input")}
                      description={t(
                        "Allow image messages for a vision-capable model."
                      )}
                      checked={form.vision}
                      onCheckedChange={(checked) => update("vision", checked)}
                    />
                    <Field>
                      <Field.Label>{t("Vision model (optional)")}</Field.Label>
                      <Input
                        id="endpoint-vision-model"

                        value={form.visionModel}
                        onChange={(event) =>
                          update("visionModel", event.target.value)
                        }
                        placeholder={t("Reuse chat model")}
                      />
                    </Field>
                  </div>
                )}
                {supports(form.providerType, "embeddings") && (
                  <Field>
                    <Field.Label>{t("Embedding model")}</Field.Label>
                    <Input
                      id="endpoint-embedding-model"
                      value={form.embeddingModel}
                      onChange={(event) =>
                        update("embeddingModel", event.target.value)
                      }
                      placeholder="text-embedding-3-small"
                    />
                    <Field.Description>
                      {t(
                        "Needed when this endpoint should power knowledge search."
                      )}
                    </Field.Description>
                  </Field>
                )}
                {supports(form.providerType, "image-generation") && (
                  <Field>
                    <Field.Label>{t("Image generation model")}</Field.Label>
                    <Input
                      id="endpoint-image-model"
                      value={form.imageModel}
                      onChange={(event) =>
                        update("imageModel", event.target.value)
                      }
                      placeholder="gpt-image-1"
                    />
                    <Field.Description>
                      {t("Used by Image Studio for generation and editing.")}
                    </Field.Description>
                  </Field>
                )}
                {transcriptionAvailable && (
                  <div className="grid gap-4">
                    <Field>
                      <Field.Label>{t("Transcription model")}</Field.Label>
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
                      {supports(
                        form.providerType,
                        "realtime-transcription"
                      ) && (
                        <CapabilitySwitch
                          label={t("Realtime transcription")}
                          description={t("Native provider WebSocket.")}
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
                          label={t("Chunked HTTP transcription")}
                          description={t("Rolling Whisper windows.")}
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
                  <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                    <CapabilitySwitch
                      label={t("Speaker diarization")}
                      description={t(
                        "Identify anonymous speakers alongside transcription."
                      )}
                      checked={form.diarization}
                      onCheckedChange={(checked) =>
                        update("diarization", checked)
                      }
                    />
                    <Field>
                      <Field.Label>{t("Diarization model")}</Field.Label>
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
                    <Field.Label>{t("Speech model")}</Field.Label>
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
                    label={t("Tool calling")}
                    description={t(
                      "Allow approved MCP actions for chat requests."
                    )}
                    checked={form.toolCalling}
                    onCheckedChange={(checked) =>
                      update("toolCalling", checked)
                    }
                  />
                )}
              </div>
            </Frame.Panel>
          </Frame>
        )}
      {part === "advanced" &&
        form.endpointKind === "llm" &&
        !hasOptionalModels && (
          <PuAlert variant="plain">
            <PuAlert.Icon>
              <Sparkles />
            </PuAlert.Icon>
            <PuAlert.Title>
              {t("No optional capabilities available")}
            </PuAlert.Title>
            <PuAlert.Description>
              {t(
                "This provider exposes chat only. You can still verify and save the endpoint with its primary chat model."
              )}
            </PuAlert.Description>
          </PuAlert>
        )}
    </div>
  )
}

function BehaviorStep({
  form,
  update,
  compact = false,
}: {
  compact?: boolean
  form: EndpointForm
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
}) {
  const { t } = useTranslations()

  const chatAvailable = form.endpointKind === "llm" || form.useForChat

  return (
    <div className="flex flex-col gap-5">
      {!compact && (
        <div>
          <p className="text-sm font-medium">{t("Set runtime behavior")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              "Decide how long JustAI should wait, how chat requests behave, and whether this endpoint participates in routing."
            )}
          </p>
        </div>
      )}

      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Runtime limits")}</Frame.Title>
          <Frame.Description>
            {t(
              "These values apply whenever JustAI routes a request to this endpoint."
            )}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel className="p-4">
          <div className="flex flex-col gap-4">
            <div
              className={cn("grid gap-4", chatAvailable && "sm:grid-cols-3")}
            >
              <Field>
                <Field.Label>{t("Timeout (seconds)")}</Field.Label>
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
                <Field.Description>
                  {form.providerType === "pyannote"
                    ? t(
                        "Maximum wait for one full-video diarization. 1,800 seconds is the default."
                      )
                    : t("Maximum wait for a single provider request.")}
                </Field.Description>
              </Field>
              {chatAvailable && (
                <>
                  <Field>
                    <Field.Label>{t("Max output tokens")}</Field.Label>
                    <Input
                      id="endpoint-max-tokens"
                      type="number"
                      min={1}
                      step={1}
                      value={form.maxOutputTokens}
                      onChange={(event) =>
                        update("maxOutputTokens", Number(event.target.value))
                      }
                    />
                    <Field.Description>
                      {t("Upper limit for generated chat output.")}
                    </Field.Description>
                  </Field>
                  <Field>
                    <Field.Label>{t("Temperature")}</Field.Label>
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
                    <Field.Description>
                      {t("Lower values make chat responses more predictable.")}
                    </Field.Description>
                  </Field>
                </>
              )}
            </div>
          </div>
        </Frame.Panel>
      </Frame>
    </div>
  )
}

function AvailabilitySettings({
  form,
  update,
}: {
  form: EndpointForm
  update: <K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) => void
}) {
  const { t } = useTranslations()
  const chatAvailable = form.endpointKind === "llm" || form.useForChat
  return (
    <Frame>
      <Frame.Header>
        <Frame.Title>{t("Availability and defaults")}</Frame.Title>
        <Frame.Description>
          {t(
            "Choose whether this endpoint is available and used by default for new chats."
          )}
        </Frame.Description>
      </Frame.Header>
      <Frame.Panel>
        <CapabilitySwitch
          label={t("Enabled")}
          description={t("Allow this endpoint to be selected by routing.")}
          checked={form.enabled}
          onCheckedChange={(checked) => {
            update("enabled", checked)
            if (!checked) update("isDefault", false)
          }}
        />
        {chatAvailable && (
          <CapabilitySwitch
            label={t("Default chat endpoint")}
            description={
              !form.enabled
                ? t("Enable this endpoint before making it the default.")
                : chatAvailable
                  ? t("Use for new chat sessions.")
                  : t(
                      "Enable chat in the previous step before making this the default."
                    )
            }
            checked={form.isDefault}
            disabled={!chatAvailable || !form.enabled}
            onCheckedChange={(checked) => update("isDefault", checked)}
          />
        )}
      </Frame.Panel>
    </Frame>
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
  const { t } = useTranslations()
  return (
    <Field>
      <Field.Label>{label}</Field.Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          className="min-w-0 flex-1"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        {options.length > 0 && (
          <Select
            value={options.some((model) => model.id === value) ? value : null}
            onValueChange={(next) => {
              if (next) onChange(next)
            }}
          >
            <SelectTrigger aria-label={t("Choose discovered model")}>
              <SelectValue>{t("Browse models")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name ?? model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <Field.Description>{description}</Field.Description>
    </Field>
  )
}

function ReviewStep({
  form,
  endpointKind,
  providerLabel,
  isEditing,
  preflightState,
  preflightMessage,
  validationMessage,
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
  isEditing: boolean
  preflightState: PreflightState
  preflightMessage: string
  validationMessage: string
  modelCount: number
  verificationOverride: boolean
  verificationIsCurrent: boolean
  notice?: string
  onCheck: () => void
  onContinueWithoutVerification: () => void
}) {
  const { t } = useTranslations()

  const modelLabel =
    endpointKind === "diarization"
      ? form.diarizationModel || "Service-selected pipeline"
      : form.chatModel || "Selected at request time"
  const credentialLabel = form.credential.trim()
    ? isEditing
      ? t("Replace stored credential")
      : t("New credential entered")
    : isEditing
      ? t("Keep stored credential")
      : t("No credential (local or no auth)")

  return (
    <div className="flex flex-col gap-5">
      {notice && <ToastFeedback message={notice} type={"destructive"} />}

      {validationMessage && (
        <PuAlert tone="destructive" variant="plain">
          <PuAlert.Icon>
            <CircleAlert />
          </PuAlert.Icon>
          <PuAlert.Title>{t("Setup needs attention")}</PuAlert.Title>
          <PuAlert.Description>{t(validationMessage)}</PuAlert.Description>
        </PuAlert>
      )}

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("Setup summary")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <SummaryItem label={t("Name")} value={form.name} />
            <SummaryItem label={t("Provider")} value={providerLabel} />
            <SummaryItem
              label={t("Visibility")}
              value={t(scopeLabel(form.scopeType))}
            />
            <SummaryItem label={t("Primary model")} value={t(modelLabel)} />
            <SummaryItem label={t("Base URL")} value={form.baseUrl} wide />
            <SummaryItem label={t("Credential")} value={credentialLabel} />
          </dl>
        </CardContent>
      </Card>

      <Frame variant="plain">
        <Frame.Header>
          <Frame.Title>{t("Connection check")}</Frame.Title>
          <Frame.Description>
            {modelCount > 0
              ? t("{count} models discovered from the provider.", {
                  count: modelCount,
                })
              : t(
                  "Saving checks the connection first. You can also test it here."
                )}
          </Frame.Description>
          <Frame.Action>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onCheck}
              disabled={preflightState === "checking"}
            >
              {preflightState === "checking" && <Spinner className="size-4" />}
              {t(
                preflightState === "checking"
                  ? "Checking…"
                  : preflightState === "passed"
                    ? "Check again"
                    : "Check connection"
              )}
            </Button>
          </Frame.Action>
        </Frame.Header>
        <div className="flex flex-col gap-3">
          {preflightState === "passed" && verificationIsCurrent && (
            <PuAlert tone="success" variant="plain">
              <PuAlert.Icon>
                <CheckCircle2 />
              </PuAlert.Icon>
              <PuAlert.Title>{t("Provider verified")}</PuAlert.Title>
              <PuAlert.Description>
                {t(preflightMessage || "Provider is reachable.")}
              </PuAlert.Description>
            </PuAlert>
          )}
          {preflightState === "passed" && !verificationIsCurrent && (
            <PuAlert variant="plain">
              <PuAlert.Icon>
                <CircleAlert />
              </PuAlert.Icon>
              <PuAlert.Title>
                {t("Setup changed after verification")}
              </PuAlert.Title>
              <PuAlert.Description>
                {t(
                  "Check the connection again to verify the updated provider or model settings."
                )}
              </PuAlert.Description>
            </PuAlert>
          )}
          {preflightState === "failed" && (
            <PuAlert
              tone={
                verificationOverride && verificationIsCurrent
                  ? "warning"
                  : "destructive"
              }
              variant="plain"
            >
              <PuAlert.Icon>
                <CircleAlert />
              </PuAlert.Icon>
              <PuAlert.Title>
                {t(
                  verificationOverride && verificationIsCurrent
                    ? "Verification skipped"
                    : "Verification needs attention"
                )}
              </PuAlert.Title>
              <PuAlert.Description>
                {t(preflightMessage || "The provider could not be reached.")}
              </PuAlert.Description>
            </PuAlert>
          )}
          {preflightState === "checking" && (
            <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Spinner aria-hidden="true" />{" "}
              {t("Checking provider and looking for models…")}
            </div>
          )}
          {preflightMessage &&
            preflightState !== "passed" &&
            preflightState !== "failed" && (
              <p className="text-xs text-destructive">{preflightMessage}</p>
            )}
          <div className="flex flex-wrap gap-2">
            {preflightState === "failed" &&
              (!verificationOverride || !verificationIsCurrent) && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onContinueWithoutVerification}
                >
                  {t("Continue without verification")}
                </Button>
              )}
          </div>
          {verificationOverride && verificationIsCurrent && (
            <p className="text-xs text-muted-foreground">
              {t(
                "Verification was skipped by choice. Saving will use the connection exactly as entered."
              )}
            </p>
          )}
        </div>
      </Frame>
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
