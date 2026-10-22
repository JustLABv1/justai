"use client"

import { useEffect, useRef, useState } from "react"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Stepper,
  StepperContent,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperPanel,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper"

type OnboardingState = {
  installation: boolean
  step: string
  completed: boolean
}
const installationSteps = [
  { id: "welcome", title: "Welcome" },
  { id: "workspace", title: "Workspace" },
  { id: "authentication", title: "Sign-in" },
  { id: "endpoints", title: "AI models" },
  { id: "ready", title: "Review" },
]
const userSteps = [
  { id: "welcome", title: "Welcome" },
  { id: "workspace", title: "Your workspace" },
  { id: "ready", title: "Get started" },
]

export function Onboarding() {
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
              ? "Enter a workspace name."
              : "Enter your display name."
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
          <Alert variant="destructive" className="max-w-lg">
            <AlertTitle>Setup unavailable</AlertTitle>
            <AlertDescription>
              {error}
              <Button
                onClick={() => setReload((value) => value + 1)}
                variant="secondary"
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Spinner aria-label="Loading setup" />
        )}
      </main>
    )

  return (
    <main className="flex min-h-0 w-full flex-1 overflow-y-auto bg-background p-4 sm:p-8">
      <Stepper
        className="m-auto grid w-full max-w-6xl overflow-hidden rounded-3xl bg-card shadow-xl shadow-black/5 md:min-h-[42rem] md:grid-cols-[16rem_minmax(0,1fr)]"
        orientation="vertical"
        value={index + 1}
        onValueChange={(value) => {
          if (value - 1 < index) void navigate(value - 1)
        }}
        indicators={{ completed: <Check className="size-4" /> }}
      >
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
                ? "Let’s make it yours."
                : "Make yourself at home."}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {state.installation
                ? "Your workspace, your team, your AI."
                : "A quick introduction to your workspace."}
            </p>
          </div>
          <StepperNav className="hidden gap-1 md:flex">
            {steps.map((step, position) => (
              <StepperItem
                key={step.id}
                step={position + 1}
                disabled={busy || position > index}
                className="w-full items-stretch not-last:flex-none"
              >
                <StepperTrigger className="w-full gap-3 rounded-xl px-3 py-3 text-left disabled:opacity-100 data-[state=active]:bg-card">
                  <StepperIndicator className="size-7">
                    {position + 1}
                  </StepperIndicator>
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <StepperTitle>{step.title}</StepperTitle>
                    <span className="text-xs leading-normal text-muted-foreground">
                      {step.id === "welcome"
                        ? "What we’ll set up"
                        : step.id === "workspace"
                          ? state.installation
                            ? "Name and identity"
                            : "Your profile and access"
                          : step.id === "authentication"
                            ? "OIDC · optional"
                            : step.id === "endpoints"
                              ? "Provider and model"
                              : "Check and launch"}
                    </span>
                  </span>
                </StepperTrigger>
              </StepperItem>
            ))}
          </StepperNav>
          <div className="mt-auto hidden flex-col gap-2 pt-5 md:flex">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5" /> Progress saved automatically
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
          <StepperPanel className="min-w-0 flex-1">
            <div className="mb-6 flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Step {index + 1} of {steps.length}
              </p>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
              >
                {current.id === "welcome"
                  ? state.installation
                    ? "Your workspace starts here."
                    : `Welcome, ${user.displayName}.`
                  : current.id === "workspace"
                    ? state.installation
                      ? "Make this workspace yours"
                      : "A space for your work"
                    : current.id === "authentication"
                      ? "Choose how your team signs in"
                      : current.id === "endpoints"
                        ? "Connect your first AI model"
                        : "Ready for your first conversation"}
              </h1>
            </div>
            <StepperContent value={1}>
              <div className="flex flex-col gap-6">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {state.installation
                    ? "Connect the essentials and you’re ready to go. We’ll guide you through each step; optional settings can wait until later."
                    : "Get to know your workspace and make sure you’re ready to start. Your administrator manages sign-in and shared AI models."}
                </p>
                <div className="flex flex-col gap-5 rounded-2xl bg-muted/50 p-5 sm:p-6">
                  {(state.installation
                    ? [
                        {
                          icon: MessageSquare,
                          title: "Create a home for your team",
                          text: "Name your workspace. Invite people and organize shared resources whenever you’re ready.",
                        },
                        {
                          icon: ShieldCheck,
                          title: "Choose how people sign in",
                          text: "Use existing accounts or connect your company’s identity provider with OIDC. You can do this later.",
                        },
                        {
                          icon: Sparkles,
                          title: "Bring your preferred AI",
                          text: "Connect a hosted provider or your own model server, choose a model and test the connection.",
                        },
                      ]
                    : [
                        {
                          icon: MessageSquare,
                          title: "Meet your workspace",
                          text: "See where you’re working, check your access and choose the name others will see.",
                        },
                        {
                          icon: Sparkles,
                          title: "Start your first conversation",
                          text: "Find the models your administrator has made available and learn where your chat history lives.",
                        },
                      ]
                  ).map(({ icon: Icon, title, text }) => (
                    <div key={title} className="flex items-start gap-4">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-primary">
                        <Icon className="size-4" />
                      </span>
                      <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-medium">{title}</h3>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {text}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                {state.installation && (
                  <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>
                      Your administrator account is ready. You can change these
                      settings later in Platform admin.
                    </span>
                  </p>
                )}
              </div>
            </StepperContent>
            <StepperContent value={2}>
              <Card>
                <CardHeader>
                  <CardTitle>{organization?.name ?? "Your account"}</CardTitle>
                  <CardDescription>
                    {state.installation
                      ? "This is the shared space created with your administrator account. You can invite your team later in workspace settings."
                      : `You’re signed in as ${user.email}${organization ? ` and have ${organization.role ?? "member"} access to this workspace` : ""}.`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="onboarding-name">
                        {state.installation ? "Workspace name" : "Display name"}
                      </FieldLabel>
                      <Input
                        id="onboarding-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={80}
                        autoComplete={
                          state.installation ? "organization" : "name"
                        }
                      />
                      <FieldDescription>
                        {state.installation
                          ? "Choose a name your team will recognize."
                          : "This is how your name appears to others. You can change it in your profile."}
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>
            </StepperContent>
            {state.installation && (
              <StepperContent value={3}>
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    Local sign-in is already available. Optionally connect your
                    company’s identity provider using OIDC. Add its issuer URL
                    and client credentials, then run the discovery test.
                  </p>
                  <PlatformAuthenticationView showCreateAction />
                  <p className="text-xs text-muted-foreground">
                    You can continue with local sign-in and configure SSO later
                    in Platform admin → Authentication.
                  </p>
                </div>
              </StepperContent>
            )}
            {state.installation && (
              <StepperContent value={4}>
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    Connect a hosted provider or your own model server. Choose
                    an LLM endpoint, select a chat model and test the
                    connection. Global endpoints are shared across the
                    installation.
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
                    Prefer to configure AI later? Continue to review; chat
                    becomes available once a model is connected.
                  </p>
                </div>
              </StepperContent>
            )}
            <StepperContent value={steps.length}>
              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {organization?.name ?? "Your workspace"}
                    </CardTitle>
                    <CardDescription>Your setup at a glance</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4 text-sm">
                    <p>
                      <span className="text-muted-foreground">
                        Signed in as
                      </span>
                      <br />
                      {user.email}
                    </p>
                    {state.installation && (
                      <p>
                        <span className="text-muted-foreground">Sign-in</span>
                        <br />
                        Local administrator account
                        {providers.some((provider) => provider.enabled)
                          ? ` · ${providers.filter((provider) => provider.enabled).length} OIDC provider(s) enabled`
                          : " · OIDC not configured"}
                      </p>
                    )}
                    <p>
                      <span className="text-muted-foreground">AI models</span>
                      <br />
                      {hasChat
                        ? "A chat model is connected. Start a conversation and select your model in the composer."
                        : "No chat model is configured yet."}
                    </p>
                  </CardContent>
                </Card>
                {!hasChat && (
                  <Alert>
                    <MessageSquare />
                    <AlertTitle>AI still needs a model</AlertTitle>
                    <AlertDescription>
                      {state.installation
                        ? "You can finish setup now and add an endpoint later in Platform admin → Endpoints."
                        : "Ask your workspace administrator to connect an AI endpoint. You can still explore the workspace."}
                    </AlertDescription>
                  </Alert>
                )}
                <p className="text-sm text-muted-foreground">
                  {state.installation
                    ? "Manage team access in workspace settings. Return to Platform admin whenever you want to change authentication or shared models."
                    : "Start with Chat in the sidebar. Your history keeps previous conversations; workspace settings show the shared models and tools available to you."}
                </p>
              </div>
            </StepperContent>
          </StepperPanel>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not continue</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <footer className="mt-auto flex items-center justify-between gap-3 pt-4">
            <Button
              disabled={busy || index === 0}
              className={index === 0 ? "invisible" : undefined}
              variant="ghost"
              onClick={() => void navigate(index - 1)}
            >
              <ArrowLeft /> Back
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void navigate(
                  Math.min(index + 1, steps.length - 1),
                  index === steps.length - 1
                )
              }
            >
              {busy && <Spinner />}
              {index === steps.length - 1
                ? hasChat
                  ? "Open JustAI"
                  : state.installation
                    ? "Finish without AI"
                    : "Open workspace"
                : index === 0
                  ? "Let’s get started"
                  : "Continue"}
              <ArrowRight />
            </Button>
          </footer>
        </section>
      </Stepper>
    </main>
  )
}
