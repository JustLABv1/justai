"use client"

import { useTranslations } from "@/components/locale-provider"
import { Mic } from "lucide-react"
import { useVoiceControls } from "@assistant-ui/react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { Prompt } from "@/components/panelui/prompt"
import { cn } from "@/lib/utils"

/** Starts a voice session. While one runs, the composer shows its Prompt.Recorder instead. */
export function VoiceControl({ className }: { className?: string }) {
  const { t } = useTranslations()

  const controls = useVoiceControls()
  return (
    <div className={cn("relative flex items-center", className)}>
      <Prompt.Tool label={t("Start voice")} onClick={controls.connect}>
        <Mic />
      </Prompt.Tool>
    </div>
  )
}

/** A tool the voice session wants approved, shown over the composer. */
export function VoiceToolApproval({
  toolApproval,
}: {
  toolApproval?: ToolCallMessagePartProps | null
}) {
  if (!toolApproval) return null
  return (
    <div className="absolute right-0 bottom-full z-30 mb-3 w-[min(22rem,calc(100vw-2rem))]">
      <ToolFallback {...toolApproval} />
    </div>
  )
}

export function VoiceOrb({
  className,
  compact = false,
  state = "idle",
  volume = 0,
}: {
  className?: string
  compact?: boolean
  state?: "idle" | "connecting" | "listening" | "speaking" | "muted" | "error"
  volume?: number
}) {
  const effectiveVolume = Math.min(Math.max(volume, 0), 1)
  const scale =
    state === "speaking"
      ? 1 + effectiveVolume * 0.06
      : state === "listening"
        ? 1 + effectiveVolume * 0.035
        : 1
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative flex items-center justify-center rounded-full border border-primary/20 bg-primary/10 shadow-[0_0_80px_rgba(99,102,241,0.22)]",
        compact ? "size-6" : "size-40",
        state === "error" && "border-destructive/40 bg-destructive/10",
        state === "muted" && "opacity-60 saturate-50",
        className
      )}
    >
      {state === "connecting" ? (
        <span className="absolute inset-[-5px] rounded-full border border-transparent border-t-primary motion-safe:animate-spin motion-reduce:border-primary/40" />
      ) : null}
      {state === "listening" ? (
        <span className="absolute inset-[12%] rounded-full border border-primary/30 opacity-70" />
      ) : null}
      <div
        className={cn(
          "rounded-full bg-gradient-to-br from-primary/80 via-primary/40 to-transparent blur-[1px] transition-transform duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
          compact ? "size-4" : "size-28"
        )}
        style={{ transform: `scale(${scale})` }}
      />
      <div
        className={cn(
          "absolute rounded-full bg-primary/80 blur-md transition-transform duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
          compact ? "size-2.5" : "size-16"
        )}
        style={{ transform: `scale(${Math.max(1, scale - 0.015)})` }}
      />
    </div>
  )
}
