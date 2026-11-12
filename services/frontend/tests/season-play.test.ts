import assert from "node:assert/strict"
import test from "node:test"
import {
  advanceSeasonalFrost,
  seasonalWindImpulse,
} from "../lib/season-play.ts"

test("the leaf blower lifts leaves away from the nozzle and has a bounded radius", () => {
  const right = seasonalWindImpulse(40, 0, 0, 0, 0.032)
  const left = seasonalWindImpulse(-40, 0, 0, 0, 0.032)
  assert.ok(right.x > 0 && right.y < 0)
  assert.ok(left.x < 0 && left.y < 0)
  assert.deepEqual(seasonalWindImpulse(260, 0, 0, 0, 0.032), { x: 0, y: -0 })
  assert.ok(
    Math.abs(right.x) > Math.abs(seasonalWindImpulse(180, 0, 0, 0, 0.032).x)
  )
})

test("wind cannot jump after a suspended animation frame or reverse time", () => {
  assert.deepEqual(
    seasonalWindImpulse(30, 0, 0, 0, 10),
    seasonalWindImpulse(30, 0, 0, 0, 0.05)
  )
  assert.deepEqual(seasonalWindImpulse(30, 0, 0, 0, -1), { x: 0, y: -0 })
})

test("frost starts only after snow accumulates and spreads gradually", () => {
  assert.equal(advanceSeasonalFrost(0, 1, true, 0.05), 0)
  const first = advanceSeasonalFrost(0, 5, true, 0.05)
  assert.ok(first > 0 && first < 0.01)
  let progress = 0
  for (let tick = 0; tick < 720; tick++)
    progress = advanceSeasonalFrost(progress, 5, true, 0.05)
  assert.equal(progress, 1)
  assert.equal(advanceSeasonalFrost(1, 5, false, 0.05), 0)
})

test("background throttling cannot instantly freeze the prompt", () => {
  assert.equal(
    advanceSeasonalFrost(0, 5, true, 60),
    advanceSeasonalFrost(0, 5, true, 0.05)
  )
})
