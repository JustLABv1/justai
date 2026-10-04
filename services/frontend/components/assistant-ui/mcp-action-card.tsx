"use client"

import type { ReactNode } from "react"
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  LoaderCircle,
  X,
} from "lucide-react"
import type { ToolCallEntry } from "@/components/ui/tool-calls-section"
import { formatToolName, getToolCategoryIcon } from "@/lib/utils/tool-icons"
import { cn } from "@/lib/utils"

function parameterLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())
}

function parameterValue(value: unknown): string {
  if (value === null) return "None"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value)) return `${value.length} items`
  if (typeof value === "object") return "See details"
  return String(value)
}

export function MCPActionCard({
  call,
  children,
}: {
  call: ToolCallEntry
  children?: ReactNode
}) {
  const notExecuted =
    call.approval?.approved === false || call.status === "cancelled"
  const status = notExecuted
    ? "Not executed"
    : call.status === "waiting"
      ? "Waiting for approval"
      : call.status === "running"
        ? "Running…"
        : call.status === "failed"
          ? "Failed"
          : "Completed"
  const Icon = notExecuted
    ? X
    : call.status === "waiting"
      ? Clock3
      : call.status === "running"
        ? LoaderCircle
        : call.status === "failed"
          ? CircleAlert
          : Check
  const parameters = Object.entries(call.inputs ?? {})
  return (
    <section
      aria-label={call.message || formatToolName(call.tool_name)}
      className="mb-2 w-full max-w-2xl rounded-2xl bg-card px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
        >
          {getToolCategoryIcon(
            call.tool_category,
            { width: 18, height: 18 },
            call.icon_url
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {call.message || formatToolName(call.tool_name)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{call.integration_name || "MCP"}</span>
            <span aria-hidden="true">·</span>
            <span
              role="status"
              className={cn(
                "inline-flex items-center gap-1.5",
                call.status === "failed" && !notExecuted && "text-destructive"
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  "size-3.5",
                  call.status === "running" &&
                    !notExecuted &&
                    "animate-spin motion-reduce:animate-none"
                )}
              />
              {status}
            </span>
          </div>
          {parameters.length > 0 && (
            <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {parameters.slice(0, 4).map(([key, value]) => (
                <div key={key} className="flex max-w-full min-w-0 gap-1">
                  <dt className="shrink-0 text-muted-foreground">
                    {parameterLabel(key)}:
                  </dt>
                  <dd
                    className="truncate text-foreground"
                    title={parameterValue(value)}
                  >
                    {parameterValue(value)}
                  </dd>
                </div>
              ))}
              {parameters.length > 4 && (
                <div className="text-muted-foreground">
                  +{parameters.length - 4} more in details
                </div>
              )}
            </dl>
          )}
          {call.error && !notExecuted && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {call.error}
            </p>
          )}
          <details className="group/details mt-2">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 group-open/details:rotate-90"
              />
              Details
            </summary>
            <div className="mt-2 space-y-3 text-xs">
              <p className="break-all text-muted-foreground">
                Tool: {call.tool_name}
              </p>
              {parameters.length > 0 && (
                <div>
                  <p className="mb-1 font-medium">Parameters</p>
                  <pre className="max-h-60 overflow-auto rounded-lg bg-muted p-3 break-all whitespace-pre-wrap">
                    {JSON.stringify(call.inputs, null, 2)}
                  </pre>
                </div>
              )}
              {call.approval?.reason && (
                <p className="text-muted-foreground">{call.approval.reason}</p>
              )}
              {call.approval?.resolution === "expired" && (
                <p className="text-muted-foreground">
                  The approval request expired.
                </p>
              )}
              {call.output && (
                <div className="min-w-0">
                  <p className="mb-1 font-medium">Result</p>
                  {children}
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
    </section>
  )
}
