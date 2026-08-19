"use client"
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Activity,
  Archive,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Ban,
  CheckCircle2,
  Database,
  Globe2,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Megaphone,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  TestTube2,
  UsersRound,
  Wrench,
  X,
} from "lucide-react"

import { APIError, api, resolveAPIURL } from "@/lib/api"
import type {
  AdminAnalyticsResponse,
  AdminDashboardResponse,
  AdminTab,
  Endpoint,
  MCPServer,
  PlatformSettings,
  User,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { notifyError, notifySuccess } from "@/lib/feedback"
import { PlatformAdminDashboard } from "@/components/platform-admin-dashboard"
import { AdminUsageCharts, compactNumber } from "@/components/admin-usage-charts"
import { EndpointsView } from "@/components/endpoints-view"
import { PlatformAnnouncementsView } from "@/components/platform-announcements-view"
import { PlatformAuthenticationView } from "@/components/platform-authentication-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const tabs: Array<{ id: AdminTab; label: string; icon: typeof ShieldCheck }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "workspaces", label: "Workspaces", icon: Network },
  { id: "endpoints", label: "Endpoints", icon: Globe2 },
  { id: "mcp", label: "MCP", icon: Wrench },
  { id: "controls", label: "Platform controls", icon: ShieldCheck },
  { id: "authentication", label: "Authentication", icon: KeyRound },
  { id: "announcements", label: "Announcements", icon: Megaphone },
  { id: "health", label: "Health", icon: Database },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "audit", label: "Audit", icon: KeyRound },
]

const tabGroups: Array<{ label: string; ids: AdminTab[] }> = [
  { label: "Overview", ids: ["overview"] },
  { label: "Operations", ids: ["users", "workspaces", "endpoints", "mcp"] },
  {
    label: "Configuration",
    ids: ["controls", "authentication", "announcements"],
  },
  { label: "Observability", ids: ["health", "analytics", "audit"] },
]

function settingLabel(key: string) {
  return key
    .replace(/Enabled$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase())
}

function isRequestAborted(caught: unknown) {
  return caught instanceof APIError && caught.code === "request_aborted"
}

type PlatformControlKey = Exclude<
  keyof PlatformSettings,
  "maintenanceMessage" | "updatedAt"
>

type PlatformAdminShellProps = {
  activeTab: AdminTab
  onTabChange: (tab: AdminTab) => void
  user: User
}

const emptySettings: PlatformSettings = {
  loginEnabled: true,
  localAuthEnabled: true,
  signupEnabled: true,
  aiEnabled: true,
  voiceEnabled: true,
  transcriptionEnabled: true,
  mcpEnabled: true,
  knowledgeEnabled: true,
  attachmentsEnabled: true,
  maintenanceMessage: "",
}

export function PlatformAdminShell({
  activeTab,
  onTabChange,
  user,
}: PlatformAdminShellProps) {
  const [error, setError] = useState("")
  const [settings, setSettings] = useState<PlatformSettings>(emptySettings)
  const [dashboard, setDashboard] = useState<AdminDashboardResponse | null>(
    null
  )
  const [users, setUsers] = useState<any[]>([])
  const [workspaces, setWorkspaces] = useState<any[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [servers, setServers] = useState<any[]>([])
  const [health, setHealth] = useState<Record<string, any> | null>(null)
  const [audit, setAudit] = useState<any[]>([])
  const [analytics, setAnalytics] = useState<AdminAnalyticsResponse | null>(
    null
  )
  const [query, setQuery] = useState("")
  const [listStatus, setListStatus] = useState("")
  const [listPage, setListPage] = useState(1)
  const [listTotal, setListTotal] = useState(0)
  const [auditFilters, setAuditFilters] = useState<Record<string, string>>({
    search: "",
    action: "",
    resourceType: "",
    actorId: "",
    organizationId: "",
    from: "",
    to: "",
  })
  const [analyticsFilters, setAnalyticsFilters] = useState<
    Record<string, string>
  >({
    days: "30",
    from: "",
    to: "",
    organizationId: "",
    endpointId: "",
    model: "",
    status: "",
  })
  const [savingMaintenance, setSavingMaintenance] = useState(false)
  const [savingControl, setSavingControl] = useState<PlatformControlKey | null>(
    null
  )
  const [endpointCreateRequest, setEndpointCreateRequest] = useState(0)
  const [mcpCreateRequest, setMcpCreateRequest] = useState(0)
  const [authenticationCreateRequest, setAuthenticationCreateRequest] =
    useState(0)
  const [announcementCreateRequest, setAnnouncementCreateRequest] =
    useState(0)

  const load = useCallback(async () => {
    setError("")
    try {
      if (activeTab === "overview") {
        const result = await api.get<AdminDashboardResponse>(
          "/api/v1/admin/dashboard?days=30"
        )
        setDashboard(result)
        setSettings(result.settings)
      } else if (activeTab === "controls") {
        setSettings(await api.get<PlatformSettings>("/api/v1/admin/settings"))
      } else if (activeTab === "users") {
        const result = await api.get<{ users: any[] }>(
          `/api/v1/admin/users?query=${encodeURIComponent(query)}&status=${encodeURIComponent(listStatus)}&page=${listPage}&pageSize=25`
        )
        setUsers(result.users)
        setListTotal(Number((result as any).total ?? 0))
      } else if (activeTab === "workspaces") {
        const result = await api.get<{ organizations: any[] }>(
          `/api/v1/admin/organizations?query=${encodeURIComponent(query)}&status=${encodeURIComponent(listStatus)}&page=${listPage}&pageSize=25`
        )
        setWorkspaces(result.organizations)
        setListTotal(Number((result as any).total ?? 0))
      } else if (activeTab === "endpoints") {
        const result = await api.get<{ endpoints: any[] }>(
          "/api/v1/admin/endpoints"
        )
        setEndpoints(result.endpoints)
      } else if (activeTab === "mcp") {
        const result = await api.get<{ servers: any[] }>(
          "/api/v1/admin/mcp/servers"
        )
        setServers(result.servers)
      } else if (activeTab === "health") {
        setHealth(await api.get<Record<string, any>>("/api/v1/admin/health"))
      } else if (activeTab === "analytics") {
        const params = new URLSearchParams()
        Object.entries(analyticsFilters).forEach(([key, value]) => {
          if (value) params.set(key, value)
        })
        setAnalytics(
          await api.get<AdminAnalyticsResponse>(
            `/api/v1/admin/analytics?${params.toString()}`
          )
        )
      } else if (activeTab === "audit") {
        const params = new URLSearchParams({
          page: String(listPage),
          pageSize: "25",
        })
        Object.entries(auditFilters).forEach(([key, value]) => {
          if (value) params.set(key, value)
        })
        const result = await api.get<{ events: any[]; total?: number }>(
          `/api/v1/admin/audit?${params.toString()}`
        )
        setAudit(result.events)
        setListTotal(Number(result.total ?? 0))
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Admin data could not be loaded."
      )
    }
  }, [activeTab, analyticsFilters, auditFilters, listPage, listStatus, query])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  async function saveMaintenanceMessage() {
    setSavingMaintenance(true)
    setError("")
    try {
      const result = await api.put<PlatformSettings>(
        "/api/v1/admin/settings",
        { maintenanceMessage: settings.maintenanceMessage }
      )
      setSettings(result)
      notifySuccess("Maintenance message saved")
    } catch (caught) {
      setError(notifyError("Maintenance message could not be saved", caught, "Platform settings could not be saved."))
    } finally {
      setSavingMaintenance(false)
    }
  }

  async function updateSetting(
    key: PlatformControlKey,
    value: boolean
  ) {
    const previousValue = settings[key]
    setSettings((current) => ({ ...current, [key]: value }))
    setSavingControl(key)
    setError("")
    try {
      const result = await api.put<PlatformSettings>("/api/v1/admin/settings", {
        [key]: value,
      })
      setSettings((current) => ({
        ...result,
        maintenanceMessage: current.maintenanceMessage,
      }))
      notifySuccess(`${settingLabel(key)} ${value ? "enabled" : "disabled"}`)
    } catch (caught) {
      setSettings((current) => ({ ...current, [key]: previousValue }))
      setError(notifyError("Platform control could not be updated", caught, "The control could not be updated."))
    } finally {
      setSavingControl(null)
    }
  }

  async function updateUser(id: string, patch: Record<string, unknown>) {
    setError("")
    try {
      await api.patch(`/api/v1/admin/users/${id}`, patch)
      notifySuccess("User updated")
      await load()
    } catch (caught) {
      setError(notifyError("User could not be updated", caught, "User could not be updated."))
    }
  }

  async function updateWorkspace(id: string, patch: Record<string, unknown>) {
    setError("")
    try {
      await api.patch(`/api/v1/admin/organizations/${id}`, patch)
      notifySuccess("Workspace updated")
      await load()
    } catch (caught) {
      setError(notifyError("Workspace could not be updated", caught, "Workspace could not be updated."))
    }
  }

  const title = useMemo(
    () => tabs.find((tab) => tab.id === activeTab)?.label ?? "Overview",
    [activeTab]
  )

  const pageAction =
    activeTab === "endpoints" ? (
      <Button onClick={() => setEndpointCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" /> Add endpoint
      </Button>
    ) : activeTab === "mcp" ? (
      <Button onClick={() => setMcpCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" /> Add MCP server
      </Button>
    ) : activeTab === "authentication" ? (
      <Button
        onClick={() =>
          setAuthenticationCreateRequest((value) => value + 1)
        }
      >
        <Plus data-icon="inline-start" aria-hidden="true" /> Add provider
      </Button>
    ) : activeTab === "announcements" ? (
      <Button
        onClick={() => setAnnouncementCreateRequest((value) => value + 1)}
      >
        <Plus data-icon="inline-start" aria-hidden="true" /> Add announcement
      </Button>
    ) : null

  if (!user.platformAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-12">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Platform administrator access required</AlertTitle>
          <AlertDescription>
            This area is restricted to platform administrators.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[0.65rem] font-medium tracking-[0.24em] text-muted-foreground uppercase">
            Platform administration
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Global controls for JustAI users, workspaces, integrations, and
            reliability.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {pageAction}
          <Button
            aria-label="Refresh admin data"
            onClick={() => void load()}
            variant="outline"
            size="sm"
          >
            <RefreshCw data-icon="inline-start" /> Refresh
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-start">
        <nav
          aria-label="Platform administration"
          className="flex gap-4 overflow-x-auto rounded-xl border bg-card p-2 lg:sticky lg:top-4 lg:flex-col lg:gap-5"
        >
          {tabGroups.map((group) => (
            <div className="flex min-w-max flex-col gap-1 lg:min-w-0" key={group.label}>
              <p className="px-2 text-[0.65rem] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                {group.label}
              </p>
              <div className="flex gap-1 lg:flex-col">
                {group.ids.map((id) => {
                  const tab = tabs.find((candidate) => candidate.id === id)
                  if (!tab) return null
                  const Icon = tab.icon
                  return (
                    <button
                      aria-current={tab.id === activeTab ? "page" : undefined}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                        tab.id === activeTab &&
                          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                      )}
                      key={tab.id}
                      onClick={() => {
                        setListPage(1)
                        setListStatus("")
                        onTabChange(tab.id)
                      }}
                      type="button"
                    >
                      <Icon className="size-3.5 shrink-0" /> {tab.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="min-w-0">
          {error && (
            <Alert className="mb-4" variant="destructive">
              <AlertTriangle />
              <AlertTitle>Admin request failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

      {activeTab === "overview" && (
        <PlatformAdminDashboard dashboard={dashboard} onTabChange={onTabChange} />
      )}
      {activeTab === "controls" && (
        <ControlsView
          settings={settings}
          savingMaintenance={savingMaintenance}
          savingControl={savingControl}
          onChange={setSettings}
          onToggle={(key, value) => void updateSetting(key, value)}
          onSave={() => void saveMaintenanceMessage()}
        />
      )}
      {activeTab === "authentication" && (
        <PlatformAuthenticationView createRequest={authenticationCreateRequest} />
      )}
      {activeTab === "announcements" && (
        <PlatformAnnouncementsView createRequest={announcementCreateRequest} />
      )}
      {(activeTab === "users" || activeTab === "workspaces") && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-md">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                onChange={(event) => {
                  setListPage(1)
                  setQuery(event.target.value)
                }}
                placeholder={`Search ${activeTab}…`}
                value={query}
              />
            </div>
            <Select
              value={listStatus || "all"}
              onValueChange={(value) => {
                setListPage(1)
                const nextValue = value ?? "all"
                setListStatus(nextValue === "all" ? "" : nextValue)
              }}
            >
              <SelectTrigger
                aria-label={`${activeTab} status`}
                className="h-9 w-48"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  {activeTab === "users" ? (
                    <SelectItem value="suspended">Suspended</SelectItem>
                  ) : (
                    <>
                      <SelectItem value="archived">Archived</SelectItem>
                      <SelectItem value="suspended">Suspended</SelectItem>
                    </>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {activeTab === "users" ? (
            <UsersView
              users={users}
              onUpdate={updateUser}
              onReload={() => void load()}
              page={listPage}
              pageSize={25}
              total={listTotal}
              onPageChange={setListPage}
            />
          ) : (
            <WorkspacesView
              workspaces={workspaces}
              onUpdate={updateWorkspace}
              onReload={() => void load()}
              page={listPage}
              pageSize={25}
              total={listTotal}
              onPageChange={setListPage}
            />
          )}
        </div>
      )}
      {activeTab === "endpoints" && (
        <EndpointsView
          endpoints={endpoints}
          onChange={setEndpoints}
          platformAdmin
          userId={user.id}
          apiBasePath="/api/v1/admin/endpoints"
          defaultScopeType="global"
          createRequest={endpointCreateRequest}
        />
      )}
      {activeTab === "mcp" && (
        <InventoryView
          title="Global and scoped MCP servers"
          items={servers}
          kind="mcp"
          onRefresh={() => void load()}
          createRequest={mcpCreateRequest}
        />
      )}
      {activeTab === "health" && <HealthView health={health} />}
      {activeTab === "analytics" && (
        <AnalyticsView
          analytics={analytics}
          filters={analyticsFilters}
          onFiltersChange={setAnalyticsFilters}
          onRefresh={() => void load()}
        />
      )}
      {activeTab === "audit" && (
        <AuditView
          events={audit}
          page={listPage}
          pageSize={25}
          total={listTotal}
          filters={auditFilters}
          onFiltersChange={(next) => {
            setListPage(1)
            setAuditFilters(next)
          }}
          onPageChange={setListPage}
        />
      )}
        </div>
      </div>
    </div>
  )
}

function ControlsView({
  settings,
  savingMaintenance,
  savingControl,
  onChange,
  onToggle,
  onSave,
}: {
  settings: PlatformSettings
  savingMaintenance: boolean
  savingControl: PlatformControlKey | null
  onChange: (settings: PlatformSettings) => void
  onToggle: (
    key: PlatformControlKey,
    value: boolean
  ) => void
  onSave: () => void
}) {
  const controls: Array<[PlatformControlKey, string, string]> = [
    ["loginEnabled", "Login", "Allow existing users to sign in."],
    [
      "localAuthEnabled",
      "Local password auth",
      "Allow password login and password account creation.",
    ],
    ["signupEnabled", "Signup", "Allow new password and OIDC provisioning."],
    ["aiEnabled", "AI chat", "Allow model requests and text chat."],
    ["voiceEnabled", "Voice", "Allow realtime voice and speech synthesis."],
    [
      "transcriptionEnabled",
      "Transcription",
      "Allow rooms, capture, and processing.",
    ],
    ["mcpEnabled", "MCP", "Allow MCP discovery, attachment, and execution."],
    [
      "knowledgeEnabled",
      "Knowledge",
      "Allow source upload, indexing, and retrieval.",
    ],
    [
      "attachmentsEnabled",
      "Attachments",
      "Allow file, URL, and text attachments.",
    ],
  ]
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Platform controls</CardTitle>
          <CardDescription>
            Switches are saved as soon as they change. Existing sessions remain
            valid when login is disabled.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {controls.map(([key, label, description]) => (
            <div
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
              key={key}
            >
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {savingControl === key && (
                  <span className="text-[11px] text-muted-foreground">Saving…</span>
                )}
                <Switch
                  aria-label={label}
                  checked={Boolean(settings[key])}
                  disabled={savingControl !== null}
                  onCheckedChange={(checked) => onToggle(key, checked)}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Maintenance message</CardTitle>
          <CardDescription>
            Shown with a 503 response while a capability is disabled.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            onChange={(event) =>
              onChange({ ...settings, maintenanceMessage: event.target.value })
            }
            placeholder="We’re performing maintenance…"
            value={settings.maintenanceMessage}
          />
          <Button disabled={savingMaintenance} onClick={onSave}>
            {savingMaintenance ? "Saving…" : "Save maintenance message"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (pageCount <= 1) return null
  return (
    <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
      <span>
        Page {page} of {pageCount} · {total} total
      </span>
      <div className="flex gap-1">
        <Button
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          size="sm"
          variant="outline"
        >
          Previous
        </Button>
        <Button
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          size="sm"
          variant="outline"
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function UsersView({
  users,
  onUpdate,
  onReload,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  users: any[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  onReload: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const [detail, setDetail] = useState<any | null>(null)
  const [actionError, setActionError] = useState("")
  const [loadingDetail, setLoadingDetail] = useState(false)

  async function showDetail(id: string) {
    setLoadingDetail(true)
    setActionError("")
    try {
      const result = await api.get<{ user: any; organizations: any[] }>(
        `/api/v1/admin/users/${id}`
      )
      setDetail(result)
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "User details could not be loaded."
      )
    } finally {
      setLoadingDetail(false)
    }
  }

  async function deleteUser(item: any) {
    if (!window.confirm("Permanently delete this user?")) return
    setActionError("")
    try {
      const result = await api.get<{ organizations: any[] }>(
        `/api/v1/admin/users/${item.id}`
      )
      const owned = (result.organizations ?? []).filter(
        (organization) => organization.role === "owner"
      )
      const confirmation = window.prompt(
        owned.length > 0
          ? `Type DELETE to remove ${item.displayName} and permanently delete ${owned.length} owned workspace(s).`
          : `Type DELETE to permanently remove ${item.displayName}.`
      )
      if (confirmation !== "DELETE") return
      await api.delete(`/api/v1/admin/users/${item.id}`, {
        confirm: true,
        deleteOrganizationIds: owned.map((organization) => organization.id),
      })
      setDetail(null)
      onReload()
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "User could not be deleted."
      )
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Search, inspect, suspend, revoke sessions, and manage platform
            administrator access.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 overflow-x-auto">
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">User</th>
                <th className="p-2">Status</th>
                <th className="p-2">Access</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr className="border-b last:border-0" key={item.id}>
                  <td className="p-2">
                    <button
                      className="text-left hover:underline"
                      onClick={() => void showDetail(item.id)}
                      type="button"
                    >
                      <div className="font-medium">{item.displayName}</div>
                      <div className="text-muted-foreground">{item.email}</div>
                    </button>
                  </td>
                  <td className="p-2">
                    <Badge
                      variant={
                        item.status === "suspended" ? "destructive" : "default"
                      }
                    >
                      {item.status ?? "active"}
                    </Badge>
                  </td>
                  <td className="p-2">
                    {item.platformAdmin ? (
                      <Badge>
                        <ShieldCheck data-icon="inline-start" /> platform admin
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">standard</span>
                    )}
                  </td>
                  <td className="p-2">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              aria-label={`Actions for ${item.displayName}`}
                              size="icon-sm"
                              variant="ghost"
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onClick={() => void showDetail(item.id)}
                            >
                              <Search aria-hidden="true" /> Details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                void onUpdate(item.id, {
                                  status:
                                    item.status === "suspended"
                                      ? "active"
                                      : "suspended",
                                })
                              }
                            >
                              {item.status === "suspended" ? (
                                <RotateCcw aria-hidden="true" />
                              ) : (
                                <Ban aria-hidden="true" />
                              )}
                              {item.status === "suspended"
                                ? "Unsuspend"
                                : "Suspend"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                void onUpdate(item.id, {
                                  platformAdmin: !item.platformAdmin,
                                })
                              }
                            >
                              <ShieldCheck aria-hidden="true" />
                              {item.platformAdmin
                                ? "Demote admin"
                                : "Promote admin"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={async () => {
                                if (
                                  !window.confirm(
                                    "Revoke every active session for this user?"
                                  )
                                )
                                  return
                                try {
                                  await api.post(
                                    `/api/v1/admin/users/${item.id}/revoke-sessions`
                                  )
                                  onReload()
                                } catch (caught) {
                                  setActionError(
                                    caught instanceof Error
                                      ? caught.message
                                      : "Sessions could not be revoked."
                                  )
                                }
                              }}
                            >
                              <RefreshCw aria-hidden="true" /> Revoke sessions
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => void deleteUser(item)}
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" /> Delete user
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No users match this search.
            </p>
          )}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
          />
        </CardContent>
      </Card>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {detail?.user?.displayName ?? "User details"}
            </DialogTitle>
            <DialogDescription>{detail?.user?.email}</DialogDescription>
          </DialogHeader>
          {loadingDetail ? (
            <p className="text-sm text-muted-foreground">
              Loading user details…
            </p>
          ) : detail ? (
            <div className="flex flex-col gap-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    detail.user.status === "suspended"
                      ? "destructive"
                      : "default"
                  }
                >
                  {detail.user.status ?? "active"}
                </Badge>
                {detail.user.platformAdmin && <Badge>platform admin</Badge>}
              </div>
              <div>
                <p className="font-medium">Workspaces</p>
                <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                  {(detail.organizations ?? []).map((organization: any) => (
                    <div
                      className="flex items-center justify-between rounded-md border px-2 py-1.5"
                      key={organization.id}
                    >
                      <span>{organization.name}</span>
                      <span>
                        {organization.role} · {organization.status}
                      </span>
                    </div>
                  ))}
                  {detail.organizations?.length === 0 && <span>None</span>}
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            {detail?.user && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  <MoreHorizontal data-icon="inline-start" /> Actions
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() =>
                        void onUpdate(detail.user.id, {
                          status:
                            detail.user.status === "suspended"
                              ? "active"
                              : "suspended",
                        })
                      }
                    >
                      {detail.user.status === "suspended" ? (
                        <RotateCcw aria-hidden="true" />
                      ) : (
                        <Ban aria-hidden="true" />
                      )}
                      {detail.user.status === "suspended"
                        ? "Unsuspend"
                        : "Suspend"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void onUpdate(detail.user.id, {
                          platformAdmin: !detail.user.platformAdmin,
                        })
                      }
                    >
                      <ShieldCheck aria-hidden="true" />
                      {detail.user.platformAdmin
                        ? "Demote admin"
                        : "Promote admin"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "Revoke every active session for this user?"
                          )
                        )
                          return
                        try {
                          await api.post(
                            `/api/v1/admin/users/${detail.user.id}/revoke-sessions`
                          )
                          onReload()
                        } catch (caught) {
                          setActionError(
                            caught instanceof Error
                              ? caught.message
                              : "Sessions could not be revoked."
                          )
                        }
                      }}
                    >
                      <RefreshCw aria-hidden="true" /> Revoke sessions
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => void deleteUser(detail.user)}
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" /> Delete user
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function WorkspacesView({
  workspaces,
  onUpdate,
  onReload,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  workspaces: any[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  onReload: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const [detail, setDetail] = useState<any | null>(null)
  const [actionError, setActionError] = useState("")

  async function showDetail(id: string) {
    setActionError("")
    try {
      setDetail(await api.get(`/api/v1/admin/organizations/${id}`))
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "Workspace details could not be loaded."
      )
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>
            Archive, suspend, inspect, transfer, or delete organization-owned
            resources.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 overflow-x-auto">
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">Workspace</th>
                <th className="p-2">Members</th>
                <th className="p-2">Status</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((item) => (
                <tr className="border-b last:border-0" key={item.id}>
                  <td className="p-2">
                    <button
                      className="text-left hover:underline"
                      onClick={() => void showDetail(item.id)}
                      type="button"
                    >
                      <div className="font-medium">{item.name}</div>
                      <div className="text-muted-foreground">{item.slug}</div>
                    </button>
                  </td>
                  <td className="p-2">{item.members}</td>
                  <td className="p-2">
                    <Badge
                      variant={
                        item.status === "suspended"
                          ? "destructive"
                          : item.status === "archived"
                            ? "secondary"
                            : "default"
                      }
                    >
                      {item.status}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              aria-label={`Actions for ${item.name}`}
                              size="icon-sm"
                              variant="ghost"
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onClick={() => void showDetail(item.id)}
                            >
                              <Search aria-hidden="true" /> Details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                void onUpdate(item.id, {
                                  status:
                                    item.status === "archived"
                                      ? "active"
                                      : "archived",
                                })
                              }
                            >
                              {item.status === "archived" ? (
                                <RotateCcw aria-hidden="true" />
                              ) : (
                                <Archive aria-hidden="true" />
                              )}
                              {item.status === "archived"
                                ? "Restore"
                                : "Archive"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                void onUpdate(item.id, {
                                  status:
                                    item.status === "suspended"
                                      ? "active"
                                      : "suspended",
                                })
                              }
                            >
                              {item.status === "suspended" ? (
                                <RotateCcw aria-hidden="true" />
                              ) : (
                                <Ban aria-hidden="true" />
                              )}
                              {item.status === "suspended"
                                ? "Unsuspend"
                                : "Suspend"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={async () => {
                                const newOwnerId = window
                                  .prompt("Enter the new owner user ID")
                                  ?.trim()
                                if (!newOwnerId) return
                                try {
                                  await api.post(
                                    `/api/v1/admin/organizations/${item.id}/transfer-ownership`,
                                    { newOwnerId }
                                  )
                                  await onUpdate(item.id, {})
                                } catch (caught) {
                                  setActionError(
                                    caught instanceof Error
                                      ? caught.message
                                      : "Ownership could not be transferred."
                                  )
                                }
                              }}
                            >
                              <ArrowLeftRight aria-hidden="true" /> Transfer
                              ownership
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={async () => {
                              const confirmation = window.prompt(
                                `Type ${item.name} to permanently delete this workspace`
                              )
                              if (confirmation !== item.name) return
                              try {
                                await api.delete(
                                  `/api/v1/admin/organizations/${item.id}`,
                                  { confirmName: confirmation }
                                )
                                onReload()
                              } catch (caught) {
                                setActionError(
                                  caught instanceof Error
                                    ? caught.message
                                    : "Workspace could not be deleted."
                                )
                              }
                            }}
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" /> Delete workspace
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {workspaces.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No workspaces match this search.
            </p>
          )}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
          />
        </CardContent>
      </Card>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {detail?.organization?.name ?? "Workspace details"}
            </DialogTitle>
            <DialogDescription>{detail?.organization?.slug}</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge>{detail.organization.status}</Badge>
                <Badge variant="outline">
                  {detail.members?.length ?? 0} members
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <ResourceCount
                  label="Conversations"
                  value={detail.resources?.conversations}
                />
                <ResourceCount
                  label="Endpoints"
                  value={detail.resources?.endpoints}
                />
                <ResourceCount
                  label="MCP servers"
                  value={detail.resources?.mcpServers}
                />
                <ResourceCount
                  label="Knowledge sources"
                  value={detail.resources?.knowledgeSources}
                />
                <ResourceCount
                  label="Transcriptions"
                  value={detail.resources?.transcriptions}
                />
              </div>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                {(detail.members ?? []).map((member: any) => (
                  <div
                    className="flex items-center justify-between rounded-md border px-2 py-1.5"
                    key={member.id}
                  >
                    <span>
                      {member.displayName} · {member.email}
                    </span>
                    <span>{member.role}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setDetail(null)} variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ResourceCount({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">
        {typeof value === "number" ? value : "—"}
      </p>
    </div>
  )
}

type InventoryAction = {
  id: string
  label: string
  cancellable: boolean
  stoppedMessage: string
}

function InventoryView({
  title,
  items,
  kind,
  onRefresh,
  createRequest,
}: {
  title: string
  items: any[]
  kind: "endpoint" | "mcp"
  onRefresh: () => void
  createRequest?: number
}) {
  const [actionError, setActionError] = useState("")
  const [actionNotice, setActionNotice] = useState("")
  const [busyId, setBusyId] = useState("")
  const [activeAction, setActiveAction] = useState<InventoryAction | null>(null)
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState("")
  const [createIconFile, setCreateIconFile] = useState<File | null>(null)
  const [createIconPreview, setCreateIconPreview] = useState("")
  const [createValues, setCreateValues] = useState({
    name: "",
    providerType: "openai-compatible",
    baseUrl: "",
    chatModel: "",
    endpointUrl: "",
    authType: "none",
    credential: "",
    oauthAuthorizationUrl: "",
    oauthTokenUrl: "",
    oauthClientId: "",
    oauthScopes: "",
    scopeType: "global",
    scopeId: "",
  })
  const actionAbortRef = useRef<AbortController | null>(null)
  const createIconInputRef = useRef<HTMLInputElement | null>(null)
  const createIconObjectURLRef = useRef("")
  const createRequestRef = useRef(createRequest ?? 0)
  const resourceLabel = kind === "endpoint" ? "Endpoint" : "MCP server"

  const resetCreateIcon = useCallback(() => {
    if (createIconObjectURLRef.current) {
      URL.revokeObjectURL(createIconObjectURLRef.current)
      createIconObjectURLRef.current = ""
    }
    setCreateIconFile(null)
    setCreateIconPreview("")
    if (createIconInputRef.current) createIconInputRef.current.value = ""
  }, [])

  function chooseCreateIcon(file: File | null) {
    if (!file) return
    if (file.size > 512 * 1024) {
      setCreateError("MCP icons are limited to 512 KB.")
      if (createIconInputRef.current) createIconInputRef.current.value = ""
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
      setCreateError("Use a PNG, JPEG, GIF, WebP, or ICO image for the MCP logo.")
      if (createIconInputRef.current) createIconInputRef.current.value = ""
      return
    }
    if (createIconObjectURLRef.current) {
      URL.revokeObjectURL(createIconObjectURLRef.current)
    }
    createIconObjectURLRef.current = URL.createObjectURL(file)
    setCreateIconFile(file)
    setCreateIconPreview(createIconObjectURLRef.current)
    setCreateError("")
  }

  useEffect(() => {
    return () => {
      actionAbortRef.current?.abort()
      if (createIconObjectURLRef.current) {
        URL.revokeObjectURL(createIconObjectURLRef.current)
      }
    }
  }, [])

  async function runAction(
    id: string,
    actionDetails: Omit<InventoryAction, "id">,
    action: (signal: AbortSignal) => Promise<void>
  ) {
    const controller = new AbortController()
    actionAbortRef.current = controller
    setBusyId(id)
    setActionError("")
    setActionNotice("")
    setActiveAction({ id, ...actionDetails })
    setItemErrors((current) => ({ ...current, [id]: "" }))
    try {
      await action(controller.signal)
      notifySuccess(`${resourceLabel} action completed`)
      onRefresh()
    } catch (caught) {
      if (isRequestAborted(caught)) {
        setActionNotice(actionDetails.stoppedMessage)
        return
      }
      const message = notifyError(
        `${resourceLabel} action failed`,
        caught,
        "The action could not be completed."
      )
      setActionError(message)
      setItemErrors((current) => ({ ...current, [id]: message }))
    } finally {
      if (actionAbortRef.current === controller) actionAbortRef.current = null
      setActiveAction(null)
      setBusyId("")
    }
  }

  function stopActiveAction() {
    actionAbortRef.current?.abort()
  }

  function uploadCatalogIcon(itemId: string, file: File | null) {
    if (!file) return
    if (file.size > 512 * 1024) {
      setItemErrors((current) => ({
        ...current,
        [itemId]: "MCP icons are limited to 512 KB.",
      }))
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
      setItemErrors((current) => ({
        ...current,
        [itemId]: "Use a PNG, JPEG, GIF, WebP, or ICO image for the MCP logo.",
      }))
      return
    }
    const body = new FormData()
    body.set("icon", file)
    void runAction(
      itemId,
      {
        label: "Uploading logo…",
        cancellable: false,
        stoppedMessage: "MCP logo upload was stopped.",
      },
      async () => {
        await api.upload<MCPServer>(
          `/api/v1/admin/mcp/servers/${itemId}/icon`,
          body
        )
      }
    )
  }

  const resourcePath = kind === "endpoint" ? "endpoints" : "mcp/servers"
  async function createResource() {
    setCreateError("")
    const name = createValues.name.trim()
    const scopeId = createValues.scopeId.trim()
    if (!name) {
      setCreateError("A name is required.")
      return
    }
    if (createValues.scopeType !== "global" && !scopeId) {
      setCreateError("Enter the organization or user ID for this scope.")
      return
    }
    if (
      kind === "endpoint" &&
      (!createValues.baseUrl.trim() || !createValues.chatModel.trim())
    ) {
      setCreateError("An endpoint URL and chat model are required.")
      return
    }
    if (kind === "mcp" && !createValues.endpointUrl.trim()) {
      setCreateError("An MCP endpoint URL is required.")
      return
    }
    if (
      kind === "mcp" &&
      createValues.authType === "oauth" &&
      !createValues.oauthClientId.trim()
    ) {
      setCreateError("OAuth requires a client ID.")
      return
    }
    setCreateBusy(true)
    try {
      if (kind === "endpoint") {
        await api.post("/api/v1/admin/endpoints", {
          scopeType: createValues.scopeType,
          scopeId: createValues.scopeType === "global" ? null : scopeId,
          name,
          providerType: createValues.providerType,
          baseUrl: createValues.baseUrl.trim(),
          chatModel: createValues.chatModel.trim(),
          credential: createValues.credential,
          capabilities: { chat: true },
          enabled: true,
        })
      } else {
        const server = await api.post<MCPServer>("/api/v1/admin/mcp/servers", {
          scopeType: createValues.scopeType,
          scopeId: createValues.scopeType === "global" ? null : scopeId,
          name,
          endpointUrl: createValues.endpointUrl.trim(),
          authType: createValues.authType,
          credential: createValues.credential,
          oauthAuthorizationUrl: createValues.oauthAuthorizationUrl.trim(),
          oauthTokenUrl: createValues.oauthTokenUrl.trim(),
          oauthClientId: createValues.oauthClientId.trim(),
          oauthScopes: createValues.oauthScopes.trim(),
          enabled: true,
        })
        if (createIconFile) {
          const body = new FormData()
          body.set("icon", createIconFile)
          await api.upload<MCPServer>(
            `/api/v1/admin/mcp/servers/${server.id}/icon`,
            body
          )
        }
      }
      setCreateOpen(false)
      resetCreateIcon()
      setCreateValues((current) => ({
        ...current,
        name: "",
        baseUrl: "",
        chatModel: "",
        endpointUrl: "",
        credential: "",
        oauthAuthorizationUrl: "",
        oauthTokenUrl: "",
        oauthClientId: "",
        oauthScopes: "",
        scopeId: "",
      }))
      notifySuccess(`${resourceLabel} created`, `${name} is now in the catalog.`)
      onRefresh()
    } catch (caught) {
      setCreateError(
        notifyError(
          `${resourceLabel} could not be created`,
          caught,
          "The resource could not be created."
        )
      )
    } finally {
      setCreateBusy(false)
    }
  }

  const updateCreateValue = (key: keyof typeof createValues, value: string) =>
    setCreateValues((current) => ({ ...current, [key]: value }))
  const openCreate = useCallback(() => {
    setCreateError("")
    resetCreateIcon()
    setCreateOpen(true)
  }, [resetCreateIcon])

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              Shared catalog resources are visible to eligible workspaces and
              remain mutable here only.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 overflow-x-auto">
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {actionNotice && (
            <div
              aria-live="polite"
              className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              role="status"
            >
              {actionNotice}
            </div>
          )}
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">Name</th>
                <th className="p-2">Scope</th>
                <th className="p-2">Provider / URL</th>
                <th className="p-2">State</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const busy = busyId === item.id
                const rowAction =
                  activeAction?.id === item.id ? activeAction : null
                const itemError =
                  itemErrors[item.id] ||
                  (kind === "mcp" ? String(item.lastError || "") : "")
                const scopeLabel =
                  item.scopeType === "global"
                    ? "Platform"
                    : item.scopeType === "organization"
                      ? "Workspace"
                      : "Personal"
                return (
                  <tr className="border-b last:border-0" key={item.id}>
                    <td className="p-2 font-medium">
                      <div className="flex items-center gap-2">
                        {kind === "mcp" && item.iconUrl ? (
                          // MCP icons are served by JustAI, so Next Image does
                          // not need a host allowlist here.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            alt=""
                            className="size-5 rounded object-contain"
                            src={resolveAPIURL(item.iconUrl)}
                          />
                        ) : null}
                        <span>{item.name}</span>
                      </div>
                    </td>
                    <td className="p-2">
                      <Badge
                        variant={
                          item.scopeType === "global" ? "default" : "outline"
                        }
                      >
                        {scopeLabel}
                      </Badge>
                    </td>
                    <td className="max-w-xs truncate p-2 text-muted-foreground">
                      {kind === "endpoint"
                        ? `${item.providerType} · ${item.chatModel || "no chat model"}`
                        : item.endpointUrl}
                    </td>
                    <td className="p-2">
                      <Badge variant={item.enabled ? "default" : "destructive"}>
                        {item.enabled ? "enabled" : "disabled"}
                      </Badge>
                      {itemError && (
                        <p
                          aria-live="assertive"
                          className="mt-1 max-w-xs text-xs break-words text-destructive"
                          role="alert"
                        >
                          {itemError}
                        </p>
                      )}
                    </td>
                    <td className="p-2">
                      {kind === "mcp" && (
                        <input
                          aria-label={`Choose logo for ${item.name}`}
                          className="hidden"
                          id={`mcp-logo-${item.id}`}
                          type="file"
                          accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
                          onChange={(event) => {
                            const file = event.target.files?.[0] ?? null
                            event.currentTarget.value = ""
                            uploadCatalogIcon(item.id, file)
                          }}
                        />
                      )}
                      <div className="flex justify-end">
                        {busy ? (
                          <div className="flex items-center justify-end gap-2">
                            <div
                              aria-live="polite"
                              className="flex items-center gap-1.5 text-xs text-muted-foreground"
                              role="status"
                            >
                              <LoaderCircle
                                aria-hidden="true"
                                className="size-3.5 animate-spin"
                              />
                              <span>{rowAction?.label ?? "Working…"}</span>
                            </div>
                            {rowAction?.cancellable && (
                              <Button
                                aria-label={`Stop action for ${item.name}`}
                                onClick={stopActiveAction}
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                <Square
                                  data-icon="inline-start"
                                  aria-hidden="true"
                                />
                                Stop
                              </Button>
                            )}
                          </div>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  aria-label={`Actions for ${item.name}`}
                                  disabled={busy}
                                  size="icon-sm"
                                  variant="ghost"
                                />
                              }
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  disabled={busy}
                                  onClick={() =>
                                    void runAction(
                                      item.id,
                                      {
                                        label: item.enabled
                                          ? "Disabling…"
                                          : "Enabling…",
                                        cancellable: false,
                                        stoppedMessage: `${resourceLabel} update was stopped.`,
                                      },
                                      async () => {
                                        await api.patch(
                                          `/api/v1/admin/${resourcePath}/${item.id}`,
                                          { enabled: !item.enabled }
                                        )
                                      }
                                    )
                                  }
                                >
                                  {item.enabled ? (
                                    <Ban aria-hidden="true" />
                                  ) : (
                                    <CheckCircle2 aria-hidden="true" />
                                  )}
                                  {item.enabled ? "Disable" : "Enable"}
                                </DropdownMenuItem>
                                {kind === "endpoint" && (
                                  <DropdownMenuItem
                                    disabled={busy}
                                    onClick={() =>
                                      void runAction(
                                        item.id,
                                        {
                                          label: "Testing endpoint…",
                                          cancellable: true,
                                          stoppedMessage:
                                            "Endpoint test was stopped.",
                                        },
                                        async (signal) => {
                                          await api.post(
                                            `/api/v1/admin/endpoints/${item.id}/test`,
                                            {},
                                            { signal }
                                          )
                                        }
                                      )
                                    }
                                  >
                                    <TestTube2 aria-hidden="true" /> Test
                                    endpoint
                                  </DropdownMenuItem>
                                )}
                                {kind === "mcp" && (
                                  <>
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onClick={() =>
                                        void runAction(
                                          item.id,
                                          {
                                            label: "Testing connection…",
                                            cancellable: true,
                                            stoppedMessage: `${item.name} connection test was stopped.`,
                                          },
                                          async (signal) => {
                                            await api.post(
                                              `/api/v1/admin/mcp/servers/${item.id}/test`,
                                              undefined,
                                              { signal }
                                            )
                                          }
                                        )
                                      }
                                    >
                                      <TestTube2 aria-hidden="true" /> Test
                                      server
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onClick={() =>
                                        void runAction(
                                          item.id,
                                          {
                                            label: "Discovering tools…",
                                            cancellable: true,
                                            stoppedMessage: `${item.name} tool discovery was stopped.`,
                                          },
                                          async (signal) => {
                                            await api.get(
                                              `/api/v1/admin/mcp/servers/${item.id}/tools`,
                                              { signal }
                                            )
                                          }
                                        )
                                      }
                                    >
                                      <Wrench aria-hidden="true" /> Discover
                                      tools
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onClick={() =>
                                        document
                                          .getElementById(`mcp-logo-${item.id}`)
                                          ?.click()
                                      }
                                    >
                                      <ImagePlus aria-hidden="true" /> Set logo
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={busy}
                                variant="destructive"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Permanently delete this ${kind === "endpoint" ? "endpoint" : "MCP server"}: ${item.name}?`
                                    )
                                  )
                                    void runAction(
                                      item.id,
                                      {
                                        label: "Deleting…",
                                        cancellable: false,
                                        stoppedMessage: `${resourceLabel} deletion was stopped.`,
                                      },
                                      async () => {
                                        await api.delete(
                                          `/api/v1/admin/${resourcePath}/${item.id}`
                                        )
                                      }
                                    )
                                }}
                              >
                                <Trash2 aria-hidden="true" /> Delete{" "}
                                {kind === "endpoint"
                                  ? "endpoint"
                                  : "MCP server"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {items.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No resources found.
            </p>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && !createBusy) {
            resetCreateIcon()
            setCreateOpen(false)
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Add {kind === "endpoint" ? "endpoint" : "MCP server"}
            </DialogTitle>
            <DialogDescription>
              Register a resource in the shared platform catalog or assign it to
              a specific scope.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {createError && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            <label className="grid gap-1 text-sm">
              Name
              <Input
                value={createValues.name}
                onChange={(event) =>
                  updateCreateValue("name", event.target.value)
                }
                placeholder={
                  kind === "endpoint" ? "Production LLM" : "Knowledge tools"
                }
              />
            </label>
            {kind === "mcp" && (
              <label className="grid gap-1 text-sm">
                Logo (optional)
                <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-2">
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-background p-1">
                    {createIconPreview ? (
                      // Uploaded MCP icons are served by JustAI and do not need
                      // a Next Image host allowlist.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt="Selected MCP logo preview"
                        className="size-full rounded-md object-contain"
                        src={createIconPreview}
                      />
                    ) : (
                      <ImagePlus
                        aria-hidden="true"
                        className="size-6 text-muted-foreground"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <Input
                      ref={createIconInputRef}
                      type="file"
                      className="sr-only"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
                      onChange={(event) =>
                        chooseCreateIcon(event.target.files?.[0] ?? null)
                      }
                    />
                    <p className="truncate text-sm font-medium">
                      {createIconFile?.name ??
                        (createIconPreview ? "Logo selected" : "No logo selected")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      PNG, JPEG, GIF, WebP, or ICO · Max 512 KB
                    </p>
                    <div className="pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => createIconInputRef.current?.click()}
                      >
                        <ImagePlus data-icon="inline-start" aria-hidden="true" />
                        {createIconPreview ? "Replace logo" : "Choose logo"}
                      </Button>
                      {createIconPreview && (
                        <Button
                          className="ml-2"
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={resetCreateIcon}
                        >
                          <X data-icon="inline-start" aria-hidden="true" />
                          Remove logo
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </label>
            )}
            <div className="grid gap-1 text-sm">
              <span className="font-medium">Scope</span>
              <Select
                value={createValues.scopeType}
                onValueChange={(value) =>
                  updateCreateValue("scopeType", value ?? "global")
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="organization">Organization</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {createValues.scopeType !== "global" && (
              <label className="grid gap-1 text-sm">
                Scope ID
                <Input
                  value={createValues.scopeId}
                  onChange={(event) =>
                    updateCreateValue("scopeId", event.target.value)
                  }
                  placeholder="UUID"
                />
              </label>
            )}
            {kind === "endpoint" ? (
              <>
                <div className="grid gap-1 text-sm">
                  <span className="font-medium">Provider</span>
                  <Select
                    value={createValues.providerType}
                    onValueChange={(value) =>
                      updateCreateValue(
                        "providerType",
                        value ?? "openai-compatible"
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="openai-compatible">
                          OpenAI-compatible
                        </SelectItem>
                        <SelectItem value="openai">OpenAI</SelectItem>
                        <SelectItem value="gemini">Gemini</SelectItem>
                        <SelectItem value="anthropic">Anthropic</SelectItem>
                        <SelectItem value="ollama">Ollama</SelectItem>
                        <SelectItem value="mock">JustAI demo</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <label className="grid gap-1 text-sm">
                  Base URL
                  <Input
                    value={createValues.baseUrl}
                    onChange={(event) =>
                      updateCreateValue("baseUrl", event.target.value)
                    }
                    placeholder="https://gateway.example/v1"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Chat model
                  <Input
                    value={createValues.chatModel}
                    onChange={(event) =>
                      updateCreateValue("chatModel", event.target.value)
                    }
                    placeholder="model-name"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  API key or token
                  <Input
                    type="password"
                    value={createValues.credential}
                    onChange={(event) =>
                      updateCreateValue("credential", event.target.value)
                    }
                    placeholder="Stored encrypted on the backend"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="grid gap-1 text-sm">
                  MCP endpoint URL
                  <Input
                    value={createValues.endpointUrl}
                    onChange={(event) =>
                      updateCreateValue("endpointUrl", event.target.value)
                    }
                    placeholder="https://tools.example/mcp"
                  />
                </label>
                <div className="grid gap-1 text-sm">
                  <span className="font-medium">Authentication</span>
                  <Select
                    value={createValues.authType}
                    onValueChange={(value) =>
                      updateCreateValue("authType", value ?? "none")
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">No auth</SelectItem>
                        <SelectItem value="api_key">API key</SelectItem>
                        <SelectItem value="oauth">OAuth</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <label className="grid gap-1 text-sm">
                  Credential (optional)
                  <Input
                    type="password"
                    value={createValues.credential}
                    onChange={(event) =>
                      updateCreateValue("credential", event.target.value)
                    }
                    placeholder="Stored encrypted on the backend"
                  />
                </label>
                {createValues.authType === "oauth" && (
                  <>
                    <label className="grid gap-1 text-sm">
                      OAuth client ID
                      <Input
                        value={createValues.oauthClientId}
                        onChange={(event) =>
                          updateCreateValue("oauthClientId", event.target.value)
                        }
                        placeholder="Client ID"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      Authorization URL (optional)
                      <Input
                        value={createValues.oauthAuthorizationUrl}
                        onChange={(event) =>
                          updateCreateValue(
                            "oauthAuthorizationUrl",
                            event.target.value
                          )
                        }
                        placeholder="https://provider.example/authorize"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      Token URL (optional)
                      <Input
                        value={createValues.oauthTokenUrl}
                        onChange={(event) =>
                          updateCreateValue("oauthTokenUrl", event.target.value)
                        }
                        placeholder="https://provider.example/token"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      OAuth scopes (optional)
                      <Input
                        value={createValues.oauthScopes}
                        onChange={(event) =>
                          updateCreateValue("oauthScopes", event.target.value)
                        }
                        placeholder="tools.read tools.write"
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={createBusy}
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={createBusy} onClick={() => void createResource()}>
              {createBusy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type HealthState = "healthy" | "warning" | "down" | "unknown"

function healthState(value: any): HealthState {
  if (typeof value === "boolean") return value ? "healthy" : "down"
  if (!value || typeof value !== "object") return "unknown"

  const failures = Number(value.recentFailures ?? value.failures ?? 0)
  if (failures > 0) return "warning"
  if (typeof value.ok === "boolean") return value.ok ? "healthy" : "down"

  const signals = Object.values(value).filter(
    (item): item is boolean => typeof item === "boolean"
  )
  if (signals.length > 0) return signals.every(Boolean) ? "healthy" : "down"
  return "unknown"
}

function HealthStatusBadge({ state }: { state: HealthState }) {
  const Icon =
    state === "healthy"
      ? CheckCircle2
      : state === "unknown"
        ? Activity
        : AlertTriangle
  const label =
    state === "healthy"
      ? "Operational"
      : state === "warning"
        ? "Degraded"
        : state === "down"
          ? "Unavailable"
          : "Unknown"
  const variant =
    state === "healthy"
      ? "default"
      : state === "down"
        ? "destructive"
        : "outline"
  const className =
    state === "warning"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : undefined

  return (
    <Badge className={className} variant={variant}>
      <Icon data-icon="inline-start" />
      {label}
    </Badge>
  )
}

function HealthMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold tracking-tight">{value}</p>
      {detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      )}
    </div>
  )
}

function HealthPanel({
  title,
  description,
  icon: Icon,
  state,
  children,
}: {
  title: string
  description: string
  icon: typeof Activity
  state: HealthState
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
        <CardAction>
          <HealthStatusBadge state={state} />
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function HealthView({ health }: { health: Record<string, any> | null }) {
  if (!health) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Service health</CardTitle>
          <CardDescription>
            Runtime checks for the platform services and background workers.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Loading health checks…
        </CardContent>
      </Card>
    )
  }

  const database = health?.database ?? {}
  const providers = health?.providers ?? {}
  const mcp = health?.mcp ?? {}
  const workers = health?.workers ?? {}
  const providerFailures = Number(providers.recentFailures ?? 0)
  const mcpFailures = Number(mcp.failures ?? 0)
  const states = [
    healthState(database),
    healthState(providers),
    healthState(mcp),
    healthState(workers),
  ]
  const overallState = states.includes("down")
    ? "down"
    : states.includes("warning")
      ? "warning"
      : states.includes("unknown")
        ? "unknown"
        : "healthy"
  const checkedAt =
    typeof health?.checkedAt === "string" ? new Date(health.checkedAt) : null
  const checkedLabel =
    checkedAt && !Number.isNaN(checkedAt.getTime())
      ? checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null
  const enabledProviders = Number(providers.enabled ?? 0)
  const totalProviders = Number(providers.total ?? 0)
  const enabledMcp = Number(mcp.enabled ?? 0)
  const totalMcp = Number(mcp.total ?? 0)
  const workerEntries = [
    ["RAG worker", workers.rag],
    ["Transcription worker", workers.transcription],
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Service health</CardTitle>
            <CardDescription>
              Runtime checks for the platform services and background workers.
            </CardDescription>
          </div>
          <CardAction className="flex flex-col items-end gap-1.5">
            <HealthStatusBadge state={overallState} />
            {checkedLabel && (
              <span className="text-xs text-muted-foreground">
                Checked at {checkedLabel}
              </span>
            )}
          </CardAction>
        </CardHeader>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <HealthPanel
          description="PostgreSQL connectivity and readiness."
          icon={Database}
          state={healthState(database)}
          title="Database"
        >
          <HealthMetric
            detail="Primary application store"
            label="Connection"
            value={database.ok ? "Connected" : "Unavailable"}
          />
        </HealthPanel>
        <HealthPanel
          description="Configured model endpoints and recent request failures."
          icon={Globe2}
          state={healthState(providers)}
          title="Providers"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthMetric
              detail={`${totalProviders} configured`}
              label="Enabled"
              value={`${enabledProviders} / ${totalProviders}`}
            />
            <HealthMetric
              detail="Last hour"
              label="Recent failures"
              value={String(providerFailures)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description="Connected tool servers and MCP execution."
          icon={Wrench}
          state={healthState(mcp)}
          title="MCP"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthMetric
              detail={`${totalMcp} configured`}
              label="Enabled"
              value={`${enabledMcp} / ${totalMcp}`}
            />
            <HealthMetric
              detail="Across configured servers"
              label="Failures"
              value={String(mcpFailures)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description="Background jobs that keep retrieval and transcription moving."
          icon={Activity}
          state={healthState(workers)}
          title="Workers"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {workerEntries.map(([label, value]) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5"
                key={label}
              >
                <span className="text-sm">{label}</span>
                <Badge variant={value ? "default" : "destructive"}>
                  {value ? "Online" : "Offline"}
                </Badge>
              </div>
            ))}
          </div>
        </HealthPanel>
      </div>

      {(providerFailures > 0 || mcpFailures > 0) && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Recent service failures</AlertTitle>
          <AlertDescription>
            {providerFailures > 0 &&
              `${providerFailures} provider ${providerFailures === 1 ? "failure" : "failures"} recorded in the last hour.`}
            {providerFailures > 0 && mcpFailures > 0 && " "}
            {mcpFailures > 0 &&
              `${mcpFailures} MCP ${mcpFailures === 1 ? "failure" : "failures"} reported.`}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function AnalyticsView({
  analytics,
  filters,
  onFiltersChange,
  onRefresh,
}: {
  analytics: AdminAnalyticsResponse | null
  filters: Record<string, string>
  onFiltersChange: (filters: Record<string, string>) => void
  onRefresh: () => void
}) {
  const summary = analytics?.summary
  const setFilter = (key: string, value: string) =>
    onFiltersChange({ ...filters, [key]: value })
  const timeSeries = analytics?.timeSeries ?? []

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Analytics</CardTitle>
          <CardDescription>
            Filter request volume, latency, usage, and tool calls across the
            platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            aria-label="Analytics days"
            onChange={(event) => setFilter("days", event.target.value)}
            placeholder="Days (1–365)"
            value={filters.days}
          />
          <Input
            aria-label="Analytics from"
            onChange={(event) => setFilter("from", event.target.value)}
            placeholder="From (YYYY-MM-DD)"
            value={filters.from}
          />
          <Input
            aria-label="Analytics to"
            onChange={(event) => setFilter("to", event.target.value)}
            placeholder="To (YYYY-MM-DD)"
            value={filters.to}
          />
          <Input
            aria-label="Analytics organization"
            onChange={(event) =>
              setFilter("organizationId", event.target.value)
            }
            placeholder="Organization ID"
            value={filters.organizationId}
          />
          <Input
            aria-label="Analytics endpoint"
            onChange={(event) => setFilter("endpointId", event.target.value)}
            placeholder="Endpoint ID"
            value={filters.endpointId}
          />
          <Input
            aria-label="Analytics model"
            onChange={(event) => setFilter("model", event.target.value)}
            placeholder="Model"
            value={filters.model}
          />
          <Select
            value={filters.status || "all"}
            onValueChange={(value) => {
              const nextValue = value ?? "all"
              setFilter("status", nextValue === "all" ? "" : nextValue)
            }}
          >
            <SelectTrigger aria-label="Analytics status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="requires-action">Requires action</SelectItem>
                <SelectItem value="complete">Complete</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="incomplete">Incomplete</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button onClick={onRefresh}>Apply filters</Button>
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Requests", summary?.requests],
          ["Success", summary?.succeeded],
          ["Errors", summary?.failed],
          [
            "P95 latency",
            summary?.p95LatencyMs
              ? `${Math.round(summary.p95LatencyMs)} ms`
              : "—",
          ],
          ["Total tokens", compactNumber(summary?.totalTokens)],
          ["Average TTFT", summary?.averageTtftMs ? `${Math.round(summary.averageTtftMs)} ms` : "—"],
          ["Tool calls", summary?.toolCalls],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{value ?? "—"}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <AdminUsageCharts analytics={analytics} showLatency />
      <Card>
        <CardHeader>
          <CardTitle>Endpoint and model breakdown</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">Endpoint</th>
                <th className="p-2">Model</th>
                <th className="p-2">Requests</th>
                <th className="p-2">Errors</th>
                <th className="p-2">Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {(analytics?.byEndpoint ?? []).map((item: any) => (
                <tr
                  className="border-b last:border-0"
                  key={`${item.endpointId}-${item.model}`}
                >
                  <td className="p-2">{item.endpointName}</td>
                  <td className="p-2">{item.model || "—"}</td>
                  <td className="p-2">{item.requests}</td>
                  <td className="p-2">{item.errors}</td>
                  <td className="p-2">
                    {Math.round(item.averageLatencyMs ?? 0)} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!analytics?.byEndpoint?.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No runs match these filters.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Daily activity</CardTitle>
          <CardDescription>
            Request volume, outcomes, latency, and tool calls by UTC day.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">Date</th>
                <th className="p-2">Requests</th>
                <th className="p-2">Success</th>
                <th className="p-2">Errors</th>
                <th className="p-2">Cancelled</th>
                <th className="p-2">Avg latency</th>
                <th className="p-2">Tool calls</th>
              </tr>
            </thead>
            <tbody>
              {timeSeries.map((item: any) => (
                <tr className="border-b last:border-0" key={item.date}>
                  <td className="p-2">{item.date}</td>
                  <td className="p-2">{item.requests}</td>
                  <td className="p-2">{item.succeeded}</td>
                  <td className="p-2">{item.failed}</td>
                  <td className="p-2">{item.cancelled}</td>
                  <td className="p-2">
                    {Math.round(item.averageLatencyMs ?? 0)} ms
                  </td>
                  <td className="p-2">{item.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!timeSeries.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No daily activity for this range.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AuditView({
  events,
  filters,
  onFiltersChange,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  events: any[]
  filters: Record<string, string>
  onFiltersChange: (filters: Record<string, string>) => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const setFilter = (key: string, value: string) =>
    onFiltersChange({ ...filters, [key]: value })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>
          Administrative mutations are recorded without credentials or tokens.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            aria-label="Audit search"
            onChange={(event) => setFilter("search", event.target.value)}
            placeholder="Search actions or details"
            value={filters.search}
          />
          <Input
            aria-label="Audit action"
            onChange={(event) => setFilter("action", event.target.value)}
            placeholder="Action"
            value={filters.action}
          />
          <Input
            aria-label="Audit resource type"
            onChange={(event) => setFilter("resourceType", event.target.value)}
            placeholder="Resource type"
            value={filters.resourceType}
          />
          <Input
            aria-label="Audit actor"
            onChange={(event) => setFilter("actorId", event.target.value)}
            placeholder="Actor user ID"
            value={filters.actorId}
          />
          <Input
            aria-label="Audit organization"
            onChange={(event) =>
              setFilter("organizationId", event.target.value)
            }
            placeholder="Organization ID"
            value={filters.organizationId}
          />
          <Input
            aria-label="Audit from"
            onChange={(event) => setFilter("from", event.target.value)}
            placeholder="From (YYYY-MM-DD)"
            value={filters.from}
          />
          <Input
            aria-label="Audit to"
            onChange={(event) => setFilter("to", event.target.value)}
            placeholder="To (YYYY-MM-DD)"
            value={filters.to}
          />
        </div>
        {events.map((event) => (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-xs"
            key={event.id}
          >
            <div>
              <p className="font-medium">{event.action}</p>
              <p className="text-muted-foreground">
                {event.resourceType} · {event.resourceId ?? "—"}
              </p>
            </div>
            <time className="text-muted-foreground">
              {event.createdAt
                ? new Date(event.createdAt).toLocaleString()
                : ""}
            </time>
          </div>
        ))}
        {events.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No audit events found.
          </p>
        )}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
        />
      </CardContent>
    </Card>
  )
}
