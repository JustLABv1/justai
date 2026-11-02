"use client"

import { useTranslations } from "@/components/locale-provider"
import { useMemo } from "react"
import {
  Activity,
  Bot,
  Cpu,
  Pencil,
  Plug,
  ShieldCheck,
  Users,
} from "lucide-react"

import {
  AdminUsageCharts,
  compactNumber,
} from "@/components/admin-usage-charts"
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
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  AdminAnalyticsResponse,
  Endpoint,
  MCPServer,
  Organization,
} from "@/lib/types"
import { cn } from "@/lib/utils"

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
  onArchive: () => void
  onDelete: () => void
  onLeave: () => void
}

function workspaceInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "W"
}

function ActivityHeatmap({
  analytics,
}: {
  analytics: AdminAnalyticsResponse | null
}) {
  const { t, locale } = useTranslations()
  const dayLabel = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  })

  const days = useMemo(() => {
    const counts = new Map(
      (analytics?.timeSeries ?? []).map((day) => [day.date, day.requests])
    )
    const end = new Date()
    end.setHours(12, 0, 0, 0)
    const start = new Date(end)
    start.setDate(start.getDate() - 90 - start.getDay())
    const result: Array<{ key: string; count: number; date: Date }> = []
    const cursor = new Date(start)
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`
      result.push({ key, count: counts.get(key) ?? 0, date: new Date(cursor) })
      cursor.setDate(cursor.getDate() + 1)
    }
    return result
  }, [analytics])
  const max = Math.max(1, ...days.map((day) => day.count))

  return (
    <Card className="h-full" size="sm">
      <CardHeader>
        <CardTitle>{t("Activity rhythm")}</CardTitle>
        <CardDescription>
          {t("Workspace runs over the last 90 days.")}
        </CardDescription>
        <CardAction>
          <Activity
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="pb-1">
          <div className="mx-auto grid w-full max-w-lg auto-cols-fr grid-flow-col grid-rows-7 gap-1">
            {days.map((day) => {
              const ratio = day.count / max
              const level =
                day.count === 0
                  ? 0
                  : ratio > 0.66
                    ? 4
                    : ratio > 0.33
                      ? 3
                      : ratio > 0.12
                        ? 2
                        : 1
              return (
                <span
                  aria-label={t("{value0} runs on {value1}", {
                    value0: day.count,
                    value1: dayLabel.format(day.date),
                  })}
                  className={cn(
                    "aspect-square w-full rounded-[4px] bg-muted",
                    level === 1 && "bg-primary/25",
                    level === 2 && "bg-primary/45",
                    level === 3 && "bg-primary/70",
                    level === 4 && "bg-primary"
                  )}
                  key={day.key}
                  role="img"
                  title={t("{value0} runs on {value1}", {
                    value0: day.count,
                    value1: dayLabel.format(day.date),
                  })}
                />
              )
            })}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>{t("Less")}</span>
          {[
            "bg-muted",
            "bg-primary/25",
            "bg-primary/45",
            "bg-primary/70",
            "bg-primary",
          ].map((color) => (
            <span className={cn("size-2.5 rounded-[3px]", color)} key={color} />
          ))}
          <span>{t("More")}</span>
        </div>
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
  onArchive,
  onDelete,
  onLeave,
}: WorkspaceSettingsDashboardProps) {
  const { t, locale } = useTranslations()

  const enabledEndpoints = endpoints.filter(
    (endpoint) => endpoint.enabled
  ).length
  const enabledServers = mcpServers.filter((server) => server.enabled).length
  const requests = analytics?.summary.requests ?? 0
  const successRate = requests
    ? Math.round(((analytics?.summary.succeeded ?? 0) / requests) * 100)
    : 100

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
      value: analyticsLoading ? null : `${successRate}%`,
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card size="sm" key={label}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardAction>
                <Icon
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </CardAction>
            </CardHeader>
            <CardContent>
              {value === null ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <p className="font-heading text-2xl font-semibold tracking-tight">
                  {typeof value === "number"
                    ? compactNumber(value, locale)
                    : value}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ActivityHeatmap analytics={analytics} />
        <Card className="h-full" size="sm">
          <CardHeader>
            <CardTitle>{t("Workspace stack")}</CardTitle>
            <CardDescription>
              {t("Connected capacity at a glance.")}
            </CardDescription>
            <CardAction>
              <Cpu
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {[
              {
                label: t("Endpoints enabled"),
                value: enabledEndpoints,
                total: endpoints.length,
              },
              {
                label: t("MCP servers enabled"),
                value: enabledServers,
                total: mcpServers.length,
              },
              {
                label: t("Successful runs"),
                value: successRate,
                total: 100,
                suffix: "%",
              },
            ].map((item) => (
              <div className="flex flex-col gap-2" key={item.label}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{item.label}</span>
                  <span className="font-medium tabular-nums">
                    {item.value}
                    {item.suffix ?? ` / ${item.total}`}
                  </span>
                </div>
                <Progress
                  aria-label={item.label}
                  value={item.total ? (item.value / item.total) * 100 : 0}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {canManage && !analyticsLoading && (
        <AdminUsageCharts analytics={analytics} />
      )}

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("Workspace lifecycle")}</CardTitle>
          <CardDescription>
            {t("Archive, leave, or permanently remove this workspace.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Archiving hides the workspace without deleting its content. Permanent deletion cannot be undone."
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {organization.role !== "owner" ? (
              <Button onClick={onLeave} variant="outline">
                {t("Leave workspace")}
              </Button>
            ) : (
              <>
                <Button onClick={onArchive} variant="outline">
                  {t("Archive workspace")}
                </Button>
                <Button onClick={onDelete} variant="destructive">
                  {t("Delete workspace")}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
