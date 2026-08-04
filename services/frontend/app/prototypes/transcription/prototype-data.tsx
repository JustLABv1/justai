"use client"

import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  Copy,
  Headphones,
  LibraryBig,
  MessageSquareText,
  Mic2,
  MoreHorizontal,
  Pencil,
  PlugZap,
  Radio,
  Settings2,
  Share2,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"

import { BrandMark } from "@/components/brand-mark"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import styles from "./prototype.module.css"

export type RoomSpeakerStatus = "speaking" | "listening" | "quiet"

export type RoomSpeaker = {
  id: string
  name: string
  initials: string
  role: string
  sourceId: string
  source: string
  device: string
  location: string
  lastSpoke: string
  words: number
  confidence: string
  signal: number
  accent: string
  status: RoomSpeakerStatus
}

export type RoomTranscriptLine = {
  id: string
  timestamp: string
  speakerId: string
  text: string
  provisional?: boolean
}

export const roomSpeakers: RoomSpeaker[] = [
  {
    id: "maya",
    name: "Maya Chen",
    initials: "MC",
    role: "Product",
    sourceId: "room-a",
    source: "Room mic A",
    device: "Ceiling array",
    location: "West table",
    lastSpoke: "00:11",
    words: 148,
    confidence: "96%",
    signal: 82,
    accent: "var(--chart-1)",
    status: "speaking",
  },
  {
    id: "leon",
    name: "Leon Weber",
    initials: "LW",
    role: "Engineering",
    sourceId: "leon-macbook",
    source: "Leon's MacBook",
    device: "MacBook Pro mic",
    location: "North table",
    lastSpoke: "00:26",
    words: 92,
    confidence: "93%",
    signal: 64,
    accent: "var(--chart-2)",
    status: "listening",
  },
  {
    id: "priya",
    name: "Priya Nair",
    initials: "PN",
    role: "Design",
    sourceId: "room-b",
    source: "Room mic B",
    device: "USB boundary mic",
    location: "East table",
    lastSpoke: "00:43",
    words: 61,
    confidence: "91%",
    signal: 47,
    accent: "var(--chart-3)",
    status: "quiet",
  },
  {
    id: "justin",
    name: "Justin",
    initials: "J",
    role: "Host",
    sourceId: "host-laptop",
    source: "This laptop",
    device: "Built-in microphone",
    location: "Host desk",
    lastSpoke: "01:02",
    words: 37,
    confidence: "98%",
    signal: 29,
    accent: "var(--chart-4)",
    status: "quiet",
  },
]

export const roomSources = [
  { id: "room-a", label: "Room mic A", detail: "Ceiling array · West table", kind: "shared" },
  { id: "leon-macbook", label: "Leon's MacBook", detail: "MacBook Pro mic · North table", kind: "personal" },
  { id: "room-b", label: "Room mic B", detail: "USB boundary mic · East table", kind: "shared" },
  { id: "host-laptop", label: "This laptop", detail: "Built-in microphone · Host desk", kind: "host" },
]

export const roomTranscript: RoomTranscriptLine[] = [
  {
    id: "line-1",
    timestamp: "00:08",
    speakerId: "maya",
    text: "The room-scale version should feel like a shared instrument, not another call window.",
  },
  {
    id: "line-2",
    timestamp: "00:19",
    speakerId: "leon",
    text: "Then every microphone needs a name and a visible health signal.",
  },
  {
    id: "line-3",
    timestamp: "00:31",
    speakerId: "priya",
    text: "The transcript can stay quiet until I need to review a decision.",
  },
  {
    id: "line-4",
    timestamp: "00:48",
    speakerId: "maya",
    text: "Let's make the orbit the default and keep the machinery one click away.",
  },
  {
    id: "line-5",
    timestamp: "01:04",
    speakerId: "justin",
    text: "I will keep the host laptop available as both a viewer and a capture source.",
    provisional: true,
  },
]

type NavItem = {
  id: string
  label: string
  icon: LucideIcon
}

const navItems: NavItem[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "endpoints", label: "Endpoints", icon: Radio },
  { id: "knowledge", label: "Knowledge", icon: LibraryBig },
  { id: "mcp", label: "MCP", icon: PlugZap },
]

export function useTranscriptionRoom() {
  const [isLive, setIsLive] = useState(true)
  const [activeSpeakerId, setActiveSpeakerId] = useState("maya")
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | null>(null)
  const [activeSourceId, setActiveSourceId] = useState("room-a")
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!isLive) {
      return
    }

    const timer = window.setInterval(() => {
      setActiveSpeakerId((current) => {
        const currentIndex = roomSpeakers.findIndex((speaker) => speaker.id === current)
        const nextSpeaker = roomSpeakers[(currentIndex + 1) % roomSpeakers.length]
        setActiveSourceId(nextSpeaker.sourceId)
        return nextSpeaker.id
      })
    }, 3200)

    return () => window.clearInterval(timer)
  }, [isLive])

  const speakers = useMemo(
    () =>
      roomSpeakers.map((speaker) => ({
        ...speaker,
        name: speakerNames[speaker.id] || speaker.name,
        status: (!isLive
          ? "quiet"
          : speaker.id === activeSpeakerId
            ? "speaking"
            : speaker.status === "speaking"
              ? "listening"
              : speaker.status) as RoomSpeakerStatus,
      })),
    [activeSpeakerId, isLive, speakerNames]
  )

  const selectedSpeaker = speakers.find((speaker) => speaker.id === selectedSpeakerId) ?? null
  const activeSpeaker = speakers.find((speaker) => speaker.id === activeSpeakerId) ?? null

  const selectSource = useCallback((sourceId: string) => {
    setActiveSourceId(sourceId)
    const sourceSpeaker = roomSpeakers.find((speaker) => speaker.sourceId === sourceId)
    if (sourceSpeaker) {
      setActiveSpeakerId(sourceSpeaker.id)
    }
  }, [])

  const renameSpeaker = useCallback((speakerId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }
    setSpeakerNames((current) => ({ ...current, [speakerId]: trimmed }))
  }, [])

  return {
    activeSpeaker,
    activeSpeakerId,
    activeSourceId,
    isLive,
    renameSpeaker,
    selectSource,
    selectedSpeaker,
    selectedSpeakerId,
    setIsLive,
    setSelectedSpeakerId,
    setTranscriptOpen,
    speakers,
    transcriptOpen,
  }
}

export function PrototypeSidebar({
  activeView,
  onViewChange,
  className,
}: {
  activeView: string
  onViewChange: (view: string) => void
  className?: string
}) {
  const [chatOpen, setChatOpen] = useState(false)
  const [transcriptionOpen, setTranscriptionOpen] = useState(true)

  return (
    <aside className={cn(styles.sidebar, className)}>
      <div className="flex items-center gap-2 px-1">
        <BrandMark className="size-9 rounded-xl" priority />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">JustAI</p>
          <p className="truncate text-[11px] text-muted-foreground">JustLAB workspace</p>
        </div>
      </div>

      <Button className="mt-5 h-auto justify-between rounded-xl px-3 py-2 text-left" variant="outline">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
            <Sparkles data-icon="inline-start" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold">Justin&apos;s workspace</span>
            <span className="block truncate text-[10px] font-normal text-muted-foreground">owner access</span>
          </span>
        </span>
        <ChevronDown data-icon="inline-end" />
      </Button>

      <nav aria-label="Prototype workspace navigation" className="mt-6 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <p className="px-2 text-[11px] font-medium text-muted-foreground">Workspace</p>

          <Collapsible open={chatOpen} onOpenChange={setChatOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  className={cn("h-9 w-full justify-start gap-2 px-2.5", activeView === "chat" && "bg-sidebar-accent text-sidebar-accent-foreground")}
                  onClick={() => onViewChange("chat")}
                  variant="ghost"
                />
              }
            >
              <MessageSquareText data-icon="inline-start" />
              <span>Chat</span>
              <ChevronRight className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ml-4 flex flex-col gap-0.5 border-l border-border/70 py-1 pl-2">
                {["Onboarding notes", "Provider routing"].map((item, index) => (
                  <Button className="h-8 justify-start gap-2 px-2 text-xs font-normal" key={item} onClick={() => onViewChange("chat")} variant="ghost">
                    <span className={cn("size-1.5 rounded-full", index === 0 ? "bg-primary" : "bg-muted-foreground/30")} />
                    <span className="truncate">{item}</span>
                  </Button>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={transcriptionOpen} onOpenChange={setTranscriptionOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  className={cn("h-9 w-full justify-start gap-2 px-2.5", activeView === "transcription" && "bg-sidebar-accent text-sidebar-accent-foreground")}
                  onClick={() => onViewChange("transcription")}
                  variant="ghost"
                />
              }
            >
              <Headphones data-icon="inline-start" />
              <span>Live transcription</span>
              <ChevronRight className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ml-4 flex flex-col gap-0.5 border-l border-border/70 py-1 pl-2">
                <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Sessions</p>
                <Button className="h-8 justify-start gap-2 bg-muted/70 px-2 text-xs font-normal" onClick={() => onViewChange("transcription")} variant="ghost">
                  <span className="size-1.5 rounded-full bg-primary" />
                  <span className="truncate">Product direction</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">now</span>
                </Button>
                <Button className="h-8 justify-start gap-2 px-2 text-xs font-normal text-muted-foreground" onClick={() => onViewChange("transcription-history")} variant="ghost">
                  <Clock3 data-icon="inline-start" />
                  <span className="truncate">Design review</span>
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {navItems.slice(1).map((item) => {
            const Icon = item.icon
            return (
              <Button
                aria-current={activeView === item.id ? "page" : undefined}
                className={cn("h-9 justify-start gap-2 px-2.5", activeView === item.id && "bg-sidebar-accent text-sidebar-accent-foreground")}
                key={item.id}
                onClick={() => onViewChange(item.id)}
                variant="ghost"
              >
                <Icon data-icon="inline-start" />
                <span>{item.label}</span>
              </Button>
            )
          })}
        </div>

        <div className="flex flex-col gap-1">
          <p className="px-2 text-[11px] font-medium text-muted-foreground">System</p>
          <Button className="h-9 justify-start gap-2 px-2.5" onClick={() => onViewChange("settings")} variant="ghost">
            <Settings2 data-icon="inline-start" />
            <span>Settings</span>
          </Button>
          <Button className="h-9 justify-start gap-2 px-2.5" onClick={() => onViewChange("docs")} variant="ghost">
            <CircleHelp data-icon="inline-start" />
            <span>Docs & guides</span>
          </Button>
        </div>
      </nav>

      <div className="mt-4 border-t border-border/70 pt-3">
        <Button className="h-auto w-full justify-start gap-2 px-1.5 py-2 text-left" variant="ghost">
          <Avatar size="sm">
            <AvatarFallback>J</AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">Justin Neubert</span>
            <span className="block truncate text-[10px] font-normal text-muted-foreground">justin@justlab.local</span>
          </span>
          <MoreHorizontal className="ml-auto text-muted-foreground" />
        </Button>
      </div>
    </aside>
  )
}

export function SignalBars({ value, accent }: { value: number; accent?: string }) {
  const activeBars = Math.max(1, Math.ceil(value / 20))

  return (
    <div
      aria-label={`${value}% signal`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value}
      className={styles.signalBars}
      role="meter"
      style={{ "--speaker-accent": accent || "var(--primary)" } as CSSProperties}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <span className={cn(index < activeBars && styles.signalBarActive)} key={index} />
      ))}
    </div>
  )
}

export function ListenCore({
  isLive,
  activeSpeaker,
  compact = false,
}: {
  isLive: boolean
  activeSpeaker: RoomSpeaker | null
  compact?: boolean
}) {
  return (
    <div
      aria-label={isLive ? "JustAI is listening" : "Transcription paused"}
      className={cn(styles.listenCore, compact && styles.listenCoreCompact, isLive ? styles.listenCoreLive : styles.listenCorePaused)}
      style={{ "--speaker-accent": activeSpeaker?.accent || "var(--primary)" } as CSSProperties}
    >
      <span aria-hidden="true" className={styles.coreWave} />
      <span aria-hidden="true" className={styles.coreWave} />
      <span aria-hidden="true" className={styles.coreWave} />
      <div className={styles.coreSurface}>
        <div className={styles.coreGlyph}>
          <AudioLines data-icon="inline-start" />
        </div>
        <span className="text-[11px] font-semibold tracking-[0.16em] uppercase">{isLive ? "Listening" : "Paused"}</span>
        <span className="text-[10px] text-muted-foreground">{isLive ? activeSpeaker ? `${activeSpeaker.name} is speaking` : "Waiting for audio" : "Capture paused"}</span>
      </div>
    </div>
  )
}

export function SpeakerNode({
  speaker,
  angle,
  active,
  onClick,
  className,
  style,
}: {
  speaker: RoomSpeaker
  angle: number
  active: boolean
  onClick: () => void
  className?: string
  style?: CSSProperties
}) {
  return (
    <Button
      aria-label={`Open details for ${speaker.name}`}
      className={cn(styles.speakerNode, active && styles.speakerNodeActive, className)}
      onClick={onClick}
      style={{ "--speaker-accent": speaker.accent, "--speaker-angle": `${angle}deg`, ...style } as CSSProperties}
      variant="ghost"
    >
      <span className={styles.speakerNodeHalo} />
      <Avatar className={styles.speakerAvatar} size="lg">
        <AvatarFallback>{speaker.initials}</AvatarFallback>
      </Avatar>
      <span className={styles.speakerNodeLabel}>
        <span className="block max-w-32 truncate text-xs font-semibold">{speaker.name}</span>
        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", speaker.status === "speaking" ? "bg-primary" : "bg-muted-foreground/40")} />
          {speaker.status === "speaking" ? "speaking" : speaker.source}
        </span>
      </span>
    </Button>
  )
}

export function SourceStrip({
  activeSourceId,
  onSourceChange,
  speakers,
}: {
  activeSourceId: string
  onSourceChange: (sourceId: string) => void
  speakers: RoomSpeaker[]
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
      {roomSources.map((source) => {
        const sourceSpeaker = speakers.find((speaker) => speaker.sourceId === source.id)
        const active = activeSourceId === source.id

        return (
          <Button
            aria-pressed={active}
            className={cn("h-auto min-w-40 shrink-0 justify-start gap-2 rounded-xl px-2.5 py-2 text-left", active && "border-primary/40 bg-primary/5")}
            key={source.id}
            onClick={() => onSourceChange(source.id)}
            size="sm"
            variant="outline"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Mic2 data-icon="inline-start" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-semibold">{source.label}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <SignalBars accent={sourceSpeaker?.accent} value={sourceSpeaker?.signal ?? 0} />
                {sourceSpeaker?.signal ?? 0}%
              </span>
            </span>
          </Button>
        )
      })}
    </div>
  )
}

export function TranscriptTray({
  open,
  onOpenChange,
  speakers,
  className,
  transcript = roomTranscript,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  speakers: RoomSpeaker[]
  className?: string
  transcript?: RoomTranscriptLine[]
}) {
  const latest = transcript[transcript.length - 1]
  const latestSpeaker = latest ? speakers.find((speaker) => speaker.id === latest.speakerId) : null

  return (
    <Collapsible className={cn(styles.transcriptTray, className)} onOpenChange={onOpenChange} open={open}>
      <div className={styles.transcriptTrayHeader}>
        <CollapsibleTrigger
          render={
            <Button className="min-w-0 flex-1 justify-start gap-2 px-1.5 text-left" variant="ghost" />
          }
        >
          <span className={cn(styles.liveDot, open && styles.liveDotActive)} />
          <span className="truncate text-xs font-semibold">Live transcription</span>
          <Badge className="shrink-0" variant="secondary">{transcript.length} segments</Badge>
          {latest ? <span className="ml-auto text-[11px] text-muted-foreground">{latestSpeaker?.name || "Unassigned"} · {latest.timestamp}</span> : null}
          {open ? <ChevronDown data-icon="inline-end" /> : <ChevronUp data-icon="inline-end" />}
        </CollapsibleTrigger>
        {!open ? (
          <Button aria-label="Expand live transcription" className="shrink-0" onClick={() => onOpenChange(true)} size="icon-sm" variant="ghost">
            <ChevronUp data-icon="inline-start" />
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className={styles.transcriptTrayBody}>
          {transcript.map((line) => {
            const speaker = speakers.find((item) => item.id === line.speakerId)
            return (
              <div className={styles.transcriptLine} key={line.id}>
                <span className="w-10 shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">{line.timestamp}</span>
                <Avatar className="mt-0.5" size="sm">
                  <AvatarFallback style={{ background: speaker?.accent, color: "var(--background)" } as CSSProperties}>{speaker?.initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-semibold">{speaker?.name}</span>
                    <Badge variant="outline">{speaker?.source}</Badge>
                    {line.provisional ? <Badge variant="secondary">Listening</Badge> : null}
                  </div>
                  <p className={cn("mt-1 text-sm leading-relaxed", line.provisional && "text-muted-foreground italic")}>{line.text}</p>
                </div>
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SpeakerDetailDialog({
  speaker,
  open,
  onOpenChange,
  onSave,
}: {
  speaker: RoomSpeaker | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (speakerId: string, name: string) => void
}) {
  if (!speaker) {
    return null
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Avatar size="sm">
              <AvatarFallback style={{ background: speaker.accent, color: "var(--background)" } as CSSProperties}>{speaker.initials}</AvatarFallback>
            </Avatar>
            Speaker details
          </DialogTitle>
          <DialogDescription>Review the anonymous speaker match, rename it, or trace it back to the capture source.</DialogDescription>
        </DialogHeader>

        <SpeakerForm onOpenChange={onOpenChange} onSave={onSave} speaker={speaker}>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/50 p-3">
            <DetailStat label="Role" value={speaker.role} />
            <DetailStat label="Last spoke" value={speaker.lastSpoke} />
            <DetailStat label="Confidence" value={speaker.confidence} />
            <DetailStat label="Words" value={String(speaker.words)} />
          </div>

          <Separator />
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
              <Mic2 data-icon="inline-start" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold">{speaker.source}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{speaker.device} · {speaker.location}</p>
              <div className="mt-2 flex items-center gap-2">
                <SignalBars accent={speaker.accent} value={speaker.signal} />
                <span className="text-[11px] text-muted-foreground">{speaker.signal}% signal</span>
              </div>
            </div>
          </div>
        </SpeakerForm>
      </DialogContent>
    </Dialog>
  )
}

function SpeakerForm({
  speaker,
  onOpenChange,
  onSave,
  children,
}: {
  speaker: RoomSpeaker
  onOpenChange: (open: boolean) => void
  onSave: (speakerId: string, name: string) => void
  children: ReactNode
}) {
  const [name, setName] = useState(speaker.name)

  return (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="speaker-name">Speaker name</FieldLabel>
          <Input id="speaker-name" onChange={(event) => setName(event.target.value)} value={name} />
          <FieldDescription>This name is shown across the live transcript for this room.</FieldDescription>
        </Field>
      </FieldGroup>
      {children}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} variant="outline">Cancel</Button>
        <Button onClick={() => { onSave(speaker.id, name); onOpenChange(false) }}>
          <Pencil data-icon="inline-start" />
          Save speaker
        </Button>
      </DialogFooter>
    </>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs font-medium">{value}</p>
    </div>
  )
}

export function ShareRoomDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState(false)
  const roomCode = "N7P4-K2Q9"

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(roomCode)
    } catch {
      // The prototype remains useful in browsers that block clipboard access.
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }, [])

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Share2 /> Share this room</DialogTitle>
          <DialogDescription>Invite another laptop or room microphone. They can join with the short code after you approve the device.</DialogDescription>
        </DialogHeader>
        <div className="rounded-2xl border border-border bg-muted/40 p-4 text-center">
          <p className="text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">Room code</p>
          <p className="mt-2 font-mono text-2xl font-semibold tracking-[0.24em]">{roomCode}</p>
          <Button className="mt-4" onClick={copyCode} variant="outline">
            <Copy data-icon="inline-start" />
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
        <div className="flex items-start gap-2 rounded-xl bg-secondary/70 p-3 text-xs text-secondary-foreground">
          <Users className="mt-0.5 shrink-0" />
          <p>2 devices are connected. New capture devices stay muted until approved.</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function SessionHeader({
  isLive,
  onLiveToggle,
  onShare,
  variantLabel,
}: {
  isLive: boolean
  onLiveToggle: () => void
  onShare: () => void
  variantLabel: string
}) {
  return (
    <header className={styles.sessionHeader}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Live transcription</span>
          <span>/</span>
          <span className="truncate">Product direction · room 04</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="truncate text-base font-semibold tracking-tight">Product direction</h1>
          <Badge variant="outline">{variantLabel}</Badge>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge className="hidden sm:inline-flex" variant="secondary"><Clock3 data-icon="inline-start" /> 01:08</Badge>
        <Badge className="hidden sm:inline-flex" variant={isLive ? "default" : "secondary"}>
          <span className={cn("size-1.5 rounded-full", isLive ? "bg-primary-foreground" : "bg-muted-foreground/50")} />
          {isLive ? "Live" : "Paused"}
        </Badge>
        <Button aria-label={isLive ? "Pause listening" : "Resume listening"} onClick={onLiveToggle} size="sm" variant="outline">
          {isLive ? <X data-icon="inline-start" /> : <AudioLines data-icon="inline-start" />}
          <span className="hidden sm:inline">{isLive ? "Pause" : "Resume"}</span>
        </Button>
        <Button aria-label="Share transcription room" onClick={onShare} size="sm" variant="outline">
          <Share2 data-icon="inline-start" />
          <span className="hidden sm:inline">Share</span>
        </Button>
      </div>
    </header>
  )
}

export function SourceSummary({
  speakers,
  activeSourceId,
  onSourceChange,
}: {
  speakers: RoomSpeaker[]
  activeSourceId: string
  onSourceChange: (sourceId: string) => void
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="gap-1 px-4 py-4">
        <CardTitle className="flex items-center gap-2 text-sm"><Mic2 /> Capture sources</CardTitle>
        <CardDescription className="text-[11px]">Each microphone stays source-separated.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-3 pb-3">
        {roomSources.map((source) => {
          const speaker = speakers.find((item) => item.sourceId === source.id)
          const active = activeSourceId === source.id
          return (
            <Button
              aria-pressed={active}
              className={cn("h-auto justify-start gap-2 rounded-xl px-2 py-2 text-left", active && "bg-muted")}
              key={source.id}
              onClick={() => onSourceChange(source.id)}
              variant="ghost"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><Mic2 data-icon="inline-start" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{source.label}</span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{speaker?.device}</span>
              </span>
              <SignalBars accent={speaker?.accent} value={speaker?.signal ?? 0} />
            </Button>
          )
        })}
      </CardContent>
    </Card>
  )
}

export function SpeakerList({
  speakers,
  selectedSpeakerId,
  onSpeakerSelect,
}: {
  speakers: RoomSpeaker[]
  selectedSpeakerId: string | null
  onSpeakerSelect: (speakerId: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      {speakers.map((speaker) => (
        <Button
          aria-pressed={selectedSpeakerId === speaker.id}
          className={cn("h-auto justify-start gap-2 rounded-xl px-2 py-2 text-left", selectedSpeakerId === speaker.id && "bg-muted")}
          key={speaker.id}
          onClick={() => onSpeakerSelect(speaker.id)}
          variant="ghost"
        >
          <Avatar size="sm">
            <AvatarFallback style={{ background: speaker.accent, color: "var(--background)" } as CSSProperties}>{speaker.initials}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium">{speaker.name}</span>
              {speaker.status === "speaking" ? <Badge>Speaking</Badge> : null}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{speaker.source} · {speaker.confidence}</span>
          </span>
          <SignalBars accent={speaker.accent} value={speaker.signal} />
        </Button>
      ))}
    </div>
  )
}
