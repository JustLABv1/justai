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
  Check,
  ChevronDown,
  Copy,
  FileText,
  History,
  Link,
  Mic,
  PanelRightClose,
  Paperclip,
  PanelRightOpen,
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
  useThreadViewport,
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
import { BrandMark } from "@/components/brand-mark"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { APIError, api, API_URL } from "@/lib/api"
import type {
  Conversation,
  ConversationContext,
  Endpoint,
  ViewId,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type Props = {
  conversationId: string | null
  conversationMessageCount?: number
  endpoints: Endpoint[]
  onEnsureConversation?: () => Promise<string>
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onConversationSettled?: () => void
  onConversationMissing?: () => void
  onNavigate?: (view: ViewId) => void
  onOpenHistory?: () => void
  onOpenContext?: () => void
  contextOpen?: boolean
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
    <span className="ml-auto text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
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
        <div className="flex w-full items-center gap-2">
          <div className="flex items-center gap-2">
            <MessageActions assistant />
            <BranchPicker />
          </div>
          <MessageTiming />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function ScrollToLatest() {
  const viewport = useThreadViewport((state) => state.element.viewport)
  const scrollToBottom = useThreadViewport((state) => state.scrollToBottom)
  const footerInset = useThreadViewport((state) => state.height.inset)
  const messageCount = useAuiState((state) => state.thread.messages.length)
  const [latestMessageVisible, setLatestMessageVisible] = useState(true)

  useEffect(() => {
    if (!viewport) {
      return
    }

    const updateVisibility = () => {
      const messages = viewport.querySelectorAll<HTMLElement>(
        "[data-message-id]"
      )
      const latestMessage = messages.item(messages.length - 1)
      if (!latestMessage) {
        setLatestMessageVisible(true)
        return
      }

      const latestMessageRect = latestMessage.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      // The composer is a sticky footer and can cover the bottom of the
      // scroll viewport. Use the readable area above that inset instead of
      // treating a message hidden behind the composer as visible.
      const visibleBottom =
        viewportRect.bottom -
        Math.min(Math.max(footerInset, 0), viewportRect.height)
      const nextVisible =
        latestMessageRect.top < visibleBottom &&
        latestMessageRect.bottom > viewportRect.top
      setLatestMessageVisible((current) =>
        current === nextVisible ? current : nextVisible
      )
    }

    updateVisibility()
    viewport.addEventListener("scroll", updateVisibility, { passive: true })

    // Message content can stream in without changing the message count, so
    // observe DOM updates as well as scroll events. This keeps the affordance
    // correct while a long response grows or the composer changes height.
    const observer = new MutationObserver(updateVisibility)
    observer.observe(viewport, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    return () => {
      viewport.removeEventListener("scroll", updateVisibility)
      observer.disconnect()
    }
  }, [footerInset, messageCount, viewport])

  if (!viewport || latestMessageVisible) return null

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-full z-30 flex justify-center pb-3"
    >
      <div className="flex w-full max-w-3xl justify-end px-3 sm:px-5">
        <Button
          aria-label="Jump to latest message"
          className="pointer-events-auto rounded-full border bg-background/90 p-2 shadow-sm"
          onClick={() => scrollToBottom({ behavior: "auto" })}
          size="icon"
          type="button"
          variant="ghost"
        >
          ↓
        </Button>
      </div>
    </div>
  )
}

function EmptyThread({ children }: { children?: ReactNode }) {
  return (
    <ThreadPrimitive.Empty>
      <div className="flex min-h-[calc(100svh-8rem)] flex-col items-center justify-center px-5 py-12 text-center">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark className="size-12 rounded-full" priority />
          <span className="text-2xl font-semibold tracking-[-0.04em]">
            JustAI
          </span>
        </div>
        {children}
      </div>
    </ThreadPrimitive.Empty>
  )
}

function ModelEndpointPicker({
  endpoints,
  endpointId,
  onEndpointChange,
  models,
  modelId,
  modelDiscoveryLoading,
  onModelChange,
  compact,
}: {
  endpoints: Endpoint[]
  endpointId: string
  onEndpointChange: (id: string) => void
  models: DiscoveredChatModel[]
  modelId: string
  modelDiscoveryLoading?: boolean
  onModelChange: (id: string) => void
  compact: boolean
}) {
  const endpoint = endpoints.find((item) => item.id === endpointId)
  const selectedModel = models.find((model) => model.id === modelId)
  const endpointLabel = endpoint?.name ?? "Select endpoint"
  const modelLabel = selectedModel?.name || modelId || "Select model"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Select LLM endpoint and chat model"
            className={cn(
              "h-9 max-w-56 min-w-0 justify-start gap-1.5 rounded-full border-0 bg-transparent px-2 text-xs font-normal text-foreground hover:bg-muted/70",
              compact && "max-w-40 px-1.5"
            )}
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <span className="max-w-24 truncate text-muted-foreground">
          {endpointLabel}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span className="max-w-28 truncate">{modelLabel}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          LLM endpoint
        </div>
        <DropdownMenuGroup>
          {endpoints.map((item) => (
            <DropdownMenuItem
              className="items-start py-2"
              key={item.id}
              onClick={() => onEndpointChange(item.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {item.name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {item.providerType} · {item.chatModel || "No default model"}
                </span>
              </span>
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  item.id === endpointId ? "opacity-100" : "opacity-0"
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          Chat model
          {modelDiscoveryLoading && (
            <span className="ml-2 font-normal text-muted-foreground">
              Discovering…
            </span>
          )}
        </div>
        <DropdownMenuGroup>
          {models.length > 0 ? (
            models.map((model) => (
              <DropdownMenuItem
                className="items-start py-2"
                key={model.id}
                onClick={() => onModelChange(model.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {model.name && model.name !== model.id
                      ? model.name
                      : model.id}
                  </span>
                  {model.name && model.name !== model.id && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {model.id}
                    </span>
                  )}
                </span>
                <Check
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    model.id === modelId ? "opacity-100" : "opacity-0"
                  )}
                />
              </DropdownMenuItem>
            ))
          ) : (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {modelDiscoveryLoading
                ? "Discovering models for this endpoint…"
                : "No discovered models. Configure one in Settings."}
            </p>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  compact = false,
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
  compact?: boolean
  onOpenHistory?: () => void
  conversationContext: ConversationContext
  toolApproval?: import("@assistant-ui/react").ToolCallMessagePartProps | null
  onImportURL: () => void | Promise<void>
  onImportText: () => void | Promise<void>
}) {
  const isThreadRunning = useAuiState((state) => state.thread.isRunning)
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
    <div
      className={cn(
        "mx-auto w-full max-w-3xl px-3 pt-2 pb-3 sm:px-5 sm:pb-5",
        compact && "px-0 py-0"
      )}
    >
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
        <ComposerPrimitive.Root
          className={cn(
            "group/composer relative rounded-[2rem] border bg-background/95 p-2 shadow-[0_16px_48px_-24px_rgba(0,0,0,0.5)] ring-1 ring-border/40 backdrop-blur supports-[backdrop-filter]:bg-background/80",
            compact &&
              "flex items-center gap-1 overflow-hidden rounded-full bg-muted/30 p-1.5 ring-border/60"
          )}
          data-running={isThreadRunning}
        >
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
          {!compact && <ContextDisplay context={conversationContext} />}
          <ComposerPrimitive.Input
            className={cn(
              "max-h-40 min-h-12 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground",
              compact && "order-2 min-h-10 min-w-0 flex-1 px-2 py-1.5"
            )}
            placeholder={
              compact ? "What do you want to know?" : "Message JustAI…"
            }
            submitMode="enter"
          />
          <div
            className={cn(
              "flex items-center justify-between gap-2 px-1",
              compact && "contents"
            )}
          >
            <div
              className={cn(
                "flex min-w-0 items-center gap-1",
                compact && "order-1"
              )}
            >
              <ComposerPrimitive.AddAttachment
                aria-label="Attach a file"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                multiple
              >
                <Paperclip className="size-4" />
              </ComposerPrimitive.AddAttachment>
              <Button
                aria-label="Import a URL"
                className={cn(
                  "rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  compact && "hidden"
                )}
                onClick={() => void onImportURL()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Link className="size-4" />
              </Button>
              <Button
                aria-label="Import text"
                className={cn(
                  "rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  compact && "hidden"
                )}
                onClick={() => void onImportText()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <FileText className="size-4" />
              </Button>
              <ComposerPrimitive.Dictate
                aria-label="Dictate message"
                className={cn(
                  "rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  compact && "hidden"
                )}
              >
                <Mic className="size-4" />
              </ComposerPrimitive.Dictate>
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
            <div className="order-3 flex shrink-0 items-center gap-1">
              <ModelEndpointPicker
                compact={compact}
                endpointId={endpointId}
                endpoints={endpoints}
                modelDiscoveryLoading={modelDiscoveryLoading}
                modelId={modelId}
                models={models}
                onEndpointChange={onEndpointChange}
                onModelChange={onModelChange}
              />
              <VoiceControl
                className="shrink-0"
                compact
                toolApproval={toolApproval}
              />
              {isThreadRunning ? (
                <ComposerPrimitive.Cancel
                  aria-label="Cancel response"
                  className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80"
                >
                  <RotateCcw className="size-4" />
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send
                  aria-label="Send message"
                  className="flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/85 disabled:opacity-40"
                >
                  <ArrowUp className="size-4" />
                </ComposerPrimitive.Send>
              )}
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {!compact && (
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          JustAI can make mistakes. Verify important information.
        </p>
      )}
    </div>
  )
}

type AssistantThreadLayoutProps = {
  composerProps: Parameters<typeof Composer>[0]
}

function AssistantThreadLayout({ composerProps }: AssistantThreadLayoutProps) {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0)
  const composer = <Composer {...composerProps} compact={isEmpty} />

  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ThreadPrimitive.Viewport
        className="relative min-h-0 flex-1 overflow-y-auto"
        turnAnchor="bottom"
        autoScroll
        scrollToBottomOnInitialize
        scrollToBottomOnRunStart
        scrollToBottomOnThreadSwitch
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-3 sm:px-8 lg:px-12">
          <EmptyThread>
            {isEmpty && <div className="mt-4 w-full max-w-3xl">{composer}</div>}
          </EmptyThread>
          {!isEmpty && (
            <div className="mt-auto">
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                }}
              />
            </div>
          )}
        </div>
        {!isEmpty && (
          <ThreadPrimitive.ViewportFooter className="relative sticky bottom-0 z-20 shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent pt-5 backdrop-blur supports-[backdrop-filter]:bg-background/75">
            <ScrollToLatest />
            {composer}
          </ThreadPrimitive.ViewportFooter>
        )}
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function AssistantChatSurface({
  conversationId,
  initialMessages,
  endpoints,
  activeEndpoint,
  onEnsureConversation,
  onUpload,
  onImportURL,
  onImportText,
  onConversationCreated,
  onConversationUpdated,
  onConversationSettled,
  onOpenHistory,
  conversationContext,
}: {
  conversationId: string | null
  initialMessages: UIMessage[]
  endpoints: Endpoint[]
  activeEndpoint?: Endpoint
  onEnsureConversation: () => Promise<string>
  onUpload: (file: File) => Promise<void>
  onImportURL: () => void | Promise<void>
  onImportText: () => void | Promise<void>
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onConversationSettled?: () => void
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
          conversationId: "",
          endpointId: selectedEndpointId,
          model: selectedModel,
        }),
        prepareSendMessagesRequest: async ({ body, messages }) => {
          const id = await onEnsureConversation()
          const requestMessages = Array.isArray(messages) ? messages : []
          const latestUser = [...requestMessages]
            .reverse()
            .find((message) => message?.role === "user")
          const latestMessage = requestMessages.at(-1)
          const requestId =
            latestMessage?.role === "assistant" &&
            typeof latestMessage.id === "string"
              ? `approval:${latestMessage.id}`
              : typeof latestUser?.id === "string"
                ? `turn:${latestUser.id}`
                : undefined
          return {
            body: {
              ...(body ?? {}),
              // AssistantChatTransport keeps messages outside its resolved
              // body. Copy them explicitly when returning a prepared body;
              // otherwise the backend receives an empty history on the first
              // turn and some OpenAI-compatible gateways fail with an opaque
              // "list index out of range" error.
              messages: requestMessages,
              conversationId: id,
              endpointId: selectedEndpointId,
              model: selectedModel,
              requestId,
            },
          }
        },
      }),
    [onEnsureConversation, selectedEndpointId, selectedModel]
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
    onFinish: ({ isError }) => {
      onConversationUpdated?.()
      if (!isError) onConversationSettled?.()
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssistantThreadLayout
        composerProps={{
          conversationContext,
          endpointId: selectedEndpointId,
          endpoints,
          models: availableModels,
          modelDiscoveryLoading,
          modelId: selectedModel,
          onImportText,
          onImportURL,
          onEndpointChange: setEndpointId,
          onModelChange: (model) =>
            setModelByEndpoint((current) => ({
              ...current,
              [selectedEndpointId]: model,
            })),
          onOpenHistory,
          toolApproval: voiceApproval,
        }}
      />
    </AssistantRuntimeProvider>
  )
}

export function ChatView({
  conversationId,
  conversationMessageCount,
  endpoints,
  onConversationCreated,
  onConversationUpdated,
  onConversationSettled,
  onConversationMissing,
  onEnsureConversation,
  onOpenHistory,
  onOpenContext,
  contextOpen = false,
}: Props) {
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(conversationId)
  const [surfaceKey, setSurfaceKey] = useState(conversationId ?? "new")
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(
    Boolean(conversationId && conversationMessageCount !== 0)
  )
  const [conversationContext, setConversationContext] =
    useState<ConversationContext>(EMPTY_CONTEXT)
  const locallyCreatedConversationRef = useRef<string | null>(null)
  const pendingConversationRef = useRef(false)
  const conversationCreationRef = useRef<Promise<string> | null>(null)
  const activeConversationRef = useRef<string | null>(conversationId)
  const routeConversationIdRef = useRef<string | null>(conversationId)
  const onEnsureConversationRef = useRef(onEnsureConversation)
  const onConversationMissingRef = useRef(onConversationMissing)
  const onConversationCreatedRef = useRef(onConversationCreated)
  const onConversationUpdatedRef = useRef(onConversationUpdated)
  const uploadedAttachmentKeysRef = useRef(new Set<string>())

  useEffect(() => {
    activeConversationRef.current = conversationId
    routeConversationIdRef.current = conversationId
    onEnsureConversationRef.current = onEnsureConversation
    onConversationMissingRef.current = onConversationMissing
    onConversationCreatedRef.current = onConversationCreated
    onConversationUpdatedRef.current = onConversationUpdated
  }, [
    conversationId,
    onConversationCreated,
    onConversationMissing,
    onConversationUpdated,
    onEnsureConversation,
  ])

  const activeChatEndpoints = endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.capabilities?.chat
  )
  const activeEndpoint =
    activeChatEndpoints.find((endpoint) => endpoint.isDefault) ??
    activeChatEndpoints[0]

  const loadConversation = useCallback(
    async (id: string | null, signal?: AbortSignal) => {
      setHistoryLoading(Boolean(id))
      setConversationContext(EMPTY_CONTEXT)
      if (!id) {
        setInitialMessages([])
        setHistoryLoading(false)
        return
      }
      try {
        const [historyResult, contextResult] = await Promise.allSettled([
          api.get<AssistantHistoryResponse>(
            `/api/v1/conversations/${id}/messages?format=assistant-ui`,
            { signal }
          ),
          api.get<ConversationContext>(`/api/v1/conversations/${id}/context`, {
            signal,
          }),
        ])
        if (signal?.aborted) return
        if (historyResult.status === "fulfilled") {
          setInitialMessages(normalizeHistory(historyResult.value))
        } else if (
          historyResult.reason instanceof APIError
            ? historyResult.reason.status === 404
            : typeof historyResult.reason === "object" &&
                historyResult.reason !== null &&
                "status" in historyResult.reason &&
                Number(
                  (historyResult.reason as { status?: unknown }).status
                ) === 404
        ) {
          onConversationMissingRef.current?.()
        } else {
          console.error(
            "Assistant UI history could not be loaded",
            historyResult.reason
          )
          setInitialMessages([])
        }
        if (contextResult.status === "fulfilled") {
          setConversationContext(contextResult.value)
        } else {
          console.error(
            "Assistant UI conversation context could not be loaded",
            contextResult.reason
          )
        }
      } catch (caught) {
        if (!signal?.aborted) {
          console.error("Assistant UI history could not be loaded", caught)
          setInitialMessages([])
        }
      } finally {
        if (!signal?.aborted) setHistoryLoading(false)
      }
    },
    []
  )
  const loadConversationRef = useRef(loadConversation)

  useEffect(() => {
    loadConversationRef.current = loadConversation
  }, [loadConversation])

  useEffect(() => {
    if (conversationId && pendingConversationRef.current) {
      // The workspace creates the conversation as part of the first send or
      // attachment. Keep the mounted "new" runtime alive while the URL
      // catches up; loading history here would unmount the active request.
      pendingConversationRef.current = false
      locallyCreatedConversationRef.current = conversationId
    }
    if (
      conversationId &&
      locallyCreatedConversationRef.current === conversationId
    ) {
      locallyCreatedConversationRef.current = null
      setActiveConversationId(conversationId)
      activeConversationRef.current = conversationId
      return
    }
    setActiveConversationId(conversationId)
    setSurfaceKey(conversationId ?? "new")
    activeConversationRef.current = conversationId
    uploadedAttachmentKeysRef.current.clear()
    if (conversationMessageCount === 0) {
      queueMicrotask(() => {
        setInitialMessages([])
        setHistoryLoading(false)
      })
      return
    }
    const controller = new AbortController()
    queueMicrotask(
      () => void loadConversationRef.current(conversationId, controller.signal)
    )
    return () => controller.abort()
  }, [
    conversationId,
    conversationMessageCount,
  ])

  const ensureLocalConversation = useCallback(async () => {
    if (activeConversationRef.current) return activeConversationRef.current
    if (conversationCreationRef.current) return conversationCreationRef.current

    const creation = api
      .post<{ conversation: Conversation }>("/api/v1/conversations")
      .then((response) => {
        locallyCreatedConversationRef.current = response.conversation.id
        activeConversationRef.current = response.conversation.id
        setActiveConversationId(response.conversation.id)
        onConversationCreatedRef.current?.(response.conversation)
        return response.conversation.id
      })
      .finally(() => {
        conversationCreationRef.current = null
      })
    conversationCreationRef.current = creation
    return creation
  }, [])

  const ensureConversation = useCallback(
    async () => {
      const creatingFromRoot = routeConversationIdRef.current === null
      if (creatingFromRoot) pendingConversationRef.current = true
      try {
        const id = await (
          onEnsureConversationRef.current?.() ?? ensureLocalConversation()
        )
        if (creatingFromRoot) {
          pendingConversationRef.current = false
          locallyCreatedConversationRef.current = id
          activeConversationRef.current = id
          setActiveConversationId(id)
        }
        return id
      } catch (error) {
        if (creatingFromRoot) pendingConversationRef.current = false
        throw error
      }
    },
    [ensureLocalConversation]
  )

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
      onConversationUpdatedRef.current?.()
    },
    [ensureConversation]
  )

  const refreshConversationContext = useCallback(async (id: string) => {
    const context = await api.get<ConversationContext>(
      `/api/v1/conversations/${id}/context`
    )
    setConversationContext(context)
    onConversationUpdatedRef.current?.()
  }, [])

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

  if (historyLoading && conversationId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading conversation…
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {onOpenContext && (
        <Button
          aria-expanded={contextOpen}
          aria-label={
            contextOpen
              ? "Close conversation context"
              : "Open conversation context"
          }
          className="absolute top-3 right-3 z-30 h-8 gap-1.5 rounded-full border bg-background/90 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur hover:bg-muted hover:text-foreground"
          onClick={onOpenContext}
          size="sm"
          type="button"
          variant="ghost"
        >
          {contextOpen ? (
            <PanelRightClose className="size-3.5" />
          ) : (
            <PanelRightOpen className="size-3.5" />
          )}
          Context
        </Button>
      )}
      <AssistantChatSurface
        key={surfaceKey}
        activeEndpoint={activeEndpoint}
        conversationId={activeConversationId}
        endpoints={activeChatEndpoints}
        initialMessages={initialMessages}
        onConversationCreated={onConversationCreated}
        onConversationUpdated={onConversationUpdated}
        onConversationSettled={onConversationSettled}
        onEnsureConversation={ensureConversation}
        onImportText={importText}
        onImportURL={importURL}
        onOpenHistory={onOpenHistory}
        onUpload={uploadFile}
        conversationContext={conversationContext}
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
