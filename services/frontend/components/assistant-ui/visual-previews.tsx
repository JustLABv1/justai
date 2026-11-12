"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { useTranslations } from "@/components/locale-provider"
import { parseChartSpec } from "@/lib/chart-spec"
import { cn } from "@/lib/utils"

const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 }

/** Renders Graphviz/DOT source to an <img>, so the SVG can never run scripts. */
export function GraphvizPreview({ code }: { code: string }) {
  const { t } = useTranslations()
  const [result, setResult] = useState<{
    code: string
    src?: string
  }>({ code: "" })

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const { instance } = await import("@viz-js/viz")
        const viz = await instance()
        const svg = viz.renderString(code, { format: "svg" })
        if (active) {
          setResult({
            code,
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          })
        }
      } catch {
        if (active) setResult({ code })
      }
    })()
    return () => {
      active = false
    }
  }, [code])

  if (result.code !== code) {
    return (
      <p className="rounded-xl bg-muted/50 p-3 text-muted-foreground" role="status">
        {t("Loading…")}
      </p>
    )
  }
  if (!result.src) {
    return (
      <p className="rounded-xl bg-destructive/10 p-3 text-destructive" role="alert">
        {t("The diagram could not be rendered.")}
      </p>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={t("Diagram")}
      className="max-h-[32rem] w-full rounded-xl bg-white p-3"
      src={result.src}
    />
  )
}

/** Chart from the JSON of a ```chart block (see `lib/chart-spec.ts`). */
export function ChartPreview({ code }: { code: string }) {
  const { t } = useTranslations()
  const parsed = useMemo(() => parseChartSpec(code), [code])

  if (!parsed.ok) {
    return (
      <p className="rounded-xl bg-destructive/10 p-3 text-destructive" role="alert">
        {t("This chart definition is not valid.")}
      </p>
    )
  }

  const { spec } = parsed
  const color = (index: number) => chartColors[index % chartColors.length]
  const shared = { data: spec.data, margin: { top: 8, right: 8, bottom: 0, left: 0 } }
  const axes = (
    <>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
      <XAxis dataKey={spec.x} tick={axisTick} />
      <YAxis tick={axisTick} width={48} />
    </>
  )
  const tooltip = (
    <Tooltip
      contentStyle={{
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        color: "var(--foreground)",
      }}
    />
  )

  return (
    <figure className="rounded-xl bg-muted/30 p-3">
      {spec.title && (
        <figcaption className="mb-2 text-sm font-medium">{spec.title}</figcaption>
      )}
      <div className="h-72 w-full">
        <ResponsiveContainer>
          {spec.type === "pie" ? (
            <PieChart>
              <Pie
                data={spec.data.map((row, index) => ({
                  name: String(row[spec.x]),
                  value: Number(row[spec.series[0]]),
                  fill: color(index),
                }))}
                dataKey="value"
                label
                nameKey="name"
              />
              {tooltip}
              <Legend />
            </PieChart>
          ) : spec.type === "line" ? (
            <LineChart {...shared}>
              {axes}
              {tooltip}
              <Legend />
              {spec.series.map((key, index) => (
                <Line
                  dataKey={key}
                  dot={false}
                  key={key}
                  stroke={color(index)}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}
            </LineChart>
          ) : spec.type === "area" ? (
            <AreaChart {...shared}>
              {axes}
              {tooltip}
              <Legend />
              {spec.series.map((key, index) => (
                <Area
                  dataKey={key}
                  fill={color(index)}
                  fillOpacity={0.25}
                  key={key}
                  stroke={color(index)}
                  type="monotone"
                />
              ))}
            </AreaChart>
          ) : (
            <BarChart {...shared}>
              {axes}
              {tooltip}
              <Legend />
              {spec.series.map((key, index) => (
                <Bar dataKey={key} fill={color(index)} key={key} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

/** Unified diff with added and removed lines highlighted. */
export function DiffPreview({ code }: { code: string }) {
  const lines = code.split("\n")
  return (
    <div className="max-h-96 overflow-auto rounded-xl bg-muted/50 py-2 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <div
          className={cn(
            "px-3 whitespace-pre",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-red-500/15 text-red-700 dark:text-red-300"
                : line.startsWith("@@")
                  ? "text-primary"
                  : /^(\+\+\+|---|diff |index )/.test(line)
                    ? "font-semibold text-muted-foreground"
                    : "text-foreground"
          )}
          key={index}
        >
          {line || " "}
        </div>
      ))}
    </div>
  )
}
