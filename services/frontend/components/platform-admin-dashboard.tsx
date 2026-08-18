"use client"

import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import type {
  AdminAttentionItem,
  AdminDashboardResponse,
  AdminTab,
} from "@/lib/types"
import { AdminUsageCharts, compactNumber } from "@/components/admin-usage-charts"
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

function number(value: number | null | undefined) {
  if (value == null) return "—"
  return new Intl.NumberFormat("en").format(value)
}

function percentage(succeeded: number, requests: number) {
  if (!requests) return "—"
  return `${Math.round((succeeded / requests) * 100)}%`
}

function attentionIcon(severity: AdminAttentionItem["severity"]) {
  if (severity === "critical" || severity === "warning") return Alert02Icon
  return InformationCircleIcon
}

function attentionVariant(severity: AdminAttentionItem["severity"]) {
  if (severity === "critical") return "destructive" as const
  if (severity === "warning") return "outline" as const
  return "secondary" as const
}

function actionLabel(action: string) {
  return action
    .replace(/^platform\./, "")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase())
}

export function PlatformAdminDashboard({
  dashboard,
  onTabChange,
}: {
  dashboard: AdminDashboardResponse | null
  onTabChange: (tab: AdminTab) => void
}) {
  if (!dashboard) {
    return (
      <Card>
        <CardContent className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
          Loading platform overview…
        </CardContent>
      </Card>
    )
  }

  const { counts, health, usage } = dashboard
  const summary = usage.summary
  const stats = [
    ["Requests", number(summary.requests), "Selected period"],
    ["Success rate", percentage(summary.succeeded, summary.requests), "Completed runs"],
    ["Total tokens", compactNumber(summary.totalTokens), "Reported provider usage"],
    ["P95 latency", summary.p95LatencyMs ? `${Math.round(summary.p95LatencyMs)} ms` : "—", "Completed runs"],
    ["Users", number(counts.users), "Platform total"],
    ["Workspaces", number(counts.workspaces), "Platform total"],
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {stats.map(([label, value, detail]) => (
          <Card key={label} size="sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">{value}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Card>
          <CardHeader>
            <CardTitle>Attention required</CardTitle>
            <CardDescription>
              Derived from current service health, failures, and platform controls.
            </CardDescription>
            <CardAction>
              <Badge variant={dashboard.attention.some((item) => item.severity === "critical") ? "destructive" : dashboard.attention.length ? "outline" : "secondary"}>
                {dashboard.attention.length ? `${dashboard.attention.length} item${dashboard.attention.length === 1 ? "" : "s"}` : "Clear"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            {dashboard.attention.length === 0 ? (
              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
                <HugeiconsIcon icon={CheckmarkCircle02Icon} className="mt-0.5 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium">Everything looks healthy</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    No current configuration or service issues need attention.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {dashboard.attention.map((item) => {
                  const Icon = attentionIcon(item.severity)
                  return (
                    <button
                      className="flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 active:scale-[0.99]"
                      key={item.id}
                      onClick={() => onTabChange(item.tab)}
                      type="button"
                    >
                      <HugeiconsIcon icon={Icon} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.title}</span>
                          <Badge variant={attentionVariant(item.severity)}>{item.severity}</Badge>
                        </span>
                        <span className="mt-1 block text-sm text-muted-foreground">{item.description}</span>
                      </span>
                      {item.metric != null && <span className="font-mono text-xs tabular-nums">{number(item.metric)}</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform health</CardTitle>
            <CardDescription>
              Runtime status for the core platform dependencies.
            </CardDescription>
            <CardAction>
              <Badge variant={health.database.ok && health.providers.ok && health.mcp.ok ? "default" : "destructive"}>
                {health.database.ok && health.providers.ok && health.mcp.ok ? "Operational" : "Degraded"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            {[
              ["Database", health.database.ok, "Primary application store"],
              ["Model endpoints", health.providers.ok, `${health.providers.enabled} of ${health.providers.total} enabled`],
              ["MCP", health.mcp.ok, `${health.mcp.enabled} of ${health.mcp.total} enabled`],
              ["Workers", health.workers.rag && health.workers.transcription, "RAG and transcription"],
            ].map(([label, ok, detail]) => (
              <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5" key={String(label)}>
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{detail}</p>
                </div>
                <Badge variant={ok ? "default" : "destructive"}>{ok ? "Ready" : "Issue"}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <AdminUsageCharts analytics={usage} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top endpoint activity</CardTitle>
            <CardDescription>Highest request volume in the selected period.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {usage.byEndpoint.slice(0, 5).map((item) => (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5" key={`${item.endpointId}-${item.model}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.endpointName}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.model || "Model selected at request time"}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm tabular-nums">{number(item.requests)}</p>
                  <p className="text-xs text-muted-foreground">{item.errors} errors</p>
                </div>
              </div>
            ))}
            {usage.byEndpoint.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No endpoint activity yet.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent admin activity</CardTitle>
            <CardDescription>Latest platform mutations recorded in the audit trail.</CardDescription>
            <CardAction>
              <Button onClick={() => onTabChange("audit")} size="sm" variant="outline">View audit</Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {dashboard.recentActivity.map((item) => (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5" key={item.id}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{actionLabel(item.action)}</p>
                  <p className="text-xs text-muted-foreground">{item.resourceType}</p>
                </div>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </time>
              </div>
            ))}
            {dashboard.recentActivity.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No admin activity recorded yet.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
