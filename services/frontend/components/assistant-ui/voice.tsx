"use client"

import {
  AlertCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RotateCcw,
  X,
} from "lucide-react"
import {
  useVoiceControls,
  useVoiceState,
  useVoiceVolume,
} from "@assistant-ui/react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function VoiceControl({
  className,
  compact = false,
  centered = false,
  error,
  onClearError,
  onDismissError,
  toolApproval,
}: {
  className?: string
  compact?: boolean
  centered?: boolean
  error?: string | null
  onClearError?: () => void
  onDismissError?: () => void
  toolApproval?: ToolCallMessagePartProps | null
}) {
  const state = useVoiceState()
  const controls = useVoiceControls()
  const volume = useVoiceVolume()
  const active =
    state?.status.type === "running" || state?.status.type === "starting"
  const muted = state?.isMuted === true
  const orbState = error
    ? "error"
    : state?.status.type === "starting"
      ? "connecting"
      : muted
        ? "muted"
        : state?.mode === "speaking"
          ? "speaking"
          : active
            ? "listening"
            : "idle"

  if (centered) {
    const statusLabel = error
      ? "Voice unavailable"
      : state?.status.type === "starting"
        ? "Connecting to voice"
        : active
          ? muted
            ? "Voice muted"
            : state?.mode === "speaking"
              ? "Assistant is speaking"
              : "Listening"
          : "Voice mode"
    const statusDescription = error
      ? error
      : active
        ? "Speak naturally. You can interrupt the assistant at any time."
        : "Start a hands-free conversation with JustAI."

    return (
      <div
        className={cn(
          "absolute inset-0 z-40 flex min-h-0 items-center justify-center overflow-y-auto bg-background/95 px-6 py-12 backdrop-blur-sm",
          className
        )}
      >
        <div className="flex w-full max-w-lg flex-col items-center gap-7 text-center">
          <div className="relative flex items-center justify-center">
            <div className="absolute size-56 rounded-full bg-primary/5 blur-3xl" />
            <VoiceOrb
              className="relative size-40 border-primary/30 bg-primary/10 shadow-[0_0_120px_rgba(99,102,241,0.28)] sm:size-48"
              state={orbState}
              volume={volume}
            />
          </div>
          <div className="space-y-2">
            <p className="text-lg font-semibold tracking-tight">
              {statusLabel}
            </p>
            <p
              className={cn(
                "mx-auto max-w-md text-sm leading-6 text-muted-foreground",
                error && "text-destructive"
              )}
            >
              {statusDescription}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {error ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    controls.connect()
                    onClearError?.()
                  }}
                >
                  <RotateCcw aria-hidden="true" className="mr-2 size-4" />
                  Try again
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onDismissError ?? onClearError}
                >
                  Back to chat
                </Button>
              </>
            ) : active ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => (muted ? controls.unmute() : controls.mute())}
                >
                  {muted ? (
                    <Mic aria-hidden="true" className="mr-2 size-4" />
                  ) : (
                    <MicOff aria-hidden="true" className="mr-2 size-4" />
                  )}
                  {muted ? "Unmute" : "Mute"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={controls.disconnect}
                >
                  <PhoneOff aria-hidden="true" className="mr-2 size-4" />
                  End voice
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => {
                  onClearError?.()
                  controls.connect()
                }}
              >
                <Phone aria-hidden="true" className="mr-2 size-4" />
                Start voice
              </Button>
            )}
          </div>
          {error && (
            <div className="flex max-w-md items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-left text-xs text-destructive">
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{error}</span>
            </div>
          )}
          {toolApproval && (
            <div className="w-full max-w-lg">
              <ToolFallback {...toolApproval} />
            </div>
          )}
        </div>
      </div>
    )
  }

  if (compact) {
    const label = active
      ? muted
        ? "Unmute voice"
        : "Mute voice"
      : "Start voice"
    return (
      <div className={cn("relative flex items-center", className)}>
        <Button
          aria-label={label}
          aria-pressed={active && !muted}
          className={cn(
            "relative size-9 rounded-full p-0 text-muted-foreground hover:bg-muted hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-primary/50",
            active && "bg-primary/10 text-primary hover:bg-primary/15",
            muted && "opacity-70"
          )}
          onClick={() => {
            if (!active) controls.connect()
            else if (muted) controls.unmute()
            else controls.mute()
          }}
          type="button"
          variant="ghost"
        >
          <VoiceOrb
            className="absolute inset-1 border-0 bg-primary/10 shadow-none"
            compact
            state={orbState}
            volume={volume}
          />
          <span className="sr-only">{label}</span>
        </Button>
        {active && (
          <Button
            aria-label="End voice"
            className="ml-0.5 size-7 rounded-full p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={controls.disconnect}
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-3.5" />
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
  return (
    <div className={cn("relative flex items-center gap-2", className)}>
      <VoiceOrb
        className="shrink-0 border-0 bg-primary/10 shadow-none"
        compact
        state={orbState}
        volume={volume}
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-2 rounded-full bg-muted-foreground",
            active && "animate-pulse bg-emerald-500"
          )}
        />
        {state?.status.type === "starting"
          ? "Connecting"
          : active
            ? muted
              ? "Muted"
              : "Voice active"
            : "Voice"}
      </div>
      {active ? (
        <>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => (muted ? controls.unmute() : controls.mute())}
            aria-label={muted ? "Unmute voice" : "Mute voice"}
          >
            {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={controls.disconnect}
            aria-label="End voice"
          >
            <PhoneOff aria-hidden="true" />
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={controls.connect}
          aria-label="Start voice"
        >
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
  state?: "idle" | "connecting" | "listening" | "speaking" | "muted" | "error"
  volume?: number
}) {
  const effectiveVolume = volume
  return (
    <div
      aria-label={`Voice state: ${state}`}
      className={cn(
        "relative flex items-center justify-center rounded-full border border-primary/20 bg-primary/10 shadow-[0_0_80px_rgba(99,102,241,0.22)]",
        compact ? "size-6" : "size-40",
        (state === "connecting" || state === "speaking") && "animate-pulse",
        state === "error" && "border-destructive/40 bg-destructive/10",
        state === "muted" && "opacity-60 saturate-50",
        className
      )}
      role="img"
      style={{ transform: `scale(${1 + Math.min(effectiveVolume, 1) * 0.08})` }}
    >
      <div
        className={cn(
          "rounded-full bg-gradient-to-br from-primary/80 via-primary/40 to-transparent blur-[1px]",
          compact ? "size-4" : "size-28"
        )}
      />
      <div
        className={cn(
          "absolute rounded-full bg-primary/80 blur-md",
          compact ? "size-2.5" : "size-16"
        )}
      />
    </div>
  )
}
