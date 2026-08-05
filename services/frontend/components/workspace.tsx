"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Bot,
  Archive,
  ChevronDown,
  CircleHelp,
  Cpu,
  Headphones,
  LibraryBig,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plug,
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react"

import { ChatView } from "@/components/chat-view"
import { BrandMark } from "@/components/brand-mark"
import { EndpointsView } from "@/components/endpoints-view"
import { KnowledgeView } from "@/components/knowledge-view"
import { LiveTranscriptionView } from "@/components/live-transcription-view"
import { MCPView } from "@/components/mcp-view"
import { SettingsView } from "@/components/settings-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { parseWorkspaceRoute, workspacePath } from "@/lib/workspace-routes"

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

type WorkspaceStatus = "loading" | "ready" | "error"

type DeleteTarget =
  | { kind: "conversation"; id: string; title: string }
  | { kind: "transcription"; id: string; title: string }

export function Workspace() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const route = parseWorkspaceRoute(pathname ?? "/", searchParams)
  const activeView = route.view
  const requestedConversationId = route.conversationId
  const requestedSessionId = route.sessionId

  const [status, setStatus] = useState<WorkspaceStatus>("loading")
  const [loadError, setLoadError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [user, setUser] = useState<User | null>(null)
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [archivedConversations, setArchivedConversations] = useState<Conversation[]>([])
  const [transcriptionSessions, setTranscriptionSessions] = useState<TranscriptionSession[]>([])
  const [archivedTranscriptionSessions, setArchivedTranscriptionSessions] = useState<TranscriptionSession[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [servers, setServers] = useState<MCPServer[]>([])
  const [actionError, setActionError] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  const redirectToLogin = useCallback(() => {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(next)}`)
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      const [activeResult, archivedResult] = await Promise.all([
        api.get<{ conversations: Conversation[] }>("/api/v1/conversations"),
        api.get<{ conversations: Conversation[] }>(
          "/api/v1/conversations?archived=true"
        ),
      ])
      setConversations(activeResult.conversations)
      setArchivedConversations(archivedResult.conversations)
      return activeResult.conversations
    } catch (caught) {
      if (caught instanceof APIError && caught.status === 401) {
        redirectToLogin()
      }
      throw caught
    }
  }, [redirectToLogin, setConversations])

  const refreshTranscriptionSessions = useCallback(async () => {
    try {
      const [activeResult, archivedResult] = await Promise.all([
        api.get<{ sessions: TranscriptionSession[] }>(
          "/api/v1/transcription/sessions"
        ),
        api.get<{ sessions: TranscriptionSession[] }>(
          "/api/v1/transcription/sessions?archived=true"
        ),
      ])
      setTranscriptionSessions(activeResult.sessions)
      setArchivedTranscriptionSessions(archivedResult.sessions)
      return activeResult.sessions
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

        const storedOrganizationId = api.getOrganizationId()
        const nextOrganization =
          me.organizations.find((organization) => organization.id === storedOrganizationId) ??
          me.organizations[0] ??
          null
        api.setOrganizationId(nextOrganization?.id ?? null)
        setActiveOrganizationId(nextOrganization?.id ?? null)

        const [conversationResult, archivedConversationResult, transcriptionResult, archivedTranscriptionResult, endpointResult, sourceResult, serverResult] =
          await Promise.all([
            api.get<{ conversations: Conversation[] }>("/api/v1/conversations"),
            api.get<{ conversations: Conversation[] }>(
              "/api/v1/conversations?archived=true"
            ),
            api.get<{ sessions: TranscriptionSession[] }>("/api/v1/transcription/sessions"),
            api.get<{ sessions: TranscriptionSession[] }>(
              "/api/v1/transcription/sessions?archived=true"
            ),
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
        setArchivedConversations(archivedConversationResult.conversations)
        setTranscriptionSessions(transcriptionResult.sessions)
        setArchivedTranscriptionSessions(archivedTranscriptionResult.sessions)
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

  const activeOrganization = organizations.find(
    (organization) => organization.id === activeOrganizationId
  ) ?? organizations[0]
  const activeConversationId = [...conversations, ...archivedConversations].some(
    (conversation) => conversation.id === requestedConversationId
  )
    ? requestedConversationId
    : null
  const activeSessionId = [...transcriptionSessions, ...archivedTranscriptionSessions].some(
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
      const path = workspacePath(view, conversationId, sessionId)
      if (replace) {
        router.replace(path)
      } else {
        router.push(path)
      }
    },
    [router]
  )

  const selectOrganization = useCallback(
    (organizationId: string) => {
      if (!organizations.some((organization) => organization.id === organizationId)) {
        return
      }
      api.setOrganizationId(organizationId)
      setActiveOrganizationId(organizationId)
      setReloadToken((value) => value + 1)
    },
    [organizations]
  )

  const handleOrganizationCreated = useCallback((organization: Organization) => {
    setOrganizations((current) => [
      ...current.filter((item) => item.id !== organization.id),
      organization,
    ])
    api.setOrganizationId(organization.id)
    setActiveOrganizationId(organization.id)
    setReloadToken((value) => value + 1)
  }, [])

  const handleOrganizationUpdated = useCallback((organization: Organization) => {
    setOrganizations((current) =>
      current.map((item) => (item.id === organization.id ? organization : item))
    )
  }, [])

  const handleArchiveConversation = useCallback(
    async (conversationId: string, archived: boolean) => {
      setActionError("")
      try {
        await api.patch(`/api/v1/conversations/${conversationId}`, { archived })
        await refreshConversations()
        if (archived && requestedConversationId === conversationId) {
          navigate("chat")
        }
      } catch (caught) {
        setActionError(
          caught instanceof Error ? caught.message : "The conversation could not be updated."
        )
      }
    },
    [navigate, refreshConversations, requestedConversationId]
  )

  const handleDeleteConversation = useCallback((conversation: Conversation) => {
    setDeleteTarget({ kind: "conversation", id: conversation.id, title: conversation.title })
  }, [])

  const handleArchiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      setActionError("")
      try {
        await api.patch(`/api/v1/transcription/sessions/${sessionId}`, { archived })
        await refreshTranscriptionSessions()
        if (archived && requestedSessionId === sessionId) {
          navigate("transcription")
        }
      } catch (caught) {
        setActionError(
          caught instanceof Error ? caught.message : "The transcription session could not be updated."
        )
      }
    },
    [navigate, refreshTranscriptionSessions, requestedSessionId]
  )

  const handleDeleteSession = useCallback((session: TranscriptionSession) => {
    setDeleteTarget({ kind: "transcription", id: session.id, title: session.title })
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    setActionError("")
    try {
      if (target.kind === "conversation") {
        await api.delete(`/api/v1/conversations/${target.id}`)
        await refreshConversations()
        if (requestedConversationId === target.id) navigate("chat")
      } else {
        await api.delete(`/api/v1/transcription/sessions/${target.id}`)
        await refreshTranscriptionSessions()
        if (requestedSessionId === target.id) navigate("transcription")
      }
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : target.kind === "conversation"
            ? "The conversation could not be deleted."
            : "The transcription session could not be deleted."
      )
    }
  }, [deleteTarget, navigate, refreshConversations, refreshTranscriptionSessions, requestedConversationId, requestedSessionId])

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
      setArchivedTranscriptionSessions((current) =>
        current.filter((item) => item.id !== session.id)
      )
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
    <>
      <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className="gap-3">
          <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0">
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
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      tooltip={`${activeOrganization?.name ?? "Workspace"} organization`}
                      variant="outline"
                    />
                  }
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
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64" side="right">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {organizations.map((organization) => (
                      <DropdownMenuItem
                        key={organization.id}
                        onClick={() => selectOrganization(organization.id)}
                      >
                        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                          <Bot aria-hidden="true" />
                        </div>
                        <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                        {organization.id === activeOrganization?.id && (
                          <span className="text-xs text-muted-foreground">Current</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("settings")}>
                    <Settings2 data-icon="inline-start" />
                    <span>Manage workspaces</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {actionError && (
            <Alert className="mx-2 mt-2 group-data-[collapsible=icon]:hidden" variant="destructive">
              <AlertDescription className="text-xs">
                {actionError}
              </AlertDescription>
            </Alert>
          )}
          <SidebarGroup className="pb-1">
            <SidebarGroupContent>
              <div className="flex items-center gap-1">
                <SidebarMenu className="min-w-0 flex-1">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={activeView === "chat"}
                      render={<div aria-label="Chat" aria-level={2} role="heading" />}
                      tooltip="Chat"
                    >
                      <MessageSquare data-icon="inline-start" />
                      <span className="group-data-[collapsible=icon]:hidden">Chat</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
                <Button
                  aria-label="New chat"
                  className="h-8 shrink-0 gap-1 px-2 text-xs group-data-[collapsible=icon]:hidden"
                  onClick={() => navigate("chat")}
                  size="sm"
                  title="New chat"
                  variant="outline"
                >
                  <Plus data-icon="inline-start" />
                  <span>New chat</span>
                </Button>
              </div>
              <SidebarGroupLabel className="mt-1 h-7 px-2.5 text-[11px]">
                Conversations
              </SidebarGroupLabel>
              <SidebarMenuSub className="mt-0">
                {conversations.length === 0 ? (
                  <SidebarMenuSubItem>
                    <Empty className="min-h-0 rounded-md p-3">
                      <EmptyHeader>
                        <EmptyTitle>No conversations yet</EmptyTitle>
                        <EmptyDescription>
                          Start a new chat to create one.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </SidebarMenuSubItem>
                ) : (
                  conversations.map((conversation) => (
                    <ConversationSidebarItem
                      active={activeConversationId === conversation.id}
                      archived={false}
                      conversation={conversation}
                      key={conversation.id}
                      onArchive={handleArchiveConversation}
                      onDelete={handleDeleteConversation}
                      onSelect={(id) => navigate("chat", id)}
                    />
                  ))
                )}
              </SidebarMenuSub>
              {archivedConversations.length > 0 && (
                <>
                  <SidebarGroupLabel className="mt-2 h-7 px-2.5 text-[11px]">
                    Archived
                  </SidebarGroupLabel>
                  <SidebarMenuSub className="mt-0">
                    {archivedConversations.map((conversation) => (
                      <ConversationSidebarItem
                        active={activeConversationId === conversation.id}
                        archived
                        conversation={conversation}
                        key={conversation.id}
                        onArchive={handleArchiveConversation}
                        onDelete={handleDeleteConversation}
                        onSelect={(id) => navigate("chat", id)}
                      />
                    ))}
                  </SidebarMenuSub>
                </>
              )}
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="pt-1 pb-1">
            <SidebarGroupContent>
              <div className="flex items-center gap-1">
                <SidebarMenu className="min-w-0 flex-1">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={activeView === "transcription"}
                      render={<div aria-label="Live transcription" aria-level={2} role="heading" />}
                      tooltip="Live transcription"
                    >
                      <Headphones data-icon="inline-start" />
                      <span className="group-data-[collapsible=icon]:hidden">
                        Live transcription
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
                <Button
                  aria-label="New live transcription session"
                  className="h-8 shrink-0 gap-1 px-2 text-xs group-data-[collapsible=icon]:hidden"
                  onClick={() => navigate("transcription")}
                  size="sm"
                  title="New live transcription session"
                  variant="outline"
                >
                  <Plus data-icon="inline-start" />
                  <span>New session</span>
                </Button>
              </div>
              <SidebarGroupLabel className="mt-1 h-7 px-2.5 text-[11px]">
                Sessions
              </SidebarGroupLabel>
              <SidebarMenuSub className="mt-0">
                {transcriptionSessions.length === 0 ? (
                  <SidebarMenuSubItem>
                    <Empty className="min-h-0 rounded-md p-3">
                      <EmptyHeader>
                        <EmptyTitle>No sessions yet</EmptyTitle>
                        <EmptyDescription>
                          Start listening to create one.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </SidebarMenuSubItem>
                ) : (
                  transcriptionSessions.map((session) => (
                    <TranscriptionSidebarItem
                      active={activeSessionId === session.id}
                      archived={false}
                      key={session.id}
                      onArchive={handleArchiveSession}
                      onDelete={handleDeleteSession}
                      onSelect={(id) =>
                        navigate("transcription", null, false, id)
                      }
                      session={session}
                    />
                  ))
                )}
              </SidebarMenuSub>
              {archivedTranscriptionSessions.length > 0 && (
                <>
                  <SidebarGroupLabel className="mt-2 h-7 px-2.5 text-[11px]">
                    Archived
                  </SidebarGroupLabel>
                  <SidebarMenuSub className="mt-0">
                    {archivedTranscriptionSessions.map((session) => (
                      <TranscriptionSidebarItem
                        active={activeSessionId === session.id}
                        archived
                        key={session.id}
                        onArchive={handleArchiveSession}
                        onDelete={handleDeleteSession}
                        onSelect={(id) =>
                          navigate("transcription", null, false, id)
                        }
                        session={session}
                      />
                    ))}
                  </SidebarMenuSub>
                </>
              )}
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="pt-1">
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation
                  .filter((item) => item.id !== "chat" && item.id !== "transcription")
                  .map((item) => {
                    const ItemIcon = item.icon
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={item.id === activeView}
                          onClick={(event) => {
                            event.preventDefault()
                            navigate(item.id)
                          }}
                          tooltip={item.hint}
                        >
                          <ItemIcon data-icon="inline-start" />
                          <span className="group-data-[collapsible=icon]:hidden">
                            {item.label}
                          </span>
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
                    <span className="group-data-[collapsible=icon]:hidden">Settings</span>
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
                    <span className="group-data-[collapsible=icon]:hidden">Docs &amp; guides</span>
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
                <span className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
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
              : activeView === "chat"
                ? "mx-auto flex h-svh min-h-0 w-full max-w-[1440px] flex-col p-4 sm:p-6 lg:p-8"
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
            <SettingsView
              activeOrganizationId={activeOrganization?.id ?? null}
              onOrganizationCreated={handleOrganizationCreated}
              onOrganizationSelect={selectOrganization}
              onOrganizationUpdated={handleOrganizationUpdated}
              organizations={organizations}
              user={user}
            />
          )}
        </div>
      </SidebarInset>
      </SidebarProvider>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        open={deleteTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.kind === "conversation" ? "chat" : "live transcription"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title}” and its stored data will be permanently removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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

function ConversationSidebarItem({
  active,
  archived,
  conversation,
  onArchive,
  onDelete,
  onSelect,
}: {
  active: boolean
  archived: boolean
  conversation: Conversation
  onArchive: (id: string, archived: boolean) => void
  onDelete: (conversation: Conversation) => void
  onSelect: (id: string) => void
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        className="pr-8"
        href={workspacePath("chat", conversation.id)}
        isActive={active}
        onClick={(event) => {
          event.preventDefault()
          onSelect(conversation.id)
        }}
        title={`${conversation.title} · ${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-border" />
        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatConversationTime(conversation.updatedAt)}
        </span>
      </SidebarMenuSubButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Actions for ${conversation.title}`}
              className="group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100"
              showOnHover
              title={`Actions for ${conversation.title}`}
            />
          }
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40" side="right">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => onArchive(conversation.id, !archived)}
            >
              {archived ? (
                <RotateCcw data-icon="inline-start" />
              ) : (
                <Archive data-icon="inline-start" />
              )}
              <span>{archived ? "Restore" : "Archive"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onDelete(conversation)}
              variant="destructive"
            >
              <Trash2 data-icon="inline-start" />
              <span>Delete</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuSubItem>
  )
}

function TranscriptionSidebarItem({
  active,
  archived,
  onArchive,
  onDelete,
  onSelect,
  session,
}: {
  active: boolean
  archived: boolean
  onArchive: (id: string, archived: boolean) => void
  onDelete: (session: TranscriptionSession) => void
  onSelect: (id: string) => void
  session: TranscriptionSession
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        className="pr-8"
        href={workspacePath("transcription", null, session.id)}
        isActive={active}
        onClick={(event) => {
          event.preventDefault()
          onSelect(session.id)
        }}
        title={`${session.title} · ${session.status}`}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${session.status === "live" ? "bg-primary" : "bg-border"}`}
        />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatConversationTime(session.updatedAt)}
        </span>
      </SidebarMenuSubButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Actions for ${session.title}`}
              className="group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:opacity-100"
              showOnHover
              title={`Actions for ${session.title}`}
            />
          }
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40" side="right">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => onArchive(session.id, !archived)}>
              {archived ? (
                <RotateCcw data-icon="inline-start" />
              ) : (
                <Archive data-icon="inline-start" />
              )}
              <span>{archived ? "Restore" : "Archive"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onDelete(session)}
              variant="destructive"
            >
              <Trash2 data-icon="inline-start" />
              <span>Delete</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuSubItem>
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
