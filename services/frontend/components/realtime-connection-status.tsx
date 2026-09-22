"use client"

import { AlertTriangle, CheckCircle2, RefreshCw, WifiOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { SSEConnectionState } from "@/lib/sse-transport"
import { cn } from "@/lib/utils"

export const initialRealtimeState: SSEConnectionState = {
  state: "connecting",
  audioQuality: "good",
  attempt: 0,
  maxAttempts: 5,
}

export function RealtimeConnectionStatus({
  status,
  interruptionAt,
  className,
}: {
  status: SSEConnectionState
  interruptionAt?: Date | null
  className?: string
}) {
  const reconnecting = status.state === "reconnecting"
  const degraded = status.state === "degraded"
  const disconnected = status.state === "disconnected"
  const label = reconnecting
    ? `Reconnecting · attempt ${status.attempt} of ${status.maxAttempts}`
    : degraded
      ? "Connection degraded"
      : disconnected
        ? "Disconnected"
        : status.state === "connecting"
          ? "Connecting"
          : "Live"
  const Icon = reconnecting
    ? RefreshCw
    : degraded
      ? AlertTriangle
      : disconnected
        ? WifiOff
        : CheckCircle2
  const quality =
    status.audioQuality === "dropping"
      ? "Dropping audio"
      : status.audioQuality === "delayed"
        ? "Audio delayed"
        : "Audio good"

  return (
    <div className={cn("rounded-lg border bg-card px-3 py-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div
          aria-live="polite"
          className="flex items-center gap-2"
          role="status"
        >
          <Icon
            className={cn(
              "size-3.5",
              reconnecting && "motion-safe:animate-spin"
            )}
            aria-hidden="true"
          />
          <span className="font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            Signal level is separate
          </span>
          <Badge variant={degraded || disconnected ? "outline" : "secondary"}>
            {quality}
          </Badge>
        </div>
      </div>
      {reconnecting ? (
        <Progress
          className="mt-2 h-1"
          value={(status.attempt / status.maxAttempts) * 100}
        />
      ) : null}
      {interruptionAt ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Possible transcript gap near{" "}
          {interruptionAt.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
          .
        </p>
      ) : null}
    </div>
  )
}
