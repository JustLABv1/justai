"use client"

import { useState } from "react"
import { Check, ExternalLink, KeyRound, MoreHorizontal, Plug, Plus, ShieldCheck, TerminalSquare, Trash2, Wrench } from "lucide-react"

import { api, API_URL } from "@/lib/api"
import type { MCPServer } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"

type Props = {
  servers: MCPServer[]
  onChange: (servers: MCPServer[]) => void
}

type MCPForm = {
  name: string
  endpointUrl: string
  authType: string
  credential: string
  oauthAuthorizationUrl: string
  oauthTokenUrl: string
  oauthClientId: string
  oauthScopes: string
  scopeType: string
  allowedTools: string
}

const emptyForm: MCPForm = { name: "", endpointUrl: "", authType: "none", credential: "", oauthAuthorizationUrl: "", oauthTokenUrl: "", oauthClientId: "", oauthScopes: "", scopeType: "organization", allowedTools: "" }

export function MCPView({ servers, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<MCPForm>(emptyForm)
  const [notice, setNotice] = useState("")
  const [tools, setTools] = useState<Record<string, Array<{ name: string; description?: string }>>>({})

  function update<K extends keyof MCPForm>(key: K, value: MCPForm[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const allowedTools = form.allowedTools.split(",").map((tool) => tool.trim()).filter(Boolean)
    try {
      const server = await api.post<MCPServer>("/api/v1/mcp/servers", { ...form, allowedTools })
      onChange([server, ...servers])
      setNotice(`${form.name} is connected. Tool discovery is explicit and allowlisted.`)
    } catch {
      const local: MCPServer = { id: `local-${Date.now()}`, scopeType: form.scopeType, scopeId: "local", name: form.name, endpointUrl: form.endpointUrl, authType: form.authType, credentialConfigured: Boolean(form.credential), enabled: true, allowedTools, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      onChange([local, ...servers])
      setNotice("Added to the local preview. Start the backend to negotiate Streamable HTTP or SSE.")
    }
    setForm(emptyForm)
    setOpen(false)
  }

  async function discover(server: MCPServer) {
    if (server.id.startsWith("local-")) {
      setTools((current) => ({ ...current, [server.id]: [{ name: "preview.search", description: "Example allowlisted tool" }, { name: "preview.status", description: "Example read-only tool" }] }))
      setNotice("Preview tools loaded. Mutating MCP actions will always require approval.")
      return
    }
    try {
      const result = await api.get<{ tools: Array<{ name: string; description?: string }> }>(`/api/v1/mcp/servers/${server.id}/tools`)
      setTools((current) => ({ ...current, [server.id]: result.tools }))
      setNotice(`${result.tools.length} allowlisted tools discovered.`)
    } catch {
      setNotice("MCP tool discovery failed. Check the endpoint and auth token.")
    }
  }

  async function test(server: MCPServer) {
    if (server.id.startsWith("local-")) {
      setNotice(`${server.name} is ready in local preview mode.`)
      return
    }
    try {
      await api.post(`/api/v1/mcp/servers/${server.id}/test`)
      setNotice(`${server.name} responded successfully.`)
    } catch {
      setNotice(`${server.name} could not be reached.`)
    }
  }

  function authorize(server: MCPServer) {
    if (server.id.startsWith("local-")) {
      setNotice("OAuth authorization is available when the backend is running.")
      return
    }
    window.location.assign(`${API_URL}/api/v1/mcp/servers/${server.id}/oauth/start`)
  }

  async function remove(server: MCPServer) {
    if (!server.id.startsWith("local-")) await api.delete(`/api/v1/mcp/servers/${server.id}`)
    onChange(servers.filter((item) => item.id !== server.id))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><div className="mb-2 flex items-center gap-2"><Badge variant="secondary">Tool layer</Badge><span className="text-xs text-muted-foreground">Streamable HTTP + legacy SSE</span></div><h2 className="font-heading text-2xl font-semibold tracking-tight">Connect an MCP tool belt</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Register remote MCP servers, discover only the tools you allow, and keep mutating actions behind explicit approval.</p></div><Button onClick={() => setOpen(true)}><Plus data-icon="inline-start" aria-hidden="true" />Add MCP server</Button></div>
      {notice && <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">{notice}</div>}
      <div className="grid gap-4 lg:grid-cols-2">{servers.map((server) => <Card key={server.id}><CardHeader className="flex-row items-start gap-3 space-y-0"><div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Plug aria-hidden="true" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{server.name}</CardTitle><Badge variant="outline">{server.authType === "none" ? "No auth" : server.authType === "api_key" ? "API key" : "OAuth"}</Badge></div><CardDescription className="mt-1 truncate font-mono text-xs">{server.endpointUrl}</CardDescription></div><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${server.name}`}><MoreHorizontal aria-hidden="true" /></Button></CardHeader><CardContent><div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><Badge variant="secondary">{server.scopeType}</Badge>{server.credentialConfigured && <Badge variant="outline" className="gap-1.5"><KeyRound aria-hidden="true" />Credential stored</Badge>}<Badge variant="outline" className="gap-1.5"><ShieldCheck aria-hidden="true" />Approval gated</Badge></div><Separator className="my-4" /><div className="flex items-center gap-2 text-sm"><Wrench aria-hidden="true" className="text-muted-foreground" /><span>{server.allowedTools.length ? `${server.allowedTools.length} allowlisted tools` : "All discovered tools"}</span></div>{tools[server.id] && <div className="mt-3 grid gap-2">{tools[server.id].map((tool) => <div key={tool.name} className="rounded-lg border bg-muted/40 px-3 py-2"><p className="font-mono text-xs">{tool.name}</p><p className="mt-1 text-xs text-muted-foreground">{tool.description || "No description provided"}</p></div>)}</div>}<div className="mt-5 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void discover(server)}><TerminalSquare data-icon="inline-start" aria-hidden="true" />Discover tools</Button><Button variant="secondary" size="sm" onClick={() => void test(server)}><Check data-icon="inline-start" aria-hidden="true" />Test</Button>{server.authType === "oauth" && <Button variant="outline" size="sm" onClick={() => authorize(server)}><KeyRound data-icon="inline-start" aria-hidden="true" />Authorize</Button>}<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => void remove(server)}><Trash2 data-icon="inline-start" aria-hidden="true" />Remove</Button></div></CardContent></Card>)}{servers.length === 0 && <Card className="border-dashed lg:col-span-2"><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center"><div className="flex size-10 items-center justify-center rounded-xl bg-muted"><Plug aria-hidden="true" /></div><p className="font-medium">No MCP servers connected</p><p className="max-w-md text-sm text-muted-foreground">Add a remote server over Streamable HTTP or legacy HTTP+SSE. JustAI does not run arbitrary stdio processes from the web app.</p><Button variant="outline" size="sm" onClick={() => setOpen(true)}>Add a server</Button></CardContent></Card>}</div>
      <Card className="bg-muted/35"><CardContent className="flex items-start gap-3 p-4"><ShieldCheck aria-hidden="true" className="mt-0.5 text-muted-foreground" /><div><p className="text-sm font-medium">A safe default for tools</p><p className="mt-1 text-sm text-muted-foreground">API-key and OAuth credentials remain backend-only. Tool names are allowlisted, and mutating calls require an approval event before execution.</p></div><Button variant="ghost" size="icon-sm" className="ml-auto" render={<a href="https://modelcontextprotocol.io/specification/2025-06-18/basic/transports" target="_blank" rel="noreferrer" aria-label="Read MCP transport docs" />}><ExternalLink aria-hidden="true" /></Button></CardContent></Card>
      <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Add MCP server</DialogTitle><DialogDescription>Use the server&apos;s remote HTTP endpoint. Local stdio processes stay outside this web service boundary.</DialogDescription></DialogHeader><form onSubmit={save}><FieldGroup><Field><FieldLabel htmlFor="mcp-name">Display name</FieldLabel><Input id="mcp-name" value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Linear tools" required /></Field><Field><FieldLabel htmlFor="mcp-url">Endpoint URL</FieldLabel><Input id="mcp-url" type="url" value={form.endpointUrl} onChange={(event) => update("endpointUrl", event.target.value)} placeholder="https://mcp.example.com/mcp" required /><FieldDescription>Streamable HTTP is preferred; legacy HTTP+SSE is supported by the backend client.</FieldDescription></Field><div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel>Authentication</FieldLabel><Select value={form.authType} onValueChange={(value) => update("authType", value ?? "none")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No auth</SelectItem><SelectItem value="api_key">API key</SelectItem><SelectItem value="oauth">OAuth 2.1</SelectItem></SelectContent></Select></Field><Field><FieldLabel>Visibility</FieldLabel><Select value={form.scopeType} onValueChange={(value) => update("scopeType", value ?? "organization")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="organization">Organization</SelectItem><SelectItem value="user">Only me</SelectItem></SelectContent></Select></Field></div>{form.authType === "oauth" && <div className="grid gap-4 rounded-xl border bg-muted/35 p-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="mcp-oauth-authorize">Authorization URL</FieldLabel><Input id="mcp-oauth-authorize" type="url" value={form.oauthAuthorizationUrl} onChange={(event) => update("oauthAuthorizationUrl", event.target.value)} placeholder="https://id.example.com/authorize" required /></Field><Field><FieldLabel htmlFor="mcp-oauth-token">Token URL</FieldLabel><Input id="mcp-oauth-token" type="url" value={form.oauthTokenUrl} onChange={(event) => update("oauthTokenUrl", event.target.value)} placeholder="https://id.example.com/token" required /></Field><Field><FieldLabel htmlFor="mcp-oauth-client">Client ID</FieldLabel><Input id="mcp-oauth-client" value={form.oauthClientId} onChange={(event) => update("oauthClientId", event.target.value)} placeholder="public-client-id" required /></Field><Field><FieldLabel htmlFor="mcp-oauth-scopes">Scopes</FieldLabel><Input id="mcp-oauth-scopes" value={form.oauthScopes} onChange={(event) => update("oauthScopes", event.target.value)} placeholder="openid tools" /></Field><FieldDescription className="sm:col-span-2">PKCE is generated by the backend. After saving, start authorization from the server actions.</FieldDescription></div>}<Field><FieldLabel htmlFor="mcp-credential">Credential</FieldLabel><Input id="mcp-credential" type="password" value={form.credential} onChange={(event) => update("credential", event.target.value)} placeholder={form.authType === "oauth" ? "Optional existing access token" : "Stored encrypted by JustAI"} autoComplete="off" /></Field><Field><FieldLabel htmlFor="mcp-tools">Allowlisted tools</FieldLabel><Input id="mcp-tools" value={form.allowedTools} onChange={(event) => update("allowedTools", event.target.value)} placeholder="search, create_issue" /><FieldDescription>Comma-separated. Leave empty to inspect all read-only tools, subject to approval policy.</FieldDescription></Field></FieldGroup><DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">Save server</Button></DialogFooter></form></DialogContent></Dialog>
    </div>
  )
}
