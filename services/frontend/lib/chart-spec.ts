export type ChartType = "bar" | "line" | "area" | "pie"

export type ChartRow = Record<string, string | number>

export interface ChartSpec {
  type: ChartType
  title?: string
  /** Key of the category (x axis / pie slice name). */
  x: string
  /** Keys of the numeric values to plot. */
  series: string[]
  data: ChartRow[]
}

export type ParsedChart = { ok: true; spec: ChartSpec } | { ok: false }

const chartTypes = new Set<ChartType>(["bar", "line", "area", "pie"])
const maxRows = 500
const maxSeries = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Parses the JSON of a ```chart block:
 * `{"type":"bar","title":"…","data":[{"month":"Jan","sales":10}],"x":"month","series":["sales"]}`
 * `x` and `series` are optional: the first text column is the category and the
 * remaining numeric columns are the series.
 */
export function parseChartSpec(text: string): ParsedChart {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (!isRecord(raw) || !Array.isArray(raw.data)) return { ok: false }
  const type = String(raw.type ?? "bar").toLowerCase() as ChartType
  if (!chartTypes.has(type)) return { ok: false }

  const rows = raw.data.slice(0, maxRows).filter(isRecord)
  if (rows.length === 0) return { ok: false }

  const keys = Object.keys(rows[0])
  const x =
    typeof raw.x === "string" && keys.includes(raw.x)
      ? raw.x
      : (keys.find((key) => asNumber(rows[0][key]) === null) ?? keys[0])
  if (!x) return { ok: false }

  const requested = Array.isArray(raw.series)
    ? raw.series.filter((key): key is string => typeof key === "string")
    : []
  const series = (
    requested.length > 0
      ? requested
      : keys.filter((key) => key !== x && asNumber(rows[0][key]) !== null)
  ).slice(0, maxSeries)
  if (series.length === 0) return { ok: false }

  const data = rows.map((row) => {
    const out: ChartRow = { [x]: String(row[x] ?? "") }
    for (const key of series) out[key] = asNumber(row[key]) ?? 0
    return out
  })

  return {
    ok: true,
    spec: {
      type,
      title: typeof raw.title === "string" ? raw.title.slice(0, 200) : undefined,
      x,
      series,
      data,
    },
  }
}
