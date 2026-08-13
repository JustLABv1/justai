"use client"

import { useState } from "react"
import { Check, ChevronDown, CircleAlert, LoaderCircle, Shield } from "lucide-react"
import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from "@assistant-ui/react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function formatValue(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const ToolFallback: ToolCallMessagePartComponent = (props: ToolCallMessagePartProps) => {
  const [open, setOpen] = useState(props.approval?.approved === undefined)
  const requiresApproval = Boolean(
    props.approval &&
      props.approval.approved === undefined &&
      !props.approval.resolution
  )
  const status = props.status?.type
  const isRunning = status === "running" || requiresApproval
  const isDenied = props.approval?.approved === false
  const isCancelled = status === "incomplete" && props.status.reason === "cancelled"
  const errorText =
    isDenied
      ? props.approval?.reason || "Denied by user"
      : status === "incomplete" && props.status.error
        ? String(props.status.error)
      : undefined
  const isError = isDenied || (status === "incomplete" && !isCancelled) || props.isError === true
  const hasResult = props.result !== undefined

  return (
    <div className="my-2 w-full max-w-xl overflow-hidden rounded-xl border bg-muted/30 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {requiresApproval ? (
          <Shield className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
        ) : isError || isCancelled ? (
          <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : isRunning ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <Check className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{props.toolName}</span>
        <span className="text-xs text-muted-foreground">
          {requiresApproval
            ? "Approval needed"
            : isCancelled
              ? "Cancelled"
              : isDenied
              ? "Denied"
              : isError
                ? "Failed"
                : hasResult
                  ? "Completed"
                  : "Running"}
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-3 text-xs">
          {props.argsText && (
            <details open className="rounded-lg border bg-background/60 px-2 py-1.5">
              <summary className="cursor-pointer font-medium">Arguments</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">{props.argsText}</pre>
            </details>
          )}
          {requiresApproval && props.respondToApproval && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={() => props.respondToApproval?.({ approved: true })}>
                Allow
              </Button>
              <Button size="sm" variant="outline" onClick={() => props.respondToApproval?.({ approved: false, reason: "Denied by user" })}>
                Deny
              </Button>
            </div>
          )}
          {errorText && <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">{errorText}</p>}
          {hasResult && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-background/60 px-2 py-1.5 text-muted-foreground">{formatValue(props.result)}</pre>}
        </div>
      )}
    </div>
  )
}
