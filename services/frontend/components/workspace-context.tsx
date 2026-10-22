"use client"

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  BookOpenText,
  CheckCircle2,
  Database,
  FolderKanban,
  Headphones,
  LoaderCircle,
  NotebookPen,
  Pin,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type {
  ConversationContext,
  Conversation,
  KnowledgeSource,
  MCPServer,
  Note,
  TranscriptionSession,
  ViewId,
  WorkspaceProject,
} from "@/lib/types"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type ContextTab = "sources" | "mcp" | "live"
type EnsureConversationOptions = { activate?: boolean }

type WorkspaceContextProps = {
  conversation: Conversation | null
  conversationId: string | null
  onEnsureConversation?: (
    options?: EnsureConversationOptions
  ) => Promise<string>
  sources: KnowledgeSource[]
  servers: MCPServer[]
  notes: Note[]
  projects: WorkspaceProject[]
  onProjectsChange: (projects: WorkspaceProject[]) => void
  transcriptionSessions: TranscriptionSession[]
  onNavigate: (view: ViewId) => void
  onClose: () => void
}

export function WorkspaceContext({
  conversation,
  conversationId,
  onEnsureConversation,
  sources,
  servers,
  notes,
  projects,
  onProjectsChange,
  transcriptionSessions,
  onNavigate,
  onClose,
}: WorkspaceContextProps) {
  const [activeTab, setActiveTab] = useState<ContextTab>("sources")
  const [context, setContext] = useState<ConversationContext>({
    knowledgeSources: [],
    repositories: [],
    mcpServers: [],
    transcriptionSessions: [],
    notes: [],
  })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState("")
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [projectDescription, setProjectDescription] = useState("")
  const [projectVisibility, setProjectVisibility] = useState<
    "private" | "workspace"
  >("private")
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
    let disposed = false
    let timer: number | null = null
    let delay = 5_000
    let controller: AbortController | null = null
    let inFlight = false
    const schedule = () => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void loadContext(false), delay)
    }
    const loadContext = async (showLoading: boolean) => {
      if (disposed || document.visibilityState === "hidden") {
        schedule()
        return
      }
      if (inFlight) return
      inFlight = true
      controller?.abort()
      controller = new AbortController()
      if (showLoading) setLoading(true)
      try {
        const result = await api.get<ConversationContext>(
          `/api/v1/conversations/${conversationId}/context`,
          { signal: controller.signal }
        )
        if (!disposed) {
          setContext(result)
          setLoadedConversationId(conversationId)
          setNotice("")
          delay = 5_000
        }
      } catch (caught) {
        if (!disposed && !controller.signal.aborted) {
          setLoadedConversationId(conversationId)
          setNotice(
            caught instanceof Error
              ? caught.message
              : "Conversation context could not be loaded."
          )
          delay = Math.min(delay * 2, 60_000)
        }
      } finally {
        inFlight = false
        if (!disposed && showLoading) setLoading(false)
        schedule()
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        delay = 5_000
        void loadContext(false)
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    const initialTimer = window.setTimeout(() => {
      setNotice("")
      void loadContext(true)
    }, 0)
    return () => {
      disposed = true
      controller?.abort()
      window.clearTimeout(initialTimer)
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [conversationId])

  const visibleContext =
    conversationId && loadedConversationId === conversationId
      ? context
      : {
          knowledgeSources: [],
          repositories: [],
          mcpServers: [],
          transcriptionSessions: [],
          notes: [],
        }
  const visibleNotice =
    conversationId && loadedConversationId === conversationId ? notice : ""

  async function ensureContextConversation(message: string) {
    const targetConversationId =
      conversationId ?? (await onEnsureConversation?.({ activate: false }))
    if (!targetConversationId) throw new Error(message)
    return targetConversationId
  }

  async function refreshConversationContext(targetConversationId: string) {
    const next = await api.get<ConversationContext>(
      `/api/v1/conversations/${targetConversationId}/context`
    )
    setContext(next)
    setLoadedConversationId(targetConversationId)
  }

  async function selectProject(value: string | null) {
    setBusy("project")
    setNotice("")
    try {
      const targetConversationId = await ensureContextConversation(
        "A conversation is required before setting project context."
      )
      await api.patch(`/api/v1/conversations/${targetConversationId}`, {
        projectId: !value || value === "none" ? "" : value,
      })
      await refreshConversationContext(targetConversationId)
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "Project context could not be updated."
      )
    } finally {
      setBusy("")
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!projectName.trim()) {
      setNotice("Enter a project name.")
      return
    }
    setBusy("project-create")
    setNotice("")
    try {
      const result = await api.post<{ project: WorkspaceProject }>(
        "/api/v1/projects",
        {
          name: projectName.trim(),
          description: projectDescription.trim(),
          visibility: projectVisibility,
        }
      )
      onProjectsChange([result.project, ...projects])
      setProjectDialogOpen(false)
      setProjectName("")
      setProjectDescription("")
      setProjectVisibility("private")
      await selectProject(result.project.id)
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The project could not be created."
      )
    } finally {
      setBusy("")
    }
  }

  const availableSources = Array.from(
    new Map(
      [...sources, ...visibleContext.knowledgeSources].map((source) => [
        source.id,
        source,
      ])
    ).values()
  ).filter((source) => source.sourceType !== "repository")
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
  const availableNotes = Array.from(
    new Map(
      [...notes, ...(visibleContext.notes ?? [])].map((note) => [note.id, note])
    ).values()
  )

  async function toggle(
    resource: "knowledge" | "mcp" | "note" | "transcription",
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
          : resource === "note"
            ? "notes"
            : "transcription"
    try {
      const targetConversationId = await ensureContextConversation(
        "A conversation is required before attaching context."
      )
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

  async function pinKnowledge(sourceId: string) {
    setBusy(sourceId)
    setNotice("")
    try {
      const targetConversationId = await ensureContextConversation(
        "A conversation is required before pinning context."
      )
      await api.patch(
        `/api/v1/conversations/${targetConversationId}/context/knowledge/${sourceId}`,
        { contextScope: "persistent" }
      )
      const next = await api.get<ConversationContext>(
        `/api/v1/conversations/${targetConversationId}/context`
      )
      setContext(next)
      setLoadedConversationId(targetConversationId)
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "Context could not be pinned."
      )
    } finally {
      setBusy("")
    }
  }

  const panel = (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto bg-sidebar px-4 py-5 text-sidebar-foreground">
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

      <div className="flex flex-col gap-2 rounded-xl bg-sidebar-accent p-3">
        <ContextHeading
          icon={FolderKanban}
          label="Project context"
          meta={visibleContext.project ? "Attached" : "Optional"}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A project brief follows this conversation and keeps responses aligned
          across turns.
          {conversation?.visibility === "workspace"
            ? " Members can use the attached brief."
            : ""}
        </p>
        <div className="flex gap-2">
          <Select
            disabled={
              busy === "project" ||
              (conversationId !== null && conversation?.canManage === false)
            }
            onValueChange={(value) => void selectProject(value)}
            value={visibleContext.project?.id ?? "none"}
          >
            <SelectTrigger className="min-w-0 flex-1" size="sm">
              <SelectValue placeholder="No project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                  {project.visibility === "workspace" ? " · Workspace" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            aria-label="Create project"
            disabled={
              busy === "project-create" ||
              (conversationId !== null && conversation?.canManage === false)
            }
            onClick={() => setProjectDialogOpen(true)}
            size="icon-sm"
            title="Create project"
            variant="outline"
          >
            <Plus />
          </Button>
        </div>
        {visibleContext.project?.description && (
          <p className="line-clamp-4 text-[11px] text-muted-foreground">
            {visibleContext.project.description}
          </p>
        )}
      </div>

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
              "min-h-8 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-[background-color,color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.98]",
              activeTab === id &&
                "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs"
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
                detail={`${source.contextScope === "message" ? "this message · " : ""}${source.status}${source.sourceType ? ` · ${source.sourceType}` : ""}`}
                icon={BookOpenText}
                key={source.id}
                label={source.title}
                action={
                  <div className="flex items-center gap-1">
                    {source.contextScope === "message" &&
                      visibleContext.knowledgeSources.some(
                        (item) => item.id === source.id
                      ) && (
                        <Button
                          aria-label={`Keep ${source.title} in conversation context`}
                          disabled={busy === source.id}
                          onClick={() => void pinKnowledge(source.id)}
                          size="icon-sm"
                          title="Keep in conversation context"
                          variant="ghost"
                        >
                          <Pin />
                        </Button>
                      )}
                    <Button
                      aria-label={`${visibleContext.knowledgeSources.some((item) => item.id === source.id) ? "Remove" : "Attach"} ${source.title}`}
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
                      size="icon-sm"
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
                  </div>
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
          <div className="mt-3 flex flex-col gap-2 border-t pt-3">
            <ContextHeading
              icon={NotebookPen}
              label="Notes"
              meta={`${visibleContext.notes?.length ?? 0}/${availableNotes.length} attached`}
            />
            {availableNotes.length > 0 ? (
              availableNotes.slice(0, 6).map((note) => {
                const attached = (visibleContext.notes ?? []).some(
                  (item) => item.id === note.id
                )
                return (
                  <ContextItem
                    detail={`${note.content ? `${note.content.length} characters` : "Empty note"} · updated ${new Date(note.updatedAt).toLocaleDateString()}`}
                    icon={NotebookPen}
                    key={note.id}
                    label={note.title}
                    action={
                      <Button
                        aria-label={`${attached ? "Detach" : "Attach"} ${note.title}`}
                        disabled={busy === note.id}
                        onClick={() => void toggle("note", note.id, attached)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        {busy === note.id ? (
                          <LoaderCircle className="animate-spin" />
                        ) : attached ? (
                          <CheckCircle2 />
                        ) : (
                          <Plus />
                        )}
                      </Button>
                    }
                  />
                )
              })
            ) : (
              <ContextEmpty icon={NotebookPen} text="No workspace notes yet." />
            )}
            <Button
              className="mt-1 w-full"
              onClick={() => onNavigate("notes")}
              size="sm"
              variant="outline"
            >
              Open notes
            </Button>
          </div>
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
                    size="icon-sm"
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
            Organization-default MCP servers are attached to new chats
            automatically. Other connected servers stay opt-in for this
            conversation. Tool calls and their bounded results stay attached to
            the relevant chat turn.
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
                    size="icon-sm"
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

      <Dialog
        open={projectDialogOpen}
        onOpenChange={(open) => {
          if (busy !== "project-create") setProjectDialogOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create project context</DialogTitle>
            <DialogDescription>
              Save a short brief that is automatically included whenever this
              project is attached to a conversation.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={createProject}>
            <Input
              aria-label="Project name"
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Project name"
              value={projectName}
            />
            <Textarea
              aria-label="Project brief"
              onChange={(event) => setProjectDescription(event.target.value)}
              placeholder="Goals, terminology, constraints, and decisions…"
              value={projectDescription}
            />
            <Select
              onValueChange={(value) =>
                setProjectVisibility(value as "private" | "workspace")
              }
              value={projectVisibility}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private project</SelectItem>
                <SelectItem value="workspace">Workspace project</SelectItem>
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button
                disabled={busy === "project-create"}
                onClick={() => setProjectDialogOpen(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button disabled={busy === "project-create"} type="submit">
                {busy === "project-create" && (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                )}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="mt-auto flex items-center gap-2 border-t pt-4 text-[11px] text-muted-foreground">
        <CheckCircle2 className="size-4 shrink-0" />
        Knowledge sources stay available to add across new chats.
      </div>
    </div>
  )

  return (
    <>
      <aside className="workspace-context-enter hidden w-[304px] min-w-0 shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground lg:flex">
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
            className="w-[min(100vw,304px)] gap-0 bg-sidebar p-0 text-sidebar-foreground"
            side="right"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Conversation context</SheetTitle>
              <SheetDescription>
                Attach Knowledge sources, Notes, MCP servers, and transcription
                sessions to this conversation.
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
    <div className="flex min-w-0 items-start gap-2 rounded-xl bg-sidebar-accent p-2.5">
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
