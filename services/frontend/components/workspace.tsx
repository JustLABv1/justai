"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Info } from "lucide-react"
import { ChatView } from "@/components/chat-view"
import { BrandMark } from "@/components/brand-mark"
import { LiveTranscriptionView } from "@/components/live-transcription-view"
import { MemoryView } from "@/components/memory-view"
import { NotesView } from "@/components/notes-view"
import { ProfileView } from "@/components/profile-view"
import { PlatformAdminShell } from "@/components/platform-admin-shell"
import { SettingsShell } from "@/components/settings-shell"
import { VideoTranscriptionView } from "@/components/video-transcription-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AssistantsView } from "@/components/assistants-view"
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
  AdminTab,
  TranscriptionSession,
  Note,
  SavedAssistant,
  WorkspaceProject,
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
  const [disabledFeatures, setDisabledFeatures] = useState<
    Record<string, string>
  >({})
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
  const [notes, setNotes] = useState<Note[]>([])
  const [savedAssistants, setSavedAssistants] = useState<SavedAssistant[]>([])
  const [projects, setProjects] = useState<WorkspaceProject[]>([])
  const [draftAssistantId, setDraftAssistantId] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [createTranscriptionRequested, setCreateTranscriptionRequested] =
    useState(false)
  const [
    createVideoTranscriptionRequested,
    setCreateVideoTranscriptionRequested,
  ] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [historyPreferenceLoaded, setHistoryPreferenceLoaded] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [pendingConversationId, setPendingConversationId] = useState<
    string | null
  >(null)
  const [pendingConversation, setPendingConversation] =
    useState<Conversation | null>(null)
  const [conversationRouteTarget, setConversationRouteTarget] = useState<{
    id: string | null
  } | null>(null)
  const conversationCreationRef = useRef<Promise<string> | null>(null)
  const activeConversationRef = useRef<string | null>(requestedConversationId)
  const pendingConversationIdRef = useRef<string | null>(null)
  const pendingConversationRef = useRef<Conversation | null>(null)
  const pendingConversationAddedRef = useRef(false)
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
        api.get<{ conversations: Conversation[] }>(
          "/api/v1/conversations?organized=true",
          { cache: "no-store" }
        ),
        api.get<{ conversations: Conversation[] }>(
          "/api/v1/conversations?archived=true&organized=true",
          { cache: "no-store" }
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

  useEffect(() => {
    if (status !== "ready" || activeView === "admin" || !activeOrganizationId) {
      return
    }

    let disposed = false
    let refreshInFlight = false

    const refresh = () => {
      if (
        disposed ||
        refreshInFlight ||
        document.visibilityState === "hidden"
      ) {
        return
      }
      refreshInFlight = true
      void refreshConversations()
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = false
        })
    }

    const handleFocus = () => refresh()
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh()
    }

    window.addEventListener("focus", handleFocus)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    const interval = window.setInterval(refresh, 15_000)

    // Fetch once after the initial workspace load so a tab that was opened
    // while another browser was creating a chat immediately converges on the
    // server's current list.
    refresh()

    return () => {
      disposed = true
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.clearInterval(interval)
    }
  }, [activeOrganizationId, activeView, refreshConversations, status])

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
        setNotes([])
        setSavedAssistants([])
        setProjects([])

        // The platform-admin shell is intentionally independent from the
        // active workspace. Avoid loading workspace resources (and emitting
        // misleading feature-gate errors) when a platform administrator does
        // not belong to an organization.
        const results =
          activeView === "admin"
            ? []
            : await Promise.allSettled([
                api.get<{ conversations: Conversation[] }>(
                  "/api/v1/conversations?organized=true",
                  { cache: "no-store" }
                ),
                api.get<{ conversations: Conversation[] }>(
                  "/api/v1/conversations?archived=true&organized=true",
                  { cache: "no-store" }
                ),
                api.get<{ sessions: TranscriptionSession[] }>(
                  "/api/v1/transcription/sessions"
                ),
                api.get<{ sessions: TranscriptionSession[] }>(
                  "/api/v1/transcription/sessions?archived=true"
                ),
                api.get<{ endpoints: Endpoint[] }>("/api/v1/endpoints"),
                api.get<{ sources: KnowledgeSource[] }>(
                  "/api/v1/knowledge/sources"
                ),
                api.get<{ servers: MCPServer[] }>("/api/v1/mcp/servers"),
                api.get<{ notes: Note[] }>("/api/v1/notes"),
                api.get<{ assistants: SavedAssistant[] }>("/api/v1/assistants"),
                api.get<{ projects: WorkspaceProject[] }>("/api/v1/projects"),
              ])
        if (cancelled) return

        if (activeView === "admin") {
          setFeatureErrors({})
          setDisabledFeatures({})
          setStatus("ready")
          return
        }

        const errors: Record<string, string> = {}
        const disabled: Record<string, string> = {}
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
          if (
            result.reason instanceof APIError &&
            result.reason.code === "feature_disabled"
          ) {
            disabled[key] = result.reason.message
            return null
          }
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
        const notesResult = valueAt<{ notes: Note[] }>(7, "notes")
        const assistantResult = valueAt<{ assistants: SavedAssistant[] }>(
          8,
          "assistants"
        )
        const projectResult = valueAt<{ projects: WorkspaceProject[] }>(
          9,
          "projects"
        )
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
        if (notesResult) setNotes(notesResult.notes)
        if (assistantResult) setSavedAssistants(assistantResult.assistants)
        if (projectResult) setProjects(projectResult.projects)
        setFeatureErrors(errors)
        setDisabledFeatures(disabled)
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
  }, [activeView, redirectToLogin, reloadToken])

  // `/settings?tab=admin` was the old platform-admin entry point. Keep the
  // organization Operations page for ordinary workspace owners/admins, but
  // move platform administrators to the dedicated control plane.
  useEffect(() => {
    if (
      status === "ready" &&
      activeView === "settings" &&
      route.settingsTab === "admin" &&
      user?.platformAdmin
    ) {
      router.replace("/admin")
    }
  }, [activeView, route.settingsTab, router, status, user?.platformAdmin])

  useEffect(() => {
    if (status === "ready" && activeView === "admin" && !user?.platformAdmin) {
      router.replace("/")
    }
  }, [activeView, router, status, user?.platformAdmin])

  const activeOrganization =
    organizations.find(
      (organization) => organization.id === activeOrganizationId
    ) ?? organizations[0]
  const activeConversationId =
    conversationRouteTarget !== null
      ? conversationRouteTarget.id
      : (requestedConversationId ?? pendingConversationId)
  // Attachment uploads create the conversation before the first message, so
  // it is not in the history list yet. Keep its assistant metadata available
  // while the pending chat surface is mounted.
  const activeConversation =
    [...conversations, ...archivedConversations].find(
      (conversation) => conversation.id === activeConversationId
    ) ??
    (pendingConversationId === activeConversationId
      ? (pendingConversation ?? undefined)
      : undefined)

  useEffect(() => {
    activeConversationRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    if (
      conversationRouteTarget === null ||
      requestedConversationId !== conversationRouteTarget.id
    ) {
      return
    }
    const settledTarget = conversationRouteTarget
    queueMicrotask(() => {
      setConversationRouteTarget((current) =>
        current === settledTarget ? null : current
      )
    })
  }, [conversationRouteTarget, requestedConversationId])

  useEffect(() => {
    // The native History API updates the pathname without a server
    // navigation. Clear the local handoff state only after usePathname has
    // confirmed that the durable conversation route is active.
    if (
      !requestedConversationId ||
      pendingConversationIdRef.current !== requestedConversationId
    ) {
      return
    }
    pendingConversationIdRef.current = null
    pendingConversationRef.current = null
    pendingConversationAddedRef.current = false
    setPendingConversationId(null)
    setPendingConversation(null)
  }, [requestedConversationId])

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
  const activeSession = [
    ...transcriptionSessions,
    ...archivedTranscriptionSessions,
  ].find((session) => session.id === activeSessionId)
  const sessionViewMatches =
    !activeSession ||
    (activeView === "video-transcription"
      ? activeSession.kind === "video"
      : activeView === "transcription"
        ? activeSession.kind !== "video"
        : true)

  useEffect(() => {
    if (status !== "ready" || !activeSession || !requestedSessionId) return
    const expectedView =
      activeSession.kind === "video" ? "video-transcription" : "transcription"
    if (activeView === expectedView) return
    router.replace(workspacePath(expectedView, null, activeSession.id), {
      scroll: false,
    })
  }, [activeSession, activeView, requestedSessionId, router, status])

  const initials = useMemo(() => {
    if (!user) return "?"
    return user.displayName
      .split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  }, [user])

  const workspaceViewKey =
    activeView === "settings"
      ? `${activeView}:${route.settingsTab}`
      : activeView === "admin"
        ? `${activeView}:${route.adminTab}`
        : activeView

  const navigate = useCallback(
    (
      view: ViewId,
      conversationId: string | null = null,
      replace = false,
      sessionId: string | null = null,
      settingsTab: import("@/lib/types").SettingsTab = "workspace",
      adminTab: AdminTab = "overview"
    ) => {
      if (view !== "chat") {
        setContextOpen(false)
        setConversationRouteTarget(null)
      }
      const isInternalChatReplace =
        view === "chat" && replace && conversationId !== null
      if (view === "chat") {
        if (conversationId === null) setDraftAssistantId(null)
        activeConversationRef.current = conversationId
        if (!isInternalChatReplace) {
          setConversationRouteTarget({ id: conversationId })
          pendingConversationIdRef.current = null
          pendingConversationRef.current = null
          pendingConversationAddedRef.current = false
          setPendingConversationId(null)
          setPendingConversation(null)
        }
      }
      const path = workspacePath(
        view,
        conversationId,
        sessionId,
        settingsTab,
        adminTab
      )

      // A newly-created chat is already mounted in the current Assistant UI
      // runtime. Replacing the URL through the App Router would request a new
      // RSC payload while a response is streaming, which looks like a page
      // refresh and can briefly rebuild the thread. The native History API is
      // integrated with Next's App Router and keeps this same-view handoff
      // client-side.
      if (isInternalChatReplace) {
        if (
          typeof window !== "undefined" &&
          `${window.location.pathname}${window.location.search}` !== path
        ) {
          window.history.replaceState(window.history.state, "", path)
        }
        return
      }

      if (replace) {
        router.replace(path, { scroll: false })
      } else {
        router.push(path, { scroll: false })
      }
    },
    [router]
  )

  const promotePendingConversation = useCallback(
    (id: string) => {
      if (!pendingConversationAddedRef.current) {
        const conversation = pendingConversationRef.current
        if (conversation) {
          setConversations((current) => [
            conversation,
            ...current.filter((item) => item.id !== conversation.id),
          ])
        }
        pendingConversationAddedRef.current = true
      }
      // Keep the pending id alive until the route catches up. This preserves
      // the mounted chat runtime while the first message is being sent.
      navigate("chat", id, true)
    },
    [navigate]
  )

  const ensureConversationForContext = useCallback(
    async ({
      activate = true,
      assistantId,
      inheritRepositories,
    }: {
      activate?: boolean
      assistantId?: string | null
      inheritRepositories?: boolean
    } = {}) => {
      const selectedAssistantId =
        assistantId !== undefined ? assistantId : draftAssistantId
      // A root chat can hold a server-side context draft without changing the
      // URL. The draft is promoted to a normal history item only when the
      // user sends the first message (or another action explicitly activates
      // it).
      if (!requestedConversationId && pendingConversationIdRef.current) {
        const id = pendingConversationIdRef.current
        activeConversationRef.current = id
        if (activate) promotePendingConversation(id)
        return id
      }
      if (!requestedConversationId && !pendingConversationId) {
        activeConversationRef.current = null
      }
      if (activeConversationRef.current) return activeConversationRef.current

      if (conversationCreationRef.current) {
        const id = await conversationCreationRef.current
        if (activate) promotePendingConversation(id)
        return id
      }

      const creation = api
        .post<{ conversation: Conversation }>("/api/v1/conversations", {
          assistantId: selectedAssistantId || undefined,
          inheritRepositories: inheritRepositories === true,
        })
        .then((result) => {
          activeConversationRef.current = result.conversation.id
          pendingConversationIdRef.current = result.conversation.id
          pendingConversationRef.current = result.conversation
          pendingConversationAddedRef.current = false
          setPendingConversationId(result.conversation.id)
          setPendingConversation(result.conversation)
          return result.conversation.id
        })
        .finally(() => {
          conversationCreationRef.current = null
        })
      conversationCreationRef.current = creation
      const id = await creation
      if (activate) promotePendingConversation(id)
      return id
    },
    [
      navigate,
      draftAssistantId,
      pendingConversationId,
      promotePendingConversation,
      requestedConversationId,
    ]
  )

  const settlePendingConversation = useCallback(() => {
    const id = pendingConversationIdRef.current
    if (!id) return
    if (requestedConversationId === id) {
      pendingConversationIdRef.current = null
      pendingConversationRef.current = null
      pendingConversationAddedRef.current = false
      setPendingConversationId(null)
      setPendingConversation(null)
      return
    }
    if (requestedConversationId) return
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
    pendingConversationRef.current = null
    pendingConversationAddedRef.current = false
    setPendingConversationId(null)
    setPendingConversation(null)
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

  const handleShareConversation = useCallback(
    async (conversationId: string, visibility: "private" | "workspace") => {
      setActionError("")
      try {
        await api.patch(`/api/v1/conversations/${conversationId}`, {
          visibility,
        })
        await refreshConversations()
      } catch (caught) {
        setActionError(
          caught instanceof Error
            ? caught.message
            : "The conversation sharing setting could not be updated."
        )
        throw caught
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
          navigate(
            activeView === "video-transcription"
              ? "video-transcription"
              : "transcription"
          )
        }
      } catch (caught) {
        setActionError(
          caught instanceof Error
            ? caught.message
            : "The transcription session could not be updated."
        )
      }
    },
    [activeView, navigate, refreshTranscriptionSessions, requestedSessionId]
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
        if (requestedSessionId === target.id) {
          navigate(
            activeView === "video-transcription"
              ? "video-transcription"
              : "transcription"
          )
        }
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
    activeView,
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

  const handleUseNoteInChat = useCallback(
    async (note: Note) => {
      const conversationId = await ensureConversationForContext()
      const saved = await api.patch<{ note: Note }>(
        `/api/v1/notes/${note.id}`,
        {
          title: note.title,
          content: note.content,
        }
      )
      setNotes((current) =>
        current.map((item) => (item.id === saved.note.id ? saved.note : item))
      )
      await api.post(
        `/api/v1/conversations/${conversationId}/context/notes/${note.id}`
      )
      navigate("chat", conversationId)
    },
    [ensureConversationForContext, navigate]
  )

  const handleTranscriptionSessionCreated = useCallback(
    (
      session: TranscriptionSession,
      view: "transcription" | "video-transcription" = "transcription"
    ) => {
      setTranscriptionSessions((current) => [
        session,
        ...current.filter((item) => item.id !== session.id),
      ])
      setArchivedTranscriptionSessions((current) =>
        current.filter((item) => item.id !== session.id)
      )
      navigate(view, null, true, session.id)
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

  const handleNewVideoTranscription = useCallback(() => {
    setCreateVideoTranscriptionRequested(true)
    navigate("video-transcription")
  }, [navigate])

  if (status === "loading") return <WorkspaceLoading />

  if (status === "error" || !user) {
    return (
      <main className="flex min-h-full flex-1 items-center justify-center bg-background p-6">
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
      <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background">
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
          onConversationRefresh={() =>
            refreshConversations().then(() => undefined)
          }
          onRenameConversation={handleRenameConversation}
          onShareConversation={handleShareConversation}
          onNewTranscriptionSession={handleNewTranscriptionSession}
          onNewVideoTranscription={handleNewVideoTranscription}
          onNavigate={(
            view,
            conversationId = null,
            sessionId = null,
            settingsTab = "workspace",
            adminTab = "overview"
          ) =>
            navigate(
              view,
              conversationId,
              false,
              sessionId,
              settingsTab,
              adminTab
            )
          }
          historyOpen={historyOpen}
          onHistoryOpenChange={setHistoryOpen}
          onOrganizationSelect={selectOrganization}
          onSignOut={() => void signOut()}
          organizations={organizations}
          disabledFeatures={disabledFeatures}
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
          {(activeView === "transcription" ||
            activeView === "video-transcription") &&
            disabledFeatures.transcription && (
              <Alert className="m-4 mb-0 shrink-0 border-muted-foreground/20 bg-muted/30">
                <Info />
                <AlertTitle>
                  {activeView === "video-transcription"
                    ? "Video transcription is disabled"
                    : "Live transcription is disabled"}
                </AlertTitle>
                <AlertDescription>
                  This capability was intentionally disabled by a platform
                  administrator.
                </AlertDescription>
              </Alert>
            )}
          {activeView === "settings" &&
            (route.settingsTab === "knowledge" ||
              route.settingsTab === "mcp") &&
            disabledFeatures[route.settingsTab] && (
              <Alert className="m-4 mb-0 shrink-0 border-muted-foreground/20 bg-muted/30">
                <Info />
                <AlertTitle>
                  {route.settingsTab === "knowledge" ? "Knowledge" : "MCP"} is
                  disabled
                </AlertTitle>
                <AlertDescription>
                  This capability was intentionally disabled by a platform
                  administrator.
                </AlertDescription>
              </Alert>
            )}
          <div
            key={workspaceViewKey}
            className={cn(
              "workspace-view-enter min-h-0 w-full flex-1",
              activeView === "transcription" ||
                activeView === "video-transcription"
                ? "flex overflow-hidden"
                : activeView === "chat"
                  ? "flex flex-col overflow-hidden"
                  : "mx-auto max-w-[1440px] overflow-y-auto p-4 sm:p-6 lg:p-8"
            )}
          >
            {activeView === "chat" && (
              <ChatView
                key={`chat:${activeOrganizationId ?? "none"}:${user.id}`}
                assistants={savedAssistants}
                cacheScope={`${activeOrganizationId ?? "none"}:${user.id}`}
                conversationId={activeConversationId}
                conversation={activeConversation}
                endpoints={endpoints}
                mcpServers={servers}
                notes={notes}
                onAssistantSelectionChange={setDraftAssistantId}
                onEnsureConversation={ensureConversationForContext}
                onConversationCreated={(conversation) => {
                  setDraftAssistantId(conversation.assistantId ?? null)
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
            {activeView === "transcription" &&
              sessionViewMatches &&
              (disabledFeatures.transcription ? (
                <FeatureDisabledPanel label="Live transcription" />
              ) : (
                <LiveTranscriptionView
                  endpoints={endpoints}
                  onSessionCreated={handleTranscriptionSessionCreated}
                  onSessionsChanged={handleTranscriptionSessionsChanged}
                  onCreateSessionRequestHandled={() =>
                    setCreateTranscriptionRequested(false)
                  }
                  createSessionRequested={createTranscriptionRequested}
                  sessionId={activeSessionId}
                  sessions={transcriptionSessions.filter(
                    (session) => session.kind !== "video"
                  )}
                  user={user}
                />
              ))}
            {activeView === "video-transcription" &&
              sessionViewMatches &&
              (disabledFeatures.transcription ? (
                <FeatureDisabledPanel label="Video transcription" />
              ) : (
                <VideoTranscriptionView
                  endpoints={endpoints}
                  onSessionCreated={(session) =>
                    handleTranscriptionSessionCreated(
                      session,
                      "video-transcription"
                    )
                  }
                  onSessionsChanged={handleTranscriptionSessionsChanged}
                  onCreateSessionRequestHandled={() =>
                    setCreateVideoTranscriptionRequested(false)
                  }
                  createSessionRequested={createVideoTranscriptionRequested}
                  sessionId={activeSessionId}
                  user={user}
                />
              ))}
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
            {activeView === "notes" && (
              <NotesView
                onNotesChange={setNotes}
                onUseInChat={handleUseNoteInChat}
              />
            )}
            {activeView === "memory" && <MemoryView />}
            {activeView === "assistants" && (
              <AssistantsView
                assistants={savedAssistants}
                endpoints={endpoints}
                onChange={setSavedAssistants}
              />
            )}
            {activeView === "admin" && (
              <PlatformAdminShell
                activeTab={route.adminTab}
                onTabChange={(tab) =>
                  navigate("admin", null, false, null, "workspace", tab)
                }
                user={user}
              />
            )}
          </div>
        </main>
        {activeView === "chat" && contextOpen && (
          <WorkspaceContext
            conversation={activeConversation ?? null}
            conversationId={activeConversationId}
            onEnsureConversation={ensureConversationForContext}
            onClose={() => setContextOpen(false)}
            onNavigate={(view) => navigate(view, null)}
            servers={servers}
            sources={sources}
            notes={notes}
            onProjectsChange={setProjects}
            projects={projects}
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
    <main className="flex min-h-full flex-1 items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <BrandMark className="size-10" />
        <p className="text-sm text-muted-foreground">Loading JustAI…</p>
      </div>
    </main>
  )
}

function FeatureDisabledPanel({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Alert className="max-w-md border-muted-foreground/20 bg-muted/30">
        <Info />
        <AlertTitle>{label} is currently disabled</AlertTitle>
        <AlertDescription>
          A platform administrator has intentionally disabled this capability.
          It will be available again when the platform control is enabled.
        </AlertDescription>
      </Alert>
    </div>
  )
}
