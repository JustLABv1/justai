"use client"

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react"
import { useMemo, useState } from "react"
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Conversation } from "@/lib/types"
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
}

function metadata(conversation: Conversation, status: "regular" | "archived") {
  return {
    remoteId: conversation.id,
    title: conversation.title,
    status,
    lastMessageAt: new Date(conversation.updatedAt),
    custom: { messageCount: conversation.messageCount },
  } as const
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
  thread,
}: {
  archived: boolean
  onArchive: (threadId: string) => void
  onDelete: (threadId: string) => void
  onRequestRename: (threadId: string, title: string) => void
  thread: { id: string; title?: string; custom?: Record<string, unknown> }
}) {
  const count =
    typeof thread.custom?.messageCount === "number"
      ? thread.custom.messageCount
      : 0
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
}: AssistantThreadListProps) {
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    id: string
    title: string
  } | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [renameSaving, setRenameSaving] = useState(false)

  const allConversations = useMemo(
    () => [...conversations, ...archivedConversations],
    [archivedConversations, conversations]
  )
  const adapter = useMemo<RemoteThreadListAdapter>(
    () => ({
      async list() {
        const query = historyQuery.trim().toLocaleLowerCase()
        const regular = conversations
          .filter(
            (item) => !query || item.title.toLocaleLowerCase().includes(query)
          )
          .map((item) => metadata(item, "regular"))
        const archived = archivedConversations
          .filter(
            (item) => !query || item.title.toLocaleLowerCase().includes(query)
          )
          .map((item) => metadata(item, "archived"))
        return { threads: [...regular, ...archived] }
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
        if (conversation) onDelete(conversation)
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
        const conversation = allConversations.find(
          (item) => item.id === threadId
        )
        if (!conversation) throw new Error("Conversation not found")
        return metadata(
          conversation,
          archivedConversations.some((item) => item.id === threadId)
            ? "archived"
            : "regular"
        )
      },
      async generateTitle() {
        return emptyAssistantStream()
      },
    }),
    [
      allConversations,
      archivedConversations,
      conversations,
      historyQuery,
      onArchive,
      onDelete,
      onRename,
    ]
  )

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
                  if (conversation) onDelete(conversation)
                }}
                onRequestRename={requestRename}
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
                          if (conversation) onDelete(conversation)
                        }}
                        onRequestRename={requestRename}
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
    </AssistantRuntimeProvider>
  )
}
