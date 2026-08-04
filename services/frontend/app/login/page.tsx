"use client"

import { useState } from "react"
import { ArrowRight, KeyRound, ShieldCheck, Sparkles } from "lucide-react"

import { api } from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError("")
    try {
      await api.post(mode === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register", { email, password, displayName })
      window.location.assign("/")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not authenticate")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="grid min-h-svh bg-muted/30 lg:grid-cols-[minmax(0,1fr)_480px]">
      <section className="relative hidden overflow-hidden bg-primary p-10 text-primary-foreground lg:flex lg:flex-col"><div className="absolute -top-40 -right-20 size-[28rem] rounded-full bg-primary-foreground/10 blur-3xl" /><div className="absolute -bottom-44 -left-16 size-[30rem] rounded-full bg-primary-foreground/10 blur-3xl" /><div className="relative flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-xl bg-primary-foreground text-primary"><Sparkles aria-hidden="true" /></div><div><p className="font-heading font-semibold tracking-tight">JustAI</p><p className="text-xs text-primary-foreground/70">JustLAB workspace</p></div></div><div className="relative mt-auto max-w-xl pb-8"><BadgeLine icon={KeyRound} label="One workspace for endpoints, chat, MCP, and RAG" /><h1 className="mt-6 font-heading text-5xl font-semibold tracking-[-0.04em]">Make your AI stack feel like one tool.</h1><p className="mt-6 max-w-lg text-lg leading-relaxed text-primary-foreground/75">Route requests across providers, ground answers in your own sources, and keep actions observable and approval-gated.</p></div><p className="relative text-xs text-primary-foreground/60">Local-first foundations · OpenAI-compatible by design</p></section>
      <section className="flex items-center justify-center p-4 sm:p-8"><Card className="w-full max-w-md shadow-lg"><CardHeader className="space-y-3"><div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground lg:hidden"><Sparkles aria-hidden="true" /></div><div><CardTitle className="text-xl">{mode === "login" ? "Welcome back" : "Create your workspace"}</CardTitle><CardDescription className="mt-1">{mode === "login" ? "Sign in to continue to JustAI." : "Your first account becomes the workspace owner."}</CardDescription></div></CardHeader><CardContent><form onSubmit={submit}><FieldGroup>{mode === "register" && <Field><FieldLabel htmlFor="display-name">Display name</FieldLabel><Input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Justin" autoComplete="name" required /></Field>}<Field><FieldLabel htmlFor="email">Email</FieldLabel><Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required /></Field><Field><FieldLabel htmlFor="password">Password</FieldLabel><Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" autoComplete={mode === "login" ? "current-password" : "new-password"} required /><FieldDescription>Credentials are handled by the backend session boundary.</FieldDescription></Field></FieldGroup>{error && <Alert variant="destructive" className="mt-5"><ShieldCheck aria-hidden="true" /><AlertTitle>Could not continue</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}<Button type="submit" className="mt-6 w-full" disabled={loading}>{loading ? "Working…" : mode === "login" ? "Sign in" : "Create workspace"}<ArrowRight data-icon="inline-end" aria-hidden="true" /></Button></form><Separator className="my-6" /><div className="flex flex-col gap-3 text-center text-sm"><p className="text-muted-foreground">{mode === "login" ? "New to JustAI?" : "Already have an account?"}</p><Button variant="outline" size="sm" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError("") }}>{mode === "login" ? "Create an account" : "Sign in instead"}</Button><Button variant="ghost" size="sm" render={<a href="/api/v1/auth/oidc/start" />}>Continue with OIDC</Button></div></CardContent></Card></section>
    </main>
  )
}

function BadgeLine({ icon: Icon, label }: { icon: typeof KeyRound; label: string }) {
  return <div className="inline-flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-xs text-primary-foreground/85"><Icon aria-hidden="true" />{label}</div>
}
