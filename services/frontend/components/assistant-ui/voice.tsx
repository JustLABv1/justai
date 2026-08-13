"use client"

import { Mic, MicOff, Phone, PhoneOff } from "lucide-react"
import { useVoiceControls, useVoiceState, useVoiceVolume } from "@assistant-ui/react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function VoiceControl({
  className,
  toolApproval,
}: {
  className?: string
  toolApproval?: ToolCallMessagePartProps | null
}) {
  const state = useVoiceState()
  const controls = useVoiceControls()
  const volume = useVoiceVolume()
  const active = state?.status.type === "running" || state?.status.type === "starting"
  const muted = state?.isMuted === true
  const orbState = state?.mode === "speaking" ? "speaking" : active ? "listening" : "idle"
  return (
    <div className={cn("relative flex items-center gap-2", className)}>
      <VoiceOrb className="shrink-0 border-0 bg-primary/10 shadow-none" compact state={orbState} volume={volume} />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("size-2 rounded-full bg-muted-foreground", active && "animate-pulse bg-emerald-500")} />
        {state?.status.type === "starting" ? "Connecting" : active ? (muted ? "Muted" : "Voice active") : "Voice"}
      </div>
      {active ? (
        <>
          <Button type="button" size="icon" variant="ghost" onClick={() => (muted ? controls.unmute() : controls.mute())} aria-label={muted ? "Unmute voice" : "Mute voice"}>
            {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </Button>
          <Button type="button" size="icon" variant="ghost" onClick={controls.disconnect} aria-label="End voice">
            <PhoneOff aria-hidden="true" />
          </Button>
        </>
      ) : (
        <Button type="button" size="icon" variant="ghost" onClick={controls.connect} aria-label="Start voice">
          <Phone aria-hidden="true" />
        </Button>
      )}
      {toolApproval && (
        <div className="absolute right-0 bottom-full z-30 mb-3 w-[min(22rem,calc(100vw-2rem))]">
          <ToolFallback {...toolApproval} />
        </div>
      )}
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
  state?: "idle" | "listening" | "speaking" | "error"
  volume?: number
}) {
  const active = state === "listening" || state === "speaking"
  const effectiveVolume = volume
  return (
    <div
      aria-label={`Voice state: ${state}`}
      className={cn("relative flex items-center justify-center rounded-full border border-primary/20 bg-primary/10 shadow-[0_0_80px_rgba(99,102,241,0.22)]", compact ? "size-6" : "size-40", active && "animate-pulse", state === "error" && "border-destructive/40 bg-destructive/10", className)}
      role="img"
      style={{ transform: `scale(${1 + Math.min(effectiveVolume, 1) * 0.08})` }}
    >
      <div className={cn("rounded-full bg-gradient-to-br from-primary/80 via-primary/40 to-transparent blur-[1px]", compact ? "size-4" : "size-28")} />
      <div className={cn("absolute rounded-full bg-primary/80 blur-md", compact ? "size-2.5" : "size-16")} />
    </div>
  )
}
