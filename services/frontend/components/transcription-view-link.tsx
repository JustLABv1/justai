"use client"

import { Check, Copy, Eye, Link2Off, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
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
import { api } from "@/lib/api"

type ViewLink = { token: string; createdAt: string }

function viewURL(token: string) {
  return `${window.location.origin}/transcription/view?token=${encodeURIComponent(token)}`
}

/**
 * A read-only link: colleagues follow the live transcript, speakers and agenda items
 * without an account, and cannot change anything.
 */
export function ViewLinkButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="outline">
        <Eye data-icon="inline-start" /> {t("Read-only link")}
      </Button>
      {open ? (
        <ViewLinkDialog onClose={() => setOpen(false)} sessionId={sessionId} />
      ) : null}
    </>
  )
}

function ViewLinkDialog({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) {
  const { t, locale } = useTranslations()
  const [link, setLink] = useState<ViewLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ link: ViewLink | null }>(
        `/api/v1/transcription/sessions/${sessionId}/view-link`
      )
      .then((result) => {
        if (!cancelled) setLink(result.link)
      })
      .catch(() => {
        if (!cancelled) setError(t("The link could not be loaded."))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, t])

  const create = async () => {
    setBusy(true)
    setError("")
    try {
      const result = await api.post<{ link: ViewLink }>(
        `/api/v1/transcription/sessions/${sessionId}/view-link`
      )
      setLink(result.link)
    } catch {
      setError(t("The link could not be created."))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    setBusy(true)
    setError("")
    try {
      await api.delete(`/api/v1/transcription/sessions/${sessionId}/view-link`)
      setLink(null)
    } catch {
      setError(t("The link could not be turned off."))
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    if (!link) return
    void navigator.clipboard
      .writeText(viewURL(link.token))
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => setError(t("Copying is not available here.")))
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Read-only link")}</DialogTitle>
          <DialogDescription>
            {t(
              "Anyone with this link can follow the transcript, the speakers and the agenda items live, without an account. They cannot change anything."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("Loading…")}
            </p>
          ) : link ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Input
                  aria-label={t("Read-only link")}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={viewURL(link.token)}
                />
                <Button onClick={copy} variant="outline">
                  {copied ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Copy data-icon="inline-start" />
                  )}
                  {copied ? t("Copied") : t("Copy")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("Created {value0}", {
                  value0: new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(link.createdAt)),
                })}
              </p>
            </div>
          ) : (
            <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              {t("There is no read-only link for this session yet.")}
            </p>
          )}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {link ? (
            <>
              <Button
                disabled={busy}
                onClick={() => void revoke()}
                variant="outline"
              >
                <Link2Off data-icon="inline-start" /> {t("Turn off")}
              </Button>
              <Button disabled={busy} onClick={() => void create()}>
                <RefreshCw data-icon="inline-start" /> {t("New link")}
              </Button>
            </>
          ) : (
            <Button disabled={busy || loading} onClick={() => void create()}>
              <Eye data-icon="inline-start" /> {t("Create link")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
