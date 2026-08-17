"use client"

import { useState } from "react"
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AuthLiveCaption } from "@/components/auth-live-caption"
import { BrandMark } from "@/components/brand-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, API_URL } from "@/lib/api"
import { usePlatformConfig } from "@/components/platform-config"
import { oidcLoginPath } from "@/lib/platform-config-logic"
import { cn } from "@/lib/utils"

import styles from "./login-form.module.css"

type AuthMode = "login" | "register"

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [mode, setMode] = useState<AuthMode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const { config } = usePlatformConfig()
  const oidcProviders = config?.oidcProviders?.length
    ? config.oidcProviders
    : config?.oidcEnabled
      ? [
          {
            id: "legacy",
            slug: "",
            displayName: config.oidcLabel || "Continue with OIDC",
          },
        ]
      : []
  const oidcEnabled = config?.oidcEnabled ?? false
  const loginEnabled = config?.loginEnabled !== false
  const localAuthEnabled = config?.localAuthEnabled !== false
  const signupEnabled = config?.signupEnabled !== false
  const maintenanceMessage = config?.maintenanceMessage ?? ""

  const isRegister = mode === "register"
  // Keep the sign-in form usable even when the platform gate is closed. The
  // backend intentionally allows platform administrators to recover the
  // deployment while rejecting regular users.
  const modeGateEnabled = isRegister ? signupEnabled : loginEnabled
  const modeEnabled = isRegister ? signupEnabled && localAuthEnabled : true

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    setError("")
    setPassword("")
    setConfirmPassword("")
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    if (isRegister && (!signupEnabled || !localAuthEnabled)) {
      setError(
        maintenanceMessage ||
          (localAuthEnabled
            ? "Account creation is temporarily disabled."
            : "Local password authentication is disabled.")
      )
      return
    }

    if (isRegister && password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    setLoading(true)
    try {
      await api.post(
        isRegister ? "/api/v1/auth/register" : "/api/v1/auth/login",
        {
          email,
          password,
          ...(isRegister ? { displayName } : {}),
        }
      )
      window.location.assign(safeNext(window.location.search))
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not authenticate"
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={cn(styles.authExperience, className)} {...props}>
      <div className={styles.authLayout}>
        <AuthLiveCaption />

        <section className={styles.authFormPane}>
          <div className={styles.authFormInner}>
            <div className={styles.authBrandRow}>
              <BrandMark className="size-10 rounded-xl" />
              <div>
                <p className={styles.authBrandName}>JustAI</p>
                <p className={styles.authBrandMeta}>
                  Your intelligent workspace
                </p>
              </div>
            </div>

            <div className={styles.authIntro}>
              <p className={styles.authEyebrow}>
                {isRegister ? "Start a new workspace" : "Welcome back"}
              </p>
              <h1 className={styles.authTitle}>
                {isRegister
                  ? "Make the next conversation count."
                  : "Your context is waiting."}
              </h1>
              <p className={styles.authDescription}>
                {isRegister
                  ? "Bring every conversation, transcript, and next step into one clear place."
                  : "Sign in to pick up where your workspace left off."}
              </p>
            </div>

            {signupEnabled && (
              <div
                aria-label="Authentication mode"
                className={styles.authModeSwitch}
                role="tablist"
              >
                <button
                  aria-selected={!isRegister}
                  className={cn(
                    styles.authModeButton,
                    !isRegister && styles.authModeButtonActive
                  )}
                  role="tab"
                  type="button"
                  onClick={() => switchMode("login")}
                >
                  Sign in
                </button>
                <button
                  aria-selected={isRegister}
                  className={cn(
                    styles.authModeButton,
                    isRegister && styles.authModeButtonActive
                  )}
                  role="tab"
                  type="button"
                  onClick={() => switchMode("register")}
                >
                  Create account
                </button>
              </div>
            )}

            <form className={styles.authForm} onSubmit={submit}>
              <FieldGroup>
                {isRegister && (
                  <Field>
                    <FieldLabel htmlFor="display-name">Display name</FieldLabel>
                    <Input
                      id="display-name"
                      autoComplete="name"
                      placeholder="Justin"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      required
                    />
                  </Field>
                )}

                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    autoComplete={
                      isRegister ? "new-password" : "current-password"
                    }
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                  {isRegister && (
                    <FieldDescription>
                      Use at least 8 characters.
                    </FieldDescription>
                  )}
                </Field>

                {isRegister && (
                  <Field>
                    <FieldLabel htmlFor="confirm-password">
                      Confirm password
                    </FieldLabel>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      required
                    />
                  </Field>
                )}

                {(!modeGateEnabled || (!isRegister && !localAuthEnabled)) &&
                  !error && (
                    <Alert>
                      <ShieldCheck aria-hidden="true" />
                      <AlertTitle>Temporarily unavailable</AlertTitle>
                      <AlertDescription>
                        {maintenanceMessage ||
                          (isRegister
                            ? "Account creation is temporarily disabled."
                            : !localAuthEnabled
                              ? "Local password authentication is disabled for regular users. Platform administrators can still sign in for recovery."
                              : "Sign in is temporarily disabled for regular users. Platform administrators can still sign in for recovery.")}
                      </AlertDescription>
                    </Alert>
                  )}

                {error && (
                  <Alert variant="destructive">
                    <ShieldCheck aria-hidden="true" />
                    <AlertTitle>Could not continue</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <Field className={styles.authSubmitField}>
                  <Button
                    className={styles.authSubmit}
                    type="submit"
                    disabled={loading || (isRegister && !modeEnabled)}
                  >
                    {loading && <Spinner data-icon="inline-start" />}
                    {loading
                      ? "Working…"
                      : isRegister
                        ? "Create workspace"
                        : "Continue to workspace"}
                    {!loading && (
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    )}
                  </Button>
                </Field>

                {oidcEnabled &&
                  oidcProviders.length > 0 &&
                  (!isRegister || signupEnabled) && (
                    <>
                      <FieldSeparator className={styles.authSeparator}>
                        Or continue with
                      </FieldSeparator>

                      {oidcProviders.map((provider) => (
                        <Field key={provider.id || provider.slug}>
                          <a
                            className={buttonVariants({
                              variant: "outline",
                              className: styles.authSso,
                            })}
                            href={`${API_URL}${oidcLoginPath(provider.slug, safeNext(typeof window === "undefined" ? "" : window.location.search))}`}
                          >
                            <KeyRound
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                            {provider.displayName || "Continue with OIDC"}
                          </a>
                        </Field>
                      ))}
                    </>
                  )}

                {signupEnabled && (
                  <FieldDescription className={styles.authModeDescription}>
                    {isRegister ? "Already have an account?" : "New to JustAI?"}{" "}
                    <button
                      className="underline underline-offset-4 hover:no-underline"
                      type="button"
                      onClick={() =>
                        switchMode(isRegister ? "login" : "register")
                      }
                    >
                      {isRegister ? "Sign in" : "Create an account"}
                    </button>
                  </FieldDescription>
                )}
              </FieldGroup>
            </form>

            <FieldDescription className={styles.authPolicy}>
              By continuing, you agree to use JustAI within your workspace
              policies.
            </FieldDescription>
          </div>
        </section>
      </div>
    </div>
  )
}

function safeNext(search: string) {
  const value = new URLSearchParams(search).get("next")
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\r") ||
    value.includes("\n") ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/"
  }
  return value
}
