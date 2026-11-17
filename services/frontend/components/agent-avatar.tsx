"use client"

import { BotAvatar } from "bot-avatars"
import type { ComponentProps } from "react"

const TYPES = [
  "clover",
  "flower",
  "triangle",
  "square",
  "blob",
  "ghost",
  "circle",
  "drop",
  "star",
  "droid",
  "mech",
  "alien",
  "hexagon",
  "cat",
  "cloud",
  "pill",
  "pebble",
  "puddle",
] as const

type AgentAvatarProps = Omit<
  ComponentProps<typeof BotAvatar>,
  "type" | "seed"
> & {
  /** Stable key (agent id or name) that picks the avatar's shape. */
  seedKey: string
}

function hash(value: string) {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Gives every agent its own, stable bot shape. */
export function AgentAvatar({ seedKey, size = 40, ...props }: AgentAvatarProps) {
  const h = hash(seedKey)
  return (
    <BotAvatar
      {...props}
      seed={(h % 1000) / 1000}
      size={size}
      type={TYPES[h % TYPES.length]}
    />
  )
}
