"use client"

import { useEffect, useState } from "react"
import {
  CircleHelp,
  Command,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  X,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  navItems,
  prototypeMessages,
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

export function CommandVariant() {
  const [activeView, setActiveView] = useState<PrototypeView>("chat")
  const [activeConversation, setActiveConversation] = useState("plain-docs")
  const [query, setQuery] = useState("")
  const [paletteQuery, setPaletteQuery] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [commandOpen, setCommandOpen] = useState(false)
  const chat = usePrototypeChat(prototypeMessages)
  const selectedConversation = conversations.find(
    (item) => item.id === activeConversation
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        (target?.matches("input, textarea, select, [contenteditable='true']") ??
          false) ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return
      }

      event.preventDefault()
      setCommandOpen((open) => !open)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function changeView(view: PrototypeView) {
    setActiveView(view)
    setCommandOpen(false)
    setPaletteQuery("")
  }

  function startNewChat() {
    setActiveView("chat")
    setActiveConversation("plain-docs")
    setQuery("")
    setCommandOpen(false)
    chat.setDraft("")
  }

  const normalizedPaletteQuery = paletteQuery.trim().toLowerCase()
  const filteredNavItems = navItems.filter(
    (item) =>
      !normalizedPaletteQuery ||
      item.label.toLowerCase().includes(normalizedPaletteQuery) ||
      item.hint.toLowerCase().includes(normalizedPaletteQuery)
  )
  const filteredConversations = conversations.filter(
    (conversation) =>
      !normalizedPaletteQuery ||
      conversation.title.toLowerCase().includes(normalizedPaletteQuery)
  )

  return (
    <main className={cn(styles.variant, styles.enter, styles.commandShell)}>
      <header className={styles.commandTopbar}>
        <div className={styles.commandTopbarStart}>
          <Button
            aria-label={
              drawerOpen ? "Close command drawer" : "Open command drawer"
            }
            onClick={() => setDrawerOpen(!drawerOpen)}
            size="icon-sm"
            title={drawerOpen ? "Close command drawer" : "Open command drawer"}
            variant="outline"
          >
            {drawerOpen ? (
              <PanelLeftClose data-icon="inline-start" />
            ) : (
              <PanelLeftOpen data-icon="inline-start" />
            )}
          </Button>
          <PrototypeBrand />
          <Button
            className={styles.commandSearch}
            onClick={() => setCommandOpen(true)}
            variant="outline"
          >
            <Search data-icon="inline-start" />
            <span className="truncate">Search workspace</span>
            <kbd>⌘ K</kbd>
          </Button>
        </div>
        <div className={styles.commandTopbarEnd}>
          <Badge variant="secondary">2 live rooms</Badge>
          <Button
            aria-label="Docs and guides"
            onClick={() => changeView("settings")}
            size="icon-sm"
            title="Docs & guides"
            variant="ghost"
          >
            <CircleHelp data-icon="inline-start" />
          </Button>
          <Avatar size="sm">
            <AvatarFallback>JN</AvatarFallback>
          </Avatar>
        </div>
      </header>

      <div className={styles.commandBody}>
        {drawerOpen && (
          <aside
            className={styles.commandDrawer}
            aria-label="Command navigation"
          >
            <div className={styles.commandDrawerHeader}>
              <div>
                <p className="text-[11px] text-muted-foreground">
                  Justin&apos;s workspace
                </p>
                <h2 className="text-sm font-semibold">Navigate</h2>
              </div>
              <Button
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
                size="icon-sm"
                variant="ghost"
              >
                <X data-icon="inline-start" />
              </Button>
            </div>
            <Button className="w-full justify-start" onClick={startNewChat}>
              <Plus data-icon="inline-start" />
              New chat
            </Button>
            <div className={styles.commandDrawerNav}>
              <ViewNav activeView={activeView} onChange={changeView} />
            </div>
            {activeView === "chat" ? (
              <div className={styles.commandDrawerRecents}>
                <ConversationList
                  activeConversation={activeConversation}
                  onSelect={setActiveConversation}
                  query={query}
                  setQuery={setQuery}
                />
              </div>
            ) : (
              <div className="mt-auto rounded-xl border bg-card p-3">
                <p className="text-xs font-medium">{viewLabels[activeView]}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  This workspace surface stays one click away while the command
                  drawer is open.
                </p>
                <Button
                  className="mt-3 w-full"
                  onClick={() => changeView("chat")}
                  size="sm"
                  variant="outline"
                >
                  Return to chat
                </Button>
              </div>
            )}
          </aside>
        )}

        <section className={styles.commandMain}>
          <header className={styles.commandConversationHeader}>
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                {activeView === "chat" ? <Command /> : <Menu />}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[11px] text-muted-foreground">
                  JustLAB / {viewLabels[activeView]}
                </p>
                <h1 className="truncate text-sm font-semibold">
                  {activeView === "chat"
                    ? (selectedConversation?.title ?? "New conversation")
                    : viewLabels[activeView]}
                </h1>
              </div>
            </div>
            <Badge className="hidden sm:inline-flex" variant="outline">
              OpenAI-compatible · gpt-4o-mini
            </Badge>
          </header>

          {activeView === "chat" ? (
            <section
              className={styles.chatStage}
              aria-label="Chat conversation"
            >
              <PrototypeMessages density="compact" messages={chat.messages} />
              <div className={styles.composerDock}>
                <PrototypeComposer {...chat} compact />
                <p className="mx-auto mt-2 max-w-[720px] text-center text-[11px] text-muted-foreground">
                  Tip: press ⌘ K to switch between chat, live rooms, knowledge,
                  and tools.
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
      </div>

      {commandOpen && (
        <div
          className={styles.commandPalette}
          role="dialog"
          aria-label="Search workspace"
        >
          <div className={styles.commandPaletteSearch}>
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              aria-label="Search workspace"
              autoFocus
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="Jump to a feature or conversation"
              value={paletteQuery}
            />
            <Button
              aria-label="Close workspace search"
              onClick={() => setCommandOpen(false)}
              size="icon-xs"
              variant="ghost"
            >
              <X data-icon="inline-start" />
            </Button>
          </div>
          <div className={styles.commandPaletteItems}>
            {filteredNavItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  className={styles.commandPaletteItem}
                  key={item.id}
                  onClick={() => changeView(item.id)}
                  type="button"
                >
                  <Icon />
                  <span className={styles.commandPaletteItemText}>
                    <span className="block text-xs font-medium">
                      {item.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {item.hint}
                    </span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Feature
                  </span>
                </button>
              )
            })}
            {filteredConversations.slice(0, 4).map((conversation) => (
              <button
                className={styles.commandPaletteItem}
                key={conversation.id}
                onClick={() => {
                  setActiveConversation(conversation.id)
                  setActiveView("chat")
                  setCommandOpen(false)
                  setPaletteQuery("")
                }}
                type="button"
              >
                <MessageSquare />
                <span className={styles.commandPaletteItemText}>
                  <span className="block truncate text-xs font-medium">
                    {conversation.title}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {conversation.meta}
                  </span>
                </span>
                <span className="text-[10px] text-muted-foreground">Chat</span>
              </button>
            ))}
            {!filteredNavItems.length && !filteredConversations.length && (
              <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                No workspace matches.
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
