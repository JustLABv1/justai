import assert from "node:assert/strict"
import test from "node:test"
import { adminChartDays } from "../lib/admin-chart-data.ts"

const day = {
  date: "2026-10-22",
  requests: 2,
  succeeded: 2,
  failed: 0,
  cancelled: 0,
  averageLatencyMs: 814,
  toolCalls: 0,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
}

test("sparse counts retain their date while inactive days have no latency", () => {
  const data = adminChartDays(
    [day],
    { days: 30 },
    new Date("2026-11-02T23:00:00Z")
  )
  assert.equal(data.length, 30)
  assert.equal(data[0].date, "2026-10-04")
  assert.equal(data.at(-1)?.date, "2026-11-02")
  assert.equal(
    data.find((item) => item.date === day.date)?.averageLatencyMs,
    814
  )
  assert.equal(data[0].averageLatencyMs, null)
  assert.equal(
    data.reduce((sum, item) => sum + item.requests, 0),
    2
  )
})

test("custom ranges include both dates and stay bounded", () => {
  const data = adminChartDays([day], { from: "2026-10-21", to: "2026-10-23" })
  assert.equal(data.length, 3)
  assert.equal(data[1].requests, 2)
  assert.equal(
    adminChartDays([], { from: "2020-01-01", to: "2026-01-01" }).length,
    365
  )
  assert.deepEqual(
    adminChartDays([], { from: "2026-10-23", to: "2026-10-21" }),
    []
  )
})
