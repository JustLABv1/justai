"use client"

import { AudioLines, ChevronDown, ChevronUp, Mic2, Pencil } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import styles from "./live-transcription.module.css"

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

export function SignalBars({
  value,
  accent,
}: {
  value: number
  accent?: string
}) {
  const safeValue = Math.max(0, Math.min(100, value))
  const activeBars = Math.max(1, Math.ceil(safeValue / 20))

  return (
    <div
      aria-label={`${safeValue}% signal`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={safeValue}
      className={styles.signalBars}
      role="meter"
      style={
        { "--speaker-accent": accent || "var(--primary)" } as CSSProperties
      }
    >
      {Array.from({ length: 5 }, (_, index) => (
        <span
          className={cn(index < activeBars && styles.signalBarActive)}
          key={index}
        />
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
      className={cn(
        styles.listenCore,
        compact && styles.listenCoreCompact,
        isLive ? styles.listenCoreLive : styles.listenCorePaused
      )}
      style={
        {
          "--speaker-accent": activeSpeaker?.accent || "var(--primary)",
        } as CSSProperties
      }
    >
      <span aria-hidden="true" className={styles.coreWave} />
      <span aria-hidden="true" className={styles.coreWave} />
      <span aria-hidden="true" className={styles.coreWave} />
      <div className={styles.coreSurface}>
        <div className={styles.coreGlyph}>
          <AudioLines data-icon="inline-start" />
        </div>
        <span className="text-[11px] font-semibold tracking-[0.16em] uppercase">
          {isLive ? "Listening" : "Paused"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {isLive
            ? activeSpeaker
              ? `${activeSpeaker.name} is speaking`
              : "Waiting for audio"
            : "Capture paused"}
        </span>
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
      className={cn(
        styles.speakerNode,
        active && styles.speakerNodeActive,
        className
      )}
      onClick={onClick}
      style={
        {
          "--speaker-accent": speaker.accent,
          "--speaker-angle": `${angle}deg`,
          ...style,
        } as CSSProperties
      }
      variant="ghost"
    >
      <span className={styles.speakerNodeHalo} />
      <Avatar className={styles.speakerAvatar} size="lg">
        <AvatarFallback>{speaker.initials}</AvatarFallback>
      </Avatar>
      <span className={styles.speakerNodeLabel}>
        <span className="block max-w-32 truncate text-xs font-semibold">
          {speaker.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              speaker.status === "speaking"
                ? "bg-primary"
                : "bg-muted-foreground/40"
            )}
          />
          {speaker.status === "speaking" ? "speaking" : speaker.source}
        </span>
      </span>
    </Button>
  )
}

export function TranscriptTray({
  open,
  onOpenChange,
  speakers,
  className,
  transcript = [],
  segmentCount = transcript.filter((line) => !line.provisional).length,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  speakers: RoomSpeaker[]
  className?: string
  segmentCount?: number
  transcript?: RoomTranscriptLine[]
}) {
  const latest = transcript[transcript.length - 1]
  const latestSpeaker = latest
    ? speakers.find((speaker) => speaker.id === latest.speakerId)
    : null
  const messageCount = transcript.filter((line) => !line.provisional).length

  return (
    <Collapsible
      className={cn(styles.transcriptTray, className)}
      onOpenChange={onOpenChange}
      open={open}
    >
      <div className={styles.transcriptTrayHeader}>
        <CollapsibleTrigger
          render={
            <Button
              aria-label={
                open
                  ? "Collapse live transcription"
                  : "Expand live transcription"
              }
              className="min-w-0 flex-1 justify-start gap-2 px-1.5 text-left"
              variant="ghost"
            />
          }
        >
          <span className={cn(styles.liveDot, open && styles.liveDotActive)} />
          <span className="truncate text-xs font-semibold">
            Live transcription
          </span>
          <Badge className="shrink-0" variant="secondary">
            {segmentCount} segments
          </Badge>
          {messageCount > 0 && messageCount !== segmentCount ? (
            <Badge className="shrink-0" variant="outline">
              {messageCount} messages
            </Badge>
          ) : null}
          {latest ? (
            <span className="ml-auto max-w-[45%] min-w-0 truncate text-[11px] text-muted-foreground">
              {latestSpeaker?.name || "Unassigned"} · {latest.timestamp}
            </span>
          ) : null}
          {open ? (
            <ChevronDown data-icon="inline-end" />
          ) : (
            <ChevronUp data-icon="inline-end" />
          )}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className={styles.transcriptTrayBody}>
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <TranscriptScroller speakers={speakers} transcript={transcript} />
          </MessageScrollerProvider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function TranscriptScroller({
  speakers,
  transcript,
}: {
  speakers: RoomSpeaker[]
  transcript: RoomTranscriptLine[]
}) {
  const { scrollToEnd } = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)

  useEffect(() => {
    if (!followLatestRef.current) return
    const frame = window.requestAnimationFrame(() => {
      scrollToEnd({ behavior: "auto" })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [scrollToEnd, transcript])

  const handleScroll = () => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distanceFromEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    followLatestRef.current = distanceFromEnd <= 32
  }

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        aria-label="Live transcription"
        onScroll={handleScroll}
        ref={viewportRef}
      >
        <MessageScrollerContent className="gap-1">
          {transcript.map((line) => {
            const speaker = speakers.find((item) => item.id === line.speakerId)
            return (
              <MessageScrollerItem
                className="w-full"
                key={line.id}
                messageId={line.id}
              >
                <div className={styles.transcriptLine}>
                  <span className="w-10 shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">
                    {line.timestamp}
                  </span>
                  <Avatar className="mt-0.5" size="sm">
                    <AvatarFallback
                      style={
                        {
                          background: speaker?.accent,
                          color: "var(--background)",
                        } as CSSProperties
                      }
                    >
                      {speaker?.initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-semibold">
                        {speaker?.name || "Unassigned"}
                      </span>
                      {speaker?.source ? (
                        <Badge
                          className="max-w-full truncate"
                          variant="outline"
                        >
                          {speaker.source}
                        </Badge>
                      ) : null}
                      {line.provisional ? (
                        <Badge variant="secondary">Listening</Badge>
                      ) : null}
                    </div>
                    <p
                      className={cn(
                        "mt-1 min-w-0 text-sm leading-relaxed",
                        line.provisional && "text-muted-foreground italic"
                      )}
                    >
                      {line.text}
                    </p>
                  </div>
                </div>
              </MessageScrollerItem>
            )
          })}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton
        aria-label="Scroll to latest transcript"
        direction="end"
      />
    </MessageScroller>
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
  if (!speaker) return null

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Avatar size="sm">
              <AvatarFallback
                style={
                  {
                    background: speaker.accent,
                    color: "var(--background)",
                  } as CSSProperties
                }
              >
                {speaker.initials}
              </AvatarFallback>
            </Avatar>
            Speaker details
          </DialogTitle>
          <DialogDescription>
            Review the speaker match, rename it, or trace it back to the capture
            source.
          </DialogDescription>
        </DialogHeader>

        <SpeakerForm
          onOpenChange={onOpenChange}
          onSave={onSave}
          speaker={speaker}
        >
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
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {speaker.device} · {speaker.location}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <SignalBars accent={speaker.accent} value={speaker.signal} />
                <span className="text-[11px] text-muted-foreground">
                  {speaker.signal}% signal
                </span>
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
          <Input
            id="speaker-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <FieldDescription>
            This name is shown across the live transcript for this room.
          </FieldDescription>
        </Field>
      </FieldGroup>
      {children}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} variant="outline">
          Cancel
        </Button>
        <Button
          onClick={() => {
            onSave(speaker.id, name)
            onOpenChange(false)
          }}
        >
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
