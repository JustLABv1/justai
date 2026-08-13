"use client"

import { useEffect, useState, type ReactNode } from "react"
import {
  BookOpenText,
  CheckCircle2,
  Database,
  Headphones,
  LoaderCircle,
  Plug,
  Plus,
  Radio,
  Wrench,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  ConversationContext,
  KnowledgeSource,
  MCPServer,
  TranscriptionSession,
  ViewId,
} from "@/lib/types"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type ContextTab = "sources" | "mcp" | "live"

type WorkspaceContextProps = {
  conversationId: string | null
  onEnsureConversation?: () => Promise<string>
  sources: KnowledgeSource[]
  servers: MCPServer[]
  transcriptionSessions: TranscriptionSession[]
  onNavigate: (view: ViewId) => void
  onClose: () => void
}

export function WorkspaceContext({
  conversationId,
  onEnsureConversation,
  sources,
  servers,
  transcriptionSessions,
  onNavigate,
  onClose,
}: WorkspaceContextProps) {
  const [activeTab, setActiveTab] = useState<ContextTab>("sources")
  const [context, setContext] = useState<ConversationContext>({
    knowledgeSources: [],
    mcpServers: [],
    transcriptionSessions: [],
  })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState("")
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [loadedConversationId, setLoadedConversationId] = useState<
    string | null
  >(null)

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)")
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches)
    updateViewport()
    mediaQuery.addEventListener("change", updateViewport)
    return () => mediaQuery.removeEventListener("change", updateViewport)
  }, [])

  useEffect(() => {
    if (!conversationId) {
      return
    }
    let cancelled = false
    const loadContext = (showLoading: boolean) => {
      if (cancelled) return
      if (showLoading) setLoading(true)
      void api
        .get<ConversationContext>(
          `/api/v1/conversations/${conversationId}/context`
        )
        .then((result) => {
          if (!cancelled) {
            setContext(result)
            setLoadedConversationId(conversationId)
          }
        })
        .catch((caught) => {
          if (!cancelled) {
            setLoadedConversationId(conversationId)
            setNotice(
              caught instanceof Error
                ? caught.message
                : "Conversation context could not be loaded."
            )
          }
        })
        .finally(() => {
          if (!cancelled && showLoading) setLoading(false)
        })
    }
    const timer = window.setTimeout(() => {
      if (cancelled) return
      setNotice("")
      loadContext(true)
    }, 0)
    const refreshTimer = window.setInterval(() => loadContext(false), 5000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(refreshTimer)
    }
  }, [conversationId])

  const visibleContext =
    conversationId && loadedConversationId === conversationId
      ? context
      : { knowledgeSources: [], mcpServers: [], transcriptionSessions: [] }
  const visibleNotice =
    conversationId && loadedConversationId === conversationId ? notice : ""

  const availableSources = Array.from(
    new Map(
      [...sources, ...visibleContext.knowledgeSources].map((source) => [
        source.id,
        source,
      ])
    ).values()
  )
  const readySources = availableSources.filter(
    (source) => source.status === "ready"
  )
  const availableServers = Array.from(
    new Map(
      [...servers, ...visibleContext.mcpServers].map((server) => [
        server.id,
        server,
      ])
    ).values()
  )
  const activeServers = availableServers.filter(
    (server) =>
      server.enabled ||
      visibleContext.mcpServers.some((item) => item.id === server.id)
  )
  const availableSessions = Array.from(
    new Map(
      [...transcriptionSessions, ...visibleContext.transcriptionSessions].map(
        (session) => [session.id, session]
      )
    ).values()
  )
  // Completed sessions remain searchable and can be attached for timestamped
  // citations; the context picker is not limited to currently live rooms.
  const liveSessions = availableSessions

  async function toggle(
    resource: "knowledge" | "mcp" | "transcription",
    id: string,
    attached: boolean
  ) {
    setBusy(id)
    setNotice("")
    const path =
      resource === "knowledge"
        ? "knowledge"
        : resource === "mcp"
          ? "mcp"
          : "transcription"
    try {
      const targetConversationId =
        conversationId ?? (await onEnsureConversation?.())
      if (!targetConversationId) {
        throw new Error("A conversation is required before attaching context.")
      }
      await (attached
        ? api.delete(
            `/api/v1/conversations/${targetConversationId}/context/${path}/${id}`
          )
        : api.post(
            `/api/v1/conversations/${targetConversationId}/context/${path}/${id}`
          ))
      const next = await api.get<ConversationContext>(
        `/api/v1/conversations/${targetConversationId}/context`
      )
      setContext(next)
      setLoadedConversationId(targetConversationId)
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "Context could not be updated."
      )
    } finally {
      setBusy("")
    }
  }

  const panel = (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">
            Conversation context
          </p>
          <h2 className="text-sm font-semibold tracking-tight">Context</h2>
        </div>
        <Button
          aria-label="Hide context inspector"
          onClick={onClose}
          size="icon-sm"
          title="Hide context inspector"
          variant="ghost"
        >
          <X data-icon="inline-start" />
        </Button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading attached
          context…
        </div>
      )}
      {visibleNotice && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          {visibleNotice}
        </p>
      )}

      <div
        className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
        role="tablist"
        aria-label="Chat context"
      >
        {(
          [
            ["sources", "Sources"],
            ["mcp", "MCP"],
            ["live", "Live"],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-selected={activeTab === id}
            className={cn(
              "rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors",
              activeTab === id && "bg-card text-foreground shadow-xs"
            )}
            key={id}
            onClick={() => setActiveTab(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "sources" && (
        <div className="flex flex-col gap-2">
          <ContextHeading
            icon={BookOpenText}
            label="Knowledge sources"
            meta={`${readySources.length}/${availableSources.length} ready`}
          />
          {availableSources.length > 0 ? (
            availableSources.slice(0, 6).map((source) => (
              <ContextItem
                detail={`${source.status}${source.sourceType ? ` · ${source.sourceType}` : ""}`}
                icon={BookOpenText}
                key={source.id}
                label={source.title}
                action={
                  <Button
                    aria-label={`${visibleContext.knowledgeSources.some((item) => item.id === source.id) ? "Detach" : "Attach"} ${source.title}`}
                    disabled={
                      busy === source.id ||
                      (source.status === "failed" &&
                        !visibleContext.knowledgeSources.some(
                          (item) => item.id === source.id
                        ))
                    }
                    onClick={() =>
                      void toggle(
                        "knowledge",
                        source.id,
                        visibleContext.knowledgeSources.some(
                          (item) => item.id === source.id
                        )
                      )
                    }
                    size="icon-xs"
                    variant="ghost"
                  >
                    {busy === source.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : visibleContext.knowledgeSources.some(
                        (item) => item.id === source.id
                      ) ? (
                      <CheckCircle2 />
                    ) : (
                      <Plus />
                    )}
                  </Button>
                }
              />
            ))
          ) : (
            <ContextEmpty icon={Database} text="No workspace sources yet." />
          )}
          <Button
            className="mt-1 w-full"
            onClick={() => onNavigate("knowledge")}
            size="sm"
            variant="outline"
          >
            Manage knowledge
          </Button>
        </div>
      )}

      {activeTab === "mcp" && (
        <div className="flex flex-col gap-2">
          <ContextHeading
            icon={Plug}
            label="Connected tools"
            meta={`${activeServers.length} servers`}
          />
          {activeServers.length > 0 ? (
            activeServers.slice(0, 6).map((server) => (
              <ContextItem
                detail={`${server.toolCount ?? server.allowedTools.length} tools discovered`}
                icon={Wrench}
                key={server.id}
                label={server.name}
                status={
                  server.credentialConfigured ? "Connected" : "Needs setup"
                }
                action={
                  <Button
                    aria-label={`${visibleContext.mcpServers.some((item) => item.id === server.id) ? "Detach" : "Attach"} ${server.name}`}
                    disabled={
                      busy === server.id ||
                      (server.authType !== "none" &&
                        !server.credentialConfigured &&
                        !visibleContext.mcpServers.some(
                          (item) => item.id === server.id
                        ))
                    }
                    onClick={() =>
                      void toggle(
                        "mcp",
                        server.id,
                        visibleContext.mcpServers.some(
                          (item) => item.id === server.id
                        )
                      )
                    }
                    size="icon-xs"
                    variant="ghost"
                  >
                    {busy === server.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : visibleContext.mcpServers.some(
                        (item) => item.id === server.id
                      ) ? (
                      <CheckCircle2 />
                    ) : (
                      <Plus />
                    )}
                  </Button>
                }
              />
            ))
          ) : (
            <ContextEmpty icon={Plug} text="No MCP servers connected." />
          )}
          <div className="rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
            Tool calls and their bounded results stay attached to the relevant
            chat turn.
          </div>
          <Button
            className="mt-1 w-full"
            onClick={() => onNavigate("mcp")}
            size="sm"
            variant="outline"
          >
            Inspect MCP
          </Button>
        </div>
      )}

      {activeTab === "live" && (
        <div className="flex flex-col gap-2">
          <ContextHeading
            icon={Headphones}
            label="Live transcription"
            meta={`${liveSessions.length} sessions`}
          />
          {liveSessions.length > 0 ? (
            liveSessions.slice(0, 6).map((session) => (
              <ContextItem
                detail={`${session.status} · ${session.segmentCount} segments`}
                icon={session.status === "live" ? Radio : Headphones}
                key={session.id}
                label={session.title}
                status={session.status === "live" ? "Listening" : undefined}
                action={
                  <Button
                    aria-label={`${visibleContext.transcriptionSessions.some((item) => item.id === session.id) ? "Detach" : "Attach"} ${session.title}`}
                    disabled={busy === session.id}
                    onClick={() =>
                      void toggle(
                        "transcription",
                        session.id,
                        visibleContext.transcriptionSessions.some(
                          (item) => item.id === session.id
                        )
                      )
                    }
                    size="icon-xs"
                    variant="ghost"
                  >
                    {busy === session.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : visibleContext.transcriptionSessions.some(
                        (item) => item.id === session.id
                      ) ? (
                      <CheckCircle2 />
                    ) : (
                      <Plus />
                    )}
                  </Button>
                }
              />
            ))
          ) : (
            <ContextEmpty
              icon={Radio}
              text="No live transcription sessions yet."
            />
          )}
          <Button
            className="mt-1 w-full"
            onClick={() => onNavigate("transcription")}
            size="sm"
            variant="outline"
          >
            Open live transcription
          </Button>
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 border-t pt-4 text-[11px] text-muted-foreground">
        <CheckCircle2 className="size-4 shrink-0" />
        Context stays available while you work.
      </div>
    </div>
  )

  return (
    <>
      <aside className="hidden w-[304px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-muted/20 lg:flex">
        {panel}
      </aside>
      {isMobileViewport && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) onClose()
          }}
        >
          <SheetContent
            className="w-[min(100vw,304px)] gap-0 p-0"
            side="right"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Conversation context</SheetTitle>
              <SheetDescription>
                Attach Knowledge sources, MCP servers, and transcription sessions
                to this conversation.
              </SheetDescription>
            </SheetHeader>
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}

function ContextHeading({
  icon: Icon,
  label,
  meta,
}: {
  icon: LucideIcon
  label: string
  meta: string
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <p className="truncate text-xs font-medium">{label}</p>
      </div>
      <span className="shrink-0 text-[10px] text-muted-foreground">{meta}</span>
    </div>
  )
}

function ContextItem({
  detail,
  icon: Icon,
  label,
  status,
  action,
}: {
  detail: string
  icon: LucideIcon
  label: string
  status?: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-card p-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {label}
          </span>
          {status && (
            <Badge
              className="h-5 shrink-0 px-1.5 text-[10px]"
              variant="secondary"
            >
              {status}
            </Badge>
          )}
          {action}
        </span>
        <span className="mt-1 block truncate text-[11px] text-muted-foreground">
          {detail}
        </span>
      </span>
    </div>
  )
}

function ContextEmpty({
  icon: Icon,
  text,
}: {
  icon: LucideIcon
  text: string
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-5 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )
}
