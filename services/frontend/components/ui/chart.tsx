"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"

export type ChartConfig = {
  [key: string]: {
    label?: React.ReactNode
    color?: string
  }
}

type ChartContextValue = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextValue | null>(null)

function ChartContainer({
  config,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
}) {
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        className={cn("h-full w-full text-xs", className)}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

function useChartConfig() {
  const context = React.useContext(ChartContext)
  if (!context) {
    throw new Error("useChartConfig must be used inside a ChartContainer")
  }
  return context.config
}

type ChartTooltipPayload = {
  dataKey?: string | number
  name?: string | number
  value?: string | number
  color?: string
  payload?: Record<string, unknown>
}

function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  formatter,
}: {
  active?: boolean
  payload?: ChartTooltipPayload[]
  label?: React.ReactNode
  className?: string
  formatter?: (value: number | string, key: string) => React.ReactNode
}) {
  const config = useChartConfig()
  if (!active || !payload?.length) return null

  return (
    <div
      className={cn(
        "grid min-w-36 gap-2 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl",
        className
      )}
    >
      {label !== undefined && (
        <div className="font-medium text-foreground">{label}</div>
      )}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = String(item.dataKey ?? item.name ?? index)
          const labelValue = config[key]?.label ?? item.name ?? key
          const value = item.value ?? "—"
          return (
            <div className="flex items-center justify-between gap-4" key={`${key}-${index}`}>
              <span className="flex items-center gap-2 text-muted-foreground">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: item.color ?? config[key]?.color }}
                />
                {labelValue}
              </span>
              <span className="font-mono font-medium tabular-nums">
                {formatter ? formatter(value, key) : value}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ChartLegendContent({
  payload,
  className,
}: {
  payload?: Array<{ dataKey?: string | number; value?: string }>
  className?: string
}) {
  const config = useChartConfig()
  if (!payload?.length) return null

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-4 gap-y-2", className)}>
      {payload.map((item, index) => {
        const key = String(item.dataKey ?? item.value ?? index)
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" key={`${key}-${index}`}>
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: config[key]?.color }}
            />
            {config[key]?.label ?? item.value ?? key}
          </span>
        )
      })}
    </div>
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip
const ChartLegend = RechartsPrimitive.Legend

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
}
