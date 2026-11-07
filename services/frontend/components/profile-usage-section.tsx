"use client"

import { useEffect, useState } from "react"
import { Flame, Gauge, MessageSquare } from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { BarChart } from "@/components/panelui/bar-chart"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
import { PageSection } from "@/components/ui/page"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import type { UsageDay } from "@/lib/usage"
import { useUsage } from "@/lib/use-usage"

/** The signed-in member's token use: this month so far, and day by day for the last 30 days. */
export function ProfileUsageSection() {
  const { t, locale } = useTranslations()
  const usage = useUsage()
  const [days, setDays] = useState<UsageDay[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ days: UsageDay[] }>("/api/v1/usage/history")
      .then((result) => {
        if (!cancelled) setDays(result.days)
      })
      .catch(() => {
        if (!cancelled) setDays([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const number = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  })
  const dayLabel = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
  const limit = usage?.monthlyTokenLimit ?? null
  const share =
    usage && limit ? Math.min(100, (usage.totalTokens / limit) * 100) : 0
  const resets = usage
    ? new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(usage.periodEnd))
    : ""
  const chartData = (days ?? []).map((day) => ({
    name: dayLabel.format(new Date(`${day.date}T00:00:00Z`)),
    input: day.inputTokens,
    output: day.outputTokens,
  }))
  const activeDays = (days ?? []).filter((day) => day.totalTokens > 0).length
  const total30 = (days ?? []).reduce((sum, day) => sum + day.totalTokens, 0)

  return (
    <PageSection
      description={t("Tokens your conversations used, counted per month.")}
      title={t("Usage")}
    >
      {usage ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card size="sm">
            <CardHeader>
              <CardDescription>{t("Tokens this month")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <p className="font-heading text-2xl font-semibold tracking-tight">
                {number.format(usage.totalTokens)}
              </p>
              {limit !== null ? (
                <>
                  <Progress
                    aria-label={t("Used of the monthly limit")}
                    className="gap-0"
                    value={share}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("of {value0} · resets on {value1}", {
                      value0: number.format(limit),
                      value1: resets,
                    })}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("No limit · resets on {value0}", { value0: resets })}
                </p>
              )}
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>{t("Requests this month")}</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <MessageSquare
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
              <p className="font-heading text-2xl font-semibold tracking-tight">
                {number.format(usage.requests)}
              </p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>{t("Active days (last 30)")}</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <Flame
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
              <p className="font-heading text-2xl font-semibold tracking-tight">
                {days ? activeDays : "–"}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton className="h-28 rounded-2xl" key={index} />
          ))}
        </div>
      )}
      <Card size="sm">
        <CardContent>
          {days === null ? (
            <Skeleton className="h-56 rounded-xl" />
          ) : total30 === 0 ? (
            <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Gauge aria-hidden="true" className="size-4" />
              {t("No usage in the last 30 days.")}
            </p>
          ) : (
            <BarChart
              aspectRatio={3}
              data={chartData}
              label={t("Tokens per day, last 30 days")}
              stacked
              xDataKey="name"
            >
              <BarChart.Header
                caption={t("Last 30 days")}
                labels={{
                  input: t("Input tokens"),
                  output: t("Output tokens"),
                }}
                legend
                title={t("Tokens per day")}
                value={compact.format(total30)}
              />
              <BarChart.Grid rows={4} />
              <BarChart.Bar color="info" dataKey="input" />
              <BarChart.Bar color="success" dataKey="output" />
              <BarChart.XAxis ticks={6} />
              <BarChart.YAxis />
              <BarChart.Tooltip
                labels={{
                  input: t("Input tokens"),
                  output: t("Output tokens"),
                }}
              />
            </BarChart>
          )}
        </CardContent>
      </Card>
    </PageSection>
  )
}
