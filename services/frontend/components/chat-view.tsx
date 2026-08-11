"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  ShieldAlert,
  Wrench,
} from "lucide-react"

import Ai04, { type Ai04Action } from "@/components/ai-04"
import { VoiceMode } from "@/components/voice-mode"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Markdown } from "@/components/markdown"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { api, socketURL } from "@/lib/api"
import type {
  ChatMessage,
  Citation,
  Conversation,
  ChatToolEvent,
  Endpoint,
  User,
  ViewId,
} from "@/lib/types"

type SocketEnvelope = {
  type: string
  data?: Record<string, unknown>
}

type ToolApproval = {
  approvalId: string
  messageId: string
  callId: string
  serverName: string
  toolName: string
  arguments: Record<string, unknown>
  round: number
}

type Props = {
  conversationId: string | null
  endpoints: Endpoint[]
  user: Pick<User, "displayName" | "email">
  userInitials: string
  onConversationCreated?: (conversation: Conversation) => void
  onConversationUpdated?: () => void
  onNavigate?: (view: ViewId) => void
}

function parseToolEvent(content: string): ChatToolEvent | undefined {
  try {
    const event = JSON.parse(content) as ChatToolEvent
    if (event.kind === "mcp_tool" && event.toolName && event.serverName) {
      return event
    }
  } catch {
    // Older or malformed tool records stay visible as plain tool messages.
  }
  return undefined
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "tool" || message.toolCall) return message
  return { ...message, toolCall: parseToolEvent(message.content) }
}

function socketToolEvent(data: Record<string, unknown>): ChatToolEvent {
  const argumentsValue = data.arguments
  return {
    kind: "mcp_tool",
    status: String(data.status ?? "running") as ChatToolEvent["status"],
    serverId: typeof data.serverId === "string" ? data.serverId : undefined,
    serverName: String(data.serverName ?? "MCP server"),
    toolName: String(data.toolName ?? "tool"),
    callId: String(data.callId ?? ""),
    approvalId:
      typeof data.approvalId === "string" ? data.approvalId : undefined,
    arguments:
      argumentsValue && typeof argumentsValue === "object"
        ? (argumentsValue as Record<string, unknown>)
        : undefined,
    result: typeof data.result === "string" ? data.result : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
  }
}

function upsertToolMessage(
  messages: ChatMessage[],
  messageId: string,
  toolCall: ChatToolEvent
) {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) {
    return [
      ...messages,
      { id: messageId, role: "tool" as const, content: "", toolCall },
    ]
  }
  return messages.map((message, currentIndex) =>
    currentIndex === index ? { ...message, toolCall } : message
  )
}

function formatToolResult(result: string) {
  try {
    return JSON.stringify(JSON.parse(result), null, 2)
  } catch {
    return result
  }
}

function ToolCallCard({ toolCall }: { toolCall: ChatToolEvent }) {
  const statusLabel =
    toolCall.status === "awaiting_approval"
      ? "Needs approval"
      : toolCall.status === "running"
        ? "Running"
        : toolCall.status === "completed"
          ? "Completed"
          : toolCall.status === "declined"
            ? "Declined"
            : "Failed"
  const statusVariant =
    toolCall.status === "failed"
      ? "destructive"
      : toolCall.status === "completed"
        ? "secondary"
        : "outline"

  return (
    <Bubble align="start" className="w-full max-w-xl" variant="outline">
      <BubbleContent className="w-full min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {toolCall.status === "running" ||
          toolCall.status === "awaiting_approval" ? (
            <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" />
          ) : toolCall.status === "completed" ? (
            <CheckCircle2 aria-hidden="true" className="shrink-0 text-muted-foreground" />
          ) : (
            <CircleAlert aria-hidden="true" className="shrink-0 text-destructive" />
          )}
          <span className="min-w-0 truncate font-medium">{toolCall.toolName}</span>
          <Badge className="ml-auto shrink-0" variant={statusVariant}>
            {statusLabel}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">{toolCall.serverName}</p>
        {toolCall.arguments && Object.keys(toolCall.arguments).length > 0 && (
          <details className="min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
            <summary className="cursor-pointer font-medium">Arguments</summary>
            <pre className="mt-2 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </details>
        )}
        {toolCall.result && (
          <details className="min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
            <summary className="cursor-pointer font-medium">Result</summary>
            <pre className="mt-2 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
              {formatToolResult(toolCall.result)}
            </pre>
          </details>
        )}
        {toolCall.error && (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {toolCall.error}
          </p>
        )}
      </BubbleContent>
    </Bubble>
  )
}

export function ChatView({
  conversationId,
  endpoints,
  user,
  userInitials,
  onConversationCreated,
  onConversationUpdated,
  onNavigate,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [chatError, setChatError] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [connectionState, setConnectionState] = useState("Ready")
  const [activeAssistantId, setActiveAssistantId] = useState("")
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [toolApproval, setToolApproval] = useState<ToolApproval | null>(null)
  const [toolApprovalBusy, setToolApprovalBusy] = useState(false)
  const [toolNotice, setToolNotice] = useState("")
  const socketRef = useRef<WebSocket | null>(null)
  const conversationIdRef = useRef<string | null>(conversationId)
  const createdConversationIdRef = useRef<string | null>(null)
  const assistantIdRef = useRef("")
  const requestRef = useRef(0)

  const activeEndpoint =
    endpoints.find((endpoint) => endpoint.isDefault) ?? endpoints[0]

  useEffect(() => {
    return () => {
      socketRef.current?.close()
    }
  }, [])

  useEffect(() => {
    const nextConversationId = conversationId ?? null
    const conversationChanged = conversationIdRef.current !== nextConversationId
    conversationIdRef.current = nextConversationId

    if (createdConversationIdRef.current === nextConversationId) {
      createdConversationIdRef.current = null
      return
    }

    let cancelled = false
    if (conversationChanged) {
      socketRef.current?.close()
      socketRef.current = null
      assistantIdRef.current = ""
      setToolApproval(null)
      setToolApprovalBusy(false)
      setToolNotice("")
    }

    queueMicrotask(() => {
      if (cancelled) return
      setMessages([])
      if (conversationChanged) {
        setStreaming(false)
        setActiveAssistantId("")
        setConnectionState("Ready")
        setChatError("")
      }

      if (!nextConversationId) {
        setHistoryLoading(false)
        return
      }

      setHistoryLoading(true)
      void api
        .get<{ messages: ChatMessage[] }>(
          `/api/v1/conversations/${nextConversationId}/messages`
        )
        .then((result) => {
          if (cancelled) return
          setMessages(result.messages.map(normalizeChatMessage))
        })
        .catch((caught) => {
          if (cancelled) return
          setChatError(
            caught instanceof Error
              ? caught.message
              : "The conversation history could not be loaded."
          )
        })
        .finally(() => {
          if (!cancelled) setHistoryLoading(false)
        })
    })

    return () => {
      cancelled = true
    }
  }, [conversationId, historyRefresh])

  const notifyConversationUpdated = useCallback(() => {
    setHistoryRefresh((current) => current + 1)
    onConversationUpdated?.()
  }, [onConversationUpdated])

  const handleConversationCreated = useCallback(
    (conversation: Conversation) => {
      setMessages([])
      conversationIdRef.current = conversation.id
      createdConversationIdRef.current = conversation.id
      onConversationCreated?.(conversation)
    },
    [onConversationCreated]
  )

  const updateAssistant = useCallback(
    (update: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantIdRef.current ? update(message) : message
        )
      )
    },
    []
  )

  const handleSocketMessage = useCallback(
    (event: MessageEvent<string>) => {
      let envelope: SocketEnvelope
      try {
        envelope = JSON.parse(event.data) as SocketEnvelope
      } catch {
        return
      }

      const data = envelope.data ?? {}
      const serverConversationId = data.conversationId
      if (typeof serverConversationId === "string") {
        conversationIdRef.current = serverConversationId
      }
      if (envelope.type === "session.ready") setConnectionState("Connected")
      if (envelope.type === "message.accepted") setConnectionState("Thinking")
      if (envelope.type === "message.delta") {
        setStreaming(true)
        updateAssistant((message) => ({
          ...message,
          content: message.content + String(data.delta ?? ""),
        }))
      }
      if (envelope.type === "retrieval.completed") {
        updateAssistant((message) => ({
          ...message,
          citations: (data.citations ?? []) as Citation[],
        }))
      }
      if (envelope.type === "tool.call") {
        const messageId = String(data.messageId ?? `tool-${data.callId ?? Date.now()}`)
        setMessages((current) =>
          upsertToolMessage(current, messageId, socketToolEvent(data))
        )
      }
      if (envelope.type === "tool.approval_required") {
        setToolApproval({
          approvalId: String(data.approvalId ?? ""),
          messageId: String(data.messageId ?? ""),
          callId: String(data.callId ?? ""),
          serverName: String(data.serverName ?? "MCP server"),
          toolName: String(data.toolName ?? "tool"),
          arguments:
            data.arguments && typeof data.arguments === "object"
              ? (data.arguments as Record<string, unknown>)
              : {},
          round: Number(data.round ?? 1),
        })
        setToolApprovalBusy(false)
        setConnectionState("Needs approval")
      }
      if (envelope.type === "tools.ready") setToolNotice("")
      if (envelope.type === "tools.unavailable") {
        setToolNotice(String(data.message ?? "MCP tools are unavailable for this endpoint."))
      }
      if (envelope.type === "tool.updated" || envelope.type === "tool.completed") {
        const messageId = String(data.messageId ?? "")
        if (messageId) {
          setMessages((current) =>
            upsertToolMessage(current, messageId, socketToolEvent(data))
          )
        }
      }
      if (envelope.type === "tool.completed") {
        setToolApproval(null)
        setToolApprovalBusy(false)
      }
      if (envelope.type === "message.completed") {
        setStreaming(false)
        setConnectionState("Connected")
        setChatError("")
        if (typeof data.content === "string")
          updateAssistant((message) => ({
            ...message,
            content: data.content as string,
          }))
        notifyConversationUpdated()
      }
      if (envelope.type === "error") {
        setStreaming(false)
        setConnectionState("Needs attention")
        setChatError(String(data.message ?? "The model returned an error."))
        setMessages((current) =>
          current.filter((message) => message.id !== assistantIdRef.current)
        )
        setActiveAssistantId("")
      }
    },
    [notifyConversationUpdated, updateAssistant]
  )

  function handleAction(action: Ai04Action) {
    onNavigate?.(action)
  }

  async function openChatSocket(activeConversationId: string) {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      return socketRef.current

    const response = await api.post<{ ticket: string }>("/api/v1/ws/tickets", {
      kind: "chat",
    })
    const socket = new WebSocket(socketURL("/api/v1/ws/chat", response.ticket))
    socket.onmessage = handleSocketMessage
    socket.onclose = () => setConnectionState("Offline")
    socket.onerror = () => setConnectionState("Needs attention")

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () =>
        reject(new Error("Could not connect to the chat socket"))
    })

    socketRef.current = socket
    socket.send(
      JSON.stringify({
        type: "session.start",
        requestId: "session",
        data: {
          conversationId: activeConversationId,
          endpointId: activeEndpoint?.id ?? "",
        },
      })
    )
    return socket
  }

  async function sendMessage(content: string) {
    const prompt = content.trim()
    if (!prompt || streaming) return

    const requestId = `request-${++requestRef.current}`
    const assistantId = `assistant-${requestId}`
    assistantIdRef.current = assistantId
    setActiveAssistantId(assistantId)
    setMessages((current) => [
      ...current,
      { id: `user-${requestId}`, role: "user", content: prompt },
      { id: assistantId, role: "assistant", content: "" },
    ])
    setChatError("")
    setStreaming(true)
    setConnectionState("Connecting")

    try {
      let activeConversationId = conversationIdRef.current
      if (!activeConversationId) {
        const response = await api.post<{ conversation: Conversation }>(
          "/api/v1/conversations"
        )
        activeConversationId = response.conversation.id
        conversationIdRef.current = activeConversationId
        createdConversationIdRef.current = activeConversationId
        handleConversationCreated(response.conversation)
      }

      const socket = await openChatSocket(activeConversationId)
      socket.send(
        JSON.stringify({
          type: "message.send",
          requestId,
          data: {
            conversationId: activeConversationId,
            content: prompt,
            endpointId: activeEndpoint?.id ?? "",
          },
        })
      )
    } catch (caught) {
      setStreaming(false)
      setConnectionState("Needs attention")
      setChatError(
        caught instanceof Error
          ? caught.message
          : "The message could not be sent."
      )
      setMessages((current) =>
        current.filter((message) => message.id !== assistantIdRef.current)
      )
      setActiveAssistantId("")
    }
  }

  function decideTool(approved: boolean) {
    if (!toolApproval || socketRef.current?.readyState !== WebSocket.OPEN) return
    setToolApprovalBusy(true)
    socketRef.current.send(
      JSON.stringify({
        type: "tool.decision",
        requestId: `tool-decision-${toolApproval.approvalId}`,
        data: { approvalId: toolApproval.approvalId, approved },
      })
    )
  }

  const voiceOverlay = (
    <VoiceMode
      conversationId={conversationId}
      endpoints={endpoints}
      onClose={() => setVoiceOpen(false)}
      onConversationCreated={handleConversationCreated}
      onConversationUpdated={notifyConversationUpdated}
      open={voiceOpen}
    />
  )

  if (historyLoading) {
    return (
      <>
        {voiceOverlay}
        <div className="flex h-full min-h-0 items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading conversation…
          </div>
        </div>
      </>
    )
  }

  if (messages.length === 0) {
    return (
      <>
        <div className="flex h-full min-h-0 items-center justify-center">
          <div className="w-full">
            {chatError && (
              <Alert className="mx-auto mb-4 max-w-3xl" variant="destructive">
                <AlertTitle>Chat unavailable</AlertTitle>
                <AlertDescription>{chatError}</AlertDescription>
              </Alert>
            )}
            <Ai04
              onAction={handleAction}
              onVoice={() => setVoiceOpen(true)}
              onSubmit={(prompt) => void sendMessage(prompt)}
            />
          </div>
        </div>
        {voiceOverlay}
      </>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="end"
        key={conversationId ?? "new-chat"}
      >
        <MessageScroller className="min-h-0 min-w-0 flex-1 basis-0">
          <MessageScrollerViewport className="min-h-0 flex-1">
            <MessageScrollerContent className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 lg:px-12">
              {messages.map((message, index) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={index === messages.length - 1}
                >
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageAvatar className="bg-transparent">
                      <Avatar
                        aria-label={
                          message.role === "user"
                            ? `${user.displayName} avatar`
                            : message.role === "tool"
                              ? "MCP tool"
                              : "JustAI avatar"
                        }
                        size="sm"
                      >
                        <AvatarFallback
                          className={
                            message.role === "user"
                              ? "bg-primary text-primary-foreground"
                              : "bg-secondary text-secondary-foreground"
                          }
                        >
                          {message.role === "user" ? (
                            userInitials
                          ) : message.role === "tool" ? (
                            <Wrench aria-hidden="true" />
                          ) : (
                            <Bot aria-hidden="true" />
                          )}
                        </AvatarFallback>
                      </Avatar>
                    </MessageAvatar>
                    <MessageContent>
                      <MessageHeader>
                        <span>
                          {message.role === "user"
                            ? user.displayName
                            : message.role === "tool"
                              ? "MCP tool"
                              : "JustAI"}
                        </span>
                        {message.role === "assistant" && (
                          <Badge
                            className="h-5 px-1.5 text-[10px]"
                            variant="outline"
                          >
                            assistant
                          </Badge>
                        )}
                        {message.role === "tool" && (
                          <Badge
                            className="h-5 px-1.5 text-[10px]"
                            variant="outline"
                          >
                            tool call
                          </Badge>
                        )}
                      </MessageHeader>
                      {message.role === "tool" && message.toolCall ? (
                        <ToolCallCard toolCall={message.toolCall} />
                      ) : (
                        <Bubble
                          align={message.role === "user" ? "end" : "start"}
                          variant={message.role === "user" ? "default" : "muted"}
                        >
                          <BubbleContent>
                            {message.content ? (
                              <Markdown>{message.content}</Markdown>
                            ) : streaming && message.id === activeAssistantId ? (
                              <Spinner />
                            ) : null}
                          </BubbleContent>
                        </Bubble>
                      )}
                      {!!message.citations?.length && (
                        <div className="flex flex-wrap gap-1.5 px-3">
                          {message.citations.map((citation) => (
                            <Badge
                              className="max-w-full truncate font-normal"
                              key={`${citation.sourceId}-${citation.chunkIndex}`}
                              variant="secondary"
                            >
                              {citation.title}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            aria-label="Jump to latest message"
            direction="end"
          />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="mx-auto w-full max-w-5xl shrink-0 px-4 pb-4 sm:px-8 sm:pb-6 lg:px-12">
        {chatError && (
          <Alert className="mb-3" variant="destructive">
            <AlertTitle>Chat unavailable</AlertTitle>
            <AlertDescription>{chatError}</AlertDescription>
          </Alert>
        )}
        {toolNotice && (
          <Alert className="mb-3">
            <ShieldAlert aria-hidden="true" />
            <AlertTitle>MCP tools not active</AlertTitle>
            <AlertDescription>{toolNotice}</AlertDescription>
          </Alert>
        )}
        {toolApproval && (
          <Alert className="mb-3">
            <ShieldAlert aria-hidden="true" />
            <AlertTitle>Approve MCP tool call</AlertTitle>
            <AlertDescription>
              <p>
                {toolApproval.serverName} wants to run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  {toolApproval.toolName}
                </code>{" "}
                (round {toolApproval.round}).
              </p>
              <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-muted p-2 text-xs">
                {JSON.stringify(toolApproval.arguments, null, 2)}
              </pre>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  disabled={toolApprovalBusy}
                  onClick={() => decideTool(true)}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={toolApprovalBusy}
                  onClick={() => decideTool(false)}
                >
                  Decline
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        <Ai04
          compact
          onVoice={() => setVoiceOpen(true)}
          onSubmit={(prompt) => void sendMessage(prompt)}
        />
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          {connectionState} · Responses use your connected JustAI endpoint.
        </p>
      </div>
      {voiceOverlay}
    </div>
  )
}
