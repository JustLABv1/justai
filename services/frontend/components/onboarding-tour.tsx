"use client"

import {
  BellRing,
  Bot,
  FolderSearch,
  Headphones,
  MessageSquare,
  Video,
  type LucideIcon,
} from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useId, useRef, type KeyboardEvent } from "react"

import { useTranslations } from "@/components/locale-provider"
import {
  FeatureSketch,
  type SketchName,
} from "@/components/onboarding-sketches"
import { cn } from "@/lib/utils"

export type TourFeature = {
  id: SketchName
  icon: LucideIcon
  title: string
  short: string
  text: string
  examples: string[]
}

export const tourFeatures: TourFeature[] = [
  {
    id: "chat",
    icon: MessageSquare,
    title: "Chat with AI",
    short: "Ask, write, analyse",
    text: "Ask questions, draft texts and work through documents. JustAI searches the web, reads attachments, creates images, PDFs and files, and runs code for calculations and charts.",
    examples: [
      "Summarise this PDF in five points",
      "Search the web for the latest news on the topic",
      "Turn this table into a chart",
    ],
  },
  {
    id: "live",
    icon: Headphones,
    title: "Live transcription",
    short: "Meetings and livestreams",
    text: "Transcribe meetings, calls and livestreams as they happen, with speakers. For Bundestag debates JustAI follows the agenda, records only the topics you pick and gives each one its own transcript.",
    examples: [
      "Record only the topics on digital policy",
      "Share the transcript with my team while it runs",
      "Summarise each agenda item when it ends",
    ],
  },
  {
    id: "video",
    icon: Video,
    title: "Video transcription",
    short: "Upload and evaluate",
    text: "Upload a recording and get a transcript with speakers, chapters and a summary. Correct names, then export it as a document.",
    examples: [
      "Name the speakers in this interview",
      "Write minutes of this meeting recording",
      "Export the transcript as a Word file",
    ],
  },
  {
    id: "agents",
    icon: Bot,
    title: "Agents and workflows",
    short: "Work that runs by itself",
    text: "Build agents for recurring work and chain them into workflows that run on a schedule. Actions with consequences wait for your approval.",
    examples: [
      "Every morning, check new documents and brief me",
      "Research, then let a second agent write the report",
      "Ask me before anything is sent",
    ],
  },
  {
    id: "knowledge",
    icon: FolderSearch,
    title: "Storage and knowledge",
    short: "Your files, searchable",
    text: "Keep files and notes in your storage and in shared knowledge spaces. JustAI finds the right passages and cites them in its answers.",
    examples: [
      "Answer from our handbook only",
      "Which contract mentions the notice period?",
      "Compare these two drafts",
    ],
  },
  {
    id: "notifications",
    icon: BellRing,
    title: "Notifications and reminders",
    short: "Stay informed",
    text: "Hear when a transcript or topic is finished, a run needs you or something goes wrong: in the app, as browser push, by e-mail or in Slack, Teams, Mattermost and Discord. Or just ask JustAI to remind you.",
    examples: [
      "Remind me in 20 minutes to call back",
      "Tell me tomorrow at 9 about the deadline",
      "Notify me when the debate on the budget is over",
    ],
  },
]

/**
 * A tour of what JustAI can do: pick a capability on the left, its sketch draws itself
 * on the right with a few things to try.
 */
export function OnboardingTour({
  active,
  onActiveChange,
}: {
  /** The capability shown; the onboarding's Next and Back buttons step through them. */
  active: number
  onActiveChange: (index: number) => void
}) {
  const { t } = useTranslations()
  const reduce = useReducedMotion()
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const baseId = useId()
  const feature = tourFeatures[active]

  // Arrow keys move between capabilities, as in any tab list.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    }
    let next: number | null = null
    if (event.key in keys)
      next =
        (active + keys[event.key] + tourFeatures.length) % tourFeatures.length
    if (event.key === "Home") next = 0
    if (event.key === "End") next = tourFeatures.length - 1
    if (next === null) return
    event.preventDefault()
    onActiveChange(next)
    tabs.current[next]?.focus()
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div
        aria-label={t("What JustAI can do")}
        aria-orientation="vertical"
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
        role="tablist"
      >
        {tourFeatures.map((item, index) => {
          const selected = index === active
          const Icon = item.icon
          return (
            <button
              aria-controls={`${baseId}-panel`}
              aria-selected={selected}
              className={cn(
                "relative flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring lg:shrink",
                selected
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
              id={`${baseId}-tab-${index}`}
              key={item.id}
              onClick={() => onActiveChange(index)}
              onKeyDown={onKeyDown}
              ref={(node) => {
                tabs.current[index] = node
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {selected ? (
                <motion.span
                  className="absolute inset-0 rounded-xl bg-muted"
                  layoutId={reduce ? undefined : `${baseId}-active`}
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              ) : null}
              <span
                className={cn(
                  "relative grid size-8 shrink-0 place-items-center rounded-lg",
                  selected ? "bg-primary/12 text-primary" : "bg-muted/60"
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="relative min-w-0">
                <span className="block text-sm font-medium whitespace-nowrap lg:whitespace-normal">
                  {t(item.title)}
                </span>
                <span className="hidden text-xs text-muted-foreground lg:block">
                  {t(item.short)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div
        aria-labelledby={`${baseId}-tab-${active}`}
        className="overflow-hidden rounded-2xl bg-muted [--iso-face:var(--muted)]"
        id={`${baseId}-panel`}
        role="tabpanel"
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-4 p-5 sm:p-6"
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            key={feature.id}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <div className="mx-auto w-full max-w-md text-foreground">
              <FeatureSketch label={t(feature.title)} name={feature.id} />
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="text-lg font-semibold tracking-tight">
                {t(feature.title)}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(feature.text)}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("For example")}
              </p>
              <ul className="flex flex-wrap gap-2">
                {feature.examples.map((example, index) => (
                  <motion.li
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-full bg-card px-3 py-1.5 text-xs text-foreground shadow-xs"
                    initial={reduce ? false : { opacity: 0, y: 4 }}
                    key={example}
                    transition={{ delay: 0.35 + index * 0.08, duration: 0.25 }}
                  >
                    {t("“{value0}”", { value0: t(example) })}
                  </motion.li>
                ))}
              </ul>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
