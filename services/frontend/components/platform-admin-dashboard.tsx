"use client"

import { AlertTriangle, ArrowUpRight, CheckCircle2 } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { useTranslations } from "@/components/locale-provider"
import { compactNumber } from "@/components/admin-usage-charts"
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
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { PlatformStatCard } from "@/components/platform-stat-card"
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
        className="@container flex min-w-0 flex-col gap-8"
        aria-label={t("Loading platform overview…")}
        aria-busy="true"
      >
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
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
  const formatNumber = (value: number) =>
    new Intl.NumberFormat(locale).format(value)
  const formatDay = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`))
  const data = workspaceActivityDays(usage.timeSeries)
    .slice(-30)
    .map((day) => ({ ...day, label: formatDay(day.date) }))
  const daily = new Map(usage.timeSeries.map((day) => [day.date, day]))
  const metrics = [
    {
      label: "Requests",
      value: formatNumber(usage.summary.requests),
      color: "#00b884",
      points: data.map((day) => ({ value: day.requests })),
    },
    {
      label: "Success rate",
      value: usage.summary.requests
        ? `${Math.round((usage.summary.succeeded / usage.summary.requests) * 100)}%`
        : "—",
      color: "#2f7bff",
      domain: [0, 100] as [number, number],
      points: data.map((day) => {
        const entry = daily.get(day.date)
        return {
          value: entry?.requests
            ? (entry.succeeded / entry.requests) * 100
            : null,
        }
      }),
    },
    {
      label: "Average latency",
      value: usage.summary.requests
        ? `${formatNumber(Math.round(usage.summary.averageLatencyMs))} ms`
        : "—",
      color: "#8b46ff",
      points: data.map((day) => {
        const entry = daily.get(day.date)
        return { value: entry?.requests ? entry.averageLatencyMs : null }
      }),
    },
  ]

  return (
    <div className="@container flex min-w-0 flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-sm">
          {operational ? (
            <CheckCircle2
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="size-4 text-destructive"
              aria-hidden="true"
            />
          )}
          <span className="font-medium">
            {t(
              operational
                ? "All systems operational"
                : "Some systems need attention"
            )}
          </span>
          {attention.length > 0 && (
            <Badge variant="secondary">
              {t(attention.length === 1 ? "{count} item" : "{count} items", {
                count: attention.length,
              })}
            </Badge>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onTabChange("health")}>
          {t("View system health")}
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 @3xl:grid-cols-3">
        {metrics.map((metric) => (
          <PlatformStatCard
            key={metric.label}
            title={t(metric.label)}
            period={t("Last 30 days")}
            value={metric.value}
            color={metric.color}
            points={metric.points}
            domain={metric.domain}
          />
        ))}
      </div>

      {attention.length > 0 && (
        <section
          aria-label={t("Attention required")}
          className="flex flex-col gap-2"
        >
          {attention.map((item) => (
            <Alert
              key={item.id}
              variant={
                item.severity === "critical"
                  ? "destructive"
                  : item.severity === "warning"
                    ? "warning"
                    : "default"
              }
              className="p-4"
            >
              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <AlertTitle className="flex items-start gap-2">
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {t(item.title)}
                      {item.metric != null && ` · ${formatNumber(item.metric)}`}
                    </span>
                  </AlertTitle>
                  <AlertDescription className="mt-1 pl-6">
                    {t(item.description)}
                  </AlertDescription>
                </div>
                <Button
                  className="justify-self-start sm:justify-self-end"
                  size="sm"
                  variant="ghost"
                  onClick={() => onTabChange(item.tab)}
                >
                  {t("Review")}
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              </div>
            </Alert>
          ))}
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("Request activity")}</CardTitle>
          <CardDescription>{t("Last 30 days")}</CardDescription>
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onTabChange("analytics")}
            >
              {t("View analytics")}
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {usage.summary.requests > 0 ? (
            <ChartContainer
              style={{ height: 240 }}
              config={{
                requests: { label: t("Requests"), color: "var(--primary)" },
              }}
            >
              <BarChart
                accessibilityLayer
                data={data}
                margin={{ top: 8, right: 8, bottom: 4 }}
              >
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="label"
                  ticks={[
                    data[0].label,
                    data[9].label,
                    data[19].label,
                    data[29].label,
                  ]}
                  axisLine={false}
                  tickLine={false}
                  tickMargin={12}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                />
                <YAxis
                  width={32}
                  allowDecimals={false}
                  tickCount={3}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  tickFormatter={(value) => compactNumber(value, locale)}
                />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
                  content={<ChartTooltipContent />}
                />
                <Bar
                  dataKey="requests"
                  fill="var(--primary)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={24}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
              {t("No activity for this period.")}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
