"use client"

import { useId } from "react"
import { Area, AreaChart, YAxis } from "recharts"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer } from "@/components/ui/chart"

/** Compact KPI card with the title/value/sparkline layout of the ReUI reference. */
export function PlatformStatCard({
  title,
  period,
  value,
  color,
  points,
  domain = [0, "auto"],
}: {
  title: string
  period: string
  value: string
  color: string
  points: Array<{ value: number | null }>
  domain?: [number, number | "auto"]
}) {
  const gradientId = `stat-${useId().replace(/:/g, "")}`
  const hasSingleValue =
    points.filter((point) => point.value !== null).length === 1

  return (
    <Card className="h-40 w-full max-w-full min-w-0 gap-0 rounded-[18px] py-5">
      <CardHeader className="min-w-0 px-5">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-3 px-5 pt-6">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{period}</p>
          <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
        </div>
        <div className="min-w-0 overflow-hidden" aria-hidden="true">
          <ChartContainer
            style={{ height: 64, minWidth: 0 }}
            config={{ value: { color } }}
          >
            <AreaChart
              data={points}
              margin={{ top: 5, right: 1, bottom: 0, left: 1 }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.015} />
                </linearGradient>
              </defs>
              <YAxis hide domain={domain} />
              <Area
                dataKey="value"
                type="monotone"
                stroke={color}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                baseValue={0}
                dot={
                  hasSingleValue ? { r: 3, fill: color, strokeWidth: 0 } : false
                }
                activeDot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  )
}
