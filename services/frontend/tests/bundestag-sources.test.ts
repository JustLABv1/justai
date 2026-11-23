import assert from "node:assert/strict"
import test from "node:test"

import {
  type RelaySource,
  relayChoiceForURL,
  relayChoices,
  runningPlanSession,
  sessionsOnAir,
} from "../lib/bundestag-sources.ts"
import type { StreamPlanSession } from "../lib/types.ts"

const relay = "https://relay.example/v1/sources/"
const source = (
  id: string,
  status: RelaySource["status"] = "idle",
  relayName = "relay.example"
): RelaySource => ({
  id,
  name: id,
  url: relay + id,
  relay: relayName,
  status,
})

test("Bundestag channel sources become one card per relay", () => {
  const choices = relayChoices([
    source("bundestag-hk7", "live"),
    source("radio"),
    source("bundestag"),
    source("bundestag-hk3"),
    source("bundestag-hk8", "offline"),
  ])
  assert.deepEqual(
    choices.map((choice) => choice.key),
    ["relay.example/bundestag", "relay.example/radio"]
  )
  const bundestag = choices[0]
  assert.equal(bundestag.kind, "bundestag")
  if (bundestag.kind !== "bundestag") return
  // The plenary source is stored; the backend routes to the sitting's channel.
  assert.equal(bundestag.source.id, "bundestag")
  assert.deepEqual(bundestag.channels, [1, 3, 7, 8])
  assert.equal(bundestag.status, "live")
  // Any channel URL, e.g. of an existing session, selects the merged card.
  assert.equal(
    relayChoiceForURL(choices, relay + "bundestag-hk8")?.key,
    "relay.example/bundestag"
  )
  assert.equal(
    relayChoiceForURL(choices, relay + "radio")?.key,
    "relay.example/radio"
  )
  assert.equal(relayChoiceForURL(choices, "https://other.example/x"), undefined)
})

test("without a plenary source the lowest channel is stored", () => {
  const [choice] = relayChoices([
    source("bundestag-hk8"),
    source("bundestag-hk7"),
  ])
  assert.equal(choice.kind, "bundestag")
  assert.equal(choice.source.id, "bundestag-hk7")
})

test("other names are not treated as channels", () => {
  const choices = relayChoices([
    source("bundestag-kanal7"),
    source("bundestagx"),
  ])
  assert.ok(choices.every((choice) => choice.kind === "source"))
})

const now = Date.parse("2026-11-23T11:30:00Z")
const session = (
  key: string,
  channel: number,
  startMin: number,
  endMin: number
): StreamPlanSession => {
  const start = new Date(now + startMin * 60_000).toISOString()
  const end = new Date(now + endMin * 60_000).toISOString()
  return {
    key,
    title: key,
    startAt: start,
    endAt: end,
    windowStartAt: start,
    windowEndAt: end,
    fallbackAt: start,
    channel,
  }
}

test("the running session follows the backend's choice", () => {
  const committee = session("verkehr", 7, -30, 90)
  const later = session("inneres", 8, 150, 270)
  assert.equal(runningPlanSession([committee, later], now)?.key, "verkehr")
  const plenary = session("plenum", 1, -60, 360)
  assert.equal(runningPlanSession([committee, plenary], now)?.key, "plenum")
  const parallel = session("gesundheit", 3, -10, 60)
  assert.equal(runningPlanSession([committee, parallel], now), undefined)
  assert.equal(sessionsOnAir([committee, parallel, later], now).length, 2)
  // Starting within 15 minutes counts, like the backend's watch window.
  assert.equal(
    runningPlanSession([session("soon", 7, 10, 60)], now)?.key,
    "soon"
  )
  assert.equal(runningPlanSession([later], now), undefined)
})
