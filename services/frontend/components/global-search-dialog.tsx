"use client"

import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"
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
  Settings2,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Command } from "@/components/panelui/command"
import type {
  AdminTab,
  SettingsTab,
  UniversalSearchResult,
  ViewId,
} from "@/lib/types"
import { api } from "@/lib/api"

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

const resultGroupsMessages = [
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

const navigationItemsMessages: NavigationItem[] = [
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
    id: "templates",
    label: "Templates",
    hint: "Reusable document templates",
    keywords: ["templates", "vorlagen", "expense", "documents"],
    icon: BookOpenText,
    view: "templates",
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
    hint: "Manage MCP connections and tools",
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
  const resultGroups = useTranslatedConfig(resultGroupsMessages)
  const navigationItems = useTranslatedConfig(navigationItemsMessages)

  const { t } = useTranslations()

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

  const groupedResults = useMemo(
    () =>
      resultGroups.map((group) => ({
        ...group,
        results: (query.trim() ? results : []).filter(
          (result) => result.kind === group.kind
        ),
      })),
    [query, results, resultGroups]
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
  }, [disabledFeatures, platformAdmin, query, navigationItems])

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

  const hasQuery = query.trim() !== ""
  const hasResults = groupedResults.some((group) => group.results.length > 0)

  return (
    <Command.Dialog
      hotkey="mod+k"
      label={t("Universal search")}
      onOpenChange={setOpen}
      open={open}
    >
      <Command
        filter={false}
        label={t("Universal search")}
        onSearchChange={setQuery}
        search={query}
      >
        <Command.Input
          placeholder={t("Search everything in this workspace…")}
        />
        <Command.List>
          {visibleNavigationItems.length > 0 && (
            <Command.Group heading={t("Go to")}>
              {visibleNavigationItems.map((item) => {
                const Icon = item.icon
                return (
                  <Command.Item
                    icon={<Icon />}
                    key={item.id}
                    onSelect={() => selectNavigation(item)}
                    subtitle={item.hint}
                    value={`nav:${item.id}`}
                  >
                    {item.label}
                  </Command.Item>
                )
              })}
            </Command.Group>
          )}
          {hasQuery && loading && (
            <Command.Loading>{t("Searching workspace…")}</Command.Loading>
          )}
          {hasQuery &&
            !loading &&
            !error &&
            !hasResults &&
            visibleNavigationItems.length === 0 && (
              <Command.Empty>
                {t("No matching workspace content.")}
              </Command.Empty>
            )}
          {hasQuery && !loading && error && (
            <div
              aria-live="assertive"
              className="mx-3 my-2 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <span className="min-w-0">{t(error)}</span>
              <button
                className="shrink-0 rounded-md border border-destructive/30 px-2 py-1 hover:bg-destructive/10"
                onClick={() => setRetryToken((value) => value + 1)}
                type="button"
              >
                {t("Retry")}
              </button>
            </div>
          )}
          {groupedResults.map((group) => {
            if (group.results.length === 0) return null
            const Icon = group.icon
            return (
              <Command.Group heading={group.label} key={group.kind}>
                {group.results.map((result) => (
                  <Command.Item
                    icon={<Icon />}
                    key={`${result.kind}-${result.id}`}
                    kind={group.label}
                    onSelect={() => selectResult(result)}
                    subtitle={result.snippet || t("No preview available")}
                    value={`${result.kind}-${result.id}`}
                  >
                    {result.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )
          })}
        </Command.List>
        <Command.Footer>
          <Command.FooterAction keys={["↵"]}>{t("Open")}</Command.FooterAction>
        </Command.Footer>
      </Command>
    </Command.Dialog>
  )
}
