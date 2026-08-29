"use client"

import { useEffect, useRef, useState } from "react"
import { useAuiState } from "@assistant-ui/react"

import { BrandMark } from "@/components/brand-mark"
import { cn } from "@/lib/utils"

type ChatBrandMarkProps = {
  className?: string
}

/** The JustAI mark doubles as a quiet, contextual chat-status indicator. */
export function ChatBrandMark({ className }: ChatBrandMarkProps) {
  const isRunning = useAuiState((state) => state.thread.isRunning)
  const wasRunning = useRef(false)
  const timer = useRef<number | null>(null)
  const [celebrating, setCelebrating] = useState(false)

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    const completed = wasRunning.current && !isRunning
    wasRunning.current = isRunning

    if (completed) {
      timer.current = window.setTimeout(() => {
        setCelebrating(true)
        timer.current = window.setTimeout(() => setCelebrating(false), 850)
      }, 0)
    }

    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [isRunning])

  const state = isRunning ? "thinking" : celebrating ? "complete" : "idle"
  const label =
    state === "thinking"
      ? "JustAI is working"
      : state === "complete"
        ? "JustAI response complete"
        : "JustAI"

  return (
    <span aria-label={label} className={cn("justai-chat-mark", className)} data-state={state}>
      <BrandMark className="size-full" />
    </span>
  )
}
