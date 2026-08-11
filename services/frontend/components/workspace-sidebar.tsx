"use client"

import { useMemo, useState } from "react"
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
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
  Search,
  Settings2,
  Trash2,
} from "lucide-react"

import { BrandMark } from "@/components/brand-mark"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarInput,
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
import type {
  Conversation,
  Organization,
  TranscriptionSession,
  User,
  ViewId,
} from "@/lib/types"
import { workspacePath } from "@/lib/workspace-routes"

const navigation: Array<{
  id: Exclude<ViewId, "chat" | "transcription" | "settings">
  label: string
  icon: typeof Cpu
  hint: string
}> = [
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

type WorkspaceSidebarProps = {
  activeView: ViewId
  activeConversationId: string | null
  activeSessionId: string | null
  activeOrganization: Organization | undefined
  organizations: Organization[]
  conversations: Conversation[]
  archivedConversations: Conversation[]
  transcriptionSessions: TranscriptionSession[]
  archivedTranscriptionSessions: TranscriptionSession[]
  actionError: string
  user: User
  userInitials: string
  onNavigate: (
    view: ViewId,
    conversationId?: string | null,
    sessionId?: string | null
  ) => void
  onOrganizationSelect: (organizationId: string) => void
  onArchiveConversation: (conversationId: string, archived: boolean) => void
  onDeleteConversation: (conversation: Conversation) => void
  onArchiveSession: (sessionId: string, archived: boolean) => void
  onDeleteSession: (session: TranscriptionSession) => void
  onNewTranscriptionSession: () => void
  onSignOut: () => void
}

type RecencyGroup<T> = {
  label: string
  items: T[]
}

export function WorkspaceSidebar({
  activeView,
  activeConversationId,
  activeSessionId,
  activeOrganization,
  organizations,
  conversations,
  archivedConversations,
  transcriptionSessions,
  archivedTranscriptionSessions,
  actionError,
  user,
  userInitials,
  onNavigate,
  onOrganizationSelect,
  onArchiveConversation,
  onDeleteConversation,
  onArchiveSession,
  onDeleteSession,
  onNewTranscriptionSession,
  onSignOut,
}: WorkspaceSidebarProps) {
  const [historyQuery, setHistoryQuery] = useState("")
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedSessionsOpen, setArchivedSessionsOpen] = useState(false)

  const filteredConversations = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase()
    if (!query) return conversations
    return conversations.filter((conversation) =>
      conversation.title.toLocaleLowerCase().includes(query)
    )
  }, [conversations, historyQuery])

  const filteredArchivedConversations = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase()
    if (!query) return archivedConversations
    return archivedConversations.filter((conversation) =>
      conversation.title.toLocaleLowerCase().includes(query)
    )
  }, [archivedConversations, historyQuery])

  const conversationGroups = useMemo(
    () => groupByRecency(filteredConversations),
    [filteredConversations]
  )
  const archivedConversationGroups = useMemo(
    () => groupByRecency(filteredArchivedConversations),
    [filteredArchivedConversations]
  )
  const sessionGroups = useMemo(
    () => groupByRecency(transcriptionSessions),
    [transcriptionSessions]
  )
  const archivedSessionGroups = useMemo(
    () => groupByRecency(archivedTranscriptionSessions),
    [archivedTranscriptionSessions]
  )

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="gap-4 border-b border-sidebar-border/70 px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:justify-center">
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
                      onClick={() => onOrganizationSelect(organization.id)}
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                        <Bot aria-hidden="true" />
                      </div>
                      <span className="min-w-0 flex-1 truncate">
                        {organization.name}
                      </span>
                      {organization.id === activeOrganization?.id && (
                        <span className="text-xs text-muted-foreground">
                          Current
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onNavigate("settings")}>
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
          <Alert
            className="mx-3 mt-3 group-data-[collapsible=icon]:hidden"
            variant="destructive"
          >
            <AlertDescription className="text-xs">
              {actionError}
            </AlertDescription>
          </Alert>
        )}

        <SidebarGroup className="shrink-0 px-3 py-3">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
                <Button
                  aria-label="New chat"
                  className="h-9 w-full justify-start gap-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:!p-0"
                  onClick={() => onNavigate("chat")}
                  title="New chat"
                >
                  <Plus data-icon="inline-start" />
                  <span className="group-data-[collapsible=icon]:hidden">
                    New chat
                  </span>
                </Button>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={activeView === "chat"}
                  onClick={() =>
                    onNavigate(
                      "chat",
                      activeView === "chat"
                        ? activeConversationId
                        : (conversations[0]?.id ?? null)
                    )
                  }
                  tooltip="Chat"
                >
                  <MessageSquare data-icon="inline-start" />
                  <span>Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={activeView === "transcription"}
                  onClick={() =>
                    onNavigate(
                      "transcription",
                      null,
                      activeView === "transcription"
                        ? activeSessionId
                        : (transcriptionSessions[0]?.id ?? null)
                    )
                  }
                  tooltip="Live transcription"
                >
                  <Headphones data-icon="inline-start" />
                  <span>Live transcription</span>
                  {transcriptionSessions.length > 0 && (
                    <SidebarMenuBadge>
                      {transcriptionSessions.length}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {activeView === "chat" && (
          <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-3 py-0 group-data-[collapsible=icon]:hidden">
            <SidebarGroupContent>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between px-2">
                  <SidebarGroupLabel className="h-6 p-0">
                    Chat history
                  </SidebarGroupLabel>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {conversations.length}
                  </span>
                </div>
                <div className="relative px-0.5">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <SidebarInput
                    aria-label="Search chat history"
                    className="h-9 pl-8"
                    onChange={(event) => setHistoryQuery(event.target.value)}
                    placeholder="Search chats"
                    type="search"
                    value={historyQuery}
                  />
                </div>
                {conversationGroups.length > 0 ? (
                  <div className="flex flex-col gap-4 pt-1">
                    {conversationGroups.map((group) => (
                      <ConversationGroup
                        activeConversationId={activeConversationId}
                        group={group}
                        key={group.label}
                        onArchive={onArchiveConversation}
                        onDelete={onDeleteConversation}
                        onSelect={(id) => onNavigate("chat", id)}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty className="min-h-0 rounded-lg border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>
                        {historyQuery ? "No chats found" : "No chats yet"}
                      </EmptyTitle>
                      <EmptyDescription>
                        {historyQuery
                          ? "Try a different search."
                          : "Start a new chat to create one."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}

                {archivedConversations.length > 0 && (
                  <Collapsible
                    onOpenChange={setArchivedOpen}
                    open={archivedOpen}
                  >
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <CollapsibleTrigger
                          aria-label="Toggle archived chats"
                          render={<SidebarMenuButton size="sm" />}
                        >
                          <Archive data-icon="inline-start" />
                          <span>Archived</span>
                          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                            {archivedConversations.length}
                          </span>
                          {archivedOpen ? <ChevronDown /> : <ChevronRight />}
                        </CollapsibleTrigger>
                      </SidebarMenuItem>
                    </SidebarMenu>
                    <CollapsibleContent className="pt-1">
                      {archivedConversationGroups.length > 0 ? (
                        <div className="flex flex-col gap-4">
                          {archivedConversationGroups.map((group) => (
                            <ConversationGroup
                              activeConversationId={activeConversationId}
                              archived
                              group={group}
                              key={group.label}
                              onArchive={onArchiveConversation}
                              onDelete={onDeleteConversation}
                              onSelect={(id) => onNavigate("chat", id)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                          No archived chats match your search.
                        </p>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {activeView === "transcription" && (
          <>
            <SidebarSeparator className="mx-3 my-3 w-auto shrink-0" />
            <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-3 py-0">
              <SidebarGroupContent>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between px-2">
                    <SidebarGroupLabel className="h-6 p-0">
                      Recent sessions
                    </SidebarGroupLabel>
                    <Button
                      aria-label="New live transcription session"
                      className="size-6 p-0"
                      onClick={onNewTranscriptionSession}
                      size="icon-sm"
                      title="New live transcription session"
                      variant="ghost"
                    >
                      <Plus />
                    </Button>
                  </div>
                  {sessionGroups.length > 0 ? (
                    <div className="flex flex-col gap-4 pt-1">
                      {sessionGroups.map((group) => (
                        <SessionGroup
                          activeSessionId={activeSessionId}
                          group={group}
                          key={group.label}
                          onArchive={onArchiveSession}
                          onDelete={onDeleteSession}
                          onSelect={(id) =>
                            onNavigate("transcription", null, id)
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty className="min-h-0 rounded-lg border-0 p-4">
                      <EmptyHeader>
                        <EmptyTitle>No sessions yet</EmptyTitle>
                        <EmptyDescription>
                          Start listening to create one.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  {archivedTranscriptionSessions.length > 0 && (
                    <Collapsible
                      onOpenChange={setArchivedSessionsOpen}
                      open={archivedSessionsOpen}
                    >
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <CollapsibleTrigger
                            aria-label="Toggle archived transcription sessions"
                            render={<SidebarMenuButton size="sm" />}
                          >
                            <Archive data-icon="inline-start" />
                            <span>Archived</span>
                            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                              {archivedTranscriptionSessions.length}
                            </span>
                            {archivedSessionsOpen ? (
                              <ChevronDown />
                            ) : (
                              <ChevronRight />
                            )}
                          </CollapsibleTrigger>
                        </SidebarMenuItem>
                      </SidebarMenu>
                      <CollapsibleContent className="pt-1">
                        <div className="flex flex-col gap-4">
                          {archivedSessionGroups.map((group) => (
                            <SessionGroup
                              activeSessionId={activeSessionId}
                              archived
                              group={group}
                              key={group.label}
                              onArchive={onArchiveSession}
                              onDelete={onDeleteSession}
                              onSelect={(id) =>
                                onNavigate("transcription", null, id)
                              }
                            />
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}

        <SidebarSeparator className="mx-3 my-3 w-auto" />

        <SidebarGroup className="shrink-0 px-3 py-0">
          <SidebarGroupLabel className="px-2">Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => {
                const ItemIcon = item.icon
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={activeView === item.id}
                      onClick={() => onNavigate(item.id)}
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

        <SidebarGroup className="shrink-0 px-3 py-3">
          <SidebarGroupLabel className="px-2">System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={activeView === "settings"}
                  onClick={() => onNavigate("settings")}
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

      <SidebarFooter className="px-3 py-3">
        <SidebarSeparator className="mx-0 mb-2 w-auto" />
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
                <AvatarFallback>{userInitials}</AvatarFallback>
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
              onClick={onSignOut}
              showOnHover
              title="Sign out"
            >
              <LogOut aria-hidden="true" />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function ConversationGroup({
  activeConversationId,
  archived = false,
  group,
  onArchive,
  onDelete,
  onSelect,
}: {
  activeConversationId: string | null
  archived?: boolean
  group: RecencyGroup<Conversation>
  onArchive: (id: string, archived: boolean) => void
  onDelete: (conversation: Conversation) => void
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 text-[11px] font-medium text-muted-foreground">
        {group.label}
      </p>
      <SidebarMenu>
        {group.items.map((conversation) => (
          <ConversationSidebarItem
            active={activeConversationId === conversation.id}
            archived={archived}
            conversation={conversation}
            key={conversation.id}
            onArchive={onArchive}
            onDelete={onDelete}
            onSelect={onSelect}
          />
        ))}
      </SidebarMenu>
    </div>
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
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-10 pr-8"
        isActive={active}
        render={<a href={workspacePath("chat", conversation.id)} />}
        onClick={(event) => {
          event.preventDefault()
          onSelect(conversation.id)
        }}
        title={`${conversation.title} · ${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${active ? "bg-primary" : "bg-sidebar-border"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {conversation.title}
          </span>
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {conversation.messageCount} message
            {conversation.messageCount === 1 ? "" : "s"} ·{" "}
            {formatItemTime(conversation.updatedAt)}
          </span>
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Actions for ${conversation.title}`}
              className="group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100"
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
    </SidebarMenuItem>
  )
}

function SessionGroup({
  activeSessionId,
  archived = false,
  group,
  onArchive,
  onDelete,
  onSelect,
}: {
  activeSessionId: string | null
  archived?: boolean
  group: RecencyGroup<TranscriptionSession>
  onArchive: (id: string, archived: boolean) => void
  onDelete: (session: TranscriptionSession) => void
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 text-[11px] font-medium text-muted-foreground">
        {group.label}
      </p>
      <SidebarMenu>
        {group.items.map((session) => (
          <SessionSidebarItem
            active={activeSessionId === session.id}
            archived={archived}
            key={session.id}
            onArchive={onArchive}
            onDelete={onDelete}
            onSelect={onSelect}
            session={session}
          />
        ))}
      </SidebarMenu>
    </div>
  )
}

function SessionSidebarItem({
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
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-10 pr-8"
        isActive={active}
        render={<a href={workspacePath("transcription", null, session.id)} />}
        onClick={(event) => {
          event.preventDefault()
          onSelect(session.id)
        }}
        title={`${session.title} · ${session.status}`}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${session.status === "live" ? "bg-primary" : active ? "bg-primary" : "bg-sidebar-border"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {session.title}
          </span>
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {session.status} · {formatItemTime(session.updatedAt)}
          </span>
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Actions for ${session.title}`}
              className="group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100"
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
    </SidebarMenuItem>
  )
}

function groupByRecency<T extends { updatedAt: string }>(items: T[]) {
  const groups = new Map<string, T[]>()
  const sortedItems = [...items].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )

  for (const item of sortedItems) {
    const label = getRecencyGroupLabel(item.updatedAt)
    const group = groups.get(label) ?? []
    group.push(item)
    groups.set(label, group)
  }

  return ["Today", "Yesterday", "Previous 7 days", "Older"]
    .map((label) => ({ label, items: groups.get(label) ?? [] }))
    .filter((group) => group.items.length > 0)
}

function getRecencyGroupLabel(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Older"

  const now = new Date()
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const daysAgo = Math.round((today.getTime() - dateDay.getTime()) / 86400000)

  if (daysAgo <= 0) return "Today"
  if (daysAgo === 1) return "Yesterday"
  if (daysAgo <= 7) return "Previous 7 days"
  return "Older"
}

function formatItemTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""

  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

export { formatItemTime }
