"use client"

import { useTranslations } from "@/components/locale-provider"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { BarChart } from "@/components/panelui/bar-chart"
import { Button } from "@/components/panelui/button"
import { Card } from "@/components/panelui/card"
import { Frame } from "@/components/panelui/frame"
import { Kpi } from "@/components/panelui/kpi"
import { Skeleton } from "@/components/ui/skeleton"
import { workspaceActivityDays } from "@/lib/workspace-activity"
import type { AdminDashboardResponse, AdminTab } from "@/lib/types"

export function PlatformAdminDashboard({
  dashboard,
  onTabChange,
}: {
  dashboard: AdminDashboardResponse | null
  onTabChange: (tab: AdminTab) => void
}) {
  const { t, locale } = useTranslations()
  if (!dashboard)
    return (
      <div
        className="flex min-w-0 flex-col gap-5"
        aria-label={t("Loading platform overview…")}
        aria-busy="true"
      >
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    )
  const { health, usage, attention } = dashboard
  const operational =
    health.database.ok &&
    health.providers.ok &&
    health.mcp.ok &&
    health.agents.ok &&
    health.workers.rag &&
    health.workers.transcription &&
    health.workers.agents
  const number = new Intl.NumberFormat(locale)
  const generatedAt = new Date(dashboard.generatedAt)
  const formatDay = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  const data = workspaceActivityDays(usage.timeSeries, generatedAt)
    .slice(-30)
    .map((day) => ({
      name: formatDay.format(new Date(`${day.date}T00:00:00Z`)),
      requests: day.requests,
    }))
  const metrics = [
    { label: "Requests", value: number.format(usage.summary.requests) },
    {
      label: "Success rate",
      value: usage.summary.requests
        ? `${Math.round((usage.summary.succeeded / usage.summary.requests) * 100)}%`
        : "—",
    },
    {
      label: "Average latency",
      value: usage.summary.requests
        ? `${number.format(Math.round(usage.summary.averageLatencyMs))} ms`
        : "—",
    },
  ]
  const inventory: Array<{ key: string; label: string; tab: AdminTab }> = [
    { key: "users", label: "Users", tab: "users" },
    { key: "workspaces", label: "Workspaces", tab: "workspaces" },
    { key: "endpoints", label: "Endpoints", tab: "endpoints" },
    { key: "mcpServers", label: "MCP servers", tab: "mcp" },
  ]
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={operational ? "success" : "destructive"}>
            {t(
              operational
                ? "All systems operational"
                : "Some systems need attention"
            )}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("Updated {value0}", {
              value0: generatedAt.toLocaleTimeString(locale, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onTabChange("health")}>
          {t("View system health")}
        </Button>
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-3">
        {metrics.map((metric) => (
          <Kpi key={metric.label} surface>
            <Kpi.Title>{t(metric.label)}</Kpi.Title>
            <Kpi.Value>{metric.value}</Kpi.Value>
            <Kpi.Footer>{t("Last 30 days")}</Kpi.Footer>
          </Kpi>
        ))}
      </div>
      {attention.length > 0 && (
        <section
          aria-label={t("Attention required")}
          className="flex flex-col gap-3"
        >
          {attention.map((item) => (
            <Alert
              key={item.id}
              tone={
                item.severity === "critical"
                  ? "destructive"
                  : item.severity === "warning"
                    ? "warning"
                    : "info"
              }
              variant="plain"
            >
              <Alert.Title>
                {t(item.title)}
                {item.metric != null && ` · ${number.format(item.metric)}`}
              </Alert.Title>
              <Alert.Description>{t(item.description)}</Alert.Description>
              <Alert.Actions>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onTabChange(item.tab)}
                >
                  {t("Review")}
                </Button>
              </Alert.Actions>
            </Alert>
          ))}
        </section>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
        <Card className="min-w-0">
          <Card.Header>
            <Card.Title>{t("Request activity")}</Card.Title>
            <Card.Description>
              {t("Last 30 days · daily requests")}
            </Card.Description>
            <Card.Action>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onTabChange("analytics")}
              >
                {t("View analytics")}
              </Button>
            </Card.Action>
          </Card.Header>
          <Card.Content>
            {data.some((day) => day.requests > 0) ? (
              <BarChart
                data={data}
                xDataKey="name"
                aspectRatio={2.6}
                label={t("Daily platform requests over the last 30 days")}
              >
                <BarChart.Grid rows={4} />
                <BarChart.Bar color="info" dataKey="requests" />
                <BarChart.XAxis ticks={6} />
                <BarChart.YAxis />
                <BarChart.Tooltip labels={{ requests: t("Requests") }} />
              </BarChart>
            ) : (
              <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                {t("No activity for this period.")}
              </div>
            )}
          </Card.Content>
        </Card>
        <Frame>
          <Frame.Header>
            <Frame.Title>{t("Platform inventory")}</Frame.Title>
            <Frame.Description>
              {t("Manage people, workspaces and connections.")}
            </Frame.Description>
          </Frame.Header>
          <Frame.Panel>
            {inventory.map((item) => (
              <Frame.Row
                key={item.key}
                onClick={() => onTabChange(item.tab)}
                chevron
              >
                <Frame.Content>
                  <Frame.Title as="p">{t(item.label)}</Frame.Title>
                </Frame.Content>
                <Frame.Actions>
                  <span className="text-sm font-medium tabular-nums">
                    {dashboard.counts[item.key] == null
                      ? "—"
                      : number.format(dashboard.counts[item.key])}
                  </span>
                </Frame.Actions>
              </Frame.Row>
            ))}
          </Frame.Panel>
        </Frame>
      </div>
    </div>
  )
}
