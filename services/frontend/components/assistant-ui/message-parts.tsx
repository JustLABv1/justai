"use client"

import Image from "next/image"
import { Children, useMemo } from "react"
import {
  CircleAlert,
  FileText,
  LoaderCircle,
  Quote,
  Sparkles,
} from "lucide-react"
import {
  groupPartByType,
  MessagePrimitive,
  useAui,
  useAuiState,
  type GroupByContext,
  type PartState,
  type EnrichedPartState,
} from "@assistant-ui/react"

import { AssistantMarkdown } from "@/components/assistant-ui/markdown-text"
import { AssistantSource } from "@/components/assistant-ui/sources"
import { ToolResultContent } from "@/components/assistant-ui/tool-fallback"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CompactMarkdown } from "@/components/ui/compact-markdown"
import {
  ToolCallsSection,
  type ToolCallEntry,
} from "@/components/ui/tool-calls-section"
import { cn } from "@/lib/utils"
import { formatToolName } from "@/lib/utils/tool-icons"

type RetrievalStatus = {
  status?: string
  query?: string
  citationCount?: number
  sourceCount?: number
  passageCount?: number
  error?: string
}

function RetrievalStatusPart({ data }: { data: unknown }) {
  const value = (data ?? {}) as RetrievalStatus
  const status = value.status ?? "started"
  const sourceCountFromMessage = useAuiState((state) => {
    const sourceIDs = new Set<string>()
    for (const part of state.message.parts) {
      if (part.type === "source") sourceIDs.add(part.id)
    }
    return sourceIDs.size
  })
  const sourceCount =
    typeof value.sourceCount === "number"
      ? value.sourceCount
      : sourceCountFromMessage || value.citationCount || 0
  const passageCount =
    typeof value.passageCount === "number"
      ? value.passageCount
      : value.citationCount
  const sourceLabel = `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`
  const passageLabel =
    typeof passageCount === "number" && passageCount > sourceCount
      ? ` · ${passageCount} matches`
      : ""
  const label =
    status === "completed"
      ? `Grounding ready · ${sourceLabel}${passageLabel}`
      : status === "failed"
        ? "Grounding unavailable"
        : status === "disabled"
          ? "Knowledge grounding is disabled"
          : "Searching attached context…"

  return (
    <div
      className={cn(
        "my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground",
        status === "failed" && "border-destructive/30 text-destructive",
        status === "completed" && "border-primary/30 text-foreground"
      )}
      title={value.query ? `Query: ${value.query}` : undefined}
    >
      {status === "started" ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      ) : status === "completed" ? (
        <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
      ) : (
        <FileText className="size-3.5" aria-hidden="true" />
      )}
      <span>{label}</span>
      {value.error && <span className="truncate">· {value.error}</span>}
    </div>
  )
}

function AssistantErrorPart({ data }: { data: unknown }) {
  const value = data as { message?: unknown } | null
  const message =
    value && typeof value.message === "string"
      ? value.message
      : "The assistant could not complete this response."

  return (
    <Alert className="my-2 max-w-4xl" variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="break-words whitespace-pre-wrap text-destructive/90">
        {message}
      </AlertDescription>
    </Alert>
  )
}

function ReasoningPart({ text }: { text: string }) {
  return (
    <div className="my-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <Sparkles className="size-3.5" aria-hidden="true" />
        Thinking
      </div>
      <div className="mt-1 whitespace-pre-wrap opacity-80">{text}</div>
    </div>
  )
}

type ToolCallPart = Extract<PartState, { type: "tool-call" }>

const toolLabels: Record<string, string> = {
  web_search: "Web search",
  browse_url: "Browse URL",
  generate_image: "Generate image",
  edit_image: "Edit image",
}

function toolCategory(toolName: string) {
  if (toolName === "web_search") return "web_search"
  if (toolName === "browse_url") return "browse_url"
  if (toolName === "generate_image") return "generate_image"
  if (toolName === "edit_image") return "edit_image"
  if (toolName.toLowerCase().includes("memory")) return "memory"
  return "integrations"
}

function formatMCPToolName(toolName: string) {
  const normalized = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
  if (!normalized) return "MCP tool"
  return normalized
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

function toolLabel(toolName: string, rawToolName?: string) {
  if (rawToolName) return formatMCPToolName(rawToolName)
  return toolLabels[toolName] ?? formatToolName(toolName)
}

function justAIToolMetadata(part: ToolCallPart) {
  const rawMetadata = part.providerMetadata?.justai
  if (!rawMetadata || typeof rawMetadata !== "object") return {}
  const metadata = rawMetadata as {
    serverName?: unknown
    toolName?: unknown
  }
  return {
    serverName:
      typeof metadata.serverName === "string" ? metadata.serverName : undefined,
    toolName:
      typeof metadata.toolName === "string" ? metadata.toolName : undefined,
  }
}

function parseToolInputs(
  part: ToolCallPart
): Record<string, unknown> | undefined {
  if (part.args && typeof part.args === "object" && !Array.isArray(part.args)) {
    return part.args as Record<string, unknown>
  }

  const argsText = part.argsText.trim()
  if (!argsText) return undefined

  try {
    const parsed = JSON.parse(argsText) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Arguments can still be incomplete while the model is streaming.
  }

  return { raw: argsText }
}

function formatToolValue(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolCallStatus(
  part: ToolCallPart,
  threadIsRunning: boolean
): ToolCallEntry["status"] {
  if (
    part.approval?.resolution === "cancelled" ||
    part.approval?.resolution === "expired"
  ) {
    return "cancelled"
  }
  if (
    part.approval &&
    part.approval.approved === undefined &&
    !part.approval.resolution
  ) {
    return "waiting"
  }
  if (part.isError || part.status.type === "incomplete") return "failed"
  if (
    part.status.type === "running" ||
    (threadIsRunning &&
      part.status.type === "requires-action" &&
      part.approval?.approved === true)
  ) {
    return "running"
  }
  if (
    part.status.type === "requires-action" &&
    part.approval?.approved !== undefined
  ) {
    return "failed"
  }
  if (part.status.type === "requires-action") return "waiting"
  return "completed"
}

function toolCallError(part: ToolCallPart) {
  if (part.status.type !== "incomplete" || part.status.error === undefined) {
    return undefined
  }
  return formatToolValue(part.status.error)
}

function ToolActivityGroup({ indices }: { indices: readonly number[] }) {
  const aui = useAui()
  const messageParts = useAuiState((state) => state.message.parts)
  const threadIsRunning = useAuiState((state) => state.thread.isRunning)
  const toolCalls = useMemo(
    () =>
      indices.flatMap((index): ToolCallEntry[] => {
        const part = messageParts[index]
        if (!part || part.type !== "tool-call") return []
        const displayMetadata = justAIToolMetadata(part)

        return [
          {
            tool_name: part.toolName,
            tool_category: toolCategory(part.toolName),
            message: toolLabel(part.toolName, displayMetadata.toolName),
            show_category: true,
            tool_call_id: part.toolCallId,
            integration_name: displayMetadata.serverName,
            inputs: parseToolInputs(part),
            output:
              part.result === undefined
                ? undefined
                : formatToolValue(part.result),
            error: toolCallError(part),
            status: toolCallStatus(part, threadIsRunning),
            approval: part.approval,
            respondToApproval: (response) =>
              aui.message.part({ index }).respondToToolApproval(response),
          },
        ]
      }),
    [aui, indices, messageParts, threadIsRunning]
  )

  if (toolCalls.length === 0) return null

  return (
    <ToolCallsSection
      className="my-2 w-full max-w-2xl"
      toolCalls={toolCalls}
      renderContent={(content, call, kind) =>
        kind === "output" ? (
          <ToolResultContent toolName={call.tool_name} value={content} />
        ) : (
          <CompactMarkdown content={content} />
        )
      }
    />
  )
}

type AssistantGroupKey = "group-reasoning" | "group-tool" | "group-retrieval"

const assistantGroupByType = groupPartByType<AssistantGroupKey>({
  reasoning: ["group-reasoning"],
  "tool-call": ["group-tool"],
})

const groupAssistantParts = (
  part: PartState,
  context: GroupByContext
): readonly AssistantGroupKey[] => {
  if (part.type === "data" && part.name === "retrieval-status") {
    return ["group-retrieval"] as const
  }
  return assistantGroupByType(part, context)
}

function renderPart(part: EnrichedPartState, textClassName?: string) {
  switch (part.type) {
    case "text":
      return <AssistantMarkdown className={textClassName} />
    case "reasoning":
      return <ReasoningPart text={part.text} />
    case "source":
      return <AssistantSource {...part} />
    case "image":
      return (
        <div className="my-2 overflow-hidden rounded-xl border bg-muted/20">
          <Image
            alt={part.filename ?? "Attached image"}
            className="h-auto max-h-96 w-auto max-w-full object-contain"
            height={384}
            src={part.image}
            unoptimized
            width={512}
          />
          {part.filename && (
            <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
              {part.filename}
            </div>
          )}
        </div>
      )
    case "file":
      if (part.data.startsWith("justai-source:")) {
        return (
          <span className="my-2 inline-flex items-center gap-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs text-foreground">
            <FileText className="size-4" aria-hidden="true" />
            {part.filename ?? "Attached file"}
          </span>
        )
      }
      return (
        <a
          className="my-2 inline-flex items-center gap-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs text-foreground hover:bg-muted"
          download={part.filename}
          href={part.data}
          rel="noreferrer"
          target="_blank"
        >
          <FileText className="size-4" aria-hidden="true" />
          {part.filename ?? "Attached file"}
        </a>
      )
    case "data":
      return (
        part.dataRendererUI ??
        (part.name === "retrieval-status" ? (
          <RetrievalStatusPart data={part.data} />
        ) : part.name === "justai-error" ? (
          <AssistantErrorPart data={part.data} />
        ) : null)
      )
    case "tool-call":
      return part.toolUI
    case "generative-ui":
      return (
        <div className="my-2 rounded-xl border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Quote className="mb-1 size-3.5" aria-hidden="true" />
          Structured result is available in this response.
        </div>
      )
    default:
      return null
  }
}

export function AssistantMessageParts() {
  return (
    <MessagePrimitive.GroupedParts
      groupBy={groupAssistantParts}
      indicator="no-text"
    >
      {({ part, children }) => {
        if (part.type === "group-reasoning") {
          return (
            <details className="my-2 rounded-xl border bg-muted/20" open>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Thinking
              </summary>
              <div className="border-t px-3 py-2">{children}</div>
            </details>
          )
        }
        if (part.type === "group-tool") {
          return <ToolActivityGroup indices={part.indices} />
        }
        if (part.type === "group-retrieval") {
          const statuses = Children.toArray(children)
          return statuses[statuses.length - 1] ?? null
        }
        if (part.type === "indicator") {
          return (
            <span className="my-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
              Working…
            </span>
          )
        }
        return renderPart(part as EnrichedPartState)
      }}
    </MessagePrimitive.GroupedParts>
  )
}

export function UserMessageParts() {
  return (
    <MessagePrimitive.Parts>
      {({ part }) =>
        part.type === "file"
          ? null
          : renderPart(
              part,
              "text-accent-foreground dark:text-primary-foreground"
            )
      }
    </MessagePrimitive.Parts>
  )
}

export function RetrievalStatus({ data }: { data: unknown }) {
  return <RetrievalStatusPart data={data} />
}
