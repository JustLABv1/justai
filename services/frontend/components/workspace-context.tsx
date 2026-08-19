"use client"

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  BookOpenText,
  CheckCircle2,
  Database,
  GitBranch,
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
  Note,
  RepositoryContext,
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
  notes: Note[]
  transcriptionSessions: TranscriptionSession[]
  onNavigate: (view: ViewId) => void
  onClose: () => void
}

export function WorkspaceContext({
  conversationId,
  onEnsureConversation,
  sources,
  servers,
  notes,
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
  const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false)
  const [repositoryURL, setRepositoryURL] = useState("")
  const [repositoryRef, setRepositoryRef] = useState("")
  const [repositoryToken, setRepositoryToken] = useState("")
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
      : {
          knowledgeSources: [],
          repositories: [],
          mcpServers: [],
          transcriptionSessions: [],
          notes: [],
        }
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
  const repositories = visibleContext.repositories ?? []
  const readyRepositories = repositories.filter(
    (repository) => repository.status === "ready"
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

  async function pinKnowledge(sourceId: string) {
    setBusy(sourceId)
    setNotice("")
    try {
      const targetConversationId =
        conversationId ?? (await onEnsureConversation?.())
      if (!targetConversationId) {
        throw new Error("A conversation is required before pinning context.")
      }
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

  async function connectRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!repositoryURL.trim()) {
      setNotice("Enter a GitHub or GitLab repository URL.")
      return
    }
    setBusy("repository-create")
    setNotice("")
    try {
      const targetConversationId =
        conversationId ?? (await onEnsureConversation?.())
      if (!targetConversationId) {
        throw new Error(
          "A conversation is required before adding a repository."
        )
      }
      const repository = await api.post<RepositoryContext>(
        `/api/v1/conversations/${targetConversationId}/repositories`,
        {
          url: repositoryURL.trim(),
          ref: repositoryRef.trim(),
          accessToken: repositoryToken,
        }
      )
      const next = await api.get<ConversationContext>(
        `/api/v1/conversations/${targetConversationId}/context`
      )
      setContext(next)
      setLoadedConversationId(targetConversationId)
      setRepositoryDialogOpen(false)
      setRepositoryURL("")
      setRepositoryRef("")
      setRepositoryToken("")
      setNotice(
        repository.status === "ready"
          ? "Repository attached. Its existing index is available in this chat."
          : "Repository import started. It will become searchable when indexing finishes."
      )
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The repository could not be added."
      )
    } finally {
      setBusy("")
    }
  }

  async function removeRepository(item: RepositoryContext) {
    if (!conversationId) return
    setBusy(item.id)
    setNotice("")
    try {
      await api.delete(
        `/api/v1/conversations/${conversationId}/context/repositories/${item.id}`
      )
      const next = await api.get<ConversationContext>(
        `/api/v1/conversations/${conversationId}/context`
      )
      setContext(next)
      setLoadedConversationId(conversationId)
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The repository could not be removed."
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
            icon={GitBranch}
            label="Repositories"
            meta={`${readyRepositories.length}/${repositories.length} ready`}
          />
          {repositories.length > 0 ? (
            repositories.slice(0, 4).map((item) => (
              <ContextItem
                detail={repositoryDetail(item)}
                icon={GitBranch}
                key={item.id}
                label={item.title}
                status={formatRepositoryStatus(item.status)}
                action={
                  <Button
                    aria-label={`Remove ${item.title} from this chat; keep it indexed for future chats`}
                    disabled={busy === item.id}
                    onClick={() => void removeRepository(item)}
                    size="icon-xs"
                    title="Remove from this chat (keep indexed for future chats)"
                    variant="ghost"
                  >
                    {busy === item.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <X />
                    )}
                  </Button>
                }
              />
            ))
          ) : (
            <ContextEmpty
              icon={GitBranch}
              text="Add a public GitHub/GitLab repo, or use a read-only token for a private one."
            />
          )}
          <Button
            className="mt-1 w-full"
            onClick={() => setRepositoryDialogOpen(true)}
            size="sm"
            variant="outline"
          >
            <Plus data-icon="inline-start" />
            Add or reuse repository
          </Button>
          <div className="mb-2 rounded-lg border border-dashed p-3 text-[11px] leading-relaxed text-muted-foreground">
            JustAI imports a bounded set of text files and indexes them as
            read-only chat context. Provider credentials are encrypted and never
            sent to the model.
          </div>
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
                          size="icon-xs"
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
                        size="icon-xs"
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

      <Dialog
        open={repositoryDialogOpen}
        onOpenChange={(open) => {
          if (busy !== "repository-create") setRepositoryDialogOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a read-only repository</DialogTitle>
            <DialogDescription>
              Connect a public GitHub/GitLab repository, or provide a read-only
              personal access token for a private one. If it is already in your
              repository library, JustAI attaches the existing index instead of
              importing it again.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={connectRepository}>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium" htmlFor="repository-url">
                Repository URL
              </label>
              <Input
                id="repository-url"
                onChange={(event) => setRepositoryURL(event.target.value)}
                placeholder="https://github.com/org/project"
                value={repositoryURL}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium" htmlFor="repository-ref">
                Branch, tag, or commit
              </label>
              <Input
                id="repository-ref"
                onChange={(event) => setRepositoryRef(event.target.value)}
                placeholder="HEAD (default branch)"
                value={repositoryRef}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium" htmlFor="repository-token">
                Optional read-only access token
              </label>
              <Input
                autoComplete="off"
                id="repository-token"
                onChange={(event) => setRepositoryToken(event.target.value)}
                placeholder="Leave empty for public repositories"
                type="password"
                value={repositoryToken}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Use the smallest provider scope available. The token is
                encrypted at rest and never returned by the API.
              </p>
            </div>
            <DialogFooter>
              <Button
                disabled={busy === "repository-create"}
                onClick={() => setRepositoryDialogOpen(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button disabled={busy === "repository-create"} type="submit">
                {busy === "repository-create" && (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                )}
                Connect repository
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="mt-auto flex items-center gap-2 border-t pt-4 text-[11px] text-muted-foreground">
        <CheckCircle2 className="size-4 shrink-0" />
        Repositories stay indexed and available across new chats.
      </div>
    </div>
  )

  return (
    <>
      <aside className="workspace-context-enter hidden w-[304px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-muted/20 lg:flex">
        {panel}
      </aside>
      {isMobileViewport && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) onClose()
          }}
        >
          <SheetContent className="w-[min(100vw,304px)] gap-0 p-0" side="right">
            <SheetHeader className="sr-only">
              <SheetTitle>Conversation context</SheetTitle>
              <SheetDescription>
                Attach Knowledge sources, repositories, Notes, MCP servers, and
                transcription sessions to this conversation.
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

function formatRepositoryStatus(status: string) {
  if (status === "ready") return "Ready"
  if (status === "failed") return "Failed"
  if (status === "queued") return "Queued"
  return "Indexing"
}

function repositoryDetail(item: RepositoryContext) {
  if (item.status === "failed" && item.error) return item.error
  const skipped =
    item.skippedFileCount > 0 ? ` · ${item.skippedFileCount} skipped` : ""
  return `${item.provider} · ${item.readyFileCount}/${item.fileCount || "…"} files${skipped}${item.ref ? ` · ${item.ref}` : ""}`
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
