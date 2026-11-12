import assert from "node:assert/strict"
import test from "node:test"
import {
  advanceSeasonalFrost,
  pointerAboveRim,
  rimDwellMs,
  rimIntentReached,
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

test("moving into the prompt to type never counts as playing with the leaves", () => {
  const edge = 400
  const [left, right] = [100, 700]
  // Resting just above the rim does.
  assert.equal(pointerAboveRim(300, edge - 30, left, right, edge), true)
  assert.equal(pointerAboveRim(300, edge - 2, left, right, edge), true)
  // Anywhere inside the field (where the text is) does not, however close to the edge.
  assert.equal(pointerAboveRim(300, edge + 7, left, right, edge), false)
  assert.equal(pointerAboveRim(300, edge + 50, left, right, edge), false)
  // Far above, or beside the composer, does not either.
  assert.equal(pointerAboveRim(300, edge - 200, left, right, edge), false)
  assert.equal(pointerAboveRim(20, edge - 30, left, right, edge), false)
})

test("the blower waits for the pointer to rest before it comes out", () => {
  assert.equal(rimIntentReached(1000, 0), false)
  assert.equal(rimIntentReached(1000, 900), false)
  assert.equal(rimIntentReached(1000 + rimDwellMs, 1000), true)
  // Crossing the strip on the way into the field is far shorter than the dwell.
  assert.equal(rimIntentReached(1100, 1000), false)
})
