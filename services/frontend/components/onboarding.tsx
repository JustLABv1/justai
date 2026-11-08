"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { api, APIError } from "@/lib/api"
import type {
  AdminOIDCProvider,
  Endpoint,
  Organization,
  User,
} from "@/lib/types"
import { BrandMark } from "@/components/brand-mark"
import { EndpointsView } from "@/components/endpoints-view"
import { PlatformAuthenticationView } from "@/components/platform-authentication-view"
import { Alert } from "@/components/panelui/alert"
import { Steps } from "@/components/panelui/steps"
import { Frame } from "@/components/panelui/frame"
import { Button } from "@/components/panelui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/panelui/card"
import { Field, FieldLabel, FieldDescription } from "@/components/panelui/field"
import { Input } from "@/components/panelui/input"
import { Spinner } from "@/components/panelui/spinner"

type OnboardingState = {
  installation: boolean
  step: string
  completed: boolean
}
const installationStepsMessages = [
  { id: "welcome", title: "Welcome" },
  { id: "workspace", title: "Workspace" },
  { id: "authentication", title: "Sign-in" },
  { id: "endpoints", title: "AI models" },
  { id: "ready", title: "Review" },
]
const userStepsMessages = [
  { id: "welcome", title: "Welcome" },
  { id: "workspace", title: "Your workspace" },
  { id: "ready", title: "Get started" },
]

export function Onboarding() {
  const installationSteps = useTranslatedConfig(installationStepsMessages)
  const userSteps = useTranslatedConfig(userStepsMessages)

  const { t } = useTranslations()

  const router = useRouter()
  const [state, setState] = useState<OnboardingState | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [name, setName] = useState("")
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [providers, setProviders] = useState<AdminOIDCProvider[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const me = await api.get<{ user: User; organizations: Organization[] }>(
          "/api/v1/auth/me"
        )
        const progress = await api.get<OnboardingState>("/api/v1/onboarding")
        if (cancelled) return
        if (progress.completed) {
          router.replace("/")
          return
        }
        const workspace =
          me.organizations.find(
            (item) => item.id === api.getOrganizationId()
          ) ??
          me.organizations[0] ??
          null
        api.setOrganizationId(workspace?.id ?? null)
        const catalog = await api
          .get<{ endpoints: Endpoint[] }>(
            progress.installation
              ? "/api/v1/admin/endpoints?scope=global"
              : "/api/v1/endpoints"
          )
          .catch((caught: unknown) => {
            // Members can still finish their introduction when AI is disabled or
            // they have not been assigned a workspace yet.
            if (
              !progress.installation &&
              caught instanceof APIError &&
              [403, 503].includes(caught.status)
            )
              return { endpoints: [] }
            throw caught
          })
        const oidc = progress.installation
          ? await api.get<{ providers: AdminOIDCProvider[] }>(
              "/api/v1/admin/oidc/providers"
            )
          : { providers: [] }
        if (cancelled) return
        setUser(me.user)
        setOrganization(workspace)
        setName(
          progress.installation ? (workspace?.name ?? "") : me.user.displayName
        )
        setEndpoints(catalog.endpoints)
        setProviders(oidc.providers)
        setState(progress)
        setError("")
      } catch (caught) {
        if (cancelled) return
        if (caught instanceof APIError && caught.status === 401) {
          router.replace("/login?next=%2Fsetup")
          return
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "Setup could not be loaded."
        )
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reload, router])

  const steps = state?.installation ? installationSteps : userSteps
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === state?.step)
  )
  const current = steps[index]
  const hasChat = endpoints.some(
    (endpoint) =>
      endpoint.enabled && endpoint.capabilities.chat && endpoint.chatModel
  )

  async function navigate(next: number, complete = false) {
    if (!state || busy) return
    setBusy(true)
    setError("")
    try {
      if (next > index && current.id === "workspace") {
        if (!name.trim())
          throw new Error(
            state.installation
              ? t("Enter a workspace name.")
              : t("Enter your display name.")
          )
        if (state.installation && organization) {
          await api.patch(`/api/v1/organizations/${organization.id}`, {
            name: name.trim(),
          })
          setOrganization({ ...organization, name: name.trim() })
        } else if (!state.installation) {
          await api.patch("/api/v1/profile", { displayName: name.trim() })
        }
      }
      if (next > index && state.installation) {
        const [catalog, oidc] = await Promise.all([
          api.get<{ endpoints: Endpoint[] }>(
            "/api/v1/admin/endpoints?scope=global"
          ),
          api.get<{ providers: AdminOIDCProvider[] }>(
            "/api/v1/admin/oidc/providers"
          ),
        ])
        setEndpoints(catalog.endpoints)
        setProviders(oidc.providers)
      }
      const step = steps[next].id
      await api.put("/api/v1/onboarding", { step, complete })
      if (complete) {
        router.replace("/")
        return
      }
      setState({ ...state, step })
      requestAnimationFrame(() => headingRef.current?.focus())
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your progress could not be saved."
      )
    } finally {
      setBusy(false)
    }
  }

  if (!state || !user)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        {error ? (
          <Alert tone="destructive" variant="plain" className="max-w-lg">
            <Alert.Title>{t("Setup unavailable")}</Alert.Title>
            <Alert.Description>
              {t(error)}
              <Button
                onClick={() => setReload((value) => value + 1)}
                variant="secondary"
              >
                {t("Try again")}
              </Button>
            </Alert.Description>
          </Alert>
        ) : (
          <Spinner label={t("Loading setup")} />
        )}
      </main>
    )

  return (
    <main className="flex min-h-0 w-full flex-1 overflow-y-auto bg-background p-4 sm:p-8">
      <div className="m-auto grid w-full max-w-6xl overflow-hidden rounded-3xl border border-border bg-card shadow-xl shadow-black/5 md:min-h-[42rem] md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-7 bg-muted/50 p-6 md:p-7">
          <div
            className="flex justify-center md:justify-start"
            role="img"
            aria-label="JustAI"
          >
            <BrandMark cropped className="size-12" />
          </div>
          <div className="hidden flex-col gap-2 md:flex">
            <h2 className="text-lg font-semibold tracking-tight">
              {state.installation
                ? t("Let’s make it yours.")
                : t("Make yourself at home.")}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {state.installation
                ? t("Your workspace, your team, your AI.")
                : t("A quick introduction to your workspace.")}
            </p>
          </div>
          <Steps
            orientation="vertical"
            value={index}
            onValueChange={(next) => {
              if (next < index) void navigate(next)
            }}
            aria-label={t("Setup steps")}
            className="hidden md:flex"
          >
            {steps.map((step, position) => (
              <Steps.Item
                key={step.id}
                step={position}
                disabled={busy}
                loading={busy && position === index}
              >
                <Steps.Trigger className="w-full">
                  <Steps.Indicator />
                  <Steps.Title>{step.title}</Steps.Title>
                  <Steps.Description className="text-xs">
                    {t(
                      step.id === "welcome"
                        ? "What we’ll set up"
                        : step.id === "workspace"
                          ? state.installation
                            ? "Name and identity"
                            : "Your profile and access"
                          : step.id === "authentication"
                            ? "OIDC · optional"
                            : step.id === "endpoints"
                              ? "Provider and model"
                              : "Check and launch"
                    )}
                  </Steps.Description>
                </Steps.Trigger>
              </Steps.Item>
            ))}
          </Steps>
          <div className="mt-auto hidden flex-col gap-2 pt-5 md:flex">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5" /> {t("Progress saved automatically")}
            </p>
            <p
              className="truncate text-xs text-muted-foreground"
              title={user.email}
            >
              {user.email}
            </p>
          </div>
        </aside>
        <section className="flex min-w-0 flex-col gap-6 p-6 sm:p-9 lg:p-12">
          <div className="min-w-0 flex-1">
            <div className="mb-6 flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                {t("Step")} {index + 1} {t("of")} {steps.length}
              </p>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
              >
                {current.id === "welcome"
                  ? state.installation
                    ? t("Your workspace starts here.")
                    : t("Welcome, {value0}.", { value0: user.displayName })
                  : current.id === "workspace"
                    ? state.installation
                      ? t("Make this workspace yours")
                      : t("A space for your work")
                    : current.id === "authentication"
                      ? t("Choose how your team signs in")
                      : current.id === "endpoints"
                        ? t("Connect your first AI model")
                        : t("Ready for your first conversation")}
              </h1>
            </div>
            <SetupStep current={index} step={0}>
              <div className="flex flex-col gap-6">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {state.installation
                    ? t(
                        "Connect the essentials and you’re ready to go. We’ll guide you through each step; optional settings can wait until later."
                      )
                    : t(
                        "Get to know your workspace and make sure you’re ready to start. Your administrator manages sign-in and shared AI models."
                      )}
                </p>
                <Frame>
                  <Frame.Panel>
                    {(state.installation
                      ? [
                          {
                            icon: MessageSquare,
                            title: t("Create a home for your team"),
                            text: "Name your workspace. Invite people and organize shared resources whenever you’re ready.",
                          },
                          {
                            icon: ShieldCheck,
                            title: t("Choose how people sign in"),
                            text: "Use existing accounts or connect your company’s identity provider with OIDC. You can do this later.",
                          },
                          {
                            icon: Sparkles,
                            title: t("Bring your preferred AI"),
                            text: "Connect a hosted provider or your own model server, choose a model and test the connection.",
                          },
                        ]
                      : [
                          {
                            icon: MessageSquare,
                            title: t("Meet your workspace"),
                            text: "See where you’re working, check your access and choose the name others will see.",
                          },
                          {
                            icon: Sparkles,
                            title: t("Start your first conversation"),
                            text: "Find the models your administrator has made available and learn where your chat history lives.",
                          },
                        ]
                    ).map(({ icon: Icon, title, text }) => (
                      <Frame.Row key={title} className="items-start gap-3 py-4">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-primary">
                          <Icon className="size-4" />
                        </span>
                        <div className="flex flex-col gap-1">
                          <h3 className="text-sm font-medium">{title}</h3>
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {t(text)}
                          </p>
                        </div>
                      </Frame.Row>
                    ))}
                  </Frame.Panel>
                </Frame>
                {state.installation && (
                  <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>
                      {t(
                        "Your administrator account is ready. You can change these settings later in Platform admin."
                      )}
                    </span>
                  </p>
                )}
              </div>
            </SetupStep>
            <SetupStep current={index} step={1}>
              <Card>
                <CardHeader>
                  <CardTitle>
                    {organization?.name ?? t("Your account")}
                  </CardTitle>
                  <CardDescription>
                    {state.installation
                      ? t(
                          "This is the shared space created with your administrator account. You can invite your team later in workspace settings."
                        )
                      : t("You’re signed in as {value0}{value1}.", {
                          value0: user.email,
                          value1: organization
                            ? t(" and have {role} access to this workspace", {
                                role: t(
                                  organization.role === "owner"
                                    ? "Owner"
                                    : organization.role === "admin"
                                      ? "Admin"
                                      : "Member"
                                ),
                              })
                            : "",
                        })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <Field>
                      <FieldLabel>
                        {state.installation
                          ? t("Workspace name")
                          : t("Display name")}
                      </FieldLabel>
                      <Input
                        id="onboarding-name"
                        size="lg"
                        disabled={busy}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={80}
                        autoComplete={
                          state.installation ? "organization" : "name"
                        }
                      />
                      <FieldDescription>
                        {state.installation
                          ? t("Choose a name your team will recognize.")
                          : t(
                              "This is how your name appears to others. You can change it in your profile."
                            )}
                      </FieldDescription>
                    </Field>
                  </div>
                </CardContent>
              </Card>
            </SetupStep>
            {state.installation && (
              <SetupStep current={index} step={2}>
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "Local sign-in is already available. Optionally connect your company’s identity provider using OIDC. Add its issuer URL and client credentials, then run the discovery test."
                    )}
                  </p>
                  <PlatformAuthenticationView showCreateAction />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "You can continue with local sign-in and configure SSO later in Platform admin → Authentication."
                    )}
                  </p>
                </div>
              </SetupStep>
            )}
            {state.installation && (
              <SetupStep current={index} step={3}>
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "Connect a hosted provider or your own model server. Choose an LLM endpoint, select a chat model and test the connection. Global endpoints are shared across the installation."
                    )}
                  </p>
                  <EndpointsView
                    endpoints={endpoints}
                    onChange={setEndpoints}
                    userId={user.id}
                    platformAdmin
                    apiBasePath="/api/v1/admin/endpoints"
                    defaultScopeType="global"
                    showCreateAction
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Prefer to configure AI later? Continue to review; chat becomes available once a model is connected."
                    )}
                  </p>
                </div>
              </SetupStep>
            )}
            <SetupStep current={index} step={steps.length - 1}>
              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {organization?.name ?? t("Your workspace")}
                    </CardTitle>
                    <CardDescription>
                      {t("Your setup at a glance")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4 text-sm">
                    <p>
                      <span className="text-muted-foreground">
                        {t("Signed in as")}
                      </span>
                      <br />
                      {user.email}
                    </p>
                    {state.installation && (
                      <p>
                        <span className="text-muted-foreground">
                          {t("Sign-in")}
                        </span>
                        <br />
                        {t("Local administrator account")}
                        {providers.some((provider) => provider.enabled)
                          ? t(" · {value0} OIDC provider(s) enabled", {
                              value0: providers.filter(
                                (provider) => provider.enabled
                              ).length,
                            })
                          : t(" · OIDC not configured")}
                      </p>
                    )}
                    <p>
                      <span className="text-muted-foreground">
                        {t("AI models")}
                      </span>
                      <br />
                      {hasChat
                        ? t(
                            "A chat model is connected. Start a conversation and select your model in the composer."
                          )
                        : t("No chat model is configured yet.")}
                    </p>
                  </CardContent>
                </Card>
                {!hasChat && (
                  <Alert tone="warning" variant="plain">
                    <MessageSquare />
                    <Alert.Title>{t("AI still needs a model")}</Alert.Title>
                    <Alert.Description>
                      {state.installation
                        ? t(
                            "You can finish setup now and add an endpoint later in Platform admin → Endpoints."
                          )
                        : t(
                            "Ask your workspace administrator to connect an AI endpoint. You can still explore the workspace."
                          )}
                    </Alert.Description>
                  </Alert>
                )}
                <p className="text-sm text-muted-foreground">
                  {state.installation
                    ? t(
                        "Manage team access in workspace settings. Return to Platform admin whenever you want to change authentication or shared models."
                      )
                    : t(
                        "Start with Chat in the sidebar. Your history keeps previous conversations; workspace settings show the shared models and tools available to you."
                      )}
                </p>
              </div>
            </SetupStep>
          </div>
          {error && <ToastFeedback message={error} type={"destructive"} />}
          <footer className="mt-auto flex items-center justify-between gap-3 pt-4">
            <Button
              disabled={busy || index === 0}
              className={index === 0 ? "invisible" : undefined}
              variant="ghost"
              onClick={() => void navigate(index - 1)}
            >
              <ArrowLeft /> {t("Back")}
            </Button>
            <Button
              disabled={busy}
              loading={busy}
              onClick={() =>
                void navigate(
                  Math.min(index + 1, steps.length - 1),
                  index === steps.length - 1
                )
              }
            >
              {index === steps.length - 1
                ? hasChat
                  ? t("Open JustAI")
                  : state.installation
                    ? t("Finish without AI")
                    : t("Open workspace")
                : index === 0
                  ? t("Let’s get started")
                  : t("Continue")}
              <ArrowRight />
            </Button>
          </footer>
        </section>
      </div>
    </main>
  )
}

function SetupStep({
  current,
  step,
  children,
}: {
  current: number
  step: number
  children: ReactNode
}) {
  return current === step ? <div>{children}</div> : null
}
