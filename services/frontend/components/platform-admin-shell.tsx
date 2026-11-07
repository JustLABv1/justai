"use client"
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

import { useCallback, useEffect, useState } from "react"
import {
  Activity,
  BarChart3,
  Database,
  Globe2,
  KeyRound,
  Megaphone,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  Wrench,
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
import { notifyError, notifySuccess } from "@/lib/feedback"
import {
  PlatformControlsView,
  type PlatformControlKey,
} from "@/components/platform-controls-view"
import { PlatformWorkspacesView } from "@/components/platform-workspaces-view"
import { PlatformUsersView } from "@/components/platform-users-view"
import { PlatformAuditView } from "@/components/platform-audit-view"
import { PlatformHealthView } from "@/components/platform-health-view"
import { PlatformAdminDashboard } from "@/components/platform-admin-dashboard"
import { MCPView } from "@/components/mcp-view"
import { EndpointsView } from "@/components/endpoints-view"
import { PlatformAnnouncementsView } from "@/components/platform-announcements-view"
import { PlatformAuthenticationView } from "@/components/platform-authentication-view"
import { Page, PageActions, PageTitle } from "@/components/ui/page"
import { Tabs } from "@/components/panelui/tabs"
import { Button as PanelButton } from "@/components/panelui/button"
import { Alert as PanelAlert } from "@/components/panelui/alert"
import { PlatformAnalyticsView } from "@/components/platform-analytics-view"
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
            <PlatformAuditView
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
