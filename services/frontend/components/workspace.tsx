"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChatView } from "@/components/chat-view"
import { BrandMark } from "@/components/brand-mark"
import { LiveTranscriptionView } from "@/components/live-transcription-view"
import { ProfileView } from "@/components/profile-view"
import { SettingsShell } from "@/components/settings-shell"
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
import { cn } from "@/lib/utils"
import { FocusWorkspaceSidebar } from "@/components/focus-workspace-sidebar"
import { WorkspaceContext } from "@/components/workspace-context"

type WorkspaceStatus = "loading" | "ready" | "error"

type DeleteTarget =
  | { kind: "conversation"; id: string; title: string }
  | { kind: "transcription"; id: string; title: string }

const HISTORY_OPEN_STORAGE_KEY = "justai.chat-history-open"

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
  const [featureErrors, setFeatureErrors] = useState<Record<string, string>>({})
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
  const [historyOpen, setHistoryOpen] = useState(true)
  const [historyPreferenceLoaded, setHistoryPreferenceLoaded] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [pendingConversationId, setPendingConversationId] = useState<
    string | null
  >(null)
  const conversationCreationRef = useRef<Promise<string> | null>(null)
  const activeConversationRef = useRef<string | null>(requestedConversationId)
  const pendingConversationIdRef = useRef<string | null>(null)
  const hydratedConversationRef = useRef<string | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(HISTORY_OPEN_STORAGE_KEY)
      if (stored !== null) {
        setHistoryOpen(stored !== "false")
      }
      setHistoryPreferenceLoaded(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!historyPreferenceLoaded) return
    window.localStorage.setItem(
      HISTORY_OPEN_STORAGE_KEY,
      historyOpen ? "true" : "false"
    )
  }, [historyOpen, historyPreferenceLoaded])

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
        setUser(me.user)
        setOrganizations(me.organizations)
        // Do not retain the previous organization's resources while a partial
        // reload is in flight or if one feature endpoint fails.
        setConversations([])
        setArchivedConversations([])
        setTranscriptionSessions([])
        setArchivedTranscriptionSessions([])
        setEndpoints([])
        setSources([])
        setServers([])

        const results = await Promise.allSettled([
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

        const errors: Record<string, string> = {}
        if (
          results.some(
            (result) =>
              result.status === "rejected" &&
              result.reason instanceof APIError &&
              result.reason.status === 401
          )
        ) {
          redirectToLogin()
          return
        }
        const valueAt = <T,>(index: number, key: string): T | null => {
          const result = results[index]
          if (result.status === "fulfilled") return result.value as T
          errors[key] =
            result.reason instanceof Error
              ? result.reason.message
              : "This section could not be loaded."
          return null
        }
        const conversationResult = valueAt<{ conversations: Conversation[] }>(
          0,
          "chat"
        )
        const archivedConversationResult = valueAt<{
          conversations: Conversation[]
        }>(1, "chat")
        const transcriptionResult = valueAt<{
          sessions: TranscriptionSession[]
        }>(2, "transcription")
        const archivedTranscriptionResult = valueAt<{
          sessions: TranscriptionSession[]
        }>(3, "transcription")
        const endpointResult = valueAt<{ endpoints: Endpoint[] }>(
          4,
          "endpoints"
        )
        const sourceResult = valueAt<{ sources: KnowledgeSource[] }>(
          5,
          "knowledge"
        )
        const serverResult = valueAt<{ servers: MCPServer[] }>(6, "mcp")
        if (conversationResult)
          setConversations(conversationResult.conversations)
        if (archivedConversationResult)
          setArchivedConversations(archivedConversationResult.conversations)
        if (transcriptionResult)
          setTranscriptionSessions(transcriptionResult.sessions)
        if (archivedTranscriptionResult)
          setArchivedTranscriptionSessions(archivedTranscriptionResult.sessions)
        if (endpointResult) setEndpoints(endpointResult.endpoints)
        if (sourceResult) setSources(sourceResult.sources)
        if (serverResult) setServers(serverResult.servers)
        setFeatureErrors(errors)
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
  const activeConversationId = requestedConversationId ?? pendingConversationId

  useEffect(() => {
    activeConversationRef.current =
      requestedConversationId ?? pendingConversationId
  }, [pendingConversationId, requestedConversationId])

  useEffect(() => {
    if (
      !requestedConversationId ||
      status !== "ready" ||
      !activeOrganizationId
    ) {
      return
    }
    const hydrationKey = `${activeOrganizationId}:${requestedConversationId}`
    if (hydratedConversationRef.current === hydrationKey) return
    hydratedConversationRef.current = hydrationKey
    let cancelled = false
    void api
      .get<{ conversation: Conversation }>(
        `/api/v1/conversations/${requestedConversationId}`
      )
      .then(({ conversation }) => {
        if (cancelled) return
        if (conversation.archivedAt) {
          setArchivedConversations((current) => [
            conversation,
            ...current.filter((item) => item.id !== conversation.id),
          ])
        } else {
          setConversations((current) => [
            conversation,
            ...current.filter((item) => item.id !== conversation.id),
          ])
        }
      })
      .catch((caught) => {
        if (cancelled) return
        const statusCode =
          caught instanceof APIError
            ? caught.status
            : typeof caught === "object" &&
                caught !== null &&
                "status" in caught
              ? Number((caught as { status?: unknown }).status)
              : undefined
        // The conversation lookup is only supplemental hydration for direct
        // URLs. Older backend processes may not expose this endpoint yet;
        // ChatView still loads the canonical message/context endpoints and
        // handles a truly missing conversation there.
        if (statusCode !== 404)
          console.error("Conversation metadata could not be loaded", caught)
      })
    return () => {
      cancelled = true
    }
  }, [activeOrganizationId, requestedConversationId, status])
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
      sessionId: string | null = null,
      settingsTab: import("@/lib/types").SettingsTab = "workspace"
    ) => {
      if (view !== "chat") setContextOpen(false)
      if (view === "chat") {
        activeConversationRef.current = conversationId
        pendingConversationIdRef.current = null
        setPendingConversationId(null)
      }
      const path = workspacePath(view, conversationId, sessionId, settingsTab)
      if (replace) {
        router.replace(path)
      } else {
        router.push(path)
      }
    },
    [router]
  )

  const ensureConversationForContext = useCallback(async () => {
    // A root chat is intentionally pending until its first message or
    // attachment needs a server conversation. Clear a stale route id before
    // deciding whether there is already a conversation to reuse.
    if (!requestedConversationId && pendingConversationIdRef.current) {
      activeConversationRef.current = pendingConversationIdRef.current
      return pendingConversationIdRef.current
    }
    if (!requestedConversationId && !pendingConversationId) {
      activeConversationRef.current = null
    }
    if (activeConversationRef.current) return activeConversationRef.current
    if (conversationCreationRef.current) return conversationCreationRef.current

    const creation = api
      .post<{ conversation: Conversation }>("/api/v1/conversations")
      .then((result) => {
        activeConversationRef.current = result.conversation.id
        pendingConversationIdRef.current = result.conversation.id
        setPendingConversationId(result.conversation.id)
        setConversations((current) => [
          result.conversation,
          ...current.filter((item) => item.id !== result.conversation.id),
        ])
        return result.conversation.id
      })
      .finally(() => {
        conversationCreationRef.current = null
      })
    conversationCreationRef.current = creation
    return creation
  }, [pendingConversationId, requestedConversationId])

  const settlePendingConversation = useCallback(() => {
    const id = pendingConversationIdRef.current
    if (!id || requestedConversationId) return
    pendingConversationIdRef.current = null
    setPendingConversationId(null)
    navigate("chat", id, true)
  }, [navigate, requestedConversationId])

  const handleConversationMissing = useCallback(() => {
    const missingId =
      requestedConversationId ?? pendingConversationIdRef.current
    if (missingId) {
      setConversations((current) =>
        current.filter((conversation) => conversation.id !== missingId)
      )
      setArchivedConversations((current) =>
        current.filter((conversation) => conversation.id !== missingId)
      )
    }
    pendingConversationIdRef.current = null
    setPendingConversationId(null)
    navigate("chat", null, true)
  }, [navigate, requestedConversationId])

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

  const handleRenameConversation = useCallback(
    async (conversationId: string, title: string) => {
      setActionError("")
      try {
        await api.patch(`/api/v1/conversations/${conversationId}`, { title })
        await refreshConversations()
      } catch (caught) {
        const error =
          caught instanceof Error
            ? caught
            : new Error("The conversation could not be renamed.")
        setActionError(error.message)
        throw error
      }
    },
    [refreshConversations]
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
      <div className="relative flex h-svh min-h-0 overflow-hidden bg-background">
        <FocusWorkspaceSidebar
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
          onRenameConversation={handleRenameConversation}
          onNewTranscriptionSession={handleNewTranscriptionSession}
          onNavigate={(
            view,
            conversationId = null,
            sessionId = null,
            settingsTab = "workspace"
          ) => navigate(view, conversationId, false, sessionId, settingsTab)}
          historyOpen={historyOpen}
          onHistoryOpenChange={setHistoryOpen}
          onOrganizationSelect={selectOrganization}
          onSignOut={() => void signOut()}
          organizations={organizations}
          transcriptionSessions={transcriptionSessions}
          user={user}
          userInitials={initials}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {Object.keys(featureErrors).length > 0 && (
            <Alert className="m-4 mb-0 shrink-0" variant="destructive">
              <AlertTitle>Some workspace features need attention</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {Object.entries(featureErrors).map(([key, message]) => (
                  <span key={key}>
                    {key}: {message}
                  </span>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReloadToken((value) => value + 1)}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div
            className={cn(
              "min-h-0 w-full flex-1",
              activeView === "transcription"
                ? "flex overflow-hidden"
                : activeView === "chat"
                  ? "flex flex-col overflow-hidden"
                  : "mx-auto max-w-[1440px] overflow-y-auto p-4 sm:p-6 lg:p-8"
            )}
          >
            {activeView === "chat" && (
              <ChatView
                conversationId={activeConversationId}
                endpoints={endpoints}
                onEnsureConversation={ensureConversationForContext}
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
                onConversationSettled={settlePendingConversation}
                onConversationMissing={handleConversationMissing}
                onNavigate={(view) => navigate(view, null)}
                onOpenHistory={() => setHistoryOpen(true)}
                onOpenContext={() => setContextOpen((current) => !current)}
                contextOpen={contextOpen}
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
            {activeView === "settings" && (
              <SettingsShell
                activeOrganizationId={activeOrganization?.id ?? null}
                activeTab={route.settingsTab}
                endpoints={endpoints}
                knowledgeSources={sources}
                mcpServers={servers}
                onOrganizationSelect={selectOrganization}
                onOrganizationCreated={handleOrganizationCreated}
                onOrganizationUpdated={handleOrganizationUpdated}
                onEndpointsChange={setEndpoints}
                onKnowledgeChange={setSources}
                onMCPChange={setServers}
                onTabChange={(tab) =>
                  navigate("settings", null, false, null, tab)
                }
                organizations={organizations}
                user={user}
              />
            )}
            {activeView === "profile" && <ProfileView user={user} />}
          </div>
        </main>
        {activeView === "chat" && contextOpen && (
          <WorkspaceContext
            conversationId={activeConversationId}
            onEnsureConversation={ensureConversationForContext}
            onClose={() => setContextOpen(false)}
            onNavigate={(view) => navigate(view, null)}
            servers={servers}
            sources={sources}
            transcriptionSessions={transcriptionSessions}
          />
        )}
      </div>
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
