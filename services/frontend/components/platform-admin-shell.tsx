"use client"
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

import { useCallback, useEffect, useState } from "react"
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  Database,
  SlidersHorizontal,
  Globe2,
  KeyRound,
  Megaphone,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  Wrench,
  X,
} from "lucide-react"

import { APIError, api } from "@/lib/api"
import type {
  AdminAnalyticsResponse,
  AdminDashboardResponse,
  AdminTab,
  Endpoint,
  PlatformSettings,
  User,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { notifyError, notifySuccess } from "@/lib/feedback"
import {
  PlatformControlsView,
  type PlatformControlKey,
} from "@/components/platform-controls-view"
import { PlatformWorkspacesView } from "@/components/platform-workspaces-view"
import { PlatformUsersView } from "@/components/platform-users-view"
import { PlatformHealthView } from "@/components/platform-health-view"
import { PlatformAdminDashboard } from "@/components/platform-admin-dashboard"
import { MCPView } from "@/components/mcp-view"
import { EndpointsView } from "@/components/endpoints-view"
import { PlatformAnnouncementsView } from "@/components/platform-announcements-view"
import { PlatformAuthenticationView } from "@/components/platform-authentication-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Page, PageActions, PageTitle } from "@/components/ui/page"
import { Tabs } from "@/components/panelui/tabs"
import { Button as PanelButton } from "@/components/panelui/button"
import { Alert as PanelAlert } from "@/components/panelui/alert"
import { PlatformAnalyticsView } from "@/components/platform-analytics-view"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
      <PanelButton
        onClick={() => setEndpointCreateRequest((value) => value + 1)}
      >
        <Plus data-icon="inline-start" aria-hidden="true" /> {t("Add endpoint")}
      </PanelButton>
    ) : activeTab === "mcp" ? (
      <PanelButton onClick={() => setMcpCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" />{" "}
        {t("Add MCP server")}
      </PanelButton>
    ) : activeTab === "authentication" ? (
      <PanelButton
        onClick={() => setAuthenticationCreateRequest((value) => value + 1)}
      >
        <Plus data-icon="inline-start" aria-hidden="true" /> {t("Add provider")}
      </PanelButton>
    ) : activeTab === "announcements" ? (
      <PanelButton
        onClick={() => setAnnouncementCreateRequest((value) => value + 1)}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />{" "}
        {t("Add announcement")}
      </PanelButton>
    ) : null

  if (!user.platformAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-12">
        <PanelAlert tone="destructive" variant="plain">
          <PanelAlert.Title>
            {t("Platform administrator access required")}
          </PanelAlert.Title>
          <PanelAlert.Description>
            {t("This area is restricted to platform administrators.")}
          </PanelAlert.Description>
        </PanelAlert>
      </div>
    )
  }

  return (
    <Page>
      <PageTitle>{t("Platform administration")}</PageTitle>
      <PageActions>
        {pageAction}
        <PanelButton
          aria-label={t("Refresh admin data")}
          onClick={() => void load()}
          variant="outline"
          size="sm"
        >
          <RefreshCw data-icon="inline-start" /> {t("Refresh")}
        </PanelButton>
      </PageActions>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (!value) return
          setListPage(1)
          setListStatus("")
          onTabChange(value as AdminTab)
        }}
        className="gap-6"
      >
        <Tabs.List aria-label={t("Platform administration")}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <Tabs.Trigger key={id} value={id}>
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content key={activeTab} value={activeTab} className="min-w-0">
          {error && (
            <PanelAlert className="mb-4" tone="destructive" variant="plain">
              <PanelAlert.Title>{t("Admin request failed")}</PanelAlert.Title>
              <PanelAlert.Description>{t(error)}</PanelAlert.Description>
            </PanelAlert>
          )}

          {activeTab === "overview" && (
            <PlatformAdminDashboard
              dashboard={dashboard}
              onTabChange={onTabChange}
            />
          )}
          {activeTab === "controls" && (
            <PlatformControlsView
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
                <PlatformUsersView
                  query={query}
                  status={listStatus}
                  onQueryChange={(value) => {
                    setListPage(1)
                    setQuery(value)
                  }}
                  onStatusChange={(value) => {
                    setListPage(1)
                    setListStatus(value)
                  }}
                  users={users}
                  onUpdate={updateUser}
                  onReload={() => void load()}
                  page={listPage}
                  pageSize={25}
                  total={listTotal}
                  onPageChange={setListPage}
                />
              ) : (
                <PlatformWorkspacesView
                  query={query}
                  status={listStatus}
                  onQueryChange={(value) => {
                    setListPage(1)
                    setQuery(value)
                  }}
                  onStatusChange={(value) => {
                    setListPage(1)
                    setListStatus(value)
                  }}
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
            <MCPView
              servers={servers}
              onChange={setServers}
              platformAdmin
              userId={user.id}
              apiBasePath="/api/v1/admin/mcp/servers"
              createRequest={mcpCreateRequest}
            />
          )}
          {activeTab === "health" && <PlatformHealthView health={health} />}
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
        </Tabs.Content>
      </Tabs>
    </Page>
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
