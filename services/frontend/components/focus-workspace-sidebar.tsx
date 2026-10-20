"use client"

import {
  Fragment,
  useMemo,
  useState,
} from "react"
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FileVideo,
  FolderKanban,
  FileText,
  Headphones,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Plug,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { BrandMark } from "@/components/brand-mark"
import { AssistantThreadList } from "@/components/assistant-ui/thread-list"
import { GlobalSearchDialog } from "@/components/global-search-dialog"
import { ThemeMenu } from "@/components/theme-switcher"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import type {
  Conversation,
  Organization,
  TranscriptionSession,
  User,
  SettingsTab,
  AdminTab,
  ViewId,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { resolveAPIURL } from "@/lib/api"
import { avatarToneFor, versionedAvatarURL } from "@/lib/identity"

export const railNavigation: Array<{
  id: ViewId
  label: string
  hint: string
  icon: LucideIcon
  group: string
  feature?: string
}> = [
  {
    id: "chat",
    label: "Chat",
    hint: "Conversations",
    icon: MessageSquare,
    group: "Create",
  },
  {
    id: "agents",
    label: "Agents",
    hint: "Native and connected agents",
    icon: Bot,
    group: "Create",
  },
  {
    id: "transcription",
    label: "Live transcription",
    hint: "Rooms and transcripts",
    icon: Headphones,
    group: "Capture",
    feature: "transcription",
  },
  {
    id: "video-transcription",
    label: "Video transcription",
    hint: "Upload and transcribe videos",
    icon: FileVideo,
    group: "Capture",
    feature: "transcription",
  },
  {
    id: "templates",
    label: "Templates",
    hint: "Reusable document templates",
    icon: FileText,
    group: "Storage",
  },
  {
    id: "knowledge",
    label: "Storage",
    hint: "Folders, files, transcripts, and repositories",
    icon: FolderKanban,
    group: "Storage",
  },
  {
    id: "integrations",
    label: "Integrations",
    hint: "GitHub, GitLab, and more",
    icon: Plug,
    group: "Connect",
    feature: "mcp",
  },
]

type FocusWorkspaceSidebarProps = {
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
  historyOpen: boolean
  onHistoryOpenChange: (open: boolean) => void
  onNavigate: (
    view: ViewId,
    conversationId?: string | null,
    sessionId?: string | null,
    settingsTab?: SettingsTab,
    adminTab?: AdminTab
  ) => void
  onOrganizationSelect: (organizationId: string) => void
  onArchiveConversation: (conversationId: string, archived: boolean) => void
  onDeleteConversation: (conversation: Conversation) => void
  onRenameConversation: (
    conversationId: string,
    title: string
  ) => void | Promise<void>
  onShareConversation: (
    conversationId: string,
    visibility: "private" | "workspace"
  ) => void | Promise<void>
  onConversationRefresh?: () => void | Promise<void>
  onArchiveSession: (sessionId: string, archived: boolean) => void
  onDeleteSession: (session: TranscriptionSession) => void
  onNewTranscriptionSession: () => void
  onNewVideoTranscription: () => void
  onSignOut: () => void
  disabledFeatures: Record<string, string>
}

type RecencyGroup<T> = {
  label: string
  items: T[]
}

type CreateAction = {
  label: string
  hint: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
}

export function FocusWorkspaceSidebar({
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
  historyOpen,
  onHistoryOpenChange,
  onNavigate,
  onOrganizationSelect,
  onArchiveConversation,
  onDeleteConversation,
  onRenameConversation,
  onShareConversation,
  onConversationRefresh,
  onArchiveSession,
  onDeleteSession,
  onNewTranscriptionSession,
  onNewVideoTranscription,
  onSignOut,
  disabledFeatures,
}: FocusWorkspaceSidebarProps) {
  const [historyQuery, setHistoryQuery] = useState("")
  const [sessionQuery, setSessionQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [archivedSessionsOpen, setArchivedSessionsOpen] = useState(false)
  const { setOpenMobile } = useSidebar()
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false)
  const closeOverlays = () => {
    setOpenMobile(false)
    setHistoryDialogOpen(false)
  }

  const historyView =
    activeView === "chat" ||
    activeView === "transcription" ||
    activeView === "video-transcription"
  const navigation = railNavigation

  const createAction: CreateAction | null =
    activeView === "chat"
      ? {
          label: "New conversation",
          hint: "Start a new conversation",
          icon: Plus,
          onClick: () => onNavigate("chat"),
        }
      : activeView === "transcription"
        ? {
            label: "New live session",
            hint: "Create a live transcription room",
            icon: Headphones,
            onClick: onNewTranscriptionSession,
            disabled: Boolean(disabledFeatures.transcription),
          }
        : activeView === "video-transcription"
          ? {
              label: "New video transcription",
              hint: "Upload and transcribe a video",
              icon: FileVideo,
              onClick: onNewVideoTranscription,
              disabled: Boolean(disabledFeatures.transcription),
            }
          : null
  const CreateIcon = createAction?.icon ?? Plus

  const liveSessions = useMemo(
    () => transcriptionSessions.filter((session) => session.kind !== "video"),
    [transcriptionSessions]
  )
  const videoSessions = useMemo(
    () => transcriptionSessions.filter((session) => session.kind === "video"),
    [transcriptionSessions]
  )
  const archivedLiveSessions = useMemo(
    () =>
      archivedTranscriptionSessions.filter(
        (session) => session.kind !== "video"
      ),
    [archivedTranscriptionSessions]
  )
  const archivedVideoSessions = useMemo(
    () =>
      archivedTranscriptionSessions.filter(
        (session) => session.kind === "video"
      ),
    [archivedTranscriptionSessions]
  )
  const visibleSessions =
    activeView === "video-transcription" ? videoSessions : liveSessions
  const visibleArchivedSessions =
    activeView === "video-transcription"
      ? archivedVideoSessions
      : archivedLiveSessions
  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase()
    if (!query) return visibleSessions
    return visibleSessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(query)
    )
  }, [sessionQuery, visibleSessions])
  const filteredArchivedSessions = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase()
    if (!query) return visibleArchivedSessions
    return visibleArchivedSessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(query)
    )
  }, [sessionQuery, visibleArchivedSessions])
  const sessionGroups = useMemo(
    () => groupByRecency(filteredSessions),
    [filteredSessions]
  )
  const archivedSessionGroups = useMemo(
    () => groupByRecency(filteredArchivedSessions),
    [filteredArchivedSessions]
  )

  function navigateFromRail(view: ViewId) {
    const railItem = navigation.find((item) => item.id === view)
    if (railItem?.feature && disabledFeatures[railItem.feature]) return

    if (view === "chat") {
      // The primary rail is a creation shortcut. Conversation history remains
      // available in the secondary rail, where reopening an existing item is
      // an explicit choice.
      onNavigate("chat", null)
      return
    }

    onNavigate(view)
  }

  const recentItems = useMemo(() => {
    if (activeView === "chat") {
      return [...conversations]
        .sort((l, r) => new Date(r.updatedAt).getTime() - new Date(l.updatedAt).getTime())
        .slice(0, 6)
        .map((item) => ({ id: item.id, title: item.title, status: "" }))
    }
    return [...visibleSessions]
      .sort((l, r) => new Date(r.updatedAt).getTime() - new Date(l.updatedAt).getTime())
      .slice(0, 6)
      .map((item) => ({ id: item.id, title: item.title, status: item.status }))
  }, [activeView, conversations, visibleSessions])
  const historyMode = activeView === "chat" ? "chat" : "sessions"
  const historyTitle =
    activeView === "chat"
      ? "Chat history"
      : activeView === "video-transcription"
        ? "Video transcripts"
        : "Live sessions"
  const historyPanel = historyView ? (
    <div
      aria-label={
        activeView === "chat"
          ? "Chat history"
          : activeView === "video-transcription"
            ? "Video transcripts"
            : "Live sessions"
      }
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden pt-1 pb-1"
      role="region"
    >
      {createAction && (
        <Button
          aria-label={createAction.label}
          className="h-8 w-full shrink-0 justify-start gap-2 rounded-xl"
          disabled={createAction.disabled}
          onClick={() => {
            closeOverlays()
            createAction.onClick()
          }}
          size="sm"
        >
          <CreateIcon data-icon="inline-start" />
          {createAction.label}
        </Button>
      )}

      {actionError && (
        <Alert className="shrink-0" variant="destructive">
          <AlertDescription className="text-xs">{actionError}</AlertDescription>
        </Alert>
      )}

      {historyMode === "chat" ? (
        <AssistantThreadList
          activeConversationId={activeConversationId}
          archivedConversations={archivedConversations}
          conversations={conversations}
          historyQuery={historyQuery}
          organizationId={activeOrganization?.id ?? null}
          onArchive={onArchiveConversation}
          onConversationRefresh={onConversationRefresh}
          onDelete={onDeleteConversation}
          onHistoryQueryChange={setHistoryQuery}
          onRename={onRenameConversation}
          onSelect={(id) => {
            closeOverlays()
            onNavigate("chat", id)
          }}
          onShare={onShareConversation}
        />
      ) : (
        <>
          <Input
            aria-label="Search sessions"
            className="h-8 shrink-0"
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder={
              activeView === "video-transcription"
                ? "Search videos"
                : "Search sessions"
            }
            type="search"
            value={sessionQuery}
          />
          <TranscriptionHistoryPanel
            activeSessionId={activeSessionId}
            archivedOpen={archivedSessionsOpen}
            archivedSessionGroups={archivedSessionGroups}
            archivedSessions={filteredArchivedSessions}
            onArchive={onArchiveSession}
            onDelete={onDeleteSession}
            onSelect={(id) => {
              closeOverlays()
              onNavigate(
                activeView === "video-transcription"
                  ? "video-transcription"
                  : "transcription",
                null,
                id
              )
            }}
            sessionGroups={sessionGroups}
            setArchivedOpen={setArchivedSessionsOpen}
            video={activeView === "video-transcription"}
          />
        </>
      )}
    </div>
  ) : null

  return (
    <>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="gap-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      aria-label={`Select workspace (${activeOrganization?.name ?? "Workspace"})`}
                      className="gap-2.5"
                      size="lg"
                    />
                  }
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white">
                    <BrandMark aria-hidden="true" className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1 text-left leading-tight">
                    <span className="block truncate text-sm font-semibold">JustAI</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {activeOrganization?.name ?? "Workspace"}
                    </span>
                  </span>
                  <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64" side="bottom">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {organizations.map((organization) => (
                      <DropdownMenuItem
                        key={organization.id}
                        onClick={() => onOrganizationSelect(organization.id)}
                      >
                        <Bot data-icon="inline-start" />
                        <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                        {organization.id === activeOrganization?.id && (
                          <span className="text-xs text-muted-foreground">Current</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onNavigate("settings")}>
                    <Settings2 data-icon="inline-start" />
                    Manage workspaces
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-keyshortcuts="Meta+K Control+K"
                aria-label="Search workspace"
                className="h-9 bg-sidebar-accent/60 text-sm text-muted-foreground"
                onClick={() => setSearchOpen(true)}
                tooltip="Search workspace · ⌘K"
              >
                <Search />
                <span className="flex-1 text-left font-normal">Search…</span>
                <kbd className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {[...new Set(navigation.map((item) => item.group))].map((group) => (
            <SidebarGroup key={group}>
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigation
                    .filter((item) => item.group === group)
                    .map((item) => {
                      const Icon = item.icon
                      const active = activeView === item.id
                      const disabled = Boolean(
                        item.feature && disabledFeatures[item.feature]
                      )
                      const hasHistory =
                        item.id === "chat" ||
                        item.id === "transcription" ||
                        item.id === "video-transcription"
                      const button = (
                        <SidebarMenuButton
                          aria-current={active ? "page" : undefined}
                          className="text-sm"
                          disabled={disabled}
                          isActive={active}
                          onClick={() => navigateFromRail(item.id)}
                          tooltip={
                            disabled ? "Disabled by platform administrator" : item.label
                          }
                        >
                          <Icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      )
                      if (!hasHistory || !active) {
                        return <SidebarMenuItem key={item.id}>{button}</SidebarMenuItem>
                      }
                      return (
                        <Collapsible
                          key={item.id}
                          onOpenChange={onHistoryOpenChange}
                          open={historyOpen}
                          render={<SidebarMenuItem />}
                        >
                          {button}
                          {createAction && (
                            <SidebarMenuAction
                              aria-label={createAction.label}
                              disabled={createAction.disabled}
                              onClick={() => {
                                setOpenMobile(false)
                                createAction.onClick()
                              }}
                              title={createAction.label}
                            >
                              <Plus />
                            </SidebarMenuAction>
                          )}
                          <CollapsibleTrigger
                            render={<SidebarMenuAction className="right-7" aria-label={historyOpen ? `Hide ${historyTitle.toLocaleLowerCase()}` : `Show ${historyTitle.toLocaleLowerCase()}`} />}
                          >
                            <ChevronRight className="transition-transform group-data-[open]/menu-item:rotate-90 in-data-[open]:rotate-90" />
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <SidebarMenuSub>
                              {recentItems.map((entry) => {
                                const entryActive =
                                  activeView === "chat"
                                    ? activeConversationId === entry.id
                                    : activeSessionId === entry.id
                                return (
                                  <SidebarMenuSubItem key={entry.id}>
                                    <SidebarMenuSubButton
                                      isActive={entryActive}
                                      render={<button type="button" />}
                                      onClick={() => {
                                        setOpenMobile(false)
                                        if (activeView === "chat") onNavigate("chat", entry.id)
                                        else onNavigate(activeView, null, entry.id)
                                      }}
                                      title={entry.title}
                                    >
                                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                                      {entry.status === "failed" ? (
                                        <span aria-label="Failed" className="size-1.5 shrink-0 rounded-full bg-destructive" />
                                      ) : entry.status === "live" ? (
                                        <span aria-label="Live" className="size-1.5 shrink-0 rounded-full bg-primary" />
                                      ) : null}
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                )
                              })}
                              <SidebarMenuSubItem>
                                <SidebarMenuSubButton
                                  render={<button type="button" />}
                                  onClick={() => setHistoryDialogOpen(true)}
                                  className="text-muted-foreground hover:text-sidebar-accent-foreground"
                                >
                                  <span>View all…</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </Collapsible>
                      )
                    })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-current={activeView === "settings" ? "page" : undefined}
                className="text-sm"
                isActive={activeView === "settings"}
                onClick={() => onNavigate("settings")}
                tooltip="Workspace settings"
              >
                <Settings2 />
                <span>Workspace settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {user.platformAdmin && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-current={activeView === "admin" ? "page" : undefined}
                  className="text-sm"
                  isActive={activeView === "admin"}
                  onClick={() => onNavigate("admin")}
                  tooltip="Platform admin"
                >
                  <ShieldCheck />
                  <span>Platform admin</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      aria-label={`${user.displayName} account menu`}
                      size="lg"
                    />
                  }
                >
                  <Avatar size="sm">
                    {user.avatarUrl && (
                      <AvatarImage
                        alt={`${user.displayName}'s profile picture`}
                        src={resolveAPIURL(
                          versionedAvatarURL(user.avatarUrl, user.avatarVersion) ?? user.avatarUrl
                        )}
                      />
                    )}
                    <AvatarFallback className={avatarToneFor(user.id)}>{userInitials}</AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-medium">{user.displayName}</span>
                    <span className="block truncate text-[11px] font-normal text-muted-foreground">
                      {activeOrganization?.name ?? user.email}
                    </span>
                  </span>
                  <MoreHorizontal aria-hidden="true" className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56" side="top">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <span className="block truncate text-xs font-medium">{user.displayName}</span>
                      <span className="block truncate text-[11px] font-normal text-muted-foreground">{user.email}</span>
                      {activeOrganization?.role && (
                        <span className="mt-1 block truncate text-[11px] font-normal text-muted-foreground">
                          {activeOrganization.name} · {activeOrganization.role}
                        </span>
                      )}
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <ThemeMenu />
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onNavigate("profile")}>
                    <UserRound data-icon="inline-start" />
                    Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onSignOut}>
                    <LogOut data-icon="inline-start" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <Dialog onOpenChange={setHistoryDialogOpen} open={historyDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{historyTitle}</DialogTitle>
          </DialogHeader>
          <div className="flex h-[60vh] min-h-0 flex-col">{historyPanel}</div>
        </DialogContent>
      </Dialog>

      <GlobalSearchDialog
        disabledFeatures={disabledFeatures}
        onNavigate={onNavigate}
        onOpenChange={setSearchOpen}
        open={searchOpen}
        platformAdmin={user.platformAdmin}
      />
    </>
  )
}

function TranscriptionHistoryPanel({
  activeSessionId,
  archivedSessionGroups,
  archivedSessions,
  archivedOpen,
  onArchive,
  onDelete,
  onSelect,
  sessionGroups,
  setArchivedOpen,
  video,
}: {
  activeSessionId: string | null
  archivedSessionGroups: RecencyGroup<TranscriptionSession>[]
  archivedSessions: TranscriptionSession[]
  archivedOpen: boolean
  onArchive: (id: string, archived: boolean) => void
  onDelete: (session: TranscriptionSession) => void
  onSelect: (id: string) => void
  sessionGroups: RecencyGroup<TranscriptionSession>[]
  setArchivedOpen: (open: boolean) => void
  video: boolean
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {sessionGroups.length > 0 ? (
          <div className="flex flex-col gap-4 pt-1">
            {sessionGroups.map((group) => (
              <SessionGroup
                activeSessionId={activeSessionId}
                group={group}
                key={group.label}
                onArchive={onArchive}
                onDelete={onDelete}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : (
          <Empty className="min-h-0 rounded-lg border-0 p-4">
            <EmptyHeader>
              <EmptyTitle>
                {video ? "No videos yet" : "No sessions yet"}
              </EmptyTitle>
              <EmptyDescription>
                {video
                  ? "Upload a video to create one."
                  : "Start listening to create one."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {archivedSessions.length > 0 && (
          <Collapsible onOpenChange={setArchivedOpen} open={archivedOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  className="mt-4 w-full justify-start"
                  size="sm"
                  variant="ghost"
                />
              }
            >
              <Archive data-icon="inline-start" />
              Archived
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {archivedSessions.length}
              </span>
              {archivedOpen ? <ChevronDown /> : <ChevronRight />}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <div className="flex flex-col gap-4">
                {archivedSessionGroups.map((group) => (
                  <SessionGroup
                    activeSessionId={activeSessionId}
                    archived
                    group={group}
                    key={group.label}
                    onArchive={onArchive}
                    onDelete={onDelete}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
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
      <div className="flex flex-col gap-1">
        {group.items.map((session) => (
          <SessionRow
            active={activeSessionId === session.id}
            archived={archived}
            key={session.id}
            onArchive={onArchive}
            onDelete={onDelete}
            onSelect={onSelect}
            session={session}
          />
        ))}
      </div>
    </div>
  )
}

function SessionRow({
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
  const hasProcessingWarning =
    session.kind === "video" &&
    session.status === "completed" &&
    session.polishStatus === "failed"
  const statusLabel = hasProcessingWarning
    ? "completed · grammar failed"
    : session.status
  const statusDescription = hasProcessingWarning
    ? "Grammar polish failed"
    : session.status
  const failed = session.status === "failed"

  return (
    <div className="group relative">
      <Button
        aria-current={active ? "page" : undefined}
        className={cn(
          "h-auto min-h-12 w-full justify-start gap-2 pr-9 text-left",
          active && "bg-accent text-accent-foreground"
        )}
        onClick={() => onSelect(session.id)}
        title={`${session.title} · ${statusLabel}`}
        variant="ghost"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            failed
              ? "bg-destructive"
              : hasProcessingWarning
                ? active
                  ? "bg-amber-300"
                  : "bg-amber-500"
                : session.status === "live" || active
                  ? "bg-primary"
                  : "bg-border"
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {session.title}
          </span>
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-[11px] font-normal",
              active ? "text-accent-foreground/75" : "text-muted-foreground"
            )}
          >
            <span className={cn("min-w-0 truncate", failed && "text-destructive")}>
              {statusDescription}
            </span>
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="shrink-0">
              {formatItemTime(session.updatedAt)}
            </span>
          </span>
        </span>
        {session.status === "live" && (
          <Badge className="h-5 px-1.5 text-[10px]" variant="secondary">
            Live
          </Badge>
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`Actions for ${session.title}`}
              className="absolute top-1/2 right-1 size-8 -translate-y-1/2 bg-[var(--sidebar-secondary)] opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
              size="icon-xs"
              title={`Actions for ${session.title}`}
              variant="ghost"
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => onArchive(session.id, !archived)}>
            {archived ? (
              <RotateCcw data-icon="inline-start" />
            ) : (
              <Archive data-icon="inline-start" />
            )}
            {archived ? "Restore" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDelete(session)}
            variant="destructive"
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
