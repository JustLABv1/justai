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
import { BarChart } from "@/components/panelui/bar-chart"
import { Frame } from "@/components/panelui/frame"
import { Stat } from "@/components/panelui/stat"
import { Kpi } from "@/components/panelui/kpi"
import { AnalyticsEntityFilter } from "@/components/analytics-entity-filter"
import { PlatformTranscriptionWorkers } from "@/components/platform-transcription-workers"
import { Alert } from "@/components/panelui/alert"
import { Avatar } from "@/components/panelui/avatar"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Dialog } from "@/components/panelui/dialog"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs } from "@/components/panelui/tabs"

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
  const trendLabels = {
    chatRuns: t("Model requests"),
    mcpCalls: t("MCP tools"),
    agentRuns: t("Agent runs"),
    transcriptions: t("Transcriptions"),
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
      <Frame>
        <Frame.Panel className="p-4">
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
        </Frame.Panel>
      </Frame>

      {error && (
        <Alert tone="destructive" variant="plain">
          <Alert.Description className="flex flex-wrap items-center justify-between gap-2">
            <span>{t(error)}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRevision(revision + 1)}
            >
              {t("Try again")}
            </Button>
          </Alert.Description>
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
            {[
              {
                title: "Active users",
                value: data.summary.activeUsers,
                points: days.map((day) => day.activeUsers),
                color: "success" as const,
              },
              {
                title: "Model requests",
                value: data.summary.chatRuns,
                points: days.map((day) => day.chatRuns),
                color: "primary" as const,
              },
              {
                title: "MCP tool calls",
                value: data.summary.mcpCalls,
                points: days.map((day) => day.mcpCalls),
                color: "info" as const,
              },
            ].map((item) => (
              <Frame key={item.title} variant="band">
                <Frame.Panel className="p-4">
                  <Stat>
                    <Stat.Content>
                      <Stat.Label>{t(item.title)}</Stat.Label>
                      <Stat.Value size="md">{number(item.value)}</Stat.Value>
                    </Stat.Content>
                  </Stat>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {rangeLabel}
                  </p>
                  <Kpi.Chart
                    className="mt-4"
                    data={item.points}
                    color={item.color}
                    height={48}
                    filled
                    aria-label={t(item.title)}
                  />
                </Frame.Panel>
              </Frame>
            ))}
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
            variant="segmented"
            value={view}
            onValueChange={(value) => setView(value as View)}
            className="gap-5"
          >
            <Tabs.List aria-label={t("Analytics views")}>
              {Object.entries(views).map(([id, label]) => (
                <Tabs.Trigger key={id} value={id}>
                  {t(label)}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value="overview" className="flex flex-col gap-5">
              <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Frame>
                  <Frame.Header>
                    <Frame.Title>{t("Activity over time")}</Frame.Title>
                    <Frame.Description>
                      {t("Recorded usage by UTC day")}
                    </Frame.Description>
                  </Frame.Header>
                  <Frame.Panel className="p-4">
                    {days.some(
                      (day) =>
                        day.chatRuns +
                          day.mcpCalls +
                          day.agentRuns +
                          day.transcriptions >
                        0
                    ) ? (
                      <BarChart
                        data={days}
                        xDataKey="label"
                        stacked
                        aspectRatio={2.4}
                        label={t("Activity over time")}
                        animationDuration={0}
                      >
                        <BarChart.Header legend labels={trendLabels} />
                        <BarChart.Grid />
                        <BarChart.XAxis />
                        <BarChart.YAxis format={(value) => number(value)} />
                        <BarChart.Bar dataKey="chatRuns" color="chart-1" />
                        <BarChart.Bar dataKey="mcpCalls" color="chart-2" />
                        <BarChart.Bar dataKey="agentRuns" color="chart-3" />
                        <BarChart.Bar
                          dataKey="transcriptions"
                          color="chart-4"
                        />
                        <BarChart.Tooltip
                          labels={trendLabels}
                          formatValue={(value) => number(value)}
                        />
                      </BarChart>
                    ) : (
                      <AnalyticsEmpty
                        text={t("No recorded usage in this period.")}
                      />
                    )}
                  </Frame.Panel>
                </Frame>
                <Frame>
                  <Frame.Header>
                    <Frame.Title>{t("Feature adoption")}</Frame.Title>
                    <Frame.Description>
                      {t("Recorded operations in this period")}
                    </Frame.Description>
                  </Frame.Header>
                  <Frame.Panel className="p-4">
                    {features.some((feature) => feature.value > 0) ? (
                      <BarChart
                        data={features}
                        xDataKey="label"
                        orientation="horizontal"
                        aspectRatio={1.3}
                        label={t("Feature adoption")}
                        animationDuration={0}
                      >
                        <BarChart.Grid />
                        <BarChart.Bar dataKey="value" color="primary" />
                        <BarChart.YAxis />
                        <BarChart.Tooltip
                          labels={{ value: t("Operations") }}
                          formatValue={(value) => number(value)}
                        />
                      </BarChart>
                    ) : (
                      <AnalyticsEmpty
                        text={t("No recorded usage in this period.")}
                      />
                    )}
                  </Frame.Panel>
                </Frame>
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <Frame>
                  <Frame.Header>
                    <Frame.Title>{t("Most active people")}</Frame.Title>
                    <Frame.Description>
                      {t("Open a person to inspect their activity")}
                    </Frame.Description>
                  </Frame.Header>
                  <Frame.Panel className="flex flex-col p-4">
                    {data.users.slice(0, 5).map((user) => (
                      <button
                        key={user.id}
                        onClick={() => focusActivity({ user: user.id })}
                        className="flex min-w-0 items-center gap-3 rounded-lg py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Avatar name={user.name} size="sm" />
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
                  </Frame.Panel>
                </Frame>
                <Frame>
                  <Frame.Header>
                    <Frame.Title>{t("Most used MCP tools")}</Frame.Title>
                    <Frame.Description>
                      {t("Completed calls, including failures")}
                    </Frame.Description>
                  </Frame.Header>
                  <Frame.Panel className="p-4">
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
                  </Frame.Panel>
                </Frame>
              </div>
            </Tabs.Content>
            <Tabs.Content value="users">
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
            </Tabs.Content>
            <Tabs.Content value="workspaces">
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
            </Tabs.Content>
            <Tabs.Content value="tools">
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
            </Tabs.Content>
            <Tabs.Content value="activity">
              <Frame>
                <div className="p-4">
                  <div className="grid grid-cols-2 items-center gap-2 @3xl:grid-cols-[minmax(0,1fr)_11rem_11rem]">
                    <Input.Group className="col-span-2 @3xl:col-span-1">
                      <Input.Addon>
                        <Search className="size-4" aria-hidden="true" />
                      </Input.Addon>
                      <Input
                        className="h-8"
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
                    </Input.Group>
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
                          <SelectItem value="all">
                            {t("All activity")}
                          </SelectItem>
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
                          <SelectItem value="all">
                            {t("All outcomes")}
                          </SelectItem>
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
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
                </div>
                {serverId && (
                  <p className="px-4 text-xs text-muted-foreground">
                    {t("Activity is filtered to the selected MCP server.")}
                  </p>
                )}
                <Frame.Panel
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
                </Frame.Panel>
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
              </Frame>
            </Tabs.Content>
            <Tabs.Content value="operations" className="flex flex-col gap-5">
              <Frame>
                <Frame.Header>
                  <Frame.Title>{t("Model performance")}</Frame.Title>
                  <Frame.Description>
                    {t(
                      "Request outcomes, latency and provider-reported tokens"
                    )}
                  </Frame.Description>
                </Frame.Header>
                <Frame.Panel className="p-4">
                  <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
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
                      <Stat key={label}>
                        <Stat.Content>
                          <Stat.Label>{t(label)}</Stat.Label>
                          <Stat.Value size="sm">{value}</Stat.Value>
                        </Stat.Content>
                      </Stat>
                    ))}
                  </div>
                </Frame.Panel>
              </Frame>
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
                <Alert tone="info" variant="plain">
                  <Alert.Description>
                    {t(
                      "Clear the user filter to view worker infrastructure metrics."
                    )}
                  </Alert.Description>
                </Alert>
              ) : (
                <PlatformTranscriptionWorkers
                  analytics={analytics?.transcriptionWorkers}
                  detailed
                />
              )}
            </Tabs.Content>
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
        <Dialog.Content className="min-w-0 sm:max-w-2xl">
          <Dialog.Header className="min-w-0 pr-6">
            <Dialog.Title className="break-all">
              {selected?.tool || selected?.metadata.model || selected?.action}
            </Dialog.Title>
            <Dialog.Description>
              {selected && dateTime(selected.occurredAt)}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
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
                      activityOutcomeLabels[selected.outcome] ||
                        selected.outcome
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
          </Dialog.Body>
        </Dialog.Content>
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
    <Frame>
      <Frame.Header>
        <Frame.Title>{title}</Frame.Title>
        <Frame.Description>{description}</Frame.Description>
      </Frame.Header>
      <Frame.Panel className="min-w-0 overflow-x-auto p-4">
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
      </Frame.Panel>
    </Frame>
  )
}
