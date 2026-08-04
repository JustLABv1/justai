"use client"

import { useState } from "react"
import { CheckCircle2, CircleAlert, Cloud, KeyRound, MoreHorizontal, Plus, Radio, Server, Sparkles, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type { Endpoint } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"

type Props = {
  endpoints: Endpoint[]
  onChange: (endpoints: Endpoint[]) => void
}

type EndpointForm = {
  name: string
  providerType: string
  scopeType: string
  baseUrl: string
  apiPath: string
  chatModel: string
  embeddingModel: string
  transcriptionModel: string
  credential: string
}

const defaults: EndpointForm = {
  name: "My endpoint",
  providerType: "openai-compatible",
  scopeType: "organization",
  baseUrl: "http://localhost:4000/v1",
  apiPath: "",
  chatModel: "",
  embeddingModel: "",
  transcriptionModel: "",
  credential: "",
}

const providerDetails: Record<string, { label: string; description: string; baseUrl: string }> = {
  openai: { label: "OpenAI", description: "Native Chat Completions and Realtime transcription.", baseUrl: "https://api.openai.com/v1" },
  gemini: { label: "Google Gemini", description: "Native Gemini generateContent endpoint.", baseUrl: "https://generativelanguage.googleapis.com" },
  anthropic: { label: "Anthropic", description: "Native Messages API endpoint.", baseUrl: "https://api.anthropic.com" },
  ollama: { label: "Ollama", description: "Local Ollama chat and embedding models.", baseUrl: "http://localhost:11434" },
  "openai-compatible": { label: "OpenAI-compatible", description: "LiteLLM, vLLM, LM Studio, OpenRouter, or another gateway.", baseUrl: "http://localhost:4000/v1" },
  mock: { label: "JustAI demo", description: "A local response stream for exploring the UI.", baseUrl: "http://mock.local" },
}

export function EndpointsView({ endpoints, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<EndpointForm>(defaults)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")

  function update<K extends keyof EndpointForm>(key: K, value: EndpointForm[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function selectProvider(value: string | null) {
    const provider = value ?? "openai-compatible"
    setForm((current) => ({ ...current, providerType: provider, baseUrl: providerDetails[provider]?.baseUrl ?? current.baseUrl }))
  }

  async function saveEndpoint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setNotice("")
    try {
      const result = await api.post<Endpoint>("/api/v1/endpoints", {
        ...form,
        capabilities: { chat: true, embeddings: Boolean(form.embeddingModel), transcription: Boolean(form.transcriptionModel) },
        isDefault: endpoints.length === 0,
      })
      onChange([result, ...endpoints])
      setOpen(false)
      setForm(defaults)
    } catch {
      const demo: Endpoint = {
        id: `local-${Date.now()}`,
        scopeType: form.scopeType as Endpoint["scopeType"],
        providerType: form.providerType,
        name: form.name,
        baseUrl: form.baseUrl,
        apiPath: form.apiPath,
        chatModel: form.chatModel,
        embeddingModel: form.embeddingModel,
        transcriptionModel: form.transcriptionModel,
        capabilities: { chat: true, embeddings: Boolean(form.embeddingModel), transcription: Boolean(form.transcriptionModel) },
        credentialConfigured: Boolean(form.credential),
        enabled: true,
        isDefault: endpoints.length === 0,
        timeoutSeconds: 120,
        maxOutputTokens: 2048,
        temperature: 0.2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      onChange([demo, ...endpoints])
      setNotice("Saved in the local preview. Start the backend to persist it.")
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  async function testEndpoint(endpoint: Endpoint) {
    if (endpoint.id.startsWith("local-")) {
      setNotice(`${endpoint.name} is ready in local preview mode.`)
      return
    }
    try {
      await api.post(`/api/v1/endpoints/${endpoint.id}/test`)
      setNotice(`${endpoint.name} responded successfully.`)
    } catch {
      setNotice(`${endpoint.name} could not be reached. Check its URL and credential.`)
    }
  }

  async function removeEndpoint(endpoint: Endpoint) {
    if (!endpoint.id.startsWith("local-")) await api.delete(`/api/v1/endpoints/${endpoint.id}`)
    onChange(endpoints.filter((item) => item.id !== endpoint.id))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2"><Badge variant="secondary">Model layer</Badge><span className="text-xs text-muted-foreground">{endpoints.length} connected</span></div>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">Endpoints that fit your stack</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Connect native providers, local runtimes, or OpenAI-compatible gateways. Keys are encrypted by the backend and never sent to the browser.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus data-icon="inline-start" aria-hidden="true" />Add endpoint</Button>
      </div>

      {notice && <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">{notice}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        {endpoints.map((endpoint) => {
          const details = providerDetails[endpoint.providerType] ?? providerDetails["openai-compatible"]
          return <Card key={endpoint.id} className="overflow-hidden">
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><ProviderIcon provider={endpoint.providerType} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{endpoint.name}</CardTitle>{endpoint.isDefault && <Badge variant="outline">Default</Badge>}</div>
                <CardDescription className="mt-1">{details.label} · {endpoint.chatModel || "model selected at request time"}</CardDescription>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${endpoint.name}`}><MoreHorizontal aria-hidden="true" /></Button>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><Badge variant="secondary">{endpoint.scopeType}</Badge><Badge variant="outline" className="gap-1.5"><span className={`size-1.5 rounded-full ${endpoint.enabled ? "bg-primary" : "bg-muted-foreground"}`} />{endpoint.enabled ? "Enabled" : "Disabled"}</Badge>{endpoint.credentialConfigured && <Badge variant="outline" className="gap-1.5"><KeyRound aria-hidden="true" />Credential stored</Badge>}</div>
              <Separator className="my-4" />
              <div className="grid gap-3 text-sm sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Base URL</p><p className="mt-1 truncate font-mono text-xs">{endpoint.baseUrl}</p></div><div><p className="text-xs text-muted-foreground">Capabilities</p><div className="mt-1 flex gap-1.5">{Object.entries(endpoint.capabilities ?? {}).filter(([, enabled]) => enabled).map(([capability]) => <Badge key={capability} variant="outline" className="text-[10px]">{capability}</Badge>)}</div></div></div>
              <div className="mt-5 flex gap-2"><Button variant="outline" size="sm" onClick={() => void testEndpoint(endpoint)}><Radio data-icon="inline-start" aria-hidden="true" />Test connection</Button><Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => void removeEndpoint(endpoint)}><Trash2 data-icon="inline-start" aria-hidden="true" />Remove</Button></div>
            </CardContent>
          </Card>
        })}
        {endpoints.length === 0 && <Card className="border-dashed lg:col-span-2"><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center"><div className="flex size-10 items-center justify-center rounded-xl bg-muted"><Cloud aria-hidden="true" /></div><div><p className="font-medium">No custom endpoints yet</p><p className="mt-1 text-sm text-muted-foreground">The backend seeds a JustAI demo endpoint for first-run chat.</p></div><Button variant="outline" size="sm" onClick={() => setOpen(true)}>Connect your first model</Button></CardContent></Card>}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Add an LLM endpoint</DialogTitle><DialogDescription>Choose a native provider or point JustAI at a compatible gateway such as LiteLLM, Ollama, or OpenRouter.</DialogDescription></DialogHeader>
          <form onSubmit={saveEndpoint}>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field><FieldLabel htmlFor="endpoint-name">Display name</FieldLabel><Input id="endpoint-name" value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Team GPT" required /></Field>
                <Field><FieldLabel>Provider</FieldLabel><Select value={form.providerType} onValueChange={selectProvider}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(providerDetails).map(([value, details]) => <SelectItem key={value} value={value}>{details.label}</SelectItem>)}</SelectContent></Select></Field>
              </div>
              <Field><FieldLabel>Visibility</FieldLabel><Select value={form.scopeType} onValueChange={(value) => update("scopeType", value ?? "organization")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="organization">Organization</SelectItem><SelectItem value="user">Only me</SelectItem><SelectItem value="global">Global (platform admin)</SelectItem></SelectContent></Select><FieldDescription>Routing precedence is explicit selection, personal, organization, then global.</FieldDescription></Field>
              <Field><FieldLabel htmlFor="endpoint-url">Base URL</FieldLabel><Input id="endpoint-url" value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" required /><FieldDescription>{providerDetails[form.providerType]?.description}</FieldDescription></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="endpoint-model">Chat model</FieldLabel><Input id="endpoint-model" value={form.chatModel} onChange={(event) => update("chatModel", event.target.value)} placeholder="gpt-4o-mini" /></Field><Field><FieldLabel htmlFor="endpoint-embedding">Embedding model</FieldLabel><Input id="endpoint-embedding" value={form.embeddingModel} onChange={(event) => update("embeddingModel", event.target.value)} placeholder="text-embedding-3-small" /></Field></div>
              <Field><FieldLabel htmlFor="endpoint-key">API key or token</FieldLabel><Input id="endpoint-key" type="password" value={form.credential} onChange={(event) => update("credential", event.target.value)} placeholder="Stored encrypted by JustAI" autoComplete="off" /><FieldDescription>For local runtimes this can stay empty. OAuth-ready MCP credentials follow the same encrypted storage boundary.</FieldDescription></Field>
              <Field><FieldLabel htmlFor="endpoint-notes">Connection notes (optional)</FieldLabel><Textarea id="endpoint-notes" placeholder="Model routing notes for your team" /></Field>
            </FieldGroup>
            <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save endpoint"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "ollama") return <Server aria-hidden="true" />
  if (provider === "mock") return <Sparkles aria-hidden="true" />
  return provider === "anthropic" ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />
}
