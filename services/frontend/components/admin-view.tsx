"use client"

import { useEffect, useMemo, useState } from "react"
import { BarChart3, Check, LoaderCircle, ShieldCheck } from "lucide-react"

import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { AdminAnalyticsResponse, Endpoint, MCPServer } from "@/lib/types"
import { AdminUsageCharts } from "@/components/admin-usage-charts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type DefaultsResponse = {
  endpointId: string | null
  mcpServerIds: string[]
}

type AdminViewProps = {
  organizationId: string | null
  organizationRole?: string
  platformAdmin?: boolean
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
}

export function AdminView({
  organizationId,
  organizationRole,
  platformAdmin = false,
  endpoints,
  mcpServers,
}: AdminViewProps) {
  const canManage =
    platformAdmin ||
    organizationRole === "owner" ||
    organizationRole === "admin"
  const [defaults, setDefaults] = useState<DefaultsResponse>({
    endpointId: null,
    mcpServerIds: [],
  })
  const [globalDefaults, setGlobalDefaults] = useState<DefaultsResponse>({
    endpointId: null,
    mcpServerIds: [],
  })
  const [analytics, setAnalytics] = useState<AdminAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingGlobal, setSavingGlobal] = useState(false)
  const [analyticsDays, setAnalyticsDays] = useState(30)
  const [notice, setNotice] = useState("")

  const enabledChatEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) =>
          endpoint.enabled &&
          (endpoint.capabilities?.chat === true ||
            Boolean(endpoint.chatModel?.trim()))
      ),
    [endpoints]
  )
  const globalChatEndpoints = useMemo(
    () =>
      enabledChatEndpoints.filter(
        (endpoint) => endpoint.scopeType === "global"
      ),
    [enabledChatEndpoints]
  )
  const enabledServers = useMemo(
    () => mcpServers.filter((server) => server.enabled),
    [mcpServers]
  )
  const analyticsRangeLabel =
    analyticsDays === 7
      ? "Last 7 days"
      : analyticsDays === 30
        ? "Last 30 days"
        : analyticsDays === 90
          ? "Last 90 days"
          : "Last year"

  useEffect(() => {
    if (!canManage || (!organizationId && !platformAdmin)) {
      return
    }
    let cancelled = false
    void Promise.all([
      platformAdmin
        ? api.get<DefaultsResponse>("/api/v1/admin/defaults")
        : api.get<DefaultsResponse>(
            `/api/v1/organizations/${organizationId}/admin/defaults`
          ),
      api.get<AdminAnalyticsResponse>(
        platformAdmin
          ? `/api/v1/admin/analytics?days=${analyticsDays}`
          : `/api/v1/organizations/${organizationId}/admin/analytics?days=${analyticsDays}`
      ),
    ])
      .then(([nextDefaults, nextAnalytics]) => {
        if (cancelled) return
        if (platformAdmin) {
          setGlobalDefaults(nextDefaults)
        } else {
          setDefaults(nextDefaults)
        }
        setAnalytics(nextAnalytics)
      })
      .catch((caught) => {
        if (!cancelled) {
          setNotice(
            caught instanceof Error
              ? caught.message
              : "Admin data could not be loaded."
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [analyticsDays, canManage, organizationId, platformAdmin])

  async function saveDefaults() {
    if (!organizationId || !canManage) return
    setSaving(true)
    setNotice("")
    try {
      await api.put(
        `/api/v1/organizations/${organizationId}/admin/defaults`,
        defaults
      )
      setNotice("Workspace defaults saved.")
      notifySuccess("Workspace defaults saved")
    } catch (caught) {
      setNotice(notifyError("Workspace defaults could not be saved", caught, "Defaults could not be saved."))
    } finally {
      setSaving(false)
    }
  }

  async function saveGlobalDefaults() {
    if (!platformAdmin) return
    setSavingGlobal(true)
    setNotice("")
    try {
      const next = await api.put<DefaultsResponse>("/api/v1/admin/defaults", {
        endpointId: globalDefaults.endpointId,
      })
      setGlobalDefaults(next)
      setNotice("Platform defaults saved.")
      notifySuccess("Platform defaults saved")
    } catch (caught) {
      setNotice(notifyError("Platform defaults could not be saved", caught, "Platform defaults could not be saved."))
    } finally {
      setSavingGlobal(false)
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck /> Workspace operations
          </CardTitle>
          <CardDescription>
            Organization owners and administrators can manage defaults and
            analytics.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" /> Loading workspace
        operations…
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      {notice && (
        <Alert>
          <AlertTitle>Operations update</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Card size="sm" className="gap-0">
        <CardHeader className="border-b pb-4">
          <CardTitle>New chat defaults</CardTitle>
          <CardDescription>
            These choices are applied when a new conversation is created.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4">
              <label className="block space-y-2 text-sm font-medium">
                <span className="block">Default chat endpoint</span>
                <Select
                  value={defaults.endpointId ?? "none"}
                  onValueChange={(value) =>
                    setDefaults((current) => ({
                      ...current,
                      endpointId: value === "none" ? null : value,
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose an endpoint" />
                  </SelectTrigger>
                  <SelectContent
                    align="start"
                    className="max-w-[calc(100vw-2rem)] min-w-[min(30rem,calc(100vw-2rem))]"
                  >
                    <SelectItem value="none">Use routing precedence</SelectItem>
                    {enabledChatEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} ·{" "}
                        {endpoint.chatModel || "model not configured"}
                      </SelectItem>
                    ))}
                    {enabledChatEndpoints.length === 0 && (
                      <SelectItem value="no-endpoints" disabled>
                        No enabled chat endpoints configured
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <span className="text-sm font-medium">Default MCP servers</span>
              <div className="mt-2 grid gap-1 rounded-lg border bg-muted/20 p-1">
                {enabledServers.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No enabled MCP servers.
                  </p>
                )}
                {enabledServers.map((server) => {
                  const selected = defaults.mcpServerIds.includes(server.id)
                  return (
                    <button
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${selected ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/70 bg-card hover:border-border hover:bg-muted/40"}`}
                      key={server.id}
                      onClick={() =>
                        setDefaults((current) => ({
                          ...current,
                          mcpServerIds: selected
                            ? current.mcpServerIds.filter(
                                (id) => id !== server.id
                              )
                            : [...current.mcpServerIds, server.id],
                        }))
                      }
                      type="button"
                    >
                      <span
                        className={`flex size-4 items-center justify-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                      >
                        {selected && <Check className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {server.name}
                      </span>
                      <span className="text-muted-foreground">
                        {server.toolCount ?? server.allowedTools.length} tools
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button disabled={saving} onClick={() => void saveDefaults()}>
              {saving && <LoaderCircle className="animate-spin" />} Save
              defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      {platformAdmin && (
        <Card size="sm" className="gap-0">
          <CardHeader className="border-b pb-4">
            <CardTitle>Platform defaults</CardTitle>
            <CardDescription>
              Fallback endpoint selection for organizations without an explicit
              default.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4 pt-4">
            <label className="min-w-64 flex-1 space-y-2 text-sm font-medium">
              <span className="block">Global chat endpoint</span>
              <Select
                value={globalDefaults.endpointId ?? "none"}
                onValueChange={(value) =>
                  setGlobalDefaults((current) => ({
                    ...current,
                    endpointId: value === "none" ? null : value,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose an endpoint" />
                </SelectTrigger>
                <SelectContent
                  align="start"
                  className="max-w-[calc(100vw-2rem)] min-w-[min(30rem,calc(100vw-2rem))]"
                >
                  <SelectItem value="none">
                    Use endpoint routing precedence
                  </SelectItem>
                  {globalChatEndpoints.map((endpoint) => (
                    <SelectItem key={endpoint.id} value={endpoint.id}>
                      {endpoint.name} ·{" "}
                      {endpoint.chatModel || "model not configured"}
                    </SelectItem>
                  ))}
                  {globalChatEndpoints.length === 0 && (
                    <SelectItem value="no-global-endpoints" disabled>
                      No global chat endpoints configured
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </label>
            <Button
              disabled={savingGlobal}
              onClick={() => void saveGlobalDefaults()}
            >
              {savingGlobal && <LoaderCircle className="animate-spin" />} Save
              platform default
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 /> Analytics
              </CardTitle>
              <CardDescription>
                Operational and usage metrics from chat runs.
              </CardDescription>
            </div>
            <Select
              value={String(analyticsDays)}
              onValueChange={(value) => setAnalyticsDays(Number(value))}
            >
              <SelectTrigger className="w-40">
                <SelectValue>{analyticsRangeLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="365">Last year</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {[
              ["Requests", analytics?.summary.requests ?? 0],
              [
                "Success rate",
                `${analytics?.summary.requests ? Math.round((analytics.summary.succeeded / analytics.summary.requests) * 100) : 0}%`,
              ],
              [
                "Avg latency",
                `${Math.round(analytics?.summary.averageLatencyMs ?? 0)} ms`,
              ],
              [
                "Avg TTFT",
                `${Math.round(analytics?.summary.averageTtftMs ?? 0)} ms`,
              ],
              ["Tool calls", analytics?.summary.toolCalls ?? 0],
              ["Total tokens", analytics?.summary.totalTokens ?? "—"],
            ].map(([label, value]) => (
              <div className="rounded-lg border bg-muted/20 p-3" key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-6">
            <AdminUsageCharts analytics={analytics} />
          </div>
          {analytics?.byEndpoint && analytics.byEndpoint.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Endpoint</th>
                    <th className="pb-2 font-medium">Model</th>
                    <th className="pb-2 font-medium">Requests</th>
                    <th className="pb-2 font-medium">Errors</th>
                    <th className="pb-2 font-medium">Avg latency</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.byEndpoint.map((item) => (
                    <tr
                      className="border-t"
                      key={`${item.endpointId}:${item.model}`}
                    >
                      <td className="py-2">{item.endpointName}</td>
                      <td className="py-2 text-muted-foreground">
                        {item.model || "—"}
                      </td>
                      <td className="py-2">{item.requests}</td>
                      <td className="py-2">{item.errors}</td>
                      <td className="py-2">
                        {Math.round(item.averageLatencyMs)} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {analytics?.timeSeries && analytics.timeSeries.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Day</th>
                    <th className="pb-2 font-medium">Requests</th>
                    <th className="pb-2 font-medium">Success</th>
                    <th className="pb-2 font-medium">Errors</th>
                    <th className="pb-2 font-medium">Avg latency</th>
                    <th className="pb-2 font-medium">Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.timeSeries.map((item) => (
                    <tr className="border-t" key={item.date}>
                      <td className="py-2">{item.date}</td>
                      <td className="py-2">{item.requests}</td>
                      <td className="py-2">{item.succeeded}</td>
                      <td className="py-2">{item.failed + item.cancelled}</td>
                      <td className="py-2">
                        {Math.round(item.averageLatencyMs)} ms
                      </td>
                      <td className="py-2">{item.toolCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {analytics?.summary.inputTokens == null && (
            <p className="mt-4 text-xs text-muted-foreground">
              Token usage is unavailable for the selected providers.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
