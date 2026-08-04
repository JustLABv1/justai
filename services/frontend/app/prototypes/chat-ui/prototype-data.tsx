"use client"

import {
  ArrowUp,
  AudioLines,
  BookOpenText,
  Bot,
  ChevronDown,
  Circle,
  Clock3,
  Cpu,
  FileText,
  Hash,
  LibraryBig,
  Link2,
  MessageCircle,
  MessageSquareText,
  Mic,
  Paperclip,
  PlugZap,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  UserRound,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useCallback, useState, type ReactNode } from "react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
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
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export type ChatMessage = {
  id: string
  role: "assistant" | "user"
  content: string
  time: string
  citations?: Array<{ label: string; source: string }>
}

export type Conversation = {
  id: string
  title: string
  detail: string
  time: string
  unread?: boolean
}

export const conversations: Conversation[] = [
  {
    id: "onboarding",
    title: "Onboarding notes",
    detail: "You · 8 messages",
    time: "2m",
    unread: true,
  },
  {
    id: "provider-routing",
    title: "Provider routing",
    detail: "JustAI · 14 messages",
    time: "1h",
  },
  {
    id: "product-brief",
    title: "Product brief",
    detail: "You · 6 messages",
    time: "Yesterday",
  },
  {
    id: "mcp-playground",
    title: "MCP playground",
    detail: "JustAI · 22 messages",
    time: "Mon",
  },
  {
    id: "rag-evaluation",
    title: "RAG evaluation",
    detail: "You · 11 messages",
    time: "Sun",
  },
]

export const studioMessages: ChatMessage[] = [
  {
    id: "studio-1",
    role: "assistant",
    time: "10:42 AM",
    content:
      "I pulled the onboarding flow into a short sequence: connect a provider, pick a model, then ground the first workspace with a source collection. The smallest useful first run is one endpoint plus one folder of notes.",
    citations: [
      { label: "Architecture brief.md", source: "RAG collection" },
      { label: "justscan overview", source: "Workspace context" },
    ],
  },
  {
    id: "studio-2",
    role: "user",
    time: "10:44 AM",
    content:
      "Can we make the provider setup feel less like infrastructure and more like choosing a workspace capability?",
  },
  {
    id: "studio-3",
    role: "assistant",
    time: "10:44 AM",
    content:
      "Yes. I would frame each endpoint as a capability card with the provider, model family, latency, and an explicit fallback. Advanced connection details stay one click away, while the chat header always makes the active route visible.",
    citations: [{ label: "Provider routing", source: "Conversation" }],
  },
]

export const focusMessages: ChatMessage[] = [
  {
    id: "focus-1",
    role: "assistant",
    time: "Now",
    content:
      "What are you shaping today? I can help turn raw notes into a plan, answer questions from your sources, or inspect an MCP tool response.",
  },
  {
    id: "focus-2",
    role: "user",
    time: "Now",
    content: "Summarize the JustAI direction in one clear product statement.",
  },
  {
    id: "focus-3",
    role: "assistant",
    time: "Now",
    content:
      "JustAI is a calm workspace for working with any model: connect the endpoint you trust, bring the context you own, and move from conversation to action with live transcription, MCP, and RAG built in.",
    citations: [{ label: "Product brief", source: "RAG collection" }],
  },
]

export const pulseMessages: ChatMessage[] = [
  {
    id: "pulse-1",
    role: "assistant",
    time: "09:18:12",
    content:
      "The call transcript is ready. I found three decisions, one open question, and a reference to the provider fallback policy.",
    citations: [
      { label: "Call transcript · 12:04", source: "Live transcription" },
      { label: "Fallback policy.md", source: "RAG collection" },
    ],
  },
  {
    id: "pulse-2",
    role: "user",
    time: "09:18:31",
    content: "Give me the one decision we should make before the next call.",
  },
  {
    id: "pulse-3",
    role: "assistant",
    time: "09:18:33",
    content:
      "Decide whether endpoint fallback is automatic or user-approved. The live notes imply trust matters more than latency for the first release, so I would make the route visible and ask once before switching.",
    citations: [{ label: "Decision log", source: "MCP workspace" }],
  },
]

type NavItem = {
  id: string
  label: string
  icon: LucideIcon
}

const navItems: NavItem[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "endpoints", label: "Endpoints", icon: Cpu },
  { id: "knowledge", label: "Knowledge", icon: LibraryBig },
  { id: "mcp", label: "MCP", icon: PlugZap },
]

export function usePrototypeChat(seed: ChatMessage[]) {
  const [messages, setMessages] = useState(seed)
  const [draft, setDraft] = useState("")
  const [isSending, setIsSending] = useState(false)

  const send = useCallback(() => {
    const value = draft.trim()

    if (!value || isSending) {
      return
    }

    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: value,
        time: "Now",
      },
    ])
    setDraft("")
    setIsSending(true)

    window.setTimeout(() => {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content:
            "I’ve added that to the working context. The next useful step is to keep the active endpoint visible, then let the source trail show exactly where the answer came from.",
          time: "Now",
          citations: [{ label: "Working context", source: "JustAI" }],
        },
      ])
      setIsSending(false)
    }, 560)
  }, [draft, isSending])

  return { messages, draft, setDraft, send, isSending }
}

export function PrototypeComposer({
  draft,
  setDraft,
  send,
  isSending,
  placeholder = "Ask anything about this workspace...",
  className,
}: {
  draft: string
  setDraft: (value: string) => void
  send: () => void
  isSending: boolean
  placeholder?: string
  className?: string
}) {
  return (
    <form
      className={cn("flex flex-col gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <InputGroup className="h-auto min-h-14 flex-col items-stretch rounded-2xl bg-background shadow-sm has-[>textarea]:h-auto">
        <InputGroupTextarea
          aria-label="Message JustAI"
          className="min-h-14 px-3.5 pt-3 text-sm"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          placeholder={placeholder}
          rows={2}
          value={draft}
        />
        <InputGroupAddon align="inline-start" className="px-2.5 pb-2">
          <InputGroupButton aria-label="Attach a file" size="icon-xs">
            <Paperclip data-icon="inline-start" />
          </InputGroupButton>
          <InputGroupButton
            aria-label="Start live transcription"
            size="icon-xs"
          >
            <Mic data-icon="inline-start" />
          </InputGroupButton>
          <InputGroupText className="ml-1 hidden text-[11px] sm:flex">
            <span>Shift + Enter for a new line</span>
          </InputGroupText>
        </InputGroupAddon>
        <InputGroupAddon align="inline-end" className="px-2.5 pb-2">
          <Badge className="mr-1 hidden sm:inline-flex" variant="secondary">
            <Sparkles data-icon="inline-start" />
            JustAI
          </Badge>
          <Button
            aria-label={isSending ? "Sending message" : "Send message"}
            disabled={isSending || !draft.trim()}
            size="icon-sm"
            type="submit"
          >
            <ArrowUp data-icon="inline-start" />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>Responses stay in this workspace</span>
        <span className="hidden sm:inline">
          OpenAI-compatible · gpt-4o-mini
        </span>
      </div>
    </form>
  )
}

export function PrototypeMessageList({
  messages,
  density = "comfortable",
  className,
}: {
  messages: ChatMessage[]
  density?: "comfortable" | "focused" | "compact"
  className?: string
}) {
  const contentGap = {
    comfortable: "gap-7",
    focused: "gap-8",
    compact: "gap-4",
  }[density]

  return (
    <MessageScrollerProvider>
      <MessageScroller className={cn("min-h-0", className)}>
        <MessageScrollerViewport className="px-1 py-5 sm:px-4 sm:py-8">
          <MessageScrollerContent className={contentGap}>
            {messages.map((message, index) => {
              const align = message.role === "user" ? "end" : "start"
              const isLast = index === messages.length - 1

              return (
                <MessageScrollerItem key={message.id} scrollAnchor={isLast}>
                  <Message align={align}>
                    <MessageAvatar className="mt-1">
                      <Avatar size={density === "compact" ? "sm" : "default"}>
                        <AvatarFallback>
                          {message.role === "user" ? <UserRound /> : <Bot />}
                        </AvatarFallback>
                      </Avatar>
                    </MessageAvatar>
                    <MessageContent
                      className={cn(
                        "max-w-[min(48rem,88%)]",
                        message.role === "user" && "items-end"
                      )}
                    >
                      <MessageHeader className="gap-2">
                        <span className="font-semibold text-foreground">
                          {message.role === "user" ? "You" : "JustAI"}
                        </span>
                        <span>{message.time}</span>
                      </MessageHeader>
                      <Bubble
                        align={align}
                        variant={
                          message.role === "user" ? "default" : "secondary"
                        }
                      >
                        <BubbleContent>{message.content}</BubbleContent>
                      </Bubble>
                      {message.citations?.length ? (
                        <div className="flex flex-wrap gap-1.5 px-1">
                          {message.citations.map((citation) => (
                            <Button
                              className="max-w-full"
                              key={citation.label}
                              size="xs"
                              title={citation.source}
                              variant="outline"
                            >
                              <FileText data-icon="inline-start" />
                              <span className="truncate">{citation.label}</span>
                            </Button>
                          ))}
                        </div>
                      ) : null}
                      <MessageFooter>
                        {message.role === "assistant"
                          ? "Grounded response"
                          : "Sent just now"}
                      </MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          aria-label="Jump to latest message"
          direction="end"
        />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

export function GlobalSidebar({
  activeView,
  onViewChange,
  condensed = false,
  className,
}: {
  activeView: string
  onViewChange: (view: string) => void
  condensed?: boolean
  className?: string
}) {
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2",
          condensed ? "justify-center" : "px-1"
        )}
      >
        <div className="flex size-8 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
          <Sparkles data-icon="inline-start" />
        </div>
        {!condensed ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">
              JustAI
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              JustLAB workspace
            </p>
          </div>
        ) : null}
      </div>

      <Button
        className={cn(
          "mt-5",
          condensed ? "mx-auto size-9 p-0" : "justify-start"
        )}
        onClick={() => onViewChange("chat")}
        size={condensed ? "icon" : "default"}
        variant="default"
      >
        <Plus data-icon="inline-start" />
        {!condensed ? "New chat" : null}
      </Button>

      <nav className="mt-5 flex flex-col gap-1" aria-label="Global navigation">
        {navItems.map((item) => {
          const Icon = item.icon
          const active = activeView === item.id

          return (
            <Button
              aria-current={active ? "page" : undefined}
              aria-label={condensed ? item.label : undefined}
              className={cn(
                condensed ? "mx-auto size-9 p-0" : "justify-start",
                active && "bg-sidebar-accent text-sidebar-accent-foreground"
              )}
              key={item.id}
              onClick={() => onViewChange(item.id)}
              size={condensed ? "icon" : "default"}
              title={condensed ? item.label : undefined}
              variant="ghost"
            >
              <Icon data-icon="inline-start" />
              {!condensed ? item.label : null}
            </Button>
          )
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1">
        <Button
          aria-label={condensed ? "Settings" : undefined}
          className={cn(condensed ? "mx-auto size-9 p-0" : "justify-start")}
          onClick={() => onViewChange("settings")}
          size={condensed ? "icon" : "default"}
          title={condensed ? "Settings" : undefined}
          variant="ghost"
        >
          <Settings2 data-icon="inline-start" />
          {!condensed ? "Settings" : null}
        </Button>
        <Separator className="my-2 bg-sidebar-border" />
        <Button
          aria-label={condensed ? "Open profile" : undefined}
          className={cn(
            "h-auto py-2",
            condensed ? "mx-auto size-9 p-0" : "justify-start"
          )}
          size={condensed ? "icon" : "default"}
          title={condensed ? "Justin Neubert" : undefined}
          variant="ghost"
        >
          <Avatar size="sm">
            <AvatarFallback>JN</AvatarFallback>
          </Avatar>
          {!condensed ? (
            <span className="ml-1 min-w-0 text-left">
              <span className="block truncate text-xs font-medium">
                Justin Neubert
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                Personal workspace
              </span>
            </span>
          ) : null}
        </Button>
      </div>
    </aside>
  )
}

export function ConversationRail({
  activeConversation,
  onConversationChange,
  query,
  setQuery,
  className,
}: {
  activeConversation: string
  onConversationChange: (id: string) => void
  query: string
  setQuery: (value: string) => void
  className?: string
}) {
  const filtered = conversations.filter((conversation) =>
    `${conversation.title} ${conversation.detail}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )

  return (
    <aside className={cn("flex min-h-0 flex-col bg-muted/35", className)}>
      <div className="flex items-center justify-between gap-3 p-4 pb-3">
        <div>
          <p className="text-sm font-semibold tracking-tight">Conversations</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Your working memory
          </p>
        </div>
        <Button
          aria-label="Create conversation"
          size="icon-sm"
          variant="outline"
        >
          <Plus data-icon="inline-start" />
        </Button>
      </div>
      <div className="px-3 pb-3">
        <InputGroup className="h-8 bg-background">
          <InputGroupAddon>
            <InputGroupText>
              <Search data-icon="inline-start" />
            </InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search conversations"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            value={query}
          />
          <InputGroupAddon align="inline-end">
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] sm:inline">
              ⌘ K
            </kbd>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <Separator />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="flex flex-col gap-1">
          {filtered.map((conversation) => {
            const active = activeConversation === conversation.id

            return (
              <Button
                className={cn(
                  "h-auto min-h-14 items-start justify-start gap-2.5 px-2.5 py-2 text-left",
                  active && "bg-background shadow-sm"
                )}
                key={conversation.id}
                onClick={() => onConversationChange(conversation.id)}
                variant="ghost"
              >
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <MessageCircle />
                </div>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold">
                      {conversation.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {conversation.time}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 truncate text-[11px] font-normal text-muted-foreground">
                    {conversation.unread ? (
                      <span className="size-1.5 rounded-full bg-primary" />
                    ) : null}
                    {conversation.detail}
                  </span>
                </span>
              </Button>
            )
          })}
        </div>
      </div>
      <div className="border-t border-border/70 px-3 py-3">
        <div className="flex items-center gap-2 rounded-xl bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
          <Clock3 />
          <span className="truncate">Synced with JustLAB local context</span>
        </div>
      </div>
    </aside>
  )
}

export function EndpointPill({
  label = "OpenAI-compatible",
  detail = "gpt-4o-mini",
  onClick,
  className,
}: {
  label?: string
  detail?: string
  onClick?: () => void
  className?: string
}) {
  return (
    <Button
      className={cn(
        "h-auto justify-between gap-4 px-2.5 py-1.5 text-left",
        className
      )}
      onClick={onClick}
      size="sm"
      variant="outline"
    >
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <span className="block truncate text-xs font-semibold">{detail}</span>
      </span>
      <ChevronDown data-icon="inline-end" />
    </Button>
  )
}

export function ContextRow({
  icon: Icon,
  label,
  value,
  status = "ready",
}: {
  icon: LucideIcon
  label: string
  value: string
  status?: "ready" | "working" | "idle"
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium">{label}</span>
          <Badge variant={status === "working" ? "default" : "secondary"}>
            {status === "working"
              ? "Working"
              : status === "idle"
                ? "Idle"
                : "Ready"}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {value}
        </p>
      </div>
    </div>
  )
}

export function SourceRow({
  icon: Icon = FileText,
  label,
  meta,
}: {
  icon?: LucideIcon
  label: string
  meta: string
}) {
  return (
    <Button
      className="h-auto w-full justify-start gap-2 px-1.5 py-1.5 text-left"
      size="sm"
      variant="ghost"
    >
      <Icon data-icon="inline-start" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{label}</span>
        <span className="block truncate text-[10px] font-normal text-muted-foreground">
          {meta}
        </span>
      </span>
      <Link2 data-icon="inline-end" />
    </Button>
  )
}

export function LiveSignal({
  label,
  detail,
  icon: Icon = AudioLines,
}: {
  label: string
  detail: string
  icon?: LucideIcon
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex size-8 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
        <span className="absolute inset-0 rounded-xl border border-primary/25" />
        <Icon />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-primary" />
          <p className="text-xs font-semibold">{label}</p>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  )
}

export function ContextStack({
  title = "Working context",
  description = "Everything JustAI can use in this reply.",
  children,
  className,
}: {
  title?: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={cn("shadow-none", className)}>
      <CardHeader className="gap-1 px-4 py-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription className="text-[11px]">{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 pb-4">
        {children}
      </CardContent>
    </Card>
  )
}

export function WorkspaceMetric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: string
  detail: string
  icon: LucideIcon
}) {
  return (
    <div className="rounded-xl bg-muted/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <Icon />
      </div>
      <p className="mt-2 text-lg font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{detail}</p>
    </div>
  )
}

export const contextIcons = {
  endpoint: Cpu,
  knowledge: BookOpenText,
  mcp: Terminal,
  live: AudioLines,
  model: Zap,
  transcript: Mic,
  route: Hash,
  user: Circle,
} satisfies Record<string, LucideIcon>
