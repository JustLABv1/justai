"use client"

import { BookOpenText, ExternalLink, PanelRight, Sparkles } from "lucide-react"
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
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import {
  ContextRow,
  EndpointPill,
  GlobalSidebar,
  PrototypeComposer,
  PrototypeMessageList,
  SourceRow,
  contextIcons,
  focusMessages,
  usePrototypeChat,
} from "./prototype-data"
import styles from "./prototype.module.css"

const endpoints = [
  { label: "JustAI route", detail: "balanced · 320 ms" },
  { label: "Google Gemini", detail: "fast · 244 ms" },
  { label: "Local Ollama", detail: "private · 510 ms" },
]

export function FocusVariant() {
  const [activeView, setActiveView] = useState("chat")
  const [contextOpen, setContextOpen] = useState(true)
  const [endpointIndex, setEndpointIndex] = useState(0)
  const { messages, draft, setDraft, send, isSending } =
    usePrototypeChat(focusMessages)
  const endpoint = endpoints[endpointIndex]

  return (
    <main className={cn(styles.variant, styles.entrance, styles.focusVariant)}>
      <div className={styles.focusGrid}>
        <GlobalSidebar
          activeView={activeView}
          className={styles.focusGlobalSidebar}
          condensed
          onViewChange={setActiveView}
        />
        <section className={styles.focusMain}>
          <header className="flex shrink-0 items-center justify-between gap-4 px-5 py-4 sm:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                <Sparkles data-icon="inline-start" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-tight">
                  JustAI / Focus
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  A single calm place to think with models
                </p>
              </div>
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
                aria-expanded={contextOpen}
                className="hidden sm:inline-flex"
                onClick={() => setContextOpen((open) => !open)}
                size="sm"
                variant={contextOpen ? "secondary" : "outline"}
              >
                <PanelRight data-icon="inline-start" />
                {contextOpen ? "Hide context" : "Show context"}
              </Button>
              <Button
                aria-label={contextOpen ? "Hide context" : "Show context"}
                aria-expanded={contextOpen}
                className="sm:hidden"
                onClick={() => setContextOpen((open) => !open)}
                size="icon-sm"
                variant={contextOpen ? "secondary" : "outline"}
              >
                <PanelRight data-icon="inline-start" />
              </Button>
            </div>
          </header>

          <div
            className={cn(
              styles.focusCanvas,
              !contextOpen && styles.focusCanvasClosed
            )}
          >
            <section className={styles.focusConversation}>
              <div className={styles.focusIntro}>
                <Badge variant="secondary">
                  <Sparkles data-icon="inline-start" />
                  Ready when you are
                </Badge>
                <h1 className="mt-5 max-w-2xl text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                  Make space for the next useful thought.
                </h1>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  One conversation, one clear route, and the sources you choose.
                  Ask naturally; Focus keeps the machinery nearby but out of the
                  way.
                </p>
              </div>
              <div className="min-h-0 flex-1">
                <PrototypeMessageList density="focused" messages={messages} />
              </div>
              <div className="shrink-0 px-4 pb-4 sm:px-10 sm:pb-8">
                <PrototypeComposer
                  className="mx-auto max-w-2xl"
                  draft={draft}
                  isSending={isSending}
                  placeholder="Ask JustAI to help you think..."
                  send={send}
                  setDraft={setDraft}
                />
              </div>
            </section>

            {contextOpen ? (
              <aside className={styles.focusContext}>
                <div className="flex items-center justify-between gap-3 px-1 pb-3">
                  <div>
                    <p className="text-sm font-semibold">Context</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      The quiet edge of the conversation
                    </p>
                  </div>
                  <Button
                    aria-label="Close context"
                    className="sm:hidden"
                    onClick={() => setContextOpen(false)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PanelRight data-icon="inline-start" />
                  </Button>
                </div>
                <Tabs className="min-h-0 flex-1" defaultValue="sources">
                  <TabsList className="w-full" variant="line">
                    <TabsTrigger value="sources">Sources</TabsTrigger>
                    <TabsTrigger value="run">Run details</TabsTrigger>
                  </TabsList>
                  <TabsContent
                    className="flex flex-col gap-3 overflow-y-auto pt-4"
                    value="sources"
                  >
                    <Card className="shadow-none">
                      <CardHeader className="gap-1 px-4 py-4">
                        <CardTitle className="text-sm">
                          Grounded in your work
                        </CardTitle>
                        <CardDescription className="text-[11px]">
                          2 sources are ready for this thread.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-1 px-3 pb-3">
                        <SourceRow
                          label="Product brief"
                          meta="Notion sync · updated 4m ago"
                        />
                        <SourceRow
                          label="Architecture brief.md"
                          meta="Local file · 82% match"
                        />
                        <Button
                          className="mt-2 w-full"
                          size="sm"
                          variant="outline"
                        >
                          <BookOpenText data-icon="inline-start" />
                          Add a source
                        </Button>
                      </CardContent>
                    </Card>
                    <Card className="shadow-none">
                      <CardHeader className="gap-1 px-4 py-4">
                        <CardTitle className="text-sm">
                          Retrieval confidence
                        </CardTitle>
                        <CardDescription className="text-[11px]">
                          Strong enough to cite directly.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="px-4 pb-4">
                        <Progress value={84}>
                          <div className="flex w-full items-center justify-between text-[11px]">
                            <span className="text-muted-foreground">
                              Semantic match
                            </span>
                            <span className="font-semibold">84%</span>
                          </div>
                        </Progress>
                      </CardContent>
                    </Card>
                    <div className="rounded-xl border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">
                      <p className="font-medium text-foreground">Tip</p>
                      <p className="mt-1">
                        Switch to Run details when you want to inspect the exact
                        endpoint and latency without leaving the conversation.
                      </p>
                    </div>
                  </TabsContent>
                  <TabsContent
                    className="flex flex-col gap-3 overflow-y-auto pt-4"
                    value="run"
                  >
                    <Card className="shadow-none">
                      <CardHeader className="gap-1 px-4 py-4">
                        <CardTitle className="text-sm">This response</CardTitle>
                        <CardDescription className="text-[11px]">
                          A transparent, reversible route.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4 px-4 pb-4">
                        <ContextRow
                          icon={contextIcons.endpoint}
                          label="Endpoint"
                          value={`${endpoint?.label} · ${endpoint?.detail}`}
                        />
                        <ContextRow
                          icon={contextIcons.knowledge}
                          label="Retrieval"
                          value="2 sources · 84% confidence"
                        />
                        <ContextRow
                          icon={contextIcons.mcp}
                          label="MCP tools"
                          status="idle"
                          value="No tools called"
                        />
                      </CardContent>
                    </Card>
                    <Button className="w-full" size="sm" variant="outline">
                      <ExternalLink data-icon="inline-start" />
                      Open trace
                    </Button>
                  </TabsContent>
                </Tabs>
              </aside>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  )
}
