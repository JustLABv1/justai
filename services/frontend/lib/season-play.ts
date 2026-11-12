/** A local gust: strong near the nozzle, fading smoothly at its edge. */
export function seasonalWindImpulse(
  x: number,
  y: number,
  originX: number,
  originY: number,
  delta: number
) {
  const dx = x - originX
  const dy = y - originY
  const distance = Math.hypot(dx, dy)
  const strength = Math.max(0, 1 - distance / 260) ** 2
  const direction = dx < 0 ? -1 : 1
  const seconds = Math.max(0, Math.min(delta, 0.05))
  return {
    x: direction * strength * 1500 * seconds,
    y: -strength * 1100 * seconds,
  }
}

export const iceCracksToOpen = 3

/** Snow must build up before frost spreads; writing keeps the prompt thawed. */
export function advanceSeasonalFrost(
  progress: number,
  snowDepth: number,
  idle: boolean,
  delta: number
) {
  if (!idle) return 0
  const target = Math.max(0, Math.min(1, (snowDepth - 1.2) / 3))
  const step = Math.max(0, Math.min(delta, 0.05)) / 35
  return Math.max(
    0,
    Math.min(1, progress + Math.max(-step, Math.min(step, target - progress)))
  )
}

/** How long the pointer must rest above the rim before the blower comes out. */
export const rimDwellMs = 350

/**
 * The strip just above the composer's top edge, where the pointer lingers when
 * it means to play with the leaves. It stops at the edge: moving into the
 * input to type must never summon the blower.
 */
export function pointerAboveRim(
  x: number,
  y: number,
  left: number,
  right: number,
  edge: number
) {
  return x >= left - 40 && x <= right + 40 && y > edge - 80 && y < edge + 6
}

/** True once the pointer has rested above the rim for the dwell time. */
export function rimIntentReached(
  now: number,
  restingSince: number,
  dwell = rimDwellMs
) {
  return restingSince > 0 && now - restingSince >= dwell
}
