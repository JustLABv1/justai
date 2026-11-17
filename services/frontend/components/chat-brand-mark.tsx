"use client"

import { useTranslations } from "@/components/locale-provider"
import { useEffect, useRef, useState } from "react"
import { useAuiState } from "@assistant-ui/react"

import { BrandMark } from "@/components/brand-mark"
import { Mascot, useIdle } from "@/components/mascot"
import { cn } from "@/lib/utils"

type ChatBrandMarkProps = {
  className?: string
  isActive?: boolean
  /** Render the animated ghost mascot instead of the signet. */
  mascot?: boolean
}

/** The JustAI mark doubles as a quiet, contextual chat-status indicator. */
export function ChatBrandMark({ className, isActive, mascot = false }: ChatBrandMarkProps) {
  const { t } = useTranslations()

  const threadIsRunning = useAuiState((state) => state.thread.isRunning)
  const active = isActive ?? threadIsRunning
  const wasRunning = useRef(false)
  const timer = useRef<number | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const idle = useIdle(5 * 60 * 1000, mascot && !active)

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    const completed = wasRunning.current && !active
    wasRunning.current = active

    if (completed) {
      timer.current = window.setTimeout(() => {
        setCelebrating(true)
        timer.current = window.setTimeout(() => setCelebrating(false), 850)
      }, 0)
    }

    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [active])

  const state = active ? "thinking" : celebrating ? "complete" : "idle"
  const label =
    state === "thinking"
      ? t("JustAI is working")
      : state === "complete"
        ? t("JustAI response complete")
        : "JustAI"

  if (mascot) {
    return (
      <span
        aria-label={label}
        className={cn("inline-block flex-none", className)}
        role="img"
      >
        <Mascot
          size="100%"
          state={active ? "working" : idle ? "sleeping" : "default"}
        />
      </span>
    )
  }

  return (
    <span
      aria-label={label}
      className={cn("justai-chat-mark", className)}
      data-state={state}
    >
      <BrandMark className="size-full text-inherit" />
    </span>
  )
}
