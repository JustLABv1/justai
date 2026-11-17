"use client"

import { BellPlus, ListChecks, Trash2 } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import { Input } from "@/components/panelui/input"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { api } from "@/lib/api"
import { workspacePath } from "@/lib/workspace-routes"

type Subscription = {
  id: string
  name: string
  keywords: string[]
  sourceName: string
  enabled: boolean
  lastCheckedAt?: string
  lastError?: string
  createdAt: string
  sittings: {
    sittingNo: number
    sessionId?: string
    sessionTitle?: string
    topicCount: number
    createdAt: string
  }[]
}

type PreviewItem = {
  key: string
  sessionNo: number
  label: string
  title: string
  startAt: string
}

function parseKeywords(text: string) {
  return text
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Shows which upcoming agenda items the keywords would pick. */
function useKeywordPreview(keywords: string[]) {
  const [state, setState] = useState<{
    key: string
    items: PreviewItem[]
    error: string
  } | null>(null)
  const key = keywords.join("\n")
  const ready = keywords.length > 0 && keywords.every((k) => k.length >= 3)
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void api
        .post<{ items: PreviewItem[] }>(
          "/api/v1/transcription/topic-subscriptions/preview",
          { keywords: key.split("\n") }
        )
        .then((result) => {
          if (!cancelled) setState({ key, items: result.items, error: "" })
        })
        .catch((caught) => {
          if (!cancelled)
            setState({
              key,
              items: [],
              error: caught instanceof Error ? caught.message : "",
            })
        })
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key, ready])
  if (!ready) return { loading: false, items: [], error: "" }
  if (state?.key !== key) return { loading: true, items: [], error: "" }
  return { loading: false, items: state.items, error: state.error }
}

/**
 * Subscribe to agenda items by keyword: for every upcoming sitting with matching items,
 * JustAI schedules a capture of only those items, like this session.
 */
export function TopicSubscriptionButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="outline">
        <BellPlus data-icon="inline-start" /> {t("Subscribe to topics")}
      </Button>
      {open ? (
        <TopicSubscriptionDialog
          onClose={() => setOpen(false)}
          sessionId={sessionId}
        />
      ) : null}
    </>
  )
}

function TopicSubscriptionDialog({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) {
  const { t, locale } = useTranslations()
  const [name, setName] = useState("")
  const [keywordText, setKeywordText] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [created, setCreated] = useState(false)
  const keywords = parseKeywords(keywordText)
  const preview = useKeywordPreview(keywords)
  const dateTime = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      await api.post("/api/v1/transcription/topic-subscriptions", {
        sessionId,
        name,
        keywords,
      })
      setCreated(true)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("The subscription could not be saved.")
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Subscribe to topics")}</DialogTitle>
          <DialogDescription>
            {t(
              "JustAI checks the Bundestag plan every 30 minutes. For each upcoming sitting with matching agenda items it schedules its own capture of only those items, with the settings and stream of this session."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {created ? (
            <p className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-900 dark:text-emerald-200">
              {t(
                "Subscribed. Scheduled captures appear in your live sessions; you can manage subscriptions there."
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{t("Keywords")}</span>
                <Input
                  autoFocus
                  onChange={(event) => setKeywordText(event.target.value)}
                  placeholder={t("e.g. Digital, Haushalt, Rente")}
                  value={keywordText}
                />
                <span className="text-xs text-muted-foreground">
                  {t(
                    "Separate keywords with commas. An agenda item matches when its title contains one of them."
                  )}
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{t("Name")}</span>
                <Input
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    keywords[0]
                      ? `Bundestag · ${keywords[0]}`
                      : t("e.g. Bundestag · Digital")
                  }
                  value={name}
                />
              </label>
              {keywords.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("Upcoming matches")}
                  </p>
                  {preview.loading ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner /> {t("Checking the Bundestag plan…")}
                    </p>
                  ) : preview.error ? (
                    <p className="text-sm text-destructive">{preview.error}</p>
                  ) : preview.items.length === 0 ? (
                    <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
                      {t(
                        "No agenda item in the published plan matches yet. The subscription keeps checking when new sitting weeks are published."
                      )}
                    </p>
                  ) : (
                    <ul className="flex max-h-56 flex-col divide-y divide-border/60 overflow-auto rounded-lg bg-muted/40">
                      {preview.items.map((item) => (
                        <li className="px-3 py-2 text-sm" key={item.key}>
                          <span className="block font-medium">
                            {item.title}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t("{value0}. sitting", { value0: item.sessionNo })}{" "}
                            · {item.label} ·{" "}
                            {dateTime.format(new Date(item.startAt))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {created ? (
            <Button onClick={onClose}>{t("Close")}</Button>
          ) : (
            <>
              <Button onClick={onClose} variant="outline">
                {t("Cancel")}
              </Button>
              <Button
                disabled={saving || keywords.length === 0}
                onClick={() => void save()}
              >
                {saving ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <BellPlus data-icon="inline-start" />
                )}
                {t("Subscribe")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Lists the topic subscriptions with what they scheduled, to pause or remove them. */
export function TopicSubscriptionsButton() {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="outline">
        <ListChecks data-icon="inline-start" /> {t("Topic subscriptions")}
      </Button>
      {open ? (
        <TopicSubscriptionsDialog onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

function TopicSubscriptionsDialog({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslations()
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(
    null
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const dateTime = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })

  const load = useCallback(async () => {
    const result = await api.get<{ subscriptions: Subscription[] }>(
      "/api/v1/transcription/topic-subscriptions"
    )
    setSubscriptions(result.subscriptions)
  }, [])

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ subscriptions: Subscription[] }>(
        "/api/v1/transcription/topic-subscriptions"
      )
      .then((result) => {
        if (!cancelled) setSubscriptions(result.subscriptions)
      })
      .catch(() => {
        if (!cancelled) setError(t("The subscriptions could not be loaded."))
      })
    return () => {
      cancelled = true
    }
  }, [t])

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setError("")
    try {
      await action()
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("The action failed.")
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Topic subscriptions")}</DialogTitle>
          <DialogDescription>
            {t(
              "Each subscription schedules a capture of the matching agenda items for every upcoming Bundestag sitting. Create one from the topics of a Bundestag session."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {!subscriptions ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("Loading…")}
            </p>
          ) : subscriptions.length === 0 ? (
            <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
              {t(
                "No subscriptions yet. Open a Bundestag session and choose “Subscribe to topics” in its topic list."
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {subscriptions.map((subscription) => (
                <li
                  className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3"
                  key={subscription.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{subscription.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {subscription.keywords.map((keyword) => (
                          <Badge key={keyword} size="sm" variant="secondary">
                            {keyword}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        aria-label={t("Subscription active")}
                        checked={subscription.enabled}
                        disabled={busyId === subscription.id}
                        onCheckedChange={(enabled) =>
                          void act(subscription.id, () =>
                            api.patch(
                              `/api/v1/transcription/topic-subscriptions/${subscription.id}`,
                              { enabled }
                            )
                          )
                        }
                      />
                      <Button
                        aria-label={t("Delete subscription")}
                        disabled={busyId === subscription.id}
                        onClick={() =>
                          void act(subscription.id, () =>
                            api.delete(
                              `/api/v1/transcription/topic-subscriptions/${subscription.id}`
                            )
                          )
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {!subscription.enabled
                      ? t("Paused. No new captures are scheduled.")
                      : subscription.lastCheckedAt
                        ? t("Last checked {value0}", {
                            value0: dateTime.format(
                              new Date(subscription.lastCheckedAt)
                            ),
                          })
                        : t("Not checked yet")}
                  </p>
                  {subscription.lastError ? (
                    <p className="text-xs text-destructive">
                      {t(subscription.lastError)}
                    </p>
                  ) : null}
                  {subscription.sittings.length > 0 ? (
                    <ul className="flex flex-col gap-1 text-sm">
                      {subscription.sittings.map((sitting) => (
                        <li
                          className="flex flex-wrap items-center gap-x-2"
                          key={sitting.sittingNo}
                        >
                          <span className="text-muted-foreground tabular-nums">
                            {t("{value0}. sitting", {
                              value0: sitting.sittingNo,
                            })}
                          </span>
                          {sitting.sessionId ? (
                            <Link
                              className="text-primary hover:underline"
                              href={workspacePath(
                                "transcription",
                                null,
                                sitting.sessionId
                              )}
                              onClick={onClose}
                              prefetch={false}
                            >
                              {sitting.sessionTitle || t("Open session")}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("Session deleted")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t("Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
