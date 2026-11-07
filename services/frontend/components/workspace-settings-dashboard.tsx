"use client"

import { useMemo } from "react"
import { useTranslations } from "@/components/locale-provider"
import { Bot, Cpu, Pencil, Plug, ShieldCheck, Users } from "lucide-react"

import { workspaceActivityDays } from "@/lib/workspace-activity"

import { compactNumber } from "@/components/admin-usage-charts"
import { Avatar } from "@/components/panelui/avatar"
import { Badge } from "@/components/panelui/badge"
import { BarChart } from "@/components/panelui/bar-chart"
import { Button } from "@/components/panelui/button"
import { Card } from "@/components/panelui/card"
import { Frame } from "@/components/panelui/frame"
import { Stat } from "@/components/panelui/stat"
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

function WorkspaceActivity({
  analytics,
  loading,
}: {
  analytics: AdminAnalyticsResponse | null
  loading: boolean
}) {
  const { t, locale } = useTranslations()
  // 90 daily bars would be hairlines, so show the same window by week.
  const data = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    const days = workspaceActivityDays(analytics?.timeSeries ?? [])
    const weeks: { name: string; requests: number }[] = []
    for (let end = days.length; end > 0; end -= 7) {
      const chunk = days.slice(Math.max(0, end - 7), end)
      weeks.unshift({
        name: format.format(new Date(`${chunk[0].date}T00:00:00Z`)),
        requests: chunk.reduce((sum, day) => sum + day.requests, 0),
      })
    }
    return weeks
  }, [analytics, locale])
  const total = data.reduce((sum, day) => sum + day.requests, 0)
  return (
    <Card className="min-w-0">
      <Card.Content>
        {loading ? (
          <Skeleton className="h-56 w-full rounded-xl" />
        ) : total > 0 ? (
          <BarChart
            aspectRatio={3}
            data={data}
            label={t("Workspace runs over the last 90 days.")}
            xDataKey="name"
          >
            <BarChart.Header
              caption={t("Workspace runs over the last 90 days.")}
              title={t("Usage trends")}
              value={compactNumber(total, locale)}
            />
            <BarChart.Grid rows={4} />
            <BarChart.Bar color="info" dataKey="requests" />
            <BarChart.XAxis ticks={7} />
            <BarChart.YAxis />
            <BarChart.Tooltip labels={{ requests: t("AI runs · 90d") }} />
          </BarChart>
        ) : (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
            {t("No activity for this period.")}
          </div>
        )}
      </Card.Content>
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
      <Card>
        <Card.Content className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar name={organization.name} shape="square" size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold tracking-tight">
                {organization.name}
              </h2>
              <Badge size="sm" variant="secondary">
                {t("Current workspace")}
              </Badge>
              <Badge size="sm" variant="outline">
                {organization.role || "member"}
              </Badge>
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
        </Card.Content>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <Card.Content className="flex items-start justify-between gap-3">
              <Stat>
                <Stat.Content>
                  <Stat.Label>{label}</Stat.Label>
                  <Stat.Value size="md">
                    {value === null ? (
                      <Skeleton className="h-7 w-14" />
                    ) : typeof value === "number" ? (
                      compactNumber(value, locale)
                    ) : (
                      value
                    )}
                  </Stat.Value>
                </Stat.Content>
              </Stat>
              <Icon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Card.Content>
          </Card>
        ))}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        {canManage && (
          <WorkspaceActivity analytics={analytics} loading={analyticsLoading} />
        )}
        <Frame>
          <Frame.Header>
            <Frame.Title>{t("Workspace stack")}</Frame.Title>
            <Frame.Description>
              {t("Connected capacity at a glance.")}
            </Frame.Description>
          </Frame.Header>
          <Frame.Panel>
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
              <Frame.Row key={label}>
                <Frame.Media>
                  <Icon aria-hidden="true" />
                </Frame.Media>
                <Frame.Content>
                  <Frame.Title as="p">{label}</Frame.Title>
                </Frame.Content>
                <Frame.Actions>
                  <Badge
                    size="sm"
                    variant={
                      value === total && total > 0 ? "success" : "outline"
                    }
                  >
                    {value} / {total}
                  </Badge>
                </Frame.Actions>
              </Frame.Row>
            ))}
          </Frame.Panel>
        </Frame>
      </div>
    </div>
  )
}
