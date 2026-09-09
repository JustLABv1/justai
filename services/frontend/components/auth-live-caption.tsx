import {
  ArrowUpRight,
  Bot,
  Check,
  CircleCheck,
  FileText,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react"

import { BrandMark } from "@/components/brand-mark"

import styles from "./auth-live-caption.module.css"

export function AuthLiveCaption() {
  return (
    <section aria-label="JustAI workspace preview" className={styles.showcase}>
      <div aria-hidden="true" className={styles.ambientOrb} />
      <div aria-hidden="true" className={styles.ambientOrbSecondary} />

      <header className={styles.topbar}>
        <div className={styles.wordmark}>
          <BrandMark className={styles.logoMark} />
          <span>JustAI</span>
        </div>
        <span className={styles.status}>
          <span /> Workspace online
        </span>
      </header>

      <div className={styles.content}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>
            <Sparkles aria-hidden="true" /> One intelligent workspace
          </p>
          <h1 className={styles.headline}>
            Turn conversation
            <br />
            into <span>momentum.</span>
          </h1>
          <p className={styles.lead}>
            Chat with your knowledge, coordinate agents, and move work forward
            without losing the context that matters.
          </p>
        </div>

        <div aria-hidden="true" className={styles.scene}>
          <div className={`${styles.card} ${styles.chatCard}`}>
            <div className={styles.cardHeader}>
              <span className={styles.cardIdentity}>
                <span className={styles.iconTile}>
                  <Sparkles />
                </span>
                JustAI
              </span>
              <span className={styles.livePill}>Live</span>
            </div>
            <div className={styles.messages}>
              <div className={`${styles.message} ${styles.userMessage}`}>
                Summarize today&apos;s customer calls and flag follow-ups.
              </div>
              <div className={`${styles.message} ${styles.agentMessage}`}>
                <span className={styles.typingLine} />
                <span className={styles.typingLineShort} />
              </div>
              <div className={styles.resultRow}>
                <CircleCheck /> 6 follow-ups found <ArrowUpRight />
              </div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.agentCard}`}>
            <div className={styles.cardHeader}>
              <span className={styles.cardIdentity}>
                <span className={`${styles.iconTile} ${styles.agentIcon}`}>
                  <Bot />
                </span>
                Research agent
              </span>
              <span className={styles.agentPulse} />
            </div>
            <div className={styles.agentSteps}>
              <div className={styles.agentStep}>
                <span>
                  <Search />
                </span>
                <div>
                  <strong>Search workspace</strong>
                  <small>28 sources</small>
                </div>
                <Check />
              </div>
              <div className={styles.agentStep}>
                <span>
                  <FileText />
                </span>
                <div>
                  <strong>Build brief</strong>
                  <small>Generating</small>
                </div>
                <span className={styles.miniLoader} />
              </div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.actionCard}`}>
            <span className={styles.actionIcon}>
              <WandSparkles />
            </span>
            <div>
              <strong>Brief ready</strong>
              <small>Shared with Product team</small>
            </div>
            <CircleCheck />
          </div>
          <div className={styles.connectionLine} />
          <div className={styles.connectionDot} />
        </div>

        <div className={styles.trustRow}>
          <span>
            <Check aria-hidden="true" /> Private by design
          </span>
          <span>
            <Check aria-hidden="true" /> Your tools, connected
          </span>
          <span>
            <Check aria-hidden="true" /> Context that compounds
          </span>
        </div>
      </div>
    </section>
  )
}
