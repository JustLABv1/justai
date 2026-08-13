"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ArrowUp,
  ChevronDown,
  Copy,
  FileText,
  History,
  Link,
  Mic,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  X,
} from "lucide-react"
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  type ExportedMessageRepository,
  ErrorPrimitive,
  type MessageFormatAdapter,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  type ThreadHistoryAdapter,
  type AttachmentAdapter,
  type FeedbackAdapter,
  type SpeechSynthesisAdapter,
  WebSpeechDictationAdapter,
  useAuiState,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"
import type { UIMessage } from "ai"

import { AssistantMarkdown } from "@/components/assistant-ui/markdown-text"
import { AssistantSource } from "@/components/assistant-ui/sources"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { VoiceControl } from "@/components/assistant-ui/voice"
import { createJustAIVoiceAdapter } from "@/components/assistant-ui/voice-adapter"
import { Button } from "@/components/ui/button"
import { api, API_URL } from "@/lib/api"
import type {
  Conversation,
  ConversationContext,
  Endpoint,
  User,
  ViewId,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type Props = {
  conversationId: string | null
  endpoints: Endpoint[]
  user: Pick<User, "displayName" | "email">
  userInitials: string
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onNavigate?: (view: ViewId) => void
  onOpenHistory?: () => void
}

type AssistantHistoryResponse = {
  repository?: {
    headId?: string
    messages?: Array<{
      parentId?: string
      message?: UIMessage
    }>
  }
  messages?: UIMessage[]
}

type DiscoveredChatModel = {
  id: string
  name?: string
  ownedBy?: string
}

function createHistoryAdapter(
  conversationId: string | null,
  ensureConversation: () => Promise<string>
): ThreadHistoryAdapter {
  const load = async (): Promise<ExportedMessageRepository> => {
    if (!conversationId) return { messages: [] }
    const payload = await api.get<AssistantHistoryResponse>(
      `/api/v1/conversations/${conversationId}/messages?format=assistant-ui`
    )
    const repository = payload.repository
    return {
      headId: repository?.headId ?? null,
      messages:
        repository?.messages?.flatMap((item) => {
          if (!item.message) return []
          return [
            {
              parentId: item.parentId || null,
              // The AI SDK storage adapter is applied by useChatRuntime. The
              // backend stores the canonical UIMessage envelope, so this cast
              // keeps the adapter generic without losing branch metadata.
              message: item.message as never,
            },
          ]
        }) ?? [],
    }
  }

  const persist = async <
    TMessage,
    TStorageFormat extends Record<string, unknown>,
  >(
    item: { parentId: string | null; message: TMessage },
    formatAdapter?: MessageFormatAdapter<TMessage, TStorageFormat>
  ) => {
    const messageId = formatAdapter
      ? formatAdapter.getId(item.message)
      : String((item.message as { id?: string }).id ?? crypto.randomUUID())
    const message = formatAdapter
      ? {
          id: messageId,
          ...formatAdapter.encode(item),
        }
      : (item.message as Record<string, unknown>)
    const id = await ensureConversation()
    await api.put<void>(
      `/api/v1/conversations/${id}/messages/${encodeURIComponent(messageId)}`,
      {
        parentId: item.parentId,
        message,
      }
    )
  }

  return {
    load,
    append: (item) => persist(item),
    update: (item) => persist(item),
    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>
    ) {
      return {
        load: async () => {
          const repository = await load()
          return {
            headId: repository.headId,
            messages: repository.messages.map((item) => ({
              parentId: item.parentId,
              message: item.message as TMessage,
            })),
          }
        },
        append: (item: { parentId: string | null; message: TMessage }) =>
          persist(item, formatAdapter),
        update: (item: { parentId: string | null; message: TMessage }) =>
          persist(item, formatAdapter),
      }
    },
  }
}

const EMPTY_CONTEXT: ConversationContext = {
  knowledgeSources: [],
  mcpServers: [],
  transcriptionSessions: [],
}

function normalizeHistory(payload: AssistantHistoryResponse): UIMessage[] {
  const repositoryItems = payload.repository?.messages?.filter((item) => {
    const message = item.message
    return Boolean(
      message &&
      typeof message.id === "string" &&
      (message.role === "user" || message.role === "assistant") &&
      Array.isArray(message.parts)
    )
  })
  if (repositoryItems?.length) {
    const byId = new Map(
      repositoryItems.map((item) => [item.message!.id, item] as const)
    )
    const headId =
      payload.repository?.headId ?? repositoryItems.at(-1)?.message?.id
    const activePath: typeof repositoryItems = []
    const visited = new Set<string>()
    let currentId = headId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const item = byId.get(currentId)
      if (!item?.message) break
      activePath.unshift(item)
      currentId = item.parentId || ""
    }
    const messages = (activePath.length ? activePath : repositoryItems)
      .map((item) => item.message)
      .filter((message): message is UIMessage => Boolean(message))
    if (messages.length) return messages
  }
  return Array.isArray(payload.messages) ? payload.messages : []
}

function createAttachmentAdapter(
  upload: (file: File) => Promise<void>
): AttachmentAdapter {
  return {
    accept:
      "image/*,text/plain,text/markdown,text/html,application/json,application/pdf",
    async add({ file }) {
      return {
        id: crypto.randomUUID(),
        type: file.type.startsWith("image/") ? "image" : "document",
        name: file.name,
        contentType: file.type || "application/octet-stream",
        file,
        status: { type: "requires-action", reason: "composer-send" },
      }
    },
    async send(attachment) {
      await upload(attachment.file)
      return {
        ...attachment,
        status: { type: "complete" },
        content: [],
      }
    },
    async remove() {
      // The backend attachment is intentionally retained as conversation
      // context. Removing it from the composer only removes the pending item.
    },
  }
}

function createSpeechAdapter(endpointId: string): SpeechSynthesisAdapter {
  return {
    speak(text) {
      let status: SpeechSynthesisAdapter.Status = { type: "starting" }
      const listeners = new Set<() => void>()
      let audio: HTMLAudioElement | null = null
      let objectURL = ""
      let cancelled = false

      const notify = () => listeners.forEach((listener) => listener())
      const finish = (
        reason: "finished" | "cancelled" | "error",
        error?: unknown
      ) => {
        status = { type: "ended", reason, error }
        if (objectURL) URL.revokeObjectURL(objectURL)
        notify()
      }

      void api
        .postBlob("/api/v1/voice/speech", { text, endpointId })
        .then((blob) => {
          if (cancelled) return
          objectURL = URL.createObjectURL(blob)
          audio = new Audio(objectURL)
          audio.onplay = () => {
            status = { type: "running" }
            notify()
          }
          audio.onended = () => finish("finished")
          audio.onerror = (event) => finish("error", event)
          return audio.play()
        })
        .catch((error) => {
          if (!cancelled) finish("error", error)
        })

      return {
        get status() {
          return status
        },
        cancel() {
          cancelled = true
          audio?.pause()
          audio = null
          finish("cancelled")
        },
        subscribe(callback) {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
      }
    },
  }
}

function ToolGroup({ children }: { children?: ReactNode }) {
  return (
    <div className="my-2 space-y-1 rounded-xl border border-border/60 bg-muted/20 p-1.5">
      {children}
    </div>
  )
}

function BranchPicker() {
  return (
    <BranchPickerPrimitive.Root
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      hideWhenSingleBranch
    >
      <BranchPickerPrimitive.Previous
        aria-label="Previous branch"
        className="rounded px-1.5 py-0.5 hover:bg-muted"
      >
        ‹
      </BranchPickerPrimitive.Previous>
      <BranchPickerPrimitive.Number />
      <span>/</span>
      <BranchPickerPrimitive.Count />
      <BranchPickerPrimitive.Next
        aria-label="Next branch"
        className="rounded px-1.5 py-0.5 hover:bg-muted"
      >
        ›
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  )
}

function MessageActions({ assistant }: { assistant: boolean }) {
  return (
    <ActionBarPrimitive.Root
      className={cn(
        "mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100",
        "focus-within:opacity-100"
      )}
    >
      <ActionBarPrimitive.Copy
        aria-label="Copy message"
        className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Copy className="size-3.5" />
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Edit
        aria-label="Edit message"
        className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Pencil className="size-3.5" />
      </ActionBarPrimitive.Edit>
      {assistant && (
        <>
          <ActionBarPrimitive.Reload
            aria-label="Regenerate response"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </ActionBarPrimitive.Reload>
          <ActionBarPrimitive.Speak
            aria-label="Read response aloud"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Volume2 className="size-3.5" />
          </ActionBarPrimitive.Speak>
          <ActionBarPrimitive.FeedbackPositive
            aria-label="Good response"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ThumbsUp className="size-3.5" />
          </ActionBarPrimitive.FeedbackPositive>
          <ActionBarPrimitive.FeedbackNegative
            aria-label="Poor response"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ThumbsDown className="size-3.5" />
          </ActionBarPrimitive.FeedbackNegative>
        </>
      )}
    </ActionBarPrimitive.Root>
  )
}

function MessageTiming() {
  const timing = useAuiState((state) => {
    const metadata = state.message.metadata
    if (!metadata || typeof metadata !== "object" || !("timing" in metadata)) {
      return undefined
    }
    const value = metadata.timing
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined
  })
  const duration =
    typeof timing?.totalStreamTime === "number" ? timing.totalStreamTime : 0
  const chunks =
    typeof timing?.totalChunks === "number" ? timing.totalChunks : 0
  if (!duration && !chunks) return null
  return (
    <span className="text-[10px] text-muted-foreground">
      {duration ? `${(duration / 1000).toFixed(1)}s` : ""}
      {duration && chunks ? " · " : ""}
      {chunks ? `${chunks} chunks` : ""}
    </span>
  )
}

function ContextDisplay({ context }: { context: ConversationContext }) {
  const items = [
    ...context.knowledgeSources.map((source) => ({
      id: `knowledge:${source.id}`,
      label: source.title,
      detail: source.sourceType || "knowledge",
    })),
    ...context.mcpServers.map((server) => ({
      id: `mcp:${server.id}`,
      label: server.name,
      detail: "MCP",
    })),
    ...context.transcriptionSessions.map((session) => ({
      id: `transcription:${session.id}`,
      label: session.title,
      detail: "transcription",
    })),
  ]
  if (!items.length) return null
  return (
    <div className="mx-1 mb-1 flex min-w-0 items-center gap-1.5 overflow-x-auto rounded-xl border bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground">Context</span>
      {items.map((item) => (
        <span
          className="inline-flex max-w-48 shrink-0 items-center gap-1 rounded-full bg-background px-2 py-0.5"
          key={item.id}
          title={`${item.label} · ${item.detail}`}
        >
          <span className="size-1.5 rounded-full bg-primary/70" />
          <span className="truncate">{item.label}</span>
        </span>
      ))}
    </div>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group/message flex justify-end px-1 py-3 sm:px-4">
      <div className="flex max-w-[min(44rem,90%)] flex-col items-end">
        <div className="rounded-[1.35rem] rounded-br-md bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
          <MessagePrimitive.Parts
            components={{
              Text: () => (
                <MessagePartPrimitive.Text component="span" smooth={false} />
              ),
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <MessageActions assistant={false} />
          <BranchPicker />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group/message px-1 py-4 sm:px-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-start">
        <div className="w-full text-sm leading-7 text-foreground">
          <MessagePrimitive.Parts
            components={{
              Text: AssistantMarkdown,
              Source: AssistantSource,
              tools: { Fallback: ToolFallback },
              ToolGroup,
            }}
          />
        </div>
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-2 flex max-w-4xl items-center rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
        <div className="flex items-center gap-2">
          <MessageActions assistant />
          <BranchPicker />
          <MessageTiming />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function EmptyThread({
  user,
  onOpenHistory,
}: {
  user: Pick<User, "displayName" | "email">
  onOpenHistory?: () => void
}) {
  return (
    <ThreadPrimitive.Empty>
      <div className="flex min-h-[min(60vh,38rem)] flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border bg-muted/50 text-lg font-semibold">
          J
        </div>
        <p className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
          JustAI
        </p>
        <h1 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
          What can I help you figure out?
        </h1>
        <p className="mt-3 max-w-lg text-sm text-muted-foreground">
          Ask about your connected knowledge, MCP tools, or anything you are
          working through today.
        </p>
        <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
          {[
            "Summarize my attached knowledge",
            "Find the latest relevant information",
            "Help me plan the next steps",
            "What can my connected tools do?",
          ].map((prompt) => (
            <ThreadPrimitive.Suggestion
              key={prompt}
              className="rounded-2xl border bg-background px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
              prompt={prompt}
              send
            >
              {prompt}
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>Signed in as {user.displayName || user.email}</span>
          {onOpenHistory && (
            <Button
              className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
              onClick={onOpenHistory}
              size="sm"
              variant="ghost"
            >
              <History className="size-3.5" /> History
            </Button>
          )}
        </div>
      </div>
    </ThreadPrimitive.Empty>
  )
}

function Composer({
  endpoints,
  endpointId,
  onEndpointChange,
  models,
  modelId,
  modelDiscoveryLoading,
  onModelChange,
  onOpenHistory,
  conversationContext,
  toolApproval,
  onImportURL,
  onImportText,
}: {
  endpoints: Endpoint[]
  endpointId: string
  onEndpointChange: (id: string) => void
  models: DiscoveredChatModel[]
  modelId: string
  modelDiscoveryLoading?: boolean
  onModelChange: (id: string) => void
  onOpenHistory?: () => void
  conversationContext: ConversationContext
  toolApproval?: import("@assistant-ui/react").ToolCallMessagePartProps | null
  onImportURL: () => void | Promise<void>
  onImportText: () => void | Promise<void>
}) {
  const contextTriggerAdapter = useMemo(() => {
    const groups = [
      {
        id: "knowledge",
        label: "Knowledge",
        items: conversationContext.knowledgeSources.map((source) => ({
          id: `knowledge:${source.id}`,
          type: "knowledge",
          label: source.title,
          description: source.status,
          metadata: { resourceId: source.id },
        })),
      },
      {
        id: "mcp",
        label: "MCP servers",
        items: conversationContext.mcpServers.map((server) => ({
          id: `mcp:${server.id}`,
          type: "mcp",
          label: server.name,
          description: server.enabled ? "Connected" : "Disabled",
          metadata: { resourceId: server.id },
        })),
      },
      {
        id: "transcription",
        label: "Transcription rooms",
        items: conversationContext.transcriptionSessions.map((session) => ({
          id: `transcription:${session.id}`,
          type: "transcription",
          label: session.title,
          description: session.status,
          metadata: { resourceId: session.id },
        })),
      },
    ]
    const items = groups.flatMap((group) => group.items)
    return {
      categories: () =>
        groups
          .filter((group) => group.items.length > 0)
          .map(({ id, label }) => ({ id, label })),
      categoryItems: (categoryId: string) =>
        groups.find((group) => group.id === categoryId)?.items ?? [],
      search: (query: string) => {
        const normalized = query.toLocaleLowerCase()
        return items.filter(
          (item) =>
            item.label.toLocaleLowerCase().includes(normalized) ||
            item.description?.toLocaleLowerCase().includes(normalized)
        )
      },
    }
  }, [conversationContext])

  return (
    <div className="mx-auto w-full max-w-4xl px-1 pt-2 pb-3 sm:px-4 sm:pb-5">
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Unstable_TriggerPopover
          adapter={contextTriggerAdapter}
          char="@"
          className="absolute bottom-full left-0 z-40 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-background p-2 shadow-xl"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Directive />
          <ComposerPrimitive.Unstable_TriggerPopoverCategories className="flex flex-col gap-1">
            {(categories) =>
              categories.map((category) => (
                <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
                  categoryId={category.id}
                  className="rounded-lg px-2.5 py-2 text-left text-xs hover:bg-muted"
                  key={category.id}
                >
                  {category.label}
                </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
              ))
            }
          </ComposerPrimitive.Unstable_TriggerPopoverCategories>
          <ComposerPrimitive.Unstable_TriggerPopoverItems className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {(items) =>
              items.map((item, index) => (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  className="rounded-lg px-2.5 py-2 text-left hover:bg-muted"
                  index={index}
                  item={item}
                  key={item.id}
                >
                  <span className="block text-xs font-medium">
                    {item.label}
                  </span>
                  {item.description && (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              ))
            }
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Root className="relative rounded-[1.6rem] border bg-background/95 p-2 shadow-[0_12px_40px_-22px_rgba(0,0,0,0.45)] backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <ComposerPrimitive.Attachments>
            {({ attachment }) => (
              <AttachmentPrimitive.Root className="mx-1 mb-1 flex items-center gap-2 rounded-xl border bg-muted/40 px-2.5 py-1.5 text-xs">
                <AttachmentPrimitive.Name />
                <span className="text-muted-foreground">
                  {attachment.status.type === "running"
                    ? `${Math.round(attachment.status.progress * 100)}%`
                    : attachment.status.type === "complete"
                      ? "Ready"
                      : "Pending"}
                </span>
                <AttachmentPrimitive.Remove
                  aria-label={`Remove ${attachment.name}`}
                  className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </AttachmentPrimitive.Remove>
              </AttachmentPrimitive.Root>
            )}
          </ComposerPrimitive.Attachments>
          <ContextDisplay context={conversationContext} />
          <ComposerPrimitive.Input
            className="max-h-40 min-h-12 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Message JustAI…"
            submitMode="enter"
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 items-center gap-1">
              <ComposerPrimitive.AddAttachment
                aria-label="Attach a file"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                multiple
              >
                <Paperclip className="size-4" />
              </ComposerPrimitive.AddAttachment>
              <Button
                aria-label="Import a URL"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void onImportURL()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Link className="size-4" />
              </Button>
              <Button
                aria-label="Import text"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void onImportText()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <FileText className="size-4" />
              </Button>
              <ComposerPrimitive.Dictate
                aria-label="Dictate message"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Mic className="size-4" />
              </ComposerPrimitive.Dictate>
              <VoiceControl toolApproval={toolApproval} />
              <label className="ml-1 hidden items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground sm:flex">
                <span className="sr-only">Model endpoint</span>
                <select
                  aria-label="Model endpoint"
                  className="max-w-36 bg-transparent text-xs text-foreground outline-none"
                  onChange={(event) => onEndpointChange(event.target.value)}
                  value={endpointId}
                >
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="size-3" />
              </label>
              <label className="hidden min-w-0 items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground sm:flex">
                <span className="sr-only">Chat model</span>
                <select
                  aria-busy={modelDiscoveryLoading || undefined}
                  aria-label="Chat model"
                  className="max-w-[min(12rem,30vw)] bg-transparent text-xs text-foreground outline-none"
                  disabled={modelDiscoveryLoading && models.length === 0 && !modelId}
                  onChange={(event) => onModelChange(event.target.value)}
                  value={modelId}
                >
                  {models.length > 0 ? (
                    models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name && model.name !== model.id
                          ? `${model.name} · ${model.id}`
                          : model.id}
                      </option>
                    ))
                  ) : modelId ? (
                    <option value={modelId}>{modelId}</option>
                  ) : (
                    <option value="">
                      {modelDiscoveryLoading ? "Discovering models…" : "No model configured"}
                    </option>
                  )}
                </select>
                <ChevronDown className="size-3 shrink-0" />
              </label>
              {onOpenHistory && (
                <Button
                  aria-label="Open conversation history"
                  className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden"
                  onClick={onOpenHistory}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <History className="size-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <ComposerPrimitive.Cancel
                aria-label="Cancel response"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="size-4" />
              </ComposerPrimitive.Cancel>
              <ComposerPrimitive.Send
                aria-label="Send message"
                className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-40"
              >
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        JustAI can make mistakes. Verify important information.
      </p>
    </div>
  )
}

function AssistantChatSurface({
  conversationId,
  initialMessages,
  endpoints,
  activeEndpoint,
  user,
  onEnsureConversation,
  onUpload,
  onImportURL,
  onImportText,
  onConversationCreated,
  onConversationUpdated,
  onOpenHistory,
  conversationContext,
}: {
  conversationId: string | null
  initialMessages: UIMessage[]
  endpoints: Endpoint[]
  activeEndpoint?: Endpoint
  user: Pick<User, "displayName" | "email">
  onEnsureConversation: () => Promise<string>
  onUpload: (file: File) => Promise<void>
  onImportURL: () => void | Promise<void>
  onImportText: () => void | Promise<void>
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onOpenHistory?: () => void
  conversationContext: ConversationContext
}) {
  const [endpointId, setEndpointId] = useState(activeEndpoint?.id ?? "")
  const [modelsByEndpoint, setModelsByEndpoint] = useState<
    Record<string, DiscoveredChatModel[]>
  >({})
  const [modelByEndpoint, setModelByEndpoint] = useState<
    Record<string, string>
  >({})
  const [voiceApproval, setVoiceApproval] = useState<
    import("@assistant-ui/react").ToolCallMessagePartProps | null
  >(null)
  const selectedEndpointId =
    endpointId && endpoints.some((item) => item.id === endpointId)
      ? endpointId
      : activeEndpoint?.id || ""
  const endpoint =
    endpoints.find((item) => item.id === selectedEndpointId) ?? activeEndpoint
  const selectedModel =
    modelByEndpoint[selectedEndpointId] ?? endpoint?.chatModel ?? ""
  const availableModels = modelsByEndpoint[selectedEndpointId] ?? []
  const modelDiscoveryLoading =
    Boolean(selectedEndpointId) &&
    modelsByEndpoint[selectedEndpointId] === undefined

  useEffect(() => {
    if (
      !selectedEndpointId ||
      modelsByEndpoint[selectedEndpointId] !== undefined
    ) {
      return
    }
    let cancelled = false
    void api
      .get<{
        models?: DiscoveredChatModel[]
        configuredModel?: string
      }>(`/api/v1/endpoints/${selectedEndpointId}/models`)
      .then((result) => {
        if (cancelled) return
        const models = (result.models ?? []).filter((model) => model.id?.trim())
        setModelsByEndpoint((current) => ({
          ...current,
          [selectedEndpointId]: models,
        }))
        setModelByEndpoint((current) => ({
          ...current,
          [selectedEndpointId]:
            current[selectedEndpointId] ??
            result.configuredModel ??
            models[0]?.id ??
            endpoint?.chatModel ??
            "",
        }))
      })
      .catch(() => {
        if (cancelled) return
        // Discovery is best effort. A manually configured endpoint remains
        // usable even when its gateway does not implement /models.
        setModelsByEndpoint((current) => ({
          ...current,
          [selectedEndpointId]: endpoint?.chatModel
            ? [{ id: endpoint.chatModel }]
            : [],
        }))
        setModelByEndpoint((current) => ({
          ...current,
          [selectedEndpointId]:
            current[selectedEndpointId] ?? endpoint?.chatModel ?? "",
        }))
      })
    return () => {
      cancelled = true
    }
  }, [endpoint?.chatModel, modelsByEndpoint, selectedEndpointId])

  const transport = useMemo(
    () =>
      new AssistantChatTransport<UIMessage>({
        api: `${API_URL}/api/v1/chat`,
        credentials: "include",
        headers: (): Record<string, string> => {
          const organizationId = api.getOrganizationId()
          const headers: Record<string, string> = {}
          if (organizationId) headers["X-Organization-ID"] = organizationId
          return headers
        },
        body: () => ({
          conversationId: conversationId ?? "",
          endpointId: selectedEndpointId,
          model: selectedModel,
        }),
        prepareSendMessagesRequest: async ({ body }) => {
          const id = conversationId ?? (await onEnsureConversation())
          return {
            body: {
              ...(body ?? {}),
              conversationId: id,
              endpointId: selectedEndpointId,
              model: selectedModel,
            },
          }
        },
      }),
    [conversationId, onEnsureConversation, selectedEndpointId, selectedModel]
  )

  const attachments = useMemo(
    () => createAttachmentAdapter(onUpload),
    [onUpload]
  )
  const voice = useMemo(
    () =>
      createJustAIVoiceAdapter({
        conversationId,
        chatEndpointId: endpoint?.id,
        onConversationCreated: (id) => {
          onConversationCreated?.({
            id,
            title: "New conversation",
            endpointId: endpoint?.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 0,
          })
        },
        onToolApproval: setVoiceApproval,
      }),
    [conversationId, endpoint?.id, onConversationCreated]
  )
  const speech = useMemo(
    () => createSpeechAdapter(endpoint?.id ?? ""),
    [endpoint?.id]
  )
  const feedback = useMemo<FeedbackAdapter | undefined>(() => {
    if (!conversationId) return undefined
    return {
      submit: ({ message, type }) => {
        void api
          .patch(
            `/api/v1/conversations/${conversationId}/messages/${message.id}`,
            { feedback: type }
          )
          .then(() => onConversationUpdated?.())
          .catch(() => undefined)
      },
    }
  }, [conversationId, onConversationUpdated])
  const history = useMemo(
    () => createHistoryAdapter(conversationId, onEnsureConversation),
    [conversationId, onEnsureConversation]
  )

  const runtime = useChatRuntime<UIMessage>({
    messages: initialMessages,
    transport,
    adapters: {
      attachments,
      voice,
      speech,
      dictation: WebSpeechDictationAdapter.isSupported()
        ? new WebSpeechDictationAdapter()
        : undefined,
      feedback,
      history,
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (error) => {
      onConversationUpdated?.()
      console.error("Assistant UI chat error", error)
    },
    onFinish: () => onConversationUpdated?.(),
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <ThreadPrimitive.Viewport
          className="min-h-0 flex-1 overflow-y-auto"
          turnAnchor="top"
          scrollToBottomOnInitialize
        >
          <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-3 sm:px-8 lg:px-12">
            <div className="flex items-center justify-between py-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                <span>{endpoint?.name ?? "Choose an endpoint"}</span>
              </div>
            </div>
            <EmptyThread onOpenHistory={onOpenHistory} user={user} />
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />
            <ThreadPrimitive.ScrollToBottom
              className="sticky bottom-4 ml-auto rounded-full border bg-background/90 p-2 shadow-sm"
              aria-label="Jump to latest message"
            >
              ↓
            </ThreadPrimitive.ScrollToBottom>
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-20 shrink-0 border-t border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <Composer
              conversationContext={conversationContext}
              endpointId={selectedEndpointId}
              endpoints={endpoints}
              models={availableModels}
              modelDiscoveryLoading={modelDiscoveryLoading}
              modelId={selectedModel}
              onImportText={onImportText}
              onImportURL={onImportURL}
              onEndpointChange={setEndpointId}
              onModelChange={(model) =>
                setModelByEndpoint((current) => ({
                  ...current,
                  [selectedEndpointId]: model,
                }))
              }
              onOpenHistory={onOpenHistory}
              toolApproval={voiceApproval}
            />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

export function ChatView({
  conversationId,
  endpoints,
  user,
  onConversationCreated,
  onConversationUpdated,
  onOpenHistory,
}: Props) {
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(conversationId)
  const [surfaceKey, setSurfaceKey] = useState(conversationId ?? "new")
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(Boolean(conversationId))
  const [conversationContext, setConversationContext] =
    useState<ConversationContext>(EMPTY_CONTEXT)
  const locallyCreatedConversationRef = useRef<string | null>(null)
  const uploadedAttachmentKeysRef = useRef(new Set<string>())

  const activeChatEndpoints = endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.capabilities?.chat
  )
  const activeEndpoint =
    activeChatEndpoints.find((endpoint) => endpoint.isDefault) ??
    activeChatEndpoints[0]

  const loadConversation = useCallback(async (id: string | null) => {
    setHistoryLoading(Boolean(id))
    setConversationContext(EMPTY_CONTEXT)
    if (!id) {
      setInitialMessages([])
      setHistoryLoading(false)
      return
    }
    try {
      const [history, context] = await Promise.all([
        api.get<AssistantHistoryResponse>(
          `/api/v1/conversations/${id}/messages?format=assistant-ui`
        ),
        api.get<ConversationContext>(`/api/v1/conversations/${id}/context`),
      ])
      setInitialMessages(normalizeHistory(history))
      setConversationContext(context)
    } catch (caught) {
      console.error("Assistant UI history could not be loaded", caught)
      setInitialMessages([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const previousConversationRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (previousConversationRef.current === conversationId) return
    previousConversationRef.current = conversationId
    if (
      conversationId &&
      locallyCreatedConversationRef.current === conversationId
    ) {
      locallyCreatedConversationRef.current = null
      setActiveConversationId(conversationId)
      return
    }
    setActiveConversationId(conversationId)
    setSurfaceKey(conversationId ?? "new")
    uploadedAttachmentKeysRef.current.clear()
    queueMicrotask(() => void loadConversation(conversationId))
  }, [conversationId, loadConversation])

  const ensureConversation = useCallback(async () => {
    if (activeConversationId) return activeConversationId
    const response = await api.post<{ conversation: Conversation }>(
      "/api/v1/conversations"
    )
    locallyCreatedConversationRef.current = response.conversation.id
    setActiveConversationId(response.conversation.id)
    onConversationCreated?.(response.conversation)
    return response.conversation.id
  }, [activeConversationId, onConversationCreated])

  const uploadFile = useCallback(
    async (file: File) => {
      const id = await ensureConversation()
      const key = `${file.name}:${file.size}:${file.lastModified}`
      if (uploadedAttachmentKeysRef.current.has(key)) return
      const body = new FormData()
      body.append("file", file)
      await api.upload(`/api/v1/conversations/${id}/attachments`, body)
      uploadedAttachmentKeysRef.current.add(key)
      const context = await api.get<ConversationContext>(
        `/api/v1/conversations/${id}/context`
      )
      setConversationContext(context)
      onConversationUpdated?.()
    },
    [ensureConversation, onConversationUpdated]
  )

  const refreshConversationContext = useCallback(
    async (id: string) => {
      const context = await api.get<ConversationContext>(
        `/api/v1/conversations/${id}/context`
      )
      setConversationContext(context)
      onConversationUpdated?.()
    },
    [onConversationUpdated]
  )

  const importURL = useCallback(async () => {
    const value = window.prompt("Import URL")?.trim()
    if (!value) return
    const id = await ensureConversation()
    await api.post(`/api/v1/conversations/${id}/attachments/url`, {
      url: value,
      title: value,
    })
    await refreshConversationContext(id)
  }, [ensureConversation, refreshConversationContext])

  const importText = useCallback(async () => {
    const value = window.prompt("Paste text to import")
    if (!value?.trim()) return
    const id = await ensureConversation()
    await api.post(`/api/v1/conversations/${id}/attachments/text`, {
      title: "Pasted text",
      content: value,
    })
    await refreshConversationContext(id)
  }, [ensureConversation, refreshConversationContext])

  if (historyLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading conversation…
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AssistantChatSurface
        key={surfaceKey}
        activeEndpoint={activeEndpoint}
        conversationId={activeConversationId}
        endpoints={activeChatEndpoints}
        initialMessages={initialMessages}
        onConversationCreated={onConversationCreated}
        onConversationUpdated={onConversationUpdated}
        onEnsureConversation={ensureConversation}
        onImportText={importText}
        onImportURL={importURL}
        onOpenHistory={onOpenHistory}
        onUpload={uploadFile}
        conversationContext={conversationContext}
        user={user}
      />
      <span className="sr-only">
        {conversationContext.knowledgeSources.length} knowledge sources,{" "}
        {conversationContext.mcpServers.length} MCP servers,{" "}
        {conversationContext.transcriptionSessions.length} transcription
        sessions attached.
      </span>
    </div>
  )
}
