"use client"

import { Activity, Clock3, Info, ListOrdered, UsersRound } from "lucide-react"

import type { TranscriptionWorkerAnalytics } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—"
  const totalSeconds = Math.round(value / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

function formatHours(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0h"
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)}h`
}

function metricLabel(value: number, suffix = "") {
  if (!Number.isFinite(value)) return "—"
  return `${new Intl.NumberFormat("en").format(Math.round(value))}${suffix}`
}

function WorkerMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Activity
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5" />
        {label}
      </div>
      <p className="mt-2 text-lg font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  )
}

export function PlatformTranscriptionWorkers({
  analytics,
  detailed = false,
}: {
  analytics: TranscriptionWorkerAnalytics | null | undefined
  detailed?: boolean
}) {
  if (!analytics) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Transcription workers</CardTitle>
          <CardDescription>Loading worker consumption…</CardDescription>
        </CardHeader>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Worker telemetry will appear when the platform responds.
        </CardContent>
      </Card>
    )
  }

  const capacity = Math.max(1, analytics.capacity)
  const utilization = Math.max(0, Math.min(100, analytics.utilizationPercent))
  const saturated = analytics.active >= capacity
  const hasQueue = analytics.queued > 0
  const statusLabel = hasQueue
    ? "Queue building"
    : saturated
      ? "At capacity"
      : "Capacity available"
  const statusVariant = hasQueue || saturated ? "outline" : "default"

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <UsersRound aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <CardTitle>Transcription workers</CardTitle>
            <CardDescription>
              Live capacity and video-processing usage over the last{" "}
              {analytics.periodDays} days.
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-lg border bg-muted/20 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">Live worker consumption</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {analytics.active} / {capacity} video jobs
            </span>
          </div>
          <Progress
            aria-label="Live transcription worker utilization"
            className="mt-3 h-2"
            value={utilization}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{Math.round(analytics.utilizationPercent)}% utilized</span>
            <span>
              {analytics.queued} queued · {analytics.activeSliceWorkers} slice
              workers active
            </span>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <WorkerMetric
            detail={`of ${capacity} concurrent slots`}
            icon={Activity}
            label="Active jobs"
            value={metricLabel(analytics.active)}
          />
          <WorkerMetric
            detail={`over ${analytics.periodDays} days`}
            icon={ListOrdered}
            label="Completed jobs"
            value={metricLabel(analytics.completedJobs)}
          />
          <WorkerMetric
            detail="Completed video duration"
            icon={Clock3}
            label="Audio processed"
            value={formatHours(analytics.audioHoursProcessed)}
          />
          <WorkerMetric
            detail="Waiting before a slot opens"
            icon={Clock3}
            label="P95 queue wait"
            value={formatDuration(analytics.p95QueueWaitMs)}
          />
        </div>

        <Alert>
          <Info />
          <AlertTitle>What adding workers changes</AlertTitle>
          <AlertDescription>
            Each additional capacity slot allows one more video to transcribe at
            the same time. It increases throughput and shortens queues, but also
            increases CPU, memory, provider requests, and potentially cost. The{" "}
            {analytics.sliceWorkersPerJob} slice workers shown here control
            parallel work inside each video; capacity controls how many videos
            can run together. Change{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              video_transcription_worker_capacity
            </code>{" "}
            in the backend configuration to add slots.
          </AlertDescription>
        </Alert>

        <div className="grid gap-2 sm:grid-cols-2">
          <WorkerMetric
            detail="Average time before work starts"
            icon={Clock3}
            label="Average queue wait"
            value={formatDuration(analytics.averageQueueWaitMs)}
          />
          <WorkerMetric
            detail="P95 end-to-end worker time"
            icon={Clock3}
            label="P95 processing time"
            value={formatDuration(analytics.p95ProcessingMs)}
          />
        </div>

        {detailed ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <thead>
                <tr className="border-b bg-muted/20 text-muted-foreground">
                  <th className="p-2.5 font-medium">UTC day</th>
                  <th className="p-2.5 font-medium">Jobs</th>
                  <th className="p-2.5 font-medium">Completed</th>
                  <th className="p-2.5 font-medium">Failed</th>
                  <th className="p-2.5 font-medium">Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {analytics.timeSeries.map((day) => (
                  <tr className="border-b last:border-0" key={day.date}>
                    <td className="p-2.5">{day.date}</td>
                    <td className="p-2.5 tabular-nums">{day.total}</td>
                    <td className="p-2.5 tabular-nums">{day.completed}</td>
                    <td className="p-2.5 tabular-nums">{day.failed}</td>
                    <td className="p-2.5 tabular-nums">{day.cancelled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {analytics.timeSeries.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                No video transcription jobs in this period.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
