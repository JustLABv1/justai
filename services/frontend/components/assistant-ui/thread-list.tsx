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
  Tag,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  AssistantRuntimeProvider,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"

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

type AssistantThreadListProps = {
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
  thread,
}: {
  archived: boolean
  onArchive: (threadId: string) => void
  onDelete: (threadId: string) => void
  onRequestRename: (threadId: string, title: string) => void
  onTogglePinned: (threadId: string, pinned: boolean) => void | Promise<void>
  onMoveFolder: (threadId: string, folderId: string | null) => void | Promise<void>
  onToggleTag: (threadId: string, tagId: string, attached: boolean) => void | Promise<void>
  folders: ConversationFolder[]
  tags: ConversationTag[]
  thread: { id: string; title?: string; custom?: Record<string, unknown> }
}) {
  const count =
    typeof thread.custom?.messageCount === "number"
      ? thread.custom.messageCount
      : 0
  const pinned = typeof thread.custom?.pinnedAt === "string"
  const folderId = typeof thread.custom?.folderId === "string" ? thread.custom.folderId : null
  const threadTags = Array.isArray(thread.custom?.tags)
    ? (thread.custom.tags as ConversationTag[])
    : []
  return (
    <ThreadListItemPrimitive.Root className="group relative rounded-xl data-[active=true]:bg-accent">
      <ThreadListItemPrimitive.Trigger
        aria-label={`Open ${thread.title || "conversation"}`}
        className="flex min-h-12 w-full items-center gap-2 rounded-xl px-2.5 py-2 pr-9 text-left text-xs hover:bg-accent/70"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-border group-data-[active=true]:bg-primary" />
        <span className="min-w-0 flex-1">
          <ThreadListItemPrimitive.Title fallback="New conversation" />
          <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground">
            {count} message{count === 1 ? "" : "s"}
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
          <DropdownMenuItem onClick={() => void onTogglePinned(thread.id, !pinned)}>
            {pinned ? <PinOff data-icon="inline-start" /> : <Pin data-icon="inline-start" />}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Folder data-icon="inline-start" />
              Move to folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => void onMoveFolder(thread.id, null)}>
                No folder
              </DropdownMenuItem>
              {folders.map((folder) => (
                <DropdownMenuItem key={folder.id} onClick={() => void onMoveFolder(thread.id, folder.id)}>
                  {folder.name}{folder.id === folderId ? " · Current" : ""}
                </DropdownMenuItem>
              ))}
              {!folders.length && <DropdownMenuItem disabled>No folders yet</DropdownMenuItem>}
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
              {!tags.length && <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>}
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
  )
}

export function AssistantThreadList({
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
  const [labelDialog, setLabelDialog] = useState<"folder" | "tag" | null>(null)
  const [labelName, setLabelName] = useState("")
  const [labelSaving, setLabelSaving] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    id: string
    title: string
  } | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [renameSaving, setRenameSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get<{ folders: ConversationFolder[] }>("/api/v1/conversation-folders"),
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
  }, [])

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
          threads: response.conversations.map((conversation) =>
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
    [allConversations, folderFilter, historyQuery, onArchive, onDelete, onRename]
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
    } finally {
      setLabelSaving(false)
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
                <Button className="min-w-0 flex-1 justify-start gap-1.5" size="sm" variant="outline" />
              }
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">
                {folderFilter === "all"
                  ? "All chats"
                  : folderFilter === "pinned"
                    ? "Pinned chats"
                    : folderFilter.startsWith("folder:")
                      ? folders.find((folder) => folder.id === folderFilter.slice(7))?.name ?? "Folder"
                      : tags.find((tag) => tag.id === folderFilter.slice(4))?.name ?? "Tag"}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onClick={() => setFolderFilter("all")}>All chats</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFolderFilter("pinned")}>
                <Pin data-icon="inline-start" /> Pinned chats
              </DropdownMenuItem>
              {folders.length > 0 && <DropdownMenuSeparator />}
              {folders.map((folder) => (
                <DropdownMenuItem key={folder.id} onClick={() => setFolderFilter(`folder:${folder.id}`)}>
                  <Folder data-icon="inline-start" /> {folder.name}
                </DropdownMenuItem>
              ))}
              {tags.length > 0 && <DropdownMenuSeparator />}
              {tags.map((tag) => (
                <DropdownMenuItem key={tag.id} onClick={() => setFolderFilter(`tag:${tag.id}`)}>
                  <Tag data-icon="inline-start" /> {tag.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            aria-label="Create folder"
            onClick={() => setLabelDialog("folder")}
            size="icon-sm"
            title="Create folder"
            variant="outline"
          >
            <FolderPlus />
          </Button>
          <Button
            aria-label="Create tag"
            onClick={() => setLabelDialog("tag")}
            size="icon-sm"
            title="Create tag"
            variant="outline"
          >
            <Tag />
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
            placeholder={labelDialog === "folder" ? "Project work" : "Important"}
            value={labelName}
          />
          <DialogFooter>
            <Button disabled={labelSaving} onClick={() => setLabelDialog(null)} variant="outline">
              Cancel
            </Button>
            <Button disabled={labelSaving || !labelName.trim()} onClick={() => void createLabel()}>
              {labelSaving ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AssistantRuntimeProvider>
  )
}
