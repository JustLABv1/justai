"use client"

import { useEffect, useState, type ReactNode } from "react"
import {
  Activity,
  ArrowUpRight,
  Download,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { api } from "@/lib/api"
import type { AdminAnalyticsResponse } from "@/lib/types"
import {
  activityCategoryLabels,
  activityOutcomeLabels,
  insightsDays,
  type ActivityEntry,
  type AnalyticsInsights,
} from "@/lib/analytics-insights"
import { EvilAreaChart } from "@/components/evilcharts/charts/recharts-area-chart"
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart"
import { AnalyticsEntityFilter } from "@/components/analytics-entity-filter"
import { PlatformStatCard } from "@/components/platform-stat-card"
import { PlatformTranscriptionWorkers } from "@/components/platform-transcription-workers"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tabs,
  ScrollableTabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
import { avatarToneFor, initialsFor } from "@/lib/identity"

const views = {
  overview: "Usage overview",
  users: "People",
  workspaces: "Workspaces",
  tools: "MCP usage",
  activity: "Activity timeline",
  operations: "Performance",
}
type View = keyof typeof views
const outcomeVariants = {
  success: "success",
  failed: "destructive",
  cancelled: "secondary",
  pending: "warning",
} as const

export function PlatformAnalyticsView({
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
  const { t, locale } = useTranslations()
  const [view, setView] = useState<View>("overview")
  const [customRange, setCustomRange] = useState(false)
  const [category, setCategory] = useState("")
  const [outcome, setOutcome] = useState("")
  const [search, setSearch] = useState("")
  const [serverId, setServerId] = useState("")
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    key: string
    scope: string
    data: AnalyticsInsights
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const [selected, setSelected] = useState<ActivityEntry | null>(null)
  const scope = JSON.stringify([
    filters.days,
    filters.minutes,
    filters.from,
    filters.to,
    filters.organizationId,
    filters.userId,
  ])
  const query = new URLSearchParams({
    days: filters.days || "30",
    page: String(page),
    pageSize: "25",
    category,
    outcome,
    search,
    serverId,
  })
  for (const key of ["minutes", "from", "to", "organizationId", "userId"])
    if (filters[key]) query.set(key, filters[key])
  const queryString = query.toString()
  const requestKey = `${queryString}:${revision}`
  const data = result?.scope === scope ? result.data : null
  const activityReady = result?.key === requestKey
  const loading = !activityReady && failure?.key !== requestKey
  const error = failure?.key === requestKey ? failure.message : ""

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api
        .get<AnalyticsInsights>(
          `/api/v1/admin/analytics/insights?${queryString}`,
          { signal: controller.signal }
        )
        .then((data) => {
          if (!controller.signal.aborted) {
            setResult({ key: requestKey, scope, data })
            setPage((current) =>
              Math.min(
                current,
                Math.max(1, Math.ceil(data.activity.total / data.pageSize))
              )
            )
            setFailure(null)
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setFailure({
              key: requestKey,
              message:
                error instanceof Error
                  ? error.message
                  : "Analytics could not be loaded.",
            })
        })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [queryString, requestKey, scope])

  const setFilter = (key: string, value: string) => {
    setPage(1)
    onFiltersChange({ ...filters, [key]: value })
  }
  const changeScope = (key: string, value: string) => {
    setServerId("")
    setPage(1)
    onFiltersChange({ ...filters, [key]: value })
  }
  const focusActivity = (options: {
    user?: string
    workspace?: string
    server?: string
  }) => {
    if (options.user) changeScope("userId", options.user)
    if (options.workspace) changeScope("organizationId", options.workspace)
    setCategory(options.server ? "mcp" : "")
    setServerId(options.server || "")
    setOutcome("")
    setSearch("")
    setPage(1)
    setView("activity")
  }
  const number = (value: number | undefined) =>
    value === undefined ? "—" : new Intl.NumberFormat(locale).format(value)
  const dateTime = (value: string) => new Date(value).toLocaleString(locale)
  const metadataValue = (key: string, value: unknown) => {
    if (typeof value === "boolean") return t(value ? "Yes" : "No")
    if (key === "status" && typeof value === "string")
      return t(
        (
          {
            complete: "Completed",
            completed: "Completed",
            failed: "Failed",
            error: "Failed",
            cancelled: "Cancelled",
            running: "Running",
            queued: "Queued",
            waiting: "Waiting",
            waiting_approval: "Requires action",
            "requires-action": "Requires action",
            processing: "Processing",
            paused: "Paused",
            live: "Live",
          } as Record<string, string>
        )[value] || value
      )
    if (
      (key === "startedAt" || key === "finishedAt") &&
      typeof value === "string"
    )
      return dateTime(value)
    return String(value)
  }
  const formatDay = (value: string) =>
    value.length > 10
      ? new Intl.DateTimeFormat(locale, {
          ...(data?.bucket === "hour"
            ? { day: "numeric", month: "short" }
            : {}),
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(`${value}:00Z`))
      : new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${value}T00:00:00Z`))
  const days = data
    ? insightsDays(data).map((day) => ({ ...day, label: formatDay(day.date) }))
    : []
  const features = data
    ? [
        { label: t("Model requests"), value: data.summary.chatRuns },
        { label: t("MCP tools"), value: data.summary.mcpCalls },
        { label: t("Agent runs"), value: data.summary.agentRuns },
        { label: t("Transcriptions"), value: data.summary.transcriptions },
      ]
    : []
  const trendConfig = {
    chatRuns: {
      label: t("Model requests"),
      colors: { light: ["var(--chart-1)"], dark: ["var(--chart-1)"] },
    },
    mcpCalls: {
      label: t("MCP tools"),
      colors: { light: ["var(--chart-2)"], dark: ["var(--chart-2)"] },
    },
    agentRuns: {
      label: t("Agent runs"),
      colors: { light: ["var(--chart-3)"], dark: ["var(--chart-3)"] },
    },
    transcriptions: {
      label: t("Transcriptions"),
      colors: { light: ["var(--chart-4)"], dark: ["var(--chart-4)"] },
    },
  }
  const activeUser = data?.users.find((user) => user.id === filters.userId)
  const activeWorkspace = data?.workspaces.find(
    (workspace) => workspace.id === filters.organizationId
  )
  const minuteOptions = [
    ["5", "Last 5 minutes"],
    ["30", "Last 30 minutes"],
    ["60", "Last hour"],
    ["120", "Last 2 hours"],
    ["300", "Last 5 hours"],
    ["720", "Last 12 hours"],
    ["1440", "Last 24 hours"],
  ] as const
  const rangeLabel =
    filters.from || filters.to
      ? t("Custom range")
      : filters.minutes
        ? t(
            minuteOptions.find(([value]) => value === filters.minutes)?.[1] ||
              "Last 24 hours"
          )
        : t("Last {count} days", { count: filters.days || "30" })
  const totalPages = Math.max(1, Math.ceil((data?.activity.total || 0) / 25))

  const exportActivity = () => {
    if (!data || !activityReady) return
    // Export only the displayed metadata, with spreadsheet-formula escaping.
    const cell = (value: unknown) => {
      const text = String(value ?? "")
      return `"${(/^[\s]*[=+@\-]|^[\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`
    }
    const rows = [
      [
        "Time (UTC)",
        "User",
        "Workspace",
        "Category",
        "Action",
        "Outcome",
        "MCP server",
        "Tool",
      ],
      ...data.activity.items.map((item) => [
        item.occurredAt,
        item.userName,
        item.workspaceName,
        item.category,
        item.action,
        item.outcome,
        item.serverName,
        item.tool,
      ]),
    ]
    const url = URL.createObjectURL(
      new Blob([rows.map((row) => row.map(cell).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "analytics-activity-page.csv"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={
                customRange || filters.from || filters.to
                  ? "custom"
                  : filters.minutes
                    ? `m${filters.minutes}`
                    : filters.days || "30"
              }
              onValueChange={(value) => {
                if (value === "custom") {
                  setCustomRange(true)
                  if (filters.minutes)
                    onFiltersChange({ ...filters, minutes: "" })
                } else if (value) {
                  setCustomRange(false)
                  setPage(1)
                  const isMinutes = value.startsWith("m")
                  onFiltersChange({
                    ...filters,
                    ...(isMinutes ? {} : { days: value }),
                    minutes: isMinutes ? value.slice(1) : "",
                    from: "",
                    to: "",
                  })
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={t("Date range")}>
                <SelectValue>{rangeLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {minuteOptions.map(([value, label]) => (
                    <SelectItem key={value} value={`m${value}`}>
                      {t(label)}
                    </SelectItem>
                  ))}
                  {["7", "30", "90", "365"].map((value) => (
                    <SelectItem key={value} value={value}>
                      {t("Last {count} days", { count: value })}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">{t("Custom range")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {(customRange || filters.from || filters.to) && (
              <>
                <Input
                  type="date"
                  className="h-8 w-36"
                  aria-label={t("From")}
                  value={filters.from || ""}
                  max={filters.to || undefined}
                  onChange={(event) => setFilter("from", event.target.value)}
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  type="date"
                  className="h-8 w-36"
                  aria-label={t("To")}
                  value={filters.to || ""}
                  min={filters.from || undefined}
                  onChange={(event) => setFilter("to", event.target.value)}
                />
              </>
            )}
            <AnalyticsEntityFilter
              kind="users"
              value={filters.userId || ""}
              label={activeUser?.name}
              onChange={(value) => changeScope("userId", value)}
            />
            <AnalyticsEntityFilter
              kind="workspaces"
              value={filters.organizationId || ""}
              label={activeWorkspace?.name}
              onChange={(value) => changeScope("organizationId", value)}
            />
            {(filters.userId ||
              filters.organizationId ||
              filters.from ||
              filters.to ||
              filters.minutes ||
              customRange) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPage(1)
                  setServerId("")
                  setCustomRange(false)
                  onFiltersChange({
                    days: filters.days || "30",
                    minutes: "",
                    from: "",
                    to: "",
                    organizationId: "",
                    userId: "",
                    endpointId: "",
                    model: "",
                    status: "",
                  })
                }}
              >
                <X data-icon="inline-start" />
                {t("Clear filters")}
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="outline"
              className="ml-auto"
              aria-label={t("Refresh")}
              title={t("Refresh")}
              disabled={loading}
              onClick={() => {
                setRevision(revision + 1)
                onRefresh()
              }}
            >
              <RefreshCw />
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t(error)}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRevision(revision + 1)}
            >
              {t("Try again")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!data ? (
        !error && (
          <div aria-busy="true" className="flex flex-col gap-4">
            <div className="grid gap-4 md:grid-cols-3">
              {[1, 2, 3].map((key) => (
                <Skeleton key={key} className="h-40 w-full" />
              ))}
            </div>
            <Skeleton className="h-80 w-full" />
          </div>
        )
      ) : (
        <>
          <div className="grid min-w-0 gap-4 @3xl:grid-cols-3">
            <PlatformStatCard
              title={t("Active users")}
              period={rangeLabel}
              value={number(data.summary.activeUsers)}
              color="#00b884"
              points={days.map((day) => ({ value: day.activeUsers }))}
            />
            <PlatformStatCard
              title={t("Model requests")}
              period={rangeLabel}
              value={number(data.summary.chatRuns)}
              color="#2f7bff"
              points={days.map((day) => ({ value: day.chatRuns }))}
            />
            <PlatformStatCard
              title={t("MCP tool calls")}
              period={rangeLabel}
              value={number(data.summary.mcpCalls)}
              color="#8b46ff"
              points={days.map((day) => ({ value: day.mcpCalls }))}
            />
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 px-1 text-xs text-muted-foreground">
            <span>
              {t(
                data.summary.activeWorkspaces === 1
                  ? "{count} active workspace"
                  : "{count} active workspaces",
                { count: number(data.summary.activeWorkspaces) }
              )}
            </span>
            <span>
              {t(
                data.summary.agentRuns === 1
                  ? "{count} agent run"
                  : "{count} agent runs",
                { count: number(data.summary.agentRuns) }
              )}
            </span>
            <span>
              {t(
                data.summary.transcriptions === 1
                  ? "{count} transcription"
                  : "{count} transcriptions",
                { count: number(data.summary.transcriptions) }
              )}
            </span>
            <span
              className={
                data.summary.mcpFailures ? "text-destructive" : undefined
              }
            >
              {t(
                data.summary.mcpFailures === 1
                  ? "{count} failed MCP call"
                  : "{count} failed MCP calls",
                { count: number(data.summary.mcpFailures) }
              )}
            </span>
          </div>
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as View)}
            className="gap-5"
          >
            <ScrollableTabsList
              variant="line"
              aria-label={t("Analytics views")}
            >
              {Object.entries(views).map(([id, label]) => (
                <TabsTrigger key={id} value={id}>
                  {t(label)}
                </TabsTrigger>
              ))}
            </ScrollableTabsList>
            <TabsContent value="overview" className="flex flex-col gap-5">
              <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("Activity over time")}</CardTitle>
                    <CardDescription>
                      {t("Recorded usage by UTC day")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {days.some(
                      (day) =>
                        day.chatRuns +
                          day.mcpCalls +
                          day.agentRuns +
                          day.transcriptions >
                        0
                    ) ? (
                      <EvilAreaChart
                        className="aspect-auto h-72 w-full"
                        data={days}
                        config={trendConfig}
                        stackType="stacked"
                        animationType="none"
                        chartProps={{
                          accessibilityLayer: true,
                          margin: { left: 0, right: 8, top: 8 },
                        }}
                      >
                        <EvilAreaChart.Grid stroke="var(--border)" />
                        <EvilAreaChart.XAxis dataKey="label" minTickGap={40} />
                        <EvilAreaChart.YAxis allowDecimals={false} width={32} />
                        <EvilAreaChart.Tooltip />
                        <EvilAreaChart.Legend isClickable align="left" />
                        {Object.keys(trendConfig).map((key) => (
                          <EvilAreaChart.Area
                            key={key}
                            dataKey={key}
                            variant="gradient"
                            strokeVariant="solid"
                            strokeWidth={1.8}
                            isClickable
                          />
                        ))}
                      </EvilAreaChart>
                    ) : (
                      <AnalyticsEmpty
                        text={t("No recorded usage in this period.")}
                      />
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>{t("Feature adoption")}</CardTitle>
                    <CardDescription>
                      {t("Recorded operations in this period")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {features.some((feature) => feature.value > 0) ? (
                      <EvilBarChart
                        className="aspect-auto h-72 w-full"
                        data={features}
                        config={{
                          value: {
                            label: t("Operations"),
                            colors: {
                              light: ["var(--chart-1)"],
                              dark: ["var(--chart-1)"],
                            },
                          },
                        }}
                        animationType="none"
                        layout="vertical"
                        chartProps={{ accessibilityLayer: true }}
                      >
                        <EvilBarChart.Grid stroke="var(--border)" />
                        <EvilBarChart.XAxis dataKey="label" />
                        <EvilBarChart.YAxis allowDecimals={false} width={30} />
                        <EvilBarChart.Tooltip />
                        <EvilBarChart.Bar dataKey="value" variant="gradient" />
                      </EvilBarChart>
                    ) : (
                      <AnalyticsEmpty
                        text={t("No recorded usage in this period.")}
                      />
                    )}
                  </CardContent>
                </Card>
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("Most active people")}</CardTitle>
                    <CardDescription>
                      {t("Open a person to inspect their activity")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col">
                    {data.users.slice(0, 5).map((user) => (
                      <button
                        key={user.id}
                        onClick={() => focusActivity({ user: user.id })}
                        className="flex min-w-0 items-center gap-3 rounded-lg py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Avatar size="sm">
                          <AvatarFallback className={avatarToneFor(user.id)}>
                            {initialsFor(user.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {user.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {number(user.chatRuns)} {t("requests")} ·{" "}
                          {number(user.mcpCalls)} MCP
                        </span>
                        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                    {!data.users.length && (
                      <AnalyticsEmpty
                        text={t("No active users in this period.")}
                      />
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>{t("Most used MCP tools")}</CardTitle>
                    <CardDescription>
                      {t("Completed calls, including failures")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {data.tools.slice(0, 5).map((tool) => (
                      <button
                        key={`${tool.serverId}:${tool.tool}`}
                        onClick={() => focusActivity({ server: tool.serverId })}
                        className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {tool.tool}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {tool.serverName}
                          </span>
                        </span>
                        <span className="text-sm tabular-nums">
                          {number(tool.calls)}
                        </span>
                      </button>
                    ))}
                    {!data.tools.length && (
                      <AnalyticsEmpty
                        text={t("No completed MCP calls in this period.")}
                      />
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
            <TabsContent value="users">
              <AnalyticsTable
                title={t("People")}
                description={t("Top 50 people by recorded activity")}
                headers={[
                  t("User"),
                  t("Requests"),
                  t("MCP calls"),
                  t("Agent runs"),
                  t("Transcriptions"),
                  t("Last active"),
                ]}
                empty={!data.users.length}
              >
                {data.users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-3">
                      <button
                        onClick={() => focusActivity({ user: user.id })}
                        className="rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block font-medium">{user.name}</span>
                        <span className="block text-muted-foreground">
                          {user.email}
                        </span>
                      </button>
                    </td>
                    {[
                      user.chatRuns,
                      user.mcpCalls,
                      user.agentRuns,
                      user.transcriptions,
                    ].map((value, index) => (
                      <td key={index} className="p-3 tabular-nums">
                        {number(value)}
                      </td>
                    ))}
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {dateTime(user.lastActive)}
                    </td>
                  </tr>
                ))}
              </AnalyticsTable>
            </TabsContent>
            <TabsContent value="workspaces">
              <AnalyticsTable
                title={t("Workspaces")}
                description={t("Top 50 workspaces by recorded activity")}
                headers={[
                  t("Workspace"),
                  t("Active users"),
                  t("Requests"),
                  t("MCP calls"),
                  t("Agent runs"),
                  t("Transcriptions"),
                ]}
                empty={!data.workspaces.length}
              >
                {data.workspaces.map((workspace) => (
                  <tr
                    key={workspace.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-3">
                      <button
                        onClick={() =>
                          focusActivity({ workspace: workspace.id })
                        }
                        className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {workspace.name}
                      </button>
                    </td>
                    {[
                      workspace.activeUsers,
                      workspace.chatRuns,
                      workspace.mcpCalls,
                      workspace.agentRuns,
                      workspace.transcriptions,
                    ].map((value, index) => (
                      <td key={index} className="p-3 tabular-nums">
                        {number(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </AnalyticsTable>
            </TabsContent>
            <TabsContent value="tools">
              <AnalyticsTable
                title={t("MCP usage")}
                description={t(
                  "Top 50 tools by completed calls. Select a server to open its activity."
                )}
                headers={[
                  t("Tool / server"),
                  t("Calls"),
                  t("Failures"),
                  t("Users"),
                  t("Last used"),
                ]}
                empty={!data.tools.length}
              >
                {data.tools.map((tool) => (
                  <tr
                    key={`${tool.serverId}:${tool.tool}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-3">
                      <button
                        onClick={() => focusActivity({ server: tool.serverId })}
                        className="rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block font-medium">
                          {tool.tool || t("Unknown tool")}
                        </span>
                        <span className="block text-muted-foreground">
                          {tool.serverName}
                        </span>
                      </button>
                    </td>
                    <td className="p-3 tabular-nums">{number(tool.calls)}</td>
                    <td className="p-3">
                      <Badge
                        variant={tool.failed ? "destructive" : "secondary"}
                      >
                        {number(tool.failed)}
                      </Badge>
                    </td>
                    <td className="p-3 tabular-nums">{number(tool.users)}</td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {dateTime(tool.lastUsed)}
                    </td>
                  </tr>
                ))}
              </AnalyticsTable>
            </TabsContent>
            <TabsContent value="activity">
              <Card>
                <div className="flex flex-wrap items-center gap-2 px-4">
                  <div className="relative min-w-48 flex-1">
                    <Search
                      className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      className="h-8 pl-8"
                      aria-label={t("Search activity")}
                      placeholder={t(
                        "Search people, tools, models or actions…"
                      )}
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value)
                        setPage(1)
                      }}
                    />
                  </div>
                  <Select
                    value={category || "all"}
                    onValueChange={(value) => {
                      setCategory(value === "all" ? "" : value || "")
                      setPage(1)
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={t("Activity type")}>
                      <SelectValue>
                        {t(
                          activityCategoryLabels[
                            category as keyof typeof activityCategoryLabels
                          ] || "All activity"
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">{t("All activity")}</SelectItem>
                        {Object.entries(activityCategoryLabels).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {t(label)}
                            </SelectItem>
                          )
                        )}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Select
                    value={outcome || "all"}
                    onValueChange={(value) => {
                      setOutcome(value === "all" ? "" : value || "")
                      setPage(1)
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={t("Outcome")}>
                      <SelectValue>
                        {t(
                          activityOutcomeLabels[
                            outcome as keyof typeof activityOutcomeLabels
                          ] || "All outcomes"
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">{t("All outcomes")}</SelectItem>
                        {Object.entries(activityOutcomeLabels).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {t(label)}
                            </SelectItem>
                          )
                        )}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {(search || category || outcome || serverId) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSearch("")
                        setCategory("")
                        setOutcome("")
                        setServerId("")
                        setPage(1)
                      }}
                    >
                      {t("Clear filters")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!activityReady || !data.activity.items.length}
                    onClick={exportActivity}
                  >
                    <Download data-icon="inline-start" />
                    {t("Export page")}
                  </Button>
                </div>
                {serverId && (
                  <p className="px-4 text-xs text-muted-foreground">
                    {t("Activity is filtered to the selected MCP server.")}
                  </p>
                )}
                <CardContent
                  className="min-w-0 overflow-x-auto"
                  aria-busy={loading}
                >
                  {error ? (
                    <AnalyticsEmpty text={t("Activity could not be loaded.")} />
                  ) : !activityReady ? (
                    <Skeleton className="h-48 w-full" />
                  ) : !data.activity.items.length ? (
                    <AnalyticsEmpty
                      text={t("No activity matches these filters.")}
                    />
                  ) : (
                    <table className="w-full min-w-[44rem] text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          {[
                            "Time",
                            "User / workspace",
                            "Activity",
                            "Outcome",
                          ].map((label) => (
                            <th className="p-3 font-medium" key={label}>
                              {t(label)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.activity.items.map((item) => (
                          <tr
                            key={item.id}
                            className="border-b border-border last:border-0"
                          >
                            <td className="p-3 whitespace-nowrap text-muted-foreground">
                              {dateTime(item.occurredAt)}
                            </td>
                            <td className="max-w-48 p-3">
                              <p className="truncate font-medium">
                                {item.userId ? item.userName : t("System")}
                              </p>
                              <p className="truncate text-muted-foreground">
                                {item.organizationId
                                  ? item.workspaceName
                                  : t("Platform")}
                              </p>
                            </td>
                            <td className="max-w-xs p-3">
                              <button
                                className="max-w-full rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => setSelected(item)}
                              >
                                <span className="block truncate font-medium">
                                  {item.tool ||
                                    item.metadata.model ||
                                    t(activityCategoryLabels[item.category])}
                                </span>
                                <span className="block truncate text-muted-foreground">
                                  {item.serverName || item.action}
                                </span>
                              </button>
                            </td>
                            <td className="p-3">
                              <Badge
                                variant={
                                  outcomeVariants[item.outcome] || "secondary"
                                }
                              >
                                {t(
                                  activityOutcomeLabels[item.outcome] ||
                                    item.outcome
                                )}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
                  <span aria-live="polite">
                    {t(
                      data.activity.total === 1
                        ? "{count} recorded event"
                        : "{count} recorded events",
                      {
                        count: data.activity.total,
                      }
                    )}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loading || page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      {t("Previous page")}
                    </Button>
                    <span className="self-center px-2 tabular-nums">
                      {page} / {totalPages}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loading || page >= totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      {t("Next page")}
                    </Button>
                  </div>
                </div>
              </Card>
            </TabsContent>
            <TabsContent value="operations" className="flex flex-col gap-5">
              <Card>
                <CardHeader>
                  <CardTitle>{t("Model performance")}</CardTitle>
                  <CardDescription>
                    {t(
                      "Request outcomes, latency and provider-reported tokens"
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-5 md:grid-cols-4">
                    {[
                      ["Successful", number(analytics?.summary.succeeded)],
                      ["Errors", number(analytics?.summary.failed)],
                      [
                        "P95 latency",
                        analytics?.summary.requests
                          ? `${Math.round(analytics.summary.p95LatencyMs)} ms`
                          : "—",
                      ],
                      [
                        "Total tokens",
                        analytics?.summary.totalTokens == null
                          ? "—"
                          : number(analytics.summary.totalTokens),
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs text-muted-foreground">
                          {t(label)}
                        </dt>
                        <dd className="mt-2 text-2xl font-medium tabular-nums">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
              <AnalyticsTable
                title={t("Models & endpoints")}
                description={t(
                  "Usage follows the selected user, workspace and date filters."
                )}
                headers={[
                  t("Endpoint"),
                  t("Model"),
                  t("Requests"),
                  t("Errors"),
                  t("Average latency"),
                ]}
                empty={!analytics?.byEndpoint.length}
              >
                {analytics?.byEndpoint.map((item) => (
                  <tr
                    key={`${item.endpointId}:${item.model}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-3">{item.endpointName}</td>
                    <td className="p-3">{item.model || "—"}</td>
                    <td className="p-3">{number(item.requests)}</td>
                    <td className="p-3">{number(item.errors)}</td>
                    <td className="p-3">
                      {Math.round(item.averageLatencyMs)} ms
                    </td>
                  </tr>
                ))}
              </AnalyticsTable>
              {filters.userId ? (
                <Alert>
                  <AlertDescription>
                    {t(
                      "Clear the user filter to view worker infrastructure metrics."
                    )}
                  </AlertDescription>
                </Alert>
              ) : (
                <PlatformTranscriptionWorkers
                  analytics={analytics?.transcriptionWorkers}
                  detailed
                />
              )}
            </TabsContent>
          </Tabs>
          <details className="px-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("About this data")}</summary>
            <p className="mt-2 max-w-3xl leading-5">
              {t(
                "Activity includes recorded model requests, MCP events, agent runs, transcription sessions and audit events. Active users performed at least one recorded operation. MCP totals count completed calls once, including failures. Run records show their current outcome; audit events show what was recorded at that time. Charts use UTC days; the timeline uses your local time."
              )}
            </p>
          </details>
        </>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="min-w-0 sm:max-w-2xl">
          <DialogHeader className="min-w-0 pr-6">
            <DialogTitle className="break-all">
              {selected?.tool || selected?.metadata.model || selected?.action}
            </DialogTitle>
            <DialogDescription>
              {selected && dateTime(selected.occurredAt)}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {t(activityCategoryLabels[selected.category])}
                </Badge>
                <Badge
                  variant={outcomeVariants[selected.outcome] || "secondary"}
                >
                  {t(
                    activityOutcomeLabels[selected.outcome] || selected.outcome
                  )}
                </Badge>
                <Badge variant="outline">
                  {t(
                    selected.id.startsWith("audit:")
                      ? "Audit event"
                      : "Run record"
                  )}
                </Badge>
              </div>
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                {[
                  [
                    "User",
                    `${selected.userName}${selected.userEmail ? ` · ${selected.userEmail}` : ""}`,
                  ],
                  [
                    "Workspace",
                    selected.organizationId
                      ? selected.workspaceName
                      : t("Platform"),
                  ],
                  ["Action", selected.action],
                  ["Time (UTC)", new Date(selected.occurredAt).toISOString()],
                  ["MCP server", selected.serverName],
                  ["Tool", selected.tool],
                  ...Object.entries(selected.metadata),
                ]
                  .filter(
                    ([, value]) =>
                      value !== null && value !== undefined && value !== ""
                  )
                  .map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {t(label)}
                      </dt>
                      <dd className="mt-1 text-sm break-all">
                        {metadataValue(String(label), value)}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AnalyticsEmpty({ text }: { text: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Activity className="size-5" aria-hidden="true" />
      {text}
    </div>
  )
}
function AnalyticsTable({
  title,
  description,
  headers,
  empty,
  children,
}: {
  title: string
  description: string
  headers: string[]
  empty: boolean
  children: ReactNode
}) {
  const { t } = useTranslations()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 overflow-x-auto">
        {empty ? (
          <AnalyticsEmpty text={t("No recorded usage in this period.")} />
        ) : (
          <table className="w-full min-w-[38rem] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                {headers.map((label) => (
                  <th className="p-3 font-medium" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
