"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CalendarClock, LoaderCircle, Megaphone, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import { sortPlatformBanners } from "@/lib/platform-config-logic"
import type { PlatformBanner } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

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

function badgeVariant(state: string): "default" | "secondary" | "outline" | "destructive" {
  if (state === "Live") return "default"
  if (state === "Expired") return "destructive"
  if (state === "Scheduled") return "outline"
  return "secondary"
}

type Props = {
  createRequest?: number
}

export function PlatformAnnouncementsView({ createRequest }: Props) {
  const [banners, setBanners] = useState<PlatformBanner[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<BannerForm>(emptyForm)
  const createRequestRef = useRef(createRequest ?? 0)

  const load = useCallback(async () => {
    setError("")
    try {
      const result = await api.get<{ banners: PlatformBanner[] }>("/api/v1/admin/banners")
      setBanners(result.banners)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Announcements could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const sortedBanners = useMemo(() => sortPlatformBanners(banners), [banners])

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

  async function save() {
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
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Announcement could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  async function remove(banner: PlatformBanner) {
    if (!window.confirm("Delete this announcement?")) return
    setError("")
    try {
      await api.delete(`/api/v1/admin/banners/${banner.id}`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Announcement could not be deleted.")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Announcement request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="size-4" /> Global announcements
          </CardTitle>
          <CardDescription>
            Scheduled messages appear above login, workspace, administration, and public pages. Higher priority messages appear first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin" /> Loading announcements…
            </div>
          ) : sortedBanners.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No announcements configured.</p>
          ) : (
            sortedBanners.map((banner) => {
              const state = bannerState(banner)
              return (
                <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between" key={banner.id}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={badgeVariant(state)}>{state}</Badge>
                      <Badge variant="outline">{banner.severity}</Badge>
                      <Badge variant="outline">Priority {banner.priority}</Badge>
                      {banner.dismissible && <Badge variant="secondary">Dismissible</Badge>}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{banner.message}</p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <CalendarClock className="size-3.5" />
                      {new Date(banner.startsAt).toLocaleString()} — {banner.endsAt ? new Date(banner.endsAt).toLocaleString() : "No end"}
                      {banner.linkUrl && <a className="underline underline-offset-2" href={banner.linkUrl} rel="noreferrer" target="_blank">Link</a>}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button onClick={() => openEdit(banner)} size="sm" variant="outline">Edit</Button>
                    <Button aria-label="Delete announcement" onClick={() => void remove(banner)} size="icon-sm" variant="ghost">
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit announcement" : "Add announcement"}</DialogTitle>
            <DialogDescription>Choose when the message is active and how it should appear to users.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium sm:col-span-2">
              Message
              <Textarea className="min-h-24" maxLength={1000} value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} placeholder="Scheduled maintenance begins at 22:00 UTC." />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Severity
              <Select value={form.severity} onValueChange={(value) => value && setForm({ ...form, severity: value as BannerForm["severity"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="danger">Danger</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Priority
              <Input min="-1000" step="1" type="number" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium sm:col-span-2">
              Optional link
              <Input type="url" value={form.linkUrl} onChange={(event) => setForm({ ...form, linkUrl: event.target.value })} placeholder="https://status.example.com" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Starts at
              <Input type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Ends at (optional)
              <Input type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} />
            </label>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <p className="text-xs font-medium">Announcement enabled</p>
                <p className="text-xs text-muted-foreground">Only enabled announcements inside the time window are public.</p>
              </div>
              <Switch aria-label="Announcement enabled" checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <p className="text-xs font-medium">Allow dismissal</p>
                <p className="text-xs text-muted-foreground">Users can hide this announcement in their current browser.</p>
              </div>
              <Switch aria-label="Allow announcement dismissal" checked={form.dismissible} onCheckedChange={(dismissible) => setForm({ ...form, dismissible })} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)} variant="outline">Cancel</Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving && <LoaderCircle className="animate-spin" />} {saving ? "Saving…" : "Save announcement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
