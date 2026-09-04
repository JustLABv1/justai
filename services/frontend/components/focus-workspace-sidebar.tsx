"use client"

import { Fragment, useMemo, useState } from "react"
import {
  Archive,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileVideo,
  Headphones,
  NotebookPen,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelRightOpen,
  Pin,
  PinOff,
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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

const railNavigation: Array<{
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
    id: "notes",
    label: "Notes",
    hint: "Your notes workspace",
    icon: NotebookPen,
    group: "Knowledge",
  },
  {
    id: "memory",
    label: "Memory",
    hint: "Persistent preferences",
    icon: Brain,
    group: "Knowledge",
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
  const [chatHistoryExpanded, setChatHistoryExpanded] = useState(false)
  const [historyRailPinned, setHistoryRailPinned] = useState(false)
  const historyView =
    activeView === "chat" ||
    activeView === "transcription" ||
    activeView === "video-transcription"
  const navigation = railNavigation
  const historyVisible = historyView && historyOpen
  const isSecondaryHistoryRail = historyVisible
  const contextPanelOpen =
    historyVisible &&
    (!isSecondaryHistoryRail || chatHistoryExpanded || historyRailPinned)

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
  const recentChats = useMemo(
    () =>
      [...conversations]
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime()
        )
        .slice(0, 4),
    [conversations]
  )
  const recentSessions = useMemo(
    () =>
      [...visibleSessions]
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime()
        )
        .slice(0, 4),
    [visibleSessions]
  )
  const archivedSessionGroups = useMemo(
    () => groupByRecency(filteredArchivedSessions),
    [filteredArchivedSessions]
  )
  const recentHistoryItems =
    activeView === "chat" ? recentChats : recentSessions
  const SecondaryHistoryIcon =
    activeView === "chat"
      ? MessageSquare
      : activeView === "video-transcription"
        ? FileVideo
        : Headphones
  const secondaryHistoryLabel =
    activeView === "chat"
      ? "Chat history"
      : activeView === "video-transcription"
        ? "Video transcripts"
        : "Live sessions"

  function navigateFromRail(view: ViewId) {
    setChatHistoryExpanded(false)
    const railItem = navigation.find((item) => item.id === view)
    if (railItem?.feature && disabledFeatures[railItem.feature]) return

    if (view === "chat") {
      onNavigate(
        "chat",
        activeView === "chat"
          ? activeConversationId
          : (conversations[0]?.id ?? null)
      )
      return
    }

    if (view === "transcription") {
      onNavigate(
        "transcription",
        null,
        activeView === "transcription"
          ? activeSessionId
          : (liveSessions[0]?.id ?? null)
      )
      return
    }

    if (view === "video-transcription") {
      onNavigate(
        "video-transcription",
        null,
        activeView === "video-transcription"
          ? activeSessionId
          : (videoSessions[0]?.id ?? null)
      )
      return
    }

    onNavigate(view)
  }

  const contextTitle =
    activeView === "transcription"
      ? "Live sessions"
      : activeView === "video-transcription"
        ? "Video transcripts"
        : "Chat history"
  const showContextLabel =
    activeView === "transcription"
      ? "Show live sessions"
      : activeView === "video-transcription"
        ? "Show video transcripts"
        : "Show chat history"
  return (
    <aside
      className={cn(
        "relative flex h-full min-h-0 w-14 shrink-0 overflow-visible border-r border-border bg-background",
        isSecondaryHistoryRail && "w-[6.5rem]",
        historyRailPinned && "lg:w-[19.5rem]"
      )}
      aria-label="Workspace navigation"
      data-history-open={historyVisible}
    >
      <div className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border/70 py-3">
        <BrandMark aria-label="JustAI" className="size-8 shrink-0" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Select workspace (${activeOrganization?.name ?? "Workspace"})`}
                className="size-9 rounded-xl"
                variant="ghost"
              />
            }
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
              <Bot aria-hidden="true" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64" side="right">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {organizations.map((organization) => (
                <DropdownMenuItem
                  key={organization.id}
                  onClick={() => onOrganizationSelect(organization.id)}
                >
                  <Bot data-icon="inline-start" />
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
              Manage workspaces
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-keyshortcuts="Meta+K Control+K"
                aria-label="Search workspace"
                className="size-9 rounded-xl border border-border/70 bg-muted/20 text-muted-foreground hover:border-border hover:bg-muted/45"
                onClick={() => setSearchOpen(true)}
                size="icon"
                variant="ghost"
              >
                <Search />
              </Button>
            }
          />
          <TooltipContent side="right">Search workspace · ⌘K</TooltipContent>
        </Tooltip>

        <Separator className="my-1" />
        <nav
          aria-label="Workspace navigation"
          className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain"
        >
          {navigation.map((item, index) => {
            const Icon = item.icon
            const active = activeView === item.id
            const disabled = Boolean(
              item.feature && disabledFeatures[item.feature]
            )
            const beginsGroup =
              index === 0 || navigation[index - 1]?.group !== item.group
            return (
              <Fragment key={item.id}>
                {beginsGroup && index > 0 && <Separator className="my-1 w-5" />}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-current={active ? "page" : undefined}
                        aria-label={item.label}
                        className={cn(
                          "relative size-9 rounded-xl text-muted-foreground",
                          active && "bg-accent text-accent-foreground"
                        )}
                        disabled={disabled}
                        onClick={() => navigateFromRail(item.id)}
                        size="icon"
                        variant="ghost"
                      >
                        <Icon />
                      </Button>
                    }
                  />
                  <TooltipContent side="right">
                    {disabled
                      ? "Disabled by platform administrator"
                      : item.label}
                  </TooltipContent>
                </Tooltip>
              </Fragment>
            )
          })}
        </nav>

        {!historyVisible && historyView && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={showContextLabel}
                  className="size-9 rounded-xl text-muted-foreground"
                  onClick={() => onHistoryOpenChange(true)}
                  size="icon"
                  variant="ghost"
                >
                  <PanelRightOpen />
                </Button>
              }
            />
            <TooltipContent side="right">{showContextLabel}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`${user.displayName} account menu`}
                className="size-8 rounded-full p-0"
                variant="ghost"
              />
            }
          >
            <Avatar size="sm">
              <AvatarFallback>{userInitials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" side="right">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="block truncate text-xs font-medium">
                  {user.displayName}
                </span>
                <span className="block truncate text-[11px] font-normal text-muted-foreground">
                  {user.email}
                </span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <ThemeMenu />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onNavigate("profile")}>
              <UserRound data-icon="inline-start" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onNavigate("settings")}>
              <Settings2 data-icon="inline-start" />
              Workspace settings
            </DropdownMenuItem>
            {user.platformAdmin && (
              <DropdownMenuItem onClick={() => onNavigate("admin")}>
                <ShieldCheck data-icon="inline-start" />
                Platform admin
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut data-icon="inline-start" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <GlobalSearchDialog
        disabledFeatures={disabledFeatures}
        onNavigate={onNavigate}
        onOpenChange={setSearchOpen}
        open={searchOpen}
        platformAdmin={user.platformAdmin}
      />

      <div
        className={cn(
          isSecondaryHistoryRail ? "relative h-full w-12 shrink-0" : "contents",
          historyRailPinned && "lg:contents"
        )}
        onBlurCapture={(event) => {
          if (
            isSecondaryHistoryRail &&
            !historyRailPinned &&
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setChatHistoryExpanded(false)
          }
        }}
        onFocusCapture={() => {
          if (isSecondaryHistoryRail) setChatHistoryExpanded(true)
        }}
        onMouseEnter={() => {
          if (isSecondaryHistoryRail) setChatHistoryExpanded(true)
        }}
        onMouseLeave={() => {
          if (isSecondaryHistoryRail && !historyRailPinned) {
            setChatHistoryExpanded(false)
          }
        }}
      >
        {isSecondaryHistoryRail && (
          <div
            className={cn(
              "flex h-full w-12 flex-col items-center gap-1 border-r border-border/70 py-3",
              historyRailPinned && "lg:hidden"
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-expanded={chatHistoryExpanded}
                    aria-label={`Open ${secondaryHistoryLabel.toLocaleLowerCase()}`}
                    className="size-9 rounded-xl bg-accent text-accent-foreground"
                    onClick={() => setChatHistoryExpanded(true)}
                    size="icon"
                    variant="ghost"
                  >
                    <SecondaryHistoryIcon />
                  </Button>
                }
              />
              <TooltipContent side="right">
                {secondaryHistoryLabel}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Search ${secondaryHistoryLabel.toLocaleLowerCase()}`}
                    className="size-9 rounded-xl text-muted-foreground"
                    onClick={() => setChatHistoryExpanded(true)}
                    size="icon"
                    variant="ghost"
                  >
                    <Search />
                  </Button>
                }
              />
              <TooltipContent side="right">
                Search {secondaryHistoryLabel.toLocaleLowerCase()}
              </TooltipContent>
            </Tooltip>
            {createAction && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={createAction.label}
                      className="size-9 rounded-xl text-muted-foreground"
                      disabled={createAction.disabled}
                      onClick={createAction.onClick}
                      size="icon"
                      variant="ghost"
                    >
                      <CreateIcon />
                    </Button>
                  }
                />
                <TooltipContent side="right">
                  {createAction.label}
                </TooltipContent>
              </Tooltip>
            )}
            {recentHistoryItems.length > 0 && (
              <Separator className="my-1 w-5" />
            )}
            <div className="flex flex-col items-center gap-2">
              {recentHistoryItems.map((item) => {
                const label = item.title.trim().slice(0, 1).toUpperCase() || "C"
                const active =
                  activeView === "chat"
                    ? activeConversationId === item.id
                    : activeSessionId === item.id
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-current={active ? "page" : undefined}
                          aria-label={`Open ${item.title}`}
                          className={cn(
                            "size-8 rounded-full text-[11px] font-semibold text-muted-foreground",
                            active && "bg-accent text-accent-foreground"
                          )}
                          onClick={() => {
                            setChatHistoryExpanded(false)
                            onNavigate(
                              activeView === "video-transcription"
                                ? "video-transcription"
                                : activeView === "transcription"
                                  ? "transcription"
                                  : "chat",
                              activeView === "chat" ? item.id : null,
                              activeView === "chat" ? null : item.id
                            )
                          }}
                          size="icon"
                          variant="ghost"
                        >
                          {label}
                        </Button>
                      }
                    />
                    <TooltipContent side="right">
                      <span className="max-w-52 truncate">{item.title}</span>
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </div>
        )}
        <div
          aria-label={contextTitle}
          className={cn(
            "min-w-0 flex-col gap-3 overflow-hidden border-r border-border bg-background p-4 shadow-xl motion-safe:animate-in motion-safe:duration-200 motion-safe:fade-in-0 motion-safe:slide-in-from-left-2",
            isSecondaryHistoryRail
              ? "absolute inset-y-0 left-0 z-30 w-64"
              : "absolute inset-y-0 left-14 z-30 w-64 xl:static xl:z-auto xl:shadow-none",
            historyRailPinned && "lg:static lg:z-auto lg:shadow-none",
            contextPanelOpen ? "flex" : "hidden",
            "max-md:fixed max-md:left-0 max-md:z-50 max-md:w-full"
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight">
                {contextTitle}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={
                        historyRailPinned
                          ? `Unpin ${secondaryHistoryLabel.toLocaleLowerCase()}`
                          : `Keep ${secondaryHistoryLabel.toLocaleLowerCase()} open`
                      }
                      aria-pressed={historyRailPinned}
                      className="size-7 rounded-lg text-muted-foreground"
                      onClick={() => {
                        setHistoryRailPinned((pinned) => !pinned)
                        setChatHistoryExpanded(true)
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      {historyRailPinned ? <PinOff /> : <Pin />}
                    </Button>
                  }
                />
                <TooltipContent>
                  {historyRailPinned
                    ? `Unpin ${secondaryHistoryLabel.toLocaleLowerCase()}`
                    : `Keep ${secondaryHistoryLabel.toLocaleLowerCase()} open`}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {createAction && (
            <Button
              aria-label={createAction.label}
              className="h-9 w-full justify-start gap-2"
              disabled={createAction.disabled}
              onClick={createAction.onClick}
            >
              <CreateIcon data-icon="inline-start" />
              {createAction.label}
            </Button>
          )}

          {actionError && (
            <Alert className="shrink-0" variant="destructive">
              <AlertDescription className="text-xs">
                {actionError}
              </AlertDescription>
            </Alert>
          )}

          {activeView === "chat" && (
            <AssistantThreadList
              activeConversationId={activeConversationId}
              archivedConversations={archivedConversations}
              conversations={conversations}
              organizationId={activeOrganization?.id ?? null}
              historyQuery={historyQuery}
              onArchive={onArchiveConversation}
              onDelete={onDeleteConversation}
              onHistoryQueryChange={setHistoryQuery}
              onRename={onRenameConversation}
              onShare={onShareConversation}
              onConversationRefresh={onConversationRefresh}
              onSelect={(id) => onNavigate("chat", id)}
            />
          )}

          {(activeView === "transcription" ||
            activeView === "video-transcription") && (
            <>
              <Input
                aria-label="Search sessions"
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder={
                  activeView === "video-transcription"
                    ? "Search videos"
                    : "Search sessions"
                }
                value={sessionQuery}
              />
              <TranscriptionHistoryPanel
                activeSessionId={activeSessionId}
                archivedSessionGroups={archivedSessionGroups}
                archivedSessions={filteredArchivedSessions}
                archivedOpen={archivedSessionsOpen}
                onArchive={onArchiveSession}
                onDelete={onDeleteSession}
                onSelect={(id) =>
                  onNavigate(
                    activeView === "video-transcription"
                      ? "video-transcription"
                      : "transcription",
                    null,
                    id
                  )
                }
                sessionGroups={sessionGroups}
                setArchivedOpen={setArchivedSessionsOpen}
                video={activeView === "video-transcription"}
              />
            </>
          )}
        </div>
      </div>
    </aside>
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
            hasProcessingWarning
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
            <span className="min-w-0 truncate">{statusDescription}</span>
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
              className="absolute top-1/2 right-1 size-7 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
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
