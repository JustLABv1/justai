"use client"

import { ProfileUsageSection } from "@/components/profile-usage-section"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/panelui/select"
import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Bot,
  Camera,
  Check,
  Flame,
  KeyRound,
  Link2,
  LogOut,
  MessageSquare,
  MonitorSmartphone,
  Pencil,
  ShieldCheck,
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
import { Tabs } from "@/components/panelui/tabs"
import { Frame } from "@/components/panelui/frame"
import { DayGrid } from "@/components/panelui/day-grid"
import { buildProfileDays } from "@/lib/profile-day-grid"
import { toast as profileToasts } from "@/components/ui/toast"
import { Avatar } from "@/components/panelui/avatar"
import { Stat } from "@/components/panelui/stat"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/panelui/card"
import {
  Page,
  PageDescription,
  PageHeader,
  PageHeading,
  PageSection,
  PageTitle,
} from "@/components/ui/page"
import { Dialog } from "@/components/panelui/dialog"
import { Input } from "@/components/panelui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { versionedAvatarURL } from "@/lib/identity"

type ProfileViewProps = {
  user: User
  organization?: Organization
  onUserChange?: (user: User) => void
}

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

function ProfileActivityGrid({
  activity,
}: {
  activity: ProfileData["activity"]
}) {
  const { t, locale } = useTranslations()
  const calendar = useMemo(() => buildProfileDays(activity), [activity])
  const [selected, setSelected] = useState(89)
  const day = calendar.days[selected]
  const formatDate = (date: Date) =>
    date.toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
  const cells = calendar.days.map((day) => ({
    level: day.level,
    label: t("{value0} actions on {value1}", {
      value0: day.count.toLocaleString(locale),
      value1: formatDate(day.date),
    }),
  }))
  const total = calendar.days.reduce((sum, day) => sum + day.count, 0)
  const active = calendar.days.filter((day) => day.count > 0).length
  return (
    <Frame variant="band">
      <Frame.Header>
        <Frame.Title>{t("Activity rhythm")}</Frame.Title>
        <Frame.Description>{t("Last 90 days")}</Frame.Description>
        <Frame.Action>
          <Badge variant="secondary">
            {active} {t("active days")}
          </Badge>
        </Frame.Action>
      </Frame.Header>
      <Frame.Panel className="p-4 sm:p-5">
        <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,22rem)_1fr] sm:gap-8">
          <div className="min-w-0">
            <div className="flex gap-3">
              <DayGrid.Weekdays
                labels={Array.from({ length: 7 }, (_, index) =>
                  new Date(2026, 0, 5 + index).toLocaleDateString(locale, {
                    weekday: "short",
                  })
                )}
              />
              <DayGrid
                cells={cells}
                rows={7}
                offset={calendar.offset}
                value={selected}
                onValueChange={setSelected}
                color="primary"
                label={t("Last 90 days")}
                summary={({ active, total }) =>
                  t("{value0} active days out of {value1}", {
                    value0: active,
                    value1: total,
                  })
                }
              />
            </div>
            <div className="mt-3 flex justify-between gap-2 text-xs text-muted-foreground">
              <span>{formatDate(calendar.days[0].date)}</span>
              <span>{formatDate(calendar.days[89].date)}</span>
            </div>
            <DayGrid.Legend
              className="mt-4"
              color="primary"
              less={t("Less")}
              more={t("More")}
            />
          </div>
          <div className="flex flex-col gap-5">
            <div>
              <p className="text-2xl font-semibold tabular-nums">
                {total.toLocaleString(locale)}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("actions in the last 90 days")}
              </p>
            </div>
            <DayGrid.Caption>
              <DayGrid.Title>
                {t("{value0} actions on {value1}", {
                  value0: day.count.toLocaleString(locale),
                  value1: formatDate(day.date),
                })}
              </DayGrid.Title>
              <DayGrid.Description>
                {t("Select a day to see its activity.")}
              </DayGrid.Description>
            </DayGrid.Caption>
          </div>
        </div>
      </Frame.Panel>
    </Frame>
  )
}

export function ProfileView({
  user,
  organization,
  onUserChange,
}: ProfileViewProps) {
  const { t, locale, setLocale } = useTranslations()
  const dayFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

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
  const showErrorToast = useCallback(
    (message: string) => {
      if (message)
        profileToasts.add({
          title: t(message),
          type: "destructive",
          priority: "high",
          timeout: 10000,
        })
    },
    [t]
  )
  const showSuccessToast = useCallback(
    (message: string) => {
      if (message) profileToasts.add({ title: t(message), type: "success" })
    },
    [t]
  )

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
        showErrorToast(
          caught instanceof Error
            ? caught.message
            : "Profile activity could not be loaded."
        )
      })
    return () => controller.abort()
  }, [user.avatarVersion, user.id, showErrorToast])

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
          showErrorToast(
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
  }, [user.id, showErrorToast])

  useEffect(() => {
    return () => {
      if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.previewURL)
    }
  }, [pendingAvatar])

  const avatarSrc = versionedAvatarURL(avatarURL, avatarVersion)
  const streak = profile ? calculateStreak(profile.activity) : 0

  function prepareAvatar(file: File | undefined) {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      showErrorToast("Profile pictures are limited to 2 MB.")
      return
    }
    if (!file.type.startsWith("image/")) {
      showErrorToast("Choose a PNG, JPEG, GIF, or WebP image.")
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
      showSuccessToast("Profile picture updated.")
      cancelAvatarPreview()
    } catch (caught) {
      showErrorToast(
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
    try {
      await api.delete("/api/v1/profile/avatar")
      setProfile((current) =>
        current ? { ...current, avatarUrl: "", avatarVersion: "" } : current
      )
      setAvatarURL("")
      setAvatarVersion("")
      onUserChange?.({ ...user, avatarUrl: "", avatarVersion: "" })
      setRemoveAvatarOpen(false)
      showSuccessToast("Profile picture removed.")
    } catch (caught) {
      showErrorToast(
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
      showErrorToast("Display name is required.")
      return
    }
    if (nextName === user.displayName) return
    setSavingName(true)
    try {
      const result = await api.patch<{ user: User }>("/api/v1/profile", {
        displayName: nextName,
      })
      setDisplayName(result.user.displayName)
      onUserChange?.({ ...user, ...result.user })
      setEditingName(false)
      showSuccessToast("Display name updated.")
    } catch (caught) {
      showErrorToast(
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
    try {
      await api.delete(`/api/v1/auth/sessions/${session.id}`)
      setSessions((current) => current.filter((item) => item.id !== session.id))
      showSuccessToast("Device signed out.")
    } catch (caught) {
      showErrorToast(
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
    try {
      await api.post("/api/v1/auth/sessions/revoke-others")
      setSessions((current) => current.filter((session) => session.current))
      showSuccessToast("Other devices have been signed out.")
    } catch (caught) {
      showErrorToast(
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

  const metricGroups = profile
    ? [
        {
          title: t("Consistency"),
          icon: Flame,
          metrics: [
            {
              label: t("Current streak"),
              value: `${profile.stats.currentStreak ?? streak} ${(profile.stats.currentStreak ?? streak) === 1 ? t("day") : t("days")}`,
            },
            {
              label: t("Longest streak"),
              value: `${profile.stats.longestStreak ?? streak} ${(profile.stats.longestStreak ?? streak) === 1 ? t("day") : t("days")}`,
            },
          ],
        },
        {
          title: t("Conversations"),
          icon: MessageSquare,
          metrics: [
            {
              label: t("conversations"),
              value: profile.stats.conversations.toLocaleString(locale),
            },
            {
              label: t("Prompts sent"),
              value: profile.stats.prompts.toLocaleString(locale),
            },
          ],
        },
        {
          title: t("Capture & agents"),
          icon: Bot,
          metrics: [
            {
              label: t("minutes captured"),
              value: profile.stats.transcriptionMinutes.toLocaleString(locale),
            },
            {
              label: t("Agent runs"),
              value: profile.stats.agentRuns.toLocaleString(locale),
            },
          ],
        },
      ]
    : []

  return (
    <Page className="max-w-6xl">
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("Profile")}</PageTitle>
          <PageDescription>
            {t("Your identity, activity, and creative footprint in JustAI.")}
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <Card>
        <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="relative self-start">
            <Avatar
              className="size-16!"
              name={user.displayName}
              src={avatarSrc ? resolveAPIURL(avatarSrc) : undefined}
            />
            <Button
              aria-label={t("Upload profile picture")}
              className="absolute -right-0.5 -bottom-0.5 size-7! rounded-full [&_svg]:size-3.5!"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              size="icon-sm"
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
                    aria-label={t("Display name")}
                    autoComplete="name"
                    className="font-heading h-8 max-w-64 text-base font-semibold"
                    maxLength={120}
                    onChange={(event) => setDisplayName(event.target.value)}
                    value={displayName}
                    autoFocus
                  />
                  <Button
                    aria-label={t("Save display name")}
                    disabled={savingName || !displayName.trim()}
                    size="icon-sm"
                    type="submit"
                  >
                    <Check />
                  </Button>
                  <Button
                    aria-label={t("Cancel editing display name")}
                    disabled={savingName}
                    onClick={() => {
                      setDisplayName(user.displayName)
                      setEditingName(false)
                    }}
                    size="icon-sm"
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
                    aria-label={t("Edit display name")}
                    onClick={() => setEditingName(true)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                </div>
              )}
              <Badge variant="outline">
                <ShieldCheck data-icon="inline-start" />
                {user.platformAdmin
                  ? t("Platform administrator")
                  : organization?.role
                    ? `${organization.role} · ${organization.name}`
                    : t("Workspace member")}
              </Badge>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {user.email}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {profile
                ? t("Account created {value0}", {
                    value0: dayFormatter.format(new Date(profile.createdAt)),
                  })
                : t("Loading membership details…")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:self-start">
            <Button
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              size="sm"
              variant="outline"
            >
              <Camera data-icon="inline-start" />
              {t("Change photo")}
            </Button>
            {avatarSrc && (
              <Button
                aria-label={t("Remove profile picture")}
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
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{t("Preview profile picture")}</Dialog.Title>
            <Dialog.Description>
              {t(
                "The square crop keeps your face centered in account menus and member lists."
              )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <div className="mx-auto flex size-48 items-center justify-center overflow-hidden rounded-full bg-muted">
              {pendingAvatar && (
                <Avatar
                  className="size-48!"
                  name={user.displayName}
                  src={pendingAvatar.previewURL}
                />
              )}
            </div>
          </Dialog.Body>
          <Dialog.Footer>
            <Button
              disabled={busy}
              onClick={cancelAvatarPreview}
              variant="outline"
            >
              <X data-icon="inline-start" />
              {t("Cancel")}
            </Button>
            <Button
              disabled={busy || !pendingAvatar}
              onClick={() => {
                if (pendingAvatar) void uploadAvatar(pendingAvatar.file)
              }}
            >
              <Check data-icon="inline-start" />
              {busy ? t("Uploading…") : t("Use this photo")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
      <ConfirmActionDialog
        confirmLabel={t("Remove photo")}
        description={t(
          "Your profile will use initials everywhere until you upload a new picture."
        )}
        onConfirm={() => void removeAvatar()}
        onOpenChange={setRemoveAvatarOpen}
        open={removeAvatarOpen}
        pending={busy}
        title={t("Remove profile picture?")}
      />
      <Tabs defaultValue="activity" className="gap-5">
        <Tabs.List aria-label={t("Profile sections")}>
          <Tabs.Trigger value="activity">{t("Activity")}</Tabs.Trigger>
          <Tabs.Trigger value="usage">{t("Usage")}</Tabs.Trigger>
          <Tabs.Trigger value="account">{t("Account")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="activity" className="flex flex-col gap-5">
          {profile ? (
            <ProfileActivityGrid activity={profile.activity} />
          ) : (
            <Skeleton className="h-56 rounded-2xl" />
          )}
          <PageSection
            title={t("At a glance")}
            description={t("A few signals from your work across JustAI.")}
          >
            <Card size="sm">
              <CardContent className="grid divide-y p-0! lg:grid-cols-3 lg:divide-x lg:divide-y-0">
                {profile
                  ? metricGroups.map(({ title, icon: Icon, metrics }) => (
                      <section
                        key={title}
                        className="min-w-0 p-5"
                        aria-label={title}
                      >
                        <h3 className="mb-4 flex items-center gap-2 text-sm font-medium">
                          <Icon
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                          />
                          {title}
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                          {metrics.map(({ label, value }) => (
                            <Stat key={label}>
                              <Stat.Content>
                                <Stat.Label className="text-xs">
                                  {label}
                                </Stat.Label>
                                <Stat.Value size="sm">{value}</Stat.Value>
                              </Stat.Content>
                            </Stat>
                          ))}
                        </div>
                      </section>
                    ))
                  : Array.from({ length: 3 }, (_, index) => (
                      <div key={index} className="p-5">
                        <Skeleton className="mb-4 h-4 w-24" />
                        <Skeleton className="h-12" />
                      </div>
                    ))}
              </CardContent>
            </Card>
          </PageSection>
          {profile && (
            <div className="flex flex-col gap-4">
              <Frame>
                <Frame.Panel>
                  {[
                    {
                      label: t("Favorite agent"),
                      value:
                        profile.stats.favoriteAgent ||
                        t("No favorite agent yet"),
                      description: t("Most-used saved agent by conversation."),
                    },
                    {
                      label: t("Favorite model"),
                      value:
                        profile.stats.favoriteModel ||
                        t("No model preference yet"),
                      description: t(
                        "Model used most often in completed runs."
                      ),
                    },
                    {
                      label: t("Productive weekday"),
                      value: t(profile.stats.productiveWeekday || "—"),
                      description: "",
                    },
                    {
                      label: t("Milestones"),
                      value: profile.stats.milestones?.length
                        ? profile.stats.milestones.join(" · ")
                        : t("First milestone ahead"),
                      description: t(
                        "Milestones based on your activity this year."
                      ),
                    },
                  ].map((item) => (
                    <Frame.Row
                      key={item.label}
                      className="flex-wrap gap-y-2 py-4"
                    >
                      <Frame.Content>
                        <Frame.Title as="p">{item.label}</Frame.Title>
                        <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                          {item.description}
                        </Frame.Description>
                      </Frame.Content>
                      <p className="max-w-full text-sm font-medium break-words sm:max-w-[50%]">
                        {item.value}
                      </p>
                    </Frame.Row>
                  ))}
                </Frame.Panel>
              </Frame>
            </div>
          )}
        </Tabs.Content>
        <Tabs.Content value="usage" className="flex flex-col gap-5">
          <ProfileUsageSection />
        </Tabs.Content>
        <Tabs.Content value="account" className="flex flex-col gap-5">
          <Frame>
            <Frame.Panel>
              <Frame.Row className="flex-wrap gap-3">
                <Frame.Content>
                  <Frame.Title as="p">{t("Language")}</Frame.Title>
                  <Frame.Description>
                    {t("Choose the language used throughout JustAI.")}
                  </Frame.Description>
                </Frame.Content>
                <Frame.Actions>
                  <Select
                    value={locale}
                    onValueChange={(value) => {
                      if (value === "de" || value === "en") setLocale(value)
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-40"
                      aria-label={t("Choose language")}
                    >
                      <SelectValue>
                        {locale === "de" ? "Deutsch" : "English"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="de">Deutsch</SelectItem>
                        <SelectItem value="en">English</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Frame.Actions>
              </Frame.Row>
            </Frame.Panel>
          </Frame>
          <PageSection
            title={t("Account security")}
            description={t(
              "Manage your active devices and connected sign-in methods."
            )}
          >
            <div className="grid items-start gap-3 lg:grid-cols-2">
              <Card size="sm" className="h-full">
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle>{t("Sessions and devices")}</CardTitle>
                    {!accountLoading && (
                      <Badge variant="secondary">
                        {sessions.length.toLocaleString(locale)}
                      </Badge>
                    )}
                  </div>
                  <CardDescription>
                    {t("Review devices with access to your account.")}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {accountLoading ? (
                    <div className="flex items-center gap-3 py-2">
                      <Skeleton className="size-10 rounded-xl" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-44" />
                      </div>
                    </div>
                  ) : sessions.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">
                      {t("No active sessions found.")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {[...sessions]
                        .sort((a, b) => Number(b.current) - Number(a.current))
                        .map((session) => (
                          <li
                            key={session.id}
                            className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
                          >
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                              <MonitorSmartphone
                                aria-hidden="true"
                                className="size-5"
                              />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <p className="text-sm font-medium">
                                  {t(deviceLabel(session.userAgent))}
                                </p>
                                {session.current && (
                                  <Badge
                                    variant="outline"
                                    className="h-5 text-[11px]"
                                  >
                                    {t("This device")}
                                  </Badge>
                                )}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {t("Last active")}{" "}
                                {dayFormatter.format(
                                  new Date(session.lastSeenAt)
                                )}
                              </p>
                            </div>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                session.current
                                  ? void logout()
                                  : void revokeSession(session)
                              }
                              size="sm"
                              variant="ghost"
                              className="shrink-0"
                            >
                              <LogOut aria-hidden="true" className="size-3.5" />
                              {t("Sign out")}
                            </Button>
                          </li>
                        ))}
                    </ul>
                  )}
                </CardContent>
                {!accountLoading &&
                  sessions.some((session) => !session.current) && (
                    <CardFooter className="justify-end border-t pt-3">
                      <Button
                        disabled={busy}
                        onClick={() => void revokeOtherSessions()}
                        size="sm"
                        variant="outline"
                      >
                        {t("Sign out other devices")}
                      </Button>
                    </CardFooter>
                  )}
              </Card>
              <Card className="h-full" size="sm">
                <CardHeader>
                  <CardTitle>{t("Linked sign-in methods")}</CardTitle>
                  <CardDescription>
                    {t("Identity providers connected to your account.")}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {accountLoading ? (
                    <Skeleton className="h-12 rounded-xl" />
                  ) : identities.length === 0 ? (
                    <div className="flex items-center gap-3 rounded-xl bg-muted/30 p-3 text-sm text-muted-foreground">
                      <KeyRound aria-hidden="true" />
                      {t("No external identity providers are linked.")}
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
                              {t("Linked")}{" "}
                              {dayFormatter.format(
                                new Date(identity.createdAt)
                              )}
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
        </Tabs.Content>
      </Tabs>
    </Page>
  )
}
