import type { AdminAnalyticsDay } from "./types"

export type AnalyticsRange = { days?: number; from?: string; to?: string }

/** The API only returns active days. Count gaps are zero; latency gaps are unknown. */
export function adminChartDays(
  series: AdminAnalyticsDay[],
  range?: AnalyticsRange,
  now = new Date()
) {
  if (!range)
    return series.map((day) => ({
      ...day,
      averageLatencyMs: day.requests ? day.averageLatencyMs : null,
    }))
  const parseDay = (value?: string) =>
    value && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? Date.parse(`${value}T00:00:00Z`)
      : NaN
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  const parsedEnd = parseDay(range.to)
  const end = Number.isFinite(parsedEnd) ? parsedEnd : today
  const parsedStart = parseDay(range.from)
  const days = Math.min(365, Math.max(1, Math.floor(range.days || 30)))
  const start = Number.isFinite(parsedStart)
    ? Math.max(parsedStart, end - 364 * 86400000)
    : end - (days - 1) * 86400000
  const indexed = new Map(series.map((day) => [day.date, day]))
  const result = []
  for (let time = start; time <= end; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10)
    const day = indexed.get(date)
    result.push(
      day
        ? {
            ...day,
            averageLatencyMs: day.requests ? day.averageLatencyMs : null,
          }
        : {
            date,
            requests: 0,
            succeeded: 0,
            failed: 0,
            cancelled: 0,
            toolCalls: 0,
            averageLatencyMs: null,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          }
    )
  }
  return result
}
