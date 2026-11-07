"use client"

import { useTranslations } from "@/components/locale-provider"
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Mic2,
  Pencil,
  Search,
} from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
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
} from "@/components/panelui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/panelui/input"
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
  startOffsetMs: number
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
      aria-label={`${safeValue}% audio level`}
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
  const { t } = useTranslations()

  return (
    <div
      aria-label={isLive ? t("JustAI is listening") : t("Transcription paused")}
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
          {isLive ? t("Listening") : t("Paused")}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {isLive
            ? activeSpeaker
              ? t("{value0} is speaking", { value0: activeSpeaker.name })
              : t("Waiting for audio")
            : t("Capture paused")}
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
  label = "Live transcription",
  segmentCount = transcript.filter((line) => !line.provisional).length,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  speakers: RoomSpeaker[]
  className?: string
  segmentCount?: number
  transcript?: RoomTranscriptLine[]
  label?: string
}) {
  const { t } = useTranslations()

  const [search, setSearch] = useState("")
  const latest = transcript[transcript.length - 1]
  const latestSpeaker = latest
    ? speakers.find((speaker) => speaker.id === latest.speakerId)
    : null
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredTranscript = normalizedSearch
    ? transcript.filter((line) => {
        const speaker = speakers.find((item) => item.id === line.speakerId)
        return [line.text, line.timestamp, speaker?.name || ""].some((value) =>
          value.toLocaleLowerCase().includes(normalizedSearch)
        )
      })
    : transcript
  const messageCount = filteredTranscript.filter(
    (line) => !line.provisional
  ).length

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
                  ? t("Collapse {value0}", {
                      value0: label.toLocaleLowerCase(),
                    })
                  : t("Expand {value0}", { value0: label.toLocaleLowerCase() })
              }
              className="min-w-0 flex-1 justify-start gap-2 px-1.5 text-left"
              variant="ghost"
            />
          }
        >
          <span className={cn(styles.liveDot, open && styles.liveDotActive)} />
          <span className="truncate text-xs font-semibold">{t(label)}</span>
          <Badge className="shrink-0" variant="secondary">
            {segmentCount} {t("segments")}
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
          <div className="relative px-1 pb-2">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={t("Search {value0}", {
                value0: label.toLocaleLowerCase(),
              })}
              className="h-8 pl-8 text-xs"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search transcript")}
              value={search}
            />
          </div>
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <TranscriptScroller
              emptyMessage={
                normalizedSearch
                  ? "No matching transcript segments."
                  : undefined
              }
              speakers={speakers}
              transcript={filteredTranscript}
            />
          </MessageScrollerProvider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function TranscriptScroller({
  speakers,
  transcript,
  emptyMessage,
}: {
  speakers: RoomSpeaker[]
  transcript: RoomTranscriptLine[]
  emptyMessage?: string
}) {
  const { t } = useTranslations()

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
        aria-label={t("Live transcription")}
        onScroll={handleScroll}
        ref={viewportRef}
      >
        <MessageScrollerContent className="gap-1">
          {transcript.length === 0 && emptyMessage ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </p>
          ) : null}
          {transcript.map((line) => {
            const speaker = speakers.find((item) => item.id === line.speakerId)
            return (
              <MessageScrollerItem
                className="w-full"
                key={line.id}
                messageId={line.id}
              >
                <div className={styles.transcriptLine}>
                  <time
                    className="w-14 shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground"
                    dateTime={`PT${Math.max(0, Math.floor(line.startOffsetMs / 1000))}S`}
                  >
                    {line.timestamp}
                  </time>
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
                        <Badge variant="secondary">{t("Listening")}</Badge>
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
        aria-label={t("Scroll to latest transcript")}
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
  const { t } = useTranslations()

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
            {t("Speaker details")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Review the speaker match, rename it, or trace it back to the capture source."
            )}
          </DialogDescription>
        </DialogHeader>

        <SpeakerForm
          onOpenChange={onOpenChange}
          onSave={onSave}
          speaker={speaker}
        >
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/50 p-3">
            <DetailStat label={t("Role")} value={speaker.role} />
            <DetailStat label={t("Last spoke")} value={speaker.lastSpoke} />
            <DetailStat label={t("Confidence")} value={speaker.confidence} />
            <DetailStat label={t("Words")} value={String(speaker.words)} />
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
                  {speaker.signal}
                  {t("% audio level")}
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
  const { t } = useTranslations()

  const [name, setName] = useState(speaker.name)

  return (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="speaker-name">{t("Speaker name")}</FieldLabel>
          <Input
            id="speaker-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <FieldDescription>
            {t("This name is shown across the live transcript for this room.")}
          </FieldDescription>
        </Field>
      </FieldGroup>
      {children}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} variant="outline">
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => {
            onSave(speaker.id, name)
            onOpenChange(false)
          }}
        >
          <Pencil data-icon="inline-start" />
          {t("Save speaker")}
        </Button>
      </DialogFooter>
    </>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  const { t } = useTranslations()
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{t(label)}</p>
      <p className="mt-0.5 text-xs font-medium">{value}</p>
    </div>
  )
}
