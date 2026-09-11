"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Bot,
  Camera,
  Check,
  Clock3,
  Flame,
  KeyRound,
  Link2,
  LogOut,
  MessageSquare,
  MonitorSmartphone,
  NotebookPen,
  Pencil,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { useRouter } from "next/navigation"

import { api, APIError, resolveAPIURL } from "@/lib/api"
import type {
  AccountIdentity,
  AccountSession,
  Organization,
  ProfileData,
  User,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Page,
  PageDescription,
  PageEyebrow,
  PageHeader,
  PageHeading,
  PageSection,
  PageTitle,
} from "@/components/ui/page"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { avatarToneFor, initialsFor, versionedAvatarURL } from "@/lib/identity"

type ProfileViewProps = {
  user: User
  organization?: Organization
  onUserChange?: (user: User) => void
}

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function calculateStreak(activity: ProfileData["activity"]) {
  const active = new Set(
    activity.filter((day) => day.count > 0).map((day) => day.date)
  )
  const cursor = new Date()
  cursor.setHours(12, 0, 0, 0)
  if (!active.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (active.has(dateKey(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function deviceLabel(userAgent: string) {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "Apple mobile device"
  if (/Android/i.test(userAgent)) return "Android device"
  if (/Macintosh|Mac OS/i.test(userAgent)) return "Mac browser"
  if (/Windows/i.test(userAgent)) return "Windows browser"
  if (/Linux/i.test(userAgent)) return "Linux browser"
  return userAgent || "Unknown device"
}

function ActivityHeatmap({ activity }: { activity: ProfileData["activity"] }) {
  const days = useMemo(() => {
    const counts = new Map(activity.map((day) => [day.date, day.count]))
    const end = new Date()
    end.setHours(12, 0, 0, 0)
    const start = new Date(end)
    start.setDate(start.getDate() - 364 - start.getDay())
    const result: Array<{ date: Date; key: string; count: number }> = []
    const cursor = new Date(start)
    while (cursor <= end) {
      const key = dateKey(cursor)
      result.push({ date: new Date(cursor), key, count: counts.get(key) ?? 0 })
      cursor.setDate(cursor.getDate() + 1)
    }
    return result
  }, [activity])
  const max = Math.max(1, ...days.map((day) => day.count))
  const total = activity.reduce((sum, day) => sum + day.count, 0)

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">Your year in JustAI</CardTitle>
        <CardDescription>
          {total.toLocaleString()} actions across the last 365 days
        </CardDescription>
        <CardAction>
          <Badge variant="secondary">
            {activity.filter((day) => day.count > 0).length} active days
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto pb-1">
          <div className="mx-auto flex w-max min-w-[720px] gap-2">
            <div className="grid grid-rows-7 gap-1 pt-5 text-[10px] leading-3 text-muted-foreground">
              <span />
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
            </div>
            <div>
              <div className="mb-2 flex justify-between text-[10px] text-muted-foreground">
                <span>{dayFormatter.format(days[0]?.date ?? new Date())}</span>
                <span>Today</span>
              </div>
              <div
                className="grid grid-flow-col grid-rows-7 gap-1"
                aria-label="Activity over the last year"
              >
                {days.map((day) => {
                  const ratio = day.count / max
                  const level =
                    day.count === 0
                      ? 0
                      : ratio > 0.66
                        ? 4
                        : ratio > 0.33
                          ? 3
                          : ratio > 0.12
                            ? 2
                            : 1
                  return (
                    <span
                      aria-label={`${day.count} actions on ${dayFormatter.format(day.date)}`}
                      className={cn(
                        "size-2.5 rounded-[3px] bg-muted sm:size-3",
                        level === 1 && "bg-primary/25",
                        level === 2 && "bg-primary/45",
                        level === 3 && "bg-primary/70",
                        level === 4 && "bg-primary"
                      )}
                      key={day.key}
                      role="img"
                      title={`${day.count} actions on ${dayFormatter.format(day.date)}`}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>Less</span>
          {[
            "bg-muted",
            "bg-primary/25",
            "bg-primary/45",
            "bg-primary/70",
            "bg-primary",
          ].map((color) => (
            <span className={cn("size-2.5 rounded-[3px]", color)} key={color} />
          ))}
          <span>More</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function ProfileView({
  user,
  organization,
  onUserChange,
}: ProfileViewProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [avatarURL, setAvatarURL] = useState(user.avatarUrl ?? "")
  const [avatarVersion, setAvatarVersion] = useState(user.avatarVersion ?? "")
  const [pendingAvatar, setPendingAvatar] = useState<{
    file: File
    previewURL: string
  } | null>(null)
  const [removeAvatarOpen, setRemoveAvatarOpen] = useState(false)
  const [displayName, setDisplayName] = useState(user.displayName)
  const [editingName, setEditingName] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [sessions, setSessions] = useState<AccountSession[]>([])
  const [identities, setIdentities] = useState<AccountIdentity[]>([])
  const [accountLoading, setAccountLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    void api
      .get<ProfileData>(
        `/api/v1/profile?timezone=${encodeURIComponent(timezone)}`,
        { signal: controller.signal }
      )
      .then((result) => {
        setProfile(result)
        setAvatarURL(result.avatarUrl || "")
        setAvatarVersion(result.avatarVersion || user.avatarVersion || "")
      })
      .catch((caught) => {
        if (caught instanceof APIError && caught.code === "request_aborted")
          return
        setError(
          caught instanceof Error
            ? caught.message
            : "Profile activity could not be loaded."
        )
      })
    return () => controller.abort()
  }, [user.avatarVersion, user.id])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get<{ sessions: AccountSession[] }>("/api/v1/auth/sessions"),
      api.get<{ identities: AccountIdentity[] }>("/api/v1/auth/identities"),
    ])
      .then(([sessionResult, identityResult]) => {
        if (cancelled) return
        setSessions(sessionResult.sessions)
        setIdentities(identityResult.identities)
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Account security details could not be loaded."
          )
        }
      })
      .finally(() => {
        if (!cancelled) setAccountLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user.id])

  useEffect(() => {
    return () => {
      if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.previewURL)
    }
  }, [pendingAvatar])

  const initials = initialsFor(user.displayName)
  const avatarSrc = versionedAvatarURL(avatarURL, avatarVersion)
  const streak = profile ? calculateStreak(profile.activity) : 0

  function prepareAvatar(file: File | undefined) {
    if (!file) return
    setError("")
    setNotice("")
    if (file.size > 2 * 1024 * 1024) {
      setError("Profile pictures are limited to 2 MB.")
      return
    }
    if (!file.type.startsWith("image/")) {
      setError("Choose a PNG, JPEG, GIF, or WebP image.")
      return
    }
    if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.previewURL)
    setPendingAvatar({ file, previewURL: URL.createObjectURL(file) })
  }

  function cancelAvatarPreview() {
    if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.previewURL)
    setPendingAvatar(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  async function uploadAvatar(file: File) {
    setError("")
    setBusy(true)
    try {
      const body = new FormData()
      body.append("avatar", file)
      const result = await api.upload<{
        avatarUrl: string
        avatarVersion?: string
      }>("/api/v1/profile/avatar", body)
      const nextVersion = result.avatarVersion || String(Date.now())
      setProfile((current) =>
        current
          ? {
              ...current,
              avatarUrl: result.avatarUrl,
              avatarVersion: nextVersion,
            }
          : current
      )
      setAvatarURL(result.avatarUrl)
      setAvatarVersion(nextVersion)
      onUserChange?.({
        ...user,
        avatarUrl: result.avatarUrl,
        avatarVersion: nextVersion,
      })
      setNotice("Profile picture updated.")
      cancelAvatarPreview()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The profile picture could not be uploaded."
      )
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  async function removeAvatar() {
    setBusy(true)
    setError("")
    try {
      await api.delete("/api/v1/profile/avatar")
      setProfile((current) =>
        current ? { ...current, avatarUrl: "", avatarVersion: "" } : current
      )
      setAvatarURL("")
      setAvatarVersion("")
      onUserChange?.({ ...user, avatarUrl: "", avatarVersion: "" })
      setRemoveAvatarOpen(false)
      setNotice("Profile picture removed.")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The profile picture could not be removed."
      )
    } finally {
      setBusy(false)
    }
  }

  async function saveDisplayName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextName = displayName.trim()
    if (!nextName) {
      setError("Display name is required.")
      return
    }
    if (nextName === user.displayName) return
    setSavingName(true)
    setError("")
    setNotice("")
    try {
      const result = await api.patch<{ user: User }>("/api/v1/profile", {
        displayName: nextName,
      })
      setDisplayName(result.user.displayName)
      onUserChange?.({ ...user, ...result.user })
      setEditingName(false)
      setNotice("Display name updated.")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Display name could not be updated."
      )
    } finally {
      setSavingName(false)
    }
  }

  async function revokeSession(session: AccountSession) {
    if (session.current) return
    setBusy(true)
    setError("")
    try {
      await api.delete(`/api/v1/auth/sessions/${session.id}`)
      setSessions((current) => current.filter((item) => item.id !== session.id))
      setNotice("Device signed out.")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Device could not be signed out."
      )
    } finally {
      setBusy(false)
    }
  }

  async function revokeOtherSessions() {
    setBusy(true)
    setError("")
    try {
      await api.post("/api/v1/auth/sessions/revoke-others")
      setSessions((current) => current.filter((session) => session.current))
      setNotice("Other devices have been signed out.")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Other devices could not be signed out."
      )
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    try {
      await api.post("/api/v1/auth/logout")
    } finally {
      api.setOrganizationId(null)
      router.push("/login")
    }
  }

  const statCards = profile
    ? [
        {
          label: "Current streak",
          value: `${profile.stats.currentStreak ?? streak} ${(profile.stats.currentStreak ?? streak) === 1 ? "day" : "days"}`,
          icon: Flame,
        },
        {
          label: "Longest streak",
          value: `${profile.stats.longestStreak ?? streak} days`,
          icon: Flame,
        },
        {
          label: "Prompts sent",
          value: profile.stats.prompts.toLocaleString(),
          icon: MessageSquare,
        },
        {
          label: "Agent runs",
          value: profile.stats.agentRuns.toLocaleString(),
          icon: Bot,
        },
        {
          label: "Productive weekday",
          value: profile.stats.productiveWeekday || "—",
          icon: NotebookPen,
        },
        {
          label: "Last 30 days",
          value:
            profile.stats.previous30DaysActions &&
            profile.stats.previous30DaysActions > 0
              ? `${Math.round(((profile.stats.last30DaysActions ?? 0) / profile.stats.previous30DaysActions - 1) * 100)}%`
              : `${(profile.stats.last30DaysActions ?? 0).toLocaleString()} actions`,
          icon: Sparkles,
        },
      ]
    : []

  return (
    <Page className="max-w-6xl">
      <PageHeader>
        <PageHeading>
          <PageEyebrow>Account</PageEyebrow>
          <PageTitle>Profile</PageTitle>
          <PageDescription>
            Your identity, activity, and creative footprint in JustAI.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert aria-live="polite">
          <Check />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="relative self-start">
            <Avatar className="size-20!">
              {avatarSrc && (
                <AvatarImage
                  src={resolveAPIURL(avatarSrc)}
                  alt={`${user.displayName}'s profile picture`}
                />
              )}
              <AvatarFallback
                className={cn("text-xl font-medium", avatarToneFor(user.id))}
              >
                {initials}
              </AvatarFallback>
            </Avatar>
            <Button
              aria-label="Upload profile picture"
              className="absolute -right-0.5 -bottom-0.5 size-7! rounded-full [&_svg]:size-3.5!"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              size="icon-xs"
            >
              <Camera aria-hidden="true" />
            </Button>
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0]
                prepareAvatar(file)
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {editingName ? (
                <form
                  className="flex min-w-0 items-center gap-2"
                  onSubmit={(event) => void saveDisplayName(event)}
                >
                  <Input
                    aria-label="Display name"
                    autoComplete="name"
                    className="font-heading h-8 max-w-64 text-base font-semibold"
                    maxLength={120}
                    onChange={(event) => setDisplayName(event.target.value)}
                    value={displayName}
                    autoFocus
                  />
                  <Button
                    aria-label="Save display name"
                    disabled={savingName || !displayName.trim()}
                    size="icon-xs"
                    type="submit"
                  >
                    <Check />
                  </Button>
                  <Button
                    aria-label="Cancel editing display name"
                    disabled={savingName}
                    onClick={() => {
                      setDisplayName(user.displayName)
                      setEditingName(false)
                    }}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                </form>
              ) : (
                <div className="flex min-w-0 items-center gap-1">
                  <h2 className="font-heading truncate text-xl font-semibold">
                    {user.displayName}
                  </h2>
                  <Button
                    aria-label="Edit display name"
                    onClick={() => setEditingName(true)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                </div>
              )}
              <Badge variant="outline">
                <ShieldCheck data-icon="inline-start" />
                {user.platformAdmin
                  ? "Platform administrator"
                  : organization?.role
                    ? `${organization.role} · ${organization.name}`
                    : "Workspace member"}
              </Badge>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {user.email}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {profile
                ? `Account created ${dayFormatter.format(new Date(profile.createdAt))}`
                : "Loading membership details…"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:self-start">
            <Button
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              size="sm"
              variant="outline"
            >
              <Camera data-icon="inline-start" />
              Change photo
            </Button>
            {avatarSrc && (
              <Button
                aria-label="Remove profile picture"
                disabled={busy}
                onClick={() => setRemoveAvatarOpen(true)}
                size="icon-sm"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={Boolean(pendingAvatar)}
        onOpenChange={(open) => {
          if (!open && !busy) cancelAvatarPreview()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preview profile picture</DialogTitle>
            <DialogDescription>
              The square crop keeps your face centered in account menus and
              member lists.
            </DialogDescription>
          </DialogHeader>
          <div className="mx-auto flex size-48 items-center justify-center overflow-hidden rounded-full bg-muted">
            {pendingAvatar && (
              <Avatar className="size-48">
                <AvatarImage
                  alt="Profile picture preview"
                  className="size-full object-cover"
                  src={pendingAvatar.previewURL}
                />
              </Avatar>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={cancelAvatarPreview}
              variant="outline"
            >
              <X data-icon="inline-start" />
              Cancel
            </Button>
            <Button
              disabled={busy || !pendingAvatar}
              onClick={() => {
                if (pendingAvatar) void uploadAvatar(pendingAvatar.file)
              }}
            >
              <Check data-icon="inline-start" />
              {busy ? "Uploading…" : "Use this photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog
        confirmLabel="Remove photo"
        description="Your profile will use initials everywhere until you upload a new picture."
        onConfirm={() => void removeAvatar()}
        onOpenChange={setRemoveAvatarOpen}
        open={removeAvatarOpen}
        pending={busy}
        title="Remove profile picture?"
      />
      <PageSection
        title="At a glance"
        description="A few signals from your work across JustAI."
      >
        {profile ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {statCards.map(({ label, value, icon: Icon }) => (
              <Card size="sm" key={label}>
                <CardHeader>
                  <CardDescription>{label}</CardDescription>
                  <CardAction>
                    <Icon
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <p className="font-heading text-2xl font-semibold tracking-tight">
                    {value}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton className="h-24 rounded-2xl" key={index} />
            ))}
          </div>
        )}
      </PageSection>
      {profile ? (
        <ActivityHeatmap activity={profile.activity} />
      ) : (
        <Skeleton className="h-56 rounded-2xl" />
      )}
      {profile && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card size="sm">
            <CardHeader>
              <Sparkles className="mb-2 size-5 text-primary" />
              <CardTitle>
                {profile.stats.conversations.toLocaleString()} conversations
              </CardTitle>
              <CardDescription>
                Threads you have started and shaped.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <Clock3 className="mb-2 size-5 text-primary" />
              <CardTitle>
                {profile.stats.transcriptionMinutes.toLocaleString()} minutes
                captured
              </CardTitle>
              <CardDescription>
                Time turned into searchable transcripts.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <Flame className="mb-2 size-5 text-primary" />
              <CardTitle>
                {profile.activity.filter((day) => day.count > 0).length} active
                days
              </CardTitle>
              <CardDescription>
                Days you made something happen this year.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <Bot className="mb-2 size-5 text-primary" />
              <CardTitle>
                {profile.stats.favoriteAgent || "No favorite agent yet"}
              </CardTitle>
              <CardDescription>
                Most-used saved agent by conversation.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <KeyRound className="mb-2 size-5 text-primary" />
              <CardTitle>
                {profile.stats.favoriteModel || "No model preference yet"}
              </CardTitle>
              <CardDescription>
                Model used most often in completed runs.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <Sparkles className="mb-2 size-5 text-primary" />
              <CardTitle>
                {profile.stats.milestones?.length
                  ? profile.stats.milestones.join(" · ")
                  : "First milestone ahead"}
              </CardTitle>
              <CardDescription>
                Milestones based on your activity this year.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )}
      <PageSection
        title="Account security"
        description="Manage your active devices and connected sign-in methods."
      >
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <Card className="h-full" size="sm">
            <CardHeader>
              <CardTitle>Sessions and devices</CardTitle>
              <CardDescription>
                Review devices with access to your account.
              </CardDescription>
              <CardAction>
                <MonitorSmartphone
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </CardAction>
            </CardHeader>
            <CardContent>
              {accountLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Skeleton className="size-8 rounded-full" /> Loading sessions…
                </div>
              ) : sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active sessions found.
                </p>
              ) : (
                <div className="divide-y rounded-xl bg-muted/30">
                  {sessions.map((session) => (
                    <div
                      className="flex flex-wrap items-center gap-3 p-3"
                      key={session.id}
                    >
                      <span className="flex size-8 items-center justify-center rounded-full bg-background text-muted-foreground">
                        <MonitorSmartphone aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {deviceLabel(session.userAgent)}
                          {session.current && (
                            <Badge
                              className="ml-2 align-middle"
                              variant="secondary"
                            >
                              This device
                            </Badge>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          Last active{" "}
                          {dayFormatter.format(new Date(session.lastSeenAt))}
                        </p>
                      </div>
                      {!session.current && (
                        <Button
                          disabled={busy}
                          onClick={() => void revokeSession(session)}
                          size="sm"
                          variant="ghost"
                        >
                          Sign out
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
            <CardFooter className="flex-wrap justify-between gap-2 border-t">
              <Button onClick={() => void logout()} size="sm" variant="outline">
                <LogOut data-icon="inline-start" />
                Sign out
              </Button>
              <Button
                disabled={busy || accountLoading || sessions.length < 2}
                onClick={() => void revokeOtherSessions()}
                size="sm"
                variant="ghost"
              >
                Sign out other devices
              </Button>
            </CardFooter>
          </Card>
          <Card className="h-full" size="sm">
            <CardHeader>
              <CardTitle>Linked sign-in methods</CardTitle>
              <CardDescription>
                Identity providers connected to your account.
              </CardDescription>
              <CardAction>
                <Link2
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </CardAction>
            </CardHeader>
            <CardContent>
              {accountLoading ? (
                <Skeleton className="h-12 rounded-xl" />
              ) : identities.length === 0 ? (
                <div className="flex items-center gap-3 rounded-xl bg-muted/30 p-3 text-sm text-muted-foreground">
                  <KeyRound aria-hidden="true" />
                  No external identity providers are linked.
                </div>
              ) : (
                <div className="divide-y rounded-xl bg-muted/30">
                  {identities.map((identity) => (
                    <div
                      className="flex items-center gap-3 p-3"
                      key={`${identity.provider}-${identity.createdAt}`}
                    >
                      <span className="flex size-8 items-center justify-center rounded-full bg-background text-muted-foreground">
                        <Link2 aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {identity.provider}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          Linked{" "}
                          {dayFormatter.format(new Date(identity.createdAt))}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </PageSection>
    </Page>
  )
}
