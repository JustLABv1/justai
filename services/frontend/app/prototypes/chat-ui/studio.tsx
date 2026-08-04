"use client"

import {
  BookOpenText,
  Check,
  MoreHorizontal,
  RefreshCw,
  Route,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import {
  ContextRow,
  ContextStack,
  ConversationRail,
  EndpointPill,
  GlobalSidebar,
  PrototypeComposer,
  PrototypeMessageList,
  SourceRow,
  WorkspaceMetric,
  contextIcons,
  studioMessages,
  usePrototypeChat,
} from "./prototype-data"
import styles from "./prototype.module.css"

const endpoints = [
  { label: "OpenAI-compatible", detail: "gpt-4o-mini" },
  { label: "Google Gemini", detail: "gemini-2.5-flash" },
  { label: "Local Ollama", detail: "llama3.2:latest" },
]

export function StudioVariant() {
  const [activeView, setActiveView] = useState("chat")
  const [activeConversation, setActiveConversation] = useState("onboarding")
  const [query, setQuery] = useState("")
  const [endpointIndex, setEndpointIndex] = useState(0)
  const { messages, draft, setDraft, send, isSending } =
    usePrototypeChat(studioMessages)
  const endpoint = endpoints[endpointIndex]

  return (
    <main className={cn(styles.variant, styles.entrance, styles.studioVariant)}>
      <div className={styles.studioGrid}>
        <GlobalSidebar
          activeView={activeView}
          className={styles.studioGlobalSidebar}
          onViewChange={setActiveView}
        />
        <ConversationRail
          activeConversation={activeConversation}
          className={styles.studioConversationRail}
          onConversationChange={setActiveConversation}
          query={query}
          setQuery={setQuery}
        />
        <section className={styles.studioMain}>
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/70 bg-background/80 px-4 py-3 backdrop-blur sm:px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>Workspace</span>
                <span>/</span>
                <span className="truncate">Product discovery</span>
              </div>
              <h1 className="mt-1 truncate text-sm font-semibold tracking-tight sm:text-base">
                Onboarding notes
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <EndpointPill
                detail={endpoint?.detail}
                label={endpoint?.label}
                onClick={() =>
                  setEndpointIndex(
                    (current) => (current + 1) % endpoints.length
                  )
                }
              />
              <Button
                aria-label="More conversation actions"
                size="icon-sm"
                variant="ghost"
              >
                <MoreHorizontal data-icon="inline-start" />
              </Button>
            </div>
          </header>

          <div className={styles.studioWorkspace}>
            <section className={styles.studioConversation}>
              <div className="min-h-0 flex-1">
                <PrototypeMessageList
                  density="comfortable"
                  messages={messages}
                />
              </div>
              <div className="shrink-0 border-t border-border/70 bg-background/85 p-3 sm:p-5">
                <PrototypeComposer
                  draft={draft}
                  isSending={isSending}
                  send={send}
                  setDraft={setDraft}
                />
              </div>
            </section>

            <aside className={styles.studioInspector}>
              <div className="flex items-center justify-between gap-3 px-1">
                <div>
                  <p className="text-xs font-semibold">Run context</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Visible at a glance
                  </p>
                </div>
                <Button
                  aria-label="Tune run context"
                  size="icon-sm"
                  variant="ghost"
                >
                  <SlidersHorizontal data-icon="inline-start" />
                </Button>
              </div>

              <ContextStack description="The route used for this conversation.">
                <ContextRow
                  icon={contextIcons.endpoint}
                  label="Active endpoint"
                  value={`${endpoint?.label} · ${endpoint?.detail}`}
                />
                <ContextRow
                  icon={Route}
                  label="Fallback route"
                  status="idle"
                  value="Ollama · llama3.2:latest"
                />
                <div className="rounded-xl bg-muted/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Latency budget
                    </span>
                    <Badge variant="secondary">142 ms</Badge>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                    <div className="h-full w-[68%] rounded-full bg-primary" />
                  </div>
                </div>
              </ContextStack>

              <ContextStack
                description="Sources that can be cited in the next answer."
                title="Knowledge"
              >
                <SourceRow
                  label="Architecture brief.md"
                  meta="82% match · 4.2 KB"
                />
                <SourceRow
                  label="MCP transport notes"
                  meta="71% match · 2.1 KB"
                />
                <Button className="w-full" size="sm" variant="outline">
                  <BookOpenText data-icon="inline-start" />
                  Manage collection
                </Button>
              </ContextStack>

              <Card className="shadow-none">
                <CardHeader className="gap-1 px-4 py-4">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <ShieldCheck />
                    Workspace health
                  </CardTitle>
                  <CardDescription className="text-[11px]">
                    Ready for a grounded run.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-2 px-4 pb-4">
                  <WorkspaceMetric
                    detail="last 24h"
                    icon={Check}
                    label="Grounded"
                    value="96%"
                  />
                  <WorkspaceMetric
                    detail="this session"
                    icon={RefreshCw}
                    label="Synced"
                    value="4m"
                  />
                </CardContent>
              </Card>

              <Separator className="my-1" />
              <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
                Studio keeps the route, sources, and conversation visible
                together—built for deliberate daily work.
              </p>
            </aside>
          </div>
        </section>
      </div>
    </main>
  )
}
