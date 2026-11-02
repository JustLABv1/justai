import assert from "node:assert/strict"
import test from "node:test"
import { workspaceActivityDays } from "../lib/workspace-activity.ts"

test("sparse activity fills the 90 UTC days without moving the recorded day", () => {
  const days = workspaceActivityDays(
    [
      { date: "2026-10-22", requests: 2 },
      { date: "2025-01-01", requests: 9 },
    ],
    new Date("2026-11-02T23:30:00Z")
  )
  assert.equal(days.length, 90)
  assert.equal(days[0].date, "2026-08-05")
  assert.equal(days[89].date, "2026-11-02")
  assert.deepEqual(
    days.filter((day) => day.requests > 0),
    [{ date: "2026-10-22", requests: 2 }]
  )
  assert.equal(
    days.reduce((sum, day) => sum + day.requests, 0),
    2
  )
})

test("empty activity retains a complete axis across leap day", () => {
  const days = workspaceActivityDays([], new Date("2024-03-01T00:00:00Z"))
  assert.equal(days.length, 90)
  assert.equal(days[88].date, "2024-02-29")
  assert.ok(days.every((day) => day.requests === 0))
})
