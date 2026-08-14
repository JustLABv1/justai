"use client"

import { useState } from "react"
import {
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Shield,
} from "lucide-react"
import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react"

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

function parseResult(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function compactValue(value: unknown) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
  }
  return formatValue(value)
}

function StructuredToolResult({ value }: { value: unknown }) {
  const parsed = parseResult(value)
  const records = Array.isArray(parsed)
    ? parsed.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : typeof parsed === "object" && parsed !== null
      ? Object.values(parsed).find(
          (item): item is Record<string, unknown>[] =>
            Array.isArray(item) &&
            item.every(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                !Array.isArray(entry)
            )
        )
      : undefined
  if (records && records.length > 0) {
    const columns = Array.from(
      new Set(records.flatMap((record) => Object.keys(record)))
    ).slice(0, 6)
    return (
      <div className="overflow-auto rounded-lg border bg-background/60">
        <table className="w-full min-w-[24rem] text-left text-xs">
          <thead className="border-b bg-muted/40 text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th className="px-2 py-1.5 font-medium" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.slice(0, 20).map((record, rowIndex) => (
              <tr className="border-b last:border-0" key={rowIndex}>
                {columns.map((column) => (
                  <td className="max-w-64 px-2 py-1.5 align-top" key={column}>
                    <span className="line-clamp-3 break-words whitespace-pre-wrap text-muted-foreground">
                      {compactValue(record[column] ?? "")}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed).slice(0, 8)
    return (
      <dl className="grid gap-2 sm:grid-cols-2">
        {entries.map(([key, entry]) => (
          <div
            className="rounded-lg border bg-background/60 px-2 py-1.5"
            key={key}
          >
            <dt className="font-medium text-foreground">{key}</dt>
            <dd className="mt-0.5 break-words whitespace-pre-wrap text-muted-foreground">
              {compactValue(entry)}
            </dd>
          </div>
        ))}
      </dl>
    )
  }
  if (typeof parsed === "string" && parsed.trim() !== "") {
    return (
      <p className="rounded-lg border bg-background/60 px-2 py-1.5 whitespace-pre-wrap text-muted-foreground">
        {parsed}
      </p>
    )
  }
  return (
    <pre className="max-h-48 overflow-auto rounded-lg border bg-background/60 px-2 py-1.5 break-all whitespace-pre-wrap text-muted-foreground">
      {formatValue(value)}
    </pre>
  )
}

export const ToolFallback: ToolCallMessagePartComponent = (
  props: ToolCallMessagePartProps
) => {
  const [open, setOpen] = useState(props.approval?.approved === undefined)
  const requiresApproval = Boolean(
    props.approval &&
    props.approval.approved === undefined &&
    !props.approval.resolution
  )
  const status = props.status?.type
  const isRunning = status === "running" || requiresApproval
  const isDenied = props.approval?.approved === false
  const isCancelled =
    status === "incomplete" && props.status.reason === "cancelled"
  const errorText = isDenied
    ? props.approval?.reason || "Denied by user"
    : status === "incomplete" && props.status.error
      ? String(props.status.error)
      : undefined
  const isError =
    isDenied ||
    (status === "incomplete" && !isCancelled) ||
    props.isError === true
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
          <Shield
            className="size-4 shrink-0 text-amber-500"
            aria-hidden="true"
          />
        ) : isError || isCancelled ? (
          <CircleAlert
            className="size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : isRunning ? (
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Check
            className="size-4 shrink-0 text-emerald-500"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {props.toolName}
        </span>
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
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-3 text-xs">
          {props.argsText && (
            <details
              open
              className="rounded-lg border bg-background/60 px-2 py-1.5"
            >
              <summary className="cursor-pointer font-medium">
                Arguments
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto break-all whitespace-pre-wrap text-muted-foreground">
                {props.argsText}
              </pre>
            </details>
          )}
          {requiresApproval && props.respondToApproval && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => props.respondToApproval?.({ approved: true })}
              >
                Allow
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  props.respondToApproval?.({
                    approved: false,
                    reason: "Denied by user",
                  })
                }
              >
                Deny
              </Button>
            </div>
          )}
          {errorText && (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
              {errorText}
            </p>
          )}
          {hasResult && <StructuredToolResult value={props.result} />}
        </div>
      )}
    </div>
  )
}
