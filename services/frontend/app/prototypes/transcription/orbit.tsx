"use client"

import { AudioLines, CircleDot, Radio, Users } from "lucide-react"
import { useState, type CSSProperties } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

import {
  ListenCore,
  PrototypeSidebar,
  SessionHeader,
  ShareRoomDialog,
  SignalBars,
  SourceSummary,
  SpeakerDetailDialog,
  SpeakerNode,
  TranscriptTray,
  useTranscriptionRoom,
} from "./prototype-data"
import styles from "./prototype.module.css"

const speakerAngles = [0, 90, 180, 270]

export function OrbitVariant() {
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
            variantLabel="Orbit"
          />

          <div className={styles.orbitContent}>
            <div className={styles.orbitWorkspace}>
              <section aria-label="Speaker orbit" className={styles.orbitCanvas}>
                <div className={styles.orbitHint}>
                  <Badge variant="secondary"><CircleDot data-icon="inline-start" /> Room view</Badge>
                  <span className={styles.orbitHintText}>Click a speaker to inspect the source</span>
                </div>
                <div aria-hidden="true" className={styles.orbitTrack} />
                {room.speakers.map((speaker, index) => (
                  <SpeakerNode
                    active={speaker.id === room.activeSpeakerId}
                    angle={speakerAngles[index]}
                    key={speaker.id}
                    onClick={() => openDetails(speaker.id)}
                    speaker={speaker}
                  />
                ))}
                <ListenCore activeSpeaker={room.activeSpeaker} isLive={room.isLive} />
                <div className="absolute bottom-5 left-1/2 z-[2] -translate-x-1/2 text-center">
                  <p className="text-xs font-medium">Four sources in the room</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">English · automatic speaker labels</p>
                </div>
              </section>

              <aside className={styles.orbitInspector}>
                {room.selectedSpeaker ? (
                  <Card
                    className={styles.selectedSpeakerCard}
                    style={{ "--speaker-accent": room.selectedSpeaker.accent } as CSSProperties}
                  >
                    <CardHeader className="gap-2 px-4 py-4">
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-sm">Selected speaker</CardTitle>
                        <Badge variant={room.selectedSpeaker.status === "speaking" ? "default" : "secondary"}>
                          {room.selectedSpeaker.status === "speaking" ? "Speaking" : "In room"}
                        </Badge>
                      </div>
                      <CardDescription className="text-[11px]">The selected circle follows this source.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3 px-4 pb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--speaker-accent)_24%,var(--muted))] text-sm font-semibold" style={{ color: room.selectedSpeaker.accent }}>
                          {room.selectedSpeaker.initials}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{room.selectedSpeaker.name}</p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{room.selectedSpeaker.role} · {room.selectedSpeaker.source}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/55 px-3 py-2">
                        <span className="text-[11px] text-muted-foreground">Signal quality</span>
                        <span className="flex items-center gap-2 text-xs font-medium"><SignalBars accent={room.selectedSpeaker.accent} value={room.selectedSpeaker.signal} /> {room.selectedSpeaker.signal}%</span>
                      </div>
                      <Button onClick={() => setDetailOpen(true)} size="sm" variant="outline">Edit speaker details</Button>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="shadow-none">
                    <CardContent className="flex min-h-44 flex-col items-center justify-center px-5 text-center">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Users data-icon="inline-start" /></div>
                      <p className="mt-3 text-sm font-semibold">Choose a speaker</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Select any circle to see its source, signal, and anonymous label.</p>
                    </CardContent>
                  </Card>
                )}

                <SourceSummary activeSourceId={room.activeSourceId} onSourceChange={room.selectSource} speakers={room.speakers} />

                <Card className="shadow-none">
                  <CardHeader className="gap-1 px-4 py-4">
                    <CardTitle className="flex items-center gap-2 text-sm"><AudioLines /> Listening state</CardTitle>
                    <CardDescription className="text-[11px]">The core reacts to the dominant microphone.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center gap-3 px-4 pb-4">
                    <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Radio data-icon="inline-start" /></div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{room.activeSpeaker?.source || "Waiting for audio"}</p>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{room.isLive ? "Live PCM stream connected" : "Stream paused by host"}</p>
                    </div>
                  </CardContent>
                </Card>
              </aside>
            </div>

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
