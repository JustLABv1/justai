"use client"

import {
  Activity,
  AudioLines,
  Database,
  FileText,
  MoreHorizontal,
  Radio,
  ShieldCheck,
  Terminal,
  Zap,
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
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import {
  ContextRow,
  ContextStack,
  EndpointPill,
  GlobalSidebar,
  LiveSignal,
  PrototypeComposer,
  PrototypeMessageList,
  SourceRow,
  contextIcons,
  pulseMessages,
  usePrototypeChat,
} from "./prototype-data"
import styles from "./prototype.module.css"

const endpoints = [
  { label: "OpenAI-compatible", detail: "gpt-4o-mini" },
  { label: "LiteLLM gateway", detail: "workspace-balanced" },
  { label: "Ollama local", detail: "llama3.2:latest" },
]

export function PulseVariant() {
  const [activeView, setActiveView] = useState("chat")
  const [endpointIndex, setEndpointIndex] = useState(0)
  const [isLive, setIsLive] = useState(true)
  const { messages, draft, setDraft, send, isSending } =
    usePrototypeChat(pulseMessages)
  const endpoint = endpoints[endpointIndex]

  return (
    <main className={cn(styles.variant, styles.entrance, styles.pulseVariant)}>
      <div className={styles.pulseGrid}>
        <GlobalSidebar
          activeView={activeView}
          className={styles.pulseGlobalSidebar}
          onViewChange={setActiveView}
        />
        <section className={styles.pulseMain}>
          <header className={styles.pulseHeader}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge>
                  <span className="size-1.5 rounded-full bg-primary-foreground" />
                  Live workspace
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  09:18 AM · Tuesday
                </span>
              </div>
              <h1 className="mt-2 truncate text-lg font-semibold tracking-tight sm:text-xl">
                Call review / Product direction
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                A conversation with the room still warm.
              </p>
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
                aria-label="More workspace actions"
                size="icon-sm"
                variant="ghost"
              >
                <MoreHorizontal data-icon="inline-start" />
              </Button>
            </div>
          </header>

          <div className={styles.pulseWorkspace}>
            <section className={styles.pulseConversationPanel}>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-6">
                <LiveSignal
                  detail={
                    isLive
                      ? "English · 00:12:04 captured"
                      : "Paused · 00:12:04 captured"
                  }
                  icon={AudioLines}
                  label={isLive ? "Transcribing live" : "Transcript paused"}
                />
                <Button
                  onClick={() => setIsLive((live) => !live)}
                  size="sm"
                  variant={isLive ? "secondary" : "outline"}
                >
                  <Radio data-icon="inline-start" />
                  {isLive ? "Pause" : "Resume"}
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <PrototypeMessageList density="compact" messages={messages} />
              </div>
              <div className="shrink-0 border-t border-border/70 bg-background/85 p-3 sm:p-5">
                <PrototypeComposer
                  draft={draft}
                  isSending={isSending}
                  placeholder="Ask about the live notes..."
                  send={send}
                  setDraft={setDraft}
                />
              </div>
            </section>

            <aside className={styles.pulseContext}>
              <Tabs className="min-h-0 flex-1" defaultValue="live">
                <TabsList className="w-full" variant="line">
                  <TabsTrigger value="live">Live context</TabsTrigger>
                  <TabsTrigger value="trace">Trace</TabsTrigger>
                </TabsList>
                <TabsContent
                  className="flex flex-col gap-3 overflow-y-auto pt-4"
                  value="live"
                >
                  <ContextStack
                    description="The room signal flowing into this chat."
                    title="Live transcription"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <LiveSignal
                        detail="Speaker separation on"
                        label="Listening"
                      />
                      <Badge variant="secondary">4 speakers</Badge>
                    </div>
                    <Progress value={isLive ? 62 : 28}>
                      <div className="flex w-full items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">
                          Signal strength
                        </span>
                        <span className="font-semibold">
                          {isLive ? "Good" : "Paused"}
                        </span>
                      </div>
                    </Progress>
                    <div className="rounded-xl bg-muted/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
                      <p className="font-medium text-foreground">
                        Latest phrase
                      </p>
                      <p className="mt-1">
                        “Make the route visible before we make it automatic.”
                      </p>
                    </div>
                  </ContextStack>

                  <ContextStack
                    description="Matches found while the transcript changes."
                    title="RAG retrieval"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Database />
                        <span className="text-xs font-medium">
                          Product knowledge
                        </span>
                      </div>
                      <Badge>3 hits</Badge>
                    </div>
                    <SourceRow
                      label="Fallback policy.md"
                      meta="92% match · cited"
                    />
                    <SourceRow
                      label="Call transcript · 12:04"
                      meta="89% match · live"
                    />
                    <SourceRow
                      label="Provider routing"
                      meta="74% match · workspace"
                    />
                  </ContextStack>

                  <ContextStack
                    description="Available actions for this workspace."
                    title="MCP tools"
                  >
                    <ContextRow
                      icon={Terminal}
                      label="Decision log"
                      status="working"
                      value="Ready to append a note"
                    />
                    <ContextRow
                      icon={Zap}
                      label="Task handoff"
                      status="idle"
                      value="No action requested"
                    />
                  </ContextStack>
                </TabsContent>
                <TabsContent
                  className="flex flex-col gap-3 overflow-y-auto pt-4"
                  value="trace"
                >
                  <Card className="shadow-none">
                    <CardHeader className="gap-1 px-4 py-4">
                      <CardTitle className="text-sm">Response trace</CardTitle>
                      <CardDescription className="text-[11px]">
                        The route is inspectable, not magical.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-2 px-4 pb-4">
                      <div className="rounded-xl bg-muted/60 p-3">
                        <Activity />
                        <p className="mt-2 text-lg font-semibold">320ms</p>
                        <p className="text-[10px] text-muted-foreground">
                          time to first token
                        </p>
                      </div>
                      <div className="rounded-xl bg-muted/60 p-3">
                        <ShieldCheck />
                        <p className="mt-2 text-lg font-semibold">3 / 3</p>
                        <p className="text-[10px] text-muted-foreground">
                          sources available
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                  <ContextStack
                    description="Every layer that shaped this answer."
                    title="Route steps"
                  >
                    <ContextRow
                      icon={contextIcons.transcript}
                      label="Transcription"
                      value="12:04 of live audio"
                    />
                    <ContextRow
                      icon={contextIcons.knowledge}
                      label="Retrieval"
                      value="3 semantic matches"
                    />
                    <ContextRow
                      icon={contextIcons.endpoint}
                      label="Generation"
                      value={`${endpoint?.label} · ${endpoint?.detail}`}
                    />
                  </ContextStack>
                  <Button className="w-full" size="sm" variant="outline">
                    <FileText data-icon="inline-start" />
                    Export trace
                  </Button>
                </TabsContent>
              </Tabs>
            </aside>
          </div>
        </section>
      </div>
    </main>
  )
}
