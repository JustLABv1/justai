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
  History,
  PanelRightClose,
  Paperclip,
  PanelRightOpen,
  Pencil,
  Plug,
  RefreshCw,
  RotateCcw,
  Quote,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  X,
} from "lucide-react"
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  AuiConfig,
  BranchPickerPrimitive,
  ComposerPrimitive,
  type ExportedMessageRepository,
  ErrorPrimitive,
  McpAppRenderer,
  McpAppsRemoteHost,
  type MessageFormatAdapter,
  MessagePrimitive,
  QueueItemPrimitive,
  SelectionToolbarPrimitive,
  Tools,
  ThreadPrimitive,
  type ThreadHistoryAdapter,
  type AttachmentAdapter,
  type CompleteAttachment,
  type FeedbackAdapter,
  type PendingAttachment,
  type SpeechSynthesisAdapter,
  useAui,
  useThreadViewport,
  useAuiState,
  useVoiceState,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  createResumableSessionStorage,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"
import type { UIMessage } from "ai"

import {
  AssistantMessageParts,
  UserMessageParts,
} from "@/components/assistant-ui/message-parts"
import { ChatAttachmentPreview } from "@/components/assistant-ui/attachment-preview"
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
  KnowledgeSource,
  MCPServer,
  ViewId,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type Props = {
  conversationId: string | null
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
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

type UploadedConversationAttachment = {
  source: KnowledgeSource
}

function supportsVoiceTranscription(endpoint: Endpoint) {
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, "transcription")) {
    return Boolean(capabilities.transcription)
  }
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "chunked-transcription")
  ) {
    return Boolean(capabilities["chunked-transcription"])
  }
  if (
    Object.prototype.hasOwnProperty.call(capabilities, "realtime-transcription")
  ) {
    return Boolean(capabilities["realtime-transcription"])
  }
  return (
    endpoint.providerType === "openai" || endpoint.providerType === "gemini"
  )
}

function supportsVision(endpoint?: Endpoint) {
  if (!endpoint) return false
  const capabilities = endpoint.capabilities ?? {}
  if (Object.prototype.hasOwnProperty.call(capabilities, "vision")) {
    return Boolean(capabilities.vision)
  }
  if (Object.prototype.hasOwnProperty.call(capabilities, "multimodal")) {
    return Boolean(capabilities.multimodal)
  }
  return false
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

function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
      } else {
        reject(new Error("The attachment could not be read"))
      }
    })
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The attachment could not be read"))
    })
    reader.readAsDataURL(file)
  })
}

type NormalizedImage = {
  dataURL: string
  contentType: string
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4096

async function readImageAsDataURL(file: Blob): Promise<NormalizedImage> {
  const objectURL = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new window.Image()
      element.decoding = "async"
      element.onload = () => resolve(element)
      element.onerror = () =>
        reject(new Error("The image could not be decoded in the browser"))
      element.src = objectURL
    })

    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    if (!sourceWidth || !sourceHeight) {
      throw new Error("The image has no readable dimensions")
    }

    const scale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight)
    )
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("The image could not be prepared")
    context.drawImage(image, 0, 0, width, height)

    // vLLM/LiteLLM installations commonly support PNG/JPEG reliably, but not
    // every format a browser can preview (for example WebP or SVG). Rasterize
    // every image so the provider receives a real, self-consistent payload.
    const preferredType =
      file.type === "image/jpeg" ? "image/jpeg" : "image/png"
    const toBlob = (type: string) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("The image could not be prepared"))
              return
            }
            resolve(blob)
          },
          type,
          type === "image/jpeg" ? 0.92 : undefined
        )
      })

    let blob = await toBlob(preferredType)
    if (blob.size > MAX_IMAGE_BYTES && preferredType !== "image/jpeg") {
      blob = await toBlob("image/jpeg")
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      throw new Error("Images must be smaller than 12 MB")
    }

    return {
      dataURL: await readFileAsDataURL(blob),
      contentType: blob.type || preferredType,
    }
  } finally {
    URL.revokeObjectURL(objectURL)
  }
}

async function normalizeOutgoingImageMessages<T extends UIMessage>(
  messages: T[]
): Promise<T[]> {
  let messagesChanged = false
  const normalized = await Promise.all(
    messages.map(async (message) => {
      let messageChanged = false
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (
            part.type !== "file" ||
            !part.mediaType.toLowerCase().startsWith("image/") ||
            !part.url.toLowerCase().startsWith("data:image/")
          ) {
            return part
          }

          const mediaType = part.mediaType.toLowerCase()
          const hasCanonicalWireFormat =
            (mediaType === "image/png" || mediaType === "image/jpeg") &&
            new RegExp(`^data:${mediaType};base64,`, "i").test(part.url)
          if (hasCanonicalWireFormat) return part

          try {
            // Re-rasterize images that were created by an older client or in a
            // browser format the hosted vision gateway may not understand.
            // Invalid historical data is left untouched here and is filtered
            // by the backend rather than blocking an otherwise valid turn.
            const response = await fetch(part.url)
            if (!response.ok) return part
            const image = await readImageAsDataURL(await response.blob())
            messageChanged = true
            return {
              ...part,
              url: image.dataURL,
              mediaType: image.contentType,
            }
          } catch {
            return part
          }
        })
      )

      if (!messageChanged) return message
      messagesChanged = true
      return { ...message, parts } as T
    })
  )

  return messagesChanged ? normalized : messages
}

function createAttachmentAdapter(
  upload: (file: File) => Promise<UploadedConversationAttachment>,
  remove: (sourceId: string) => Promise<void>,
  supportsVision: boolean
): AttachmentAdapter {
  const uploadedByAttachmentId = new Map<
    string,
    UploadedConversationAttachment
  >()

  return {
    accept: `${supportsVision ? "image/*," : ""}text/plain,text/markdown,text/html,application/json,application/pdf`,
    async *add({ file }) {
      const attachment: PendingAttachment = {
        id: crypto.randomUUID(),
        type: file.type.startsWith("image/") ? "image" : "document",
        name: file.name,
        contentType: file.type || "application/octet-stream",
        file,
        status: { type: "requires-action", reason: "composer-send" },
      }

      // Vision images are sent as model content, not pushed through the text
      // ingestion pipeline. This keeps image uploads from being advertised as
      // Knowledge sources the backend cannot extract.
      if (attachment.type === "image") {
        if (!supportsVision) {
          throw new Error("The selected endpoint cannot process images")
        }
        yield attachment
        return
      }

      yield {
        ...attachment,
        status: { type: "running", reason: "uploading", progress: 0 },
      }
      try {
        const uploaded = await upload(file)
        uploadedByAttachmentId.set(attachment.id, uploaded)
        yield attachment
      } catch (caught) {
        yield {
          ...attachment,
          status: {
            type: "incomplete",
            reason: "error",
            message:
              caught instanceof Error
                ? caught.message
                : "The file could not be prepared",
          },
        }
      }
    },
    async send(attachment): Promise<CompleteAttachment> {
      if (attachment.type === "image") {
        const image = await readImageAsDataURL(attachment.file)
        return {
          ...attachment,
          contentType: image.contentType,
          status: { type: "complete" },
          content: [
            {
              type: "image",
              image: image.dataURL,
              filename: attachment.name,
            },
          ],
        }
      }
      const uploaded = uploadedByAttachmentId.get(attachment.id)
      if (!uploaded) {
        throw new Error(
          "The file is still being prepared. Wait until it is ready."
        )
      }
      uploadedByAttachmentId.delete(attachment.id)
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          {
            // The UI keeps a lightweight reference so the file can render in
            // the sent message without putting a second 25 MB payload on the
            // chat request. The backend resolves the source id only inside
            // the authorized conversation relation.
            type: "file",
            data: `justai-source:${uploaded.source.id}`,
            sourceType: "id",
            filename: attachment.name,
            mimeType:
              attachment.contentType ||
              uploaded.source.mimeType ||
              "application/octet-stream",
          },
          {
            type: "data",
            name: "justai-attachment",
            data: {
              sourceId: uploaded.source.id,
              title: uploaded.source.title,
              contextScope: "message",
            },
          },
        ],
      }
    },
    async remove(attachment) {
      const uploaded = uploadedByAttachmentId.get(attachment.id)
      uploadedByAttachmentId.delete(attachment.id)
      if (uploaded) await remove(uploaded.source.id)
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
      <CopyMessageAction />
      {!assistant && <EditMessageAction />}
      {assistant && (
        <>
          <ReloadMessageAction />
          <SpeakMessageAction />
          <FeedbackMessageAction type="positive" />
          <FeedbackMessageAction type="negative" />
        </>
      )}
    </ActionBarPrimitive.Root>
  )
}

type MessageActionButtonProps = {
  label: string
  onClick: () => void | Promise<void>
  children: ReactNode
  disabled?: boolean
}

function MessageActionButton({
  label,
  onClick,
  children,
  disabled = false,
}: MessageActionButtonProps) {
  return (
    <button
      aria-label={label}
      className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={() => void onClick()}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable")
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("Clipboard is unavailable")
}

function CopyMessageAction() {
  const aui = useAui()
  const isCopied = useAuiState((state) => state.message.isCopied)
  const canCopy = useAuiState((state) => {
    if (
      state.message.role === "assistant" &&
      state.message.status?.type === "running"
    ) {
      return false
    }
    return state.message.parts.some(
      (part) => part.type === "text" && part.text.length > 0
    )
  })
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const copy = useCallback(async () => {
    const text = aui.message.getCopyText()
    if (!text) return
    await copyTextToClipboard(text)
    aui.message.setIsCopied(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      aui.message.setIsCopied(false)
      timeoutRef.current = null
    }, 2000)
  }, [aui])

  return (
    <MessageActionButton
      disabled={!canCopy}
      label={isCopied ? "Copied" : "Copy message"}
      onClick={copy}
    >
      {isCopied ? (
        <Check className="size-3.5" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </MessageActionButton>
  )
}

function EditMessageAction() {
  const aui = useAui()
  const isEditing = useAuiState((state) => state.message.composer.isEditing)
  return (
    <MessageActionButton
      disabled={isEditing}
      label="Edit message"
      onClick={() => aui.composer.beginEdit()}
    >
      <Pencil className="size-3.5" />
    </MessageActionButton>
  )
}

function ReloadMessageAction() {
  const aui = useAui()
  const disabled = useAuiState(
    (state) =>
      state.thread.isRunning ||
      state.thread.isDisabled ||
      state.message.role !== "assistant"
  )
  return (
    <MessageActionButton
      disabled={disabled}
      label="Regenerate response"
      onClick={() => aui.message.reload()}
    >
      <RefreshCw className="size-3.5" />
    </MessageActionButton>
  )
}

function SpeakMessageAction() {
  const aui = useAui()
  const speaking = useAuiState((state) => {
    const status = state.message.speech?.status.type
    return status === "starting" || status === "running"
  })
  return (
    <MessageActionButton
      label={speaking ? "Stop reading aloud" : "Read response aloud"}
      onClick={() =>
        speaking ? aui.message.stopSpeaking() : aui.message.speak()
      }
    >
      {speaking ? <X className="size-3.5" /> : <Volume2 className="size-3.5" />}
    </MessageActionButton>
  )
}

function FeedbackMessageAction({ type }: { type: "positive" | "negative" }) {
  const aui = useAui()
  const submitted = useAuiState((state) => {
    const metadata = state.message.metadata
    if (!metadata || typeof metadata !== "object") return undefined
    const typedMetadata = metadata as {
      feedback?: string
      submittedFeedback?: { type?: string }
    }
    const value =
      typedMetadata.submittedFeedback?.type ?? typedMetadata.feedback
    return value === "positive" || value === "negative" ? value : undefined
  })
  return (
    <MessageActionButton
      label={type === "positive" ? "Good response" : "Poor response"}
      onClick={() => aui.message.submitFeedback({ type })}
    >
      {type === "positive" ? (
        <ThumbsUp
          className={cn(
            "size-3.5",
            submitted === type && "fill-current text-foreground"
          )}
        />
      ) : (
        <ThumbsDown
          className={cn(
            "size-3.5",
            submitted === type && "fill-current text-foreground"
          )}
        />
      )}
    </MessageActionButton>
  )
}

function MessageEditComposer() {
  return (
    <div className="mx-auto w-full max-w-4xl px-1 py-3 sm:px-4">
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm">
        <ComposerPrimitive.Input
          autoFocus
          className="max-h-40 min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          placeholder="Edit message…"
          submitMode="ctrlEnter"
        />
        <div className="flex shrink-0 items-center gap-1">
          <ComposerPrimitive.Cancel
            aria-label="Cancel edit"
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send
            aria-label="Save edit"
            className="flex size-8 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
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

function ContextDisplay({
  context,
  onRemoveMCP,
}: {
  context: ConversationContext
  onRemoveMCP?: (serverId: string) => Promise<void>
}) {
  const [removingMcpId, setRemovingMcpId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const items: Array<{
    id: string
    label: string
    detail: string
    kind: "knowledge" | "mcp" | "transcription"
    resourceId?: string
  }> = [
    ...context.knowledgeSources
      .filter((source) => source.contextScope !== "message")
      .map((source) => ({
        id: `knowledge:${source.id}`,
        label: source.title,
        detail: source.sourceType || "knowledge",
        kind: "knowledge" as const,
      })),
    ...context.mcpServers.map((server) => ({
      id: `mcp:${server.id}`,
      label: server.name,
      detail: "MCP",
      kind: "mcp" as const,
      resourceId: server.id,
    })),
    ...context.transcriptionSessions.map((session) => ({
      id: `transcription:${session.id}`,
      label: session.title,
      detail: "transcription",
      kind: "transcription" as const,
    })),
  ]

  const handleRemoveMCP = async (serverId: string) => {
    if (!onRemoveMCP || removingMcpId) return

    setRemoveError(null)
    setRemovingMcpId(serverId)
    try {
      await onRemoveMCP(serverId)
    } catch (error) {
      setRemoveError(
        error instanceof Error
          ? error.message
          : "The MCP server could not be removed from this chat."
      )
    } finally {
      setRemovingMcpId(null)
    }
  }

  if (!items.length && !removeError) return null

  return (
    <div className="min-w-0">
      <div className="mx-1 mb-1 flex min-w-0 items-center gap-1.5 overflow-x-auto rounded-xl border bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground">Context</span>
        {items.map((item) => (
          <div
            className="inline-flex max-w-48 shrink-0 items-center gap-1 rounded-full bg-background px-2 py-0.5"
            key={item.id}
            title={`${item.label} · ${item.detail}`}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-primary/70" />
            <span className="truncate">{item.label}</span>
            {item.kind === "mcp" && item.resourceId && onRemoveMCP ? (
              <button
                type="button"
                className="shrink-0 rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                aria-label={`Remove ${item.label} from this chat`}
                title={`Remove ${item.label} from this chat`}
                disabled={removingMcpId !== null}
                onClick={() => {
                  void handleRemoveMCP(item.resourceId!)
                }}
              >
                {removingMcpId === item.resourceId ? (
                  <RefreshCw className="size-3 animate-spin" />
                ) : (
                  <X className="size-3" />
                )}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {removeError ? (
        <p role="alert" className="mx-2.5 mb-1 text-[11px] text-destructive">
          {removeError}
        </p>
      ) : null}
    </div>
  )
}

function ContextTriggerItems({ ariaLabel }: { ariaLabel: string }) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems
      aria-label={ariaLabel}
      className="flex max-h-56 flex-col gap-1 overflow-y-auto"
    >
      {(items) =>
        items.map((item, index) => {
          const isMCP = item.type === "mcp"
          const isAttached = isMCP && item.metadata?.attached === true
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              className="group/trigger flex items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted data-[highlighted]:bg-muted"
              index={index}
              item={item}
              key={item.id}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg",
                  isMCP
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {isMCP ? (
                  <Plug className="size-3.5" aria-hidden="true" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {item.label}
                </span>
                {item.description && (
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
              {isAttached && (
                <Check
                  className="size-3.5 shrink-0 text-primary"
                  aria-label="Already attached"
                />
              )}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          )
        })
      }
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  )
}

function McpTriggerPopoverHeader() {
  const { open } = unstable_useTriggerPopoverScopeContext()
  if (!open) return null

  return (
    <div className="flex items-center gap-2 px-2.5 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Plug className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium">Add an MCP server</p>
        <p className="text-[11px] text-muted-foreground">
          Choose a server to attach to this chat
        </p>
      </div>
      <span className="ml-auto hidden shrink-0 text-[10px] whitespace-nowrap text-muted-foreground sm:inline">
        ↑↓ · Enter
      </span>
    </div>
  )
}

function TriggerPopoverKeyboardHint() {
  const { open } = unstable_useTriggerPopoverScopeContext()
  if (!open) return null

  return (
    <p className="mt-1 border-t px-2.5 pt-2 text-[10px] text-muted-foreground">
      Use ↑/↓ to navigate · Enter to select · Esc to close
    </p>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group/message flex justify-end px-1 py-3 sm:px-4">
      <div className="flex max-w-[min(44rem,90%)] flex-col items-end">
        <div className="rounded-[1.35rem] rounded-br-md border border-accent-foreground/15 bg-accent px-4 py-2.5 text-[15px] leading-6 text-accent-foreground shadow-sm dark:border-primary/40 dark:bg-primary dark:text-primary-foreground">
          <MessagePrimitive.Quote>
            {({ text }) => (
              <blockquote className="mb-2 border-l-2 border-accent-foreground/40 pl-3 text-xs leading-5 text-accent-foreground/80 dark:border-primary-foreground/50 dark:text-primary-foreground/80">
                {text}
              </blockquote>
            )}
          </MessagePrimitive.Quote>
          <UserMessageParts />
        </div>
        <MessageAttachments />
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
          <AssistantMessageParts />
        </div>
        <MessageAttachments />
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

function MessageAttachments() {
  return (
    <MessagePrimitive.Attachments>
      {({ attachment }) => {
        return (
          <AttachmentPrimitive.Root className="mt-2 max-w-full">
            <ChatAttachmentPreview attachment={attachment} variant="message" />
          </AttachmentPrimitive.Root>
        )
      }}
    </MessagePrimitive.Attachments>
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
      const messages =
        viewport.querySelectorAll<HTMLElement>("[data-message-id]")
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
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-30 flex justify-center pb-3">
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

function FollowStreamingResponse() {
  const viewport = useThreadViewport((state) => state.element.viewport)
  const scrollToBottom = useThreadViewport((state) => state.scrollToBottom)
  const isRunning = useAuiState((state) => state.thread.isRunning)
  const messageCount = useAuiState((state) => state.thread.messages.length)
  const followRef = useRef(true)
  const wasRunningRef = useRef(false)

  useEffect(() => {
    if (!viewport) return

    let frame: number | null = null
    let settleFrame: number | null = null
    let intentTimer: number | null = null
    let touchStartY: number | null = null
    let userScrollIntent = false
    const wasRunning = wasRunningRef.current
    const runStarted = isRunning && !wasRunning
    wasRunningRef.current = isRunning

    const scrollToLatest = () => {
      scrollToBottom({ behavior: "auto" })
      // The assistant-ui scroll listener and the sticky footer can both update
      // during the same frame. Directly applying the final DOM position here
      // closes that gap when a streamed response grows between measurements.
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" })
    }

    const scheduleScroll = () => {
      if (!followRef.current || frame !== null) return

      frame = window.requestAnimationFrame(() => {
        frame = null
        if (!followRef.current) return
        scrollToLatest()

        // Give markdown/tool UI one more layout pass before the final scroll.
        settleFrame = window.requestAnimationFrame(() => {
          settleFrame = null
          if (followRef.current) scrollToLatest()
        })
      })
    }

    const clearUserScrollIntent = () => {
      userScrollIntent = false
      if (intentTimer !== null) window.clearTimeout(intentTimer)
      intentTimer = null
    }

    const armUserScrollIntent = () => {
      userScrollIntent = true
      if (intentTimer !== null) window.clearTimeout(intentTimer)
      intentTimer = window.setTimeout(() => {
        userScrollIntent = false
        intentTimer = null
      }, 250)
    }

    const handleWheel = (event: WheelEvent) => {
      // A negative delta moves the viewport toward older messages. Downward
      // scrolling is allowed to rejoin the stream and is handled by the
      // bottom check in updateScrollIntent.
      if (event.deltaY < 0) armUserScrollIntent()
    }

    const handleTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null
    }

    const handleTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY
      if (
        touchStartY !== null &&
        currentY !== undefined &&
        currentY > touchStartY + 2
      ) {
        armUserScrollIntent()
      }
    }

    const handleTouchEnd = () => {
      touchStartY = null
    }

    const cancelFrames = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame)
      if (intentTimer !== null) window.clearTimeout(intentTimer)
      frame = null
      settleFrame = null
      intentTimer = null
    }

    if (!isRunning) {
      if (wasRunning && followRef.current) scheduleScroll()
      return cancelFrames
    }

    const updateScrollIntent = () => {
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const atBottom = distanceFromBottom <= 6

      if (atBottom) {
        followRef.current = true
        clearUserScrollIntent()
      } else if (userScrollIntent) {
        // Layout changes can move scrollTop upward while a new composer or
        // streamed message is mounting. Only an explicit user gesture opts out
        // of following the response.
        followRef.current = false
        clearUserScrollIntent()
      }
    }

    // Every new run starts in follow mode. A later explicit upward gesture is
    // what opts the user out of following the stream.
    if (runStarted) {
      followRef.current = true
      clearUserScrollIntent()
    }

    viewport.addEventListener("scroll", updateScrollIntent, { passive: true })
    viewport.addEventListener("wheel", handleWheel, { passive: true })
    viewport.addEventListener("touchstart", handleTouchStart, { passive: true })
    viewport.addEventListener("touchmove", handleTouchMove, { passive: true })
    viewport.addEventListener("touchend", handleTouchEnd, { passive: true })
    viewport.addEventListener("touchcancel", handleTouchEnd, { passive: true })

    const observer = new MutationObserver(scheduleScroll)
    observer.observe(viewport, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    const resizeObserver = new ResizeObserver(scheduleScroll)
    resizeObserver.observe(viewport)
    const content = viewport.firstElementChild
    if (content instanceof HTMLElement) resizeObserver.observe(content)

    // The first turn changes both the message list and the sticky composer.
    // Schedule after the initial message-count transition as well as on later
    // streamed DOM/size updates.
    scheduleScroll()

    return () => {
      viewport.removeEventListener("scroll", updateScrollIntent)
      viewport.removeEventListener("wheel", handleWheel)
      viewport.removeEventListener("touchstart", handleTouchStart)
      viewport.removeEventListener("touchmove", handleTouchMove)
      viewport.removeEventListener("touchend", handleTouchEnd)
      viewport.removeEventListener("touchcancel", handleTouchEnd)
      observer.disconnect()
      resizeObserver.disconnect()
      cancelFrames()
    }
  }, [isRunning, messageCount, scrollToBottom, viewport])

  return null
}

function EmptyThread({ children }: { children?: ReactNode }) {
  return (
    <ThreadPrimitive.Empty>
      <div className="flex min-h-[calc(100svh-8rem)] w-full flex-col items-center justify-center px-5 py-12 text-center">
        <div className="flex w-full max-w-3xl flex-col items-center">
          <div className="mb-3 flex w-full items-center justify-center gap-3">
            <BrandMark className="size-12 rounded-full" />
            <span className="text-2xl font-semibold tracking-[-0.04em]">
              JustAI
            </span>
          </div>
          {children}
        </div>
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
                  {item.capabilities?.vision && (
                    <> · Vision: {item.visionModel || "chat model"}</>
                  )}
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
  mcpServers,
  endpointId,
  onEndpointChange,
  models,
  modelId,
  modelDiscoveryLoading,
  onModelChange,
  compact = false,
  onOpenHistory,
  conversationContext,
  onAttachMCP,
  onRemoveMCP,
  toolApproval,
}: {
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  endpointId: string
  onEndpointChange: (id: string) => void
  models: DiscoveredChatModel[]
  modelId: string
  modelDiscoveryLoading?: boolean
  onModelChange: (id: string) => void
  compact?: boolean
  onOpenHistory?: () => void
  conversationContext: ConversationContext
  onAttachMCP: (serverId: string) => Promise<void>
  onRemoveMCP: (serverId: string) => Promise<void>
  toolApproval?: import("@assistant-ui/react").ToolCallMessagePartProps | null
}) {
  const isThreadRunning = useAuiState((state) => state.thread.isRunning)
  const composerAttachments = useAuiState((state) => state.composer.attachments)
  const hasAttachments = composerAttachments.length > 0
  const hasUnreadyAttachments = composerAttachments.some(
    (attachment) =>
      attachment.status.type === "running" ||
      attachment.status.type === "incomplete"
  )
  const mcpItems = useMemo<Unstable_TriggerItem[]>(() => {
    const attachedServerIds = new Set(
      conversationContext.mcpServers.map((server) => server.id)
    )
    const serversById = new Map<string, MCPServer>()
    for (const server of mcpServers) serversById.set(server.id, server)
    for (const server of conversationContext.mcpServers) {
      if (!serversById.has(server.id)) serversById.set(server.id, server)
    }

    return Array.from(serversById.values())
      .filter((server) => server.enabled || attachedServerIds.has(server.id))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((server) => {
        const attached = attachedServerIds.has(server.id)
        return {
          id: `mcp:${server.id}`,
          type: "mcp",
          label: server.name,
          description: attached
            ? server.enabled
              ? "Already attached"
              : "Attached · disabled"
            : server.credentialConfigured
              ? "Add to this chat"
              : "Needs setup",
          metadata: {
            resourceId: server.id,
            attached,
          },
        }
      })
  }, [conversationContext.mcpServers, mcpServers])

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
        items: mcpItems,
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
  }, [conversationContext, mcpItems])

  const mcpTriggerAdapter = useMemo(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        const normalized = query.toLocaleLowerCase()
        return mcpItems.filter(
          (item) =>
            item.label.toLocaleLowerCase().includes(normalized) ||
            item.description?.toLocaleLowerCase().includes(normalized)
        )
      },
    }),
    [mcpItems]
  )

  const contextDirectiveFormatter = useMemo<Unstable_DirectiveFormatter>(
    () => ({
      serialize: (item) =>
        item.type === "mcp"
          ? ""
          : unstable_defaultDirectiveFormatter.serialize(item),
      parse: unstable_defaultDirectiveFormatter.parse,
    }),
    []
  )

  const [attachingMcpId, setAttachingMcpId] = useState<string | null>(null)
  const [mcpAttachError, setMcpAttachError] = useState<string | null>(null)
  const attachingMcpName =
    mcpItems.find((item) => item.metadata?.resourceId === attachingMcpId)
      ?.label ?? "MCP server"
  const attachMcpFromTrigger = useCallback(
    (item: Unstable_TriggerItem) => {
      if (item.type !== "mcp") return
      const resourceId = item.metadata?.resourceId
      if (typeof resourceId !== "string" || item.metadata?.attached === true) {
        return
      }
      setMcpAttachError(null)
      setAttachingMcpId(resourceId)
      void onAttachMCP(resourceId)
        .catch((error: unknown) => {
          const message =
            error instanceof APIError || error instanceof Error
              ? error.message
              : "The MCP server could not be added to this chat."
          setMcpAttachError(message)
        })
        .finally(() => {
          setAttachingMcpId((current) =>
            current === resourceId ? null : current
          )
        })
    },
    [onAttachMCP]
  )

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-3xl px-3 pt-2 pb-3 sm:px-5 sm:pb-5",
        compact && "px-0 py-0"
      )}
    >
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <div className="relative">
          <ComposerPrimitive.Unstable_TriggerPopover
            adapter={contextTriggerAdapter}
            char="@"
            className="absolute bottom-full left-0 z-40 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-background p-2 shadow-xl"
          >
            <ComposerPrimitive.Unstable_TriggerPopover.Directive
              formatter={contextDirectiveFormatter}
              onInserted={attachMcpFromTrigger}
            />
            <ComposerPrimitive.Unstable_TriggerPopoverCategories className="flex flex-col gap-1">
              {(categories) =>
                categories.map((category) => (
                  <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
                    categoryId={category.id}
                    className="rounded-lg px-2.5 py-2 text-left text-xs hover:bg-muted data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                    key={category.id}
                  >
                    {category.label}
                  </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
                ))
              }
            </ComposerPrimitive.Unstable_TriggerPopoverCategories>
            <ContextTriggerItems ariaLabel="Context resources" />
            <TriggerPopoverKeyboardHint />
          </ComposerPrimitive.Unstable_TriggerPopover>
          <ComposerPrimitive.Unstable_TriggerPopover
            adapter={mcpTriggerAdapter}
            char="/"
            className="absolute bottom-full left-0 z-40 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-background p-2 shadow-xl"
          >
            <ComposerPrimitive.Unstable_TriggerPopover.Action
              onExecute={attachMcpFromTrigger}
              removeOnExecute
            />
            <McpTriggerPopoverHeader />
            <ContextTriggerItems ariaLabel="MCP servers" />
            <TriggerPopoverKeyboardHint />
          </ComposerPrimitive.Unstable_TriggerPopover>
          <ComposerPrimitive.Unstable_TriggerPopover
            adapter={mcpTriggerAdapter}
            char="$"
            className="absolute bottom-full left-0 z-40 mb-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-background p-2 shadow-xl"
          >
            <ComposerPrimitive.Unstable_TriggerPopover.Action
              onExecute={attachMcpFromTrigger}
              removeOnExecute
            />
            <McpTriggerPopoverHeader />
            <ContextTriggerItems ariaLabel="MCP servers" />
            <TriggerPopoverKeyboardHint />
          </ComposerPrimitive.Unstable_TriggerPopover>
          <ComposerPrimitive.AttachmentDropzone className="rounded-[2rem] transition-colors data-[dragging=true]:ring-2 data-[dragging=true]:ring-primary/40">
            <ComposerPrimitive.Root
              className={cn(
                "group/composer relative rounded-[2rem] border bg-background/95 p-2 shadow-[0_16px_48px_-24px_rgba(0,0,0,0.5)] ring-1 ring-border/40 backdrop-blur supports-[backdrop-filter]:bg-background/80",
                compact &&
                  "flex flex-wrap items-center gap-2 overflow-hidden rounded-[1.75rem] bg-muted/30 p-2 ring-border/60"
              )}
              data-running={isThreadRunning}
            >
              <ComposerPrimitive.Quote className="mx-2 mb-1 flex items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
                <Quote className="size-3.5 shrink-0" aria-hidden="true" />
                <ComposerPrimitive.QuoteText className="min-w-0 flex-1 truncate" />
                <ComposerPrimitive.QuoteDismiss
                  aria-label="Remove quote"
                  className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </ComposerPrimitive.QuoteDismiss>
              </ComposerPrimitive.Quote>
              <ComposerPrimitive.Queue>
                {() => (
                  <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg border bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                    <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
                    <QueueItemPrimitive.Steer className="rounded px-1.5 py-0.5 text-[11px] hover:bg-muted hover:text-foreground">
                      Send now
                    </QueueItemPrimitive.Steer>
                    <QueueItemPrimitive.Remove
                      aria-label="Remove queued message"
                      className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </QueueItemPrimitive.Remove>
                  </div>
                )}
              </ComposerPrimitive.Queue>
              {hasAttachments && (
                <div
                  className={cn(
                    "flex w-full flex-wrap items-center gap-2 px-2 pt-1 pb-0.5",
                    compact && "order-first basis-full"
                  )}
                >
                  <ComposerPrimitive.Attachments>
                    {({ attachment }) => (
                      <AttachmentPrimitive.Root className="max-w-full">
                        <ChatAttachmentPreview
                          attachment={attachment}
                          showRemove
                          variant="composer"
                        />
                      </AttachmentPrimitive.Root>
                    )}
                  </ComposerPrimitive.Attachments>
                </div>
              )}
              <ContextDisplay
                context={conversationContext}
                onRemoveMCP={onRemoveMCP}
              />
              {attachingMcpId && (
                <div
                  className="mx-1 mb-1 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[11px] text-muted-foreground"
                  role="status"
                >
                  <RefreshCw
                    className="size-3 shrink-0 animate-spin text-primary"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    Adding{" "}
                    <span className="font-medium text-foreground">
                      {attachingMcpName}
                    </span>
                    …
                  </span>
                </div>
              )}
              {mcpAttachError && (
                <div
                  className="mx-1 mb-1 rounded-xl border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive"
                  role="alert"
                >
                  {mcpAttachError}
                </div>
              )}
              <ComposerPrimitive.Input
                className={cn(
                  "max-h-40 min-h-12 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground",
                  compact &&
                    "order-2 min-h-10 min-w-0 flex-1 px-2 py-2 leading-6"
                )}
                placeholder={
                  compact
                    ? "What do you want to know? (type /, $ or @ for MCPs)"
                    : "Message JustAI… (type /, $ or @ to add MCPs)"
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
                      disabled={hasUnreadyAttachments}
                    >
                      <ArrowUp className="size-4" />
                    </ComposerPrimitive.Send>
                  )}
                </div>
              </div>
            </ComposerPrimitive.Root>
          </ComposerPrimitive.AttachmentDropzone>
        </div>
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
  voiceError?: string | null
  onVoiceErrorClear?: () => void
  onVoiceErrorDismiss?: () => void
}

function AssistantThreadLayout({
  composerProps,
  voiceError,
  onVoiceErrorClear,
  onVoiceErrorDismiss,
}: AssistantThreadLayoutProps) {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0)
  const voiceState = useVoiceState()
  const voiceActive =
    voiceState?.status.type === "starting" ||
    voiceState?.status.type === "running"
  const composer = <Composer {...composerProps} compact={isEmpty} />

  if (voiceActive || voiceError) {
    return (
      <VoiceControl
        centered
        error={voiceError}
        onClearError={onVoiceErrorClear}
        onDismissError={onVoiceErrorDismiss}
        toolApproval={composerProps.toolApproval}
      />
    )
  }

  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <SelectionToolbarPrimitive.Root className="z-50 flex items-center gap-1 rounded-lg border bg-background/95 p-1 text-xs text-foreground shadow-lg backdrop-blur">
        <SelectionToolbarPrimitive.Quote className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted">
          <Quote className="size-3.5" aria-hidden="true" />
          Quote
        </SelectionToolbarPrimitive.Quote>
      </SelectionToolbarPrimitive.Root>
      <ThreadPrimitive.Viewport
        className="relative min-h-0 flex-1 overflow-y-auto"
        turnAnchor="bottom"
        autoScroll
        scrollToBottomOnInitialize
        scrollToBottomOnRunStart
        scrollToBottomOnThreadSwitch
      >
        <FollowStreamingResponse />
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-3 sm:px-8 lg:px-12">
          <EmptyThread>
            {isEmpty && <div className="mt-2 w-full">{composer}</div>}
          </EmptyThread>
          {!isEmpty && (
            <div className="mt-auto">
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  if (message.composer.isEditing) {
                    return <MessageEditComposer />
                  }
                  return message.role === "user" ? (
                    <UserMessage />
                  ) : (
                    <AssistantMessage />
                  )
                }}
              </ThreadPrimitive.Messages>
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
  mcpServers,
  activeEndpoint,
  onEnsureConversation,
  onAttachMCP,
  onRemoveMCP,
  onUpload,
  onRemoveUpload,
  onConversationCreated,
  onConversationUpdated,
  onConversationSettled,
  onOpenHistory,
  conversationContext,
}: {
  conversationId: string | null
  initialMessages: UIMessage[]
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  activeEndpoint?: Endpoint
  onEnsureConversation: () => Promise<string>
  onAttachMCP: (serverId: string) => Promise<void>
  onRemoveMCP: (serverId: string) => Promise<void>
  onUpload: (file: File) => Promise<UploadedConversationAttachment>
  onRemoveUpload: (sourceId: string) => Promise<void>
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
  const [voiceError, setVoiceError] = useState<string | null>(null)
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
  const transcriptionEndpointId = useMemo(() => {
    const activeTranscriptionEndpoint = endpoint
      ? supportsVoiceTranscription(endpoint)
        ? endpoint
        : undefined
      : undefined
    const fallbackTranscriptionEndpoint =
      endpoints.find(
        (item) => supportsVoiceTranscription(item) && item.isDefault
      ) ?? endpoints.find(supportsVoiceTranscription)
    return activeTranscriptionEndpoint?.id ?? fallbackTranscriptionEndpoint?.id
  }, [endpoint, endpoints])

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

  const resumableStorage = useMemo(
    () =>
      createResumableSessionStorage({
        // A newly-created conversation uses a temporary key until the route
        // catches up; existing conversations are always isolated by id.
        key: `justai:resumable:${conversationId ?? "new"}`,
      }),
    [conversationId]
  )
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
          useMemory: true,
        }),
        resumable: {
          storage: resumableStorage,
          resumeApi: (streamId) =>
            `${API_URL}/api/v1/chat/resume/${encodeURIComponent(streamId)}`,
        },
        prepareReconnectToStreamRequest: async ({ headers }) => {
          const reconnectHeaders = new Headers(headers)
          const organizationId = api.getOrganizationId()
          if (organizationId) {
            reconnectHeaders.set("X-Organization-ID", organizationId)
          }
          return {
            headers: reconnectHeaders,
            credentials: "include",
          }
        },
        prepareSendMessagesRequest: async ({ body, messages }) => {
          const id = await onEnsureConversation()
          const requestMessages = Array.isArray(messages)
            ? await normalizeOutgoingImageMessages(messages)
            : []
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
              useMemory: true,
              requestId,
            },
          }
        },
      }),
    [onEnsureConversation, resumableStorage, selectedEndpointId, selectedModel]
  )

  const attachments = useMemo(
    () =>
      createAttachmentAdapter(
        onUpload,
        onRemoveUpload,
        supportsVision(endpoint)
      ),
    [endpoint, onRemoveUpload, onUpload]
  )
  const voice = useMemo(
    () =>
      createJustAIVoiceAdapter({
        conversationId,
        chatEndpointId: endpoint?.id,
        transcriptionEndpointId,
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
        onConversationUpdated,
        onToolApproval: setVoiceApproval,
        onError: (error) => setVoiceError(error.message),
      }),
    [
      conversationId,
      endpoint?.id,
      onConversationCreated,
      onConversationUpdated,
      transcriptionEndpointId,
    ]
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
      feedback,
      history,
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onResumeError: (error) => {
      onConversationUpdated?.()
      console.error("Assistant UI stream resume failed", error)
    },
    onError: (error) => {
      onConversationUpdated?.()
      console.error("Assistant UI chat error", error)
    },
    onFinish: ({ isError }) => {
      onConversationUpdated?.()
      if (!isError) onConversationSettled?.()
    },
  })

  useEffect(() => {
    return () => {
      // A route change can unmount the surface while the browser still owns
      // the microphone. Always close the Assistant UI voice session so the
      // WebSocket, worklet, and tracks cannot outlive the thread runtime.
      runtime.thread.disconnectVoice()
    }
  }, [runtime])

  const mcpAppHost = useMemo(
    () =>
      McpAppsRemoteHost({
        url: `${API_URL}/api/v1/mcp/apps`,
        fetch: (input, init) =>
          globalThis.fetch(input, { ...init, credentials: "include" }),
        headers: () => {
          const organizationId = api.getOrganizationId()
          const headers: Record<string, string> = {}
          if (organizationId) headers["X-Organization-ID"] = organizationId
          return headers
        },
      }),
    []
  )
  const mcpAppRenderer = useMemo(
    () =>
      McpAppRenderer({
        host: mcpAppHost,
        hostInfo: { name: "JustAI", version: "0.1.0" },
        maxHeight: 720,
        fallback: (
          <div className="rounded-xl border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            This MCP app is unavailable.
          </div>
        ),
      }),
    [mcpAppHost]
  )
  const assistantConfig = useMemo(
    () => AuiConfig({ tools: Tools({ mcpApp: mcpAppRenderer }) }),
    [mcpAppRenderer]
  )

  return (
    <AssistantRuntimeProvider runtime={runtime} config={assistantConfig}>
      <AssistantThreadLayout
        composerProps={{
          conversationContext,
          mcpServers,
          endpointId: selectedEndpointId,
          endpoints,
          models: availableModels,
          modelDiscoveryLoading,
          modelId: selectedModel,
          onEndpointChange: setEndpointId,
          onModelChange: (model) =>
            setModelByEndpoint((current) => ({
              ...current,
              [selectedEndpointId]: model,
            })),
          onOpenHistory,
          onAttachMCP,
          onRemoveMCP,
          toolApproval: voiceApproval,
        }}
        onVoiceErrorClear={() => setVoiceError(null)}
        onVoiceErrorDismiss={() => setVoiceError(null)}
        voiceError={voiceError}
      />
    </AssistantRuntimeProvider>
  )
}

export function ChatView({
  conversationId,
  endpoints,
  mcpServers,
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
  const [historyLoading, setHistoryLoading] = useState(Boolean(conversationId))
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
              Number((historyResult.reason as { status?: unknown }).status) ===
                404
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
    // The active Assistant UI runtime owns in-flight text and voice turns.
    // Conversation metadata refreshes can change messageCount without a route
    // change; reloading history for those updates would unmount the runtime
    // and terminate an otherwise healthy voice WebSocket.
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
    const controller = new AbortController()
    queueMicrotask(
      () => void loadConversationRef.current(conversationId, controller.signal)
    )
    return () => controller.abort()
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    const refresh = () => {
      void api
        .get<ConversationContext>(
          `/api/v1/conversations/${conversationId}/context`
        )
        .then((context) => {
          if (!cancelled) setConversationContext(context)
        })
        .catch(() => undefined)
    }
    const timer = window.setInterval(refresh, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [conversationId])

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

  const ensureConversation = useCallback(async () => {
    const creatingFromRoot = routeConversationIdRef.current === null
    if (creatingFromRoot) pendingConversationRef.current = true
    try {
      const id = await (onEnsureConversationRef.current?.() ??
        ensureLocalConversation())
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
  }, [ensureLocalConversation])

  const refreshConversationContext = useCallback(async (id: string) => {
    const context = await api.get<ConversationContext>(
      `/api/v1/conversations/${id}/context`
    )
    setConversationContext(context)
    onConversationUpdatedRef.current?.()
  }, [])

  const attachMCPServer = useCallback(
    async (serverId: string) => {
      const id = await ensureConversation()
      await api.post(`/api/v1/conversations/${id}/context/mcp/${serverId}`)
      await refreshConversationContext(id)
    },
    [ensureConversation, refreshConversationContext]
  )

  const removeMCPServer = useCallback(
    async (serverId: string) => {
      const id = activeConversationRef.current
      if (!id) return
      await api.delete(`/api/v1/conversations/${id}/context/mcp/${serverId}`)
      await refreshConversationContext(id)
    },
    [refreshConversationContext]
  )

  const waitForKnowledgeSource = useCallback(
    async (id: string, sourceId: string): Promise<KnowledgeSource> => {
      for (let attempt = 0; attempt < 90; attempt += 1) {
        const context = await api.get<ConversationContext>(
          `/api/v1/conversations/${id}/context`
        )
        setConversationContext(context)
        onConversationUpdatedRef.current?.()
        const source = context.knowledgeSources.find(
          (item) => item.id === sourceId
        )
        if (!source) {
          throw new Error("The imported source disappeared from this chat.")
        }
        if (source.status === "ready") return source
        if (source.status === "failed") {
          throw new Error(
            source.error || "The source could not be indexed for this chat."
          )
        }
        await new Promise((resolve) => window.setTimeout(resolve, 750))
      }
      throw new Error("The source took too long to become ready. Try it again.")
    },
    []
  )

  const uploadFile = useCallback(
    async (file: File): Promise<UploadedConversationAttachment> => {
      const id = await ensureConversation()
      const body = new FormData()
      body.append("file", file)
      const source = await api.upload<KnowledgeSource>(
        `/api/v1/conversations/${id}/attachments`,
        body
      )

      try {
        return { source: await waitForKnowledgeSource(id, source.id) }
      } catch (caught) {
        // Composer uploads are message-scoped. A failed or timed-out upload
        // should not leave an invisible Knowledge source blocking future turns.
        await api
          .delete(`/api/v1/conversations/${id}/context/knowledge/${source.id}`)
          .catch(() => undefined)
        await refreshConversationContext(id).catch(() => undefined)
        throw caught
      }
    },
    [ensureConversation, refreshConversationContext, waitForKnowledgeSource]
  )

  const removeUploadedFile = useCallback(async (sourceId: string) => {
    const id = activeConversationRef.current
    if (!id) return
    await api.delete(
      `/api/v1/conversations/${id}/context/knowledge/${sourceId}`
    )
    const context = await api.get<ConversationContext>(
      `/api/v1/conversations/${id}/context`
    )
    setConversationContext(context)
    onConversationUpdatedRef.current?.()
  }, [])

  const handleSurfaceConversationCreated = useCallback(
    (conversation: Conversation) => {
      // Voice can create its conversation without going through the normal
      // first-message path. Mark it as locally created before the workspace
      // updates the URL, so the route change does not replace the live voice
      // runtime with a freshly loaded history surface.
      locallyCreatedConversationRef.current = conversation.id
      activeConversationRef.current = conversation.id
      setActiveConversationId(conversation.id)
      onConversationCreatedRef.current?.(conversation)
    },
    []
  )

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
        mcpServers={mcpServers}
        initialMessages={initialMessages}
        onConversationCreated={handleSurfaceConversationCreated}
        onConversationUpdated={onConversationUpdated}
        onConversationSettled={onConversationSettled}
        onEnsureConversation={ensureConversation}
        onAttachMCP={attachMCPServer}
        onRemoveMCP={removeMCPServer}
        onOpenHistory={onOpenHistory}
        onRemoveUpload={removeUploadedFile}
        onUpload={uploadFile}
        conversationContext={conversationContext}
      />
      <span className="sr-only">
        {
          conversationContext.knowledgeSources.filter(
            (source) => source.contextScope !== "message"
          ).length
        }{" "}
        knowledge sources, {conversationContext.mcpServers.length} MCP servers,{" "}
        {conversationContext.transcriptionSessions.length} transcription
        sessions attached.
      </span>
    </div>
  )
}
