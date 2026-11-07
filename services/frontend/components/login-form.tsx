"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import { useTranslations } from "@/components/locale-provider"
import { LanguageSwitcher } from "@/components/language-switcher"
import { useState } from "react"
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react"

import { Alert } from "@/components/panelui/alert"
import { Card, CardContent } from "@/components/panelui/card"
import { Tabs } from "@/components/panelui/tabs"
import { AuroraBackdrop } from "@/components/aurora-backdrop"
import { BrandMark } from "@/components/brand-mark"
import { Button, buttonVariants } from "@/components/panelui/button"
import { Field, FieldLabel, FieldDescription } from "@/components/panelui/field"
import { Input } from "@/components/panelui/input"
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
          <Card className="w-full max-w-[30rem] gap-0">
            <CardContent className="p-6 sm:p-8">
              <div className="flex justify-end">
                <LanguageSwitcher />
              </div>
              <div
                className="mt-2 flex justify-center"
                role="img"
                aria-label="JustAI"
              >
                <BrandMark className="size-14" cropped />
              </div>

              <div className={styles.authIntro}>
                <h1 className={styles.authTitle}>
                  {initialSetup
                    ? t("Create your administrator account")
                    : isRegister
                      ? t("Create your account")
                      : t("Sign in to JustAI")}
                </h1>
              </div>

              <Tabs
                value={isRegister ? "register" : "login"}
                onValueChange={(value) => {
                  if (value === "login" || value === "register")
                    switchMode(value)
                }}
                className="mt-6 gap-0"
              >
                {!initialSetup && signupEnabled && localAuthVisible && (
                  <Tabs.List
                    aria-label={t("Authentication mode")}
                    className="w-full"
                  >
                    <Tabs.Trigger
                      value="login"
                      disabled={loading}
                      className="flex-1"
                    >
                      {t("Sign in")}
                    </Tabs.Trigger>
                    <Tabs.Trigger
                      value="register"
                      disabled={loading}
                      className="flex-1"
                    >
                      {t("Create account")}
                    </Tabs.Trigger>
                  </Tabs.List>
                )}
                <Tabs.Content value={isRegister ? "register" : "login"}>
                  <form className={styles.authForm} onSubmit={submit}>
                    <div className="flex flex-col gap-4">
                      {configLoading && !config ? (
                        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                          <Spinner /> {t("Loading sign-in options…")}
                        </div>
                      ) : localCredentialsVisible ? (
                        <>
                          {isRegister && (
                            <Field>
                              <FieldLabel>{t("Display name")}</FieldLabel>
                              <Input
                                size="lg"
                                disabled={loading}
                                id="display-name"
                                autoComplete="name"
                                placeholder={t("Your name")}
                                value={displayName}
                                onChange={(event) =>
                                  setDisplayName(event.target.value)
                                }
                                required
                              />
                            </Field>
                          )}

                          <Field>
                            <FieldLabel>{t("Email")}</FieldLabel>
                            <Input
                              size="lg"
                              disabled={loading}
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
                            <FieldLabel>{t("Password")}</FieldLabel>
                            <Input
                              size="lg"
                              disabled={loading}
                              id="password"
                              type="password"
                              minLength={isRegister ? 8 : undefined}
                              autoComplete={
                                isRegister ? "new-password" : "current-password"
                              }
                              placeholder={t("At least 8 characters")}
                              value={password}
                              onChange={(event) =>
                                setPassword(event.target.value)
                              }
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
                              <FieldLabel>{t("Confirm password")}</FieldLabel>
                              <Input
                                size="lg"
                                disabled={loading}
                                id="confirm-password"
                                type="password"
                                minLength={isRegister ? 8 : undefined}
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
                            <Alert tone="info" variant="plain">
                              <ShieldCheck aria-hidden="true" />
                              <Alert.Title>
                                {t("Administrator fallback")}
                              </Alert.Title>
                              <Alert.Description>
                                {t(
                                  "Password sign-in is available here only for platform administrators."
                                )}
                              </Alert.Description>
                            </Alert>
                          )}

                          {(!modeGateEnabled ||
                            (!isRegister && !localAuthEnabled)) &&
                            !adminFallbackActive &&
                            !error && (
                              <Alert tone="info" variant="plain">
                                <ShieldCheck aria-hidden="true" />
                                <Alert.Title>
                                  {t("Temporarily unavailable")}
                                </Alert.Title>
                                <Alert.Description>
                                  {maintenanceMessage ||
                                    (isRegister
                                      ? t(
                                          "Account creation is temporarily disabled."
                                        )
                                      : t(
                                          "Sign in is temporarily disabled for regular users."
                                        ))}
                                </Alert.Description>
                              </Alert>
                            )}

                          {error && (
                            <ToastFeedback
                              message={error}
                              type={"destructive"}
                            />
                          )}

                          <Field className={styles.authSubmitField}>
                            <Button
                              className={styles.authSubmit}
                              size="lg"
                              type="submit"
                              disabled={loading || !modeEnabled}
                              loading={loading}
                            >
                              {loading
                                ? t("Working…")
                                : isRegister
                                  ? t(
                                      initialSetup
                                        ? "Create workspace"
                                        : "Create account"
                                    )
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
                        <Alert tone="info" variant="plain">
                          <ShieldCheck aria-hidden="true" />
                          <Alert.Title>
                            {t("No sign-in methods available")}
                          </Alert.Title>
                          <Alert.Description>
                            {maintenanceMessage ||
                              "Local password authentication is disabled. Contact your platform administrator."}
                          </Alert.Description>
                        </Alert>
                      ) : null}

                      {oidcAvailable && (!isRegister || signupEnabled) && (
                        <>
                          {localCredentialsVisible && (
                            <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
                              <span className="h-px flex-1 bg-border" />
                              <span>{t("Or continue with")}</span>
                              <span className="h-px flex-1 bg-border" />
                            </div>
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
                                  size: "lg",
                                  className: cn(
                                    styles.authSso,
                                    !localCredentialsVisible &&
                                      styles.authSsoPrimary
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
                            {t(
                              "Platform administrator? Sign in with a password"
                            )}
                          </Button>
                        </Field>
                      )}

                      {!initialSetup && signupEnabled && localAuthVisible && (
                        <p className="text-center text-xs text-muted-foreground">
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
                        </p>
                      )}
                    </div>
                  </form>
                </Tabs.Content>
              </Tabs>
            </CardContent>
          </Card>
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
