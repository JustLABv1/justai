import assert from "node:assert/strict"
import test from "node:test"
import { insightsDays } from "../lib/analytics-insights.ts"

test("insights timeline honors the API's exclusive UTC end", () => {
  const data = insightsDays({
    period: { from: "2026-10-21T12:00:00Z", to: "2026-10-23T00:00:00Z" },
    daily: [
      {
        date: "2026-10-22",
        chatRuns: 2,
        mcpCalls: 3,
        agentRuns: 0,
        transcriptions: 1,
        activeUsers: 2,
      },
    ],
  })
  assert.equal(data.length, 2)
  assert.equal(data[0].date, "2026-10-21")
  assert.equal(data[0].activeUsers, 0)
  assert.equal(data[1].mcpCalls, 3)
  assert.equal(
    data.reduce((sum, day) => sum + day.chatRuns, 0),
    2
  )
})

test("partial UTC days stay present without fabricated events", () => {
  const data = insightsDays({
    period: { from: "2026-10-21T12:00:00Z", to: "2026-10-23T12:00:00Z" },
    daily: [],
  })
  assert.deepEqual(
    data.map((day) => day.date),
    ["2026-10-21", "2026-10-22", "2026-10-23"]
  )
  assert.ok(data.every((day) => day.chatRuns === 0 && day.mcpCalls === 0))
  assert.deepEqual(
    insightsDays({ period: { from: "bad", to: "bad" }, daily: [] }),
    []
  )
})

test("insightsDays builds hourly and minute buckets", () => {
  const hours = insightsDays({
    bucket: "hour",
    period: { from: "2026-11-02T08:30:00Z", to: "2026-11-02T11:30:00Z" },
    daily: [
      {
        date: "2026-11-02T09:00",
        chatRuns: 3,
        mcpCalls: 0,
        agentRuns: 0,
        transcriptions: 0,
        activeUsers: 1,
      },
    ],
  })
  assert.deepEqual(
    hours.map((h) => h.date),
    [
      "2026-11-02T08:00",
      "2026-11-02T09:00",
      "2026-11-02T10:00",
      "2026-11-02T11:00",
    ]
  )
  assert.equal(hours[1].chatRuns, 3)
  const minutes = insightsDays({
    bucket: "minute",
    period: { from: "2026-11-02T08:00:30Z", to: "2026-11-02T08:05:30Z" },
    daily: [],
  })
  assert.equal(minutes.length, 6)
  assert.equal(minutes[0].date, "2026-11-02T08:00")
})
