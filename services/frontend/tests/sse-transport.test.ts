import assert from "node:assert/strict"
import test from "node:test"

import { SSETransport } from "../lib/sse-transport.ts"

class FakeEventSource {
  static current: FakeEventSource | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    FakeEventSource.current = this
  }

  close() {}

  ready() {
    this.onmessage?.({
      data: JSON.stringify({
        type: "transport.ready",
        data: {
          streamId: "stream-1",
          uploadToken: "upload-token",
          resumeToken: "resume-token",
        },
      }),
      lastEventId: "0",
    } as MessageEvent<string>)
  }
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for audio upload")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("retries the same audio batch number after a lost response", async () => {
  const originalEventSource = globalThis.EventSource
  const originalFetch = globalThis.fetch
  const calls: { sequence: string; body: Uint8Array }[] = []
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  globalThis.fetch = (async (_url, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      sequence: headers.get("X-Audio-Batch-Sequence") ?? "",
      body: new Uint8Array(init?.body as Uint8Array),
    })
    if (calls.length === 1) throw new Error("response lost")
    return new Response(null, { status: 202 })
  }) as typeof fetch

  let transport: SSETransport | null = null
  try {
    transport = new SSETransport("/api/v1/streams/open")
    FakeEventSource.current?.ready()
    transport.send(new Uint8Array(17).fill(7))
    await waitFor(() => calls.length >= 2)
    assert.deepEqual(
      calls.map((call) => call.sequence),
      ["1", "1"]
    )
    assert.deepEqual(calls[0].body, calls[1].body)

    transport.send(new Uint8Array(17).fill(8))
    await waitFor(() => calls.length >= 3)
    assert.equal(calls[2].sequence, "2")
  } finally {
    transport?.close(false)
    globalThis.EventSource = originalEventSource
    globalThis.fetch = originalFetch
  }
})
