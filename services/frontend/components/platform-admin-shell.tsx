"use client"
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import {
  Activity,
  Archive,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Ban,
  CheckCircle2,
  ChevronDown,
  Database,
  SlidersHorizontal,
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
  PlatformSession,
  User,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { notifyError, notifySuccess } from "@/lib/feedback"
import { PlatformAdminDashboard } from "@/components/platform-admin-dashboard"
import { EndpointsView } from "@/components/endpoints-view"
import { PlatformAnnouncementsView } from "@/components/platform-announcements-view"
import { PlatformAuthenticationView } from "@/components/platform-authentication-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { avatarToneFor, initialsFor } from "@/lib/identity"
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
import { Page, PageActions, PageTitle } from "@/components/ui/page"
import { SettingsRow, SettingsSection } from "@/components/ui/settings"
import {
  Tabs,
  ScrollableTabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
import { AdminListFooter, useAdminList } from "@/components/admin-list-controls"
import { PlatformAnalyticsView } from "@/components/platform-analytics-view"
import { FilterBar } from "@/components/ui/filter-bar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
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

const tabsMessages: Array<{
  id: AdminTab
  label: string
  icon: typeof ShieldCheck
}> = [
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

function readAdminParam(key: string, fallback = "") {
  if (typeof window === "undefined") return fallback
  return (
    new URLSearchParams(window.location.search).get(`admin_${key}`) ?? fallback
  )
}

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
  agentsEnabled: true,
  knowledgeEnabled: true,
  attachmentsEnabled: true,
  maintenanceMessage: "",
}

export function PlatformAdminShell({
  activeTab,
  onTabChange,
  user,
}: PlatformAdminShellProps) {
  const tabs = useTranslatedConfig(tabsMessages)

  const { t } = useTranslations()

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
  const [analyticsResult, setAnalyticsResult] = useState<{
    key: string
    data: AdminAnalyticsResponse
  } | null>(null)
  const [query, setQuery] = useState(() => readAdminParam("query"))
  const [listStatus, setListStatus] = useState(() => readAdminParam("status"))
  const [listPage, setListPage] = useState(1)
  const [listTotal, setListTotal] = useState(0)
  const [auditFilters, setAuditFilters] = useState<Record<string, string>>(
    () => ({
      search: readAdminParam("audit_search"),
      action: readAdminParam("audit_action"),
      resourceType: readAdminParam("audit_resourceType"),
      actorId: readAdminParam("audit_actorId"),
      organizationId: readAdminParam("audit_organizationId"),
      from: readAdminParam("audit_from"),
      to: readAdminParam("audit_to"),
    })
  )
  const [analyticsFilters, setAnalyticsFilters] = useState<
    Record<string, string>
  >(() => ({
    days: readAdminParam("analytics_days", "30"),
    from: readAdminParam("analytics_from"),
    to: readAdminParam("analytics_to"),
    organizationId: readAdminParam("analytics_organizationId"),
    userId: readAdminParam("analytics_userId"),
  }))
  const analytics =
    analyticsResult?.key === JSON.stringify(analyticsFilters)
      ? analyticsResult.data
      : null
  const [savingMaintenance, setSavingMaintenance] = useState(false)
  const [savingControl, setSavingControl] = useState<PlatformControlKey | null>(
    null
  )
  const [endpointCreateRequest, setEndpointCreateRequest] = useState(0)
  const [mcpCreateRequest, setMcpCreateRequest] = useState(0)
  const [authenticationCreateRequest, setAuthenticationCreateRequest] =
    useState(0)
  const [announcementCreateRequest, setAnnouncementCreateRequest] = useState(0)

  useEffect(() => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      query,
      status: listStatus,
      ...Object.fromEntries(
        Object.entries(analyticsFilters).map(([key, value]) => [
          `analytics_${key}`,
          value,
        ])
      ),
      ...Object.fromEntries(
        Object.entries(auditFilters).map(([key, value]) => [
          `audit_${key}`,
          value,
        ])
      ),
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) url.searchParams.set(`admin_${key}`, value)
      else url.searchParams.delete(`admin_${key}`)
    })
    window.history.replaceState(window.history.state, "", url)
  }, [analyticsFilters, auditFilters, listStatus, query])

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
        const data = await api.get<AdminAnalyticsResponse>(
          `/api/v1/admin/analytics?${params.toString()}`
        )
        setAnalyticsResult({ key: JSON.stringify(analyticsFilters), data })
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

  useEffect(() => {
    if (
      activeTab !== "overview" &&
      activeTab !== "analytics" &&
      activeTab !== "health"
    )
      return
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [activeTab, load])

  async function saveMaintenanceMessage() {
    setSavingMaintenance(true)
    setError("")
    try {
      const result = await api.put<PlatformSettings>("/api/v1/admin/settings", {
        maintenanceMessage: settings.maintenanceMessage,
        expectedUpdatedAt: settings.updatedAt ?? undefined,
      })
      setSettings(result)
      notifySuccess("Maintenance message saved")
    } catch (caught) {
      if (caught instanceof APIError && caught.status === 409) {
        await load()
      }
      setError(
        notifyError(
          "Maintenance message could not be saved",
          caught,
          "Platform settings could not be saved."
        )
      )
    } finally {
      setSavingMaintenance(false)
    }
  }

  async function updateSetting(key: PlatformControlKey, value: boolean) {
    const previousValue = settings[key]
    setSettings((current) => ({ ...current, [key]: value }))
    setSavingControl(key)
    setError("")
    try {
      const result = await api.put<PlatformSettings>("/api/v1/admin/settings", {
        [key]: value,
        expectedUpdatedAt: settings.updatedAt ?? undefined,
      })
      setSettings((current) => ({
        ...result,
        maintenanceMessage: current.maintenanceMessage,
      }))
      notifySuccess(`${settingLabel(key)} ${value ? "enabled" : "disabled"}`)
    } catch (caught) {
      setSettings((current) => ({ ...current, [key]: previousValue }))
      if (caught instanceof APIError && caught.status === 409) {
        await load()
      }
      setError(
        notifyError(
          "Platform control could not be updated",
          caught,
          "The control could not be updated."
        )
      )
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
      setError(
        notifyError(
          "User could not be updated",
          caught,
          "User could not be updated."
        )
      )
    }
  }

  async function updateWorkspace(id: string, patch: Record<string, unknown>) {
    setError("")
    try {
      await api.patch(`/api/v1/admin/organizations/${id}`, patch)
      notifySuccess("Workspace updated")
      await load()
    } catch (caught) {
      setError(
        notifyError(
          "Workspace could not be updated",
          caught,
          "Workspace could not be updated."
        )
      )
    }
  }

  const pageAction =
    activeTab === "endpoints" ? (
      <Button onClick={() => setEndpointCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" /> {t("Add endpoint")}
      </Button>
    ) : activeTab === "mcp" ? (
      <Button onClick={() => setMcpCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" />{" "}
        {t("Add MCP server")}
      </Button>
    ) : activeTab === "authentication" ? (
      <Button
        onClick={() => setAuthenticationCreateRequest((value) => value + 1)}
      >
        <Plus data-icon="inline-start" aria-hidden="true" /> {t("Add provider")}
      </Button>
    ) : activeTab === "announcements" ? (
      <Button
        onClick={() => setAnnouncementCreateRequest((value) => value + 1)}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />{" "}
        {t("Add announcement")}
      </Button>
    ) : null

  if (!user.platformAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-12">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("Platform administrator access required")}</AlertTitle>
          <AlertDescription>
            {t("This area is restricted to platform administrators.")}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const listToolbar = (
    <FilterBar
      className="border-0 px-0 py-0"
      hasActiveFilters={Boolean(query.trim() || listStatus)}
      onClear={() => {
        setListPage(1)
        setQuery("")
        setListStatus("")
      }}
      search={{
        label: t("Search {value0}", { value0: activeTab }),
        onChange: (value) => {
          setListPage(1)
          setQuery(value)
        },
        placeholder: t(
          activeTab === "users" ? "Search users…" : "Search workspaces…"
        ),
        value: query,
      }}
    >
      <Select
        value={listStatus || "all"}
        onValueChange={(value) => {
          setListPage(1)
          const nextValue = value ?? "all"
          setListStatus(nextValue === "all" ? "" : nextValue)
        }}
      >
        <SelectTrigger
          aria-label={t("{value0} status", { value0: activeTab })}
          className="h-8 min-w-36 sm:min-w-40"
          size="sm"
        >
          <SelectValue>
            {t(
              listStatus === "active"
                ? "Active"
                : listStatus === "suspended"
                  ? "Suspended"
                  : listStatus === "archived"
                    ? "Archived"
                    : "All statuses"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectGroup>
            <SelectItem value="all">{t("All statuses")}</SelectItem>
            <SelectItem value="active">{t("Active")}</SelectItem>
            {activeTab === "users" ? (
              <SelectItem value="suspended">{t("Suspended")}</SelectItem>
            ) : (
              <>
                <SelectItem value="archived">{t("Archived")}</SelectItem>
                <SelectItem value="suspended">{t("Suspended")}</SelectItem>
              </>
            )}
          </SelectGroup>
        </SelectContent>
      </Select>
    </FilterBar>
  )

  return (
    <Page>
      <PageTitle>{t("Platform administration")}</PageTitle>
      <PageActions>
        {pageAction}
        <Button
          aria-label={t("Refresh admin data")}
          onClick={() => void load()}
          variant="outline"
          size="sm"
        >
          <RefreshCw data-icon="inline-start" /> {t("Refresh")}
        </Button>
      </PageActions>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setListPage(1)
          setListStatus("")
          onTabChange(value as AdminTab)
        }}
        className="gap-6"
      >
        <ScrollableTabsList
          aria-label={t("Platform administration")}
          variant="line"
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id}>
              <Icon aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </ScrollableTabsList>

        <TabsContent key={activeTab} value={activeTab} className="min-w-0">
          {error && (
            <Alert className="mb-4" variant="destructive">
              <AlertTriangle />
              <AlertTitle>{t("Admin request failed")}</AlertTitle>
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}

          {activeTab === "overview" && (
            <PlatformAdminDashboard
              dashboard={dashboard}
              onTabChange={onTabChange}
            />
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
            <PlatformAuthenticationView
              createRequest={authenticationCreateRequest}
            />
          )}
          {activeTab === "announcements" && (
            <PlatformAnnouncementsView
              createRequest={announcementCreateRequest}
            />
          )}
          {(activeTab === "users" || activeTab === "workspaces") && (
            <div className="flex flex-col gap-4">
              {activeTab === "users" ? (
                <UsersView
                  toolbar={listToolbar}
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
                  toolbar={listToolbar}
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
              title={t("Global and scoped MCP servers")}
              items={servers}
              kind="mcp"
              onRefresh={() => void load()}
              createRequest={mcpCreateRequest}
            />
          )}
          {activeTab === "health" && <HealthView health={health} />}
          {activeTab === "analytics" && (
            <div className="flex flex-col gap-4">
              <PlatformAnalyticsView
                analytics={analytics}
                filters={analyticsFilters}
                onFiltersChange={setAnalyticsFilters}
                onRefresh={() => void load()}
              />
            </div>
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
        </TabsContent>
      </Tabs>
    </Page>
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
  onToggle: (key: PlatformControlKey, value: boolean) => void
  onSave: () => void
}) {
  const { t } = useTranslations()

  const controls: Array<[PlatformControlKey, string, string]> = [
    ["loginEnabled", "Login", "Allow existing users to sign in."],
    [
      "localAuthEnabled",
      "Local password auth",
      "Allow password login and password account creation.",
    ],
    ["signupEnabled", "Signup", "Allow new password and OIDC provisioning."],
    ["aiEnabled", "AI chat", "Allow model requests and text chat."],
    [
      "agentsEnabled",
      t("Agents"),
      "Allow agent runs, delegation, and workflow scheduling.",
    ],
    ["voiceEnabled", t("Voice"), "Allow realtime voice and speech synthesis."],
    [
      "transcriptionEnabled",
      t("Transcription"),
      "Allow rooms, capture, and processing.",
    ],
    ["mcpEnabled", "MCP", "Allow MCP discovery, attachment, and execution."],
    [
      "knowledgeEnabled",
      t("Knowledge"),
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
      {[
        {
          title: "Access & registration",
          description: "Control how people sign in and create accounts.",
          keys: ["loginEnabled", "localAuthEnabled", "signupEnabled"],
        },
        {
          title: "AI & processing",
          description: "Choose which AI and processing features are available.",
          keys: [
            "aiEnabled",
            "agentsEnabled",
            "voiceEnabled",
            "transcriptionEnabled",
          ],
        },
        {
          title: "Tools & content",
          description:
            "Control access to integrations, knowledge, and attachments.",
          keys: ["mcpEnabled", "knowledgeEnabled", "attachmentsEnabled"],
        },
      ].map((group) => (
        <SettingsSection
          key={group.title}
          description={t(group.description)}
          title={t(group.title)}
        >
          {controls
            .filter(([key]) => group.keys.includes(key))
            .map(([key, label, description]) => (
              <SettingsRow
                description={t(description)}
                htmlFor={`platform-control-${key}`}
                key={key}
                label={t(label)}
              >
                <div className="flex items-center gap-2">
                  {savingControl === key && (
                    <span className="text-xs text-muted-foreground">
                      {t("Saving…")}
                    </span>
                  )}
                  <Switch
                    checked={Boolean(settings[key])}
                    disabled={savingControl !== null}
                    id={`platform-control-${key}`}
                    onCheckedChange={(checked) => onToggle(key, checked)}
                  />
                </div>
              </SettingsRow>
            ))}
        </SettingsSection>
      ))}
      <SettingsSection
        description={t("Shown when a feature is unavailable.")}
        footer={
          <Button disabled={savingMaintenance} onClick={onSave}>
            {t(savingMaintenance ? "Saving…" : "Save maintenance message")}
          </Button>
        }
        title={t("Maintenance message")}
      >
        <SettingsRow
          description={t("Visible to anyone who hits a disabled capability.")}
          htmlFor="platform-maintenance-message"
          label={t("Message")}
        >
          <Textarea
            id="platform-maintenance-message"
            onChange={(event) =>
              onChange({ ...settings, maintenanceMessage: event.target.value })
            }
            placeholder={t("We’re performing maintenance…")}
            value={settings.maintenanceMessage}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  )
}

function Pagination({
  page,
  compact = false,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  compact?: boolean
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t } = useTranslations()

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (pageCount <= 1) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground",
        !compact && "border-t pt-3"
      )}
    >
      {!compact && (
        <span className="min-w-0 flex-1">
          {t("Page")} {page} {t("of")} {pageCount} · {total} total
        </span>
      )}
      <div className="flex shrink-0 gap-1">
        <Button
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          size="sm"
          variant="outline"
        >
          {t("Previous page")}
        </Button>
        <Button
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          size="sm"
          variant="outline"
        >
          {t("Next page")}
        </Button>
      </div>
    </div>
  )
}

function UsersView({
  users,
  toolbar,
  onUpdate,
  onReload,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  users: any[]
  toolbar: ReactNode
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  onReload: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t, locale } = useTranslations()

  const [detail, setDetail] = useState<any | null>(null)
  const [actionError, setActionError] = useState("")
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<{
    item: any
    owned: any[]
  } | null>(null)
  const [deletePhrase, setDeletePhrase] = useState("")
  const [revokeCandidate, setRevokeCandidate] = useState<any | null>(null)
  const [sessionBusyId, setSessionBusyId] = useState("")
  const [confirmAction, setConfirmAction] = useState<{
    item: any
    patch: Record<string, unknown>
    title: string
    description: string
    confirmLabel: string
    destructive?: boolean
  } | null>(null)
  const [confirmPending, setConfirmPending] = useState(false)

  function requestUserAction(item: any, patch: Record<string, unknown>) {
    const isAdminChange = Object.prototype.hasOwnProperty.call(
      patch,
      "platformAdmin"
    )
    const isSuspension = patch.status === "suspended"
    const verb = isAdminChange
      ? item.platformAdmin
        ? t("Demote")
        : t("Promote")
      : isSuspension
        ? t("Suspend")
        : t("Unsuspend")
    setConfirmAction({
      item,
      patch,
      title: `${verb} ${item.displayName ?? "this user"}?`,
      description: isAdminChange
        ? `${verb}ing platform administrator access changes this user's ability to manage every workspace and platform control.`
        : isSuspension
          ? t(
              "Suspending this user revokes their current access and prevents new sign-ins until they are unsuspended."
            )
          : t(
              "This user will be able to sign in and use their workspaces again."
            ),
      confirmLabel: verb,
      destructive: isSuspension || isAdminChange,
    })
  }

  async function confirmUserAction() {
    if (!confirmAction) return
    setConfirmPending(true)
    try {
      await onUpdate(confirmAction.item.id, confirmAction.patch)
      setConfirmAction(null)
    } finally {
      setConfirmPending(false)
    }
  }

  async function showDetail(id: string) {
    setLoadingDetail(true)
    setActionError("")
    try {
      const [result, sessionResult] = await Promise.all([
        api.get<{ user: any; organizations: any[] }>(
          `/api/v1/admin/users/${id}`
        ),
        api.get<{ sessions: PlatformSession[] }>(
          `/api/v1/admin/users/${id}/sessions`
        ),
      ])
      setDetail({ ...result, sessions: sessionResult.sessions ?? [] })
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

  async function revokeSession(session: PlatformSession) {
    const userID = detail?.user?.id
    if (!userID || !session.active) return
    setSessionBusyId(session.id)
    setActionError("")
    try {
      await api.post(
        `/api/v1/admin/users/${userID}/sessions/${session.id}/revoke`
      )
      setDetail((current: any) =>
        current
          ? {
              ...current,
              sessions: (current.sessions ?? []).map((item: PlatformSession) =>
                item.id === session.id
                  ? {
                      ...item,
                      active: false,
                      revokedAt: new Date().toISOString(),
                    }
                  : item
              ),
            }
          : current
      )
      notifySuccess("Session revoked")
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "Session could not be revoked."
      )
    } finally {
      setSessionBusyId("")
    }
  }

  async function openDeleteUser(item: any) {
    setActionError("")
    try {
      const result = await api.get<{ organizations: any[] }>(
        `/api/v1/admin/users/${item.id}`
      )
      const owned = (result.organizations ?? []).filter(
        (organization) => organization.role === "owner"
      )
      setDeletePhrase("")
      setDeleteCandidate({ item, owned })
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "User could not be deleted."
      )
    }
  }

  async function deleteUser() {
    if (!deleteCandidate || deletePhrase !== "DELETE") return
    setActionError("")
    try {
      await api.delete(`/api/v1/admin/users/${deleteCandidate.item.id}`, {
        confirm: true,
        deleteOrganizationIds: deleteCandidate.owned.map(
          (organization) => organization.id
        ),
      })
      setDetail(null)
      setDeleteCandidate(null)
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
        <div className="px-4 pb-1">{toolbar}</div>
        <CardContent className="flex flex-col gap-3 overflow-x-auto">
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{t(actionError)}</AlertDescription>
            </Alert>
          )}
          <table className="w-full min-w-[36rem] text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">{t("User")}</th>
                <th className="p-2">{t("Status")}</th>
                <th className="p-2">{t("Access")}</th>
                <th className="p-2 text-right">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr className="border-b last:border-0" key={item.id}>
                  <td className="p-2">
                    <button
                      className="flex items-center gap-3 rounded-md text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void showDetail(item.id)}
                      type="button"
                    >
                      <Avatar size="sm" className="size-8">
                        <AvatarFallback className={avatarToneFor(item.id)}>
                          {initialsFor(item.displayName || item.email)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {item.displayName || item.email}
                        </span>
                        <span className="text-muted-foreground">
                          {item.email}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="p-2">
                    <Badge
                      variant={
                        item.status === "suspended" ? "destructive" : "success"
                      }
                    >
                      {t(item.status === "suspended" ? "Suspended" : "Active")}
                    </Badge>
                  </td>
                  <td className="p-2">
                    {item.platformAdmin ? (
                      <Badge variant="secondary">
                        <ShieldCheck data-icon="inline-start" />{" "}
                        {t("platform admin")}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("Standard access")}
                      </span>
                    )}
                  </td>
                  <td className="p-2">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              aria-label={t("Actions for {value0}", {
                                value0: item.displayName,
                              })}
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
                              <Search aria-hidden="true" /> {t("Details")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                requestUserAction(item, {
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
                                ? t("Unsuspend")
                                : t("Suspend")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                requestUserAction(item, {
                                  platformAdmin: !item.platformAdmin,
                                })
                              }
                            >
                              <ShieldCheck aria-hidden="true" />
                              {item.platformAdmin
                                ? t("Demote admin")
                                : t("Promote admin")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setRevokeCandidate(item)}
                            >
                              <RefreshCw aria-hidden="true" />{" "}
                              {t("Revoke sessions")}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => void openDeleteUser(item)}
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" /> {t("Delete user")}
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
              {t("No users match this search.")}
            </p>
          )}
        </CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
          <span aria-live="polite">
            {total === 0
              ? t("No users match this search.")
              : t("{start}–{end} of {total}", {
                  start: (page - 1) * pageSize + 1,
                  end: Math.min((page - 1) * pageSize + users.length, total),
                  total,
                })}
          </span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
            compact
          />
        </div>
      </Card>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent className="min-w-0 sm:max-w-xl">
          <DialogHeader className="min-w-0 pr-6">
            <DialogTitle className="break-words">
              {detail?.user?.displayName ?? t("User details")}
            </DialogTitle>
            <DialogDescription className="break-all">
              {detail?.user?.email}
            </DialogDescription>
          </DialogHeader>
          {loadingDetail ? (
            <p className="text-sm text-muted-foreground">
              {t("Loading user details…")}
            </p>
          ) : detail ? (
            <div className="flex min-w-0 flex-col gap-5 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    detail.user.status === "suspended"
                      ? "destructive"
                      : "success"
                  }
                >
                  {t(
                    detail.user.status === "suspended" ? "Suspended" : "Active"
                  )}
                </Badge>
                {detail.user.platformAdmin && (
                  <Badge variant="secondary">
                    <ShieldCheck data-icon="inline-start" />
                    {t("platform admin")}
                  </Badge>
                )}
              </div>
              <div>
                <p className="font-medium">{t("Workspaces")}</p>
                <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                  {(detail.organizations ?? []).map((organization: any) => (
                    <div
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 p-3"
                      key={organization.id}
                    >
                      <span className="min-w-0 font-medium break-words">
                        {organization.name}
                      </span>
                      <span>
                        {t(
                          organization.role === "owner"
                            ? "Owner"
                            : organization.role === "admin"
                              ? "Admin"
                              : "Member"
                        )}{" "}
                        ·{" "}
                        {t(
                          organization.status === "suspended"
                            ? "Suspended"
                            : organization.status === "archived"
                              ? "Archived"
                              : "Active"
                        )}
                      </span>
                    </div>
                  ))}
                  {detail.organizations?.length === 0 && (
                    <span>{t("None")}</span>
                  )}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{t("Sessions")}</p>
                  <span className="text-xs text-muted-foreground">
                    {
                      (detail.sessions ?? []).filter(
                        (session: PlatformSession) => session.active
                      ).length
                    }{" "}
                    {t("Active")}
                  </span>
                </div>
                <div className="mt-2 flex max-h-64 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain text-xs">
                  {(detail.sessions ?? []).map((session: PlatformSession) => (
                    <div
                      className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-xl bg-muted/50 p-3"
                      key={session.id}
                    >
                      <div className="min-w-0 flex-1 basis-48">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant={session.active ? "success" : "secondary"}
                          >
                            {session.active ? t("Active") : t("Revoked")}
                          </Badge>
                          <span className="text-muted-foreground">
                            {t("Last seen")}{" "}
                            {new Date(session.lastSeenAt).toLocaleString(
                              locale
                            )}
                          </span>
                        </div>
                        <details className="mt-2 min-w-0 text-muted-foreground">
                          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                            {t("Device details")}
                          </summary>
                          <p className="mt-2 break-all whitespace-normal">
                            {session.userAgent || t("No device metadata")}
                          </p>
                          {session.ipAddress && (
                            <p className="mt-1 break-all">
                              IP: {session.ipAddress}
                            </p>
                          )}
                        </details>
                      </div>
                      {session.active && (
                        <Button
                          aria-label={t("Revoke this session")}
                          disabled={sessionBusyId === session.id}
                          onClick={() => void revokeSession(session)}
                          size="sm"
                          variant="outline"
                        >
                          {sessionBusyId === session.id
                            ? t("Revoking…")
                            : t("Revoke")}
                        </Button>
                      )}
                    </div>
                  ))}
                  {detail.sessions?.length === 0 && (
                    <span className="text-muted-foreground">
                      {t("No sessions found.")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            {detail?.user && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  <MoreHorizontal data-icon="inline-start" /> {t("Actions")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() =>
                        requestUserAction(detail.user, {
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
                        ? t("Unsuspend")
                        : t("Suspend")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        requestUserAction(detail.user, {
                          platformAdmin: !detail.user.platformAdmin,
                        })
                      }
                    >
                      <ShieldCheck aria-hidden="true" />
                      {detail.user.platformAdmin
                        ? t("Demote admin")
                        : t("Promote admin")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setRevokeCandidate(detail.user)}
                    >
                      <RefreshCw aria-hidden="true" /> {t("Revoke sessions")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => void openDeleteUser(detail.user)}
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" /> {t("Delete user")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteCandidate(null)
            setDeletePhrase("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Permanently delete user")}</DialogTitle>
            <DialogDescription>
              {deleteCandidate?.owned.length
                ? t(
                    "This also deletes {value0} owned workspace(s). Type DELETE to continue.",
                    { value0: deleteCandidate.owned.length }
                  )
                : t(
                    "This permanently removes {value0}. Type DELETE to continue.",
                    { value0: deleteCandidate?.item.displayName ?? "this user" }
                  )}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t("Type DELETE to confirm")}
            autoComplete="off"
            onChange={(event) => setDeletePhrase(event.target.value)}
            placeholder="DELETE"
            value={deletePhrase}
          />
          <DialogFooter>
            <Button onClick={() => setDeleteCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              disabled={deletePhrase !== "DELETE"}
              onClick={() => void deleteUser()}
              variant="destructive"
            >
              {t("Delete user")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={revokeCandidate !== null}
        onOpenChange={(open) => !open && setRevokeCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Revoke active sessions")}</DialogTitle>
            <DialogDescription>
              {t(
                "Every active session for {value0} will need to sign in again.",
                { value0: revokeCandidate?.displayName ?? "this user" }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setRevokeCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              onClick={() => {
                const userToRevoke = revokeCandidate
                if (!userToRevoke) return
                void api
                  .post(
                    `/api/v1/admin/users/${userToRevoke.id}/revoke-sessions`
                  )
                  .then(onReload)
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error
                        ? caught.message
                        : "Sessions could not be revoked."
                    )
                  )
                  .finally(() => setRevokeCandidate(null))
              }}
            >
              {t("Revoke sessions")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? "Confirm user action"}
        description={confirmAction?.description ?? ""}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        destructive={confirmAction?.destructive}
        pending={confirmPending}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        onConfirm={confirmUserAction}
      />
    </>
  )
}

function WorkspacesView({
  workspaces,
  toolbar,
  onUpdate,
  onReload,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  workspaces: any[]
  toolbar: ReactNode
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  onReload: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t } = useTranslations()

  const [detail, setDetail] = useState<any | null>(null)
  const [actionError, setActionError] = useState("")
  const [transferCandidate, setTransferCandidate] = useState<any | null>(null)
  const [newOwnerID, setNewOwnerID] = useState("")
  const [deleteCandidate, setDeleteCandidate] = useState<any | null>(null)
  const [deletePhrase, setDeletePhrase] = useState("")
  const [confirmAction, setConfirmAction] = useState<{
    item: any
    patch: Record<string, unknown>
    title: string
    description: string
    confirmLabel: string
  } | null>(null)
  const [confirmPending, setConfirmPending] = useState(false)

  function requestWorkspaceAction(item: any, patch: Record<string, unknown>) {
    const nextStatus = patch.status
    const isArchive = item.status === "archived" || nextStatus === "archived"
    const isSuspend = !isArchive && nextStatus === "suspended"
    const verb = isArchive
      ? item.status === "archived"
        ? t("Restore")
        : t("Archive")
      : isSuspend
        ? t("Suspend")
        : t("Unsuspend")
    setConfirmAction({
      item,
      patch,
      title: `${verb} ${item.name ?? "this workspace"}?`,
      description: isArchive
        ? item.status === "archived"
          ? t(
              "Restoring this workspace makes its resources available to members again."
            )
          : t(
              "Archiving this workspace hides it from normal use until an administrator restores it."
            )
        : isSuspend
          ? t(
              "Suspending this workspace blocks member access and active work until it is unsuspended."
            )
          : t("Members will be able to access this workspace again."),
      confirmLabel: verb,
    })
  }

  async function confirmWorkspaceAction() {
    if (!confirmAction) return
    setConfirmPending(true)
    try {
      await onUpdate(confirmAction.item.id, confirmAction.patch)
      setConfirmAction(null)
    } finally {
      setConfirmPending(false)
    }
  }

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
        <div className="px-4 pb-1">{toolbar}</div>
        <CardContent className="flex flex-col gap-3 overflow-x-auto">
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{t(actionError)}</AlertDescription>
            </Alert>
          )}
          <table className="w-full min-w-[36rem] text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">{t("Workspace")}</th>
                <th className="p-2">{t("Members")}</th>
                <th className="p-2">{t("Status")}</th>
                <th className="p-2 text-right">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((item) => (
                <tr className="border-b last:border-0" key={item.id}>
                  <td className="p-2">
                    <button
                      className="flex items-center gap-3 rounded-md text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void showDetail(item.id)}
                      type="button"
                    >
                      <Avatar size="sm" className="size-8">
                        <AvatarFallback className={avatarToneFor(item.id)}>
                          {initialsFor(item.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="flex flex-col">
                        <span className="font-medium">{item.name}</span>
                        <span className="text-muted-foreground">
                          {item.slug}
                        </span>
                      </span>
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
                            : "success"
                      }
                    >
                      {t(
                        item.status === "suspended"
                          ? "Suspended"
                          : item.status === "archived"
                            ? "Archived"
                            : "Active"
                      )}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              aria-label={t("Actions for {value0}", {
                                value0: item.name,
                              })}
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
                              <Search aria-hidden="true" /> {t("Details")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                requestWorkspaceAction(item, {
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
                                ? t("Restore")
                                : t("Archive")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                requestWorkspaceAction(item, {
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
                                ? t("Unsuspend")
                                : t("Suspend")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setNewOwnerID("")
                                setTransferCandidate(item)
                              }}
                            >
                              <ArrowLeftRight aria-hidden="true" />{" "}
                              {t("Transfer ownership")}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              setDeletePhrase("")
                              setDeleteCandidate(item)
                            }}
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" />{" "}
                            {t("Delete workspace")}
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
              {t("No workspaces match this search.")}
            </p>
          )}
        </CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
          <span aria-live="polite">
            {total === 0
              ? t("No workspaces match this search.")
              : t("{start}–{end} of {total}", {
                  start: (page - 1) * pageSize + 1,
                  end: Math.min(
                    (page - 1) * pageSize + workspaces.length,
                    total
                  ),
                  total,
                })}
          </span>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
            compact
          />
        </div>
      </Card>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent className="min-w-0 sm:max-w-xl">
          <DialogHeader className="min-w-0 pr-6">
            <DialogTitle className="break-words">
              {detail?.organization?.name ?? t("Workspace details")}
            </DialogTitle>
            <DialogDescription className="break-all">
              {detail?.organization?.slug}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    detail.organization.status === "suspended"
                      ? "destructive"
                      : detail.organization.status === "archived"
                        ? "secondary"
                        : "success"
                  }
                >
                  {t(
                    detail.organization.status === "suspended"
                      ? "Suspended"
                      : detail.organization.status === "archived"
                        ? "Archived"
                        : "Active"
                  )}
                </Badge>
                <Badge variant="outline">
                  {detail.members?.length ?? 0}{" "}
                  {t(detail.members?.length === 1 ? "member" : "members")}
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <ResourceCount
                  label={t("Conversations")}
                  value={detail.resources?.conversations}
                />
                <ResourceCount
                  label={t("Endpoints")}
                  value={detail.resources?.endpoints}
                />
                <ResourceCount
                  label={t("MCP servers")}
                  value={detail.resources?.mcpServers}
                />
                <ResourceCount
                  label={t("Knowledge sources")}
                  value={detail.resources?.knowledgeSources}
                />
                <ResourceCount
                  label={t("Transcriptions")}
                  value={detail.resources?.transcriptions}
                />
              </div>
              <section
                aria-label={t("Members")}
                className="flex min-w-0 flex-col gap-2 text-xs"
              >
                <h3 className="text-sm font-medium">{t("Members")}</h3>
                <div className="flex max-h-64 min-w-0 flex-col gap-2 overflow-y-auto">
                  {(detail.members ?? []).map((member: any) => (
                    <div
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/50 p-3"
                      key={member.id}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <Avatar size="sm">
                          <AvatarFallback className={avatarToneFor(member.id)}>
                            {initialsFor(member.displayName || member.email)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="font-medium break-words">
                            {member.displayName || member.email}
                          </p>
                          <p className="break-all text-muted-foreground">
                            {member.email}
                          </p>
                        </div>
                      </div>
                      <Badge variant="secondary">
                        {t(
                          member.role === "owner"
                            ? "Owner"
                            : member.role === "admin"
                              ? "Admin"
                              : "Member"
                        )}
                      </Badge>
                    </div>
                  ))}
                  {!detail.members?.length && (
                    <p className="text-muted-foreground">
                      {t("No members found.")}
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setDetail(null)} variant="outline">
              {t("Close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={transferCandidate !== null}
        onOpenChange={(open) => !open && setTransferCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Transfer workspace ownership")}</DialogTitle>
            <DialogDescription>
              {t("Enter the user ID of the new owner for")}{" "}
              {transferCandidate?.name ?? "this workspace"}.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t("New owner user ID")}
            autoComplete="off"
            onChange={(event) => setNewOwnerID(event.target.value)}
            placeholder={t("User ID")}
            value={newOwnerID}
          />
          <DialogFooter>
            <Button
              onClick={() => setTransferCandidate(null)}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={!newOwnerID.trim()}
              onClick={() => {
                const workspace = transferCandidate
                const newOwnerId = newOwnerID.trim()
                if (!workspace || !newOwnerId) return
                void api
                  .post(
                    `/api/v1/admin/organizations/${workspace.id}/transfer-ownership`,
                    { newOwnerId }
                  )
                  .then(() => onUpdate(workspace.id, {}))
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error
                        ? caught.message
                        : "Ownership could not be transferred."
                    )
                  )
                  .finally(() => setTransferCandidate(null))
              }}
            >
              {t("Transfer ownership")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => !open && setDeleteCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Permanently delete workspace")}</DialogTitle>
            <DialogDescription>
              {t("Type")} {deleteCandidate?.name ?? "the workspace name"}{" "}
              {t("to permanently delete this workspace and its data.")}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t("Type workspace name to confirm")}
            autoComplete="off"
            onChange={(event) => setDeletePhrase(event.target.value)}
            placeholder={deleteCandidate?.name ?? t("Workspace name")}
            value={deletePhrase}
          />
          <DialogFooter>
            <Button onClick={() => setDeleteCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              disabled={deletePhrase !== deleteCandidate?.name}
              onClick={() => {
                const workspace = deleteCandidate
                if (!workspace || deletePhrase !== workspace.name) return
                void api
                  .delete(`/api/v1/admin/organizations/${workspace.id}`, {
                    confirmName: deletePhrase,
                  })
                  .then(onReload)
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error
                        ? caught.message
                        : "Workspace could not be deleted."
                    )
                  )
                  .finally(() => setDeleteCandidate(null))
              }}
              variant="destructive"
            >
              {t("Delete workspace")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? "Confirm workspace action"}
        description={confirmAction?.description ?? ""}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        pending={confirmPending}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        onConfirm={confirmWorkspaceAction}
      />
    </>
  )
}

function ResourceCount({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/50 p-3">
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

const maxMCPServerIconBytes = 2 * 1024 * 1024

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
  const { t } = useTranslations()
  const list = useAdminList(
    items,
    (item, query, status) =>
      `${item.name} ${item.endpointUrl ?? ""} ${item.providerType ?? ""}`
        .toLocaleLowerCase()
        .includes(query) &&
      (status === "all" ||
        (status === "enabled" ? item.enabled : !item.enabled))
  )

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
  const [deleteCandidate, setDeleteCandidate] = useState<any | null>(null)
  const [deletePhrase, setDeletePhrase] = useState("")
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
  const resourceLabel = kind === "endpoint" ? t("Endpoint") : t("MCP server")

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
    if (file.size > maxMCPServerIconBytes) {
      setCreateError("MCP icons are limited to 2 MB.")
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
      setCreateError(
        "Use a PNG, JPEG, GIF, WebP, or ICO image for the MCP logo."
      )
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
    if (file.size > maxMCPServerIconBytes) {
      setItemErrors((current) => ({
        ...current,
        [itemId]: "MCP icons are limited to 2 MB.",
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
        label: t("Uploading logo…"),
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
      notifySuccess(
        `${resourceLabel} created`,
        `${name} is now in the catalog.`
      )
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
      <Card aria-label={title}>
        <div className="px-4">
          <FilterBar
            className="border-0 p-0"
            search={{
              label: t("Search MCP servers"),
              placeholder: t("Search MCP servers…"),
              value: list.query,
              onChange: list.setQuery,
            }}
            hasActiveFilters={Boolean(list.query || list.status !== "all")}
            onClear={list.clear}
          >
            <Select
              value={list.status}
              onValueChange={(value) => list.setStatus(value ?? "all")}
            >
              <SelectTrigger size="sm" aria-label={t("Status")}>
                <SelectValue>
                  {t(
                    list.status === "enabled"
                      ? "Enabled"
                      : list.status === "disabled"
                        ? "Disabled"
                        : "All statuses"
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
          </FilterBar>
        </div>
        <CardContent className="flex flex-col gap-3 overflow-x-auto">
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{t(actionError)}</AlertDescription>
            </Alert>
          )}
          {actionNotice && (
            <div
              aria-live="polite"
              className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              role="status"
            >
              {t(actionNotice)}
            </div>
          )}
          <table className="w-full min-w-[48rem] text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">{t("Name")}</th>
                <th className="p-2">{t("Scope")}</th>
                <th className="p-2">{t("Provider / URL")}</th>
                <th className="p-2">{t("State")}</th>
                <th className="p-2 text-right">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {list.pageItems.map((item) => {
                const busy = busyId === item.id
                const rowAction =
                  activeAction?.id === item.id ? activeAction : null
                const itemError =
                  itemErrors[item.id] ||
                  (kind === "mcp" ? String(item.lastError || "") : "")
                const scopeLabel =
                  item.scopeType === "global"
                    ? t("Platform")
                    : item.scopeType === "organization"
                      ? t("Workspace")
                      : t("Personal")
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
                        <span className="break-words">{item.name}</span>
                      </div>
                    </td>
                    <td className="p-2">
                      <Badge
                        variant={
                          item.scopeType === "global" ? "secondary" : "outline"
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
                      <Badge
                        variant={
                          itemError
                            ? "destructive"
                            : item.enabled
                              ? "success"
                              : "secondary"
                        }
                      >
                        {t(
                          itemError
                            ? "Check failed"
                            : item.enabled
                              ? "Enabled"
                              : "Disabled"
                        )}
                      </Badge>
                      {itemError && (
                        <p
                          aria-live="assertive"
                          className="mt-1 max-w-xs text-xs break-words text-destructive"
                          role="alert"
                        >
                          {t(itemError)}
                        </p>
                      )}
                    </td>
                    <td className="p-2">
                      {kind === "mcp" && (
                        <input
                          aria-label={t("Choose logo for {value0}", {
                            value0: item.name,
                          })}
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
                              <span>{rowAction?.label ?? t("Working…")}</span>
                            </div>
                            {rowAction?.cancellable && (
                              <Button
                                aria-label={t("Stop action for {value0}", {
                                  value0: item.name,
                                })}
                                onClick={stopActiveAction}
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                <Square
                                  data-icon="inline-start"
                                  aria-hidden="true"
                                />
                                {t("Stop")}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  aria-label={t("Actions for {value0}", {
                                    value0: item.name,
                                  })}
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
                                  {item.enabled ? t("Disable") : t("Enable")}
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
                                    <TestTube2 aria-hidden="true" />{" "}
                                    {t("Test endpoint")}
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
                                      <TestTube2 aria-hidden="true" />{" "}
                                      {t("Test server")}
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
                                      <Wrench aria-hidden="true" />{" "}
                                      {t("Discover tools")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onClick={() =>
                                        document
                                          .getElementById(`mcp-logo-${item.id}`)
                                          ?.click()
                                      }
                                    >
                                      <ImagePlus aria-hidden="true" />{" "}
                                      {t("Set logo")}
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={busy}
                                variant="destructive"
                                onClick={() => setDeleteCandidate(item)}
                              >
                                <Trash2 aria-hidden="true" /> {t("Delete")}{" "}
                                {kind === "endpoint"
                                  ? "endpoint"
                                  : t("MCP server")}
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
          {list.total === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("No resources found.")}
            </p>
          )}
        </CardContent>
        <AdminListFooter
          page={list.page}
          total={list.total}
          onPageChange={list.setPage}
        />
      </Card>
      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteCandidate(null)
            setDeletePhrase("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("Delete")} {resourceLabel.toLowerCase()}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Permanently delete {value0}? Type DELETE to confirm. This cannot be undone.",
                {
                  value0:
                    deleteCandidate?.name ??
                    `this ${resourceLabel.toLowerCase()}`,
                }
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t("Type DELETE to confirm")}
            autoComplete="off"
            onChange={(event) => setDeletePhrase(event.target.value)}
            placeholder="DELETE"
            value={deletePhrase}
          />
          <DialogFooter>
            <Button onClick={() => setDeleteCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              disabled={deletePhrase !== "DELETE"}
              onClick={() => {
                const resource = deleteCandidate
                if (!resource || deletePhrase !== "DELETE") return
                setDeleteCandidate(null)
                setDeletePhrase("")
                void runAction(
                  resource.id,
                  {
                    label: t("Deleting…"),
                    cancellable: false,
                    stoppedMessage: `${resourceLabel} deletion was stopped.`,
                  },
                  async () => {
                    await api.delete(
                      `/api/v1/admin/${resourcePath}/${resource.id}`
                    )
                  }
                )
              }}
              variant="destructive"
            >
              {t("Delete")} {resourceLabel.toLowerCase()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && !createBusy) {
            resetCreateIcon()
            setCreateOpen(false)
          }
        }}
      >
        <DialogContent className="min-w-0 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t(kind === "endpoint" ? "Add endpoint" : "Add MCP server")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Register a resource in the shared platform catalog or assign it to a specific scope."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-3">
            {createError && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{t(createError)}</AlertDescription>
              </Alert>
            )}
            <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
              {t("Name")}
              <Input
                value={createValues.name}
                onChange={(event) =>
                  updateCreateValue("name", event.target.value)
                }
                placeholder={
                  kind === "endpoint"
                    ? t("Production LLM")
                    : t("Knowledge tools")
                }
              />
            </label>
            {kind === "mcp" && (
              <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                {t("Logo (optional)")}
                <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-2">
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-background p-1">
                    {createIconPreview ? (
                      // Uploaded MCP icons are served by JustAI and do not need
                      // a Next Image host allowlist.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt={t("Selected MCP logo preview")}
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
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <input
                      ref={createIconInputRef}
                      type="file"
                      className="hidden"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
                      onChange={(event) =>
                        chooseCreateIcon(event.target.files?.[0] ?? null)
                      }
                    />
                    <p className="truncate text-sm font-medium">
                      {createIconFile?.name ??
                        (createIconPreview
                          ? t("Logo selected")
                          : t("No logo selected"))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "PNG, JPEG, GIF, WebP, or ICO · Max 2 MB · optimized on upload"
                      )}
                    </p>
                    <div className="pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => createIconInputRef.current?.click()}
                      >
                        <ImagePlus
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {createIconPreview
                          ? t("Replace logo")
                          : t("Choose logo")}
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
                          {t("Remove logo")}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </label>
            )}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
              <span className="font-medium">{t("Scope")}</span>
              <Select
                items={{
                  global: t("Global"),
                  organization: t("Workspace"),
                  user: t("Personal"),
                }}
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
                    <SelectItem value="global">{t("Global")}</SelectItem>
                    <SelectItem value="organization">
                      {t("Organization")}
                    </SelectItem>
                    <SelectItem value="user">{t("User")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {createValues.scopeType !== "global" && (
              <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                {t("Scope ID")}
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
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                  <span className="font-medium">{t("Provider")}</span>
                  <Select
                    items={{
                      "openai-compatible": "OpenAI-compatible",
                      openai: "OpenAI",
                      gemini: "Gemini",
                      anthropic: "Anthropic",
                      ollama: "Ollama",
                      mock: "JustAI demo",
                    }}
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
                          {t("OpenAI-compatible")}
                        </SelectItem>
                        <SelectItem value="openai">OpenAI</SelectItem>
                        <SelectItem value="gemini">Gemini</SelectItem>
                        <SelectItem value="anthropic">Anthropic</SelectItem>
                        <SelectItem value="ollama">Ollama</SelectItem>
                        <SelectItem value="mock">{t("JustAI demo")}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                  {t("Base URL")}
                  <Input
                    value={createValues.baseUrl}
                    onChange={(event) =>
                      updateCreateValue("baseUrl", event.target.value)
                    }
                    placeholder="https://gateway.example/v1"
                  />
                </label>
                <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                  {t("Chat model")}
                  <Input
                    value={createValues.chatModel}
                    onChange={(event) =>
                      updateCreateValue("chatModel", event.target.value)
                    }
                    placeholder="model-name"
                  />
                </label>
                <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                  {t("API key or token")}
                  <Input
                    type="password"
                    value={createValues.credential}
                    onChange={(event) =>
                      updateCreateValue("credential", event.target.value)
                    }
                    placeholder={t("Stored encrypted on the backend")}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                  {t("MCP endpoint URL")}
                  <Input
                    value={createValues.endpointUrl}
                    onChange={(event) =>
                      updateCreateValue("endpointUrl", event.target.value)
                    }
                    placeholder="https://tools.example/mcp"
                  />
                </label>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                  <span className="font-medium">{t("Authentication")}</span>
                  <Select
                    items={{
                      none: t("No auth"),
                      api_key: "Bearer token",
                      oauth: "OAuth 2.1",
                    }}
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
                        <SelectItem value="none">{t("No auth")}</SelectItem>
                        <SelectItem value="api_key">
                          {t("Bearer token")}
                        </SelectItem>
                        <SelectItem value="oauth">OAuth 2.1</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {(createValues.authType === "none" ||
                    createValues.authType === "oauth") && (
                    <p className="text-xs text-muted-foreground">
                      {createValues.authType === "none"
                        ? t("No credential is sent to this server.")
                        : t(
                            "Sign in with the provider after saving; JustAI manages the access and refresh tokens."
                          )}
                    </p>
                  )}
                </div>
                {createValues.authType !== "none" && (
                  <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                    {createValues.authType === "oauth"
                      ? t("Access token (optional)")
                      : t("Bearer token")}
                    <Input
                      type="password"
                      value={createValues.credential}
                      onChange={(event) =>
                        updateCreateValue("credential", event.target.value)
                      }
                      placeholder={
                        createValues.authType === "oauth"
                          ? t("Leave blank to authorize after saving")
                          : t("Paste the token from your MCP provider")
                      }
                    />
                    {createValues.authType === "oauth" && (
                      <span className="text-xs text-muted-foreground">
                        {t("Leave blank to authorize after saving.")}
                      </span>
                    )}
                  </label>
                )}
                {createValues.authType === "oauth" && (
                  <>
                    <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                      {t("OAuth client ID")}
                      <Input
                        value={createValues.oauthClientId}
                        onChange={(event) =>
                          updateCreateValue("oauthClientId", event.target.value)
                        }
                        placeholder={t("Client ID")}
                      />
                    </label>
                    <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                      {t("Authorization URL (optional)")}
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
                    <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                      {t("Token URL (optional)")}
                      <Input
                        value={createValues.oauthTokenUrl}
                        onChange={(event) =>
                          updateCreateValue("oauthTokenUrl", event.target.value)
                        }
                        placeholder="https://provider.example/token"
                      />
                    </label>
                    <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                      {t("OAuth scopes (optional)")}
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
              {t("Cancel")}
            </Button>
            <Button disabled={createBusy} onClick={() => void createResource()}>
              {createBusy ? t("Creating…") : t("Create")}
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
  if (value.ok === false) return "down"
  if (failures > 0) return "warning"
  if (value.ok === true) return "healthy"

  const signals = Object.values(value).filter(
    (item): item is boolean => typeof item === "boolean"
  )
  if (signals.length > 0) return signals.every(Boolean) ? "healthy" : "down"
  return "unknown"
}

function HealthStatusBadge({ state }: { state: HealthState }) {
  const { t } = useTranslations()

  const Icon =
    state === "healthy"
      ? CheckCircle2
      : state === "unknown"
        ? Activity
        : AlertTriangle
  const label =
    state === "healthy"
      ? t("Operational")
      : state === "warning"
        ? t("Degraded")
        : state === "down"
          ? t("Unavailable")
          : t("Unknown")
  const variant =
    state === "healthy"
      ? "success"
      : state === "down"
        ? "destructive"
        : state === "warning"
          ? "warning"
          : "secondary"
  return (
    <Badge variant={variant}>
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
  const { t } = useTranslations()
  return (
    <div className="min-w-0 py-1">
      <p className="text-xs text-muted-foreground">{t(label)}</p>
      <p className="mt-1 text-base font-semibold tracking-tight">{t(value)}</p>
      {detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{t(detail)}</p>
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
  const { t, locale } = useTranslations()

  if (!health) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("Service health")}</CardTitle>
          <CardDescription>
            {t(
              "Runtime checks for the platform services and background workers."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {t("Loading health checks…")}
        </CardContent>
      </Card>
    )
  }

  const database = health?.database ?? {}
  const providers = health?.providers ?? {}
  const mcp = health?.mcp ?? {}
  const agents = health?.agents ?? {}
  const workers = health?.workers ?? {}
  const providerFailures = Number(providers.recentFailures ?? 0)
  const mcpFailures = Number(mcp.failures ?? 0)
  const states = [
    healthState(database),
    healthState(providers),
    healthState(mcp),
    healthState(agents),
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
      ? checkedAt.toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null
  const enabledProviders = Number(providers.enabled ?? 0)
  const totalProviders = Number(providers.total ?? 0)
  const enabledMcp = Number(mcp.enabled ?? 0)
  const totalMcp = Number(mcp.total ?? 0)
  const workerDetails = Array.isArray(workers.details) ? workers.details : []
  const workerEntries = [
    ["RAG worker", workers.rag],
    ["Transcription worker", workers.transcription],
    ["Agent worker", workers.agents],
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("Service health")}</CardTitle>
            <CardDescription>
              {t(
                "Runtime checks for the platform services and background workers."
              )}
            </CardDescription>
          </div>
          <CardAction className="flex flex-col items-end gap-1.5">
            <HealthStatusBadge state={overallState} />
            {checkedLabel && (
              <span className="text-xs text-muted-foreground">
                {t("Checked at")} {checkedLabel}
              </span>
            )}
          </CardAction>
        </CardHeader>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <HealthPanel
          description={t("PostgreSQL connectivity and readiness.")}
          icon={Database}
          state={healthState(database)}
          title={t("Database")}
        >
          <HealthMetric
            detail="Primary application store"
            label={t("Connection")}
            value={database.ok ? "Connected" : "Unavailable"}
          />
        </HealthPanel>
        <HealthPanel
          description={t(
            "Configured model endpoints and recent request failures."
          )}
          icon={Globe2}
          state={healthState(providers)}
          title={t("Providers")}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthMetric
              detail={t("{count} configured", { count: totalProviders })}
              label={t("Enabled")}
              value={`${enabledProviders} / ${totalProviders}`}
            />
            <HealthMetric
              detail="Last hour"
              label={t("Recent failures")}
              value={String(providerFailures)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description={t("Connected tool servers and MCP execution.")}
          icon={Wrench}
          state={healthState(mcp)}
          title="MCP"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthMetric
              detail={t("{count} configured", { count: totalMcp })}
              label={t("Enabled")}
              value={`${enabledMcp} / ${totalMcp}`}
            />
            <HealthMetric
              detail="Across configured servers"
              label={t("Failures")}
              value={String(mcpFailures)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description={t(
            "Agent execution, durable runs, and approval backlog."
          )}
          icon={Activity}
          state={healthState(agents)}
          title={t("Agents")}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <HealthMetric
              detail="Native and remote"
              label={t("Configured")}
              value={String(agents.total ?? 0)}
            />
            <HealthMetric
              detail="Currently active"
              label={t("Runs")}
              value={String(agents.activeRuns ?? 0)}
            />
            <HealthMetric
              detail="Awaiting a decision"
              label={t("Approvals")}
              value={String(agents.pendingApprovals ?? 0)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description={t(
            "Background jobs that keep retrieval and transcription moving."
          )}
          icon={Activity}
          state={healthState(workers)}
          title={t("Workers")}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {workerEntries.map(([label, value]) => (
              <div
                className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2.5"
                key={label}
              >
                <span className="text-sm">{t(label)}</span>
                <Badge variant={value ? "success" : "destructive"}>
                  {value ? t("Online") : t("Offline")}
                </Badge>
              </div>
            ))}
          </div>
          {workerDetails.length > 0 && (
            <details className="mt-3 border-t border-border pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {t("Heartbeat diagnostics")}
              </summary>
              <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
                {workerDetails.map((worker: any, index: number) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    key={`${worker.name}-${worker.instanceId ?? index}`}
                  >
                    <span className="font-medium">
                      {String(worker.name)
                        .replace(/[-_]/g, " ")
                        .replace(/^./, (value) => value.toUpperCase())}
                      {worker.instanceId
                        ? ` · ${String(worker.instanceId).slice(0, 8)}`
                        : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {worker.heartbeatAgeSeconds >= 0
                        ? t("{value0}s since heartbeat", {
                            value0: worker.heartbeatAgeSeconds,
                          })
                        : worker.started
                          ? t("Awaiting heartbeat")
                          : t("Not started")}
                      {worker.lastError ? ` · ${worker.lastError}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </HealthPanel>
      </div>

      {(providerFailures > 0 || mcpFailures > 0) && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("Recent service failures")}</AlertTitle>
          <AlertDescription>
            {providerFailures > 0 &&
              t("{value0} provider {value1} recorded in the last hour.", {
                value0: providerFailures,
                value1: t(providerFailures === 1 ? "failure" : "failures"),
              })}
            {providerFailures > 0 && mcpFailures > 0 && " "}
            {mcpFailures > 0 &&
              t("{value0} MCP {value1} reported.", {
                value0: mcpFailures,
                value1: t(mcpFailures === 1 ? "failure" : "failures"),
              })}
          </AlertDescription>
        </Alert>
      )}
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
  const { t, locale } = useTranslations()

  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null)
  const setFilter = (key: string, value: string) =>
    onFiltersChange({ ...filters, [key]: value })
  const advancedFilterCount = Object.entries(filters).filter(
    ([key, value]) => key !== "search" && Boolean(value.trim())
  ).length
  const hasActiveFilters = Object.values(filters).some((value) =>
    Boolean(value.trim())
  )
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Collapsible
          className="flex flex-col gap-2"
          onOpenChange={setMoreFiltersOpen}
          open={moreFiltersOpen}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              aria-label={t("Audit search")}
              className="min-w-0 flex-1"
              onChange={(event) => setFilter("search", event.target.value)}
              placeholder={t("Search actions or details")}
              value={filters.search}
            />
            <div className="flex flex-wrap items-center gap-2">
              <CollapsibleTrigger
                className="gap-1.5 sm:w-auto"
                render={<Button size="sm" variant="outline" />}
              >
                <SlidersHorizontal data-icon="inline-start" />
                {moreFiltersOpen ? t("Hide filters") : t("More filters")}
                {advancedFilterCount > 0 ? (
                  <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                    {advancedFilterCount}
                  </span>
                ) : null}
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 transition-transform",
                    moreFiltersOpen && "rotate-180"
                  )}
                />
              </CollapsibleTrigger>
              {hasActiveFilters ? (
                <Button
                  className="shrink-0"
                  onClick={() =>
                    onFiltersChange({
                      search: "",
                      action: "",
                      resourceType: "",
                      actorId: "",
                      organizationId: "",
                      from: "",
                      to: "",
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  <X data-icon="inline-start" /> {t("Clear filters")}
                </Button>
              ) : null}
            </div>
          </div>
          <CollapsibleContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              aria-label={t("Audit action")}
              onChange={(event) => setFilter("action", event.target.value)}
              placeholder={t("Action")}
              value={filters.action}
            />
            <Input
              aria-label={t("Audit resource type")}
              onChange={(event) =>
                setFilter("resourceType", event.target.value)
              }
              placeholder={t("Resource type")}
              value={filters.resourceType}
            />
            <Input
              aria-label={t("Audit actor")}
              onChange={(event) => setFilter("actorId", event.target.value)}
              placeholder={t("Actor user ID")}
              value={filters.actorId}
            />
            <Input
              aria-label={t("Audit organization")}
              onChange={(event) =>
                setFilter("organizationId", event.target.value)
              }
              placeholder={t("Organization ID")}
              value={filters.organizationId}
            />
            <Input
              aria-label={t("Audit from")}
              onChange={(event) => setFilter("from", event.target.value)}
              placeholder={t("From (YYYY-MM-DD)")}
              value={filters.from}
            />
            <Input
              aria-label={t("Audit to")}
              onChange={(event) => setFilter("to", event.target.value)}
              placeholder={t("To (YYYY-MM-DD)")}
              value={filters.to}
            />
          </CollapsibleContent>
        </Collapsible>
        {events.map((event) => (
          <button
            className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border px-2 py-3 text-left text-xs transition-colors last:border-0 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            key={event.id}
            onClick={() => setSelectedEvent(event)}
            type="button"
          >
            <div className="min-w-0 flex-1 break-all">
              <p className="font-medium">{event.action}</p>
              <p className="text-muted-foreground">
                {event.resourceType} · {event.resourceId ?? "—"}
              </p>
            </div>
            <Badge
              variant={
                event.outcome && event.outcome !== "success"
                  ? "destructive"
                  : "secondary"
              }
            >
              {t(
                event.outcome && event.outcome !== "success"
                  ? "Failed"
                  : "Success"
              )}
            </Badge>
            <time className="text-muted-foreground">
              {event.createdAt
                ? new Date(event.createdAt).toLocaleString(locale)
                : ""}
            </time>
          </button>
        ))}
        {events.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("No audit events found.")}
          </p>
        )}
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {total
            ? t("{start}–{end} of {total}", {
                start: (page - 1) * pageSize + 1,
                end: Math.min((page - 1) * pageSize + events.length, total),
                total,
              })
            : t("No audit events found.")}
        </span>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          compact
        />
      </div>
      <Dialog
        open={selectedEvent !== null}
        onOpenChange={(open) => !open && setSelectedEvent(null)}
      >
        <DialogContent className="min-w-0 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-all">
              {selectedEvent?.action ?? t("Audit event")}
            </DialogTitle>
            <DialogDescription className="break-all">
              {selectedEvent?.resourceType ?? "—"} ·{" "}
              {selectedEvent?.resourceId ?? "No resource ID"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <AuditDetail label={t("Actor")} value={selectedEvent?.userId} />
            <AuditDetail
              label={t("Organization")}
              value={selectedEvent?.organizationId}
            />
            <AuditDetail
              label={t("Outcome")}
              value={selectedEvent?.outcome ?? "success"}
            />
            <AuditDetail
              label={t("Request ID")}
              value={selectedEvent?.requestId}
            />
            <AuditDetail
              label={t("IP address")}
              value={selectedEvent?.ipAddress}
            />
            <AuditDetail
              label={t("Time")}
              value={
                selectedEvent?.createdAt
                  ? new Date(selectedEvent.createdAt).toLocaleString(locale)
                  : undefined
              }
            />
          </div>
          {selectedEvent?.userAgent && (
            <AuditDetail
              label={t("User agent")}
              value={selectedEvent.userAgent}
            />
          )}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t("Details")}
            </p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-muted/50 p-3 text-xs break-words whitespace-pre-wrap">
              {formatAuditDetails(selectedEvent?.details)}
            </pre>
          </div>
          <DialogFooter>
            <Button onClick={() => setSelectedEvent(null)} variant="outline">
              {t("Close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function formatAuditDetails(value: unknown) {
  if (value == null || value === "") return "No additional details."
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function AuditDetail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs break-words">
        {value == null || value === "" ? "—" : String(value)}
      </p>
    </div>
  )
}
