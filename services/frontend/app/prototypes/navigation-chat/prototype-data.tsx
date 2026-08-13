"use client"

import { useEffect, useRef, useState, type ComponentType } from "react"
import {
  Activity,
  Archive,
  AudioLines,
  BookOpenText,
  Bot,
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  Code2,
  Cpu,
  FileText,
  Headphones,
  LibraryBig,
  ListFilter,
  MessageSquare,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Upload,
  Wrench,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { BrandMark } from "@/components/brand-mark"
import { Markdown } from "@/components/markdown"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import styles from "./prototype.module.css"

export type PrototypeView =
  "chat" | "transcription" | "endpoints" | "knowledge" | "mcp" | "settings"

export type PrototypeTool = {
  name: string
  server: string
  status: "completed" | "running" | "failed"
  arguments: string
  result: string
}

export type PrototypeMessage = {
  id: string
  role: "user" | "assistant" | "tool"
  content: string
  citations?: string[]
  tool?: PrototypeTool
}

export type PrototypeConversation = {
  id: string
  title: string
  meta: string
  group: string
}

export type PrototypeSession = {
  id: string
  title: string
  meta: string
  status: "live" | "completed" | "paused"
}

export const navItems: Array<{
  id: PrototypeView
  label: string
  hint: string
  icon: LucideIcon
}> = [
  {
    id: "chat",
    label: "Chat",
    hint: "Conversations and history",
    icon: MessageSquare,
  },
  {
    id: "transcription",
    label: "Live transcription",
    hint: "Rooms and transcripts",
    icon: Headphones,
  },
  {
    id: "endpoints",
    label: "Endpoints",
    hint: "Models and providers",
    icon: Cpu,
  },
  {
    id: "knowledge",
    label: "Knowledge",
    hint: "Sources and retrieval",
    icon: LibraryBig,
  },
  { id: "mcp", label: "MCP", hint: "Tools and connections", icon: Plug },
  {
    id: "settings",
    label: "Settings",
    hint: "Workspace preferences",
    icon: Settings2,
  },
]

export const conversations: PrototypeConversation[] = [
  {
    id: "plain-docs",
    title: "Can you use search_plain_docs?",
    meta: "11 messages · 9:37 PM",
    group: "Today",
  },
  {
    id: "navigation-refresh",
    title: "Navigation refresh notes",
    meta: "8 messages · 8:52 PM",
    group: "Today",
  },
  {
    id: "gitlab-pipeline",
    title: "GitLab pipeline setup",
    meta: "6 messages · 4:18 PM",
    group: "Today",
  },
  {
    id: "endpoint-routing",
    title: "Endpoint routing decisions",
    meta: "14 messages · Aug 5",
    group: "Previous 7 days",
  },
  {
    id: "plain-onboarding",
    title: "PLAIN onboarding questions",
    meta: "21 messages · Aug 4",
    group: "Previous 7 days",
  },
]

export const transcriptionSessions: PrototypeSession[] = [
  {
    id: "roadmap-room",
    title: "Product roadmap room",
    meta: "Live · 00:12:04",
    status: "live",
  },
  {
    id: "research-review",
    title: "Research review",
    meta: "Completed · Aug 5",
    status: "completed",
  },
  {
    id: "design-crit",
    title: "Design critique",
    meta: "Paused · Aug 4",
    status: "paused",
  },
]

export const prototypeMessages: PrototypeMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "Can you use `search_plain_docs` to find the deployment notes?",
  },
  {
    id: "tool-1",
    role: "tool",
    content: "",
    tool: {
      name: "search_plain_docs",
      server: "Knowledge MCP · RAG WDB",
      status: "completed",
      arguments: '{"query":"deployment notes","limit":6}',
      result:
        '{"content":[{"type":"text","text":"Deployment notes found in Architecture brief.md and PLAIN CI guide."}],"isError":false}',
    },
  },
  {
    id: "assistant-1",
    role: "assistant",
    content:
      "I found two relevant sources. The current deployment path uses an OpenAI-compatible endpoint, keeps the knowledge index in the workspace, and runs the frontend and backend as separate pipeline jobs.",
    citations: ["Architecture brief.md", "PLAIN CI guide"],
  },
  {
    id: "user-2",
    role: "user",
    content:
      "What should I change in the navigation so the tools stay visible without taking over the chat?",
  },
  {
    id: "assistant-2",
    role: "assistant",
    content:
      "Keep the conversation as the primary canvas, then expose sources, MCP calls, endpoint status, and live transcription as compact context surfaces. History should be searchable and collapsible, while the active tool result stays inspectable without becoming a full-width document.",
  },
]

export const featureStats = {
  endpoints: "3 connected",
  knowledge: "12 sources",
  mcp: "2 servers · 8 tools",
}

export function usePrototypeChat(initialMessages: PrototypeMessage[]) {
  const [messages, setMessages] = useState(initialMessages)
  const [draft, setDraft] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [attachmentName, setAttachmentName] = useState("")
  const [voiceActive, setVoiceActive] = useState(false)
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false)
  const timeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  function send() {
    const content = draft.trim()
    if (!content || isSending) return

    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", content },
    ])
    setDraft("")
    setIsSending(true)

    timeoutRef.current = window.setTimeout(() => {
      const mentionsContext = /source|knowledge|mcp|search|docs|plain/i.test(
        content
      )
      setMessages((current) => [
        ...current,
        ...(mentionsContext
          ? [
              {
                id: `tool-${Date.now()}`,
                role: "tool" as const,
                content: "",
                tool: {
                  name: "search_plain_docs",
                  server: "Knowledge MCP · RAG WDB",
                  status: "completed" as const,
                  arguments: JSON.stringify({ query: content, limit: 6 }),
                  result:
                    '{"content":[{"type":"text","text":"Context refreshed for this question."}],"isError":false}',
                },
              },
            ]
          : []),
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: mentionsContext
            ? "I refreshed the connected context for this question and can keep the answer grounded in the workspace sources."
            : "I’m ready to help shape that into a clear next step. The selected endpoint and workspace context stay available while we work.",
        },
      ])
      setIsSending(false)
    }, 520)
  }

  return {
    messages,
    draft,
    setDraft,
    send,
    isSending,
    attachmentName,
    setAttachmentName,
    voiceActive,
    setVoiceActive,
    composerSettingsOpen,
    setComposerSettingsOpen,
  }
}

export function PrototypeBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn(styles.brand, compact && styles.brandCompact)}>
      <BrandMark className="size-8" priority />
      {!compact && (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">
            JustAI
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            JustLAB workspace
          </p>
        </div>
      )}
    </div>
  )
}

export function ViewNav({
  activeView,
  compact = false,
  onChange,
}: {
  activeView: PrototypeView
  compact?: boolean
  onChange: (view: PrototypeView) => void
}) {
  return (
    <nav className={cn(styles.viewNav, compact && styles.viewNavCompact)}>
      {navItems.map((item) => {
        const Icon = item.icon
        return (
          <Button
            aria-current={activeView === item.id ? "page" : undefined}
            aria-label={compact ? item.label : undefined}
            className={cn(
              styles.viewNavButton,
              activeView === item.id && styles.viewNavButtonActive
            )}
            key={item.id}
            onClick={() => onChange(item.id)}
            size={compact ? "icon" : "default"}
            title={compact ? item.label : undefined}
            variant="ghost"
          >
            <Icon data-icon="inline-start" />
            {!compact && (
              <span className="min-w-0 flex-1 truncate text-left">
                {item.label}
              </span>
            )}
            {!compact && item.id === "transcription" && (
              <span className="ml-auto text-[11px] text-muted-foreground">
                2
              </span>
            )}
          </Button>
        )
      })}
    </nav>
  )
}

export function ConversationList({
  activeConversation,
  query,
  setQuery,
  onSelect,
}: {
  activeConversation: string
  query: string
  setQuery: (value: string) => void
  onSelect: (id: string) => void
}) {
  const normalized = query.trim().toLowerCase()
  const filtered = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(normalized)
  )
  const groups = Array.from(
    new Set(filtered.map((conversation) => conversation.group))
  )

  return (
    <div className={styles.conversationList}>
      <div className={styles.sectionHeading}>
        <div>
          <p className="text-xs font-semibold">Chat history</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {conversations.length} conversations
          </p>
        </div>
        <Button aria-label="Filter chat history" size="icon-sm" variant="ghost">
          <ListFilter data-icon="inline-start" />
        </Button>
      </div>
      <div className={styles.searchBox}>
        <Search aria-hidden="true" />
        <Input
          aria-label="Search chat history"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          value={query}
        />
      </div>
      <div className={styles.conversationGroups}>
        {groups.map((group) => (
          <div className="flex flex-col gap-1.5" key={group}>
            <p className={styles.groupLabel}>{group}</p>
            {filtered
              .filter((conversation) => conversation.group === group)
              .map((conversation) => (
                <Button
                  aria-pressed={activeConversation === conversation.id}
                  className={cn(
                    styles.conversationButton,
                    activeConversation === conversation.id &&
                      styles.conversationButtonActive
                  )}
                  key={conversation.id}
                  onClick={() => onSelect(conversation.id)}
                  variant="ghost"
                >
                  <span className={styles.conversationDot} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-medium">
                      {conversation.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {conversation.meta}
                    </span>
                  </span>
                  <MoreHorizontal
                    aria-hidden="true"
                    className={styles.conversationAction}
                  />
                </Button>
              ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className={styles.emptyList}>
            <Search aria-hidden="true" />
            <p>No conversations found</p>
          </div>
        )}
      </div>
      <Button
        className="mt-auto w-full justify-start"
        size="sm"
        variant="ghost"
      >
        <Archive data-icon="inline-start" />
        Archived chats
        <span className="ml-auto text-[11px] text-muted-foreground">1</span>
      </Button>
    </div>
  )
}

export function PrototypeMessages({
  messages,
  density = "comfortable",
}: {
  messages: PrototypeMessage[]
  density?: "compact" | "comfortable"
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller
        className={cn(styles.messageScroller, "min-w-0 basis-0")}
      >
        <MessageScrollerViewport className="min-h-0 flex-1">
          <MessageScrollerContent
            className={cn(
              styles.messageContent,
              density === "compact" && styles.messageContentCompact
            )}
          >
            {messages.map((message, index) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={index === messages.length - 1}
              >
                <Message align={message.role === "user" ? "end" : "start"}>
                  <MessageAvatar className="bg-transparent">
                    <Avatar size="sm">
                      <AvatarFallback
                        className={cn(
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground"
                        )}
                      >
                        {message.role === "user" ? (
                          "JN"
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
                          ? "Justin"
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
                    {message.role === "tool" && message.tool ? (
                      <PrototypeToolCard tool={message.tool} />
                    ) : (
                      <Bubble
                        align={message.role === "user" ? "end" : "start"}
                        variant={message.role === "user" ? "default" : "muted"}
                      >
                        <BubbleContent>
                          <Markdown>{message.content}</Markdown>
                        </BubbleContent>
                      </Bubble>
                    )}
                    {message.citations && (
                      <div className="flex flex-wrap gap-1.5 px-3">
                        {message.citations.map((citation) => (
                          <Badge key={citation} variant="secondary">
                            {citation}
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
  )
}

function PrototypeToolCard({ tool }: { tool: PrototypeTool }) {
  const StatusIcon =
    tool.status === "completed"
      ? CheckCircle2
      : tool.status === "failed"
        ? CircleAlert
        : Activity
  return (
    <Bubble align="start" className={styles.toolBubble} variant="outline">
      <BubbleContent className={styles.toolContent}>
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon
            aria-hidden="true"
            className={cn(tool.status === "running" && "animate-spin")}
          />
          <span className="min-w-0 truncate font-medium">{tool.name}</span>
          <Badge
            className="ml-auto"
            variant={tool.status === "failed" ? "destructive" : "secondary"}
          >
            {tool.status}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">{tool.server}</p>
        <details className={styles.toolDetails}>
          <summary>Arguments</summary>
          <pre>{tool.arguments}</pre>
        </details>
        <details className={styles.toolDetails}>
          <summary>Result</summary>
          <pre>{tool.result}</pre>
        </details>
      </BubbleContent>
    </Bubble>
  )
}

export function PrototypeComposer({
  draft,
  setDraft,
  send,
  isSending,
  placeholder = "Ask JustAI",
  className,
  compact = false,
  attachmentName,
  setAttachmentName,
  voiceActive,
  setVoiceActive,
  composerSettingsOpen,
  setComposerSettingsOpen,
}: {
  draft: string
  setDraft: (value: string) => void
  send: () => void
  isSending: boolean
  placeholder?: string
  className?: string
  compact?: boolean
  attachmentName: string
  setAttachmentName: (value: string) => void
  voiceActive: boolean
  setVoiceActive: (value: boolean) => void
  composerSettingsOpen: boolean
  setComposerSettingsOpen: (value: boolean) => void
}) {
  return (
    <form
      className={cn(
        styles.composer,
        compact && styles.composerCompact,
        className
      )}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {attachmentName && (
        <div className={styles.attachmentChip}>
          <FileText aria-hidden="true" />
          <span className="truncate">{attachmentName}</span>
          <Button
            aria-label="Remove attachment"
            onClick={() => setAttachmentName("")}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <X data-icon="inline-start" />
          </Button>
        </div>
      )}
      <Textarea
        aria-label={placeholder}
        className={styles.composerTextarea}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
        placeholder={placeholder}
        value={draft}
      />
      {composerSettingsOpen && (
        <div className={styles.composerStatus}>
          <span className="size-1.5 rounded-full bg-primary" />
          MCP tools and Knowledge search are connected for this prototype.
        </div>
      )}
      <div className={styles.composerActions}>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Add attachment"
            onClick={() =>
              setAttachmentName(attachmentName ? "" : "architecture-brief.md")
            }
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Plus data-icon="inline-start" />
          </Button>
          <Button
            aria-expanded={composerSettingsOpen}
            aria-label="Adjust chat settings"
            onClick={() => setComposerSettingsOpen(!composerSettingsOpen)}
            size="icon-sm"
            type="button"
            variant={composerSettingsOpen ? "secondary" : "ghost"}
          >
            <SlidersHorizontal data-icon="inline-start" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            aria-pressed={voiceActive}
            aria-label={voiceActive ? "Stop voice input" : "Start voice input"}
            onClick={() => setVoiceActive(!voiceActive)}
            size="icon-sm"
            type="button"
            variant={voiceActive ? "secondary" : "ghost"}
          >
            <Mic data-icon="inline-start" />
          </Button>
          <Button
            aria-label="Send message"
            disabled={isSending || !draft.trim()}
            size="icon-sm"
            type="submit"
          >
            {isSending ? <Spinner /> : <Sparkles data-icon="inline-start" />}
          </Button>
        </div>
      </div>
    </form>
  )
}

export function PrototypeFeatureView({
  view,
  onBackToChat,
}: {
  view: Exclude<PrototypeView, "chat">
  onBackToChat: () => void
}) {
  const [notice, setNotice] = useState("")
  const [activeEndpoint, setActiveEndpoint] = useState("OpenAI-compatible")

  if (view === "transcription") {
    return (
      <section className={styles.featurePage}>
        <FeatureHeader
          icon={Headphones}
          eyebrow="Listen close"
          title="Live transcription"
          description="Open a room, keep the transcript readable, and return to the conversation when you are ready."
          onBackToChat={onBackToChat}
        />
        <div className={styles.featureGrid}>
          {transcriptionSessions.map((session) => (
            <Card className="shadow-none" key={session.id}>
              <CardHeader className="gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Badge
                    variant={
                      session.status === "live" ? "default" : "secondary"
                    }
                  >
                    {session.status === "live" && (
                      <span className="size-1.5 rounded-full bg-primary-foreground" />
                    )}
                    {session.status}
                  </Badge>
                  <AudioLines className="text-muted-foreground" />
                </div>
                <CardTitle className="text-base">{session.title}</CardTitle>
                <CardDescription>{session.meta} · 4 speakers</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Latest segment ready
                </span>
                <Button
                  onClick={() => setNotice(`${session.title} opened`)}
                  size="sm"
                  variant="outline"
                >
                  Open room
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        {notice && <FeatureNotice text={notice} />}
      </section>
    )
  }

  if (view === "endpoints") {
    const endpoints = [
      {
        name: "OpenAI-compatible",
        detail: "gpt-4o-mini · Tool calling",
        active: true,
      },
      {
        name: "Google Gemini",
        detail: "gemini-2.5-flash · Fast",
        active: false,
      },
      {
        name: "Local Ollama",
        detail: "llama3.2:latest · Private",
        active: false,
      },
    ]
    return (
      <section className={styles.featurePage}>
        <FeatureHeader
          icon={Cpu}
          eyebrow="Workspace infrastructure"
          title="Endpoints"
          description="Choose the model route that powers chat, retrieval, and transcription."
          onBackToChat={onBackToChat}
        />
        <div className={styles.featureGrid}>
          {endpoints.map((endpoint) => (
            <Card className="shadow-none" key={endpoint.name}>
              <CardHeader className="gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Badge
                    variant={
                      activeEndpoint === endpoint.name ? "default" : "outline"
                    }
                  >
                    {activeEndpoint === endpoint.name ? "Active" : "Available"}
                  </Badge>
                  <Cpu className="text-muted-foreground" />
                </div>
                <CardTitle className="text-base">{endpoint.name}</CardTitle>
                <CardDescription>{endpoint.detail}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  className="w-full"
                  onClick={() => {
                    setActiveEndpoint(endpoint.name)
                    setNotice(`${endpoint.name} selected`)
                  }}
                  size="sm"
                  variant={
                    activeEndpoint === endpoint.name ? "secondary" : "outline"
                  }
                >
                  {activeEndpoint === endpoint.name
                    ? "Selected"
                    : "Use endpoint"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        {notice && <FeatureNotice text={notice} />}
      </section>
    )
  }

  if (view === "knowledge") {
    return (
      <section className={styles.featurePage}>
        <FeatureHeader
          icon={LibraryBig}
          eyebrow="Grounded answers"
          title="Knowledge"
          description="Manage the documents and sources available to your workspace searches."
          onBackToChat={onBackToChat}
        />
        <Card className="shadow-none">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Workspace sources</CardTitle>
              <CardDescription>
                12 sources · Last indexed 4 minutes ago
              </CardDescription>
            </div>
            <Button onClick={() => setNotice("Upload flow opened")} size="sm">
              <Upload data-icon="inline-start" />
              Add source
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {[
              "Architecture brief.md",
              "PLAIN CI guide",
              "MCP transport notes",
              "Product roadmap.pdf",
            ].map((source, index) => (
              <div className={styles.featureRow} key={source}>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                    <FileText />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{source}</p>
                    <p className="text-xs text-muted-foreground">
                      {index % 2 === 0
                        ? "Indexed · 82% match"
                        : "Indexed · 71% match"}
                    </p>
                  </div>
                </div>
                <CheckCircle2 className="shrink-0 text-muted-foreground" />
              </div>
            ))}
          </CardContent>
        </Card>
        {notice && <FeatureNotice text={notice} />}
      </section>
    )
  }

  if (view === "mcp") {
    return (
      <section className={styles.featurePage}>
        <FeatureHeader
          icon={Plug}
          eyebrow="Connected tools"
          title="MCP"
          description="See which external tools are connected, available, and ready for the next chat turn."
          onBackToChat={onBackToChat}
        />
        <div className={styles.featureGrid}>
          {[
            {
              name: "Knowledge MCP",
              detail: "search_plain_docs · Read-only",
              icon: LibraryBig,
            },
            {
              name: "Workspace actions",
              detail: "preview.status · preview.search",
              icon: TerminalSquare,
            },
          ].map((server) => {
            const Icon = server.icon
            return (
              <Card className="shadow-none" key={server.name}>
                <CardHeader className="gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Badge variant="secondary">
                      <span className="size-1.5 rounded-full bg-primary" />
                      Connected
                    </Badge>
                    <Icon className="text-muted-foreground" />
                  </div>
                  <CardTitle className="text-base">{server.name}</CardTitle>
                  <CardDescription>{server.detail}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    8 tools discovered
                  </span>
                  <Button
                    onClick={() => setNotice(`${server.name} details opened`)}
                    size="sm"
                    variant="outline"
                  >
                    Inspect
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
        {notice && <FeatureNotice text={notice} />}
      </section>
    )
  }

  return (
    <section className={styles.featurePage}>
      <FeatureHeader
        icon={Settings2}
        eyebrow="Workspace preferences"
        title="Settings"
        description="Keep appearance, organization access, and documentation close without cluttering the conversation."
        onBackToChat={onBackToChat}
      />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription>
            Choose how much chrome you want around the chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {["Light", "System", "Dark"].map((option) => (
            <Button
              key={option}
              onClick={() => setNotice(`${option} appearance selected`)}
              size="sm"
              variant={option === "System" ? "secondary" : "outline"}
            >
              {option}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Connected workspace</CardTitle>
          <CardDescription>
            Justin&apos;s workspace · owner access
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            onClick={() => setNotice("Workspace switcher opened")}
            size="sm"
            variant="outline"
          >
            Manage workspaces
          </Button>
          <Button
            onClick={() => setNotice("Docs opened")}
            size="sm"
            variant="ghost"
          >
            Docs & guides
          </Button>
        </CardContent>
      </Card>
      {notice && <FeatureNotice text={notice} />}
      <div className={styles.featureFooter}>
        <ShieldCheck />
        <span>
          All current workspace features remain available from the navigation.
        </span>
      </div>
    </section>
  )
}

function FeatureHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  onBackToChat,
}: {
  icon: LucideIcon
  eyebrow: string
  title: string
  description: string
  onBackToChat: () => void
}) {
  return (
    <header className={styles.featureHeader}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
          <Icon />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <Button onClick={onBackToChat} size="sm" variant="outline">
        <MessageSquare data-icon="inline-start" />
        Back to chat
      </Button>
    </header>
  )
}

function FeatureNotice({ text }: { text: string }) {
  return (
    <div className={styles.featureNotice}>
      <CheckCircle2 />
      <span>{text}</span>
    </div>
  )
}

export const prototypeIcons = {
  activity: Activity,
  audio: AudioLines,
  book: BookOpenText,
  code: Code2,
  filter: ListFilter,
  panel: PanelLeft,
  panelClose: PanelLeftClose,
  panelOpen: PanelLeftOpen,
  radio: Radio,
  sliders: SlidersHorizontal,
  terminal: TerminalSquare,
  upload: CloudUpload,
}

export type PrototypeIcon = ComponentType<{ className?: string }>
