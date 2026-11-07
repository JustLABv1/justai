"use client"

import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  ImagePlus,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plug,
  Sparkles,
  TerminalSquare,
  Trash2,
  Search,
  ChevronDown,
  X,
} from "lucide-react"

import { APIError, api, API_URL, resolveAPIURL } from "@/lib/api"
import type { MCPServer } from "@/lib/types"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/panelui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/panelui/card"
import { Sheet } from "@/components/panelui/sheet"
import { Frame } from "@/components/panelui/frame"
import { Alert } from "@/components/panelui/alert"
import { Field } from "@/components/panelui/field"
import { EndpointBadge } from "@/components/endpoint-badge"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import { Menu } from "@/components/panelui/menu"

type Props = {
  servers: MCPServer[]
  onChange: (servers: MCPServer[]) => void
  organizationRole?: string
  userId?: string
  platformAdmin?: boolean
  createRequest?: number
  resourceError?: string
  onRetryResource?: () => void
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
  autoDiscover: boolean
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
  autoDiscover: true,
}

type MCPAction = {
  serverId: string
  label: string
}

const maxMCPServerIconBytes = 2 * 1024 * 1024

function mcpAuthLabel(authType: string) {
  switch (authType) {
    case "none":
      return "No auth"
    case "api_key":
      return "Bearer token"
    case "litellm":
      return "LiteLLM API key"
    case "oauth":
      return "OAuth 2.1"
    default:
      return authType
  }
}

function oauthExpiryState(expiresAt?: string | null) {
  if (!expiresAt) return null
  const timestamp = new Date(expiresAt).getTime()
  if (!Number.isFinite(timestamp)) return null
  if (timestamp <= Date.now()) return "expired" as const
  if (timestamp <= Date.now() + 7 * 24 * 60 * 60 * 1000)
    return "expiring" as const
  return "active" as const
}

function oauthExpiryLabel(expiresAt?: string | null) {
  if (!expiresAt) return "OAuth authorization needs attention"
  const date = new Date(expiresAt)
  if (!Number.isFinite(date.getTime()))
    return "OAuth authorization needs attention"
  return `OAuth ${date <= new Date() ? "expired" : "expires"} ${date.toLocaleString()}`
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
  resourceError,
  onRetryResource,
}: Props) {
  const { t, locale } = useTranslations()

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<MCPForm>(emptyForm)
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null)
  const [notice, setNotice] = useState("")
  const [dialogError, setDialogError] = useState("")
  const [tools, setTools] = useState<
    Record<string, Array<{ name: string; description?: string }>>
  >({})
  const [busyId, setBusyId] = useState("")
  const [activeAction, setActiveAction] = useState<MCPAction | null>(null)
  const [saving, setSaving] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<MCPServer | null>(null)
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [iconPreview, setIconPreview] = useState("")
  const [iconRemoved, setIconRemoved] = useState(false)
  const actionAbortRef = useRef<AbortController | null>(null)
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const iconObjectURLRef = useRef("")
  const createRequestRef = useRef(createRequest ?? 0)
  const canManageOrganization =
    platformAdmin ||
    organizationRole === "owner" ||
    organizationRole === "admin"
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState("all")
  const [status, setStatus] = useState("all")
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const visibleServers = servers.filter(
    (server) =>
      (scope === "all" || server.scopeType === scope) &&
      (status === "all" || server.enabled === (status === "enabled")) &&
      `${server.name} ${server.endpointUrl}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
  )

  const canManageServer = (server: MCPServer) => {
    if (server.scopeType === "global") return false
    if (userId === undefined && organizationRole === undefined) return true
    if (server.scopeType === "user") return server.scopeId === userId
    return server.scopeType === "organization" && canManageOrganization
  }

  const resetIconSelection = useCallback((preview = "") => {
    if (iconObjectURLRef.current) {
      URL.revokeObjectURL(iconObjectURLRef.current)
      iconObjectURLRef.current = ""
    }
    setIconFile(null)
    setIconPreview(preview)
    setIconRemoved(false)
    setDialogError("")
    if (iconInputRef.current) iconInputRef.current.value = ""
  }, [])

  function chooseIcon(file: File | null) {
    if (!file) return
    if (file.size > maxMCPServerIconBytes) {
      setDialogError("MCP icons are limited to 2 MB.")
      if (iconInputRef.current) iconInputRef.current.value = ""
      return
    }
    const allowedTypes = new Set([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/vnd.microsoft.icon",
      "image/webp",
      "image/x-icon",
    ])
    if (!allowedTypes.has(file.type)) {
      setDialogError(
        "Use a PNG, JPEG, GIF, WebP, or ICO image for the MCP logo."
      )
      if (iconInputRef.current) iconInputRef.current.value = ""
      return
    }
    if (iconObjectURLRef.current) URL.revokeObjectURL(iconObjectURLRef.current)
    iconObjectURLRef.current = URL.createObjectURL(file)
    setIconFile(file)
    setIconPreview(iconObjectURLRef.current)
    setIconRemoved(false)
    setDialogError("")
  }

  const openCreate = useCallback(() => {
    setEditingServer(null)
    setDialogError("")
    resetIconSelection()
    setForm({
      ...emptyForm,
      scopeType: canManageOrganization ? "organization" : "user",
    })
    setOpen(true)
  }, [canManageOrganization, resetIconSelection])

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

  useEffect(() => {
    return () => {
      actionAbortRef.current?.abort()
      if (iconObjectURLRef.current)
        URL.revokeObjectURL(iconObjectURLRef.current)
    }
  }, [])

  function update<K extends keyof MCPForm>(key: K, value: MCPForm[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setDialogError("")
    const allowedTools = form.allowedTools
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean)
    try {
      let server = editingServer
        ? await api.patch<MCPServer>(
            `/api/v1/mcp/servers/${editingServer.id}`,
            { ...form, allowedTools }
          )
        : await api.post<MCPServer>("/api/v1/mcp/servers", {
            ...form,
            allowedTools,
          })
      if (iconFile) {
        const body = new FormData()
        body.set("icon", iconFile)
        server = await api.upload<MCPServer>(
          `/api/v1/mcp/servers/${server.id}/icon`,
          body
        )
      } else if (iconRemoved && editingServer) {
        server = await api.delete<MCPServer>(
          `/api/v1/mcp/servers/${editingServer.id}/icon`
        )
      }
      let connectionNotice = ""
      const canVerifyNow =
        server.authType !== "oauth" || Boolean(server.credentialConfigured)
      if (!editingServer && canVerifyNow) {
        try {
          const tested = await api.post<{ server?: MCPServer }>(
            `/api/v1/mcp/servers/${server.id}/test`
          )
          server = { ...server, ...(tested.server ?? {}), lastError: "" }
          const discovered = await api.get<{
            tools: Array<{ name: string; description?: string }>
          }>(`/api/v1/mcp/servers/${server.id}/tools`)
          setTools((current) => ({
            ...current,
            [server.id]: discovered.tools,
          }))
          server = { ...server, toolCount: discovered.tools.length }
          connectionNotice = t(
            "Connection verified. {count} tools discovered.",
            { count: discovered.tools.length }
          )
        } catch (caught) {
          server = {
            ...server,
            lastError:
              caught instanceof Error
                ? caught.message
                : t("Verification failed."),
          }
          connectionNotice = t(
            "The server was saved, but verification needs attention."
          )
        }
      } else if (!editingServer && server.authType === "oauth") {
        connectionNotice = t("Authorize OAuth to verify the connection.")
      }
      onChange(
        editingServer
          ? servers.map((item) => (item.id === server.id ? server : item))
          : [server, ...servers]
      )
      setNotice(
        `${t("{value0} was saved.", { value0: form.name })} ${connectionNotice}`
      )
    } catch (caught) {
      if (caught instanceof APIError) {
        setDialogError(`Could not save MCP server: ${caught.message}`)
        return
      }
      setDialogError(
        caught instanceof Error
          ? `Could not save MCP server: ${caught.message}`
          : "Could not save MCP server. Check the backend and endpoint."
      )
      return
    } finally {
      setSaving(false)
    }
    resetIconSelection()
    setForm(emptyForm)
    setEditingServer(null)
    setOpen(false)
  }

  function edit(server: MCPServer) {
    setEditingServer(server)
    setDialogError("")
    resetIconSelection(server.iconUrl ?? "")
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
      autoDiscover: Boolean(server.autoDiscover),
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
    setActiveAction({ serverId: server.id, label: t("Discovering tools…") })
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
      setExpandedServer(server.id)
      onChange(
        servers.map((item) =>
          item.id === server.id
            ? { ...item, toolCount: result.tools.length, lastError: "" }
            : item
        )
      )
      setNotice(t("{count} tools discovered.", { count: result.tools.length }))
    } catch (caught) {
      if (isRequestAborted(caught)) {
        setNotice(`${server.name} tool discovery was stopped.`)
        return
      }
      const message =
        caught instanceof Error
          ? caught.message
          : t("MCP tool discovery failed. Check the endpoint and auth token.")
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
    setActiveAction({ serverId: server.id, label: t("Testing connection…") })
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
      setNotice(t("{value0} responded successfully.", { value0: server.name }))
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
    // OAuth must leave the app for the backend/provider redirect chain.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `${API_URL}/api/v1/mcp/servers/${server.id}/oauth/start`
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
    <div className="flex flex-col gap-5">
      {resourceError && (
        <Alert tone="destructive" variant="plain">
          <Alert.Title>{t("MCP servers could not be loaded.")}</Alert.Title>
          <Alert.Description>{t(resourceError)}</Alert.Description>
          {onRetryResource && (
            <Alert.Actions>
              <Button size="sm" variant="outline" onClick={onRetryResource}>
                {t("Retry")}
              </Button>
            </Alert.Actions>
          )}
        </Alert>
      )}
      {notice && (
        <Alert tone="info" variant="plain">
          <Alert.Description>{t(notice)}</Alert.Description>
        </Alert>
      )}
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_11rem]">
          <div className="min-w-0">
            <Input.Group>
              <Input.Addon>
                <Search className="size-4" />
              </Input.Addon>
              <Input
                aria-label={t("Search MCP servers")}
                placeholder={t("Search MCP servers")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Input.Group>
          </div>
          <Select
            value={scope}
            onValueChange={(value) => setScope(value ?? "all")}
          >
            <SelectTrigger aria-label={t("Visibility")}>
              <SelectValue>
                {t(
                  scope === "all"
                    ? "All scopes"
                    : scope === "global"
                      ? "Platform"
                      : scope === "user"
                        ? "Personal"
                        : "Workspace"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("All scopes")}</SelectItem>
                <SelectItem value="organization">{t("Workspace")}</SelectItem>
                <SelectItem value="user">{t("Personal")}</SelectItem>
                <SelectItem value="global">{t("Platform")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value ?? "all")}
          >
            <SelectTrigger aria-label={t("Status")}>
              <SelectValue>
                {t(
                  status === "all"
                    ? "All statuses"
                    : status === "enabled"
                      ? "Enabled"
                      : "Disabled"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("All statuses")}</SelectItem>
                <SelectItem value="enabled">{t("Enabled")}</SelectItem>
                <SelectItem value="disabled">{t("Disabled")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("{count} of {total} servers", {
            count: visibleServers.length,
            total: servers.length,
          })}
        </p>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {visibleServers.map((server) => {
            const manageable = canManageServer(server)
            const oauthState =
              server.authType === "oauth"
                ? oauthExpiryState(server.oauthExpiresAt)
                : null
            const needsOAuth =
              server.authType === "oauth" &&
              (!server.credentialConfigured || oauthState === "expired")
            const health = !server.enabled
              ? "Disabled"
              : needsOAuth
                ? "Authorization needed"
                : server.lastError
                  ? "Check failed"
                  : server.lastTestedAt
                    ? "Healthy"
                    : "Not tested"
            const discovered = tools[server.id]
            return (
              <Card key={server.id} size="sm">
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <EndpointBadge
                      name={server.name}
                      logoUrl={server.iconUrl}
                      fallback={<Plug className="size-5" />}
                      className="size-10 shrink-0 rounded-xl bg-muted object-contain text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <CardTitle>
                        {manageable ? (
                          <button
                            type="button"
                            onClick={() => edit(server)}
                            className="max-w-full truncate text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {server.name}
                          </button>
                        ) : (
                          server.name
                        )}
                      </CardTitle>
                      <CardDescription
                        className="mt-1 truncate"
                        title={server.endpointUrl}
                      >
                        {server.endpointUrl}
                      </CardDescription>
                    </div>
                    {manageable && (
                      <Menu>
                        <Menu.Trigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("Actions for {value0}", {
                                value0: server.name,
                              })}
                              disabled={Boolean(busyId)}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </Menu.Trigger>
                        <Menu.Content align="end">
                          <Menu.Item
                            disabled={Boolean(busyId)}
                            onClick={() => void discover(server)}
                          >
                            <TerminalSquare aria-hidden="true" />{" "}
                            {t("Discover tools")}
                          </Menu.Item>
                          <Menu.Item
                            disabled={Boolean(busyId)}
                            onClick={() => void test(server)}
                          >
                            <Check aria-hidden="true" /> {t("Test connection")}
                          </Menu.Item>
                          {server.authType === "oauth" && (
                            <Menu.Item
                              disabled={Boolean(busyId)}
                              onClick={() => authorize(server)}
                            >
                              <KeyRound aria-hidden="true" />
                              {server.credentialConfigured
                                ? t("Reconnect OAuth")
                                : t("Authorize")}
                            </Menu.Item>
                          )}
                          {canManageServer(server) && (
                            <>
                              <Menu.Separator />
                              <Menu.Item
                                disabled={Boolean(busyId)}
                                onClick={() => edit(server)}
                              >
                                <Pencil aria-hidden="true" /> {t("Edit server")}
                              </Menu.Item>
                              <Menu.Item
                                disabled={Boolean(busyId)}
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
                                {server.enabled ? t("Disable") : t("Enable")}
                              </Menu.Item>
                              <Menu.Item
                                disabled={Boolean(busyId)}
                                onClick={() =>
                                  void patchServer(server, {
                                    trustedReadOnly: !server.trustedReadOnly,
                                  })
                                }
                              >
                                {server.trustedReadOnly
                                  ? t("Remove read-only trust")
                                  : t("Trust read-only tools")}
                              </Menu.Item>
                              <Menu.Item
                                disabled={Boolean(busyId)}
                                onClick={() =>
                                  void patchServer(server, {
                                    autoDiscover: !server.autoDiscover,
                                  })
                                }
                              >
                                <Sparkles aria-hidden="true" />
                                {server.autoDiscover
                                  ? t("Require manual attachment")
                                  : t("Make available automatically")}
                              </Menu.Item>
                              <Menu.Item
                                disabled={Boolean(busyId)}
                                variant="destructive"
                                onClick={() => setRemoveTarget(server)}
                              >
                                <Trash2 aria-hidden="true" /> {t("Remove")}
                              </Menu.Item>
                            </>
                          )}
                        </Menu.Content>
                      </Menu>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        health === "Healthy"
                          ? "success"
                          : health === "Check failed" || needsOAuth
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {t(health)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {t(mcpAuthLabel(server.authType))} ·{" "}
                      {t(
                        server.scopeType === "global"
                          ? "Platform"
                          : server.scopeType === "user"
                            ? "Personal"
                            : "Workspace"
                      )}
                    </span>
                    {server.scopeType === "global" && (
                      <LockKeyhole
                        className="size-3.5 text-muted-foreground"
                        aria-label={t("Managed by platform")}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("{count} tools", {
                        count: discovered?.length ?? server.toolCount ?? 0,
                      })}
                    </span>
                    <span>
                      {t(
                        server.autoDiscover
                          ? "Available automatically"
                          : "Manual attachment"
                      )}
                    </span>
                  </div>
                  {server.trustedReadOnly && (
                    <p className="text-xs text-muted-foreground">
                      {t("Trusted read-only")}
                    </p>
                  )}
                  {server.authType === "oauth" && oauthState === "expiring" && (
                    <p
                      className="text-xs text-muted-foreground"
                      title={oauthExpiryLabel(server.oauthExpiresAt)}
                    >
                      {t("OAuth expiring soon")}
                    </p>
                  )}
                  {server.lastError && (
                    <Alert tone="destructive" variant="plain">
                      <Alert.Description>{server.lastError}</Alert.Description>
                    </Alert>
                  )}
                  {manageable && needsOAuth && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => authorize(server)}
                      disabled={Boolean(busyId)}
                    >
                      {t(
                        server.credentialConfigured
                          ? "Reconnect OAuth"
                          : "Authorize"
                      )}
                    </Button>
                  )}
                  {expandedServer === server.id && discovered && (
                    <Frame variant="plain">
                      <Frame.Header>
                        <Frame.Title>{t("Discovered tools")}</Frame.Title>
                      </Frame.Header>
                      <Frame.Panel className="max-h-60 overflow-y-auto">
                        {discovered.length ? (
                          discovered.map((tool) => (
                            <Frame.Row key={tool.name}>
                              <Frame.Content>
                                <Frame.Title
                                  as="p"
                                  className="break-all whitespace-normal!"
                                >
                                  {tool.name}
                                </Frame.Title>
                                <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                                  {tool.description ||
                                    t("No description provided")}
                                </Frame.Description>
                              </Frame.Content>
                            </Frame.Row>
                          ))
                        ) : (
                          <Frame.Row>
                            <Frame.Description>
                              {t("No tools discovered yet")}
                            </Frame.Description>
                          </Frame.Row>
                        )}
                      </Frame.Panel>
                    </Frame>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {activeAction?.serverId === server.id ? (
                      <>
                        <span
                          role="status"
                          className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <Spinner className="size-4" />
                          {activeAction.label}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={stopActiveAction}
                        >
                          {t("Stop")}
                        </Button>
                      </>
                    ) : (
                      <>
                        {manageable && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(busyId)}
                            onClick={() => void test(server)}
                          >
                            {t("Test connection")}
                          </Button>
                        )}
                        {manageable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(busyId)}
                            onClick={() => {
                              if (expandedServer === server.id)
                                setExpandedServer(null)
                              else if (discovered) setExpandedServer(server.id)
                              else void discover(server)
                            }}
                          >
                            {t(
                              expandedServer === server.id
                                ? "Hide tools"
                                : "View tools"
                            )}
                          </Button>
                        )}
                        <div className="ml-auto">
                          {manageable && (
                            <Switch
                              aria-label={t("Enable {value0}", {
                                value0: server.name,
                              })}
                              checked={server.enabled}
                              disabled={Boolean(busyId)}
                              onCheckedChange={(enabled) =>
                                void patchServer(server, { enabled })
                              }
                            />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {server.lastTestedAt
                      ? t("Last tested {value0}", {
                          value0: new Date(server.lastTestedAt).toLocaleString(
                            locale
                          ),
                        })
                      : t("Not tested")}
                  </p>
                </CardContent>
              </Card>
            )
          })}
        </div>
        {!visibleServers.length && !resourceError && (
          <Frame>
            <Frame.Panel>
              <Frame.Row className="flex-col items-start gap-3 py-8">
                <Frame.Title as="p">
                  {t(
                    servers.length
                      ? "No matching MCP servers"
                      : "No MCP servers connected"
                  )}
                </Frame.Title>
                <Frame.Description>
                  {t(
                    servers.length
                      ? "Try another search or reset the filters."
                      : "Connect a remote MCP server to bring its tools into your chats."
                  )}
                </Frame.Description>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={
                    servers.length
                      ? () => {
                          setQuery("")
                          setScope("all")
                          setStatus("all")
                        }
                      : openCreate
                  }
                >
                  {t(servers.length ? "Clear filters" : "Add MCP server")}
                </Button>
              </Frame.Row>
            </Frame.Panel>
          </Frame>
        )}
        {servers.some((server) => server.scopeType === "global") && (
          <p className="text-xs text-muted-foreground">
            {t(
              "Platform-managed servers can only be edited in the platform catalog."
            )}
          </p>
        )}
      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busyId) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t("Remove MCP server?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Remove “")}
            {removeTarget?.name}
            {t(
              "”? Existing conversations keep their messages, but this server and its tools will no longer be available for new calls."
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>
              {t("Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!removeTarget || Boolean(busyId)}
              tone="destructive"
              onClick={() => {
                const target = removeTarget
                setRemoveTarget(null)
                if (target) void remove(target)
              }}
            >
              {t("Remove server")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet
        dismissible={!saving}
        side="right"
        open={open}
        onOpenChange={(value) => {
          if (saving) return
          setOpen(value)
          if (!value) {
            setEditingServer(null)
            setDialogError("")
            resetIconSelection()
            setForm(emptyForm)
          }
        }}
      >
        <Sheet.Content className="w-[min(40rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header>
            <Sheet.Title>
              {editingServer ? t("Edit MCP server") : t("Add MCP server")}
            </Sheet.Title>
            <Sheet.Description>
              {t(
                "Connect a remote server and choose how its tools are available in your workspace."
              )}
            </Sheet.Description>
          </Sheet.Header>
          <form className="contents" onSubmit={save}>
            <fieldset disabled={saving} className="contents">
              <Sheet.Body className="flex flex-col gap-5">
                {dialogError && (
                  <Alert tone="destructive" variant="plain">
                    <Alert.Description>{t(dialogError)}</Alert.Description>
                  </Alert>
                )}
                <div className="flex flex-col gap-6">
                  <Frame variant="band">
                    <Frame.Header>
                      <Frame.Title>{t("Connection")}</Frame.Title>
                    </Frame.Header>
                    <Frame.Panel className="flex flex-col gap-5 p-4">
                      <Field>
                        <Field.Label>{t("Display name")}</Field.Label>
                        <Input
                          id="mcp-name"
                          value={form.name}
                          onChange={(event) =>
                            update("name", event.target.value)
                          }
                          placeholder="Linear tools"
                          required
                        />
                      </Field>
                      <Field>
                        <Field.Label>Logo</Field.Label>
                        <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-2">
                          <div className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-background p-1">
                            {iconPreview && !iconRemoved ? (
                              // Uploaded MCP icons are served by JustAI and do not need
                              // a Next Image host allowlist.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                alt={t("Selected MCP logo preview")}
                                className="size-full rounded-md object-contain"
                                src={resolveAPIURL(iconPreview)}
                              />
                            ) : (
                              <Plug
                                aria-hidden="true"
                                className="size-6 text-muted-foreground"
                              />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <Input
                              ref={iconInputRef}
                              id="mcp-icon"
                              type="file"
                              aria-label={t("Logo")}
                              className="sr-only"
                              accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
                              onChange={(event) =>
                                chooseIcon(event.target.files?.[0] ?? null)
                              }
                            />
                            <p className="truncate text-sm font-medium">
                              {iconFile?.name ??
                                (iconPreview && !iconRemoved
                                  ? t("Current logo")
                                  : t("No logo selected"))}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t(
                                "PNG, JPEG, GIF, WebP, or ICO · Max 2 MB · optimized on upload"
                              )}
                            </p>
                            <div className="flex flex-wrap gap-2 pt-1">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => iconInputRef.current?.click()}
                              >
                                <ImagePlus
                                  data-icon="inline-start"
                                  aria-hidden="true"
                                />
                                {iconPreview && !iconRemoved
                                  ? t("Replace logo")
                                  : t("Choose logo")}
                              </Button>
                              {((iconPreview && !iconRemoved) ||
                                (editingServer?.iconUrl && !iconRemoved)) && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    resetIconSelection()
                                    setIconRemoved(Boolean(editingServer))
                                  }}
                                >
                                  <X
                                    data-icon="inline-start"
                                    aria-hidden="true"
                                  />
                                  {t("Remove logo")}
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </Field>
                      <Field>
                        <Field.Label>{t("Endpoint URL")}</Field.Label>
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
                        <Field.Description>
                          {t(
                            "Paste the remote MCP URL provided by your service."
                          )}
                        </Field.Description>
                      </Field>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field>
                          <Field.Label>{t("Authentication")}</Field.Label>
                          <Select
                            items={{
                              none: t("No auth"),
                              api_key: t("Bearer token"),
                              litellm: t("LiteLLM API key"),
                              oauth: "OAuth 2.1",
                            }}
                            value={form.authType}
                            onValueChange={(value) =>
                              update("authType", value ?? "none")
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="none">
                                  {t("No auth")}
                                </SelectItem>
                                <SelectItem value="api_key">
                                  {t("Bearer token")}
                                </SelectItem>
                                <SelectItem value="litellm">
                                  {t("LiteLLM API key")}
                                </SelectItem>
                                <SelectItem value="oauth">OAuth 2.1</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {form.authType === "litellm" && (
                            <Field.Description>
                              {t(
                                "Enter the LiteLLM key without Bearer. Sent as x-litellm-api-key: Bearer <key>."
                              )}
                            </Field.Description>
                          )}
                          {(form.authType === "none" ||
                            form.authType === "oauth") && (
                            <Field.Description>
                              {form.authType === "none"
                                ? t("No credential is sent to this server.")
                                : t(
                                    "Sign in with the provider after saving; JustAI manages the access and refresh tokens."
                                  )}
                            </Field.Description>
                          )}
                        </Field>
                        <Field>
                          <Field.Label>{t("Visibility")}</Field.Label>
                          <Select
                            items={{
                              organization: t("Workspace"),
                              user: t("Only me"),
                            }}
                            value={form.scopeType}
                            onValueChange={(value) =>
                              update(
                                "scopeType",
                                value ??
                                  (canManageOrganization
                                    ? "organization"
                                    : "user")
                              )
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {canManageOrganization && (
                                  <SelectItem value="organization">
                                    {t("Workspace")}
                                  </SelectItem>
                                )}
                                <SelectItem value="user">
                                  {t("Only me")}
                                </SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                      {form.authType !== "none" && (
                        <Field>
                          <Field.Label>
                            {form.authType === "oauth"
                              ? t("Access token (optional)")
                              : form.authType === "litellm"
                                ? t("LiteLLM API key")
                                : t("Bearer token")}
                          </Field.Label>
                          <Input
                            id="mcp-credential"
                            type="password"
                            value={form.credential}
                            onChange={(event) =>
                              update("credential", event.target.value)
                            }
                            placeholder={
                              form.authType === "oauth"
                                ? t("Leave blank to authorize after saving")
                                : t("Paste the token from your MCP provider")
                            }
                            autoComplete="off"
                          />
                          <Field.Description>
                            {form.authType === "oauth"
                              ? editingServer
                                ? t(
                                    "Leave blank to keep the stored token, or authorize again after saving."
                                  )
                                : t("Leave blank to authorize after saving.")
                              : editingServer
                                ? t("Leave blank to keep the stored token.")
                                : t("Stored encrypted by JustAI.")}
                          </Field.Description>
                        </Field>
                      )}
                    </Frame.Panel>
                  </Frame>
                  <Frame variant="band">
                    <Frame.Header>
                      <Frame.Title>{t("Tool access")}</Frame.Title>
                    </Frame.Header>
                    <Frame.Panel className="flex flex-col gap-5 p-4">
                      <Field>
                        <Field.Label>
                          {t("Allowed tools (optional)")}
                        </Field.Label>
                        <Input
                          id="mcp-tools"
                          value={form.allowedTools}
                          onChange={(event) =>
                            update("allowedTools", event.target.value)
                          }
                          placeholder="search, create_issue"
                        />
                        <Field.Description>
                          {t(
                            "Enter tool names separated by commas. Leave empty to allow all tools under the approval policy."
                          )}
                        </Field.Description>
                      </Field>
                      <Frame.Row className="px-0">
                        <Frame.Content>
                          <Frame.Title as="p">
                            {t("Available automatically")}
                          </Frame.Title>
                          <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                            {t(
                              "Suggest relevant tools in chats. Calls still require approval."
                            )}
                          </Frame.Description>
                        </Frame.Content>
                        <Frame.Actions>
                          <Switch
                            aria-label={t("Available automatically")}
                            checked={form.autoDiscover}
                            onCheckedChange={(checked) =>
                              update("autoDiscover", checked)
                            }
                          />
                        </Frame.Actions>
                      </Frame.Row>
                    </Frame.Panel>
                  </Frame>
                  {form.authType === "oauth" && (
                    <Collapsible>
                      <Frame variant="plain">
                        <Frame.Header>
                          <Frame.Title>{t("OAuth overrides")}</Frame.Title>
                          <Frame.Description>
                            {t(
                              "Usually discovered automatically. Change only when your provider requires it."
                            )}
                          </Frame.Description>
                          <Frame.Action>
                            <CollapsibleTrigger
                              aria-label={t("OAuth overrides")}
                              render={<Button variant="ghost" size="sm" />}
                            >
                              <ChevronDown className="size-4" />
                            </CollapsibleTrigger>
                          </Frame.Action>
                        </Frame.Header>
                      </Frame>
                      <CollapsibleContent>
                        <Frame>
                          <Frame.Panel className="grid gap-4 p-4 sm:grid-cols-2">
                            <Field>
                              <Field.Label>
                                {t("Authorization URL")}
                              </Field.Label>
                              <Input
                                id="mcp-oauth-authorize"
                                type="url"
                                value={form.oauthAuthorizationUrl}
                                onChange={(event) =>
                                  update(
                                    "oauthAuthorizationUrl",
                                    event.target.value
                                  )
                                }
                                placeholder={t(
                                  "Auto-discovered from the server"
                                )}
                              />
                            </Field>
                            <Field>
                              <Field.Label>{t("Token URL")}</Field.Label>
                              <Input
                                id="mcp-oauth-token"
                                type="url"
                                value={form.oauthTokenUrl}
                                onChange={(event) =>
                                  update("oauthTokenUrl", event.target.value)
                                }
                                placeholder={t(
                                  "Auto-discovered from the server"
                                )}
                              />
                            </Field>
                            <Field>
                              <Field.Label>{t("Client ID")}</Field.Label>
                              <Input
                                id="mcp-oauth-client"
                                value={form.oauthClientId}
                                onChange={(event) =>
                                  update("oauthClientId", event.target.value)
                                }
                                placeholder="public-client-id"
                              />
                            </Field>
                            <Field>
                              <Field.Label>{t("Scopes")}</Field.Label>
                              <Input
                                id="mcp-oauth-scopes"
                                value={form.oauthScopes}
                                onChange={(event) =>
                                  update("oauthScopes", event.target.value)
                                }
                                placeholder="openid tools"
                              />
                            </Field>
                            <p className="text-xs text-muted-foreground sm:col-span-2">
                              {t(
                                "Only fill these in if automatic sign-in setup fails."
                              )}
                            </p>
                          </Frame.Panel>
                        </Frame>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              </Sheet.Body>
            </fieldset>
            <Sheet.Footer className="sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setOpen(false)
                  resetIconSelection()
                  setEditingServer(null)
                }}
              >
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                    {t("Saving…")}
                  </>
                ) : editingServer ? (
                  t("Save changes")
                ) : (
                  t("Connect server")
                )}
              </Button>
            </Sheet.Footer>
          </form>
        </Sheet.Content>
      </Sheet>
    </div>
  )
}
