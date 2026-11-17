"use client"

import { BotAvatar } from "bot-avatars"
import { useEffect, useState, type ComponentProps } from "react"

import { cn } from "@/lib/utils"

type MascotProps = Omit<ComponentProps<typeof BotAvatar>, "type" | "size"> & {
  /** Size of the (square) mascot: pixels, or any CSS length. */
  size?: number | string
  className?: string
  /** Accessible label; omit for a purely decorative mascot. */
  label?: string
}

/** JustAI's ghost mascot. */
export function Mascot({
  size = 64,
  className,
  label,
  face = "mouth",
  ...props
}: MascotProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn("inline-block flex-none", className)}
      role={label ? "img" : undefined}
      style={{ width: size, height: size }}
    >
      <BotAvatar
        {...props}
        face={face}
        shading="fabric"
        size="100%"
        type="ghost"
      />
    </span>
  )
}

/** True after `timeout` ms without pointer, key or touch activity. */
export function useIdle(timeout = 5 * 60 * 1000, enabled = true) {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    let last = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), timeout)
    }
    const onActivity = () => {
      const now = Date.now()
      if (now - last < 1000) return
      last = now
      setIdle(false)
      arm()
    }
    const events = ["pointerdown", "pointermove", "keydown", "touchstart"]
    for (const e of events)
      window.addEventListener(e, onActivity, { passive: true })
    arm()
    return () => {
      window.clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, onActivity)
    }
  }, [timeout, enabled])

  return enabled && idle
}
