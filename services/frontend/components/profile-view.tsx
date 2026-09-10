"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Bot,
  Camera,
  Clock3,
  Flame,
  LogOut,
  MessageSquare,
  NotebookPen,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useRouter } from "next/navigation"

import { api, APIError, resolveAPIURL } from "@/lib/api"
import type { ProfileData, User } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
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
import { Skeleton } from "@/components/ui/skeleton"

type ProfileViewProps = { user: User }

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
    <Card>
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
          <div className="flex min-w-[720px] gap-2">
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

export function ProfileView({ user }: ProfileViewProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [avatarVersion, setAvatarVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    void api
      .get<ProfileData>("/api/v1/profile", { signal: controller.signal })
      .then(setProfile)
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
  }, [])

  const initials =
    user.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "U"
  const avatarURL = profile?.avatarUrl || user.avatarUrl
  const streak = profile ? calculateStreak(profile.activity) : 0

  async function uploadAvatar(file: File) {
    setError("")
    if (file.size > 2 * 1024 * 1024) {
      setError("Profile pictures are limited to 2 MB.")
      return
    }
    setBusy(true)
    try {
      const body = new FormData()
      body.append("avatar", file)
      const result = await api.upload<{ avatarUrl: string }>(
        "/api/v1/profile/avatar",
        body
      )
      setProfile((current) =>
        current ? { ...current, avatarUrl: result.avatarUrl } : current
      )
      setAvatarVersion((current) => current + 1)
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
        current ? { ...current, avatarUrl: "" } : current
      )
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
          value: `${streak} ${streak === 1 ? "day" : "days"}`,
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
          label: "Notes created",
          value: profile.stats.notes.toLocaleString(),
          icon: NotebookPen,
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
      <Card>
        <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="relative self-start">
            <Avatar className="size-20!">
              {avatarURL && (
                <AvatarImage
                  src={`${resolveAPIURL(avatarURL)}?v=${avatarVersion}`}
                  alt={`${user.displayName}'s profile picture`}
                />
              )}
              <AvatarFallback className="text-xl font-medium">
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
                if (file) void uploadAvatar(file)
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-xl font-semibold">
                {user.displayName}
              </h2>
              <Badge variant="outline">
                <ShieldCheck data-icon="inline-start" />
                {user.platformAdmin
                  ? "Platform administrator"
                  : "Workspace member"}
              </Badge>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {user.email}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {profile
                ? `Member since ${dayFormatter.format(new Date(profile.createdAt))}`
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
            {avatarURL && (
              <Button
                aria-label="Remove profile picture"
                disabled={busy}
                onClick={() => void removeAvatar()}
                size="icon-sm"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <PageSection
        title="At a glance"
        description="A few signals from your work across JustAI."
      >
        {profile ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
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
        </div>
      )}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Sign out of JustAI on this device.</CardDescription>
          <CardAction>
            <Button onClick={() => void logout()} size="sm" variant="outline">
              <LogOut data-icon="inline-start" />
              Sign out
            </Button>
          </CardAction>
        </CardHeader>
      </Card>
    </Page>
  )
}
