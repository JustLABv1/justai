"use client"

import { useState } from "react"
import {
  CircleHelp,
  Headphones,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  Settings2,
} from "lucide-react"

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
  transcriptionSessions,
  usePrototypeChat,
} from "./prototype-data"
import styles from "./prototype.module.css"

const viewLabels: Record<PrototypeView, string> = {
  chat: "Chat",
  transcription: "Live transcription",
  endpoints: "Endpoints",
  knowledge: "Knowledge",
  mcp: "MCP",
  settings: "Settings",
}

export function QuietVariant() {
  const [activeView, setActiveView] = useState<PrototypeView>("chat")
  const [activeConversation, setActiveConversation] = useState("plain-docs")
  const [query, setQuery] = useState("")
  const [historyOpen, setHistoryOpen] = useState(true)
  const chat = usePrototypeChat(prototypeMessages)
  const selectedConversation = conversations.find(
    (item) => item.id === activeConversation
  )

  function changeView(view: PrototypeView) {
    setActiveView(view)
    if (view !== "chat") setHistoryOpen(true)
  }

  function startNewChat() {
    setActiveView("chat")
    setActiveConversation("plain-docs")
    setQuery("")
    chat.setDraft("")
  }

  return (
    <main className={cn(styles.variant, styles.enter, styles.quietShell)}>
      <aside className={styles.quietRail} aria-label="Workspace navigation">
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
          aria-label="Docs and guides"
          onClick={() => changeView("settings")}
          size="icon"
          title="Docs & guides"
          variant="ghost"
        >
          <CircleHelp data-icon="inline-start" />
        </Button>
        <Avatar size="sm">
          <AvatarFallback>JN</AvatarFallback>
        </Avatar>
      </aside>

      {historyOpen && (
        <aside
          className={styles.quietHistory}
          aria-label="History and workspace context"
        >
          <div className={styles.quietHistoryHeader}>
            <PrototypeBrand />
            <Button
              aria-label="Collapse history"
              onClick={() => setHistoryOpen(false)}
              size="icon-sm"
              title="Collapse history"
              variant="ghost"
            >
              <PanelLeftClose data-icon="inline-start" />
            </Button>
          </div>

          <div className={styles.quietOrg}>
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
              <Settings2 />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                Justin&apos;s workspace
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                Owner access
              </p>
            </div>
            <Badge variant="outline">Live</Badge>
          </div>

          <Button
            className="w-full justify-start"
            onClick={startNewChat}
            variant="default"
          >
            <Plus data-icon="inline-start" />
            New chat
          </Button>

          {activeView === "chat" ? (
            <ConversationList
              activeConversation={activeConversation}
              onSelect={setActiveConversation}
              query={query}
              setQuery={setQuery}
            />
          ) : (
            <div className={styles.conversationList}>
              <div className={styles.sectionHeading}>
                <div>
                  <p className="text-xs font-semibold">
                    {viewLabels[activeView]}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {activeView === "transcription"
                      ? "Rooms and transcripts"
                      : "Workspace surface"}
                  </p>
                </div>
                <Headphones className="size-4 text-muted-foreground" />
              </div>
              {activeView === "transcription" ? (
                <div className={styles.conversationGroups}>
                  {transcriptionSessions.map((session) => (
                    <Button
                      className={styles.conversationButton}
                      key={session.id}
                      onClick={() => setActiveConversation(session.id)}
                      variant="ghost"
                    >
                      <span
                        className={cn(
                          styles.conversationDot,
                          session.status === "live" && "bg-primary"
                        )}
                      />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-xs font-medium">
                          {session.title}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {session.meta}
                        </span>
                      </span>
                      <Radio className="size-4 shrink-0 text-muted-foreground" />
                    </Button>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyList}>
                  <Radio />
                  <p>Select a section to inspect its current setup.</p>
                </div>
              )}
              <Button
                className="mt-auto w-full justify-start"
                onClick={() => changeView("chat")}
                size="sm"
                variant="ghost"
              >
                <PanelLeftOpen data-icon="inline-start" />
                Return to chat
              </Button>
            </div>
          )}
        </aside>
      )}

      <section className={styles.quietMain}>
        <header className={styles.quietHeader}>
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label={historyOpen ? "Collapse history" : "Open history"}
              onClick={() => setHistoryOpen(!historyOpen)}
              size="icon-sm"
              title={historyOpen ? "Collapse history" : "Open history"}
              variant="outline"
            >
              {historyOpen ? (
                <PanelLeftClose data-icon="inline-start" />
              ) : (
                <PanelLeftOpen data-icon="inline-start" />
              )}
            </Button>
            <div className={styles.headerTitle}>
              <p className="truncate text-[11px] text-muted-foreground">
                JustLAB workspace / {viewLabels[activeView]}
              </p>
              <h1 className="truncate text-sm font-semibold">
                {activeView === "chat"
                  ? (selectedConversation?.title ?? "New conversation")
                  : viewLabels[activeView]}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="hidden sm:inline-flex" variant="outline">
              OpenAI-compatible · gpt-4o-mini
            </Badge>
            <Button
              aria-label="More chat actions"
              size="icon-sm"
              variant="ghost"
            >
              <MoreHorizontal data-icon="inline-start" />
            </Button>
          </div>
        </header>

        {activeView === "chat" ? (
          <section className={styles.chatStage} aria-label="Chat conversation">
            <PrototypeMessages messages={chat.messages} />
            <div className={styles.composerDock}>
              <PrototypeComposer {...chat} />
              <p className="mx-auto mt-2 max-w-[780px] text-center text-[11px] text-muted-foreground">
                Connected · responses use your selected endpoint and workspace
                context
              </p>
            </div>
          </section>
        ) : (
          <PrototypeFeatureView
            view={activeView}
            onBackToChat={() => changeView("chat")}
          />
        )}
      </section>
    </main>
  )
}
