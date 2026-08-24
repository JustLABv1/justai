import assert from "node:assert/strict"
import test from "node:test"

import { api } from "../lib/api.ts"

test("blob request keeps its timeout until the response body is consumed", async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let resolveBlob: ((blob: Blob) => void) | undefined
  let timeoutCallback: (() => void) | undefined
  let cleared = false

  globalThis.setTimeout = ((callback: TimerHandler) => {
    timeoutCallback = callback as () => void
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (handle === (1 as unknown as ReturnType<typeof setTimeout>)) {
      cleared = true
    }
  }) as unknown as typeof globalThis.clearTimeout
  globalThis.fetch = (async () =>
    ({
      ok: true,
      blob: () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = resolve
        }),
    }) as Response) as typeof globalThis.fetch

  try {
    const pending = api.getBlob("/api/v1/privacy/export")
    await new Promise((resolve) => originalSetTimeout(resolve, 0))
    assert.equal(cleared, false)
    assert.ok(timeoutCallback)

    resolveBlob?.(new Blob(["download"]))
    const blob = await pending
    assert.equal(await blob.text(), "download")
    assert.equal(cleared, true)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
