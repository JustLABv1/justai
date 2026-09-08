import assert from "node:assert/strict"
import test from "node:test"
import { layoutAgentGraph } from "../lib/agent-graph-layout.ts"

test("lays out fan-out and fan-in in dependency order without overlap", () => {
  const positions = layoutAgentGraph(
    ["end", "left", "start", "right"],
    [
      { from: "start", to: "left" },
      { from: "start", to: "right" },
      { from: "left", to: "end" },
      { from: "right", to: "end" },
    ]
  )
  assert.ok(positions.start.y < positions.left.y)
  assert.equal(positions.left.y, positions.right.y)
  assert.ok(Math.abs(positions.left.x - positions.right.x) >= 300)
  assert.ok(positions.end.y > positions.right.y)
})
test("handles cycles, disconnected nodes, and missing references", () => {
  const positions = layoutAgentGraph(
    ["a", "b", "c"],
    [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "missing", to: "c" },
    ]
  )
  assert.equal(
    new Set(Object.values(positions).map((p) => `${p.x},${p.y}`)).size,
    3
  )
  assert.deepEqual(layoutAgentGraph([], []), {})
})
