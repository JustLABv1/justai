"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  Headphones,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { BrandMark } from "@/components/brand-mark"
import { AssistantThreadList } from "@/components/assistant-ui/thread-list"
import { ThemeSwitcher } from "@/components/theme-switcher"
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
  feature?: string
}> = [
  { id: "chat", label: "Chat", hint: "Conversations", icon: MessageSquare },
  {
    id: "transcription",
    label: "Live transcription",
    hint: "Rooms and transcripts",
    icon: Headphones,
    feature: "transcription",
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
  onArchiveSession: (sessionId: string, archived: boolean) => void
  onDeleteSession: (session: TranscriptionSession) => void
  onNewTranscriptionSession: () => void
  onSignOut: () => void
  disabledFeatures: Record<string, string>
}

type RecencyGroup<T> = {
  label: string
  items: T[]
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
  onArchiveSession,
  onDeleteSession,
  onNewTranscriptionSession,
  onSignOut,
  disabledFeatures,
}: FocusWorkspaceSidebarProps) {
  const [historyQuery, setHistoryQuery] = useState("")
  const [archivedSessionsOpen, setArchivedSessionsOpen] = useState(false)
  const [railExpanded, setRailExpanded] = useState(false)
  const [railPreferenceLoaded, setRailPreferenceLoaded] = useState(false)
  const historyView = activeView === "chat" || activeView === "transcription"
  const navigation = railNavigation
  const historyVisible = historyView && historyOpen

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
  const sessionGroups = useMemo(
    () => groupByRecency(transcriptionSessions),
    [transcriptionSessions]
  )
  const archivedSessionGroups = useMemo(
    () => groupByRecency(archivedTranscriptionSessions),
    [archivedTranscriptionSessions]
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
          : (transcriptionSessions[0]?.id ?? null)
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
        <Button
          aria-label="New chat"
          className={cn(
            "rounded-xl",
            railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9"
          )}
          onClick={() => onNavigate("chat")}
          title="New chat"
          size="icon"
        >
          <Plus data-icon="inline-start" />
          {railExpanded && <span>New chat</span>}
        </Button>

        <nav
          aria-label="Workspace navigation"
          className={cn(
            "flex flex-col gap-1",
            railExpanded ? "w-full items-stretch" : "items-center"
          )}
        >
          {navigation.map((item) => {
            const Icon = item.icon
            const active = activeView === item.id
            const disabled = Boolean(
              item.feature && disabledFeatures[item.feature]
            )
            return (
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
                key={item.id}
                onClick={() => navigateFromRail(item.id)}
                size="icon"
                title={
                  disabled ? "Disabled by platform administrator" : item.hint
                }
                variant="ghost"
              >
                <Icon data-icon="inline-start" />
                {item.id === "transcription" &&
                  transcriptionSessions.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground">
                      {transcriptionSessions.length > 9
                        ? "9+"
                        : transcriptionSessions.length}
                    </span>
                  )}
                {railExpanded && <span className="truncate">{item.label}</span>}
              </Button>
            )
          })}
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

        <div className="min-h-0 flex-1" />
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
            aria-label="Open chat history"
            className={cn(
              "rounded-xl text-muted-foreground",
              railExpanded ? "h-9 w-full justify-start gap-3 px-3" : "size-9"
            )}
            onClick={() => onHistoryOpenChange(true)}
            size="icon"
            title="Open chat history"
            variant="ghost"
          >
            <PanelLeftOpen data-icon="inline-start" />
            {railExpanded && <span>Chat history</span>}
          </Button>
        )}
        <ThemeSwitcher expanded={railExpanded} />
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
                : activeView === "chat"
                  ? "Chat history"
                  : "Workspace"}
            </h2>
          </div>
          <Button
            aria-label="Collapse chat history"
            className="size-8 rounded-xl text-muted-foreground"
            onClick={() => onHistoryOpenChange(false)}
            size="icon"
            title="Collapse chat history"
            variant="ghost"
          >
            <PanelLeftClose data-icon="inline-start" />
          </Button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                className="h-auto w-full justify-start gap-2 border px-2.5 py-2"
                variant="outline"
              />
            }
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
              <Bot aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-xs font-medium">
                {activeOrganization?.name ?? "Workspace"}
              </span>
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
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

        {actionError && (
          <Alert className="shrink-0" variant="destructive">
            <AlertDescription className="text-xs">
              {actionError}
            </AlertDescription>
          </Alert>
        )}

        {activeView === "transcription" ? (
          <Button
            className="w-full shrink-0 justify-start"
            disabled={Boolean(disabledFeatures.transcription)}
            onClick={onNewTranscriptionSession}
            title={
              disabledFeatures.transcription
                ? "Disabled by platform administrator"
                : "New room"
            }
          >
            <Plus data-icon="inline-start" />
            New room
          </Button>
        ) : (
          <>
            <Button
              className="w-full shrink-0 justify-start"
              onClick={() => onNavigate("chat")}
            >
              <Plus data-icon="inline-start" />
              New chat
            </Button>

            <AssistantThreadList
              activeConversationId={activeConversationId}
              archivedConversations={archivedConversations}
              conversations={conversations}
              historyQuery={historyQuery}
              onArchive={onArchiveConversation}
              onDelete={onDeleteConversation}
              onHistoryQueryChange={setHistoryQuery}
              onRename={onRenameConversation}
              onSelect={(id) => onNavigate("chat", id)}
            />
          </>
        )}

        {activeView === "transcription" && (
          <TranscriptionHistoryPanel
            activeSessionId={activeSessionId}
            archivedSessionGroups={archivedSessionGroups}
            archivedSessions={archivedTranscriptionSessions}
            archivedOpen={archivedSessionsOpen}
            onArchive={onArchiveSession}
            onDelete={onDeleteSession}
            onSelect={(id) => onNavigate("transcription", null, id)}
            sessionGroups={sessionGroups}
            setArchivedOpen={setArchivedSessionsOpen}
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
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <p className="text-xs font-semibold">Recent sessions</p>
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
              <EmptyTitle>No sessions yet</EmptyTitle>
              <EmptyDescription>
                Start listening to create one.
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
  return (
    <div className="group relative">
      <Button
        aria-current={active ? "page" : undefined}
        className={cn(
          "h-auto min-h-12 w-full justify-start gap-2 pr-9 text-left",
          active && "bg-accent text-accent-foreground"
        )}
        onClick={() => onSelect(session.id)}
        title={`${session.title} · ${session.status}`}
        variant="ghost"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            session.status === "live" || active ? "bg-primary" : "bg-border"
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {session.title}
          </span>
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {session.status} · {formatItemTime(session.updatedAt)}
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
