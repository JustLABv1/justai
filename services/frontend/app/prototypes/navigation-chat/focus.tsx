"use client"

import { useState } from "react"
import {
  BookOpenText,
  CheckCircle2,
  Database,
  Headphones,
  History,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Plus,
  Radio,
  Settings2,
  Wrench,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import {
  ConversationList,
  PrototypeBrand,
  PrototypeComposer,
  PrototypeFeatureView,
  PrototypeMessages,
  PrototypeView,
  ViewNav,
  conversations,
  prototypeMessages,
  usePrototypeChat,
} from "./prototype-data"
import styles from "./prototype.module.css"

type ContextTab = "sources" | "mcp" | "live"

const viewLabels: Record<PrototypeView, string> = {
  chat: "Chat",
  transcription: "Live transcription",
  endpoints: "Endpoints",
  knowledge: "Knowledge",
  mcp: "MCP",
  settings: "Settings",
}

export function FocusVariant() {
  const [activeView, setActiveView] = useState<PrototypeView>("chat")
  const [activeConversation, setActiveConversation] = useState("plain-docs")
  const [query, setQuery] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(true)
  const [contextTab, setContextTab] = useState<ContextTab>("sources")
  const chat = usePrototypeChat(prototypeMessages)
  const selectedConversation = conversations.find(
    (item) => item.id === activeConversation
  )

  function changeView(view: PrototypeView) {
    setActiveView(view)
    if (view === "transcription") setContextTab("live")
  }

  function startNewChat() {
    setActiveView("chat")
    setActiveConversation("plain-docs")
    setQuery("")
    chat.setDraft("")
  }

  return (
    <main
      className={cn(
        styles.variant,
        styles.enter,
        styles.focusShell,
        historyOpen && styles.focusShellWithHistory
      )}
    >
      <aside
        className={styles.focusSessionRail}
        aria-label="Session navigation"
      >
        <PrototypeBrand compact />
        <Button
          aria-label="New chat"
          className="size-9 rounded-xl"
          onClick={startNewChat}
          size="icon"
          title="New chat"
        >
          <Plus data-icon="inline-start" />
        </Button>
        <ViewNav activeView={activeView} compact onChange={changeView} />
        <div className={styles.railSpacer} />
        <Button
          aria-label="Settings"
          onClick={() => changeView("settings")}
          size="icon"
          title="Settings"
          variant="ghost"
        >
          <Settings2 data-icon="inline-start" />
        </Button>
        <Avatar size="sm">
          <AvatarFallback>JN</AvatarFallback>
        </Avatar>
      </aside>

      {historyOpen && (
        <aside
          className={styles.focusHistory}
          aria-label="Conversation sessions"
        >
          <div className={styles.quietHistoryHeader}>
            <div>
              <p className="text-[11px] text-muted-foreground">Workspace</p>
              <h2 className="text-sm font-semibold">Sessions</h2>
            </div>
            <Button
              aria-label="Close sessions"
              onClick={() => setHistoryOpen(false)}
              size="icon-sm"
              variant="ghost"
            >
              <PanelLeftClose data-icon="inline-start" />
            </Button>
          </div>
          <Button className="w-full justify-start" onClick={startNewChat}>
            <Plus data-icon="inline-start" />
            New chat
          </Button>
          <ConversationList
            activeConversation={activeConversation}
            onSelect={setActiveConversation}
            query={query}
            setQuery={setQuery}
          />
        </aside>
      )}

      <section className={styles.focusMain}>
        <header className={styles.focusHeader}>
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label={historyOpen ? "Close sessions" : "Open sessions"}
              onClick={() => setHistoryOpen(!historyOpen)}
              size="icon-sm"
              title={historyOpen ? "Close sessions" : "Open sessions"}
              variant="outline"
            >
              <History data-icon="inline-start" />
            </Button>
            <div className={styles.headerTitle}>
              <p className="truncate text-[11px] text-muted-foreground">
                Focused workspace / {viewLabels[activeView]}
              </p>
              <h1 className="truncate text-sm font-semibold">
                {activeView === "chat"
                  ? (selectedConversation?.title ?? "New conversation")
                  : viewLabels[activeView]}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="hidden md:inline-flex" variant="secondary">
              3 sources ready
            </Badge>
            <Button
              aria-expanded={contextOpen}
              aria-label={
                contextOpen
                  ? "Hide context inspector"
                  : "Show context inspector"
              }
              onClick={() => setContextOpen(!contextOpen)}
              title={
                contextOpen
                  ? "Hide context inspector"
                  : "Show context inspector"
              }
              variant={contextOpen ? "secondary" : "outline"}
            >
              {contextOpen ? (
                <PanelRightClose data-icon="inline-start" />
              ) : (
                <PanelRightOpen data-icon="inline-start" />
              )}
              <span className="hidden sm:inline">Context</span>
            </Button>
          </div>
        </header>

        {activeView === "chat" ? (
          <section
            className={styles.focusChat}
            aria-label="Focused chat conversation"
          >
            <div className={styles.focusIntro}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">Knowledge grounded</Badge>
                <Badge variant="secondary">MCP ready</Badge>
                <Badge variant="secondary">gpt-4o-mini</Badge>
              </div>
              <h2 className="mt-3 text-lg font-semibold tracking-tight">
                A focused place for the next answer.
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                The chat stays narrow and readable while sources, tool calls,
                and live room status remain visible in context.
              </p>
            </div>
            <PrototypeMessages density="compact" messages={chat.messages} />
            <div className={styles.composerDock}>
              <PrototypeComposer {...chat} compact />
              <p className="mx-auto mt-2 max-w-[720px] text-center text-[11px] text-muted-foreground">
                Connected · tool calls and source refreshes stay attached to
                each turn
              </p>
            </div>
          </section>
        ) : (
          <PrototypeFeatureView
            view={activeView}
            onBackToChat={() => setActiveView("chat")}
          />
        )}
      </section>

      {contextOpen && (
        <aside
          className={styles.focusContext}
          aria-label="Conversation context"
        >
          <div className={styles.quietHistoryHeader}>
            <div>
              <p className="text-[11px] text-muted-foreground">
                Attached to this turn
              </p>
              <h2 className="text-sm font-semibold">Context</h2>
            </div>
            <Button
              aria-label="Close context inspector"
              onClick={() => setContextOpen(false)}
              size="icon-sm"
              variant="ghost"
            >
              <PanelRightClose data-icon="inline-start" />
            </Button>
          </div>
          <div
            className={styles.contextTabs}
            role="tablist"
            aria-label="Context tabs"
          >
            {(
              [
                ["sources", "Sources"],
                ["mcp", "MCP"],
                ["live", "Live"],
              ] as const
            ).map(([id, label]) => (
              <button
                aria-selected={contextTab === id}
                className={cn(
                  styles.contextTab,
                  contextTab === id && styles.contextTabActive
                )}
                key={id}
                onClick={() => setContextTab(id)}
                role="tab"
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {contextTab === "sources" && (
            <div className={styles.contextStack}>
              <ContextItem
                icon={BookOpenText}
                label="Architecture brief.md"
                detail="Indexed · 82% match"
              />
              <ContextItem
                icon={BookOpenText}
                label="PLAIN CI guide"
                detail="Indexed · 71% match"
              />
              <ContextItem
                icon={Database}
                label="Workspace index"
                detail="12 sources · refreshed 4m ago"
              />
              <Button
                className="w-full"
                onClick={() => changeView("knowledge")}
                size="sm"
                variant="outline"
              >
                Manage knowledge
              </Button>
            </div>
          )}

          {contextTab === "mcp" && (
            <div className={styles.contextStack}>
              <ContextItem
                icon={Wrench}
                label="search_plain_docs"
                detail="Completed · 240 ms"
              />
              <ContextItem
                icon={Plug}
                label="Knowledge MCP"
                detail="Connected · 8 tools discovered"
              />
              <ContextItem
                icon={CheckCircle2}
                label="Follow-up calls"
                detail="Context refreshes on every turn"
              />
              <Button
                className="w-full"
                onClick={() => changeView("mcp")}
                size="sm"
                variant="outline"
              >
                Inspect MCP
              </Button>
            </div>
          )}

          {contextTab === "live" && (
            <div className={styles.contextStack}>
              <ContextItem
                icon={Radio}
                label="Product roadmap room"
                detail="Live · 00:12:04 · 4 speakers"
              />
              <ContextItem
                icon={Headphones}
                label="Transcript capture"
                detail="Listening is available without leaving chat"
              />
              <Button
                className="w-full"
                onClick={() => changeView("transcription")}
                size="sm"
                variant="outline"
              >
                Open live transcription
              </Button>
            </div>
          )}
        </aside>
      )}
    </main>
  )
}

function ContextItem({
  icon: Icon,
  label,
  detail,
}: {
  icon: LucideIcon
  label: string
  detail: string
}) {
  return (
    <div className={styles.contextItem}>
      <div className={styles.contextItemIcon}>
        <Icon />
      </div>
      <div className={styles.contextItemText}>
        <p className="truncate text-xs font-medium">{label}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  )
}
