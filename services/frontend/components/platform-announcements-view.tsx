"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CalendarClock,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react"

import { useAdminList } from "@/components/admin-list-controls"
import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import { sortPlatformBanners } from "@/lib/platform-config-logic"
import type { PlatformBanner } from "@/lib/types"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Frame } from "@/components/panelui/frame"
import { Field } from "@/components/panelui/field"
import { Menu } from "@/components/panelui/menu"
import { Sheet } from "@/components/panelui/sheet"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import { Textarea } from "@/components/panelui/textarea"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"

type BannerForm = {
  message: string
  severity: PlatformBanner["severity"]
  linkUrl: string
  priority: string
  startsAt: string
  endsAt: string
  enabled: boolean
  dismissible: boolean
}

const emptyForm: BannerForm = {
  message: "",
  severity: "info",
  linkUrl: "",
  priority: "0",
  startsAt: toDateTimeInput(new Date()),
  endsAt: "",
  enabled: true,
  dismissible: true,
}

function toDateTimeInput(value: Date | string | null | undefined) {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function toISOStringOrNull(value: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function formFromBanner(banner: PlatformBanner): BannerForm {
  return {
    message: banner.message,
    severity: banner.severity,
    linkUrl: banner.linkUrl ?? "",
    priority: String(banner.priority),
    startsAt: toDateTimeInput(banner.startsAt),
    endsAt: toDateTimeInput(banner.endsAt),
    enabled: banner.enabled,
    dismissible: banner.dismissible,
  }
}

function bannerState(banner: PlatformBanner) {
  const now = Date.now()
  const starts = new Date(banner.startsAt).getTime()
  const ends = banner.endsAt ? new Date(banner.endsAt).getTime() : null
  if (!banner.enabled) return "Disabled"
  if (starts > now) return "Scheduled"
  if (ends !== null && ends <= now) return "Expired"
  return "Live"
}

function badgeVariant(
  state: string
): "success" | "secondary" | "outline" | "destructive" {
  if (state === "Live") return "success"
  if (state === "Expired") return "secondary"
  if (state === "Scheduled") return "outline"
  return "secondary"
}

type Props = {
  createRequest?: number
}

export function PlatformAnnouncementsView({ createRequest }: Props) {
  const { t, locale } = useTranslations()

  const [banners, setBanners] = useState<PlatformBanner[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<BannerForm>(emptyForm)
  const [removeTarget, setRemoveTarget] = useState<PlatformBanner | null>(null)
  const [removing, setRemoving] = useState(false)
  const createRequestRef = useRef(createRequest ?? 0)

  const load = useCallback(async () => {
    setError("")
    try {
      const result = await api.get<{ banners: PlatformBanner[] }>(
        "/api/v1/admin/banners"
      )
      setBanners(result.banners)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Announcements could not be loaded."
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const sortedBanners = useMemo(() => sortPlatformBanners(banners), [banners])
  const list = useAdminList(
    sortedBanners,
    (banner, query, status) =>
      banner.message.toLocaleLowerCase().includes(query) &&
      (status === "all" || bannerState(banner) === status)
  )

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm({ ...emptyForm, startsAt: toDateTimeInput(new Date()) })
    setError("")
    setDialogOpen(true)
  }, [])

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

  function openEdit(banner: PlatformBanner) {
    setEditingId(banner.id)
    setForm(formFromBanner(banner))
    setError("")
    setDialogOpen(true)
  }

  async function save(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    setError("")
    if (!form.message.trim()) {
      setError("Announcement message is required.")
      return
    }
    const priority = Number.parseInt(form.priority, 10)
    if (!Number.isFinite(priority)) {
      setError("Priority must be a whole number.")
      return
    }
    const startsAt = toISOStringOrNull(form.startsAt)
    const endsAt = toISOStringOrNull(form.endsAt)
    if (!startsAt) {
      setError("A valid start time is required.")
      return
    }
    if (endsAt && new Date(endsAt) <= new Date(startsAt)) {
      setError("The end time must be after the start time.")
      return
    }
    setSaving(true)
    try {
      const payload = {
        message: form.message.trim(),
        severity: form.severity,
        linkUrl: form.linkUrl.trim() || null,
        priority,
        enabled: form.enabled,
        dismissible: form.dismissible,
        startsAt,
        endsAt,
      }
      if (editingId) {
        await api.patch(`/api/v1/admin/banners/${editingId}`, payload)
      } else {
        await api.post("/api/v1/admin/banners", payload)
      }
      setDialogOpen(false)
      notifySuccess(
        editingId ? "Announcement updated" : "Announcement published"
      )
      await load()
    } catch (caught) {
      setError(
        notifyError(
          "Announcement could not be saved",
          caught,
          "Announcement could not be saved."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function remove(banner: PlatformBanner) {
    setRemoving(true)
    setError("")
    try {
      await api.delete(`/api/v1/admin/banners/${banner.id}`)
      notifySuccess("Announcement removed")
      setRemoveTarget(null)
      await load()
    } catch (caught) {
      setError(
        notifyError(
          "Announcement could not be deleted",
          caught,
          "Announcement could not be deleted."
        )
      )
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && !dialogOpen && (
        <ToastFeedback message={error} type={"destructive"} />
      )}

      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Announcements")}</Frame.Title>
          <Frame.Description>
            {t("Manage platform messages and their publishing schedule.")}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel>
          <Frame.Row>
            <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <Input.Group>
                <Input.Addon>
                  <Search className="size-4" />
                </Input.Addon>
                <Input
                  aria-label={t("Search announcements")}
                  placeholder={t("Search announcements…")}
                  value={list.query}
                  onChange={(event) => list.setQuery(event.target.value)}
                />
              </Input.Group>
              <Select
                value={list.status}
                onValueChange={(value) => list.setStatus(value ?? "all")}
              >
                <SelectTrigger aria-label={t("Filter by status")}>
                  <SelectValue>
                    {t(list.status === "all" ? "All statuses" : list.status)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {["all", "Live", "Scheduled", "Expired", "Disabled"].map(
                      (state) => (
                        <SelectItem key={state} value={state}>
                          {t(state === "all" ? "All statuses" : state)}
                        </SelectItem>
                      )
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </Frame.Row>

          {loading ? (
            <div
              aria-live="polite"
              className="flex items-center justify-center py-10 text-sm text-muted-foreground"
            >
              <Spinner className="mr-2 size-4" /> {t("Loading announcements…")}
            </div>
          ) : list.total === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t(
                sortedBanners.length
                  ? "No results"
                  : "No announcements configured."
              )}
            </p>
          ) : (
            list.pageItems.map((banner) => {
              const state = bannerState(banner)
              return (
                <Frame.Row className="items-start gap-3 py-4" key={banner.id}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={badgeVariant(state)}>{t(state)}</Badge>
                      <Badge
                        variant={
                          banner.severity === "danger"
                            ? "destructive"
                            : banner.severity === "warning"
                              ? "warning"
                              : banner.severity === "success"
                                ? "success"
                                : "secondary"
                        }
                      >
                        {t(
                          banner.severity === "danger"
                            ? "Error"
                            : banner.severity === "warning"
                              ? "Warning"
                              : banner.severity === "success"
                                ? "Success"
                                : "Information"
                        )}
                      </Badge>
                      <Badge variant="outline">
                        {t("Priority")} {banner.priority}
                      </Badge>
                      {banner.dismissible && (
                        <Badge variant="secondary">{t("Dismissible")}</Badge>
                      )}
                    </div>
                    <p className="mt-2 text-sm break-words whitespace-pre-wrap">
                      {banner.message}
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <CalendarClock className="size-3.5" />
                      {new Date(banner.startsAt).toLocaleString(locale)} —{" "}
                      {banner.endsAt
                        ? new Date(banner.endsAt).toLocaleString(locale)
                        : t("No end")}
                      {banner.linkUrl && (
                        <a
                          className="underline underline-offset-2"
                          href={banner.linkUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {t("Link")}
                        </a>
                      )}
                    </p>
                  </div>
                  <Frame.Actions>
                    <Menu>
                      <Menu.Trigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("Actions for {value0}", {
                              value0: banner.message.slice(0, 60),
                            })}
                          />
                        }
                      >
                        <MoreHorizontal />
                      </Menu.Trigger>
                      <Menu.Content align="end">
                        <Menu.Item onClick={() => openEdit(banner)}>
                          <Pencil />
                          {t("Edit")}
                        </Menu.Item>
                        <Menu.Separator />
                        <Menu.Item
                          variant="destructive"
                          onClick={() => setRemoveTarget(banner)}
                        >
                          <Trash2 />
                          {t("Delete announcement")}
                        </Menu.Item>
                      </Menu.Content>
                    </Menu>{" "}
                  </Frame.Actions>
                </Frame.Row>
              )
            })
          )}
        </Frame.Panel>
        {!loading && list.total > 0 && (
          <Frame.Footer className="flex flex-wrap items-center justify-between gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {t("{start}–{end} of {total}", {
                start: (list.page - 1) * 20 + 1,
                end: Math.min(list.page * 20, list.total),
                total: list.total,
              })}
            </span>
            {list.total > 20 && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={list.page <= 1}
                  onClick={() => list.setPage(list.page - 1)}
                >
                  {t("Previous page")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={list.page * 20 >= list.total}
                  onClick={() => list.setPage(list.page + 1)}
                >
                  {t("Next page")}
                </Button>
              </div>
            )}
          </Frame.Footer>
        )}
      </Frame>

      <Sheet
        side="right"
        dismissible={!saving}
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!saving) setDialogOpen(open)
        }}
      >
        <Sheet.Content className="w-[min(40rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header>
            <Sheet.Title>
              {editingId ? t("Edit announcement") : t("Add announcement")}
            </Sheet.Title>
            <Sheet.Description>
              {t(
                "Choose when the message is active and how it should appear to users."
              )}
            </Sheet.Description>
          </Sheet.Header>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void save(event)}
          >
            <Sheet.Body className="flex flex-col gap-5">
              {error && <ToastFeedback message={error} type={"destructive"} />}
              <Frame variant="band">
                <Frame.Header>
                  <Frame.Title>{t("Message & appearance")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel className="grid gap-4 p-4 sm:grid-cols-2">
                  <Field disabled={saving} className="sm:col-span-2">
                    <Field.Label>{t("Message")}</Field.Label>
                    <Textarea
                      minRows={3}
                      maxRows={8}
                      disabled={saving}
                      id="announcement-message"
                      maxLength={1000}
                      required
                      value={form.message}
                      onChange={(event) =>
                        setForm({ ...form, message: event.target.value })
                      }
                      placeholder={t(
                        "Scheduled maintenance begins at 22:00 UTC."
                      )}
                    />
                  </Field>
                  <Field disabled={saving}>
                    <Field.Label>{t("Severity")}</Field.Label>
                    <Select
                      value={form.severity}
                      onValueChange={(value) =>
                        value &&
                        setForm({
                          ...form,
                          severity: value as BannerForm["severity"],
                        })
                      }
                    >
                      <SelectTrigger
                        disabled={saving}
                        id="announcement-severity"
                      >
                        <SelectValue>
                          {t(
                            form.severity === "danger"
                              ? "Error"
                              : form.severity === "warning"
                                ? "Warning"
                                : form.severity === "success"
                                  ? "Success"
                                  : "Information"
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="info">{t("Info")}</SelectItem>
                          <SelectItem value="success">
                            {t("Success")}
                          </SelectItem>
                          <SelectItem value="warning">
                            {t("Warning")}
                          </SelectItem>
                          <SelectItem value="danger">{t("Danger")}</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field disabled={saving}>
                    <Field.Label>{t("Priority")}</Field.Label>
                    <Input
                      disabled={saving}
                      id="announcement-priority"
                      min="-1000"
                      step="1"
                      type="number"
                      value={form.priority}
                      onChange={(event) =>
                        setForm({ ...form, priority: event.target.value })
                      }
                    />
                  </Field>
                  <Field disabled={saving} className="sm:col-span-2">
                    <Field.Label>{t("Optional link")}</Field.Label>
                    <Input
                      disabled={saving}
                      id="announcement-link"
                      type="url"
                      value={form.linkUrl}
                      onChange={(event) =>
                        setForm({ ...form, linkUrl: event.target.value })
                      }
                      placeholder="https://status.example.com"
                    />
                  </Field>
                </Frame.Panel>
              </Frame>
              <Frame variant="band">
                <Frame.Header>
                  <Frame.Title>{t("Schedule")}</Frame.Title>
                  <Frame.Description>
                    {t("Times are shown in your local time zone.")}
                  </Frame.Description>
                </Frame.Header>
                <Frame.Panel className="grid gap-4 p-4 sm:grid-cols-2">
                  <Field disabled={saving}>
                    <Field.Label>{t("Starts at")}</Field.Label>
                    <Input
                      disabled={saving}
                      id="announcement-starts-at"
                      type="datetime-local"
                      required
                      value={form.startsAt}
                      onChange={(event) =>
                        setForm({ ...form, startsAt: event.target.value })
                      }
                    />
                  </Field>
                  <Field disabled={saving}>
                    <Field.Label>{t("Ends at (optional)")}</Field.Label>
                    <Input
                      disabled={saving}
                      id="announcement-ends-at"
                      type="datetime-local"
                      value={form.endsAt}
                      onChange={(event) =>
                        setForm({ ...form, endsAt: event.target.value })
                      }
                    />
                  </Field>
                </Frame.Panel>
              </Frame>
              <Frame>
                <Frame.Header>
                  <Frame.Title>{t("Visibility")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel>
                  <Frame.Row className="gap-4">
                    <Frame.Content>
                      <p className="text-xs font-medium">
                        {t("Announcement enabled")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "Only enabled announcements inside the time window are public."
                        )}
                      </p>
                    </Frame.Content>
                    <Frame.Actions>
                      <Switch
                        aria-label={t("Announcement enabled")}
                        checked={form.enabled}
                        disabled={saving}
                        onCheckedChange={(enabled) =>
                          setForm({ ...form, enabled })
                        }
                      />
                    </Frame.Actions>
                  </Frame.Row>
                  <Frame.Row className="gap-4">
                    <Frame.Content>
                      <p className="text-xs font-medium">
                        {t("Allow dismissal")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "Users can hide this announcement in their current browser."
                        )}
                      </p>
                    </Frame.Content>
                    <Frame.Actions>
                      <Switch
                        aria-label={t("Allow announcement dismissal")}
                        checked={form.dismissible}
                        disabled={saving}
                        onCheckedChange={(dismissible) =>
                          setForm({ ...form, dismissible })
                        }
                      />
                    </Frame.Actions>
                  </Frame.Row>
                </Frame.Panel>
              </Frame>
              <Frame variant="band">
                <Frame.Header>
                  <Frame.Title>{t("Preview")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel className="p-4">
                  <Alert
                    tone={
                      form.severity === "danger" ? "destructive" : form.severity
                    }
                    variant="plain"
                  >
                    <Alert.Description className="break-words whitespace-pre-wrap">
                      {form.message || t("Your announcement will appear here.")}
                    </Alert.Description>
                  </Alert>
                </Frame.Panel>
              </Frame>
            </Sheet.Body>
            <Sheet.Footer className="sm:flex-row sm:justify-end">
              <Button
                disabled={saving}
                onClick={() => setDialogOpen(false)}
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving} loading={saving} type="submit">
                {saving ? t("Saving…") : t("Save announcement")}
              </Button>
            </Sheet.Footer>
          </form>
        </Sheet.Content>
      </Sheet>
      <ConfirmActionDialog
        open={Boolean(removeTarget)}
        title={t("Delete this announcement?")}
        description={t(
          "It will disappear from every JustAI surface immediately. This cannot be undone."
        )}
        confirmLabel={t("Delete announcement")}
        pending={removing}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) return remove(removeTarget)
        }}
      />
    </div>
  )
}
