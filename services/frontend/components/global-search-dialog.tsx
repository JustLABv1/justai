"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  BookOpenText,
  Cpu,
  FileVideo,
  FolderKanban,
  Headphones,
  MessageSquare,
  NotebookPen,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type {
  AdminTab,
  SettingsTab,
  UniversalSearchResult,
  ViewId,
} from "@/lib/types"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"

type GlobalSearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNavigate: (
    view: ViewId,
    conversationId?: string | null,
    sessionId?: string | null,
    settingsTab?: SettingsTab,
    adminTab?: AdminTab
  ) => void
  disabledFeatures: Record<string, string>
  platformAdmin: boolean
}

const resultGroups = [
  { kind: "conversation", label: "Conversations", icon: MessageSquare },
  { kind: "note", label: "Notes", icon: NotebookPen },
  { kind: "knowledge", label: "Knowledge", icon: BookOpenText },
  { kind: "transcript", label: "Transcripts", icon: Headphones },
  { kind: "project", label: "Projects", icon: FolderKanban },
] as const

type NavigationItem = {
  id: string
  label: string
  hint: string
  keywords: string[]
  icon: LucideIcon
  view: ViewId
  settingsTab?: SettingsTab
  adminTab?: AdminTab
  feature?: string
  adminOnly?: boolean
}

const navigationItems: NavigationItem[] = [
  {
    id: "chat",
    label: "Chat",
    hint: "Conversations",
    keywords: ["chat", "conversation", "messages"],
    icon: MessageSquare,
    view: "chat",
  },
  {
    id: "agents",
    label: "Agents",
    hint: "Native and connected agents",
    keywords: ["assistant", "agent", "role", "a2a", "workflow", "run"],
    icon: Bot,
    view: "agents",
  },
  {
    id: "live-transcription",
    label: "Live transcription",
    hint: "Rooms and transcripts",
    keywords: ["live", "transcription", "meeting", "room", "audio"],
    icon: Headphones,
    view: "transcription",
    feature: "transcription",
  },
  {
    id: "video-transcription",
    label: "Video transcription",
    hint: "Upload and transcribe videos",
    keywords: ["video", "transcription", "upload", "subtitle"],
    icon: FileVideo,
    view: "video-transcription",
    feature: "transcription",
  },
  {
    id: "workspace-settings",
    label: "Workspace settings",
    hint: "Workspaces and defaults",
    keywords: ["settings", "workspace", "organization", "defaults"],
    icon: Settings2,
    view: "settings",
    settingsTab: "workspace",
  },
  {
    id: "endpoints",
    label: "Endpoints",
    hint: "Models and providers",
    keywords: ["endpoint", "model", "provider", "openai", "anthropic"],
    icon: Cpu,
    view: "settings",
    settingsTab: "endpoints",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    hint: "Sources and indexing",
    keywords: ["knowledge", "sources", "documents", "files", "rag"],
    icon: BookOpenText,
    view: "knowledge",
    feature: "knowledge",
  },
  {
    id: "mcp",
    label: "MCP servers",
    hint: "Connected tools",
    keywords: ["mcp", "tools", "servers", "integrations"],
    icon: Plug,
    view: "settings",
    settingsTab: "mcp",
    feature: "mcp",
  },
  {
    id: "members",
    label: "Members",
    hint: "Workspace access",
    keywords: ["members", "people", "team", "invite", "access"],
    icon: Users,
    view: "settings",
    settingsTab: "members",
  },
  {
    id: "privacy",
    label: "Privacy & lifecycle",
    hint: "Retention and data controls",
    keywords: ["privacy", "lifecycle", "retention", "export", "delete"],
    icon: ShieldCheck,
    view: "settings",
    settingsTab: "privacy",
  },
  {
    id: "profile",
    label: "Profile",
    hint: "Your account",
    keywords: ["profile", "account", "user"],
    icon: UserRound,
    view: "profile",
  },
  {
    id: "admin",
    label: "Admin console",
    hint: "Platform operations",
    keywords: ["admin", "platform", "operations", "controls"],
    icon: ShieldCheck,
    view: "admin",
    adminOnly: true,
  },
]

export function GlobalSearchDialog({
  open,
  onOpenChange,
  onNavigate,
  disabledFeatures,
  platformAdmin,
}: GlobalSearchDialogProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<UniversalSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retryToken, setRetryToken] = useState(0)

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery("")
        setResults([])
        setError("")
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  useEffect(() => {
    if (!open) {
      return
    }
    const trimmed = query.trim()
    if (!trimmed) {
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError("")
      void api
        .get<{ results: UniversalSearchResult[] }>(
          `/api/v1/search?q=${encodeURIComponent(trimmed)}&limit=40`,
          { signal: controller.signal }
        )
        .then((response) => {
          if (!controller.signal.aborted) setResults(response.results)
        })
        .catch((caught) => {
          if (controller.signal.aborted) return
          setResults([])
          setError(
            caught instanceof Error
              ? caught.message
              : "Workspace search is unavailable."
          )
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 160)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, query, retryToken])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [open, setOpen])

  const groupedResults = useMemo(
    () =>
      resultGroups.map((group) => ({
        ...group,
        results: (query.trim() ? results : []).filter(
          (result) => result.kind === group.kind
        ),
      })),
    [query, results]
  )

  const visibleNavigationItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return navigationItems.filter((item) => {
      if (item.adminOnly && !platformAdmin) return false
      if (item.feature && disabledFeatures[item.feature]) return false
      if (!normalizedQuery) return true
      return [item.label, item.hint, ...item.keywords].some((value) =>
        value.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [disabledFeatures, platformAdmin, query])

  function selectNavigation(item: NavigationItem) {
    setOpen(false)
    onNavigate(item.view, null, null, item.settingsTab, item.adminTab)
  }

  function selectResult(result: UniversalSearchResult) {
    setOpen(false)
    if (result.kind === "conversation") {
      onNavigate("chat", result.conversationId ?? result.id)
    } else if (result.kind === "transcript") {
      onNavigate("transcription", null, result.sessionId ?? result.id)
    } else if (result.kind === "note" || result.kind === "knowledge") {
      onNavigate("knowledge", result.id)
    } else if (result.kind === "project") {
      onNavigate("chat")
    }
  }

  return (
    <CommandDialog
      description="Search conversations, notes, knowledge, transcripts, and projects."
      onOpenChange={setOpen}
      open={open}
      title="Universal search"
    >
      <CommandInput
        autoFocus
        onValueChange={setQuery}
        placeholder="Search everything in this workspace…"
        value={query}
      />
      <CommandList>
        {visibleNavigationItems.length > 0 && (
          <CommandGroup heading="Go to">
            {visibleNavigationItems.map((item) => {
              const Icon = item.icon
              return (
                <CommandItem
                  key={item.id}
                  onSelect={() => selectNavigation(item)}
                  value={`${item.label} ${item.hint} ${item.keywords.join(" ")}`}
                >
                  <Icon />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.label}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {item.hint}
                    </span>
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
        {!query.trim() && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted-foreground">
            <Search className="size-5" />
            <p>
              Search across chats, notes, knowledge, transcripts, and projects.
            </p>
            <p className="flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
              <span>Open anytime with</span>
              <kbd className="rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                ⌘
              </kbd>
              <kbd className="rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                K
              </kbd>
              <span className="text-muted-foreground/70">or</span>
              <kbd className="rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                Ctrl
              </kbd>
              <kbd className="rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                K
              </kbd>
            </p>
          </div>
        )}
        {query.trim() && loading && (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            Searching workspace…
          </p>
        )}
        {query.trim() && !loading && !error && (
          <CommandEmpty>No matching workspace content.</CommandEmpty>
        )}
        {query.trim() && !loading && error && (
          <div
            aria-live="assertive"
            className="mx-3 my-2 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <span className="min-w-0">{error}</span>
            <Button
              className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setRetryToken((value) => value + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        )}
        {groupedResults.map((group) => {
          if (group.results.length === 0) return null
          const Icon = group.icon
          return (
            <CommandGroup heading={group.label} key={group.kind}>
              {group.results.map((result) => (
                <CommandItem
                  key={`${result.kind}-${result.id}`}
                  onSelect={() => selectResult(result)}
                  value={`${result.kind} ${result.title} ${result.snippet}`}
                >
                  <Icon />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {result.title}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {result.snippet || "No preview available"}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
