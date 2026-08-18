"use client"

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import type { AdminAnalyticsResponse } from "@/lib/types"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

const requestConfig: ChartConfig = {
  succeeded: { label: "Successful", color: "var(--chart-1)" },
  failed: { label: "Errors", color: "var(--destructive)" },
  cancelled: { label: "Cancelled", color: "var(--chart-4)" },
}

const tokenConfig: ChartConfig = {
  inputTokens: { label: "Input tokens", color: "var(--chart-2)" },
  outputTokens: { label: "Output tokens", color: "var(--chart-1)" },
}

const latencyConfig: ChartConfig = {
  averageLatencyMs: { label: "Average latency", color: "var(--chart-5)" },
  toolCalls: { label: "Tool calls", color: "var(--chart-4)" },
}

function compactNumber(value: number | string | null | undefined) {
  if (value == null) return "—"
  const numericValue = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numericValue)) return "—"
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(numericValue)
}

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date)
}

function chartData(analytics: AdminAnalyticsResponse) {
  return analytics.timeSeries.map((item) => ({
    ...item,
    label: formatDay(item.date),
    inputTokens: item.inputTokens ?? 0,
    outputTokens: item.outputTokens ?? 0,
    averageLatencyMs: Math.round(item.averageLatencyMs ?? 0),
  }))
}

export function AdminUsageCharts({
  analytics,
  showLatency = false,
}: {
  analytics: AdminAnalyticsResponse | null
  showLatency?: boolean
}) {
  if (!analytics || analytics.timeSeries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage trends</CardTitle>
          <CardDescription>
            Charts will appear once the platform has recorded chat runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
          No activity for this period.
        </CardContent>
      </Card>
    )
  }

  const data = chartData(analytics)
  const hasTokens = analytics.summary.totalTokens != null

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Request outcomes</CardTitle>
          <CardDescription>
            Successful, failed, and cancelled runs by UTC day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ChartContainer config={requestConfig}>
              <AreaChart data={data} margin={{ left: -18, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="admin-success" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickFormatter={compactNumber} />
                <ChartTooltip content={<ChartTooltipContent formatter={compactNumber} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Area
                  dataKey="succeeded"
                  type="monotone"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fill="url(#admin-success)"
                  stackId="outcomes"
                />
                <Area dataKey="failed" type="monotone" stroke="var(--destructive)" strokeWidth={2} fill="transparent" stackId="outcomes" />
                <Area dataKey="cancelled" type="monotone" stroke="var(--chart-4)" strokeWidth={2} fill="transparent" stackId="outcomes" />
              </AreaChart>
            </ChartContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Token consumption</CardTitle>
          <CardDescription>
            Input and output tokens reported by configured providers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasTokens ? (
            <div className="h-64">
              <ChartContainer config={tokenConfig}>
                <BarChart data={data} margin={{ left: -18, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickFormatter={compactNumber} />
                  <ChartTooltip content={<ChartTooltipContent formatter={compactNumber} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="inputTokens" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="outputTokens" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </div>
          ) : (
            <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
              Token telemetry is unavailable for this period.
            </div>
          )}
        </CardContent>
      </Card>

      {showLatency && (
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Latency and tool calls</CardTitle>
            <CardDescription>
              Average completed-run latency and tool activity by UTC day.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ChartContainer config={latencyConfig}>
                <LineChart data={data} margin={{ left: -18, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis yAxisId="latency" axisLine={false} tickLine={false} tickFormatter={(value) => `${value} ms`} />
                  <YAxis yAxisId="tools" orientation="right" axisLine={false} tickLine={false} tickFormatter={compactNumber} />
                  <ChartTooltip content={<ChartTooltipContent formatter={(value, key) => key === "averageLatencyMs" ? `${compactNumber(Number(value))} ms` : compactNumber(Number(value))} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line dataKey="averageLatencyMs" yAxisId="latency" type="monotone" stroke="var(--chart-5)" strokeWidth={2} dot={false} />
                  <Line dataKey="toolCalls" yAxisId="tools" type="monotone" stroke="var(--chart-4)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export { compactNumber }
