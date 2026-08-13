"use client"

import { useState } from "react"
import {
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Plug,
  Plus,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react"

import { APIError, api, API_URL } from "@/lib/api"
import type { MCPServer } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type Props = {
  servers: MCPServer[]
  onChange: (servers: MCPServer[]) => void
  organizationRole?: string
  userId?: string
  platformAdmin?: boolean
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
  trustedReadOnly: boolean
}

const emptyForm: MCPForm = {
  name: "",
  endpointUrl: "",
  authType: "none",
  credential: "",
  oauthAuthorizationUrl: "",
  oauthTokenUrl: "",
  oauthClientId: "",
  oauthScopes: "",
  scopeType: "organization",
  allowedTools: "",
  trustedReadOnly: false,
}

export function MCPView({
  servers,
  onChange,
  organizationRole,
  userId,
  platformAdmin = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<MCPForm>(emptyForm)
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null)
  const [notice, setNotice] = useState("")
  const [tools, setTools] = useState<
    Record<string, Array<{ name: string; description?: string }>>
  >({})
  const [busyId, setBusyId] = useState("")
  const [saving, setSaving] = useState(false)
  const canManageOrganization =
    platformAdmin ||
    organizationRole === "owner" ||
    organizationRole === "admin"

  const canManageServer = (server: MCPServer) => {
    if (userId === undefined && organizationRole === undefined) return true
    if (server.scopeType === "user") return server.scopeId === userId
    return server.scopeType === "organization" && canManageOrganization
  }

  function update<K extends keyof MCPForm>(key: K, value: MCPForm[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    const allowedTools = form.allowedTools
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean)
    try {
      const server = editingServer
        ? await api.patch<MCPServer>(
            `/api/v1/mcp/servers/${editingServer.id}`,
            { ...form, allowedTools }
          )
        : await api.post<MCPServer>("/api/v1/mcp/servers", {
            ...form,
            allowedTools,
          })
      onChange(
        editingServer
          ? servers.map((item) => (item.id === server.id ? server : item))
          : [server, ...servers]
      )
      setNotice(
        `${form.name} is connected. Tool discovery is explicit and allowlisted.`
      )
    } catch (caught) {
      if (caught instanceof APIError) {
        setNotice(`Could not connect MCP server: ${caught.message}`)
        return
      }
      setNotice(
        caught instanceof Error
          ? caught.message
          : "Could not connect MCP server. Check the backend and endpoint."
      )
      return
    } finally {
      setSaving(false)
    }
    setForm(emptyForm)
    setEditingServer(null)
    setOpen(false)
  }

  function edit(server: MCPServer) {
    setEditingServer(server)
    setForm({
      name: server.name,
      endpointUrl: server.endpointUrl,
      authType: server.authType,
      credential: "",
      oauthAuthorizationUrl: "",
      oauthTokenUrl: "",
      oauthClientId: "",
      oauthScopes: "",
      scopeType: server.scopeType,
      allowedTools: server.allowedTools.join(", "),
      trustedReadOnly: Boolean(server.trustedReadOnly),
    })
    setOpen(true)
  }

  async function patchServer(server: MCPServer, body: Record<string, unknown>) {
    setBusyId(server.id)
    try {
      const updated = await api.patch<MCPServer>(
        `/api/v1/mcp/servers/${server.id}`,
        body
      )
      onChange(
        servers.map((item) =>
          item.id === server.id ? { ...item, ...updated } : item
        )
      )
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The MCP server could not be updated."
      )
    } finally {
      setBusyId("")
    }
  }

  async function discover(server: MCPServer) {
    setBusyId(server.id)
    try {
      const result = await api.get<{
        tools: Array<{ name: string; description?: string }>
      }>(`/api/v1/mcp/servers/${server.id}/tools`)
      setTools((current) => ({ ...current, [server.id]: result.tools }))
      onChange(
        servers.map((item) =>
          item.id === server.id
            ? { ...item, toolCount: result.tools.length, lastError: "" }
            : item
        )
      )
      setNotice(`${result.tools.length} allowlisted tools discovered.`)
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "MCP tool discovery failed. Check the endpoint and auth token."
      onChange(
        servers.map((item) =>
          item.id === server.id ? { ...item, lastError: message } : item
        )
      )
      setNotice(message)
    } finally {
      setBusyId("")
    }
  }

  async function test(server: MCPServer) {
    setBusyId(server.id)
    try {
      const result = await api.post<{ server?: MCPServer }>(
        `/api/v1/mcp/servers/${server.id}/test`
      )
      if (result.server)
        onChange(
          servers.map((item) => (item.id === server.id ? result.server! : item))
        )
      setNotice(`${server.name} responded successfully.`)
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : `${server.name} could not be reached.`
      onChange(
        servers.map((item) =>
          item.id === server.id
            ? { ...item, lastError: message, lastTestedAt: new Date().toISOString() }
            : item
        )
      )
      setNotice(message)
    } finally {
      setBusyId("")
    }
  }

  function authorize(server: MCPServer) {
    window.location.assign(
      `${API_URL}/api/v1/mcp/servers/${server.id}/oauth/start`
    )
  }

  async function remove(server: MCPServer) {
    if (!window.confirm(`Remove ${server.name}?`)) return
    setBusyId(server.id)
    try {
      await api.delete(`/api/v1/mcp/servers/${server.id}`)
      onChange(servers.filter((item) => item.id !== server.id))
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The MCP server could not be removed."
      )
    } finally {
      setBusyId("")
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="secondary">Tool layer</Badge>
            <span className="text-xs text-muted-foreground">
              Streamable HTTP + legacy SSE
            </span>
          </div>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">
            Connect an MCP tool belt
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Register remote MCP servers, discover only the tools you allow, and
            keep every call behind explicit consent.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingServer(null)
            setForm({
              ...emptyForm,
              scopeType: canManageOrganization ? "organization" : "user",
            })
            setOpen(true)
          }}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add MCP server
        </Button>
      </div>
      {notice && (
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {servers.map((server) => (
          <Card key={server.id}>
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                <Plug aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{server.name}</CardTitle>
                  <Badge variant="outline">
                    {server.authType === "none"
                      ? "No auth"
                      : server.authType === "api_key"
                        ? "API key"
                        : "OAuth"}
                  </Badge>
                </div>
                <CardDescription className="mt-1 truncate font-mono text-xs">
                  {server.endpointUrl}
                </CardDescription>
              </div>
              {canManageServer(server) && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${server.name}`}
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => edit(server)}>
                      Edit server
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void patchServer(server, { enabled: !server.enabled })
                      }
                    >
                      {server.enabled ? "Disable" : "Enable"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void patchServer(server, {
                          trustedReadOnly: !server.trustedReadOnly,
                        })
                      }
                    >
                      {server.trustedReadOnly
                        ? "Remove read-only trust"
                        : "Trust read-only tools"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void remove(server)}>
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{server.scopeType}</Badge>
                {!server.enabled && <Badge variant="outline">Disabled</Badge>}
                {server.trustedReadOnly && (
                  <Badge variant="outline" className="gap-1.5">
                    <ShieldCheck aria-hidden="true" />
                    Trusted read-only
                  </Badge>
                )}
                {server.credentialConfigured && (
                  <Badge variant="outline" className="gap-1.5">
                    <KeyRound aria-hidden="true" />
                    Credential stored
                  </Badge>
                )}
                <Badge variant="outline" className="gap-1.5">
                  <ShieldCheck aria-hidden="true" />
                  Approval gated
                </Badge>
              </div>
              <Separator className="my-4" />
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  <span className="font-medium text-foreground">Protocol:</span>{" "}
                  {server.protocolVersion || "Negotiating"}
                </div>
                <div>
                  <span className="font-medium text-foreground">
                    Last test:
                  </span>{" "}
                  {server.lastTestedAt
                    ? new Date(server.lastTestedAt).toLocaleString()
                    : "Not tested"}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Wrench aria-hidden="true" className="text-muted-foreground" />
                <span>
                  {server.toolCount
                    ? `${server.toolCount} discovered tools`
                    : server.allowedTools.length
                      ? `${server.allowedTools.length} allowlisted tools`
                      : "No tools discovered yet"}
                </span>
              </div>
              {tools[server.id] && (
                <div className="mt-3 grid gap-2">
                  {tools[server.id].map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-lg border bg-muted/40 px-3 py-2"
                    >
                      <p className="font-mono text-xs">{tool.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tool.description || "No description provided"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {server.lastError && (
                <p className="mt-2 text-xs text-destructive">
                  {server.lastError}
                </p>
              )}
              {canManageServer(server) && (
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === server.id}
                    onClick={() => void discover(server)}
                  >
                    {busyId === server.id ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                    ) : (
                      <TerminalSquare
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                    )}
                    Discover tools
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId === server.id}
                    onClick={() => void test(server)}
                  >
                    {busyId === server.id ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                    ) : (
                      <Check data-icon="inline-start" aria-hidden="true" />
                    )}
                    Test
                  </Button>
                  {server.authType === "oauth" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === server.id}
                      onClick={() => authorize(server)}
                    >
                      <KeyRound data-icon="inline-start" aria-hidden="true" />
                      {server.credentialConfigured
                        ? "Reconnect OAuth"
                        : "Authorize"}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-muted-foreground"
                    disabled={busyId === server.id}
                    onClick={() => void remove(server)}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {servers.length === 0 && (
          <Card className="border-dashed lg:col-span-2">
            <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <Plug aria-hidden="true" />
              </div>
              <p className="font-medium">No MCP servers connected</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Add a remote server over Streamable HTTP or legacy HTTP+SSE.
                JustAI does not run arbitrary stdio processes from the web app.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setForm({
                    ...emptyForm,
                    scopeType: canManageOrganization ? "organization" : "user",
                  })
                  setOpen(true)
                }}
              >
                Add a server
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
      <Card className="bg-muted/35">
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 text-muted-foreground"
          />
          <div>
            <p className="text-sm font-medium">A safe default for tools</p>
            <p className="mt-1 text-sm text-muted-foreground">
              API-key and OAuth credentials remain backend-only. Every call
              needs approval unless an administrator trusts read-only tools for
              this server.
            </p>
          </div>
          <Button
            nativeButton={false}
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            render={
              <a
                href="https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http"
                target="_blank"
                rel="noreferrer"
                aria-label="Read MCP transport docs"
              />
            }
          >
            <ExternalLink aria-hidden="true" />
          </Button>
        </CardContent>
      </Card>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) {
            setEditingServer(null)
            setForm(emptyForm)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingServer ? "Edit MCP server" : "Add MCP server"}
            </DialogTitle>
            <DialogDescription>
              Use the server&apos;s remote HTTP endpoint. Local stdio processes
              stay outside this web service boundary.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="mcp-name">Display name</FieldLabel>
                <Input
                  id="mcp-name"
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  placeholder="Linear tools"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-url">Endpoint URL</FieldLabel>
                <Input
                  id="mcp-url"
                  type="url"
                  value={form.endpointUrl}
                  onChange={(event) =>
                    update("endpointUrl", event.target.value)
                  }
                  placeholder="https://mcp.example.com/mcp"
                  required
                />
                <FieldDescription>
                  Streamable HTTP is preferred; legacy HTTP+SSE is supported by
                  the backend client.
                </FieldDescription>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Authentication</FieldLabel>
                  <Select
                    value={form.authType}
                    onValueChange={(value) =>
                      update("authType", value ?? "none")
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No auth</SelectItem>
                      <SelectItem value="api_key">API key</SelectItem>
                      <SelectItem value="oauth">OAuth 2.1</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Visibility</FieldLabel>
                  <Select
                    value={form.scopeType}
                    onValueChange={(value) =>
                      update(
                        "scopeType",
                        value ??
                          (canManageOrganization ? "organization" : "user")
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {canManageOrganization && (
                        <SelectItem value="organization">
                          Organization
                        </SelectItem>
                      )}
                      <SelectItem value="user">Only me</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {form.authType === "oauth" && (
                <div className="grid gap-4 rounded-xl border bg-muted/35 p-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-authorize">
                      Authorization URL
                    </FieldLabel>
                    <Input
                      id="mcp-oauth-authorize"
                      type="url"
                      value={form.oauthAuthorizationUrl}
                      onChange={(event) =>
                        update("oauthAuthorizationUrl", event.target.value)
                      }
                      placeholder="Auto-discovered from the server"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-token">Token URL</FieldLabel>
                    <Input
                      id="mcp-oauth-token"
                      type="url"
                      value={form.oauthTokenUrl}
                      onChange={(event) =>
                        update("oauthTokenUrl", event.target.value)
                      }
                      placeholder="Auto-discovered from the server"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-client">
                      Client ID
                    </FieldLabel>
                    <Input
                      id="mcp-oauth-client"
                      value={form.oauthClientId}
                      onChange={(event) =>
                        update("oauthClientId", event.target.value)
                      }
                      placeholder="public-client-id"
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-scopes">Scopes</FieldLabel>
                    <Input
                      id="mcp-oauth-scopes"
                      value={form.oauthScopes}
                      onChange={(event) =>
                        update("oauthScopes", event.target.value)
                      }
                      placeholder="openid tools"
                    />
                  </Field>
                  <FieldDescription className="sm:col-span-2">
                    PKCE, resource indicators, metadata discovery, and encrypted
                    token storage are handled by the backend. Manual URLs are an
                    advanced compatibility override.
                  </FieldDescription>
                </div>
              )}
              <Field>
                <FieldLabel htmlFor="mcp-credential">Credential</FieldLabel>
                <Input
                  id="mcp-credential"
                  type="password"
                  value={form.credential}
                  onChange={(event) => update("credential", event.target.value)}
                  placeholder={
                    form.authType === "oauth"
                      ? "Optional existing access token"
                      : "Stored encrypted by JustAI"
                  }
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-tools">Allowlisted tools</FieldLabel>
                <Input
                  id="mcp-tools"
                  value={form.allowedTools}
                  onChange={(event) =>
                    update("allowedTools", event.target.value)
                  }
                  placeholder="search, create_issue"
                />
                <FieldDescription>
                  Comma-separated. Leave empty to inspect all discovered tools,
                  subject to approval policy.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <LoaderCircle
                      className="animate-spin"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    Saving…
                  </>
                ) : editingServer ? (
                  "Save changes"
                ) : (
                  "Save server"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
