"use client"

import Image from "next/image"
import { Children, type ReactNode } from "react"
import {
  CircleAlert,
  ChevronDown,
  FileText,
  LoaderCircle,
  Quote,
  Sparkles,
} from "lucide-react"
import {
  groupPartByType,
  MessagePrimitive,
  useAuiState,
  type GroupByContext,
  type PartState,
  type EnrichedPartState,
} from "@assistant-ui/react"

import { AssistantMarkdown } from "@/components/assistant-ui/markdown-text"
import { AssistantSource } from "@/components/assistant-ui/sources"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

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

function ToolGroup({ children }: { children: ReactNode }) {
  return (
    <details
      className="my-2 overflow-hidden rounded-xl border bg-muted/20"
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        Tool activity
      </summary>
      <div className="border-t px-2 py-1">{children}</div>
    </details>
  )
}

type AssistantGroupKey =
  "group-thought" | "group-reasoning" | "group-tool" | "group-retrieval"

const assistantGroupByType = groupPartByType<AssistantGroupKey>({
  reasoning: ["group-thought", "group-reasoning"],
  "tool-call": ["group-thought", "group-tool"],
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
      return part.toolUI ?? <ToolFallback {...part} />
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
        if (part.type === "group-thought") {
          return <ToolGroup>{children}</ToolGroup>
        }
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
          return <ToolGroup>{children}</ToolGroup>
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
