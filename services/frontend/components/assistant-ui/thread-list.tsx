"use client"

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Settings2,
  Tag,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  AssistantRuntimeProvider,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  Conversation,
  ConversationFolder,
  ConversationTag,
} from "@/lib/types"
import { API_URL, api } from "@/lib/api"
import { cn } from "@/lib/utils"

type AssistantThreadListProps = {
  organizationId: string | null
  activeConversationId: string | null
  conversations: Conversation[]
  archivedConversations: Conversation[]
  historyQuery: string
  onHistoryQueryChange: (value: string) => void
  onArchive: (conversationId: string, archived: boolean) => void | Promise<void>
  onDelete: (conversation: Conversation) => void
  onRename: (conversationId: string, title: string) => void | Promise<void>
  onSelect: (conversationId: string) => void
  onConversationRefresh?: () => void | Promise<void>
}

type LabelKind = "folder" | "tag"

type LabelTarget = {
  kind: LabelKind
  id: string
  name: string
}

function metadata(conversation: Conversation, status: "regular" | "archived") {
  return {
    remoteId: conversation.id,
    title: conversation.title,
    status,
    lastMessageAt: new Date(conversation.updatedAt),
    custom: {
      messageCount: conversation.messageCount,
      folderId: conversation.folderId,
      pinnedAt: conversation.pinnedAt,
      tags: conversation.tags,
    },
  } as const
}

function conversationForThread(thread: {
  id: string
  title?: string
  custom?: Record<string, unknown>
}): Conversation {
  const messageCount =
    typeof thread.custom?.messageCount === "number"
      ? thread.custom.messageCount
      : 0
  return {
    id: thread.id,
    title: thread.title || "New conversation",
    createdAt: "",
    updatedAt: "",
    messageCount,
    folderId:
      typeof thread.custom?.folderId === "string"
        ? thread.custom.folderId
        : null,
    pinnedAt:
      typeof thread.custom?.pinnedAt === "string"
        ? thread.custom.pinnedAt
        : null,
    tags: Array.isArray(thread.custom?.tags)
      ? (thread.custom.tags as ConversationTag[])
      : [],
  }
}

function getFolderId(custom?: Record<string, unknown>) {
  return typeof custom?.folderId === "string" ? custom.folderId : null
}

function getFolderCollapseStorageKey(organizationId: string | null) {
  return `justai.chat-history-collapsed-folders:${organizationId ?? "default"}`
}

function orderConversationsByFolder(
  conversations: Conversation[],
  folders: ConversationFolder[]
) {
  const folderOrder = new Map(
    folders.map((folder, index) => [folder.id, index])
  )

  return [...conversations].sort((left, right) => {
    const leftFolderOrder = left.folderId
      ? (folderOrder.get(left.folderId) ?? folders.length)
      : folders.length + 1
    const rightFolderOrder = right.folderId
      ? (folderOrder.get(right.folderId) ?? folders.length)
      : folders.length + 1

    if (leftFolderOrder !== rightFolderOrder) {
      return leftFolderOrder - rightFolderOrder
    }

    if (left.folderId !== right.folderId) {
      return (left.folderId ?? "").localeCompare(right.folderId ?? "")
    }

    if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) {
      return left.pinnedAt ? -1 : 1
    }

    return (
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    )
  })
}

function emptyAssistantStream() {
  return new ReadableStream() as unknown as Awaited<
    ReturnType<RemoteThreadListAdapter["generateTitle"]>
  >
}

function useThreadListChatRuntime() {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${API_URL}/api/v1/chat`,
        credentials: "include",
      }),
    []
  )
  return useChatRuntime({ transport })
}

function AssistantThreadItem({
  archived,
  onArchive,
  onDelete,
  onRequestRename,
  onTogglePinned,
  onMoveFolder,
  onToggleTag,
  folders,
  tags,
  collapsedFolders,
  onToggleFolder,
  thread,
}: {
  archived: boolean
  onArchive: (threadId: string) => void
  onDelete: (threadId: string) => void
  onRequestRename: (threadId: string, title: string) => void
  onTogglePinned: (threadId: string, pinned: boolean) => void | Promise<void>
  onMoveFolder: (
    threadId: string,
    folderId: string | null
  ) => void | Promise<void>
  onToggleTag: (
    threadId: string,
    tagId: string,
    attached: boolean
  ) => void | Promise<void>
  folders: ConversationFolder[]
  tags: ConversationTag[]
  collapsedFolders: Set<string>
  onToggleFolder: (folderId: string) => void
  thread: { id: string; title?: string; custom?: Record<string, unknown> }
}) {
  const count =
    typeof thread.custom?.messageCount === "number"
      ? thread.custom.messageCount
      : 0
  const pinned = typeof thread.custom?.pinnedAt === "string"
  const folderId = getFolderId(thread.custom)
  const threadTags = Array.isArray(thread.custom?.tags)
    ? (thread.custom.tags as ConversationTag[])
    : []

  const threadId = useAuiState((state) => state.threadListItem.id)
  const threadIds = useAuiState((state) =>
    archived ? state.threads.archivedThreadIds : state.threads.threadIds
  )
  const threadItems = useAuiState((state) => state.threads.threadItems)
  const threadIndex = threadIds.indexOf(threadId)
  const previousThread =
    threadIndex > 0
      ? threadItems.find((item) => item.id === threadIds[threadIndex - 1])
      : undefined
  const previousFolderId = getFolderId(previousThread?.custom)
  const folder = folderId
    ? folders.find((item) => item.id === folderId)
    : undefined
  const showFolderHeader =
    threadIndex >= 0 &&
    (threadIndex === 0 || previousFolderId !== folderId) &&
    folders.length > 0
  const folderThreadCount = showFolderHeader
    ? threadIds.reduce((count, id) => {
        const item = threadItems.find((candidate) => candidate.id === id)
        return count + (getFolderId(item?.custom) === folderId ? 1 : 0)
      }, 0)
    : 0
  const sectionId = folderId ?? "__unfiled__"
  const sectionCollapsed = folders.length > 0 && collapsedFolders.has(sectionId)

  if (sectionCollapsed && !showFolderHeader) return null

  return (
    <div>
      {showFolderHeader && (
        <button
          aria-expanded={!sectionCollapsed}
          className={cn(
            "flex w-full items-center gap-1.5 px-2 pb-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground",
            threadIndex === 0 ? "pt-0" : "pt-3"
          )}
          onClick={() => onToggleFolder(sectionId)}
          type="button"
        >
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              sectionCollapsed && "-rotate-90"
            )}
          />
          <Folder className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {folder?.name ?? "Unfiled chats"}
          </span>
          <Badge
            className="h-4 px-1.5 text-[10px] tabular-nums"
            variant="secondary"
          >
            {folderThreadCount}
          </Badge>
        </button>
      )}
      {!sectionCollapsed && (
        <ThreadListItemPrimitive.Root className="group relative rounded-xl data-[active=true]:bg-accent">
          <ThreadListItemPrimitive.Trigger
            aria-label={`Open ${thread.title || "conversation"}`}
            className="flex min-h-12 w-full items-center gap-2 rounded-xl px-2.5 py-2 pr-9 text-left text-xs hover:bg-accent/70"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-border group-data-[active=true]:bg-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                {pinned && (
                  <span
                    aria-label="Pinned conversation"
                    title="Pinned conversation"
                  >
                    <Pin
                      aria-hidden="true"
                      className="size-3 shrink-0 text-primary"
                    />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  <ThreadListItemPrimitive.Title fallback="New conversation" />
                </span>
              </span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-[11px] font-normal text-muted-foreground">
                <span>
                  {count} message{count === 1 ? "" : "s"}
                </span>
                {threadTags.map((tag) => (
                  <Badge
                    className="h-4 max-w-28 px-1.5 text-[10px] font-normal"
                    key={tag.id}
                    title={tag.name}
                    variant="outline"
                  >
                    {tag.name}
                  </Badge>
                ))}
              </span>
            </span>
          </ThreadListItemPrimitive.Trigger>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`Actions for ${thread.title || "conversation"}`}
                  className="absolute top-1/2 right-1 size-7 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  size="icon-xs"
                  title={`Actions for ${thread.title || "conversation"}`}
                  variant="ghost"
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onClick={() => void onTogglePinned(thread.id, !pinned)}
              >
                {pinned ? (
                  <PinOff data-icon="inline-start" />
                ) : (
                  <Pin data-icon="inline-start" />
                )}
                {pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Folder data-icon="inline-start" />
                  Move to folder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onClick={() => void onMoveFolder(thread.id, null)}
                  >
                    No folder
                  </DropdownMenuItem>
                  {folders.map((folder) => (
                    <DropdownMenuItem
                      key={folder.id}
                      onClick={() => void onMoveFolder(thread.id, folder.id)}
                    >
                      {folder.name}
                      {folder.id === folderId ? " · Current" : ""}
                    </DropdownMenuItem>
                  ))}
                  {!folders.length && (
                    <DropdownMenuItem disabled>No folders yet</DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Tag data-icon="inline-start" />
                  Tags
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {tags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      checked={threadTags.some((item) => item.id === tag.id)}
                      key={tag.id}
                      onCheckedChange={(checked) =>
                        void onToggleTag(thread.id, tag.id, Boolean(checked))
                      }
                    >
                      {tag.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {!tags.length && (
                    <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onRequestRename(thread.id, thread.title || "")}
              >
                <Pencil data-icon="inline-start" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onArchive(thread.id)}>
                {archived ? (
                  <ArchiveRestore data-icon="inline-start" />
                ) : (
                  <Archive data-icon="inline-start" />
                )}
                {archived ? "Restore" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(thread.id)}
                variant="destructive"
              >
                <Trash2 data-icon="inline-start" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ThreadListItemPrimitive.Root>
      )}
    </div>
  )
}

export function AssistantThreadList({
  organizationId,
  activeConversationId,
  conversations,
  archivedConversations,
  historyQuery,
  onHistoryQueryChange,
  onArchive,
  onDelete,
  onRename,
  onSelect,
  onConversationRefresh,
}: AssistantThreadListProps) {
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [folderFilter, setFolderFilter] = useState("all")
  const [folders, setFolders] = useState<ConversationFolder[]>([])
  const [tags, setTags] = useState<ConversationTag[]>([])
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  )
  const [collapsedFoldersStorageKey, setCollapsedFoldersStorageKey] = useState<
    string | null
  >(null)
  const [labelDialog, setLabelDialog] = useState<"folder" | "tag" | null>(null)
  const [labelName, setLabelName] = useState("")
  const [labelSaving, setLabelSaving] = useState(false)
  const [labelError, setLabelError] = useState<string | null>(null)
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false)
  const [labelEditTarget, setLabelEditTarget] = useState<LabelTarget | null>(
    null
  )
  const [labelEditName, setLabelEditName] = useState("")
  const [labelEditSaving, setLabelEditSaving] = useState(false)
  const [labelDeleteTarget, setLabelDeleteTarget] =
    useState<LabelTarget | null>(null)
  const [labelDeleteSaving, setLabelDeleteSaving] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    id: string
    title: string
  } | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [renameSaving, setRenameSaving] = useState(false)

  const folderCollapseStorageKey = getFolderCollapseStorageKey(organizationId)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get<{ folders: ConversationFolder[] }>(
        "/api/v1/conversation-folders"
      ),
      api.get<{ tags: ConversationTag[] }>("/api/v1/conversation-tags"),
    ])
      .then(([folderResult, tagResult]) => {
        if (cancelled) return
        setFolders(folderResult.folders)
        setTags(tagResult.tags)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [organizationId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(folderCollapseStorageKey)
        const parsed: unknown = stored ? JSON.parse(stored) : []
        setCollapsedFolders(
          new Set(
            Array.isArray(parsed)
              ? parsed.filter(
                  (value): value is string => typeof value === "string"
                )
              : []
          )
        )
      } catch {
        setCollapsedFolders(new Set())
      }
      setCollapsedFoldersStorageKey(folderCollapseStorageKey)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [folderCollapseStorageKey])

  useEffect(() => {
    if (collapsedFoldersStorageKey !== folderCollapseStorageKey) return
    try {
      window.localStorage.setItem(
        folderCollapseStorageKey,
        JSON.stringify([...collapsedFolders])
      )
    } catch {
      // Local storage can be unavailable in private browsing or restricted contexts.
    }
  }, [collapsedFolders, collapsedFoldersStorageKey, folderCollapseStorageKey])

  function toggleFolder(folderId: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }

  const allConversations = useMemo(
    () => [...conversations, ...archivedConversations],
    [archivedConversations, conversations]
  )
  const adapter = useMemo<RemoteThreadListAdapter>(
    () => ({
      async list({ after } = {}) {
        const params = new URLSearchParams({ archived: "all" })
        params.set("organized", "true")
        const query = historyQuery.trim()
        if (query) params.set("q", query)
        if (folderFilter === "pinned") params.set("pinned", "true")
        if (folderFilter.startsWith("folder:")) {
          params.set("folderId", folderFilter.slice("folder:".length))
        }
        if (folderFilter.startsWith("tag:")) {
          params.set("tagId", folderFilter.slice("tag:".length))
        }
        if (after) params.set("cursor", after)
        const response = await api.get<{
          conversations: Conversation[]
          nextCursor?: string
        }>(`/api/v1/conversations?${params.toString()}`)
        return {
          threads: orderConversationsByFolder(
            response.conversations,
            folders
          ).map((conversation) =>
            metadata(
              conversation,
              conversation.archivedAt ? "archived" : "regular"
            )
          ),
          nextCursor: response.nextCursor || undefined,
        }
      },
      async rename(remoteId, newTitle) {
        await onRename(remoteId, newTitle)
      },
      async archive(remoteId) {
        await onArchive(remoteId, true)
      },
      async unarchive(remoteId) {
        await onArchive(remoteId, false)
      },
      async delete(remoteId) {
        const conversation = allConversations.find(
          (item) => item.id === remoteId
        )
        onDelete(
          conversation ?? {
            id: remoteId,
            title: "Conversation",
            createdAt: "",
            updatedAt: "",
            messageCount: 0,
          }
        )
      },
      async initialize(threadId) {
        const existing = allConversations.find((item) => item.id === threadId)
        if (existing) return { remoteId: existing.id }
        const response = await api.post<{ conversation: Conversation }>(
          "/api/v1/conversations"
        )
        return { remoteId: response.conversation.id }
      },
      async fetch(threadId) {
        const response = await api.get<{ conversation: Conversation }>(
          `/api/v1/conversations/${threadId}`
        )
        const conversation = response.conversation
        return metadata(
          conversation,
          conversation.archivedAt ? "archived" : "regular"
        )
      },
      async generateTitle() {
        return emptyAssistantStream()
      },
    }),
    [
      allConversations,
      folderFilter,
      folders,
      historyQuery,
      onArchive,
      onDelete,
      onRename,
    ]
  )

  async function togglePinned(threadId: string, pinned: boolean) {
    await api.patch(`/api/v1/conversations/${threadId}`, { pinned })
    await onConversationRefresh?.()
  }

  async function moveFolder(threadId: string, folderId: string | null) {
    await api.patch(`/api/v1/conversations/${threadId}`, {
      folderId: folderId ?? "",
    })
    await onConversationRefresh?.()
  }

  async function toggleTag(threadId: string, tagId: string, attached: boolean) {
    if (attached) {
      await api.post(`/api/v1/conversations/${threadId}/tags/${tagId}`)
    } else {
      await api.delete(`/api/v1/conversations/${threadId}/tags/${tagId}`)
    }
    await onConversationRefresh?.()
  }

  async function createLabel() {
    const name = labelName.trim()
    if (!name || !labelDialog || labelSaving) return
    setLabelSaving(true)
    setLabelError(null)
    try {
      if (labelDialog === "folder") {
        const response = await api.post<{ folder: ConversationFolder }>(
          "/api/v1/conversation-folders",
          { name }
        )
        setFolders((current) => [...current, response.folder])
      } else {
        const response = await api.post<{ tag: ConversationTag }>(
          "/api/v1/conversation-tags",
          { name }
        )
        setTags((current) => [...current, response.tag])
      }
      setLabelName("")
      setLabelDialog(null)
    } catch (error) {
      setLabelError(
        error instanceof Error
          ? error.message
          : `Could not create ${labelDialog}.`
      )
    } finally {
      setLabelSaving(false)
    }
  }

  function startLabelEdit(target: LabelTarget) {
    setManageLabelsOpen(false)
    setLabelError(null)
    setLabelEditTarget(target)
    setLabelEditName(target.name)
  }

  function startLabelDelete(target: LabelTarget) {
    setManageLabelsOpen(false)
    setLabelError(null)
    setLabelDeleteTarget(target)
  }

  async function submitLabelEdit() {
    const target = labelEditTarget
    const name = labelEditName.trim()
    if (!target || !name || labelEditSaving) return
    setLabelEditSaving(true)
    setLabelError(null)
    try {
      if (target.kind === "folder") {
        const response = await api.patch<{ folder: ConversationFolder }>(
          `/api/v1/conversation-folders/${target.id}`,
          { name }
        )
        setFolders((current) =>
          current.map((folder) =>
            folder.id === target.id ? response.folder : folder
          )
        )
      } else {
        const response = await api.patch<{ tag: ConversationTag }>(
          `/api/v1/conversation-tags/${target.id}`,
          { name }
        )
        setTags((current) =>
          current.map((tag) => (tag.id === target.id ? response.tag : tag))
        )
      }
      await onConversationRefresh?.()
      setLabelEditTarget(null)
    } catch (error) {
      setLabelError(
        error instanceof Error
          ? error.message
          : `Could not rename ${target.kind}.`
      )
    } finally {
      setLabelEditSaving(false)
    }
  }

  async function deleteLabel() {
    const target = labelDeleteTarget
    if (!target || labelDeleteSaving) return
    setLabelDeleteSaving(true)
    setLabelError(null)
    try {
      await api.delete(
        target.kind === "folder"
          ? `/api/v1/conversation-folders/${target.id}`
          : `/api/v1/conversation-tags/${target.id}`
      )
      if (target.kind === "folder") {
        setFolders((current) =>
          current.filter((folder) => folder.id !== target.id)
        )
        setCollapsedFolders((current) => {
          if (!current.has(target.id)) return current
          const next = new Set(current)
          next.delete(target.id)
          return next
        })
      } else {
        setTags((current) => current.filter((tag) => tag.id !== target.id))
      }
      if (folderFilter === `${target.kind}:${target.id}`) {
        setFolderFilter("all")
      }
      await onConversationRefresh?.()
      setLabelDeleteTarget(null)
    } catch (error) {
      setLabelError(
        error instanceof Error
          ? error.message
          : `Could not delete ${target.kind}.`
      )
    } finally {
      setLabelDeleteSaving(false)
    }
  }

  const requestRename = (id: string, title: string) => {
    setRenameTarget({ id, title })
    setRenameTitle(title)
  }

  const submitRename = async () => {
    const target = renameTarget
    const title = renameTitle.trim()
    if (!target || !title || renameSaving) return
    setRenameSaving(true)
    try {
      await onRename(target.id, title)
      setRenameTarget(null)
    } catch {
      // The workspace displays the request error; keep the dialog open so the
      // user can correct the title or retry without losing their input.
    } finally {
      setRenameSaving(false)
    }
  }

  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: useThreadListChatRuntime,
    threadId: activeConversationId ?? undefined,
    onThreadIdChange: (threadId) => {
      if (threadId) onSelect(threadId)
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <Input
          aria-label="Search chat history"
          className="h-9 shrink-0"
          onChange={(event) => onHistoryQueryChange(event.target.value)}
          placeholder="Search chats"
          type="search"
          value={historyQuery}
        />
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="min-w-0 flex-1 justify-start gap-1.5"
                  size="sm"
                  variant="outline"
                />
              }
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">
                {folderFilter === "all"
                  ? "All chats"
                  : folderFilter === "pinned"
                    ? "Pinned chats"
                    : folderFilter.startsWith("folder:")
                      ? (folders.find(
                          (folder) => folder.id === folderFilter.slice(7)
                        )?.name ?? "Folder")
                      : (tags.find((tag) => tag.id === folderFilter.slice(4))
                          ?.name ?? "Tag")}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onClick={() => setFolderFilter("all")}>
                All chats
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFolderFilter("pinned")}>
                <Pin data-icon="inline-start" /> Pinned chats
              </DropdownMenuItem>
              {folders.length > 0 && <DropdownMenuSeparator />}
              {folders.map((folder) => (
                <DropdownMenuItem
                  key={folder.id}
                  onClick={() => setFolderFilter(`folder:${folder.id}`)}
                >
                  <Folder data-icon="inline-start" /> {folder.name}
                </DropdownMenuItem>
              ))}
              {tags.length > 0 && <DropdownMenuSeparator />}
              {tags.map((tag) => (
                <DropdownMenuItem
                  key={tag.id}
                  onClick={() => setFolderFilter(`tag:${tag.id}`)}
                >
                  <Tag data-icon="inline-start" /> {tag.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setLabelError(null)
                  setManageLabelsOpen(true)
                }}
              >
                <Settings2 data-icon="inline-start" />
                Manage folders & tags
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            aria-label="Create folder"
            onClick={() => {
              setLabelError(null)
              setLabelDialog("folder")
            }}
            size="icon-sm"
            title="Create folder"
            variant="outline"
          >
            <FolderPlus />
          </Button>
          <Button
            aria-label="Create tag"
            onClick={() => {
              setLabelError(null)
              setLabelDialog("tag")
            }}
            size="icon-sm"
            title="Create tag"
            variant="outline"
          >
            <Tag />
          </Button>
          <Button
            aria-label="Manage folders and tags"
            onClick={() => {
              setLabelError(null)
              setManageLabelsOpen(true)
            }}
            size="icon-sm"
            title="Manage folders and tags"
            variant="outline"
          >
            <Settings2 />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <ThreadListPrimitive.Items>
            {({ threadListItem }) => (
              <AssistantThreadItem
                archived={false}
                onArchive={(threadId) => onArchive(threadId, true)}
                onDelete={(threadId) => {
                  const conversation = allConversations.find(
                    (item) => item.id === threadId
                  )
                  onDelete(
                    conversation ??
                      conversationForThread({
                        id: threadId,
                        title: threadListItem.title,
                        custom: threadListItem.custom,
                      })
                  )
                }}
                onRequestRename={requestRename}
                onTogglePinned={togglePinned}
                onMoveFolder={moveFolder}
                onToggleTag={toggleTag}
                folders={folders}
                tags={tags}
                collapsedFolders={collapsedFolders}
                onToggleFolder={toggleFolder}
                thread={threadListItem}
              />
            )}
          </ThreadListPrimitive.Items>
          {archivedConversations.length > 0 && (
            <section className="mt-4 border-t border-border/70 pt-3">
              <button
                aria-expanded={archivedOpen}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                onClick={() => setArchivedOpen((open) => !open)}
                type="button"
              >
                <span>Archived chats</span>
                <span className="flex items-center gap-1.5">
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                    {archivedConversations.length}
                  </span>
                  <ChevronDown
                    className={`size-3.5 transition-transform ${archivedOpen ? "" : "-rotate-90"}`}
                  />
                </span>
              </button>
              {archivedOpen && (
                <div className="mt-1">
                  <ThreadListPrimitive.Items archived>
                    {({ threadListItem }) => (
                      <AssistantThreadItem
                        archived
                        onArchive={(threadId) => onArchive(threadId, false)}
                        onDelete={(threadId) => {
                          const conversation = allConversations.find(
                            (item) => item.id === threadId
                          )
                          onDelete(
                            conversation ??
                              conversationForThread({
                                id: threadId,
                                title: threadListItem.title,
                                custom: threadListItem.custom,
                              })
                          )
                        }}
                        onRequestRename={requestRename}
                        onTogglePinned={togglePinned}
                        onMoveFolder={moveFolder}
                        onToggleTag={toggleTag}
                        folders={folders}
                        tags={tags}
                        collapsedFolders={collapsedFolders}
                        onToggleFolder={toggleFolder}
                        thread={threadListItem}
                      />
                    )}
                  </ThreadListPrimitive.Items>
                </div>
              )}
            </section>
          )}
          <ThreadListPrimitive.LoadMore className="mt-2 w-full rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted" />
          {!conversations.length && !archivedConversations.length && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {historyQuery
                ? "No chats found."
                : "No chats yet. Start a new chat."}
            </p>
          )}
        </div>
      </ThreadListPrimitive.Root>
      <Dialog
        onOpenChange={(open) => {
          setManageLabelsOpen(open)
          if (open) setLabelError(null)
        }}
        open={manageLabelsOpen}
      >
        <DialogContent className="max-h-[min(42rem,calc(100vh-2rem))] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage folders and tags</DialogTitle>
            <DialogDescription>
              Rename or delete the labels used to organize your chats.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium">Folders</h3>
                <Badge variant="secondary">{folders.length}</Badge>
              </div>
              {folders.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {folders.map((folder) => (
                    <div
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 py-2"
                      key={folder.id}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {folder.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          aria-label={`Edit folder ${folder.name}`}
                          onClick={() =>
                            startLabelEdit({
                              kind: "folder",
                              id: folder.id,
                              name: folder.name,
                            })
                          }
                          size="icon-sm"
                          title={`Edit folder ${folder.name}`}
                          variant="ghost"
                        >
                          <Pencil />
                        </Button>
                        <Button
                          aria-label={`Delete folder ${folder.name}`}
                          className="text-destructive hover:text-destructive"
                          onClick={() =>
                            startLabelDelete({
                              kind: "folder",
                              id: folder.id,
                              name: folder.name,
                            })
                          }
                          size="icon-sm"
                          title={`Delete folder ${folder.name}`}
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                  No folders yet.
                </p>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium">Tags</h3>
                <Badge variant="secondary">{tags.length}</Badge>
              </div>
              {tags.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {tags.map((tag) => (
                    <div
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 py-2"
                      key={tag.id}
                    >
                      <Tag className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {tag.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          aria-label={`Edit tag ${tag.name}`}
                          onClick={() =>
                            startLabelEdit({
                              kind: "tag",
                              id: tag.id,
                              name: tag.name,
                            })
                          }
                          size="icon-sm"
                          title={`Edit tag ${tag.name}`}
                          variant="ghost"
                        >
                          <Pencil />
                        </Button>
                        <Button
                          aria-label={`Delete tag ${tag.name}`}
                          className="text-destructive hover:text-destructive"
                          onClick={() =>
                            startLabelDelete({
                              kind: "tag",
                              id: tag.id,
                              name: tag.name,
                            })
                          }
                          size="icon-sm"
                          title={`Delete tag ${tag.name}`}
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                  No tags yet.
                </p>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open && !labelEditSaving) {
            setLabelEditTarget(null)
            setLabelError(null)
          }
        }}
        open={labelEditTarget !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Rename {labelEditTarget?.kind === "folder" ? "folder" : "tag"}
            </DialogTitle>
            <DialogDescription>
              The new name will be applied everywhere this label appears.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={
              labelEditTarget?.kind === "folder" ? "Folder name" : "Tag name"
            }
            autoFocus
            maxLength={labelEditTarget?.kind === "folder" ? 80 : 40}
            onChange={(event) => setLabelEditName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void submitLabelEdit()
              }
            }}
            value={labelEditName}
          />
          {labelError && (
            <p className="text-xs text-destructive">{labelError}</p>
          )}
          <DialogFooter>
            <Button
              disabled={labelEditSaving}
              onClick={() => {
                setLabelEditTarget(null)
                setLabelError(null)
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={labelEditSaving || !labelEditName.trim()}
              onClick={() => void submitLabelEdit()}
            >
              {labelEditSaving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open && !labelDeleteSaving) {
            setLabelDeleteTarget(null)
            setLabelError(null)
          }
        }}
        open={labelDeleteTarget !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {labelDeleteTarget?.kind === "folder" ? "folder" : "tag"}?
            </DialogTitle>
            <DialogDescription>
              {labelDeleteTarget?.kind === "folder"
                ? `Chats in “${labelDeleteTarget.name}” will become unfiled.`
                : `The “${labelDeleteTarget?.name}” tag will be removed from all chats.`}
            </DialogDescription>
          </DialogHeader>
          {labelError && (
            <p className="text-xs text-destructive">{labelError}</p>
          )}
          <DialogFooter>
            <Button
              disabled={labelDeleteSaving}
              onClick={() => {
                setLabelDeleteTarget(null)
                setLabelError(null)
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={labelDeleteSaving}
              onClick={() => void deleteLabel()}
              variant="destructive"
            >
              {labelDeleteSaving ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open && !renameSaving) setRenameTarget(null)
        }}
        open={renameTarget !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              Choose a short name that makes this conversation easy to find.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Chat name"
            autoFocus
            maxLength={160}
            onChange={(event) => setRenameTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void submitRename()
              }
            }}
            value={renameTitle}
          />
          <DialogFooter>
            <Button
              disabled={renameSaving}
              onClick={() => setRenameTarget(null)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={renameSaving || !renameTitle.trim()}
              onClick={() => void submitRename()}
            >
              {renameSaving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open && !labelSaving) {
            setLabelDialog(null)
            setLabelName("")
            setLabelError(null)
          }
        }}
        open={labelDialog !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Create {labelDialog === "folder" ? "folder" : "tag"}
            </DialogTitle>
            <DialogDescription>
              Organize chats so they are easier to find later.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={labelDialog === "folder" ? "Folder name" : "Tag name"}
            autoFocus
            maxLength={80}
            onChange={(event) => setLabelName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void createLabel()
              }
            }}
            placeholder={
              labelDialog === "folder" ? "Project work" : "Important"
            }
            value={labelName}
          />
          {labelError && (
            <p className="text-xs text-destructive">{labelError}</p>
          )}
          <DialogFooter>
            <Button
              disabled={labelSaving}
              onClick={() => {
                setLabelDialog(null)
                setLabelError(null)
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={labelSaving || !labelName.trim()}
              onClick={() => void createLabel()}
            >
              {labelSaving ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AssistantRuntimeProvider>
  )
}
