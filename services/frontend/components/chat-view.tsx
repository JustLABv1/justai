"use client"

import {
  getWelcomeGreeting,
  getServerWelcomeGreeting,
  subscribeToWelcomeGreeting,
} from "@/lib/welcome-greeting"
import { storageReferenceItems } from "@/lib/composer-storage-references"
import { useTranslations } from "@/components/locale-provider"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import {
  ArrowUp,
  Bot,
  BrainCircuit,
  Database,
  Check,
  ChevronDown,
  Copy,
  FileText,
  History,
  Pencil,
  AudioLines,
  Gauge,
  Mic,
  MicOff,
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
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  AuiConfig,
  ComposerPrimitive,
  type ExportedMessageRepository,
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
  useAuiEvent,
  useThreadViewport,
  useAuiState,
  useVoiceControls,
  useVoiceState,
  useVoiceVolume,
  type Unstable_TriggerItem,
  unstable_defaultDirectiveFormatter,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  createResumableSessionStorage,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"
import type { UIMessage } from "ai"

import {
  AssistantMessageParts,
  UserMessageParts,
} from "@/components/assistant-ui/message-parts"
import {
  ChatAttachmentPreview,
  ChatMessageAttachment,
} from "@/components/assistant-ui/attachment-preview"
import { VoiceToolApproval } from "@/components/assistant-ui/voice"
import {
  MCPApprovalCards,
  MCPApprovalProvider,
} from "@/components/assistant-ui/mcp-approval-context"
import { createJustAIVoiceAdapter } from "@/components/assistant-ui/voice-adapter"
import { BrandMark } from "@/components/brand-mark"
import { ChatBrandMark } from "@/components/chat-brand-mark"
import { EndpointBadge } from "@/components/endpoint-badge"
import { Button } from "@/components/ui/button"
import { UsageIndicator } from "@/components/usage-indicator"
import { Progress } from "@/components/ui/progress"
import { usageLimitReached, useUsage } from "@/lib/use-usage"
import { Menu } from "@/components/panelui/menu"
import { Message } from "@/components/panelui/message"
import { Prompt, type PromptCommandItem } from "@/components/panelui/prompt"
import { Spinner } from "@/components/panelui/spinner"
import {
  ModelPicker,
  type ModelPickerItem,
  type ModelPickerProvider,
} from "@/components/panelui/model-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { APIError, api, API_URL } from "@/lib/api"
import { chatRequestId } from "@/lib/chat-request-id"
import { conversationCacheKey } from "@/lib/conversation-cache"
import type {
  Conversation,
  ConversationContext,
  Endpoint,
  KnowledgeSource,
  KnowledgeItem,
  MCPServer,
  Note,
  SavedAssistant,
  ViewId,
} from "@/lib/types"
import { AuroraBackdrop } from "@/components/aurora-backdrop"
import { ComposerWeather } from "@/components/composer-weather"
import { cn } from "@/lib/utils"
import { chatContextLabel } from "@/lib/chat-context"

type EnsureConversationOptions = {
  activate?: boolean
  assistantId?: string | null
  inheritRepositories?: boolean
}

type Props = {
  displayName?: string
  conversationId: string | null
  cacheScope: string
  conversation?: Conversation
  assistants: SavedAssistant[]
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  notes: Note[]
  onEnsureConversation?: (
    options?: EnsureConversationOptions
  ) => Promise<string>
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onConversationSettled?: () => void
  onAssistantSelectionChange?: (assistantId: string | null) => void
  onConversationMissing?: () => void
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

type ComposerRef = { id: string; type: string; label: string }

type DiscoveredChatModel = {
  id: string
  name?: string
  ownedBy?: string
}

type UploadedConversationAttachment = {
  source: KnowledgeSource
}

type LoadedConversation = {
  messages: UIMessage[]
  context: ConversationContext
}

type CachedConversation = LoadedConversation & {
  cachedAt: number
}

const CONVERSATION_CACHE_TTL_MS = 30_000
const CONVERSATION_CACHE_LIMIT = 20
const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024
const conversationCache = new Map<string, CachedConversation>()

function readCachedConversation(
  scope: string,
  id: string
): LoadedConversation | null {
  const key = conversationCacheKey(scope, id)
  const cached = conversationCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.cachedAt > CONVERSATION_CACHE_TTL_MS) {
    conversationCache.delete(key)
    return null
  }
  conversationCache.delete(key)
  conversationCache.set(key, cached)
  return { messages: cached.messages, context: cached.context }
}

function cacheConversation(
  scope: string,
  id: string,
  loaded: LoadedConversation
) {
  const key = conversationCacheKey(scope, id)
  conversationCache.delete(key)
  conversationCache.set(key, { ...loaded, cachedAt: Date.now() })
  while (conversationCache.size > CONVERSATION_CACHE_LIMIT) {
    const oldestKey = conversationCache.keys().next().value
    if (typeof oldestKey !== "string") break
    conversationCache.delete(oldestKey)
  }
}

function invalidateConversationCache(scope: string, id: string | null) {
  if (id) conversationCache.delete(conversationCacheKey(scope, id))
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
  repositories: [],
  mcpServers: [],
  transcriptionSessions: [],
  notes: [],
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
  upload: (
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal
  ) => Promise<UploadedConversationAttachment>,
  remove: (sourceId: string) => Promise<void>,
  supportsVision: boolean
): AttachmentAdapter {
  const uploadedByAttachmentId = new Map<
    string,
    UploadedConversationAttachment
  >()
  const uploadControllers = new Map<string, AbortController>()

  return {
    accept: `${supportsVision ? "image/*," : ""}text/plain,text/markdown,text/html,text/csv,application/json,application/pdf,message/rfc822,application/vnd.ms-outlook,.csv,.xml,.yaml,.yml,.rtf,.eml,.msg,.docx,.docm,.xlsx,.xlsm,.pptx,.pptm,.odt,.ods,.odp,.epub`,
    async *add({ file }) {
      const attachment: PendingAttachment = {
        id: crypto.randomUUID(),
        type: file.type.startsWith("image/") ? "image" : "document",
        name: file.name,
        contentType: file.type || "application/octet-stream",
        file,
        status: { type: "requires-action", reason: "composer-send" },
      }

      if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
        yield {
          ...attachment,
          status: {
            type: "incomplete",
            reason: "error",
            message: "Files must be 25 MB or smaller.",
          },
        }
        return
      }

      // Vision images are sent as model content, not pushed through the text
      // ingestion pipeline. This keeps image uploads from being advertised as
      // Knowledge sources the backend cannot extract.
      if (attachment.type === "image") {
        if (!supportsVision) {
          yield {
            ...attachment,
            status: {
              type: "incomplete",
              reason: "error",
              message: "The selected endpoint cannot process images.",
            },
          }
          return
        }
        yield attachment
        return
      }

      const abortController = new AbortController()
      uploadControllers.set(attachment.id, abortController)
      let progress = 0
      let progressPending = false
      let resolveProgress: (() => void) | null = null
      const uploadPromise = upload(
        file,
        (value) => {
          progress = Math.max(0, Math.min(100, value))
          progressPending = true
          resolveProgress?.()
          resolveProgress = null
        },
        abortController.signal
      )
      yield {
        ...attachment,
        status: { type: "running", reason: "uploading", progress: 0 },
      }
      try {
        let uploaded: UploadedConversationAttachment
        while (true) {
          if (progressPending) {
            progressPending = false
            yield {
              ...attachment,
              status: { type: "running", reason: "uploading", progress },
            }
          }
          const nextProgress = new Promise<void>((resolve) => {
            resolveProgress = resolve
          })
          const result = await Promise.race([
            uploadPromise.then(
              (value) => ({ type: "done" as const, value }),
              (reason) => ({ type: "error" as const, reason })
            ),
            nextProgress.then(() => ({ type: "progress" as const })),
          ])
          if (result.type === "progress") continue
          if (result.type === "error") throw result.reason
          uploaded = result.value
          break
        }
        uploadedByAttachmentId.set(attachment.id, uploaded)
        yield attachment
      } catch (caught) {
        if (abortController.signal.aborted) return
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
      } finally {
        uploadControllers.delete(attachment.id)
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
      uploadControllers.get(attachment.id)?.abort()
      uploadControllers.delete(attachment.id)
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
  const aui = useAui()
  const count = useAuiState((state) => state.message.branchCount)
  const number = useAuiState((state) => state.message.branchNumber)
  if (count <= 1) return null
  return (
    <Message.Branch
      count={count}
      index={number - 1}
      onIndexChange={(index) =>
        aui.message.switchToBranch({
          position: index < number - 1 ? "previous" : "next",
        })
      }
    />
  )
}

function MessageActions({
  assistant,
  isLatest = false,
}: {
  assistant: boolean
  isLatest?: boolean
}) {
  return (
    <Message.Actions
      className="mt-1"
      reveal={assistant && isLatest ? "always" : "hover"}
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
    </Message.Actions>
  )
}

type MessageActionButtonProps = {
  label: string
  onClick: () => void | Promise<void>
  children: ReactNode
  disabled?: boolean
  pressed?: boolean
}

function MessageActionButton({
  label,
  onClick,
  children,
  disabled = false,
  pressed,
}: MessageActionButtonProps) {
  return (
    <Message.Action
      label={label}
      disabled={disabled}
      pressed={pressed}
      onClick={() => void onClick()}
    >
      {children}
    </Message.Action>
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
  const { t } = useTranslations()

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
      label={isCopied ? t("Copied") : t("Copy message")}
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
  const { t } = useTranslations()

  const aui = useAui()
  const isEditing = useAuiState((state) => state.message.composer.isEditing)
  return (
    <MessageActionButton
      disabled={isEditing}
      label={t("Edit message")}
      onClick={() => aui.composer.beginEdit()}
    >
      <Pencil className="size-3.5" />
    </MessageActionButton>
  )
}

function ReloadMessageAction() {
  const { t } = useTranslations()

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
      label={t("Regenerate response")}
      onClick={() => aui.message.reload()}
    >
      <RefreshCw className="size-3.5" />
    </MessageActionButton>
  )
}

function SpeakMessageAction() {
  const { t } = useTranslations()

  const aui = useAui()
  const speaking = useAuiState((state) => {
    const status = state.message.speech?.status.type
    return status === "starting" || status === "running"
  })
  return (
    <MessageActionButton
      label={speaking ? t("Stop reading aloud") : t("Read response aloud")}
      onClick={() =>
        speaking ? aui.message.stopSpeaking() : aui.message.speak()
      }
    >
      {speaking ? <X className="size-3.5" /> : <Volume2 className="size-3.5" />}
    </MessageActionButton>
  )
}

function FeedbackMessageAction({ type }: { type: "positive" | "negative" }) {
  const { t } = useTranslations()

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
      label={type === "positive" ? t("Good response") : t("Poor response")}
      pressed={submitted === type}
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
  const { t } = useTranslations()

  return (
    <div className="mx-auto w-full max-w-4xl px-1 py-3 sm:px-4">
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm">
        <ComposerPrimitive.Input
          autoFocus
          className="max-h-40 min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          placeholder={t("Edit message…")}
          submitMode="ctrlEnter"
        />
        <div className="flex shrink-0 items-center gap-1">
          <ComposerPrimitive.Cancel
            aria-label={t("Cancel edit")}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send
            aria-label={t("Save edit")}
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
    <Message.Footer className="ml-auto text-[10px] opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
      {duration ? `${(duration / 1000).toFixed(1)}s` : ""}
      {duration && chunks ? " · " : ""}
      {chunks ? `${chunks} chunks` : ""}
    </Message.Footer>
  )
}

function ContextDisplay({
  context,
  onRemoveMCP,
  onRemoveNote,
  onRemoveRepository,
  onRemoveKnowledge,
  onRemoveTranscription,
  onSaveKnowledge,
}: {
  context: ConversationContext
  onRemoveMCP?: (serverId: string) => Promise<void>
  onRemoveNote?: (noteId: string) => Promise<void>
  onRemoveRepository?: (repositoryId: string) => Promise<void>
  onRemoveKnowledge?: (sourceId: string) => Promise<void>
  onRemoveTranscription?: (sessionId: string) => Promise<void>
  onSaveKnowledge?: (sourceId: string) => Promise<void>
}) {
  const { t } = useTranslations()

  const [removingContextId, setRemovingContextId] = useState<string | null>(
    null
  )
  const [savingContextId, setSavingContextId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const items: Array<{
    id: string
    label: string
    detail: string
    kind: "knowledge" | "repository" | "mcp" | "note" | "transcription"
    resourceId?: string
    contextScope?: "persistent" | "message"
  }> = [
    ...context.knowledgeSources.map((source) => ({
      id: `knowledge:${source.id}`,
      label: source.title,
      detail: source.sourceType || "knowledge",
      kind: "knowledge" as const,
      resourceId: source.id,
      contextScope: source.contextScope,
    })),
    ...context.mcpServers.map((server) => ({
      id: `mcp:${server.id}`,
      label: server.name,
      detail: "MCP",
      kind: "mcp" as const,
      resourceId: server.id,
    })),
    ...(context.notes ?? []).map((note) => ({
      id: `note:${note.id}`,
      label: note.title,
      detail: "note",
      kind: "note" as const,
      resourceId: note.id,
    })),
    ...context.transcriptionSessions.map((session) => ({
      id: `transcription:${session.id}`,
      label: session.title,
      detail: "transcription",
      kind: "transcription" as const,
      resourceId: session.id,
    })),
  ]

  const handleRemoveContext = async (
    kind: "mcp" | "note" | "repository" | "knowledge" | "transcription",
    resourceId: string
  ) => {
    if (removingContextId) return
    const onRemove =
      kind === "mcp"
        ? onRemoveMCP
        : kind === "note"
          ? onRemoveNote
          : kind === "knowledge"
            ? onRemoveKnowledge
            : kind === "transcription"
              ? onRemoveTranscription
              : onRemoveRepository
    if (!onRemove) return

    setRemoveError(null)
    setRemovingContextId(resourceId)
    try {
      await onRemove(resourceId)
    } catch (error) {
      setRemoveError(
        error instanceof Error
          ? error.message
          : "The context could not be removed from this chat."
      )
    } finally {
      setRemovingContextId(null)
    }
  }

  const handleSaveKnowledge = async (sourceId: string) => {
    if (!onSaveKnowledge || savingContextId) return
    setRemoveError(null)
    setSavingContextId(sourceId)
    try {
      await onSaveKnowledge(sourceId)
    } catch (error) {
      setRemoveError(
        error instanceof Error
          ? error.message
          : "The source could not be saved to Knowledge."
      )
    } finally {
      setSavingContextId(null)
    }
  }

  return (
    <Prompt.Context open={items.length > 0 || Boolean(removeError)}>
      <span className="sr-only">{t("Attached context")}</span>
      {items.map((item) => (
        <Prompt.ContextItem
          className="max-w-52"
          key={item.id}
          title={`${item.label} · ${item.detail}`}
        >
          {item.kind === "mcp" ? (
            <Plug aria-hidden="true" />
          ) : (
            <FileText aria-hidden="true" />
          )}
          <span className="truncate font-medium text-foreground/85">
            {item.label}
          </span>
          <span className="hidden shrink-0 text-[10px] opacity-70 sm:inline">
            {item.detail}
          </span>
          {item.kind === "knowledge" &&
          item.contextScope === "message" &&
          onSaveKnowledge ? (
            <button
              type="button"
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-50"
              aria-label={t("Save {value0} to Knowledge", {
                value0: item.label,
              })}
              title={t("Save to Knowledge")}
              disabled={savingContextId !== null}
              onClick={() => void handleSaveKnowledge(item.resourceId!)}
            >
              {savingContextId === item.resourceId ? t("Saving…") : t("Save")}
            </button>
          ) : null}
          {item.resourceId &&
          ((item.kind === "mcp" && onRemoveMCP) ||
            (item.kind === "note" && onRemoveNote) ||
            (item.kind === "repository" && onRemoveRepository) ||
            (item.kind === "knowledge" && onRemoveKnowledge) ||
            (item.kind === "transcription" && onRemoveTranscription)) ? (
            <button
              type="button"
              className="shrink-0 rounded-full p-0.5 opacity-70 transition-colors hover:bg-background hover:opacity-100 disabled:pointer-events-none disabled:opacity-50"
              aria-label={t("Remove {value0} from this chat", {
                value0: item.label,
              })}
              title={t("Remove {value0} from this chat", {
                value0: item.label,
              })}
              disabled={removingContextId !== null}
              onClick={() => {
                if (
                  item.kind === "mcp" ||
                  item.kind === "note" ||
                  item.kind === "repository" ||
                  item.kind === "knowledge" ||
                  item.kind === "transcription"
                )
                  void handleRemoveContext(item.kind, item.resourceId!)
              }}
            >
              {removingContextId === item.resourceId ? (
                <Spinner size="sm" />
              ) : (
                <X aria-hidden="true" />
              )}
            </button>
          ) : null}
        </Prompt.ContextItem>
      ))}
      {removeError ? (
        <p role="alert" className="shrink-0 text-destructive">
          {t(removeError)}
        </p>
      ) : null}
    </Prompt.Context>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group/message px-1 py-3 sm:px-4">
      <Message from="user">
        <Message.Content className="max-w-[min(44rem,90%)]">
          <Message.Bubble>
            <MessagePrimitive.Quote>
              {({ text }) => (
                <blockquote className="mb-2 border-l-2 border-accent-foreground/40 pl-3 text-xs leading-5 text-accent-foreground/80 dark:border-primary-foreground/50 dark:text-primary-foreground/80">
                  {text}
                </blockquote>
              )}
            </MessagePrimitive.Quote>
            <Message.BubbleContent>
              <UserMessageParts />
            </Message.BubbleContent>
          </Message.Bubble>
          <MessageAttachments />
          <div className="flex items-center gap-2">
            <MessageActions assistant={false} />
            <BranchPicker />
          </div>
        </Message.Content>
      </Message>
    </MessagePrimitive.Root>
  )
}

/** Servers answer errors as JSON: show the sentence in it, not the JSON. */
function readChatError(error: unknown): { code?: string; message: string } {
  const fromObject = (value: unknown): { code?: string; message?: string } => {
    if (!value || typeof value !== "object") return {}
    const record = value as Record<string, unknown>
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : undefined
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message,
    }
  }
  let found = fromObject(error)
  const text = typeof error === "string" ? error : found.message
  if (text) {
    try {
      const parsed = fromObject(JSON.parse(text))
      if (parsed.message)
        found = { code: parsed.code ?? found.code, message: parsed.message }
    } catch {
      // Not JSON: it is already a sentence.
    }
  }
  return {
    code: found.code,
    message: found.message ?? text ?? "Something went wrong.",
  }
}

function ChatErrorNotice() {
  const { t, locale } = useTranslations()
  const status = useAuiState((state) => state.message.status)
  const { code, message } = readChatError(
    status?.type === "incomplete" && status.reason === "error"
      ? status.error
      : undefined
  )
  const limitReached = code === "usage_limit_reached"
  const usage = useUsage(limitReached)

  if (!limitReached) {
    return (
      <div
        className="mt-2 flex max-w-4xl items-center rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        role="alert"
      >
        {t(message)}
      </div>
    )
  }

  const resets = usage
    ? new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(usage.periodEnd))
    : null
  const number = new Intl.NumberFormat(locale)
  return (
    <div
      className="mt-3 flex max-w-xl items-start gap-3 rounded-2xl border bg-card p-4"
      role="alert"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]">
        <Gauge aria-hidden="true" className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6 font-medium">
          {t("Monthly usage limit reached")}
        </p>
        <p className="text-sm leading-6 text-muted-foreground">
          {resets
            ? t(
                "You have used your token budget for this month. It resets on {value0}, or a workspace admin can raise it.",
                { value0: resets }
              )
            : t("You have used your token budget for this month.")}
        </p>
        {usage && usage.monthlyTokenLimit !== null && (
          <div className="mt-3 grid gap-1.5">
            <Progress
              aria-label={t("Used of the monthly limit")}
              className="gap-0 [&_[data-slot=progress-indicator]]:bg-[var(--warning)]"
              value={Math.min(
                100,
                (usage.totalTokens / Math.max(1, usage.monthlyTokenLimit)) * 100
              )}
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {number.format(usage.totalTokens)} /{" "}
              {number.format(usage.monthlyTokenLimit)} {t("tokens")}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function AssistantMessage({ isLatest }: { isLatest: boolean }) {
  const isThreadRunning = useAuiState((state) => state.thread.isRunning)
  const startsWithTool = useAuiState(
    (state) =>
      state.message.parts.find((part) => part.type !== "data")?.type ===
      "tool-call"
  )
  const isStreamingMessage = isLatest && isThreadRunning

  return (
    <MessagePrimitive.Root className="group/message px-1 py-4 sm:px-4">
      <Message
        from="assistant"
        streaming={isStreamingMessage}
        className="mx-auto max-w-4xl items-start"
      >
        <Message.Avatar>
          <ChatBrandMark
            className={cn("size-5 shrink-0", startsWithTool ? "mt-5" : "mt-1")}
            isActive={isStreamingMessage}
          />
        </Message.Avatar>
        <Message.Content className="gap-0">
          <div className="w-full text-sm leading-7 text-foreground">
            <AssistantMessageParts />
          </div>
          <MessageAttachments />
          <MessagePrimitive.Error>
            <ChatErrorNotice />
          </MessagePrimitive.Error>
          {!isStreamingMessage ? (
            <div className="flex w-full items-center gap-2">
              <div className="flex items-center gap-2">
                <MessageActions assistant isLatest={isLatest} />
                <BranchPicker />
              </div>
              <MessageTiming />
            </div>
          ) : null}
          <ChatResponseActivity isLatest={isLatest} />
        </Message.Content>
      </Message>
    </MessagePrimitive.Root>
  )
}

function ChatAmbient() {
  return (
    <div
      aria-hidden="true"
      className="chat-ambient absolute inset-0 overflow-hidden"
    >
      <span className="chat-ambient__orb chat-ambient__orb--one" />
      <span className="chat-ambient__orb chat-ambient__orb--two" />
      <span className="chat-ambient__orb chat-ambient__orb--three" />
    </div>
  )
}

const subscribeNever = () => () => {}

function ChatBackdrop() {
  // Rendered into the inset content panel (an isolated stacking context) so
  // the image sits behind the chat but stays inside the rounded panel.
  const shell = useSyncExternalStore(
    subscribeNever,
    () => document.getElementById("workspace-inset"),
    () => null
  )
  if (!shell) return null
  return createPortal(
    <>
      <AuroraBackdrop
        composerWeather
        className="absolute inset-x-0 top-0 -z-10 h-[75%]"
      />
      <ComposerWeather />
    </>,
    shell
  )
}

function ChatResponseActivity({ isLatest }: { isLatest: boolean }) {
  const { t } = useTranslations()

  const isRunning = useAuiState((state) => state.thread.isRunning)
  const latestAssistantMessage = useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index -= 1) {
      const message = state.thread.messages[index]
      if (message?.role === "assistant") return message
    }
    return undefined
  })
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!isRunning) return

    const startedAt = Date.now()
    const updateElapsedTime = () => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }
    const initialUpdate = window.setTimeout(updateElapsedTime, 0)
    const interval = window.setInterval(() => {
      updateElapsedTime()
    }, 750)

    return () => {
      window.clearTimeout(initialUpdate)
      window.clearInterval(interval)
    }
  }, [isRunning])

  const status = useMemo(() => {
    const toolCall = latestAssistantMessage?.parts.find(
      (part) => part.type === "tool-call"
    )

    if (toolCall?.type === "tool-call") {
      if (["web_search", "browse_url"].includes(toolCall.toolName)) {
        return t("Searching sources")
      }
      if (["generate_image", "edit_image"].includes(toolCall.toolName)) {
        return t("Creating image")
      }
      if (
        ["create_pdf", "create_file", "fill_template"].includes(
          toolCall.toolName
        )
      ) {
        return t("Creating file")
      }
      return `Using ${toolCall.toolName.replaceAll("_", " ")}`
    }

    const streamedText = latestAssistantMessage?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()

    if (streamedText) return t("Writing answer")
    if (elapsedSeconds >= 3) return t("Planning a helpful answer")
    return t("Understanding your request")
  }, [elapsedSeconds, latestAssistantMessage, t])

  if (!isRunning || !isLatest) return null

  return <Message.Status>{status}</Message.Status>
}

/**
 * Outline of the conversation: one tick per question, the tick for the section
 * currently on screen is highlighted, and hovering or focusing the rail opens a
 * list of the questions to jump to.
 */
function ConversationRail() {
  const { t } = useTranslations()

  const messages = useAuiState((state) => state.thread.messages)
  const [activeId, setActiveId] = useState<string | null>(null)

  const turns = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((message, index) => {
          const text = message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
          return {
            id: message.id,
            number: index + 1,
            excerpt:
              text.length > 70 ? `${text.slice(0, 67).trimEnd()}…` : text,
          }
        }),
    [messages]
  )

  // Re-subscribe only when the set of questions changes, not on every render.
  const turnIds = turns.map((turn) => turn.id).join("|")
  const turnsRef = useRef(turns)
  useEffect(() => {
    turnsRef.current = turns
  })

  useEffect(() => {
    const turnList = turnIds ? turnsRef.current : []
    if (turnList.length === 0) return
    // The thread's scroll container is the nearest scrollable ancestor of any
    // message element.
    let viewport: HTMLElement | null =
      document.querySelector<HTMLElement>("[data-message-id]")
    while (
      viewport &&
      !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)
    )
      viewport = viewport.parentElement
    if (!viewport) return
    const scroller = viewport
    let frame = 0
    const update = () => {
      frame = 0
      const line =
        scroller.getBoundingClientRect().top + scroller.clientHeight * 0.35
      let current = turnList[0].id
      for (const turn of turnList) {
        const element = scroller.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(turn.id)}"]`
        )
        if (!element) continue
        if (element.getBoundingClientRect().top <= line) current = turn.id
        else break
      }
      setActiveId(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const initial = setTimeout(update, 0)
    scroller.addEventListener("scroll", schedule, { passive: true })
    return () => {
      clearTimeout(initial)
      scroller.removeEventListener("scroll", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [turnIds])

  if (messages.length < 2 || turns.length === 0) return null

  const jumpTo = (id: string) => {
    const target = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`
    )
    target?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  return (
    <nav
      aria-label={t("Conversation navigation")}
      className="pointer-events-none absolute inset-y-20 left-3 z-20 hidden items-center lg:flex"
    >
      <div className="group/rail pointer-events-auto relative">
        <ul className="flex max-h-[min(50vh,22rem)] flex-col gap-1.5 overflow-hidden py-1 transition-opacity group-focus-within/rail:opacity-0 group-hover/rail:opacity-0">
          {turns.map((turn) => (
            <li key={turn.id}>
              <span
                aria-hidden="true"
                className={cn(
                  "block h-0.5 rounded-full transition-all",
                  turn.id === activeId
                    ? "w-5 bg-primary"
                    : "w-3 bg-muted-foreground/40"
                )}
              />
            </li>
          ))}
        </ul>
        <div className="invisible absolute top-1/2 -left-2 w-64 -translate-y-1/2 rounded-2xl border border-border/80 bg-popover p-1 opacity-0 shadow-lg transition-opacity group-focus-within/rail:visible group-focus-within/rail:opacity-100 group-hover/rail:visible group-hover/rail:opacity-100">
          <ol className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {turns.map((turn) => (
              <li key={turn.id}>
                <button
                  aria-current={turn.id === activeId ? "true" : undefined}
                  className={cn(
                    "flex w-full min-w-0 items-baseline gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs leading-5 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    turn.id === activeId
                      ? "bg-primary/15 font-medium text-foreground"
                      : "text-muted-foreground"
                  )}
                  onClick={() => jumpTo(turn.id)}
                  type="button"
                >
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      turn.id === activeId ? "text-primary" : "opacity-60"
                    )}
                  >
                    {turn.number}
                  </span>
                  <span className="line-clamp-2 min-w-0">
                    {turn.excerpt || t("Message")}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </nav>
  )
}

function MessageAttachments() {
  return (
    <MessagePrimitive.Attachments>
      {({ attachment }) => (
        <AttachmentPrimitive.Root className="mt-2 max-w-full">
          <Message.Attachments>
            <ChatMessageAttachment attachment={attachment} />
          </Message.Attachments>
        </AttachmentPrimitive.Root>
      )}
    </MessagePrimitive.Attachments>
  )
}

function ScrollToLatest() {
  const { t } = useTranslations()

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
          aria-label={t("Jump to latest message")}
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

function EmptyThread({
  children,
  displayName,
}: {
  children?: ReactNode
  displayName?: string
}) {
  const { t } = useTranslations()
  const greeting = useSyncExternalStore(
    subscribeToWelcomeGreeting,
    getWelcomeGreeting,
    getServerWelcomeGreeting
  )
  const firstName = displayName?.trim().split(/\s+/)[0]
  return (
    <ThreadPrimitive.Empty>
      <div className="relative flex min-h-[calc(100svh-8rem)] w-full flex-col items-center justify-center px-5 py-12 text-center">
        <ChatAmbient />
        <div className="z-10 flex w-full max-w-3xl flex-col items-center">
          <div className="mb-3 grid w-full grid-cols-[3rem_minmax(0,auto)_3rem] items-center justify-center gap-3">
            <ChatBrandMark className="size-12 shrink-0" />
            <span className="text-2xl font-semibold tracking-[-0.04em]">
              {firstName ? t(greeting, { name: firstName }) : t("Hello there")}
            </span>
          </div>
          {children}
        </div>
      </div>
    </ThreadPrimitive.Empty>
  )
}

const ENDPOINT_MODEL_SEPARATOR = "::"

export function ModelEndpointPicker({
  endpoints,
  endpointId,
  modelsByEndpoint,
  modelId,
  modelDiscoveryLoading,
  modelDiscoveryFailed,
  onRetryModelDiscovery,
  onSelect,
  compact,
}: {
  endpoints: Endpoint[]
  endpointId: string
  modelsByEndpoint: Record<string, DiscoveredChatModel[]>
  modelId: string
  modelDiscoveryLoading?: boolean
  modelDiscoveryFailed?: boolean
  onRetryModelDiscovery?: () => void
  onSelect: (endpointId: string, modelId: string) => void
  compact: boolean
}) {
  const { t } = useTranslations()

  const providers = useMemo<ModelPickerProvider[]>(
    () =>
      endpoints.map((item) => ({
        value: item.id,
        label: item.name,
        icon: (
          <EndpointBadge
            name={item.name}
            logoUrl={item.logoUrl}
            className="size-4 shrink-0 text-[8px] in-[[role=toolbar]]:size-8 in-[[role=toolbar]]:text-xs"
          />
        ),
      })),
    [endpoints]
  )

  const items = useMemo<ModelPickerItem[]>(() => {
    const result: ModelPickerItem[] = []
    for (const item of endpoints) {
      const models = [...(modelsByEndpoint[item.id] ?? [])]
      // Keep the chosen model visible even if discovery did not list it.
      if (
        item.id === endpointId &&
        modelId &&
        !models.some((model) => model.id === modelId)
      ) {
        models.unshift({ id: modelId })
      }
      for (const model of models) {
        result.push({
          value: `${item.id}${ENDPOINT_MODEL_SEPARATOR}${model.id}`,
          label: model.name || model.id,
          provider: item.id,
          description:
            model.name && model.name !== model.id ? model.id : undefined,
        })
      }
    }
    return result
  }, [endpoints, endpointId, modelId, modelsByEndpoint])

  const [favorites, setFavorites] = useState<string[]>([])
  const favoritesEdited = useRef(false)
  useEffect(() => {
    let cancelled = false
    api
      .get<{ favorites?: string[] }>("/api/v1/profile/favorite-models")
      .then((result) => {
        // Keep a star the user set while the list was still loading.
        if (!cancelled && !favoritesEdited.current)
          setFavorites(result.favorites ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const anyEndpointLoading = endpoints.some(
    (item) => modelsByEndpoint[item.id] === undefined
  )
  const value = modelId
    ? `${endpointId}${ENDPOINT_MODEL_SEPARATOR}${modelId}`
    : null

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ModelPicker
        items={items}
        providers={providers}
        value={value}
        favorites={favorites}
        onFavoritesChange={(next) => {
          const previous = favorites
          favoritesEdited.current = true
          setFavorites(next)
          api
            .put("/api/v1/profile/favorite-models", { favorites: next })
            .catch(() => setFavorites(previous))
        }}
        onValueChange={(next) => {
          const index = next.indexOf(ENDPOINT_MODEL_SEPARATOR)
          if (index < 0) return
          onSelect(
            next.slice(0, index),
            next.slice(index + ENDPOINT_MODEL_SEPARATOR.length)
          )
        }}
        label={t("Select LLM endpoint and chat model")}
        hotkey="alt+m"
      >
        <ModelPicker.Trigger
          placeholder={
            modelDiscoveryLoading ? t("Discovering models…") : t("Select model")
          }
          className={cn(
            "h-8 max-w-64 min-w-0 rounded-full text-muted-foreground",
            compact && "max-w-24 sm:max-w-56"
          )}
        />
        <ModelPicker.Content
          side="top"
          align="end"
          sideOffset={12}
          placeholder={t("Search models")}
          emptyText={
            modelDiscoveryLoading || anyEndpointLoading ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="md" label={t("Discovering models…")} />
                {t("Discovering models…")}
              </span>
            ) : (
              t("No models available. Configure an endpoint in Settings.")
            )
          }
        />
      </ModelPicker>
      {anyEndpointLoading && (
        <Spinner
          size="sm"
          label={t("Discovering models…")}
          className="shrink-0 text-muted-foreground"
        />
      )}
      {modelDiscoveryFailed &&
        !modelDiscoveryLoading &&
        onRetryModelDiscovery && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRetryModelDiscovery}
            title={t("Models could not be loaded. Retrying…")}
            aria-label={t("Retry now")}
            className="size-8 shrink-0 rounded-full text-muted-foreground"
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
    </div>
  )
}

export function AssistantPicker({
  assistants,
  assistantId,
  compact,
  disabled,
  onAssistantChange,
}: {
  assistants: SavedAssistant[]
  assistantId: string
  compact: boolean
  disabled?: boolean
  onAssistantChange: (id: string) => void
}) {
  const { t } = useTranslations()

  const selectedAssistant = assistants.find(
    (assistant) => assistant.id === assistantId
  )
  const label = selectedAssistant?.name ?? t("JustAI default")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            aria-label={t("Select agent")}
            className={cn(
              "h-9 max-w-48 min-w-0 justify-start gap-1.5 rounded-full border-0 bg-transparent px-2 text-xs font-normal text-foreground hover:bg-muted/70",
              compact && "max-w-36 px-1.5"
            )}
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Bot
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="truncate text-muted-foreground">{label}</span>
        {!disabled && (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {t("Agent")}
        </div>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onAssistantChange("")}>
            <Bot data-icon="inline-start" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {t("JustAI default")}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {t("Use the normal workspace behavior")}
              </span>
            </span>
            <Check
              className={cn(
                "size-3.5",
                assistantId ? "opacity-0" : "opacity-100"
              )}
            />
          </DropdownMenuItem>
          {assistants.length > 0 ? (
            assistants.map((assistant) => (
              <DropdownMenuItem
                className="items-start py-2"
                key={assistant.id}
                onClick={() => onAssistantChange(assistant.id)}
              >
                <Bot data-icon="inline-start" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {assistant.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {assistant.kind === "remote"
                      ? t("Remote A2A agent")
                      : assistant.description ||
                        "Saved instructions and defaults"}
                  </span>
                </span>
                <Check
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    assistant.id === assistantId ? "opacity-100" : "opacity-0"
                  )}
                />
              </DropdownMenuItem>
            ))
          ) : (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("Create an assistant in the Assistants workspace first.")}
            </p>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DeepContextToggle({
  available,
  compact,
  enabled,
  onToggle,
  title,
}: {
  available: boolean
  compact: boolean
  enabled: boolean
  onToggle: () => void
  title: string
}) {
  const { t } = useTranslations()

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={available ? t("Toggle deep context mode") : title}
        aria-pressed={enabled}
        disabled={!available}
        openOnHover
        delay={250}
        closeDelay={120}
        onClick={onToggle}
        render={
          <Button
            className={cn(
              "rounded-full text-muted-foreground hover:text-foreground",
              compact ? "size-9 p-0" : "gap-1.5 px-2.5",
              enabled &&
                "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            )}
            size={compact ? "icon" : "sm"}
            type="button"
            variant="ghost"
          />
        }
        title={title}
      >
        <BrainCircuit className="size-4" aria-hidden="true" />
        {!compact && <span>{t("Deep context")}</span>}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="end"
          className="z-50 outline-none"
          side="top"
          sideOffset={8}
        >
          <PopoverPrimitive.Popup
            className="w-[min(22rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-2xl bg-popover p-3 text-popover-foreground shadow-xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
            initialFocus={false}
          >
            <PopoverPrimitive.Arrow className="-mb-1 size-2.5 rotate-45 border-r border-b bg-popover" />
            <div className="flex items-start gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <BrainCircuit className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <PopoverPrimitive.Title className="text-xs font-semibold">
                  {t("Deep context")}
                </PopoverPrimitive.Title>
                <PopoverPrimitive.Description className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t(
                    "Searches a broader, more diverse set of passages across your attached repository so JustAI can connect evidence across files."
                  )}
                </PopoverPrimitive.Description>
              </div>
              <PopoverPrimitive.Close
                aria-label={t("Close deep context explanation")}
                className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </PopoverPrimitive.Close>
            </div>
            <div className="mt-3 rounded-xl bg-muted/50 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">
                {enabled ? t("On") : t("Off")}
              </span>
              {enabled
                ? t(" · broader retrieval is active for the next question.")
                : t(" · quick retrieval uses a smaller context window.")}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              {t(
                "This still uses a relevant sample, not the entire repository."
              )}
            </p>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function Composer({
  assistants,
  assistantId,
  assistantLocked,
  onAssistantChange,
  endpoints,
  mcpServers,
  notes,
  endpointId,
  modelsByEndpoint,
  modelId,
  modelDiscoveryLoading,
  modelDiscoveryFailed,
  onRetryModelDiscovery,
  onModelSelect,
  deepContext,
  onDeepContextChange,
  searchStorage,
  onSearchStorageChange,
  compact = false,
  onOpenHistory,
  conversationContext,
  onAttachMCP,
  onRemoveMCP,
  onAttachNote,
  onRemoveNote,
  onRemoveRepository,
  onRemoveKnowledge,
  onRemoveTranscription,
  onSaveKnowledge,
  toolApproval,
  voiceTranscript,
  voiceError,
  onVoiceErrorClear,
}: {
  assistants: SavedAssistant[]
  assistantId: string
  assistantLocked: boolean
  onAssistantChange: (id: string) => void
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  notes: Note[]
  endpointId: string
  modelsByEndpoint: Record<string, DiscoveredChatModel[]>
  modelId: string
  modelDiscoveryLoading?: boolean
  modelDiscoveryFailed?: boolean
  onRetryModelDiscovery?: () => void
  onModelSelect: (endpointId: string, modelId: string) => void
  deepContext: boolean
  onDeepContextChange: (enabled: boolean) => void
  searchStorage: boolean
  onSearchStorageChange: (enabled: boolean) => void
  compact?: boolean
  onOpenHistory?: () => void
  conversationContext: ConversationContext
  onAttachMCP: (serverId: string) => Promise<void>
  onRemoveMCP: (serverId: string) => Promise<void>
  onAttachNote: (noteId: string) => Promise<void>
  onRemoveNote: (noteId: string) => Promise<void>
  onRemoveRepository: (repositoryId: string) => Promise<void>
  onRemoveKnowledge: (sourceId: string) => Promise<void>
  onRemoveTranscription: (sessionId: string) => Promise<void>
  onSaveKnowledge: (sourceId: string) => Promise<void>
  toolApproval?: import("@assistant-ui/react").ToolCallMessagePartProps | null
  voiceTranscript?: string
  voiceError?: string | null
  onVoiceErrorClear?: () => void
}) {
  const { t, locale } = useTranslations()

  const voiceControls = useVoiceControls()
  const voiceVolume = useVoiceVolume()
  const isThreadRunning = useAuiState((state) => state.thread.isRunning)
  const usage = useUsage(isThreadRunning)
  const composerAnchor = useRef<HTMLDivElement | null>(null)
  const hasThreadMessages = useAuiState(
    (state) => state.thread.messages.length > 0
  )
  const composerAui = useAui()
  const voiceState = useVoiceState()
  const voiceActive =
    voiceState?.status.type === "running" ||
    voiceState?.status.type === "starting"
  const awaitingFirstToken = useAuiState(
    (state) => state.thread.messages.at(-1)?.role === "user"
  )
  const composerAttachments = useAuiState((state) => state.composer.attachments)
  const composerText = useAuiState((state) => state.composer.text)
  // Resources picked with @ or / for this message. They show as chips in the
  // field and are sent with the message as directives, which the backend reads
  // for Storage references and MCP mentions.
  const [pendingRefs, setPendingRefs] = useState<ComposerRef[]>([])
  // MCPs mentioned in the draft are already visible as chips; only list the
  // attached ones that aren't, so the strip doesn't repeat the mention.
  const mentionedMcpIds = useMemo(
    () =>
      new Set(
        pendingRefs
          .filter((ref) => ref.type === "mcp")
          .map((ref) => ref.id.replace(/^mcp:/, ""))
      ),
    [pendingRefs]
  )
  // Files waiting in the composer already show as thumbnails, so their
  // message-scoped sources are left out of the strip until the message is sent.
  const pendingAttachmentNames = useMemo(
    () => new Set(composerAttachments.map((attachment) => attachment.name)),
    [composerAttachments]
  )
  const railContext = useMemo(() => {
    if (!mentionedMcpIds.size && !pendingAttachmentNames.size)
      return conversationContext
    return {
      ...conversationContext,
      mcpServers: conversationContext.mcpServers.filter(
        (server) => !mentionedMcpIds.has(server.id)
      ),
      knowledgeSources: conversationContext.knowledgeSources.filter(
        (source) =>
          !(
            source.contextScope === "message" &&
            pendingAttachmentNames.has(source.title)
          )
      ),
    }
  }, [mentionedMcpIds, pendingAttachmentNames, conversationContext])
  // Typing "/" at the start of the message searches Storage as you go.
  const storageQuery =
    composerText.startsWith("/") && !/\s/.test(composerText)
      ? composerText.slice(1)
      : null
  const [storageResult, setStorageResult] = useState<{
    query: string
    items: KnowledgeItem[]
  } | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  useEffect(() => {
    if (storageQuery === null) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setStorageLoading(true)
      setStorageError(null)
      const params = new URLSearchParams({
        limit: "100",
        q: storageQuery,
      })
      void Promise.all(
        ["source", "note", "transcript"].map((type) => {
          const query = new URLSearchParams(params)
          query.set("type", type)
          return api.get<{ items: KnowledgeItem[] }>(
            `/api/v1/knowledge/items?${query}`,
            { signal: controller.signal }
          )
        })
      )
        .then((results) => {
          if (!controller.signal.aborted)
            setStorageResult({
              query: storageQuery,
              items: results.flatMap((result) => result.items),
            })
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setStorageResult({ query: storageQuery, items: [] })
            setStorageError(
              "Storage files could not be loaded. Close and reopen / to retry."
            )
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setStorageLoading(false)
        })
    }, 150)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [storageQuery])
  const assistantSelectionLocked = assistantLocked || hasThreadMessages
  const hasAttachments = composerAttachments.length > 0
  const hasUnreadyAttachments = composerAttachments.some(
    (attachment) =>
      attachment.status.type === "running" ||
      attachment.status.type === "incomplete"
  )
  useEffect(() => {
    if (deepContext) onDeepContextChange(false)
  }, [deepContext, onDeepContextChange])

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
      .filter(
        (server) =>
          server.enabled &&
          (server.authType === "none" ||
            server.credentialConfigured ||
            attachedServerIds.has(server.id))
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((server) => {
        const attached = attachedServerIds.has(server.id)
        return {
          id: `mcp:${server.id}`,
          type: "mcp",
          label: server.name,
          description: attached
            ? server.enabled
              ? t("Already attached")
              : t("Attached · disabled")
            : server.credentialConfigured
              ? t("Add to this chat")
              : t("Needs setup"),
          metadata: {
            resourceId: server.id,
            attached,
          },
        }
      })
  }, [conversationContext.mcpServers, mcpServers, t])

  const noteItems = useMemo<Unstable_TriggerItem[]>(() => {
    const attachedNoteIds = new Set(
      (conversationContext.notes ?? []).map((note) => note.id)
    )
    const notesById = new Map<string, Note>()
    for (const note of notes) notesById.set(note.id, note)
    for (const note of conversationContext.notes ?? []) {
      if (!notesById.has(note.id)) notesById.set(note.id, note)
    }

    return Array.from(notesById.values())
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((note) => {
        const attached = attachedNoteIds.has(note.id)
        return {
          id: `note:${note.id}`,
          type: "note",
          label: note.title,
          description: attached ? t("Already attached") : t("Add to this chat"),
          metadata: {
            resourceId: note.id,
            attached,
          },
        }
      })
  }, [conversationContext.notes, notes, t])

  const contextItems = useMemo<Unstable_TriggerItem[]>(() => {
    const catalog =
      storageResult?.query === storageQuery ? storageResult.items : []
    const items: Unstable_TriggerItem[] = [
      ...storageReferenceItems(catalog),
      ...conversationContext.knowledgeSources.map((source) => ({
        id: `knowledge:${source.id}`,
        type: "knowledge",
        label: source.title,
        description: source.status,
        metadata: { resourceId: source.id },
      })),
      ...noteItems,
      ...conversationContext.transcriptionSessions.map((session) => ({
        id: `transcription:${session.id}`,
        type: "transcription",
        label: session.title,
        description: session.status,
        metadata: { resourceId: session.id },
      })),
    ]
    return Array.from(new Map(items.map((item) => [item.id, item])).values())
  }, [conversationContext, noteItems, storageResult, storageQuery])

  const [attachingMcpIds, setAttachingMcpIds] = useState<Set<string>>(new Set())
  const pendingMcpIds = useRef(new Set<string>())
  // MCPs attached by mentioning them in the unsent draft. Deleting the mention
  // before sending detaches them again; sending makes the attachment permanent.
  const draftMcpIds = useRef(new Set<string>())
  const mentionedDraftMcpIds = useRef(new Set<string>())
  const attachingMcpId = attachingMcpIds.values().next().value
  const [mcpAttachError, setMcpAttachError] = useState<string | null>(null)
  const [attachingNoteId, setAttachingNoteId] = useState<string | null>(null)
  const [noteAttachError, setNoteAttachError] = useState<string | null>(null)
  const attachingMcpName =
    mcpItems.find((item) => item.metadata?.resourceId === attachingMcpId)
      ?.label ?? t("MCP server")
  const attachMcpFromTrigger = useCallback(
    (item: Unstable_TriggerItem) => {
      if (item.type !== "mcp") return
      const resourceId = item.metadata?.resourceId
      if (
        typeof resourceId !== "string" ||
        item.metadata?.attached === true ||
        pendingMcpIds.current.has(resourceId)
      ) {
        return
      }
      setMcpAttachError(null)
      draftMcpIds.current.add(resourceId)
      pendingMcpIds.current.add(resourceId)
      setAttachingMcpIds(new Set(pendingMcpIds.current))
      void onAttachMCP(resourceId)
        .catch((error: unknown) => {
          const message =
            error instanceof APIError || error instanceof Error
              ? error.message
              : "The MCP server could not be added to this chat."
          setMcpAttachError(message)
        })
        .finally(() => {
          pendingMcpIds.current.delete(resourceId)
          setAttachingMcpIds(new Set(pendingMcpIds.current))
        })
    },
    [onAttachMCP]
  )
  useAuiEvent("composer.send", () => {
    draftMcpIds.current.clear()
    mentionedDraftMcpIds.current.clear()
  })
  useEffect(() => {
    for (const id of mentionedMcpIds) {
      if (draftMcpIds.current.has(id)) mentionedDraftMcpIds.current.add(id)
    }
    const removed = [...mentionedDraftMcpIds.current].filter(
      (id) => !mentionedMcpIds.has(id)
    )
    if (!removed.length || !onRemoveMCP) return
    // Sending clears the draft too; defer so the send event can win that race.
    const timer = setTimeout(() => {
      for (const id of removed) {
        if (!mentionedDraftMcpIds.current.delete(id)) continue
        draftMcpIds.current.delete(id)
        onRemoveMCP(id).catch((error: unknown) => {
          setMcpAttachError(
            error instanceof APIError || error instanceof Error
              ? error.message
              : "The MCP server could not be removed from this chat."
          )
        })
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [mentionedMcpIds, onRemoveMCP])
  const attachingNoteName =
    noteItems.find((item) => item.metadata?.resourceId === attachingNoteId)
      ?.label ?? "note"
  const attachNoteFromTrigger = useCallback(
    (item: Unstable_TriggerItem) => {
      if (item.type !== "note") return
      const resourceId = item.metadata?.resourceId
      if (typeof resourceId !== "string" || item.metadata?.attached === true) {
        return
      }
      setNoteAttachError(null)
      setAttachingNoteId(resourceId)
      void onAttachNote(resourceId)
        .catch((error: unknown) => {
          const message =
            error instanceof APIError || error instanceof Error
              ? error.message
              : "The note could not be added to this chat."
          setNoteAttachError(message)
        })
        .finally(() => {
          setAttachingNoteId((current) =>
            current === resourceId ? null : current
          )
        })
    },
    [onAttachNote]
  )
  const attachContextFromTrigger = useCallback(
    (item: Unstable_TriggerItem) => {
      if (item.type === "mcp") {
        attachMcpFromTrigger(item)
      } else if (item.type === "note") {
        attachNoteFromTrigger(item)
      }
    },
    [attachMcpFromTrigger, attachNoteFromTrigger]
  )

  const addRef = useCallback(
    (item: Unstable_TriggerItem) => {
      attachContextFromTrigger(item)
      setPendingRefs((current) =>
        current.some((ref) => ref.id === item.id)
          ? current
          : [...current, { id: item.id, type: item.type, label: item.label }]
      )
    },
    [attachContextFromTrigger]
  )

  // "@" at the start of the message lists MCP servers, "/" lists Storage files,
  // notes and transcription rooms. Prompt.Commands filters what is typed.
  const commandTrigger = composerText.startsWith("@") ? "@" : "/"
  const commandEntries = useMemo(
    () =>
      (commandTrigger === "@" ? mcpItems : contextItems).map((item, index) => ({
        item,
        command: {
          // Unique even when two titles match; only the label is searched.
          value: `${item.label}\u200b${index}`,
          label: item.label,
          description: item.description,
          icon:
            item.type === "mcp" ? (
              <Plug aria-hidden="true" />
            ) : item.type === "transcription" ? (
              <Mic aria-hidden="true" />
            ) : (
              <FileText aria-hidden="true" />
            ),
        } satisfies PromptCommandItem,
      })),
    [commandTrigger, mcpItems, contextItems]
  )
  const assistantLabel =
    assistants.find((assistant) => assistant.id === assistantId)?.name ??
    t("JustAI default")
  // Typing @ or / opens a list, which stays shut when there is nothing to list.
  const commandQuery =
    /^[@/]\S*$/.test(composerText) &&
    !(
      commandTrigger === "/" &&
      (storageLoading || storageResult?.query !== storageQuery)
    )
      ? composerText.slice(1).toLowerCase()
      : null
  const commandsEmpty =
    commandQuery !== null &&
    !commandEntries.some(({ command }) =>
      String(command.label).toLowerCase().includes(commandQuery)
    )
  const sendBlocked =
    hasUnreadyAttachments || attachingMcpIds.size > 0 || !!attachingNoteId
  const blockedSubmit = useRef(false)
  const submitMessage = () => {
    if (sendBlocked) {
      blockedSubmit.current = true
      return
    }
    const composer = composerAui.composer()
    const directives = pendingRefs
      .map((ref) => unstable_defaultDirectiveFormatter.serialize(ref))
      .join(" ")
    if (directives)
      composer.setText(
        [composerText.trim(), directives].filter(Boolean).join(" ")
      )
    composer.send()
    setPendingRefs([])
  }
  const hasContent =
    composerText.trim() !== "" ||
    composerAttachments.length > 0 ||
    pendingRefs.length > 0
  const canSubmit = !sendBlocked && hasContent
  const attachmentAccept = useAuiState(
    (state) => state.composer.attachmentAccept
  )

  // One band above the composer for whatever is being attached, or failed to.
  const emptyCommandsText = commandsEmpty
    ? commandTrigger === "@"
      ? commandEntries.length
        ? t("No configured MCP matches your search.")
        : t("No enabled MCP servers. Configure one to mention it here.")
      : commandEntries.length
        ? t("No matching Storage files.")
        : t("No Storage files, notes or transcriptions to reference yet.")
    : null
  const composerBanner: {
    text: string
    busy?: boolean
    error?: boolean
    onDismiss?: () => void
    onRetry?: () => void
  } | null = voiceError
    ? {
        text: `${t("Voice unavailable")}: ${t(voiceError)}`,
        error: true,
        onDismiss: onVoiceErrorClear,
        onRetry: () => {
          onVoiceErrorClear?.()
          voiceControls.connect()
        },
      }
    : attachingMcpId
      ? { text: `${t("Adding")} ${attachingMcpName}…`, busy: true }
      : mcpAttachError
        ? {
            text: t(mcpAttachError),
            error: true,
            onDismiss: () => setMcpAttachError(null),
          }
        : attachingNoteId
          ? { text: `${t("Adding")} ${attachingNoteName}…`, busy: true }
          : noteAttachError
            ? {
                text: t(noteAttachError),
                error: true,
                onDismiss: () => setNoteAttachError(null),
              }
            : storageQuery !== null && storageError
              ? { text: t(storageError), error: true }
              : emptyCommandsText
                ? { text: emptyCommandsText }
                : usageLimitReached(usage)
                  ? {
                      text: t(
                        "Monthly usage limit reached. Answers resume on {value0}.",
                        {
                          value0: new Intl.DateTimeFormat(locale, {
                            day: "numeric",
                            month: "long",
                            timeZone: "UTC",
                          }).format(new Date(usage!.periodEnd)),
                        }
                      ),
                      error: true,
                    }
                  : null

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-3xl px-3 pt-2 pb-3 sm:px-5 sm:pb-5",
        compact && "px-0 py-0"
      )}
    >
      <div className="relative">
        <div className="mx-auto w-[calc(100%-2rem)]" ref={composerAnchor}>
          <Prompt
            maxFiles={0}
            accept={attachmentAccept || undefined}
            value={composerText}
            onValueChange={(value) => {
              // Prompt clears the field after a send; a send that was held
              // back must keep what was typed.
              if (value === "" && blockedSubmit.current) {
                blockedSubmit.current = false
                return
              }
              blockedSubmit.current = false
              composerAui.composer().setText(value)
            }}
            onSubmit={submitMessage}
            // Files dropped on the card are handed to the composer, which
            // owns the attachments.
            onReject={(files) => {
              for (const file of files)
                void composerAui.composer().addAttachment(file)
            }}
          >
            <Prompt.Commands
              trigger={commandTrigger}
              items={commandEntries.map((entry) => entry.command)}
              label={
                <span className="inline-flex items-center gap-2">
                  {commandTrigger === "@"
                    ? t("MCP servers")
                    : t("Storage files")}
                  {commandTrigger === "/" && storageLoading && (
                    <Spinner size="sm" label={t("Loading")} />
                  )}
                  {commandTrigger === "/" && storageError && (
                    <span className="font-normal text-destructive">
                      {t(storageError)}
                    </span>
                  )}
                </span>
              }
              onSelect={(command) => {
                const entry = commandEntries.find(
                  (candidate) => candidate.command.value === command.value
                )
                if (entry) addRef(entry.item)
              }}
            />
            <Prompt.Banner
              open={Boolean(composerBanner)}
              className={cn(composerBanner?.error && "text-destructive")}
            >
              {composerBanner?.busy && (
                <Spinner size="sm" label={composerBanner.text} />
              )}
              <span
                role={composerBanner?.error ? "alert" : "status"}
                className="min-w-0 truncate"
              >
                {composerBanner?.text}
              </span>
              {composerBanner?.onDismiss && (
                <Prompt.BannerAction
                  type="button"
                  variant="outline"
                  onClick={composerBanner.onDismiss}
                >
                  {t("Dismiss")}
                </Prompt.BannerAction>
              )}
              {composerBanner?.onRetry && (
                <Prompt.BannerAction
                  className="ms-0"
                  onClick={composerBanner.onRetry}
                  type="button"
                >
                  {t("Try again")}
                </Prompt.BannerAction>
              )}
            </Prompt.Banner>
            <Prompt.Field>
              <ComposerPrimitive.Root asChild>
                <div
                  className={cn(
                    "composer-surface group/composer relative p-3",
                    compact && "flex flex-wrap items-center gap-2"
                  )}
                  data-running={isThreadRunning}
                  data-seasonal-composer={compact ? "" : undefined}
                >
                  <ComposerPrimitive.Quote className="mx-2 mb-1 flex items-center gap-2 rounded-xl bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <Quote className="size-3.5 shrink-0" aria-hidden="true" />
                    <ComposerPrimitive.QuoteText className="min-w-0 flex-1 truncate" />
                    <ComposerPrimitive.QuoteDismiss
                      aria-label={t("Remove quote")}
                      className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </ComposerPrimitive.QuoteDismiss>
                  </ComposerPrimitive.Quote>
                  <ComposerPrimitive.Queue>
                    {() => (
                      <div className="mx-2 mb-1 flex items-center gap-2 rounded-xl bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                        <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
                        <QueueItemPrimitive.Steer className="rounded px-1.5 py-0.5 text-[11px] hover:bg-muted hover:text-foreground">
                          {t("Send now")}
                        </QueueItemPrimitive.Steer>
                        <QueueItemPrimitive.Remove
                          aria-label={t("Remove queued message")}
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
                  {voiceActive ? (
                    <>
                      <Prompt.Recorder
                        cancelLabel={t("End voice")}
                        className={cn(compact && "order-1 basis-full")}
                        doneLabel={t("End voice")}
                        level={voiceState?.isMuted ? 0 : voiceVolume}
                        onCancel={voiceControls.disconnect}
                        onDone={voiceControls.disconnect}
                        placeholder={
                          voiceState?.status.type === "starting"
                            ? t("Connecting to voice")
                            : voiceState?.isMuted
                              ? t("Voice muted")
                              : t("Listening")
                        }
                        transcript={voiceTranscript || undefined}
                      />
                      <div className="flex justify-end px-1 pt-1">
                        <Prompt.Tool
                          label={
                            voiceState?.isMuted
                              ? t("Unmute voice")
                              : t("Mute voice")
                          }
                          onPressedChange={() =>
                            voiceState?.isMuted
                              ? voiceControls.unmute()
                              : voiceControls.mute()
                          }
                          pressed={voiceState?.isMuted === true}
                        >
                          <MicOff aria-hidden="true" />
                        </Prompt.Tool>
                      </div>
                      <VoiceToolApproval toolApproval={toolApproval} />
                    </>
                  ) : (
                    <>
                      {pendingRefs.length > 0 && (
                        <div
                          className={cn(
                            "flex w-full flex-wrap gap-1.5 px-1.5 pt-1",
                            compact && "order-1 basis-full"
                          )}
                        >
                          {pendingRefs.map((ref) => (
                            <span
                              className={cn(
                                "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium",
                                ref.type === "mcp"
                                  ? "bg-blue-500/10 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300"
                                  : "bg-muted text-foreground"
                              )}
                              key={ref.id}
                            >
                              <span className="truncate">
                                {ref.type === "mcp" ? "@" : "/"}
                                {ref.label}
                              </span>
                              <button
                                aria-label={t(
                                  "Remove {value0} from this chat",
                                  {
                                    value0: ref.label,
                                  }
                                )}
                                className="shrink-0 rounded-full p-0.5 opacity-70 hover:opacity-100"
                                onClick={() =>
                                  setPendingRefs((current) =>
                                    current.filter(
                                      (candidate) => candidate.id !== ref.id
                                    )
                                  )
                                }
                                type="button"
                              >
                                <X className="size-3" aria-hidden="true" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <Prompt.Textarea
                        aria-label={t("Message")}
                        className={cn(
                          "px-1.5 py-3 text-sm leading-6",
                          compact && "order-1 min-w-0 basis-full"
                        )}
                        minRows={1}
                        maxRows={6}
                        onKeyDown={(event) => {
                          // Enter sends a message that has files or mentions
                          // but no text, which Prompt itself would not.
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing &&
                            composerText.trim() === "" &&
                            (composerAttachments.length > 0 ||
                              pendingRefs.length > 0)
                          ) {
                            event.preventDefault()
                            submitMessage()
                          }
                        }}
                        placeholder={t("Let's turn your ideas into a plan.")}
                      />
                      <Prompt.Footer
                        className={cn(
                          "items-center gap-2 p-0 px-1",
                          compact && "contents"
                        )}
                      >
                        <Prompt.Tools
                          className={cn(
                            "flex-nowrap gap-1 py-0",
                            compact && "order-2"
                          )}
                        >
                          <Prompt.Menu label={t("Attach a file")}>
                            <Prompt.AttachItem shortcut={null}>
                              {t("Add files")}
                            </Prompt.AttachItem>
                            <Menu.Separator />
                            <Menu.Sub>
                              <Menu.SubTrigger
                                disabled={assistantSelectionLocked}
                                end={
                                  <span className="max-w-32 truncate text-xs text-muted-foreground">
                                    {assistantSelectionLocked
                                      ? t("Locked after the first message")
                                      : assistantLabel}
                                  </span>
                                }
                              >
                                <Bot aria-hidden="true" />
                                {t("Agent")}
                              </Menu.SubTrigger>
                              <Menu.SubContent>
                                <Menu.RadioGroup
                                  onValueChange={(value) =>
                                    onAssistantChange(String(value))
                                  }
                                  value={assistantId}
                                >
                                  <Menu.RadioItem value="">
                                    {t("JustAI default")}
                                  </Menu.RadioItem>
                                  {assistants.map((assistant) => (
                                    <Menu.RadioItem
                                      key={assistant.id}
                                      value={assistant.id}
                                    >
                                      {assistant.name}
                                    </Menu.RadioItem>
                                  ))}
                                </Menu.RadioGroup>
                              </Menu.SubContent>
                            </Menu.Sub>
                          </Prompt.Menu>
                          <Prompt.Tool
                            label={t("Search Storage")}
                            pressed={searchStorage}
                            onPressedChange={onSearchStorageChange}
                            showLabel={!compact}
                            className={cn(
                              "h-8 text-xs",
                              searchStorage && "bg-primary/10 text-primary"
                            )}
                            title={t(
                              "Search workspace Storage for this conversation. Files and / references still work when this is off."
                            )}
                          >
                            <Database className="size-4" aria-hidden="true" />
                          </Prompt.Tool>
                          {onOpenHistory && (
                            <Button
                              aria-label={t("Open conversation history")}
                              className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden"
                              onClick={onOpenHistory}
                              size="icon-sm"
                              type="button"
                              variant="ghost"
                            >
                              <History className="size-4" />
                            </Button>
                          )}
                          {assistantId && (
                            <Prompt.Tool
                              disabled={assistantSelectionLocked}
                              label={assistantLabel}
                              onPressedChange={() => onAssistantChange("")}
                              pressed
                              showLabel
                              title={
                                assistantSelectionLocked
                                  ? t("Locked after the first message")
                                  : t("Remove {value0} from this chat", {
                                      value0: assistantLabel,
                                    })
                              }
                            >
                              <Bot aria-hidden="true" />
                            </Prompt.Tool>
                          )}
                        </Prompt.Tools>
                        <div
                          className={cn(
                            "order-3 flex shrink-0 items-center gap-1",
                            compact &&
                              "ml-auto max-w-full min-w-0 flex-wrap justify-end"
                          )}
                        >
                          <ModelEndpointPicker
                            endpoints={endpoints}
                            endpointId={endpointId}
                            modelsByEndpoint={modelsByEndpoint}
                            modelId={modelId}
                            modelDiscoveryLoading={modelDiscoveryLoading}
                            modelDiscoveryFailed={modelDiscoveryFailed}
                            onRetryModelDiscovery={onRetryModelDiscovery}
                            onSelect={onModelSelect}
                            compact={compact}
                          />
                          <UsageIndicator usage={usage} />

                          {isThreadRunning ? (
                            <ComposerPrimitive.Cancel
                              aria-label={t("Cancel response")}
                              className="flex size-8 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80"
                            >
                              <RotateCcw className="size-4" />
                            </ComposerPrimitive.Cancel>
                          ) : (
                            // One button: the microphone while there is nothing to send, the
                            // arrow as soon as there is.
                            <button
                              aria-label={
                                hasContent
                                  ? t("Send message")
                                  : t("Start voice")
                              }
                              className="flex size-8 items-center justify-center rounded-full bg-[var(--composer-accent)] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                              disabled={hasContent && !canSubmit}
                              onClick={
                                hasContent
                                  ? submitMessage
                                  : voiceControls.connect
                              }
                              type="button"
                            >
                              {hasContent ? (
                                <ArrowUp className="size-4" />
                              ) : (
                                <AudioLines className="size-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </Prompt.Footer>
                    </>
                  )}
                </div>
              </ComposerPrimitive.Root>
            </Prompt.Field>
            <Prompt.Status open={isThreadRunning && !voiceActive}>
              {awaitingFirstToken
                ? t("Waiting for the model…")
                : t("Writing the answer…")}
            </Prompt.Status>
            <ContextDisplay
              context={railContext}
              onRemoveMCP={onRemoveMCP}
              onRemoveNote={onRemoveNote}
              onRemoveRepository={onRemoveRepository}
              onRemoveKnowledge={onRemoveKnowledge}
              onRemoveTranscription={onRemoveTranscription}
              onSaveKnowledge={onSaveKnowledge}
            />
            <Prompt.Hint
              className={cn(
                "text-center",
                compact ? "pt-1 text-[10px]" : "pt-2 text-[11px]"
              )}
            >
              {t("Start with")} <kbd>@</kbd> {t("to mention MCPs, or")}{" "}
              <kbd>/</kbd> {t("for Storage and context.")}
            </Prompt.Hint>
          </Prompt>
        </div>
      </div>
    </div>
  )
}

type AssistantThreadLayoutProps = {
  displayName?: string
  composerProps: Parameters<typeof Composer>[0]
  voiceError?: string | null
  onVoiceErrorClear?: () => void
}

function AssistantThreadLayout({
  displayName,
  composerProps,
  voiceError,
  onVoiceErrorClear,
}: AssistantThreadLayoutProps) {
  const { t } = useTranslations()

  const isEmpty = useAuiState((state) => state.thread.messages.length === 0)
  const latestAssistantMessageId = useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index -= 1) {
      const message = state.thread.messages[index]
      if (message?.role === "assistant") return message.id
    }
    return null
  })
  const composer = (
    <Composer
      {...composerProps}
      compact={isEmpty}
      onVoiceErrorClear={onVoiceErrorClear}
      voiceError={voiceError}
    />
  )

  return (
    <MCPApprovalProvider>
      <ThreadPrimitive.Root
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden",
          !isEmpty && "bg-background"
        )}
      >
        {isEmpty && <ChatBackdrop />}
        <SelectionToolbarPrimitive.Root className="z-50 flex items-center gap-1 rounded-lg border bg-background/95 p-1 text-xs text-foreground shadow-lg backdrop-blur">
          <SelectionToolbarPrimitive.Quote className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted">
            <Quote className="size-3.5" aria-hidden="true" />
            {t("Quote")}
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
            <EmptyThread displayName={displayName}>
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
                      <AssistantMessage
                        isLatest={message.id === latestAssistantMessageId}
                      />
                    )
                  }}
                </ThreadPrimitive.Messages>
              </div>
            )}
          </div>
          {!isEmpty && (
            <ThreadPrimitive.ViewportFooter className="relative sticky bottom-0 z-20 shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent pt-5 backdrop-blur supports-[backdrop-filter]:bg-background/75">
              <ScrollToLatest />
              <div className="flex flex-col">
                <MCPApprovalCards />
                {composer}
              </div>
            </ThreadPrimitive.ViewportFooter>
          )}
        </ThreadPrimitive.Viewport>
        <ConversationRail />
      </ThreadPrimitive.Root>
    </MCPApprovalProvider>
  )
}

function AssistantChatSurface({
  displayName,
  conversationId,
  cacheScope,
  conversationAssistantId,
  conversationEndpointId,
  conversationChatModel,
  initialMessages,
  assistants,
  endpoints,
  mcpServers,
  notes,
  activeEndpoint,
  onEnsureConversation,
  onAttachMCP,
  onRemoveMCP,
  onAttachNote,
  onRemoveNote,
  onRemoveRepository,
  onRemoveKnowledge,
  onRemoveTranscription,
  onSaveKnowledge,
  onUpload,
  onRemoveUpload,
  onConversationCreated,
  onConversationUpdated,
  onConversationSettled,
  onOpenHistory,
  onAssistantSelectionChange,
  conversationContext,
}: {
  displayName?: string
  conversationId: string | null
  cacheScope: string
  conversationAssistantId?: string | null
  conversationEndpointId?: string | null
  conversationChatModel?: string
  initialMessages: UIMessage[]
  assistants: SavedAssistant[]
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  notes: Note[]
  activeEndpoint?: Endpoint
  onEnsureConversation: (options?: EnsureConversationOptions) => Promise<string>
  onAttachMCP: (serverId: string) => Promise<void>
  onRemoveMCP: (serverId: string) => Promise<void>
  onAttachNote: (noteId: string) => Promise<void>
  onRemoveNote: (noteId: string) => Promise<void>
  onRemoveRepository: (repositoryId: string) => Promise<void>
  onRemoveKnowledge: (sourceId: string) => Promise<void>
  onRemoveTranscription: (sessionId: string) => Promise<void>
  onSaveKnowledge: (sourceId: string) => Promise<void>
  onUpload: (file: File) => Promise<UploadedConversationAttachment>
  onRemoveUpload: (sourceId: string) => Promise<void>
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onConversationSettled?: () => void
  onOpenHistory?: () => void
  onAssistantSelectionChange?: (assistantId: string | null) => void
  conversationContext: ConversationContext
}) {
  const { t } = useTranslations()

  const initialAssistant = assistants.find(
    (assistant) => assistant.id === conversationAssistantId
  )
  const initialAssistantModelEndpointId =
    conversationEndpointId ?? initialAssistant?.endpointId ?? activeEndpoint?.id
  const [selectedAssistantId, setSelectedAssistantId] = useState(
    conversationAssistantId ?? ""
  )
  const [endpointId, setEndpointId] = useState(
    conversationEndpointId ??
      initialAssistant?.endpointId ??
      activeEndpoint?.id ??
      ""
  )
  const [modelsByEndpoint, setModelsByEndpoint] = useState<
    Record<string, DiscoveredChatModel[]>
  >(() =>
    initialAssistantModelEndpointId &&
    (conversationChatModel || initialAssistant?.model)
      ? {
          [initialAssistantModelEndpointId]: [
            { id: conversationChatModel || initialAssistant?.model || "" },
          ],
        }
      : {}
  )
  const [modelDiscoveryStatus, setModelDiscoveryStatus] = useState<
    Record<string, "ok" | "failed" | "retry">
  >({})
  const discoveryAttempts = useRef<Record<string, number>>({})
  const discoveryRetryTimers = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({})
  const [modelByEndpoint, setModelByEndpoint] = useState<
    Record<string, string>
  >(() =>
    initialAssistantModelEndpointId &&
    (conversationChatModel || initialAssistant?.model)
      ? {
          [initialAssistantModelEndpointId]:
            conversationChatModel || initialAssistant?.model || "",
        }
      : {}
  )
  const [voiceApproval, setVoiceApproval] = useState<
    import("@assistant-ui/react").ToolCallMessagePartProps | null
  >(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState("")
  const [searchStorage, setSearchStorage] = useState(false)
  const [deepContext, setDeepContext] = useState(
    initialAssistant?.deepContext ?? false
  )
  const selectedAssistant = assistants.find(
    (assistant) => assistant.id === selectedAssistantId
  )
  // Creating a conversation is also required to upload a file. Keep the
  // assistant selectable until the first message is sent.
  const assistantLocked = Boolean(initialMessages.length > 0)

  const applyAssistant = useCallback(
    (id: string) => {
      if (assistantLocked) return
      const assistant = assistants.find((item) => item.id === id)
      const nextEndpointId =
        assistant?.endpointId &&
        endpoints.some((item) => item.id === assistant.endpointId)
          ? assistant.endpointId
          : (activeEndpoint?.id ?? "")

      setSelectedAssistantId(id)
      onAssistantSelectionChange?.(id || null)
      setEndpointId(nextEndpointId)
      setDeepContext(assistant?.deepContext ?? false)
      const assistantModel = assistant?.model
      if (assistantModel && nextEndpointId) {
        setModelByEndpoint((current) => ({
          ...current,
          [nextEndpointId]: assistantModel,
        }))
      }
    },
    [
      activeEndpoint?.id,
      assistants,
      assistantLocked,
      endpoints,
      onAssistantSelectionChange,
    ]
  )

  const ensureSelectedConversation = useCallback(
    (options: EnsureConversationOptions = {}) =>
      onEnsureConversation({
        ...options,
        assistantId: selectedAssistantId || null,
      }),
    [onEnsureConversation, selectedAssistantId]
  )

  const selectedEndpointId =
    endpointId && endpoints.some((item) => item.id === endpointId)
      ? endpointId
      : activeEndpoint?.id || ""
  const endpoint =
    endpoints.find((item) => item.id === selectedEndpointId) ?? activeEndpoint
  const selectedModel =
    modelByEndpoint[selectedEndpointId] ?? endpoint?.chatModel ?? ""
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

  // "ok" = the endpoint's model list was really fetched. A seeded or fallback
  // list (saved conversation model, configured model) never counts as fetched,
  // so it is replaced as soon as discovery succeeds and discovery is retried
  // with backoff after a failure instead of staying on the fallback forever.
  const retryModelDiscovery = useCallback(() => {
    if (!selectedEndpointId) return
    setModelDiscoveryStatus((current) =>
      current[selectedEndpointId] === "ok"
        ? current
        : { ...current, [selectedEndpointId]: "retry" }
    )
  }, [selectedEndpointId])

  useEffect(() => {
    const retryTimers = discoveryRetryTimers.current
    return () => {
      for (const timer of Object.values(retryTimers)) clearTimeout(timer)
    }
  }, [])

  const discoveryStatus = modelDiscoveryStatus[selectedEndpointId]
  useEffect(() => {
    if (
      !selectedEndpointId ||
      discoveryStatus === "ok" ||
      discoveryStatus === "failed"
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
        discoveryAttempts.current[selectedEndpointId] = 0
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
        setModelDiscoveryStatus((current) => ({
          ...current,
          [selectedEndpointId]: "ok",
        }))
      })
      .catch(() => {
        if (cancelled) return
        // Discovery is best effort. A manually configured endpoint remains
        // usable with its configured model, and discovery keeps retrying.
        setModelsByEndpoint((current) => ({
          ...current,
          [selectedEndpointId]:
            current[selectedEndpointId] ??
            (endpoint?.chatModel ? [{ id: endpoint.chatModel }] : []),
        }))
        setModelByEndpoint((current) => ({
          ...current,
          [selectedEndpointId]:
            current[selectedEndpointId] ?? endpoint?.chatModel ?? "",
        }))
        setModelDiscoveryStatus((current) => ({
          ...current,
          [selectedEndpointId]: "failed",
        }))
        const attempt = discoveryAttempts.current[selectedEndpointId] ?? 0
        discoveryAttempts.current[selectedEndpointId] = attempt + 1
        clearTimeout(discoveryRetryTimers.current[selectedEndpointId])
        discoveryRetryTimers.current[selectedEndpointId] = setTimeout(
          () =>
            setModelDiscoveryStatus((current) =>
              current[selectedEndpointId] === "failed"
                ? { ...current, [selectedEndpointId]: "retry" }
                : current
            ),
          Math.min(2000 * 2 ** attempt, 30000)
        )
      })
    return () => {
      cancelled = true
    }
  }, [endpoint?.chatModel, discoveryStatus, selectedEndpointId])

  // The model picker lists every endpoint's models, so fetch the ones the
  // selected endpoint's discovery does not cover. Best effort: a failure here
  // is retried by the normal discovery when that endpoint gets selected.
  const prefetchedEndpoints = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    for (const item of endpoints) {
      if (item.id === selectedEndpointId) continue
      if (prefetchedEndpoints.current.has(item.id)) continue
      prefetchedEndpoints.current.add(item.id)
      // Not cancelled when the dependencies change: the request is per
      // endpoint and its result is valid whichever endpoint is selected.
      void api
        .get<{ models?: DiscoveredChatModel[] }>(
          `/api/v1/endpoints/${item.id}/models`
        )
        .then((result) => {
          if (!mounted.current) return
          const models = (result.models ?? []).filter((model) =>
            model.id?.trim()
          )
          setModelsByEndpoint((current) => ({ ...current, [item.id]: models }))
        })
        .catch(() => {
          if (!mounted.current) return
          prefetchedEndpoints.current.delete(item.id)
          // Stop the loading hint; selecting the endpoint retries discovery.
          setModelsByEndpoint((current) =>
            current[item.id] === undefined
              ? { ...current, [item.id]: [] }
              : current
          )
        })
    }
  }, [endpoints, selectedEndpointId])

  const resumableStorage = useMemo(
    () =>
      createResumableSessionStorage({
        // A newly-created conversation uses a temporary key until the route
        // catches up; existing conversations are always isolated by id.
        key: `justai:resumable:${cacheScope}:${conversationId ?? "new"}`,
      }),
    [cacheScope, conversationId]
  )
  const contextPolicy = chatContextLabel(conversationContext, false, "")
    ? "selected-only"
    : searchStorage
      ? "automatic"
      : "none"
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
          assistantId: selectedAssistantId || undefined,
          agentId: selectedAssistantId || undefined,
          endpointId: selectedEndpointId,
          model: selectedModel,
          useMemory: selectedAssistant?.useMemory ?? true,
          deepContext,
          searchStorage,
          contextPolicy,
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
          const id = await ensureSelectedConversation()
          const requestMessages = Array.isArray(messages)
            ? await normalizeOutgoingImageMessages(messages)
            : []
          const requestId = chatRequestId(requestMessages)
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
              assistantId: selectedAssistantId || undefined,
              agentId: selectedAssistantId || undefined,
              endpointId: selectedEndpointId,
              model: selectedModel,
              useMemory: selectedAssistant?.useMemory ?? true,
              deepContext,
              searchStorage,
              contextPolicy,
              requestId,
            },
          }
        },
      }),
    [
      ensureSelectedConversation,
      deepContext,
      searchStorage,
      contextPolicy,
      resumableStorage,
      selectedAssistant?.useMemory,
      selectedAssistantId,
      selectedEndpointId,
      selectedModel,
    ]
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
        onTranscript: (item) => setVoiceTranscript(item.text),
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
    () => createHistoryAdapter(conversationId, ensureSelectedConversation),
    [conversationId, ensureSelectedConversation]
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
      // SSE stream, worklet, and tracks cannot outlive the thread runtime.
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
          <div className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("This MCP app is unavailable.")}
          </div>
        ),
      }),
    [mcpAppHost, t]
  )
  const assistantConfig = useMemo(
    () => AuiConfig({ tools: Tools({ mcpApp: mcpAppRenderer }) }),
    [mcpAppRenderer]
  )

  return (
    <AssistantRuntimeProvider runtime={runtime} config={assistantConfig}>
      <AssistantThreadLayout
        displayName={displayName}
        composerProps={{
          assistants,
          assistantId: selectedAssistantId,
          assistantLocked,
          onAssistantChange: applyAssistant,
          conversationContext,
          mcpServers,
          notes,
          endpointId: selectedEndpointId,
          endpoints,
          modelsByEndpoint,
          modelDiscoveryLoading,
          modelDiscoveryFailed:
            modelDiscoveryStatus[selectedEndpointId] === "failed",
          onRetryModelDiscovery: retryModelDiscovery,
          modelId: selectedModel,
          deepContext,
          onDeepContextChange: setDeepContext,
          searchStorage,
          onSearchStorageChange: setSearchStorage,
          onModelSelect: (nextEndpointId, model) => {
            setEndpointId(nextEndpointId)
            setModelByEndpoint((current) => ({
              ...current,
              [nextEndpointId]: model,
            }))
          },
          onOpenHistory,
          onAttachMCP,
          onRemoveMCP,
          onAttachNote,
          onRemoveNote,
          onRemoveRepository,
          onRemoveKnowledge,
          onRemoveTranscription,
          onSaveKnowledge,
          toolApproval: voiceApproval,
          voiceTranscript,
        }}
        onVoiceErrorClear={() => setVoiceError(null)}
        voiceError={voiceError}
      />
    </AssistantRuntimeProvider>
  )
}

export function ChatView({
  displayName,
  conversationId,
  cacheScope,
  conversation,
  assistants,
  endpoints,
  mcpServers,
  notes,
  onConversationCreated,
  onConversationUpdated,
  onConversationSettled,
  onAssistantSelectionChange,
  onConversationMissing,
  onEnsureConversation,
  onOpenHistory,
}: Props) {
  const { t } = useTranslations()

  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(conversationId)
  const [surfaceKey, setSurfaceKey] = useState(
    conversationId
      ? `loading:${cacheScope}:${conversationId}`
      : `new:${cacheScope}`
  )
  const [surfaceReady, setSurfaceReady] = useState(!conversationId)
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(Boolean(conversationId))
  const [historyError, setHistoryError] = useState("")
  const [historyRetryToken, setHistoryRetryToken] = useState(0)
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
  const selectedAssistantIdRef = useRef<string | null>(
    conversation?.assistantId ?? null
  )

  const handleAssistantSelectionChange = useCallback(
    (assistantId: string | null) => {
      selectedAssistantIdRef.current = assistantId
      onAssistantSelectionChange?.(assistantId)
    },
    [onAssistantSelectionChange]
  )

  useEffect(() => {
    activeConversationRef.current = conversationId
    routeConversationIdRef.current = conversationId
    selectedAssistantIdRef.current = conversation?.assistantId ?? null
    onAssistantSelectionChange?.(conversation?.assistantId ?? null)
    onEnsureConversationRef.current = onEnsureConversation
    onConversationMissingRef.current = onConversationMissing
    onConversationCreatedRef.current = onConversationCreated
    onConversationUpdatedRef.current = onConversationUpdated
  }, [
    cacheScope,
    conversationId,
    conversation?.assistantId,
    onConversationCreated,
    onConversationMissing,
    onConversationUpdated,
    onAssistantSelectionChange,
    onEnsureConversation,
  ])

  const activeChatEndpoints = endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.capabilities?.chat
  )
  const activeEndpoint =
    activeChatEndpoints.find(
      (endpoint) => endpoint.id === conversation?.endpointId
    ) ??
    activeChatEndpoints.find((endpoint) => endpoint.isDefault) ??
    activeChatEndpoints[0]

  const loadConversation = useCallback(
    async (
      id: string | null,
      signal?: AbortSignal
    ): Promise<LoadedConversation | null> => {
      if (!id) return { messages: [], context: EMPTY_CONTEXT }
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
        if (signal?.aborted) return null
        let messages: UIMessage[] = []
        let context = EMPTY_CONTEXT
        if (historyResult.status === "fulfilled") {
          messages = normalizeHistory(historyResult.value)
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
          return null
        } else {
          throw historyResult.reason instanceof Error
            ? historyResult.reason
            : new Error("Conversation history could not be loaded.")
        }
        if (contextResult.status === "fulfilled") {
          context = contextResult.value
        } else {
          console.error(
            "Assistant UI conversation context could not be loaded",
            contextResult.reason
          )
        }
        return { messages, context }
      } catch (caught) {
        if (!signal?.aborted) {
          throw caught instanceof Error
            ? caught
            : new Error("Conversation history could not be loaded.")
        }
        return null
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
    // and terminate an otherwise healthy voice stream.
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
      setSurfaceReady(true)
      return
    }
    activeConversationRef.current = conversationId

    if (!conversationId) {
      const controller = new AbortController()
      queueMicrotask(() => {
        if (controller.signal.aborted) return
        setInitialMessages([])
        setConversationContext(EMPTY_CONTEXT)
        setActiveConversationId(null)
        setSurfaceKey(`new:${cacheScope}`)
        setSurfaceReady(true)
        setHistoryLoading(false)
        setHistoryError("")
      })
      return () => controller.abort()
    }

    const cached = readCachedConversation(cacheScope, conversationId)
    if (cached) {
      queueMicrotask(() => {
        setInitialMessages(cached.messages)
        setConversationContext(cached.context)
        setActiveConversationId(conversationId)
        setSurfaceKey(`${cacheScope}:${conversationId}`)
        setSurfaceReady(true)
        setHistoryLoading(false)
        setHistoryError("")
      })
      return
    }

    const controller = new AbortController()
    queueMicrotask(() => {
      if (controller.signal.aborted) return
      setHistoryLoading(true)
      setHistoryError("")
      setSurfaceReady(false)
      void loadConversationRef
        .current(conversationId, controller.signal)
        .then((loaded) => {
          if (controller.signal.aborted || !loaded) return
          cacheConversation(cacheScope, conversationId, loaded)
          setInitialMessages(loaded.messages)
          setConversationContext(loaded.context)
          setActiveConversationId(conversationId)
          setSurfaceKey(`${cacheScope}:${conversationId}`)
          setSurfaceReady(true)
          setHistoryLoading(false)
        })
        .catch((caught) => {
          if (controller.signal.aborted) return
          setHistoryLoading(false)
          setSurfaceReady(false)
          setHistoryError(
            caught instanceof Error
              ? caught.message
              : "Conversation history could not be loaded."
          )
        })
    })
    return () => controller.abort()
  }, [cacheScope, conversationId, historyRetryToken])

  useEffect(() => {
    if (!conversationId) return
    let disposed = false
    let timer: number | null = null
    let delay = 5000
    let controller: AbortController | null = null
    const schedule = () => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), delay)
    }
    const refresh = async () => {
      if (disposed || document.visibilityState === "hidden") {
        schedule()
        return
      }
      controller?.abort()
      controller = new AbortController()
      try {
        const context = await api.get<ConversationContext>(
          `/api/v1/conversations/${conversationId}/context`,
          { signal: controller.signal }
        )
        if (!disposed) {
          setConversationContext(context)
          delay = 5000
        }
      } catch {
        if (!disposed) delay = Math.min(delay * 2, 30_000)
      } finally {
        schedule()
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        delay = 5000
        void refresh()
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    schedule()
    return () => {
      disposed = true
      controller?.abort()
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [conversationId])

  const ensureLocalConversation = useCallback(
    async ({
      assistantId,
      inheritRepositories,
    }: EnsureConversationOptions = {}) => {
      if (activeConversationRef.current) return activeConversationRef.current
      if (conversationCreationRef.current)
        return conversationCreationRef.current

      const creation = api
        .post<{ conversation: Conversation }>("/api/v1/conversations", {
          assistantId: assistantId || undefined,
          inheritRepositories: inheritRepositories === true,
        })
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
    },
    []
  )

  const ensureConversation = useCallback(
    async ({
      activate = true,
      assistantId,
      inheritRepositories,
    }: EnsureConversationOptions = {}) => {
      const resolvedAssistantId =
        assistantId !== undefined ? assistantId : selectedAssistantIdRef.current
      const creatingFromRoot = routeConversationIdRef.current === null
      if (creatingFromRoot) pendingConversationRef.current = true
      try {
        const id = await (onEnsureConversationRef.current?.({
          activate,
          assistantId: resolvedAssistantId,
          inheritRepositories,
        }) ??
          ensureLocalConversation({
            assistantId: resolvedAssistantId,
            inheritRepositories,
          }))
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

  const refreshConversationContext = useCallback(
    async (id: string) => {
      const context = await api.get<ConversationContext>(
        `/api/v1/conversations/${id}/context`
      )
      invalidateConversationCache(cacheScope, id)
      setConversationContext(context)
      onConversationUpdatedRef.current?.()
    },
    [cacheScope]
  )

  const removeRepository = useCallback(
    async (repositoryId: string) => {
      const id = activeConversationRef.current
      if (!id) return
      await api.delete(
        `/api/v1/conversations/${id}/context/repositories/${repositoryId}`
      )
      await refreshConversationContext(id)
    },
    [refreshConversationContext]
  )

  const removeTranscription = useCallback(
    async (sessionId: string) => {
      const id = activeConversationRef.current
      if (!id) return
      await api.delete(
        `/api/v1/conversations/${id}/context/transcription/${sessionId}`
      )
      await refreshConversationContext(id)
    },
    [refreshConversationContext]
  )

  const saveKnowledgeSource = useCallback(
    async (sourceId: string) => {
      const id = activeConversationRef.current
      if (!id) return
      await api.patch(
        `/api/v1/conversations/${id}/context/knowledge/${sourceId}`,
        { contextScope: "persistent" }
      )
      await refreshConversationContext(id)
    },
    [refreshConversationContext]
  )

  const attachMCPServer = useCallback(
    async (serverId: string) => {
      const id = await ensureConversation({ activate: false })
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

  const attachNote = useCallback(
    async (noteId: string) => {
      const id = await ensureConversation({ activate: false })
      await api.post(`/api/v1/conversations/${id}/context/notes/${noteId}`)
      await refreshConversationContext(id)
    },
    [ensureConversation, refreshConversationContext]
  )

  const removeNote = useCallback(
    async (noteId: string) => {
      const id = activeConversationRef.current
      if (!id) return
      await api.delete(`/api/v1/conversations/${id}/context/notes/${noteId}`)
      await refreshConversationContext(id)
    },
    [refreshConversationContext]
  )

  const waitForKnowledgeSource = useCallback(
    async (
      id: string,
      sourceId: string,
      signal?: AbortSignal,
      onProgress?: (progress: number) => void
    ): Promise<KnowledgeSource> => {
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (signal?.aborted)
          throw new Error("The attachment upload was cancelled.")
        const context = await api.get<ConversationContext>(
          `/api/v1/conversations/${id}/context`,
          { signal }
        )
        onProgress?.(Math.min(99, 20 + ((attempt + 1) / 90) * 80))
        setConversationContext(context)
        onConversationUpdatedRef.current?.()
        const source = context.knowledgeSources.find(
          (item) => item.id === sourceId
        )
        if (!source) {
          throw new Error("The imported source disappeared from this chat.")
        }
        if (source.status === "ready") {
          onProgress?.(100)
          return source
        }
        if (source.status === "failed") {
          throw new Error(
            source.error || "The source could not be indexed for this chat."
          )
        }
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, 750)
          signal?.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timer)
              reject(new Error("The attachment upload was cancelled."))
            },
            { once: true }
          )
        })
      }
      throw new Error("The source took too long to become ready. Try it again.")
    },
    []
  )

  const uploadFile = useCallback(
    async (
      file: File,
      onProgress?: (progress: number) => void,
      signal?: AbortSignal
    ): Promise<UploadedConversationAttachment> => {
      const id = await ensureConversation({
        activate: false,
        inheritRepositories: false,
      })
      invalidateConversationCache(cacheScope, id)
      const body = new FormData()
      body.append("file", file)
      const source = await api.upload<KnowledgeSource>(
        `/api/v1/conversations/${id}/attachments`,
        body
      )

      try {
        return {
          source: await waitForKnowledgeSource(
            id,
            source.id,
            signal,
            onProgress
          ),
        }
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
    [
      cacheScope,
      ensureConversation,
      refreshConversationContext,
      waitForKnowledgeSource,
    ]
  )

  const removeUploadedFile = useCallback(
    async (sourceId: string) => {
      const id = activeConversationRef.current
      if (!id) return
      await api.delete(
        `/api/v1/conversations/${id}/context/knowledge/${sourceId}`
      )
      const context = await api.get<ConversationContext>(
        `/api/v1/conversations/${id}/context`
      )
      invalidateConversationCache(cacheScope, id)
      setConversationContext(context)
      onConversationUpdatedRef.current?.()
    },
    [cacheScope]
  )

  const handleSurfaceConversationUpdated = useCallback(() => {
    invalidateConversationCache(cacheScope, activeConversationRef.current)
    onConversationUpdatedRef.current?.()
  }, [cacheScope])

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

  const conversationLoading =
    Boolean(conversationId) &&
    !historyError &&
    (historyLoading || activeConversationId !== conversationId || !surfaceReady)
  const surfaceMatchesRoute = activeConversationId === conversationId
  // A locally created surface owns the live runtime while the URL and the
  // conversation list catch up. Refreshing the conversation after the first
  // response can fill in assistantId; including that metadata in the React
  // key would remount the runtime with initialMessages still empty.
  const assistantSurfaceKey =
    surfaceKey === "new"
      ? "local"
      : conversation?.assistantId
        ? `${conversation.assistantId}:${
            assistants.some(
              (assistant) => assistant.id === conversation.assistantId
            )
              ? "ready"
              : "pending"
          }`
        : "default"

  return (
    <div
      aria-busy={conversationLoading}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div
        className="chat-surface-content relative flex min-h-0 flex-1 flex-col"
        data-loading={conversationLoading ? "true" : undefined}
      >
        {surfaceReady && surfaceMatchesRoute && (
          <div
            key={`${surfaceKey}:${assistantSurfaceKey}`}
            className="chat-surface-enter flex min-h-0 flex-1 flex-col"
          >
            <AssistantChatSurface
              displayName={displayName}
              activeEndpoint={activeEndpoint}
              assistants={assistants}
              cacheScope={cacheScope}
              conversationId={activeConversationId}
              conversationAssistantId={conversation?.assistantId}
              conversationEndpointId={conversation?.endpointId}
              conversationChatModel={conversation?.chatModel}
              endpoints={activeChatEndpoints}
              mcpServers={mcpServers}
              notes={notes}
              initialMessages={initialMessages}
              onConversationCreated={handleSurfaceConversationCreated}
              onConversationUpdated={handleSurfaceConversationUpdated}
              onConversationSettled={onConversationSettled}
              onEnsureConversation={ensureConversation}
              onAssistantSelectionChange={handleAssistantSelectionChange}
              onAttachMCP={attachMCPServer}
              onRemoveMCP={removeMCPServer}
              onAttachNote={attachNote}
              onRemoveNote={removeNote}
              onRemoveRepository={removeRepository}
              onRemoveKnowledge={removeUploadedFile}
              onRemoveTranscription={removeTranscription}
              onSaveKnowledge={saveKnowledgeSource}
              onOpenHistory={onOpenHistory}
              onRemoveUpload={removeUploadedFile}
              onUpload={uploadFile}
              conversationContext={conversationContext}
            />
          </div>
        )}
      </div>
      {conversationLoading && (
        <div
          aria-live="polite"
          className="chat-history-loading absolute inset-0 z-20 flex items-center justify-center bg-background/95 text-sm text-muted-foreground backdrop-blur-sm"
          role="status"
        >
          <div className="flex flex-col items-center gap-4 text-center">
            <div
              aria-hidden="true"
              className="chat-history-loading-logo relative size-14"
            >
              <BrandMark className="absolute inset-0 size-full text-[var(--brand-foreground)]/25" />
              <span className="chat-history-loading-logo-sheen absolute inset-0">
                <BrandMark className="size-full" />
              </span>
            </div>
            <p className="font-medium text-foreground">
              {t("Loading conversation…")}
            </p>
          </div>
        </div>
      )}
      {historyError && (
        <div
          aria-live="assertive"
          className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 p-6 text-center backdrop-blur-sm"
          role="alert"
        >
          <div className="flex max-w-sm flex-col items-center gap-3">
            <p className="font-medium text-foreground">
              {t("Conversation history could not be loaded")}
            </p>
            <p className="text-sm text-muted-foreground">{t(historyError)}</p>
            <Button
              onClick={() => {
                setHistoryError("")
                setHistoryRetryToken((value) => value + 1)
              }}
              variant="outline"
            >
              <RefreshCw data-icon="inline-start" /> {t("Try again")}
            </Button>
          </div>
        </div>
      )}
      <span className="sr-only">
        {
          conversationContext.knowledgeSources.filter(
            (source) => source.contextScope !== "message"
          ).length
        }{" "}
        {t("knowledge sources,")} {conversationContext.mcpServers.length}{" "}
        {t("MCP servers,")} {conversationContext.notes?.length ?? 0}{" "}
        {t("notes,")} {conversationContext.transcriptionSessions.length}{" "}
        {t("transcription sessions attached.")}
      </span>
    </div>
  )
}
