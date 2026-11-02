"use client"

import { useTranslations } from "@/components/locale-provider"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Bot, Cpu, Pencil, Plug, ShieldCheck, Users } from "lucide-react"

import { workspaceActivityDays } from "@/lib/workspace-activity"

import { compactNumber } from "@/components/admin-usage-charts"
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
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  AdminAnalyticsResponse,
  Endpoint,
  MCPServer,
  Organization,
} from "@/lib/types"

type WorkspaceSettingsDashboardProps = {
  organization: Organization
  memberCount: number
  membersLoading: boolean
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  analytics: AdminAnalyticsResponse | null
  analyticsLoading: boolean
  canManage: boolean
  onRename: () => void
}

function workspaceInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "W"
}

function WorkspaceActivity({
  analytics,
  loading,
}: {
  analytics: AdminAnalyticsResponse | null
  loading: boolean
}) {
  const { t, locale } = useTranslations()
  const data = workspaceActivityDays(analytics?.timeSeries ?? [])
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`))
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle>{t("Usage trends")}</CardTitle>
        <CardDescription>
          {t("Workspace runs over the last 90 days.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-56 w-full" />
        ) : data.some((day) => day.requests > 0) ? (
          <ChartContainer
            style={{ height: 224 }}
            config={{
              requests: { label: t("AI runs · 90d"), color: "var(--primary)" },
            }}
          >
            <BarChart
              accessibilityLayer
              data={data}
              margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
            >
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                axisLine={false}
                tickLine={false}
                ticks={[
                  data[0].date,
                  data[29].date,
                  data[59].date,
                  data[89].date,
                ]}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickMargin={12}
              />
              <YAxis
                width={32}
                tickCount={3}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
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
                maxBarSize={20}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
            {t("No activity for this period.")}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function WorkspaceSettingsDashboard({
  organization,
  memberCount,
  membersLoading,
  endpoints,
  mcpServers,
  analytics,
  analyticsLoading,
  canManage,
  onRename,
}: WorkspaceSettingsDashboardProps) {
  const { t, locale } = useTranslations()

  const enabledEndpoints = endpoints.filter(
    (endpoint) => endpoint.enabled
  ).length
  const enabledServers = mcpServers.filter((server) => server.enabled).length
  const requests = analytics?.summary.requests ?? 0
  const successRate = requests
    ? Math.round(((analytics?.summary.succeeded ?? 0) / requests) * 100)
    : null

  const stats = [
    {
      label: t("Members"),
      value: membersLoading ? null : memberCount,
      icon: Users,
    },
    {
      label: t("AI runs · 90d"),
      value: analyticsLoading ? null : requests,
      icon: Bot,
    },
    {
      label: t("Success rate"),
      value: analyticsLoading
        ? null
        : successRate === null
          ? "—"
          : `${successRate}%`,
      icon: ShieldCheck,
    },
    { label: t("Connected tools"), value: enabledServers, icon: Plug },
  ]

  return (
    <div className="flex flex-col gap-5">
      <Card size="sm">
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground">
            {workspaceInitial(organization.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading truncate text-xl font-semibold">
                {organization.name}
              </h2>
              <Badge variant="secondary">{t("Current workspace")}</Badge>
              <Badge variant="outline">{organization.role || "member"}</Badge>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {organization.slug}
            </p>
          </div>
          {canManage && (
            <Button onClick={onRename} size="sm" variant="outline">
              <Pencil data-icon="inline-start" /> {t("Rename")}
            </Button>
          )}
        </CardContent>
      </Card>

      <dl className="grid grid-cols-2 gap-6 rounded-2xl bg-muted/40 p-6 sm:grid-cols-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex flex-col gap-3">
            <dt className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </dt>
            <dd className="font-heading text-3xl font-medium tracking-tight tabular-nums">
              {value === null ? (
                <Skeleton className="h-9 w-16" />
              ) : typeof value === "number" ? (
                compactNumber(value, locale)
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        {canManage && (
          <WorkspaceActivity analytics={analytics} loading={analyticsLoading} />
        )}
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("Workspace stack")}</CardTitle>
            <CardDescription>
              {t("Connected capacity at a glance.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {[
              {
                label: t("Endpoints enabled"),
                value: enabledEndpoints,
                total: endpoints.length,
                icon: Cpu,
              },
              {
                label: t("MCP servers enabled"),
                value: enabledServers,
                total: mcpServers.length,
                icon: Plug,
              },
            ].map(({ label, value, total, icon: Icon }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-xl bg-muted/50 p-4"
              >
                <Icon
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="flex-1 text-sm">{label}</span>
                <span className="text-sm font-medium tabular-nums">
                  {value} / {total}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
