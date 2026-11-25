import assert from "node:assert/strict"
import test from "node:test"

class FakeMedia extends EventTarget {
  static HAVE_METADATA = 1
  static HAVE_FUTURE_DATA = 3
  static NETWORK_EMPTY = 0
  readyState = 0
  networkState = 0
  currentTime = 0
  loads = 0
  plays = 0
  load() {
    this.loads++
  }
  play() {
    this.plays++
    return Promise.resolve()
  }
}
Object.assign(globalThis, { HTMLMediaElement: FakeMedia })
class FakeVideo extends FakeMedia {}
Object.assign(globalThis, { HTMLVideoElement: FakeVideo })

const { seekMedia } = await import("../lib/media-seek.ts")

test("a seek before metadata is applied once metadata loads", async () => {
  const media = new FakeMedia()
  await seekMedia(media as unknown as HTMLMediaElement, 12_500, true)
  assert.equal(media.currentTime, 0)
  assert.equal(media.loads, 1)
  assert.equal(media.plays, 1, "play stays inside the user gesture")
  media.readyState = 1
  media.dispatchEvent(new Event("loadedmetadata"))
  assert.equal(media.currentTime, 12.5)
})

test("only the latest pending seek wins", async () => {
  const media = new FakeMedia()
  await seekMedia(media as unknown as HTMLMediaElement, 1000, false)
  await seekMedia(media as unknown as HTMLMediaElement, 5000, false)
  media.readyState = 1
  media.dispatchEvent(new Event("loadedmetadata"))
  assert.equal(media.currentTime, 5)
})

test("a loaded element seeks immediately", async () => {
  const media = new FakeMedia()
  media.readyState = 4
  await seekMedia(media as unknown as HTMLMediaElement, -20, false)
  assert.equal(media.currentTime, 0)
  assert.equal(media.plays, 0)
})
