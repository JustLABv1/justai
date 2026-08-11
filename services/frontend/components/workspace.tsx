"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

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
import { Button } from "@/components/ui/button"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
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
import { parseWorkspaceRoute, workspacePath } from "@/lib/workspace-routes"
import { WorkspaceSidebar } from "@/components/workspace-sidebar"

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
  const [activeOrganizationId, setActiveOrganizationId] = useState<
    string | null
  >(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [archivedConversations, setArchivedConversations] = useState<
    Conversation[]
  >([])
  const [transcriptionSessions, setTranscriptionSessions] = useState<
    TranscriptionSession[]
  >([])
  const [archivedTranscriptionSessions, setArchivedTranscriptionSessions] =
    useState<TranscriptionSession[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [servers, setServers] = useState<MCPServer[]>([])
  const [actionError, setActionError] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [createTranscriptionRequested, setCreateTranscriptionRequested] =
    useState(false)

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
          me.organizations.find(
            (organization) => organization.id === storedOrganizationId
          ) ??
          me.organizations[0] ??
          null
        api.setOrganizationId(nextOrganization?.id ?? null)
        setActiveOrganizationId(nextOrganization?.id ?? null)

        const [
          conversationResult,
          archivedConversationResult,
          transcriptionResult,
          archivedTranscriptionResult,
          endpointResult,
          sourceResult,
          serverResult,
        ] = await Promise.all([
          api.get<{ conversations: Conversation[] }>("/api/v1/conversations"),
          api.get<{ conversations: Conversation[] }>(
            "/api/v1/conversations?archived=true"
          ),
          api.get<{ sessions: TranscriptionSession[] }>(
            "/api/v1/transcription/sessions"
          ),
          api.get<{ sessions: TranscriptionSession[] }>(
            "/api/v1/transcription/sessions?archived=true"
          ),
          api.get<{ endpoints: Endpoint[] }>("/api/v1/endpoints"),
          api.get<{ sources: KnowledgeSource[] }>("/api/v1/knowledge/sources"),
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

  const activeOrganization =
    organizations.find(
      (organization) => organization.id === activeOrganizationId
    ) ?? organizations[0]
  const activeConversationId = [
    ...conversations,
    ...archivedConversations,
  ].some((conversation) => conversation.id === requestedConversationId)
    ? requestedConversationId
    : null
  const activeConversation = [...conversations, ...archivedConversations].find(
    (conversation) => conversation.id === activeConversationId
  )
  const activeSessionId = [
    ...transcriptionSessions,
    ...archivedTranscriptionSessions,
  ].some((session) => session.id === requestedSessionId)
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
      if (
        !organizations.some(
          (organization) => organization.id === organizationId
        )
      ) {
        return
      }
      api.setOrganizationId(organizationId)
      setActiveOrganizationId(organizationId)
      setReloadToken((value) => value + 1)
    },
    [organizations]
  )

  const handleOrganizationCreated = useCallback(
    (organization: Organization) => {
      setOrganizations((current) => [
        ...current.filter((item) => item.id !== organization.id),
        organization,
      ])
      api.setOrganizationId(organization.id)
      setActiveOrganizationId(organization.id)
      setReloadToken((value) => value + 1)
    },
    []
  )

  const handleOrganizationUpdated = useCallback(
    (organization: Organization) => {
      setOrganizations((current) =>
        current.map((item) =>
          item.id === organization.id ? organization : item
        )
      )
    },
    []
  )

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
          caught instanceof Error
            ? caught.message
            : "The conversation could not be updated."
        )
      }
    },
    [navigate, refreshConversations, requestedConversationId]
  )

  const handleDeleteConversation = useCallback((conversation: Conversation) => {
    setDeleteTarget({
      kind: "conversation",
      id: conversation.id,
      title: conversation.title,
    })
  }, [])

  const handleArchiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      setActionError("")
      try {
        await api.patch(`/api/v1/transcription/sessions/${sessionId}`, {
          archived,
        })
        await refreshTranscriptionSessions()
        if (archived && requestedSessionId === sessionId) {
          navigate("transcription")
        }
      } catch (caught) {
        setActionError(
          caught instanceof Error
            ? caught.message
            : "The transcription session could not be updated."
        )
      }
    },
    [navigate, refreshTranscriptionSessions, requestedSessionId]
  )

  const handleDeleteSession = useCallback((session: TranscriptionSession) => {
    setDeleteTarget({
      kind: "transcription",
      id: session.id,
      title: session.title,
    })
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
  }, [
    deleteTarget,
    navigate,
    refreshConversations,
    refreshTranscriptionSessions,
    requestedConversationId,
    requestedSessionId,
  ])

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

  const handleNewTranscriptionSession = useCallback(() => {
    setCreateTranscriptionRequested(true)
    navigate("transcription")
  }, [navigate])

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
        <WorkspaceSidebar
          activeConversationId={activeConversationId}
          activeOrganization={activeOrganization}
          activeSessionId={activeSessionId}
          activeView={activeView}
          actionError={actionError}
          archivedConversations={archivedConversations}
          archivedTranscriptionSessions={archivedTranscriptionSessions}
          conversations={conversations}
          onArchiveConversation={handleArchiveConversation}
          onArchiveSession={handleArchiveSession}
          onDeleteConversation={handleDeleteConversation}
          onDeleteSession={handleDeleteSession}
          onNewTranscriptionSession={handleNewTranscriptionSession}
          onNavigate={(view, conversationId = null, sessionId = null) =>
            navigate(view, conversationId, false, sessionId)
          }
          onOrganizationSelect={selectOrganization}
          onSignOut={() => void signOut()}
          organizations={organizations}
          transcriptionSessions={transcriptionSessions}
          user={user}
          userInitials={initials}
        />
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-sm">
            <SidebarTrigger
              aria-label="Toggle navigation"
              className="border border-border/70 bg-background/80 shadow-xs"
              title="Toggle navigation (⌘B)"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {getViewTitle(activeView)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {activeView === "chat"
                  ? (activeConversation?.title ?? "Start a new conversation")
                  : getViewSubtitle(activeView)}
              </p>
            </div>
          </header>
          <div
            className={
              activeView === "transcription"
                ? "flex min-h-0 w-full flex-1"
                : activeView === "chat"
                  ? "mx-auto flex min-h-0 w-full max-w-[1440px] flex-1 flex-col p-4 sm:p-6 lg:p-8"
                  : "mx-auto w-full max-w-[1440px] flex-1 p-4 sm:p-6 lg:p-8"
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
                onCreateSessionRequestHandled={() =>
                  setCreateTranscriptionRequested(false)
                }
                createSessionRequested={createTranscriptionRequested}
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
              Delete{" "}
              {deleteTarget?.kind === "conversation"
                ? "chat"
                : "live transcription"}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title}” and its stored data will be permanently
              removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDelete()}
            >
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

function getViewTitle(view: ViewId) {
  switch (view) {
    case "chat":
      return "Chat"
    case "transcription":
      return "Live transcription"
    case "endpoints":
      return "Endpoints"
    case "knowledge":
      return "Knowledge"
    case "mcp":
      return "MCP"
    case "settings":
      return "Settings"
  }
}

function getViewSubtitle(view: ViewId) {
  switch (view) {
    case "transcription":
      return "Listen to a room and keep the transcript close"
    case "endpoints":
      return "Models and provider connections"
    case "knowledge":
      return "Sources available to your workspace"
    case "mcp":
      return "Tools and external connections"
    case "settings":
      return "Workspace preferences and members"
    case "chat":
      return "Start a new conversation"
  }
}
