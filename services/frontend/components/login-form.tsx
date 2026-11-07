"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import { useTranslations } from "@/components/locale-provider"
import { LanguageSwitcher } from "@/components/language-switcher"
import { useState } from "react"
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AuroraBackdrop } from "@/components/aurora-backdrop"
import { BrandMark, BrandWordmark } from "@/components/brand-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/panelui/spinner"
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
  const { t } = useTranslations()

  const [mode, setMode] = useState<AuthMode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [adminFallbackRequested, setAdminFallbackRequested] = useState(false)

  const { config, loading: configLoading } = usePlatformConfig()
  const oidcProviders = config?.oidcProviders?.length
    ? config.oidcProviders
    : config?.oidcEnabled
      ? [
          {
            id: "legacy",
            slug: "",
            displayName: config.oidcLabel || t("Continue with OIDC"),
          },
        ]
      : []
  const oidcEnabled = config?.oidcEnabled ?? false
  const oidcAvailable = oidcEnabled && oidcProviders.length > 0
  const loginEnabled = config?.loginEnabled !== false
  const localAuthEnabled = config?.localAuthEnabled !== false
  const localAuthVisible = !configLoading && localAuthEnabled
  const signupEnabled = config?.signupEnabled !== false
  const maintenanceMessage = config?.maintenanceMessage ?? ""

  const initialSetup = config?.setupRequired === true
  const isRegister = initialSetup || mode === "register"
  const adminFallbackAvailable =
    !configLoading && !isRegister && (!localAuthEnabled || !loginEnabled)
  const adminFallbackActive = adminFallbackAvailable && adminFallbackRequested
  const localCredentialsVisible = localAuthVisible || adminFallbackActive
  const modeGateEnabled = isRegister ? signupEnabled : loginEnabled
  const modeEnabled =
    localCredentialsVisible &&
    (adminFallbackActive || (isRegister ? signupEnabled : loginEnabled))

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    setError("")
    setPassword("")
    setConfirmPassword("")
  }

  function enableAdminFallback() {
    setMode("login")
    setAdminFallbackRequested(true)
    setError("")
    setPassword("")
    setConfirmPassword("")
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    if (!localCredentialsVisible) {
      setError("Local password authentication is unavailable.")
      return
    }

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
      window.location.assign(
        initialSetup ? "/setup" : safeNext(window.location.search)
      )
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
        <section className={styles.authFormPane}>
          <AuroraBackdrop className="absolute inset-x-0 top-0 -z-10 h-[90%]" />
          <div className={styles.authFormInner}>
            <div className="flex justify-end">
              <LanguageSwitcher />
            </div>
            <div
              className={cn(
                styles.authBrandRow,
                initialSetup && "justify-center"
              )}
              role={initialSetup ? "img" : undefined}
              aria-label={initialSetup ? "JustAI" : undefined}
            >
              <BrandMark
                className={initialSetup ? "size-16" : "size-10 rounded-xl"}
                cropped={initialSetup}
              />
              {!initialSetup && <BrandWordmark className="h-6" />}
            </div>

            <div className={styles.authIntro}>
              <h1 className={styles.authTitle}>
                {initialSetup
                  ? t("Create your administrator account")
                  : isRegister
                    ? t("Create your account")
                    : t("Sign in to JustAI")}
              </h1>
              <p className={styles.authDescription}>
                {initialSetup
                  ? t(
                      "Next, we’ll configure your workspace, sign-in and AI models."
                    )
                  : isRegister
                    ? t("Set up an account to start working in your workspace.")
                    : t("Continue to your workspace.")}
              </p>
            </div>

            {!initialSetup && signupEnabled && localAuthVisible && (
              <div
                aria-label={t("Authentication mode")}
                className={styles.authModeSwitch}
                role="group"
              >
                <button
                  aria-pressed={!isRegister}
                  className={cn(
                    styles.authModeButton,
                    !isRegister && styles.authModeButtonActive
                  )}
                  type="button"
                  onClick={() => switchMode("login")}
                >
                  {t("Sign in")}
                </button>
                <button
                  aria-pressed={isRegister}
                  className={cn(
                    styles.authModeButton,
                    isRegister && styles.authModeButtonActive
                  )}
                  type="button"
                  onClick={() => switchMode("register")}
                >
                  {t("Create account")}
                </button>
              </div>
            )}

            <form className={styles.authForm} onSubmit={submit}>
              <FieldGroup>
                {configLoading && !config ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Spinner /> {t("Loading sign-in options…")}
                  </div>
                ) : localCredentialsVisible ? (
                  <>
                    {isRegister && (
                      <Field>
                        <FieldLabel htmlFor="display-name">
                          {t("Display name")}
                        </FieldLabel>
                        <Input
                          id="display-name"
                          autoComplete="name"
                          placeholder="Justin"
                          value={displayName}
                          onChange={(event) =>
                            setDisplayName(event.target.value)
                          }
                          required
                        />
                      </Field>
                    )}

                    <Field>
                      <FieldLabel htmlFor="email">{t("Email")}</FieldLabel>
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
                      <FieldLabel htmlFor="password">
                        {t("Password")}
                      </FieldLabel>
                      <Input
                        id="password"
                        type="password"
                        autoComplete={
                          isRegister ? "new-password" : "current-password"
                        }
                        placeholder={t("At least 8 characters")}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                      {isRegister && (
                        <FieldDescription>
                          {t("Use at least 8 characters.")}
                        </FieldDescription>
                      )}
                    </Field>

                    {isRegister && (
                      <Field>
                        <FieldLabel htmlFor="confirm-password">
                          {t("Confirm password")}
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

                    {adminFallbackActive && !error && (
                      <Alert>
                        <ShieldCheck aria-hidden="true" />
                        <AlertTitle>{t("Administrator fallback")}</AlertTitle>
                        <AlertDescription>
                          {t(
                            "Password sign-in is available here only for platform administrators."
                          )}
                        </AlertDescription>
                      </Alert>
                    )}

                    {(!modeGateEnabled || (!isRegister && !localAuthEnabled)) &&
                      !adminFallbackActive &&
                      !error && (
                        <Alert>
                          <ShieldCheck aria-hidden="true" />
                          <AlertTitle>
                            {t("Temporarily unavailable")}
                          </AlertTitle>
                          <AlertDescription>
                            {maintenanceMessage ||
                              (isRegister
                                ? t("Account creation is temporarily disabled.")
                                : t(
                                    "Sign in is temporarily disabled for regular users."
                                  ))}
                          </AlertDescription>
                        </Alert>
                      )}

                    {error && (
                      <ToastFeedback message={error} type={"destructive"} />
                    )}

                    <Field className={styles.authSubmitField}>
                      <Button
                        className={styles.authSubmit}
                        type="submit"
                        disabled={loading || !modeEnabled}
                      >
                        {loading && <Spinner data-icon="inline-start" />}
                        {loading
                          ? t("Working…")
                          : isRegister
                            ? t("Create workspace")
                            : t("Continue to workspace")}
                        {!loading && (
                          <ArrowRight
                            data-icon="inline-end"
                            aria-hidden="true"
                          />
                        )}
                      </Button>
                    </Field>
                  </>
                ) : !oidcAvailable ? (
                  <Alert>
                    <ShieldCheck aria-hidden="true" />
                    <AlertTitle>{t("No sign-in methods available")}</AlertTitle>
                    <AlertDescription>
                      {maintenanceMessage ||
                        "Local password authentication is disabled. Contact your platform administrator."}
                    </AlertDescription>
                  </Alert>
                ) : null}

                {oidcAvailable && (!isRegister || signupEnabled) && (
                  <>
                    {localCredentialsVisible && (
                      <FieldSeparator className={styles.authSeparator}>
                        {t("Or continue with")}
                      </FieldSeparator>
                    )}

                    {oidcProviders.map((provider) => (
                      <Field key={provider.id || provider.slug}>
                        <a
                          className={buttonVariants({
                            // SSO is the primary action when it is the only
                            // way in; next to a password form it stays secondary.
                            variant: localCredentialsVisible
                              ? "outline"
                              : "default",
                            className: cn(
                              styles.authSso,
                              !localCredentialsVisible && styles.authSsoPrimary
                            ),
                          })}
                          href={`${API_URL}${oidcLoginPath(
                            provider.slug,
                            safeNext(
                              typeof window === "undefined"
                                ? ""
                                : window.location.search
                            ),
                            typeof window === "undefined"
                              ? ""
                              : window.location.origin
                          )}`}
                        >
                          <KeyRound
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {ssoLabel(provider.displayName, t)}
                        </a>
                      </Field>
                    ))}
                  </>
                )}

                {adminFallbackAvailable && !adminFallbackActive && (
                  <Field>
                    <Button
                      className="w-full text-xs font-normal text-muted-foreground"
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={enableAdminFallback}
                    >
                      {t("Platform administrator? Sign in with a password")}
                    </Button>
                  </Field>
                )}

                {!initialSetup && signupEnabled && localAuthVisible && (
                  <FieldDescription className={styles.authModeDescription}>
                    {isRegister
                      ? t("Already have an account?")
                      : t("New to JustAI?")}{" "}
                    <button
                      className="underline underline-offset-4 hover:no-underline"
                      type="button"
                      onClick={() =>
                        switchMode(isRegister ? "login" : "register")
                      }
                    >
                      {isRegister ? t("Sign in") : t("Create an account")}
                    </button>
                  </FieldDescription>
                )}
              </FieldGroup>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}

function ssoLabel(
  displayName: string | undefined,
  t: (message: string, values?: Record<string, string | number>) => string
) {
  const name = displayName?.trim()
  if (!name) return t("Continue with SSO")
  return /^(continue|sign|log)/i.test(name)
    ? name
    : t("Continue with {name}", { name })
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
