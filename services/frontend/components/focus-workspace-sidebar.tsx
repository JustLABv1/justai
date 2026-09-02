"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
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
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
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
import { Separator } from "@/components/ui/separator"
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
  { id: "chat", label: "Chat", hint: "Conversations", icon: MessageSquare, group: "Create" },
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

const sidebarRailStorageKey = "justai.sidebar-rail-expanded"

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
  const [searchOpen, setSearchOpen] = useState(false)
  const [archivedSessionsOpen, setArchivedSessionsOpen] = useState(false)
  const [railExpanded, setRailExpanded] = useState(false)
  const [railPreferenceLoaded, setRailPreferenceLoaded] = useState(false)
  const historyView =
    activeView === "chat" ||
    activeView === "transcription" ||
    activeView === "video-transcription"
  const navigation = railNavigation
  const historyVisible = historyView && historyOpen

  const createAction: CreateAction | null =
    activeView === "chat"
      ? {
          label: "New chat",
          hint: "Start a new conversation",
          icon: Plus,
          onClick: () => onNavigate("chat"),
        }
      : activeView === "transcription"
        ? {
            label: "New room",
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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(sidebarRailStorageKey)
      if (stored !== null) setRailExpanded(stored === "true")
      setRailPreferenceLoaded(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!railPreferenceLoaded) return
    window.localStorage.setItem(sidebarRailStorageKey, String(railExpanded))
  }, [railExpanded, railPreferenceLoaded])
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
  const sessionGroups = useMemo(
    () => groupByRecency(visibleSessions),
    [visibleSessions]
  )
  const archivedSessionGroups = useMemo(
    () => groupByRecency(visibleArchivedSessions),
    [visibleArchivedSessions]
  )

  function navigateFromRail(view: ViewId) {
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

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 shrink-0 overflow-hidden border-r border-border bg-background transition-[width] duration-200 ease-out",
        historyVisible
          ? railExpanded
            ? "w-[32rem] max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-full max-md:shadow-lg"
            : "w-[352px] max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-full max-md:shadow-lg"
          : railExpanded
            ? "w-56"
            : "w-16"
      )}
      data-history-open={historyVisible}
      data-rail-expanded={railExpanded}
    >
      <div
        className={cn(
          "flex shrink-0 flex-col gap-3 border-r border-border/70 py-4 transition-[width] duration-200",
          railExpanded ? "w-56 items-stretch px-3" : "w-16 items-center px-2"
        )}
      >
        <div
          className={cn(
            "flex w-full items-center",
            railExpanded ? "justify-between" : "justify-center"
          )}
        >
          <BrandMark className="size-8 shrink-0" />
          {railExpanded && (
            <Button
              aria-expanded={railExpanded}
              aria-label="Collapse navigation"
              className="size-8 rounded-xl text-muted-foreground"
              onClick={() => setRailExpanded(false)}
              size="icon"
              title="Collapse navigation"
              variant="ghost"
            >
              <PanelLeftClose data-icon="inline-start" />
            </Button>
          )}
        </div>
        {!railExpanded && (
          <Button
            aria-expanded={railExpanded}
            aria-label="Expand navigation"
            className="size-9 rounded-xl text-muted-foreground"
            onClick={() => setRailExpanded(true)}
            size="icon"
            title="Expand navigation"
            variant="ghost"
          >
            <PanelLeftOpen data-icon="inline-start" />
          </Button>
        )}
        {railExpanded && (
          <p className="px-3 text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
            Workspace
          </p>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Select workspace (${activeOrganization?.name ?? "Workspace"})`}
                className={cn(
                  "shrink-0",
                  railExpanded
                    ? "h-auto w-full justify-start gap-2 border px-2.5 py-2"
                    : "size-9 rounded-xl"
                )}
                title={activeOrganization?.name ?? "Select workspace"}
                variant={railExpanded ? "outline" : "ghost"}
              />
            }
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground",
                railExpanded ? "size-7" : "size-8"
              )}
            >
              <Bot aria-hidden="true" />
            </span>
            {railExpanded && (
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-xs font-medium">
                  {activeOrganization?.name ?? "Workspace"}
                </span>
              </span>
            )}
            {railExpanded && (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64"
            side={railExpanded ? "bottom" : "right"}
          >
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
        <Button
          aria-label="Search workspace"
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            "rounded-xl border border-border/70 bg-muted/20 text-muted-foreground hover:border-border hover:bg-muted/45",
            railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9"
          )}
          onClick={() => setSearchOpen(true)}
          size="icon"
          title="Search workspace (⌘K / Ctrl K)"
          variant="ghost"
        >
          <Search data-icon="inline-start" />
          {railExpanded && <span>Search workspace</span>}
          {railExpanded && (
            <kbd
              aria-hidden="true"
              className="ml-auto hidden rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex"
            >
              ⌘K
            </kbd>
          )}
        </Button>

        {createAction && (
          <Button
            aria-label={createAction.label}
            className={cn(
              "rounded-xl",
              railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9"
            )}
            disabled={createAction.disabled}
            onClick={createAction.onClick}
            size="icon"
            title={
              createAction.disabled
                ? "Disabled by platform administrator"
                : createAction.hint
            }
          >
            <CreateIcon data-icon="inline-start" />
            {railExpanded && <span>{createAction.label}</span>}
          </Button>
        )}

        <Separator className="my-1" />
        <nav
          aria-label="Workspace navigation"
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1",
            "flex flex-col gap-1",
            railExpanded ? "w-full items-stretch" : "items-center"
          )}
        >
          {navigation.map((item, index) => {
            const Icon = item.icon
            const active = activeView === item.id
            const disabled = Boolean(
              item.feature && disabledFeatures[item.feature]
            )
            const beginsGroup = index === 0 || navigation[index - 1]?.group !== item.group
            return (
              <Fragment key={item.id}>
                {beginsGroup &&
                  (railExpanded ? (
                    <p
                      className={cn(
                        "px-3 text-[10px] font-medium tracking-[0.14em] text-muted-foreground/80 uppercase",
                        index > 0 && "mt-3"
                      )}
                    >
                      {item.group}
                    </p>
                  ) : (
                    index > 0 && <Separator className="my-1 w-5" />
                  ))}
              <Button
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                className={cn(
                  "relative rounded-xl text-muted-foreground",
                  railExpanded
                    ? "h-9 w-full justify-start gap-3 px-3"
                    : "size-9",
                  active && "bg-accent text-accent-foreground"
                )}
                disabled={disabled}
                onClick={() => navigateFromRail(item.id)}
                size="icon"
                title={
                  disabled ? "Disabled by platform administrator" : item.hint
                }
                variant="ghost"
              >
                <Icon data-icon="inline-start" />
                {railExpanded && <span className="truncate">{item.label}</span>}
              </Button>
              </Fragment>
            )
          })}
          {railExpanded && <Separator className="my-2" />}
          <Button
            aria-current={activeView === "settings" ? "page" : undefined}
            aria-label="Settings"
            className={cn(
              "rounded-xl text-muted-foreground",
              railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9",
              activeView === "settings" && "bg-accent text-accent-foreground"
            )}
            onClick={() => onNavigate("settings")}
            size="icon"
            title="Settings"
            variant="ghost"
          >
            <Settings2 data-icon="inline-start" />
            {railExpanded && <span>Settings</span>}
          </Button>
        </nav>

        {user.platformAdmin && (
          <Button
            aria-current={activeView === "admin" ? "page" : undefined}
            aria-label="Platform admin"
            className={cn(
              "rounded-xl text-muted-foreground",
              railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9",
              activeView === "admin" && "bg-accent text-accent-foreground"
            )}
            onClick={() => onNavigate("admin")}
            size="icon"
            title="Global controls"
            variant="ghost"
          >
            <ShieldCheck data-icon="inline-start" />
            {railExpanded && <span>Platform admin</span>}
          </Button>
        )}
        {!historyVisible && historyView && (
          <Button
            aria-label="Show chat history"
            className={cn(
              "rounded-xl text-muted-foreground",
              railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9"
            )}
            onClick={() => onHistoryOpenChange(true)}
            size="icon"
            title="Show chat history"
            variant="ghost"
          >
            <PanelRightOpen data-icon="inline-start" />
            {railExpanded && <span>Chat history</span>}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`${user.displayName} account menu`}
                className={cn(
                  "rounded-full p-0",
                  railExpanded
                    ? "h-9 w-full justify-start gap-2 rounded-xl px-1.5"
                    : "size-8"
                )}
                title={`${user.displayName} · ${user.email}`}
                variant="ghost"
              />
            }
          >
            <Avatar size="sm">
              <AvatarFallback>{userInitials}</AvatarFallback>
            </Avatar>
            {railExpanded && (
              <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                {user.displayName}
              </span>
            )}
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
          "min-w-0 flex-col gap-3 overflow-hidden p-4",
          railExpanded ? "w-72 max-md:w-[calc(100vw-14rem)]" : "w-72",
          historyVisible ? "flex" : "hidden"
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">
              {activeView === "transcription"
                ? "Live sessions"
                : activeView === "video-transcription"
                  ? "Video transcripts"
                  : activeView === "chat"
                    ? "Chat history"
                    : "Workspace"}
            </h2>
          </div>
          <Button
            aria-label="Hide chat history"
            className="size-8 rounded-xl text-muted-foreground"
            onClick={() => onHistoryOpenChange(false)}
            size="icon"
            title="Hide chat history"
            variant="ghost"
          >
            <PanelRightClose data-icon="inline-start" />
          </Button>
        </div>

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
          <TranscriptionHistoryPanel
            activeSessionId={activeSessionId}
            archivedSessionGroups={archivedSessionGroups}
            archivedSessions={visibleArchivedSessions}
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
        )}
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
      <p className="text-xs font-semibold">
        {video ? "Recent videos" : "Recent sessions"}
      </p>
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
