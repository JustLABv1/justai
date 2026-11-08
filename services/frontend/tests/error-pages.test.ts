import assert from "node:assert/strict"
import test from "node:test"

import { APIError } from "../lib/api.ts"
import { errorPageKind, errorPageKindFor } from "../lib/error-pages.ts"

test("statuses map to the matching error page", () => {
  assert.equal(errorPageKind(404), "not-found")
  assert.equal(errorPageKind(403), "client")
  assert.equal(errorPageKind(429), "client")
  assert.equal(errorPageKind(500), "server")
  assert.equal(errorPageKind(501), "server")
  assert.equal(errorPageKind(0), "unreachable")
  assert.equal(errorPageKind(502), "unreachable")
  assert.equal(errorPageKind(503), "unreachable")
})

test("caught errors are classified", () => {
  assert.equal(
    errorPageKindFor(new APIError("x", 0, { code: "network_error" })),
    "unreachable"
  )
  assert.equal(
    errorPageKindFor(new TypeError("Failed to fetch")),
    "unreachable"
  )
  assert.equal(errorPageKindFor(new Error("boom")), "server")
})
