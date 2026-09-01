"use client"

import Image from "next/image"
import Link from "next/link"
import { Children, useMemo, useState } from "react"
import {
  Check,
  ChevronDown,
  CircleAlert,
  BrainCircuit,
  ExternalLink,
  FileText,
  Files,
  LoaderCircle,
  Quote,
  ShieldCheck,
  Sparkles,
  X,
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
import { RegisterMCPApprovals } from "@/components/assistant-ui/mcp-approval-context"
import { api } from "@/lib/api"

type RetrievalStatus = {
  status?: string
  query?: string
  citationCount?: number
  sourceCount?: number
  passageCount?: number
  mode?: string
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
  // Keep recognizing the previous mode name so messages persisted before the
  // rename continue to render with the enhanced-context treatment.
  const deepContext =
    value.mode === "deep-context" || value.mode === "repository-analysis"
  const label =
    status === "completed"
      ? `${deepContext ? "Deep context ready" : "Grounding ready"} · ${sourceLabel}${passageLabel}`
      : status === "failed"
        ? "Grounding unavailable"
        : status === "disabled"
          ? "Knowledge grounding is disabled"
          : deepContext
            ? "Analyzing deeper context…"
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
        deepContext ? (
          <BrainCircuit className="size-3.5 text-primary" aria-hidden="true" />
        ) : (
          <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
        )
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

type AgentRunPartData = {
  runId?: unknown
  status?: unknown
  approvalId?: unknown
  action?: unknown
  argumentHash?: unknown
  expiresAt?: unknown
}

function AgentRunPart({ data }: { data: unknown }) {
  const value = (data ?? {}) as AgentRunPartData
  const runId = typeof value.runId === "string" ? value.runId : ""
  const status = typeof value.status === "string" ? value.status : "running"
  const approvalId =
    typeof value.approvalId === "string" ? value.approvalId : ""
  const argumentHash =
    typeof value.argumentHash === "string" ? value.argumentHash : ""
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(
    null
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const action = value.action
  const actionText =
    action === undefined
      ? ""
      : typeof action === "string"
        ? action
        : JSON.stringify(action, null, 2)

  async function decide(next: "approved" | "rejected") {
    if (!runId || !approvalId || busy) return
    setBusy(true)
    setError("")
    try {
      await api.post(
        `/api/v1/agent-runs/${runId}/approvals/${approvalId}/decision`,
        { decision: next, argumentHash }
      )
      setDecision(next)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The approval decision could not be saved."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="my-2 w-full max-w-2xl rounded-xl border border-primary/30 bg-primary/[0.03] p-3 text-xs">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {status === "waiting_approval"
              ? "Agent action needs approval"
              : "Agent run"}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {status.replaceAll("_", " ")}
            {typeof value.expiresAt === "string"
              ? ` · expires ${new Date(value.expiresAt).toLocaleString()}`
              : ""}
          </p>
        </div>
        {runId && (
          <Link
            className="inline-flex items-center gap-1 text-primary hover:underline"
            href="/agents?tab=runs"
          >
            Open run <ExternalLink className="size-3" aria-hidden="true" />
          </Link>
        )}
      </div>
      {actionText && (
        <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-muted/60 p-2 whitespace-pre-wrap">
          {actionText}
        </pre>
      )}
      {argumentHash && (
        <p className="mt-2 break-all text-[10px] text-muted-foreground">
          Exact action hash: {argumentHash}
        </p>
      )}
      {approvalId && !decision && status === "waiting_approval" && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 hover:bg-muted disabled:opacity-60"
            disabled={busy}
            onClick={() => void decide("rejected")}
            type="button"
          >
            <X className="size-3.5" aria-hidden="true" /> Reject
          </button>
          <button
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            disabled={busy}
            onClick={() => void decide("approved")}
            type="button"
          >
            <Check className="size-3.5" aria-hidden="true" /> Approve exact action
          </button>
        </div>
      )}
      {decision && (
        <p className="mt-2 text-primary">
          {decision === "approved" ? "Approved" : "Rejected"}. The durable run
          will continue or close accordingly.
        </p>
      )}
      {error && <p className="mt-2 text-destructive">{error}</p>}
    </div>
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
  create_pdf: "Create PDF",
}

function toolCategory(toolName: string, serverName?: string) {
  const provider = `${serverName ?? ""} ${toolName}`.toLowerCase()
  if (provider.includes("github")) return "github"
  if (provider.includes("gitlab")) return "gitlab"
  if (toolName === "web_search") return "web_search"
  if (toolName === "browse_url") return "browse_url"
  if (toolName === "generate_image") return "generate_image"
  if (toolName === "edit_image") return "edit_image"
  if (toolName === "create_pdf") return "documents"
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
    iconUrl?: unknown
  }
  return {
    serverName:
      typeof metadata.serverName === "string" ? metadata.serverName : undefined,
    toolName:
      typeof metadata.toolName === "string" ? metadata.toolName : undefined,
    iconUrl:
      typeof metadata.iconUrl === "string" ? metadata.iconUrl : undefined,
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
  const messageId = useAuiState((state) => state.message.id)
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
            tool_category: toolCategory(part.toolName, displayMetadata.serverName),
            message: toolLabel(part.toolName, displayMetadata.toolName),
            show_category: true,
            tool_call_id: part.toolCallId,
            integration_name: displayMetadata.serverName,
            icon_url: displayMetadata.iconUrl,
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
    <>
      <RegisterMCPApprovals
        approvals={toolCalls.filter((call) => call.status === "waiting")}
        messageId={messageId}
      />
      <ToolCallsSection
        approvalActions={false}
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
    </>
  )
}

type SourcePart = Extract<PartState, { type: "source" }>

function SourceGroup({ indices }: { indices: readonly number[] }) {
  const messageParts = useAuiState((state) => state.message.parts)
  const sourceParts = useMemo(
    () =>
      indices.flatMap((index): SourcePart[] => {
        const part = messageParts[index]
        return part?.type === "source" ? [part] : []
      }),
    [indices, messageParts]
  )

  if (sourceParts.length === 0) return null
  if (sourceParts.length === 1) {
    return <AssistantSource {...sourceParts[0]} />
  }

  return (
    <details className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border bg-muted/20 text-xs">
      <summary className="group flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <Files className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span>Sources used</span>
        <span className="font-normal text-muted-foreground">
          · {sourceParts.length} sources
        </span>
        <ChevronDown
          className="ml-auto size-3.5 text-muted-foreground transition-transform duration-150 ease-out group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-1 border-t p-2">
        {sourceParts.map((part) => (
          <AssistantSource key={part.id} {...part} />
        ))}
      </div>
    </details>
  )
}

type AssistantGroupKey =
  "group-reasoning" | "group-tool" | "group-retrieval" | "group-sources"

const assistantGroupByType = groupPartByType<AssistantGroupKey>({
  reasoning: ["group-reasoning"],
  "tool-call": ["group-tool"],
  source: ["group-sources"],
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
        (part.name === "agent-run" ? (
          <AgentRunPart data={part.data} />
        ) : part.name === "retrieval-status" ? (
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
      indicator="never"
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
        if (part.type === "group-sources") {
          return <SourceGroup indices={part.indices} />
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
