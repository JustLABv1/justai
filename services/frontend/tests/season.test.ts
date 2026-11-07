import assert from "node:assert/strict"
import test from "node:test"
import { getSeason } from "../lib/season.ts"

test("local calendar months select Northern Hemisphere seasons", () => {
  assert.deepEqual(
    Array.from({ length: 12 }, (_, month) =>
      getSeason(new Date(2026, month, 1))
    ),
    [
      "winter",
      "winter",
      "spring",
      "spring",
      "spring",
      "summer",
      "summer",
      "summer",
      "autumn",
      "autumn",
      "autumn",
      "winter",
    ]
  )
})

test("season changes at local midnight on the first day of a season", () => {
  for (const month of [2, 5, 8, 11]) {
    assert.notEqual(
      getSeason(new Date(2026, month, 0, 23, 59, 59)),
      getSeason(new Date(2026, month, 1))
    )
  }
})
