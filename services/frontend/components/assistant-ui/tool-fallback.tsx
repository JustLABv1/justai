"use client"

import Image from "next/image"
import { useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  Shield,
} from "lucide-react"
import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react"

import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import {
  formatFileSize,
  hasFileResultShape,
  parseGeneratedFileResult,
  parseToolResult,
} from "@/lib/file-result-logic"
import { cn } from "@/lib/utils"

function formatValue(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolLabel(toolName: string) {
  switch (toolName) {
    case "web_search":
      return "Web search"
    case "browse_url":
      return "Browse URL"
    case "generate_image":
      return "Generate image"
    case "edit_image":
      return "Edit image"
    case "create_pdf":
      return "Create PDF"
    default:
      return toolName
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
  const parsed = parseToolResult(value)
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

type ImageToolResult = {
  image?: {
    url?: unknown
    prompt?: unknown
    mode?: unknown
  }
}

function GeneratedImageResult({ value }: { value: unknown }) {
  const parsed = parseToolResult(value) as ImageToolResult | null
  const image = parsed?.image
  const imageURL = typeof image?.url === "string" ? image.url : ""
  const prompt =
    typeof image?.prompt === "string" ? image.prompt : "Generated image"
  const mode = image?.mode === "edit" ? "Edited image" : "Generated image"
  const [preview, setPreview] = useState({ source: "", url: "" })
  const [loadError, setLoadError] = useState({ source: "", message: "" })
  const previewRef = useRef("")

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current)
      previewRef.current = ""
    }
    if (!imageURL) return () => undefined

    void api
      .getBlob(imageURL, { signal: controller.signal })
      .then((blob) => {
        const nextURL = URL.createObjectURL(blob)
        if (!active) {
          URL.revokeObjectURL(nextURL)
          return
        }
        previewRef.current = nextURL
        setPreview({ source: imageURL, url: nextURL })
      })
      .catch((caught) => {
        if (active) {
          setLoadError({
            source: imageURL,
            message:
              caught instanceof Error
                ? caught.message
                : "The image could not be loaded.",
          })
        }
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [imageURL])

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    }
  }, [])

  if (!imageURL) return <StructuredToolResult value={value} />
  if (loadError.source === imageURL && loadError.message) {
    return (
      <p className="rounded-lg border bg-destructive/10 px-2 py-1.5 text-destructive">
        {loadError.message}
      </p>
    )
  }
  if (preview.source !== imageURL || !preview.url) {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg border bg-background/60 px-2 py-1.5 text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        Loading image…
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-background/60">
      <Image
        alt={prompt}
        className="h-auto max-h-[32rem] w-full object-contain"
        height={1024}
        src={preview.url}
        unoptimized
        width={1024}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2 py-1.5">
        <span className="text-muted-foreground">{mode}</span>
        <a
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium hover:bg-muted"
          download
          href={preview.url}
        >
          <Download className="size-3" aria-hidden="true" />
          Download
        </a>
      </div>
    </div>
  )
}

function GeneratedFileResult({ value }: { value: unknown }) {
  const file = parseGeneratedFileResult(value)
  const fileURL = file?.url ?? ""
  const [preview, setPreview] = useState({ source: "", url: "" })
  const [loadError, setLoadError] = useState({ source: "", message: "" })
  const previewRef = useRef("")

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current)
      previewRef.current = ""
    }
    if (!fileURL) return () => undefined

    void api
      .getBlob(fileURL, { signal: controller.signal })
      .then((blob) => {
        const nextURL = URL.createObjectURL(blob)
        if (!active) {
          URL.revokeObjectURL(nextURL)
          return
        }
        previewRef.current = nextURL
        setPreview({ source: fileURL, url: nextURL })
      })
      .catch((caught) => {
        if (active) {
          setLoadError({
            source: fileURL,
            message:
              caught instanceof Error
                ? caught.message
                : "The PDF could not be loaded.",
          })
        }
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [fileURL])

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    }
  }, [])

  if (!file) {
    if (!hasFileResultShape(value))
      return <StructuredToolResult value={value} />
    return (
      <div className="space-y-2">
        <p
          aria-live="polite"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-destructive"
          role="alert"
        >
          The PDF result is incomplete and does not include a valid download
          URL.
        </p>
        <StructuredToolResult value={value} />
      </div>
    )
  }

  if (loadError.source === fileURL && loadError.message) {
    return (
      <p
        aria-live="polite"
        className="rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-destructive"
        role="alert"
      >
        Unable to load this PDF: {loadError.message}
      </p>
    )
  }

  if (preview.source !== fileURL || !preview.url) {
    return (
      <div
        aria-live="polite"
        className="inline-flex items-center gap-2 rounded-lg border bg-background/60 px-2 py-1.5 text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        Loading PDF…
      </div>
    )
  }

  const sizeLabel = formatFileSize(file.size) ?? "Size unavailable"
  const canOpen =
    file.mimeType.toLowerCase() === "application/pdf" ||
    file.filename.toLowerCase().endsWith(".pdf")

  return (
    <div className="overflow-hidden rounded-lg border bg-background/60">
      <div className="flex items-start gap-3 p-3">
        <div
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive"
        >
          <FileText className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-medium text-foreground"
            title={file.title}
          >
            {file.title}
          </p>
          <p className="truncate text-muted-foreground" title={file.filename}>
            {file.filename}
          </p>
          <p className="mt-1 text-muted-foreground">
            {sizeLabel} · {file.mimeType}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        <span className="text-muted-foreground">Generated PDF</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {canOpen && (
            <a
              aria-label={`Open ${file.filename} in a new tab`}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
              href={preview.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              Open
            </a>
          )}
          <a
            aria-label={`Download ${file.filename}`}
            className="inline-flex items-center gap-1 rounded-md border bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            download={file.filename}
            href={preview.url}
          >
            <Download className="size-3" aria-hidden="true" />
            Download
          </a>
        </div>
      </div>
    </div>
  )
}

type WebSearchToolResult = {
  query?: unknown
  url?: unknown
  content?: unknown
  results?: Array<{
    title?: unknown
    url?: unknown
    snippet?: unknown
  }>
}

function WebSearchResult({ value }: { value: unknown }) {
  const parsed = parseToolResult(value) as WebSearchToolResult | null
  const results = Array.isArray(parsed?.results) ? parsed.results : []
  if (results.length === 0) {
    if (typeof parsed?.content === "string") {
      return (
        <p className="rounded-lg border bg-background/60 px-2 py-1.5 whitespace-pre-wrap text-muted-foreground">
          {parsed.content}
        </p>
      )
    }
    return <StructuredToolResult value={value} />
  }
  return (
    <div className="space-y-1.5">
      {results.slice(0, 8).map((result, index) => {
        const title =
          typeof result.title === "string" ? result.title : "Search result"
        const url = typeof result.url === "string" ? result.url : ""
        const snippet = typeof result.snippet === "string" ? result.snippet : ""
        return (
          <a
            className="block rounded-lg border bg-background/60 px-2 py-1.5 hover:bg-muted"
            href={url || undefined}
            key={`${url}-${index}`}
            rel="noreferrer"
            target="_blank"
          >
            <span className="block font-medium text-foreground">{title}</span>
            {url && (
              <span className="block truncate text-[11px] text-primary">
                {url}
              </span>
            )}
            {snippet && (
              <span className="mt-0.5 line-clamp-2 block text-muted-foreground">
                {snippet}
              </span>
            )}
          </a>
        )
      })}
    </div>
  )
}

export function ToolResultContent({
  toolName,
  value,
}: {
  toolName: string
  value: unknown
}) {
  if (toolName === "generate_image" || toolName === "edit_image") {
    return <GeneratedImageResult value={value} />
  }
  if (toolName === "create_pdf") {
    return <GeneratedFileResult value={value} />
  }
  if (toolName === "web_search" || toolName === "browse_url") {
    return <WebSearchResult value={value} />
  }
  return <StructuredToolResult value={value} />
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
  const argsText =
    props.toolName === "create_pdf" && (props.argsText?.length ?? 0) > 4_000
      ? `${props.argsText?.slice(0, 4_000)}\n… PDF content truncated in this preview.`
      : props.argsText

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
          {toolLabel(props.toolName)}
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
          {argsText && (
            <details
              open={props.toolName !== "create_pdf"}
              className="rounded-lg border bg-background/60 px-2 py-1.5"
            >
              <summary className="cursor-pointer font-medium">
                Arguments
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto break-all whitespace-pre-wrap text-muted-foreground">
                {argsText}
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
          {hasResult && (
            <ToolResultContent toolName={props.toolName} value={props.result} />
          )}
        </div>
      )}
    </div>
  )
}
