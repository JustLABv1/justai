"use client"

import { useState } from "react"
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { BrandMark } from "@/components/brand-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

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

  const isRegister = mode === "register"

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    setError("")
    setPassword("")
    setConfirmPassword("")
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

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
      setError(caught instanceof Error ? caught.message : "Could not authenticate")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <form className="p-6 md:p-8" onSubmit={submit}>
            <FieldGroup>
              <div className="flex flex-col items-center gap-3 text-center">
                <BrandMark className="size-10 md:hidden" priority />
                <div>
                  <h1 className="text-2xl font-bold">
                    {isRegister ? "Create your workspace" : "Welcome back"}
                  </h1>
                  <p className="mt-1 text-balance text-muted-foreground">
                    {isRegister
                      ? "Create your JustAI workspace to get started."
                      : "Sign in to continue to your JustAI workspace."}
                  </p>
                </div>
              </div>

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
                  autoComplete={isRegister ? "new-password" : "current-password"}
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
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                  />
                </Field>
              )}

              {error && (
                <Alert variant="destructive">
                  <ShieldCheck aria-hidden="true" />
                  <AlertTitle>Could not continue</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Field>
                <Button type="submit" disabled={loading}>
                  {loading && <Spinner data-icon="inline-start" />}
                  {loading
                    ? "Working…"
                    : isRegister
                      ? "Create workspace"
                      : "Sign in"}
                  {!loading && <ArrowRight data-icon="inline-end" aria-hidden="true" />}
                </Button>
              </Field>

              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                Or continue with
              </FieldSeparator>

              <Field>
                <a
                  className={buttonVariants({ variant: "outline" })}
                  href="/api/v1/auth/oidc/start"
                >
                  <KeyRound data-icon="inline-start" aria-hidden="true" />
                  Continue with OIDC
                </a>
              </Field>

              <FieldDescription className="text-center">
                {isRegister ? "Already have an account?" : "New to JustAI?"}{" "}
                <button
                  className="underline underline-offset-4 hover:no-underline"
                  type="button"
                  onClick={() => switchMode(isRegister ? "login" : "register")}
                >
                  {isRegister ? "Sign in" : "Create an account"}
                </button>
              </FieldDescription>
            </FieldGroup>
          </form>

          <div className="relative hidden min-h-96 overflow-hidden bg-muted md:block">
            <div className="absolute inset-0 bg-primary/5" />
            <BrandMark
              className="absolute inset-0 m-auto size-36 rounded-[2rem] shadow-lg"
              priority
            />
          </div>
        </CardContent>
      </Card>

      <FieldDescription className="px-6 text-center">
        By continuing, you agree to use JustAI within your workspace policies.
      </FieldDescription>
    </div>
  )
}

function safeNext(search: string) {
  const value = new URLSearchParams(search).get("next")
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/"
  }
  return value
}
