import assert from "node:assert/strict"
import test from "node:test"
import { buildProfileDays } from "../lib/profile-day-grid.ts"
test("profile grid fills exactly 90 calendar days and ignores out-of-range activity", () => {
  const result = buildProfileDays(
    [
      { date: "2026-11-08", count: 8 },
      { date: "2026-11-07", count: 2 },
      { date: "2025-01-01", count: 100 },
      { date: "2026-11-09", count: 100 },
    ],
    new Date(2026, 10, 8)
  )
  assert.equal(result.days.length, 90)
  assert.equal(result.days[0].key, "2026-08-11")
  assert.equal(result.days.at(-1)?.key, "2026-11-08")
  assert.equal(
    result.days.reduce((sum, day) => sum + day.count, 0),
    10
  )
  assert.equal(result.days.at(-1)?.level, 4)
  assert.equal(result.days.at(-2)?.level, 1)
  assert.equal(result.days[0].level, 0)
  assert.equal(result.offset, 1)
})
test("empty profiles have zero levels and unique dates across DST", () => {
  const { days } = buildProfileDays([], new Date(2026, 3, 8))
  assert.equal(new Set(days.map((day) => day.key)).size, 90)
  assert.ok(days.every((day) => day.level === 0))
  assert.equal(days.at(-1)?.key, "2026-04-08")
})
