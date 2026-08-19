"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  Check,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plug,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react"

import { APIError, api, API_URL } from "@/lib/api"
import type { MCPServer } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  createRequest?: number
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

type MCPAction = {
  serverId: string
  label: string
}

function isRequestAborted(caught: unknown) {
  return caught instanceof APIError && caught.code === "request_aborted"
}

export function MCPView({
  servers,
  onChange,
  organizationRole,
  userId,
  platformAdmin = false,
  createRequest,
}: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<MCPForm>(emptyForm)
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null)
  const [notice, setNotice] = useState("")
  const [tools, setTools] = useState<
    Record<string, Array<{ name: string; description?: string }>>
  >({})
  const [busyId, setBusyId] = useState("")
  const [activeAction, setActiveAction] = useState<MCPAction | null>(null)
  const [saving, setSaving] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<MCPServer | null>(null)
  const actionAbortRef = useRef<AbortController | null>(null)
  const createRequestRef = useRef(createRequest ?? 0)
  const canManageOrganization =
    platformAdmin ||
    organizationRole === "owner" ||
    organizationRole === "admin"

  const canManageServer = (server: MCPServer) => {
    if (server.scopeType === "global") return false
    if (userId === undefined && organizationRole === undefined) return true
    if (server.scopeType === "user") return server.scopeId === userId
    return server.scopeType === "organization" && canManageOrganization
  }

  const openCreate = useCallback(() => {
    setEditingServer(null)
    setForm({
      ...emptyForm,
      scopeType: canManageOrganization ? "organization" : "user",
    })
    setOpen(true)
  }, [canManageOrganization])

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

  useEffect(() => {
    return () => actionAbortRef.current?.abort()
  }, [])

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
    const controller = new AbortController()
    actionAbortRef.current = controller
    setBusyId(server.id)
    setActiveAction({ serverId: server.id, label: "Discovering tools…" })
    setNotice("")
    onChange(
      servers.map((item) =>
        item.id === server.id ? { ...item, lastError: "" } : item
      )
    )
    try {
      const result = await api.get<{
        tools: Array<{ name: string; description?: string }>
      }>(`/api/v1/mcp/servers/${server.id}/tools`, {
        signal: controller.signal,
      })
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
      if (isRequestAborted(caught)) {
        setNotice(`${server.name} tool discovery was stopped.`)
        return
      }
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
      if (actionAbortRef.current === controller) actionAbortRef.current = null
      setActiveAction(null)
      setBusyId("")
    }
  }

  async function test(server: MCPServer) {
    const controller = new AbortController()
    actionAbortRef.current = controller
    setBusyId(server.id)
    setActiveAction({ serverId: server.id, label: "Testing connection…" })
    setNotice("")
    onChange(
      servers.map((item) =>
        item.id === server.id ? { ...item, lastError: "" } : item
      )
    )
    try {
      const result = await api.post<{ server?: MCPServer }>(
        `/api/v1/mcp/servers/${server.id}/test`,
        undefined,
        { signal: controller.signal }
      )
      onChange(
        servers.map((item) =>
          item.id === server.id
            ? { ...item, ...(result.server ?? {}), lastError: "" }
            : item
        )
      )
      setNotice(`${server.name} responded successfully.`)
    } catch (caught) {
      if (isRequestAborted(caught)) {
        setNotice(`${server.name} connection test was stopped.`)
        return
      }
      const message =
        caught instanceof Error
          ? caught.message
          : `${server.name} could not be reached.`
      onChange(
        servers.map((item) =>
          item.id === server.id
            ? {
                ...item,
                lastError: message,
                lastTestedAt: new Date().toISOString(),
              }
            : item
        )
      )
      setNotice(message)
    } finally {
      if (actionAbortRef.current === controller) actionAbortRef.current = null
      setActiveAction(null)
      setBusyId("")
    }
  }

  function stopActiveAction() {
    actionAbortRef.current?.abort()
  }

  function authorize(server: MCPServer) {
    window.location.assign(
      `${API_URL}/api/v1/mcp/servers/${server.id}/oauth/start`
    )
  }

  async function remove(server: MCPServer) {
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
      {notice && (
        <div
          aria-live="polite"
          className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          {notice}
        </div>
      )}
      {servers.some((server) => server.scopeType === "global") && (
        <div className="flex items-start gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3 text-sm">
          <LockKeyhole
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">Platform-managed MCP servers</p>
            <p className="mt-1 text-muted-foreground">
              These servers are inherited by this workspace and can only be
              changed from the Platform Admin catalog.
            </p>
          </div>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {servers.map((server) => (
          <Card key={server.id} size="sm" className="gap-0">
            <CardHeader className="flex-row items-start gap-3 border-b pb-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
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
            </CardHeader>
            <CardContent className="space-y-4 pt-3">
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {server.scopeType === "global" ? (
                  <Badge variant="outline" className="gap-1.5">
                    <LockKeyhole aria-hidden="true" /> Platform-managed
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    {server.scopeType === "organization"
                      ? "Workspace"
                      : "Personal"}
                  </Badge>
                )}
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
              <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
                <Wrench aria-hidden="true" className="size-3.5" />
                <span className="truncate">
                  {server.toolCount
                    ? `${server.toolCount} discovered tools`
                    : server.allowedTools.length
                      ? `${server.allowedTools.length} allowlisted tools`
                      : "No tools discovered yet"}
                </span>
              </div>
              {tools[server.id] && (
                <div className="mt-2 grid max-h-36 gap-1 overflow-y-auto sm:grid-cols-2">
                  {tools[server.id].map((tool) => (
                    <div
                      key={tool.name}
                      className="rounded-md border bg-muted/20 px-2 py-1.5"
                    >
                      <p className="font-mono text-xs">{tool.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                        {tool.description || "No description provided"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {server.lastError && (
                <div
                  aria-live="assertive"
                  className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
                  role="alert"
                >
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="min-w-0 break-words">
                    <span className="font-medium">MCP action failed: </span>
                    {server.lastError}
                  </span>
                </div>
              )}
              {canManageServer(server) && (
                <div className="flex items-center justify-end border-t pt-3">
                  {activeAction?.serverId === server.id ? (
                    <div className="flex w-full items-center justify-end gap-2">
                      <div
                        aria-live="polite"
                        className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
                        role="status"
                      >
                        <LoaderCircle
                          aria-hidden="true"
                          className="size-3.5 shrink-0 animate-spin"
                        />
                        <span className="truncate">{activeAction.label}</span>
                      </div>
                      <Button
                        aria-label={`Stop action for ${server.name}`}
                        onClick={stopActiveAction}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Square data-icon="inline-start" aria-hidden="true" />
                        Stop
                      </Button>
                    </div>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            disabled={busyId === server.id}
                            variant="outline"
                            size="sm"
                            aria-label={`Actions for ${server.name}`}
                          />
                        }
                      >
                        <MoreHorizontal
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        Actions
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={busyId === server.id}
                          onClick={() => void discover(server)}
                        >
                          <TerminalSquare aria-hidden="true" /> Discover tools
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={busyId === server.id}
                          onClick={() => void test(server)}
                        >
                          <Check aria-hidden="true" /> Test connection
                        </DropdownMenuItem>
                        {server.authType === "oauth" && (
                          <DropdownMenuItem
                            disabled={busyId === server.id}
                            onClick={() => authorize(server)}
                          >
                            <KeyRound aria-hidden="true" />
                            {server.credentialConfigured
                              ? "Reconnect OAuth"
                              : "Authorize"}
                          </DropdownMenuItem>
                        )}
                        {canManageServer(server) && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={busyId === server.id}
                              onClick={() => edit(server)}
                            >
                              <Pencil aria-hidden="true" /> Edit server
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busyId === server.id}
                              className={
                                server.enabled
                                  ? "text-destructive focus:text-destructive"
                                  : "text-primary focus:text-primary"
                              }
                              onClick={() =>
                                void patchServer(server, {
                                  enabled: !server.enabled,
                                })
                              }
                            >
                              {server.enabled ? "Disable" : "Enable"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busyId === server.id}
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
                            <DropdownMenuItem
                              disabled={busyId === server.id}
                              variant="destructive"
                              onClick={() => setRemoveTarget(server)}
                            >
                              <Trash2 aria-hidden="true" /> Remove
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
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
              <Button variant="outline" size="sm" onClick={openCreate}>
                Add a server
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busyId) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove “{removeTarget?.name}”? Existing conversations keep their
              messages, but this server and its tools will no longer be
              available for new calls.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!removeTarget || Boolean(busyId)}
              variant="destructive"
              onClick={() => {
                const target = removeTarget
                setRemoveTarget(null)
                if (target) void remove(target)
              }}
            >
              Remove server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
                        <SelectItem value="organization">Workspace</SelectItem>
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
