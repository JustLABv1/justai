"use client"

import { Mic2, Network, Radio } from "lucide-react"
import { useState, type CSSProperties } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

import {
  ListenCore,
  PrototypeSidebar,
  SessionHeader,
  ShareRoomDialog,
  SourceStrip,
  SpeakerDetailDialog,
  SpeakerNode,
  TranscriptTray,
  useTranscriptionRoom,
} from "./prototype-data"
import styles from "./prototype.module.css"

const nodePositions = [
  { top: "27%", left: "24%", line: styles.constellationLineMaya, source: styles.constellationSourceMaya },
  { top: "27%", left: "76%", line: styles.constellationLineLeon, source: styles.constellationSourceLeon },
  { top: "73%", left: "76%", line: styles.constellationLinePriya, source: styles.constellationSourcePriya },
  { top: "73%", left: "24%", line: styles.constellationLineJustin, source: styles.constellationSourceJustin },
]

export function ConstellationVariant() {
  const room = useTranscriptionRoom()
  const [activeView, setActiveView] = useState("transcription")
  const [shareOpen, setShareOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  const openDetails = (speakerId: string) => {
    room.setSelectedSpeakerId(speakerId)
    setDetailOpen(true)
  }

  return (
    <main className={`${styles.variant} ${styles.entrance}`}>
      <div className={styles.appShell}>
        <PrototypeSidebar activeView={activeView} onViewChange={setActiveView} />
        <section className={styles.mainPanel}>
          <SessionHeader
            isLive={room.isLive}
            onLiveToggle={() => room.setIsLive((current) => !current)}
            onShare={() => setShareOpen(true)}
            variantLabel="Constellation"
          />

          <div className={styles.constellationContent}>
            <div className="flex shrink-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold">Room constellation</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">People, sources, and the current signal all share the same map.</p>
              </div>
              <Badge className="shrink-0" variant="secondary"><Network data-icon="inline-start" /> 4 participants · 4 sources</Badge>
            </div>

            <section aria-label="Room constellation" className={styles.constellationStage}>
              {room.speakers.map((speaker, index) => {
                const position = nodePositions[index]
                return (
                  <span className={`${styles.constellationLine} ${position.line}`} key={`${speaker.id}-line`} />
                )
              })}

              {room.speakers.map((speaker, index) => {
                const position = nodePositions[index]
                return (
                  <SpeakerNode
                    active={speaker.id === room.activeSpeakerId}
                    angle={0}
                    className={styles.constellationNode}
                    key={speaker.id}
                    onClick={() => openDetails(speaker.id)}
                    speaker={speaker}
                    style={{ "--node-top": position.top, "--node-left": position.left } as CSSProperties}
                  />
                )
              })}

              <ListenCore activeSpeaker={room.activeSpeaker} isLive={room.isLive} />

              {room.speakers.map((speaker, index) => {
                const position = nodePositions[index]
                const active = room.activeSourceId === speaker.sourceId
                return (
                  <Button
                    aria-pressed={active}
                    className={`${styles.constellationSourceCard} ${position.source} ${active ? "border-primary/40 bg-primary/5" : ""}`}
                    key={`${speaker.id}-source`}
                    onClick={() => room.selectSource(speaker.sourceId)}
                    style={{ "--speaker-accent": speaker.accent } as CSSProperties}
                    variant="ghost"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Mic2 data-icon="inline-start" /></span>
                    <span className="min-w-0 text-left">
                      <span className="block truncate text-[11px] font-semibold">{speaker.source}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{speaker.signal}% signal · {speaker.device}</span>
                    </span>
                  </Button>
                )
              })}

              <div className={styles.constellationLegend}><span /> Dominant source: {room.activeSpeaker?.source || "none"}</div>
              <div className="absolute top-5 right-5 z-[3] flex items-center gap-2">
                <Badge variant={room.isLive ? "default" : "secondary"}><Radio data-icon="inline-start" /> {room.isLive ? "Listening now" : "Paused"}</Badge>
              </div>
            </section>

            <SourceStrip activeSourceId={room.activeSourceId} onSourceChange={room.selectSource} speakers={room.speakers} />
            <TranscriptTray onOpenChange={room.setTranscriptOpen} open={room.transcriptOpen} speakers={room.speakers} />
          </div>
        </section>
      </div>

      <SpeakerDetailDialog
        onOpenChange={(open) => { setDetailOpen(open); if (!open) room.setSelectedSpeakerId(null) }}
        onSave={room.renameSpeaker}
        open={detailOpen}
        speaker={room.selectedSpeaker}
      />
      <ShareRoomDialog onOpenChange={setShareOpen} open={shareOpen} />
    </main>
  )
}
