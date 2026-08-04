"use client"

import { Activity, Gauge, Pencil, ShieldCheck } from "lucide-react"
import { useState, type CSSProperties } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

import {
  ListenCore,
  PrototypeSidebar,
  SessionHeader,
  ShareRoomDialog,
  SourceSummary,
  SpeakerDetailDialog,
  SpeakerList,
  SpeakerNode,
  TranscriptTray,
  useTranscriptionRoom,
} from "./prototype-data"
import styles from "./prototype.module.css"

const speakerAngles = [0, 90, 180, 270]

export function ControlRoomVariant() {
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
            variantLabel="Control room"
          />

          <div className={styles.controlContent}>
            <div className="flex shrink-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold">Signal monitor</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">A compact view for operators who need sources and confidence at a glance.</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline"><ShieldCheck data-icon="inline-start" /> Provider healthy</Badge>
                <Badge className="hidden sm:inline-flex" variant="secondary"><Activity data-icon="inline-start" /> 48 kHz PCM</Badge>
              </div>
            </div>

            <div className={styles.controlGrid}>
              <section aria-label="Signal radar" className={styles.radarStage} data-live={room.isLive ? "true" : "false"}>
                <div className={styles.radarLabel}>
                  <p className="text-xs font-semibold">Room radar</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">Dominant signal is highlighted</p>
                </div>
                <div aria-hidden="true" className={styles.orbitTrack} />
                <div aria-hidden="true" className={styles.radarSweep} />
                {room.speakers.map((speaker, index) => (
                  <SpeakerNode
                    active={speaker.id === room.activeSpeakerId}
                    angle={speakerAngles[index]}
                    key={speaker.id}
                    onClick={() => openDetails(speaker.id)}
                    speaker={speaker}
                  />
                ))}
                <ListenCore activeSpeaker={room.activeSpeaker} compact isLive={room.isLive} />
                <div className={styles.radarStatus}>
                  <span className={room.isLive ? "size-1.5 rounded-full bg-primary" : "size-1.5 rounded-full bg-muted-foreground/50"} />
                  {room.isLive ? `${room.activeSpeaker?.source || "Waiting"} is dominant` : "Capture paused"}
                </div>
              </section>

              <aside className={styles.monitorPanel}>
                <SourceSummary activeSourceId={room.activeSourceId} onSourceChange={room.selectSource} speakers={room.speakers} />
                <section className={styles.monitorSpeakerSection}>
                  <div className={styles.monitorSpeakerSectionHeader}>
                    <div>
                      <p className="text-sm font-semibold">Speaker labels</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">Anonymous until you name them.</p>
                    </div>
                    <Badge variant="secondary">{room.speakers.length} detected</Badge>
                  </div>
                  <SpeakerList onSpeakerSelect={room.setSelectedSpeakerId} selectedSpeakerId={room.selectedSpeakerId} speakers={room.speakers} />
                  {room.selectedSpeaker ? (
                    <Card
                      className={styles.selectedSpeakerCard}
                      style={{ "--speaker-accent": room.selectedSpeaker.accent } as CSSProperties}
                    >
                      <CardHeader className="gap-1 px-3 py-3">
                        <CardTitle className="text-xs">{room.selectedSpeaker.name}</CardTitle>
                        <CardDescription className="text-[10px]">{room.selectedSpeaker.source} · {room.selectedSpeaker.location}</CardDescription>
                      </CardHeader>
                      <CardContent className="px-3 pb-3">
                        <Button className="w-full" onClick={() => setDetailOpen(true)} size="sm" variant="outline"><Pencil data-icon="inline-start" /> Rename or inspect</Button>
                      </CardContent>
                    </Card>
                  ) : null}
                </section>
                <Card className="shadow-none">
                  <CardHeader className="gap-1 px-4 py-4">
                    <CardTitle className="flex items-center gap-2 text-sm"><Gauge /> Session health</CardTitle>
                    <CardDescription className="text-[11px]">Live pipeline diagnostics.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-2 px-4 pb-4">
                    <HealthMetric label="Latency" value="184 ms" />
                    <HealthMetric label="Confidence" value="94%" />
                  </CardContent>
                </Card>
              </aside>
            </div>

            <TranscriptTray className={styles.monitorTranscript} onOpenChange={room.setTranscriptOpen} open={room.transcriptOpen} speakers={room.speakers} />
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

function HealthMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/55 p-3">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  )
}
