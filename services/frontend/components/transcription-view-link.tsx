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
import { Share } from "@/components/panelui/share"
import type { User } from "@/lib/types"
import { api, resolveAPIURL } from "@/lib/api"

type ViewLink = { token: string; createdAt: string }

function viewURL(token: string) {
  return `${window.location.origin}/transcription/view?token=${encodeURIComponent(token)}`
}

/**
 * A read-only link: colleagues follow the live transcript, speakers and agenda items
 * without an account, and cannot change anything.
 */
type Reader = { id: string; name: string; email: string }

export function ViewLinkButton({
  sessionId,
  owner,
}: {
  sessionId: string
  owner: User
}) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  const [manageLink, setManageLink] = useState(false)
  const [readers, setReaders] = useState<Reader[]>([])
  const [hasLink, setHasLink] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [recipients, setRecipients] = useState<string[]>([])
  const base = `/api/v1/transcription/sessions/${sessionId}`
  const privateURL =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/transcription/view?session=${sessionId}&org=${encodeURIComponent(api.getOrganizationId() ?? "")}`
  useEffect(() => {
    if (manageLink) return
    let cancelled = false
    setReady(false)
    setError("")
    Promise.all([
      api.get<{ readers: Reader[] }>(base + "/readers"),
      open
        ? api.get<{ link: ViewLink | null }>(base + "/view-link")
        : Promise.resolve({ link: null }),
    ])
      .then(([people, access]) => {
        if (cancelled) return
        setReaders(people.readers)
        setHasLink(Boolean(access.link))
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load sharing settings."))
      })
    return () => {
      cancelled = true
    }
  }, [base, open, manageLink, t])

  return (
    <>
      <Share
        open={open}
        onOpenChange={setOpen}
        link={privateURL}
        onInvite={async ({ emails }) => {
          setBusy(true)
          setError("")
          try {
            const result = await api.post<{ readers: Reader[] }>(
              base + "/readers",
              { emails }
            )
            setReaders(result.readers)
            setRecipients(emails)
          } catch (err) {
            setError(
              t(
                "Could not grant access. Check that all addresses belong to active workspace members."
              )
            )
            throw err
          } finally {
            setBusy(false)
          }
        }}
      >
        <Share.Trigger
          aria-label={t("Share transcript")}
          people={[
            {
              name: owner.displayName || owner.email,
              src: owner.avatarUrl ? resolveAPIURL(owner.avatarUrl) : undefined,
            },
            ...readers.map((reader) => ({ name: reader.name || reader.email })),
          ]}
        >
          {t("Share")}
        </Share.Trigger>
        <Share.Content title={t("Share transcript")}>
          {ready ? (
            <>
              <Share.Invite
                roles={[]}
                placeholder={t("Workspace member email")}
              />
              <Share.People label={t("People with access")}>
                <Share.Person
                  name={owner.displayName || owner.email}
                  src={
                    owner.avatarUrl ? resolveAPIURL(owner.avatarUrl) : undefined
                  }
                  description={owner.email}
                  role={t("Owner")}
                />
                {readers.map((reader) => (
                  <Share.Person
                    key={reader.id}
                    name={reader.name}
                    role={t("Can view")}
                    description={
                      <>
                        {reader.email}{" "}
                        <button
                          type="button"
                          className="underline"
                          disabled={busy}
                          aria-label={t("Remove access for {value0}", {
                            value0: reader.email,
                          })}
                          onClick={async () => {
                            setBusy(true)
                            try {
                              const result = await api.delete<{
                                readers: Reader[]
                              }>(base + "/readers/" + reader.id)
                              setReaders(result.readers)
                              setRecipients((prev) =>
                                prev.filter(
                                  (email) =>
                                    email.toLowerCase() !==
                                    reader.email.toLowerCase()
                                )
                              )
                            } catch {
                              setError(t("Could not remove access."))
                            } finally {
                              setBusy(false)
                            }
                          }}
                        >
                          {t("Remove")}
                        </button>
                      </>
                    }
                  />
                ))}
              </Share.People>
              <div className="px-4 py-2 text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => setManageLink(true)}
                  className="underline"
                >
                  {t("Read-only link")}
                </button>
                {" · "}
                {hasLink ? t("Anyone with the link can read") : t("Off")}
              </div>
              {recipients.length > 0 && (
                <a
                  className="mx-4 text-sm underline"
                  href={`mailto:?bcc=${encodeURIComponent(recipients.join(","))}&subject=${encodeURIComponent(t("Share transcript"))}&body=${encodeURIComponent(privateURL)}`}
                >
                  {t("Open invitation email")}
                </a>
              )}
            </>
          ) : (
            !error && <Spinner />
          )}
          {error && (
            <p className="px-4 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {ready && (
            <Share.Footer className="flex-wrap gap-2 *:min-w-32 *:whitespace-nowrap">
              <Share.CopyLink
                title={t("Copy member link")}
                copiedLabel={t("Copied")}
              >
                {t("Copy link")}
              </Share.CopyLink>
              <Share.Send
                {...(busy ? { disabled: true } : {})}
                pendingLabel={t("Saving…")}
                successLabel={t("Access granted")}
              >
                {t("Grant access")}
              </Share.Send>
            </Share.Footer>
          )}
        </Share.Content>
      </Share>
      {manageLink && (
        <ViewLinkDialog
          sessionId={sessionId}
          onClose={() => setManageLink(false)}
        />
      )}
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
