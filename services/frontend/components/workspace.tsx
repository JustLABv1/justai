"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  Headphones,
  LibraryBig,
  LogOut,
  MessageSquare,
  Plug,
  Plus,
  Settings2,
} from "lucide-react"

import { ChatView } from "@/components/chat-view"
import { BrandMark } from "@/components/brand-mark"
import { EndpointsView } from "@/components/endpoints-view"
import { KnowledgeView } from "@/components/knowledge-view"
import { LiveTranscriptionView } from "@/components/live-transcription-view"
import { MCPView } from "@/components/mcp-view"
import { SettingsView } from "@/components/settings-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { APIError, api } from "@/lib/api"
import type {
  Conversation,
  Endpoint,
  KnowledgeSource,
  MCPServer,
  Organization,
  User,
  ViewId,
  TranscriptionSession,
} from "@/lib/types"
import { ThemeSwitcher } from "@/components/theme-switcher"

const navigation: Array<{
  id: ViewId
  label: string
  icon: typeof MessageSquare
  hint: string
}> = [
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    hint: "Conversations and live context",
  },
  {
    id: "transcription",
    label: "Live transcription",
    icon: Headphones,
    hint: "Listen to a room",
  },
  {
    id: "endpoints",
    label: "Endpoints",
    icon: Cpu,
    hint: "Models and providers",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    icon: LibraryBig,
    hint: "Sources and retrieval",
  },
  { id: "mcp", label: "MCP", icon: Plug, hint: "Tools and connections" },
]

const validViews: ViewId[] = [
  "chat",
  "transcription",
  "endpoints",
  "knowledge",
  "mcp",
  "settings",
]

type WorkspaceStatus = "loading" | "ready" | "error"

export function Workspace() {
  const searchParams = useSearchParams()
  const requestedView = searchParams.get("view") as ViewId | null
  const requestedConversationId = searchParams.get("conversation")
  const requestedSessionId = searchParams.get("session")
  const activeView: ViewId =
    requestedView && validViews.includes(requestedView) ? requestedView : "chat"

  const [status, setStatus] = useState<WorkspaceStatus>("loading")
  const [loadError, setLoadError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [user, setUser] = useState<User | null>(null)
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [transcriptionSessions, setTranscriptionSessions] = useState<TranscriptionSession[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [servers, setServers] = useState<MCPServer[]>([])

  const redirectToLogin = useCallback(() => {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(next)}`)
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      const result = await api.get<{ conversations: Conversation[] }>(
        "/api/v1/conversations"
      )
      setConversations(result.conversations)
      return result.conversations
    } catch (caught) {
      if (caught instanceof APIError && caught.status === 401) {
        redirectToLogin()
      }
      throw caught
    }
  }, [redirectToLogin, setConversations])

  const refreshTranscriptionSessions = useCallback(async () => {
    try {
      const result = await api.get<{ sessions: TranscriptionSession[] }>(
        "/api/v1/transcription/sessions"
      )
      setTranscriptionSessions(result.sessions)
      return result.sessions
    } catch (caught) {
      if (caught instanceof APIError && caught.status === 401) {
        redirectToLogin()
      }
      throw caught
    }
  }, [redirectToLogin, setTranscriptionSessions])

  useEffect(() => {
    let cancelled = false

    async function loadWorkspace() {
      setStatus("loading")
      setLoadError("")
      try {
        const me = await api.get<{ user: User; organizations: Organization[] }>(
          "/api/v1/auth/me"
        )
        if (cancelled) return

        const [conversationResult, transcriptionResult, endpointResult, sourceResult, serverResult] =
          await Promise.all([
            api.get<{ conversations: Conversation[] }>("/api/v1/conversations"),
            api.get<{ sessions: TranscriptionSession[] }>("/api/v1/transcription/sessions"),
            api.get<{ endpoints: Endpoint[] }>("/api/v1/endpoints"),
            api.get<{ sources: KnowledgeSource[] }>(
              "/api/v1/knowledge/sources"
            ),
            api.get<{ servers: MCPServer[] }>("/api/v1/mcp/servers"),
          ])
        if (cancelled) return

        setUser(me.user)
        setOrganizations(me.organizations)
        setConversations(conversationResult.conversations)
        setTranscriptionSessions(transcriptionResult.sessions)
        setEndpoints(endpointResult.endpoints)
        setSources(sourceResult.sources)
        setServers(serverResult.servers)
        setStatus("ready")
      } catch (caught) {
        if (cancelled) return
        if (caught instanceof APIError && caught.status === 401) {
          redirectToLogin()
          return
        }
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "The JustAI workspace could not be loaded."
        )
        setStatus("error")
      }
    }

    void loadWorkspace()
    return () => {
      cancelled = true
    }
  }, [redirectToLogin, reloadToken])

  const activeOrganization = organizations[0]
  const activeConversationId = conversations.some(
    (conversation) => conversation.id === requestedConversationId
  )
    ? requestedConversationId
    : null
  const activeSessionId = transcriptionSessions.some(
    (session) => session.id === requestedSessionId
  )
    ? requestedSessionId
    : null
  const initials = useMemo(() => {
    if (!user) return "?"
    return user.displayName
      .split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  }, [user])

  const navigate = useCallback(
    (
      view: ViewId,
      conversationId: string | null = null,
      replace = false,
      sessionId: string | null = null
    ) => {
      const params = new URLSearchParams()
      if (view !== "chat") params.set("view", view)
      if (view === "chat" && conversationId) {
        params.set("conversation", conversationId)
      }
      if (view === "transcription" && sessionId) {
        params.set("session", sessionId)
      }
      const query = params.toString()
      const path = query ? `/?${query}` : "/"
      const method = replace ? "replaceState" : "pushState"
      window.history[method]({}, "", path)
      window.dispatchEvent(new PopStateEvent("popstate"))
    },
    []
  )

  async function signOut() {
    try {
      await api.post("/api/v1/auth/logout")
    } finally {
      window.location.assign("/login")
    }
  }

  const handleTranscriptionSessionCreated = useCallback(
    (session: TranscriptionSession) => {
      setTranscriptionSessions((current) => [
        session,
        ...current.filter((item) => item.id !== session.id),
      ])
      navigate("transcription", null, true, session.id)
    },
    [navigate]
  )

  const handleTranscriptionSessionsChanged = useCallback(() => {
    void refreshTranscriptionSessions().catch(() => undefined)
  }, [refreshTranscriptionSessions])

  if (status === "loading") return <WorkspaceLoading />

  if (status === "error" || !user) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background p-6">
        <Alert className="max-w-md" variant="destructive">
          <AlertTitle>Workspace unavailable</AlertTitle>
          <AlertDescription className="flex flex-col gap-4">
            <span>{loadError || "Please sign in again to continue."}</span>
            <Button
              className="w-fit"
              variant="outline"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    )
  }

  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className="gap-3">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <BrandMark className="size-8" priority />
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate font-heading text-sm font-semibold tracking-tight">
                JustAI
              </p>
              <p className="truncate text-xs text-muted-foreground">
                JustLAB workspace
              </p>
            </div>
          </div>

          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip={`${activeOrganization?.name ?? "Workspace"} organization`}
                variant="outline"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <Bot aria-hidden="true" />
                </div>
                <span className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
                  <span className="block truncate text-xs font-medium">
                    {activeOrganization?.name ?? "Workspace"}
                  </span>
                  <span className="block truncate text-[11px] font-normal text-muted-foreground">
                    {activeOrganization?.role ?? "member"} access
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="text-muted-foreground group-data-[collapsible=icon]:hidden"
                />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => {
                  const ItemIcon = item.icon
                  const active = item.id === activeView

                  if (item.id === "chat") {
                    return (
                      <Collapsible
                        className="group/collapsible"
                        defaultOpen
                        key={item.id}
                      >
                        <SidebarMenuItem>
                          <CollapsibleTrigger
                            render={
                              <SidebarMenuButton
                                isActive={active}
                                onClick={() =>
                                  navigate("chat", activeConversationId)
                                }
                                tooltip={item.hint}
                              >
                                <ItemIcon data-icon="inline-start" />
                                <span>{item.label}</span>
                                <ChevronRight className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
                              </SidebarMenuButton>
                            }
                          />
                          <CollapsibleContent>
                            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
                              Conversations
                            </div>
                            <SidebarMenuSub className="mt-0">
                              {conversations.length === 0 ? (
                                <Empty className="min-h-0 rounded-none p-3">
                                  <EmptyHeader>
                                    <EmptyTitle>
                                      No conversations yet
                                    </EmptyTitle>
                                    <EmptyDescription>
                                      Start a new chat to create one.
                                    </EmptyDescription>
                                  </EmptyHeader>
                                </Empty>
                              ) : (
                                conversations.map((conversation) => (
                                  <SidebarMenuSubItem key={conversation.id}>
                                    <SidebarMenuSubButton
                                      href={`/?conversation=${conversation.id}`}
                                      isActive={
                                        activeConversationId === conversation.id
                                      }
                                      onClick={(event) => {
                                        event.preventDefault()
                                        navigate("chat", conversation.id)
                                      }}
                                      title={`${conversation.title} · ${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`}
                                    >
                                      <span className="size-1.5 shrink-0 rounded-full bg-border" />
                                      <span className="min-w-0 flex-1 truncate">
                                        {conversation.title}
                                      </span>
                                      <span className="shrink-0 text-[10px] text-muted-foreground">
                                        {formatConversationTime(
                                          conversation.updatedAt
                                        )}
                                      </span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                ))
                              )}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                          <SidebarMenuAction
                            aria-label="New chat"
                            onClick={(event) => {
                              event.stopPropagation()
                              navigate("chat")
                            }}
                            showOnHover
                            title="New chat"
                          >
                            <Plus aria-hidden="true" />
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      </Collapsible>
                    )
                  }

                  if (item.id === "transcription") {
                    return (
                      <Collapsible
                        className="group/collapsible"
                        defaultOpen
                        key={item.id}
                      >
                        <SidebarMenuItem>
                          <CollapsibleTrigger
                            render={
                              <SidebarMenuButton
                                isActive={activeView === "transcription"}
                                onClick={() => navigate("transcription", null, false, activeSessionId)}
                                tooltip={item.hint}
                              >
                                <ItemIcon data-icon="inline-start" />
                                <span>{item.label}</span>
                                <ChevronRight className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
                              </SidebarMenuButton>
                            }
                          />
                          <CollapsibleContent>
                            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
                              Sessions
                            </div>
                            <SidebarMenuSub className="mt-0">
                              {transcriptionSessions.length === 0 ? (
                                <Empty className="min-h-0 rounded-none p-3">
                                  <EmptyHeader>
                                    <EmptyTitle>No sessions yet</EmptyTitle>
                                    <EmptyDescription>Start listening to create one.</EmptyDescription>
                                  </EmptyHeader>
                                </Empty>
                              ) : (
                                transcriptionSessions.map((session) => (
                                  <SidebarMenuSubItem key={session.id}>
                                    <SidebarMenuSubButton
                                      href={`/?view=transcription&session=${session.id}`}
                                      isActive={activeSessionId === session.id}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        navigate("transcription", null, false, session.id)
                                      }}
                                      title={`${session.title} · ${session.status}`}
                                    >
                                      <span className={`size-1.5 shrink-0 rounded-full ${session.status === "live" ? "bg-primary" : "bg-border"}`} />
                                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                                      <span className="shrink-0 text-[10px] text-muted-foreground">{formatConversationTime(session.updatedAt)}</span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                ))
                              )}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                          <SidebarMenuAction
                            aria-label="New live transcription session"
                            onClick={(event) => {
                              event.stopPropagation()
                              navigate("transcription")
                            }}
                            showOnHover
                            title="New live transcription session"
                          >
                            <Plus aria-hidden="true" />
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      </Collapsible>
                    )
                  }

                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active}
                        onClick={(event) => {
                          event.preventDefault()
                          navigate(item.id)
                        }}
                        tooltip={item.hint}
                      >
                        <ItemIcon data-icon="inline-start" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={activeView === "settings"}
                    onClick={(event) => {
                      event.preventDefault()
                      navigate("settings")
                    }}
                    tooltip="Workspace preferences"
                  >
                    <Settings2 data-icon="inline-start" />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <a
                        href="https://modelcontextprotocol.io"
                        rel="noreferrer"
                        target="_blank"
                      />
                    }
                    tooltip="MCP and integration docs"
                  >
                    <CircleHelp data-icon="inline-start" />
                    <span>Docs &amp; guides</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="flex items-center justify-between gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center">
                <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  Appearance
                </span>
                <ThemeSwitcher />
              </div>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip={`${user.displayName} · ${user.email}`}
              >
                <Avatar size="sm">
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium">
                    {user.displayName}
                  </span>
                  <span className="block truncate text-[11px] font-normal text-muted-foreground">
                    {user.email}
                  </span>
                </span>
              </SidebarMenuButton>
              <SidebarMenuAction
                aria-label="Sign out"
                onClick={() => void signOut()}
                showOnHover
                title="Sign out"
              >
                <LogOut aria-hidden="true" />
              </SidebarMenuAction>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <div
          className={
            activeView === "transcription"
              ? "min-h-svh w-full"
              : "mx-auto min-h-svh max-w-[1440px] p-4 sm:p-6 lg:p-8"
          }
        >
          {activeView === "chat" && (
            <ChatView
              conversationId={activeConversationId}
              endpoints={endpoints}
              user={user}
              userInitials={initials}
              onConversationCreated={(conversation) => {
                setConversations((current) => {
                  if (current.some((item) => item.id === conversation.id)) {
                    return current
                  }
                  return [conversation, ...current]
                })
                navigate("chat", conversation.id, true)
              }}
              onConversationUpdated={() => {
                void refreshConversations().catch(() => undefined)
              }}
              onNavigate={(view) => navigate(view, null)}
            />
          )}
          {activeView === "transcription" && (
            <LiveTranscriptionView
              endpoints={endpoints}
              onSessionCreated={handleTranscriptionSessionCreated}
              onSessionsChanged={handleTranscriptionSessionsChanged}
              sessionId={activeSessionId}
              sessions={transcriptionSessions}
              user={user}
            />
          )}
          {activeView === "endpoints" && (
            <EndpointsView endpoints={endpoints} onChange={setEndpoints} />
          )}
          {activeView === "knowledge" && (
            <KnowledgeView sources={sources} onChange={setSources} />
          )}
          {activeView === "mcp" && (
            <MCPView servers={servers} onChange={setServers} />
          )}
          {activeView === "settings" && (
            <SettingsView user={user} organizations={organizations} />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function WorkspaceLoading() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <BrandMark className="size-10" priority />
        <p className="text-sm text-muted-foreground">Loading JustAI…</p>
      </div>
    </main>
  )
}

function formatConversationTime(value: string) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ""
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return "now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}
