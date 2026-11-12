import assert from "node:assert/strict"
import test from "node:test"

import { replaceInlineMathSymbols } from "../lib/inline-math.ts"

test("converts simple LaTeX symbols to unicode", () => {
  assert.equal(
    replaceInlineMathSymbols("Dashboards $\\rightarrow$ New $\\rightarrow$ Import"),
    "Dashboards → New → Import"
  )
  assert.equal(replaceInlineMathSymbols("a $\\leq$ b, $\\times$"), "a ≤ b, ×")
})

test("leaves code, prices and unknown math untouched", () => {
  assert.equal(replaceInlineMathSymbols("`$\\rightarrow$`"), "`$\\rightarrow$`")
  assert.equal(replaceInlineMathSymbols("costs $5 and $10"), "costs $5 and $10")
  assert.equal(replaceInlineMathSymbols("$\\frac{a}{b}$"), "$\\frac{a}{b}$")
})
