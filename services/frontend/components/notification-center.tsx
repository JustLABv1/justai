"use client"

import {
  AlarmClock,
  Bell,
  Bot,
  ShieldQuestion,
  CheckCheck,
  CircleCheck,
  Settings2,
  TriangleAlert,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { NavRail } from "@/components/panelui/nav-rail"
import { Sheet } from "@/components/panelui/sheet"
import { Spinner } from "@/components/panelui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type NotificationItem = {
  id: string
  kind: string
  title: string
  body: string
  link: string
  createdAt: string
  readAt?: string
}

const refreshEvery = 60_000

/**
 * The bell in the sidebar: lists what finished (topics and whole live transcripts the
 * user owns or was shared). E-mail and browser push are set in the profile.
 */
export function NotificationCenter({
  onOpened,
}: {
  /** Lets the sidebar close itself on mobile. */
  onOpened?: () => void
}) {
  const { t, locale } = useTranslations()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const localeSent = useRef("")

  // State is set only in the request's callbacks, so effects may start a refresh.
  const load = useCallback(
    () =>
      api
        .get<{ items: NotificationItem[]; unread: number }>(
          "/api/v1/notifications"
        )
        .then((result) => {
          setItems(result.items)
          setUnread(result.unread)
        })
        .catch(() => undefined) // the next refresh tries again
        .finally(() => setLoaded(true)),
    []
  )

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(), refreshEvery)
    const onFocus = () => void load()
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [load])

  // E-mails and push texts are written in the language the user reads JustAI in.
  useEffect(() => {
    if (localeSent.current === locale) return
    localeSent.current = locale
    // The time zone lets the assistant set reminders for the user's own clock.
    void api
      .put("/api/v1/notifications/settings", {
        locale,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      .catch(() => undefined)
  }, [locale])

  const openCenter = () => {
    setOpen(true)
    void load()
  }

  const markRead = async (body: { ids: string[] } | { all: true }) => {
    const ids = "ids" in body ? new Set(body.ids) : null
    setItems((current) =>
      current.map((item) =>
        !item.readAt && (!ids || ids.has(item.id))
          ? { ...item, readAt: new Date().toISOString() }
          : item
      )
    )
    setUnread((count) => (ids ? Math.max(0, count - ids.size) : 0))
    await api.post("/api/v1/notifications/read", body).catch(() => undefined)
  }

  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  })

  return (
    <>
      <NavRail.Item
        icon={<Bell />}
        label={
          unread > 0
            ? t("Notifications, {value0} unread", { value0: unread })
            : t("Notifications")
        }
        onClick={() => {
          onOpened?.()
          openCenter()
        }}
      >
        {t("Notifications")}
        {unread > 0 ? (
          <NavRail.Badge>{unread > 99 ? "99+" : unread}</NavRail.Badge>
        ) : null}
      </NavRail.Item>
      <Sheet side="right" open={open} onOpenChange={setOpen}>
        <Sheet.Content className="w-[min(28rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header>
            <Sheet.Title>{t("Notifications")}</Sheet.Title>
            <Sheet.Description>
              {t(
                "Finished topics and transcripts, problems during your transcriptions, and reminders you asked the assistant for."
              )}
            </Sheet.Description>
          </Sheet.Header>
          <Sheet.Body className="flex flex-col gap-2">
            <section
              aria-label={t("Recent notifications")}
              className="flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t("Recent")}</h3>
                {unread > 0 ? (
                  <Button
                    onClick={() => void markRead({ all: true })}
                    size="sm"
                    variant="ghost"
                  >
                    <CheckCheck data-icon="inline-start" />
                    {t("Mark all as read")}
                  </Button>
                ) : null}
              </div>
              {!loaded ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> {t("Loading…")}
                </p>
              ) : items.length === 0 ? (
                <p className="rounded-lg bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
                  {t("No notifications yet.")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        className={cn(
                          "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          !item.readAt && "bg-primary/5"
                        )}
                        onClick={() => {
                          if (!item.readAt) void markRead({ ids: [item.id] })
                          setOpen(false)
                          if (item.link) router.push(item.link)
                        }}
                        type="button"
                      >
                        <NotificationKindIcon
                          kind={item.kind}
                          unread={!item.readAt}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">
                            {item.title}
                            {!item.readAt ? (
                              <span className="sr-only"> ({t("unread")})</span>
                            ) : null}
                          </span>
                          {item.body ? (
                            <span className="block text-xs text-muted-foreground">
                              {item.body}
                            </span>
                          ) : null}
                          <time
                            className="mt-0.5 block text-xs text-muted-foreground tabular-nums"
                            dateTime={item.createdAt}
                          >
                            {time.format(new Date(item.createdAt))}
                          </time>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Sheet.Body>
          <Sheet.Footer>
            <Button
              onClick={() => {
                setOpen(false)
                router.push("/profile?tab=notifications")
              }}
              variant="ghost"
            >
              <Settings2 data-icon="inline-start" />
              {t("Notification settings")}
            </Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet>
    </>
  )
}

const problemKinds = new Set([
  "capture_aborted",
  "stream_unreachable",
  "watch_missed",
  "topic_missed",
  "plan_missing",
  "stream_outage",
  "transcription_failed",
  "processing_failed",
  "agent_failed",
])

/** What a notification is about, with a dot while it is unread. */
function NotificationKindIcon({
  kind,
  unread,
}: {
  kind: string
  unread: boolean
}) {
  const Icon =
    kind === "reminder"
      ? AlarmClock
      : kind === "agent_approval"
        ? ShieldQuestion
        : kind === "agent_message"
          ? Bot
          : problemKinds.has(kind)
            ? TriangleAlert
            : kind === "topic_done" ||
                kind === "transcript_done" ||
                kind === "stream_recovered" ||
                kind === "agent_completed"
              ? CircleCheck
              : Bell
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-md",
        problemKinds.has(kind)
          ? "bg-destructive/10 text-destructive"
          : "bg-primary/10 text-primary"
      )}
    >
      <Icon className="size-4" />
      {unread ? (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-popover" />
      ) : null}
    </span>
  )
}
