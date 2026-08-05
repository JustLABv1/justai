"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bot } from "lucide-react"

import Ai04, { type Ai04Action } from "@/components/ai-04"
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
import { api, socketURL } from "@/lib/api"
import type {
  ChatMessage,
  Citation,
  Conversation,
  Endpoint,
  User,
  ViewId,
} from "@/lib/types"

type SocketEnvelope = {
  type: string
  data?: Record<string, unknown>
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
    conversationIdRef.current = nextConversationId

    if (createdConversationIdRef.current === nextConversationId) {
      createdConversationIdRef.current = null
      return
    }

    let cancelled = false
    socketRef.current?.close()
    socketRef.current = null
    assistantIdRef.current = ""

    queueMicrotask(() => {
      if (cancelled) return
      setMessages([])
      setStreaming(false)
      setActiveAssistantId("")
      setConnectionState("Ready")
      setChatError("")

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
          setMessages(result.messages)
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
  }, [conversationId])

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
      if (envelope.type === "message.completed") {
        setStreaming(false)
        setConnectionState("Connected")
        setChatError("")
        if (typeof data.content === "string")
          updateAssistant((message) => ({
            ...message,
            content: data.content as string,
          }))
        onConversationUpdated?.()
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
    [onConversationUpdated, updateAssistant]
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
        onConversationCreated?.(response.conversation)
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

  if (historyLoading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Loading conversation…
        </div>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
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
            onSubmit={(prompt) => void sendMessage(prompt)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 lg:px-12">
              {messages.map((message, index) => (
                <MessageScrollerItem key={message.id} scrollAnchor={index === messages.length - 1}>
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageAvatar className="bg-transparent">
                      <Avatar
                        aria-label={
                          message.role === "user"
                            ? `${user.displayName} avatar`
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
                      </MessageHeader>
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
          <MessageScrollerButton aria-label="Jump to latest message" direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="mx-auto w-full max-w-5xl px-4 pb-4 sm:px-8 sm:pb-6 lg:px-12">
        {chatError && (
          <Alert className="mb-3" variant="destructive">
            <AlertTitle>Chat unavailable</AlertTitle>
            <AlertDescription>{chatError}</AlertDescription>
          </Alert>
        )}
        <Ai04 compact onSubmit={(prompt) => void sendMessage(prompt)} />
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          {connectionState} · Responses use your connected JustAI endpoint.
        </p>
      </div>
    </div>
  )
}
