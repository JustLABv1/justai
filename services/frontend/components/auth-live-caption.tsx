import {
  AudioLines,
  Check,
  FileText,
  Mic2,
  Radio,
  Sparkles,
} from "lucide-react"

import { BrandMark } from "@/components/brand-mark"

import styles from "./auth-live-caption.module.css"

const waveformHeights = [
  34, 54, 28, 70, 48, 82, 38, 62, 30, 76, 44, 58, 35, 66, 42, 88, 40, 61, 32,
  73, 49, 58, 36, 68,
]

export function AuthLiveCaption() {
  return (
    <section
      aria-label="JustAI live transcription preview"
      className={styles.captionPreview}
    >
      <header className={styles.captionTopbar}>
        <div className={styles.captionWordmark}>
          <BrandMark className={styles.captionLogoMark} />
          <span>JustAI / Capture</span>
        </div>
        <span className={styles.captionSession}>Session 04 / Internal</span>
      </header>

      <div className={styles.captionContent}>
        <div className={styles.captionEyebrow}>
          <span className={styles.captionEyebrowRule} />
          Live transcription
        </div>
        <h1 className={styles.captionHeadline}>
          Every voice, <span>in focus.</span>
        </h1>
        <p className={styles.captionLead}>
          Capture the room, find the signal, and leave every meeting with the
          important parts already in motion.
        </p>

        <div className={styles.captionConsole}>
          <div className={styles.captionConsoleHeader}>
            <div className={styles.captionLiveLabel}>
              <Radio aria-hidden="true" />
              <span>LIVE CAPTURE</span>
            </div>
            <span className={styles.captionTimer}>00:18:42</span>
          </div>

          <div className={styles.captionWaveform} aria-label="Audio waveform">
            {waveformHeights.map((height, index) => (
              <span
                key={index}
                style={{
                  height: `${height}%`,
                  animationDelay: `${index * 55}ms`,
                }}
              />
            ))}
          </div>

          <div className={styles.captionTranscript}>
            <div className={styles.captionLine}>
              <span className={styles.captionTime}>18:41</span>
              <div>
                <strong>Maya Chen</strong>
                <p>
                  We need a clearer handoff between the{" "}
                  <span className={styles.captionWordActive}>conversation</span>{" "}
                  and the work that follows.
                </p>
              </div>
            </div>
            <div className={styles.captionLine}>
              <span className={styles.captionTime}>18:42</span>
              <div>
                <strong className={styles.captionSpeakerAi}>
                  <Sparkles aria-hidden="true" />
                  JustAI
                </strong>
                <p>
                  I can turn that into a shared brief with{" "}
                  <span className={styles.captionWordActive}>owners</span>,{" "}
                  <span className={styles.captionWordActive}>next steps</span>,
                  and a follow-up list.
                </p>
              </div>
            </div>
          </div>

          <div className={styles.captionConsoleFooter}>
            <span>
              <Mic2 aria-hidden="true" />3 speakers detected
            </span>
            <span>
              <AudioLines aria-hidden="true" />
              96% clarity
            </span>
          </div>
        </div>

        <div className={styles.captionTrustRow}>
          <span>
            <Check aria-hidden="true" />
            Searchable transcripts
          </span>
          <span>
            <FileText aria-hidden="true" />
            Automatic briefs
          </span>
        </div>
      </div>
    </section>
  )
}
