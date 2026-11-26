"use client"

import { Maximize2, Sparkles, X } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Spinner } from "@/components/panelui/spinner"
import { api } from "@/lib/api"
import type { Conversation } from "@/lib/types"

/**
 * "Ask AI" beside a transcription: a chat panel that stays open next to the transcript
 * instead of leaving the page. Its conversation has the transcription attached, so each
 * answer reads the transcript as it stands, also while it is still running, and before
 * capture starts it knows the plan and the agenda. The chat is kept per transcription,
 * so reopening it continues the conversation. Mount it with the session id as key.
 */
export function TranscriptChatDock({
  sessionId,
  renderChat,
  onOpenFullChat,
}: {
  sessionId: string
  renderChat: (conversation: Conversation) => ReactNode
  onOpenFullChat: (conversationId: string) => void
}) {
  const { t } = useTranslations()
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const panelRef = useRef<HTMLDivElement>(null)

  const show = () => {
    setOpen(true)
    if (conversation) return
    setLoading(true)
    setError("")
    void api
      .post<{ conversation: Conversation }>(
        `/api/v1/transcription/sessions/${sessionId}/chat`
      )
      .then((result) => setConversation(result.conversation))
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : t("The chat could not be opened.")
        )
      )
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        panelRef.current?.contains(document.activeElement)
      )
        setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <>
      <AnimatePresence>
        {!open ? (
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="fixed right-6 bottom-6 z-40"
            exit={{ opacity: 0, scale: 0.9, y: 8 }}
            initial={reduce ? false : { opacity: 0, scale: 0.9, y: 8 }}
            transition={{ duration: 0.18 }}
          >
            <Button
              className="h-11 rounded-full px-5 shadow-lg shadow-black/20"
              onClick={show}
            >
              <Sparkles data-icon="inline-start" />
              {t("Ask AI")}
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {open ? (
          <motion.aside
            animate={{ opacity: 1, x: 0 }}
            aria-label={t("Ask AI about this transcript")}
            className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl shadow-black/30 sm:inset-auto sm:top-4 sm:right-4 sm:bottom-4 sm:w-[min(30rem,calc(100vw-2rem))]"
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: 32 }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 32 }}
            ref={panelRef}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                <Sparkles aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium">{t("Ask AI")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Reads this transcript as it stands, also while it is still running."
                  )}
                </p>
              </div>
              {conversation ? (
                <Button
                  aria-label={t("Open in chat")}
                  onClick={() => onOpenFullChat(conversation.id)}
                  size="icon-sm"
                  title={t("Open in chat")}
                  variant="ghost"
                >
                  <Maximize2 />
                </Button>
              ) : null}
              <Button
                aria-label={t("Close")}
                onClick={() => setOpen(false)}
                size="icon-sm"
                title={t("Close")}
                variant="ghost"
              >
                <X />
              </Button>
            </header>
            <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
              {loading ? (
                <p className="m-auto flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> {t("Loading…")}
                </p>
              ) : error ? (
                <div className="m-auto flex max-w-xs flex-col items-center gap-3 p-6 text-center">
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                  <Button onClick={show} size="sm" variant="outline">
                    {t("Try again")}
                  </Button>
                </div>
              ) : conversation ? (
                renderChat(conversation)
              ) : null}
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  )
}
