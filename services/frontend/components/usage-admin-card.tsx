"use client"

import { useCallback, useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Spinner } from "@/components/panelui/spinner"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Progress } from "@/components/ui/progress"
import { api } from "@/lib/api"
import { notifyUsageChanged } from "@/lib/use-usage"
import { cn } from "@/lib/utils"
import type {
  MemberLimitMode,
  MemberUsage,
  OrganizationUsage,
} from "@/lib/usage"

function parseLimit(value: string) {
  const parsed = Number(value.replace(/[\s.,_']/g, ""))
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Workspace owners and admins: this month's usage per member, and who may use how much. */
export function UsageAdminCard({ organizationId }: { organizationId: string }) {
  const { t, locale } = useTranslations()
  const [usage, setUsage] = useState<OrganizationUsage | null>(null)
  const [error, setError] = useState("")
  const [defaultLimit, setDefaultLimit] = useState("")
  const [savingDefault, setSavingDefault] = useState(false)
  const [editing, setEditing] = useState<MemberUsage | null>(null)
  const [mode, setMode] = useState<MemberLimitMode>("inherit")
  const [memberLimit, setMemberLimit] = useState("")
  const [saving, setSaving] = useState(false)
  const [dialogError, setDialogError] = useState("")

  const number = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  })

  const [reloadKey, setReloadKey] = useState(0)
  const load = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let cancelled = false
    api
      .get<OrganizationUsage>(
        `/api/v1/organizations/${organizationId}/admin/usage`
      )
      .then((result) => {
        if (cancelled) return
        setUsage(result)
        setDefaultLimit(
          result.defaultMonthlyTokenLimit === null
            ? ""
            : String(result.defaultMonthlyTokenLimit)
        )
        setError("")
      })
      .catch((caught) => {
        if (cancelled) return
        setError(
          caught instanceof Error
            ? caught.message
            : "Usage could not be loaded."
        )
      })
    return () => {
      cancelled = true
    }
  }, [organizationId, reloadKey])

  async function saveDefault() {
    const limit = defaultLimit.trim() === "" ? null : parseLimit(defaultLimit)
    if (defaultLimit.trim() !== "" && limit === null) {
      setError("Enter the limit as a whole number of tokens.")
      return
    }
    setSavingDefault(true)
    try {
      await api.put(
        `/api/v1/organizations/${organizationId}/admin/usage/default`,
        {
          monthlyTokenLimit: limit,
        }
      )
      load()
      notifyUsageChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The limit could not be saved."
      )
    } finally {
      setSavingDefault(false)
    }
  }

  function edit(member: MemberUsage) {
    setEditing(member)
    setMode(
      member.limitSource === "member"
        ? member.monthlyTokenLimit === null
          ? "unlimited"
          : "limit"
        : "inherit"
    )
    setMemberLimit(
      member.limitSource === "member" && member.monthlyTokenLimit !== null
        ? String(member.monthlyTokenLimit)
        : ""
    )
    setDialogError("")
  }

  async function saveMember() {
    if (!editing) return
    const limit = parseLimit(memberLimit)
    if (mode === "limit" && (limit === null || limit < 1)) {
      setDialogError("Enter the limit as a whole number of tokens.")
      return
    }
    setSaving(true)
    try {
      await api.put(
        `/api/v1/organizations/${organizationId}/admin/usage/members/${editing.id}`,
        { mode, monthlyTokenLimit: mode === "limit" ? limit : null }
      )
      setEditing(null)
      load()
      notifyUsageChanged()
    } catch (caught) {
      setDialogError(
        caught instanceof Error
          ? caught.message
          : "The limit could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("Usage and limits")}</CardTitle>
        <CardDescription className="mt-1 text-sm">
          {t(
            "Tokens each member used this month. A limit stops new answers once it is reached, until the month resets."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{t(error)}</AlertDescription>
          </Alert>
        )}
        <section className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="usage-default-limit">
            {t("Default monthly limit per member")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Applies to everyone without a personal limit. Leave empty or enter 0 for no limit."
            )}
          </p>
          <div className="mt-1 flex max-w-md gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                className="pr-16"
                id="usage-default-limit"
                inputMode="numeric"
                onChange={(event) => setDefaultLimit(event.target.value)}
                placeholder={t("No limit")}
                value={defaultLimit}
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
                {t("tokens")}
              </span>
            </div>
            <Button
              disabled={savingDefault || !usage}
              onClick={() => void saveDefault()}
              type="button"
            >
              {savingDefault && <Spinner />} {t("Save")}
            </Button>
          </div>
        </section>
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">{t("Members this month")}</h3>
          {!usage && !error ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("Loading usage…")}
            </p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {usage?.members.map((member) => {
                const limit = member.monthlyTokenLimit
                const share =
                  limit && limit > 0
                    ? Math.min(100, (member.totalTokens / limit) * 100)
                    : 0
                return (
                  <li
                    className="grid items-center gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_15rem_auto]"
                    key={member.id}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {member.displayName}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email}
                      </p>
                    </div>
                    <div className="grid gap-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span
                          className="font-medium tabular-nums"
                          title={number.format(member.totalTokens)}
                        >
                          {compact.format(member.totalTokens)} {t("tokens")}
                        </span>
                        <span className="text-muted-foreground">
                          {limit === null
                            ? t("No limit")
                            : `${t("of")} ${compact.format(limit)}${
                                member.limitSource === "member"
                                  ? ` · ${t("personal")}`
                                  : ""
                              }`}
                        </span>
                      </div>
                      {limit !== null && (
                        <Progress
                          aria-label={t("Used of the monthly limit")}
                          className={cn(
                            "gap-0",
                            share >= 90 &&
                              "[&_[data-slot=progress-indicator]]:bg-destructive"
                          )}
                          value={share}
                        />
                      )}
                    </div>
                    <Button
                      onClick={() => edit(member)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {t("Set limit")}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </CardContent>
      <Dialog
        onOpenChange={(open) => !open && setEditing(null)}
        open={editing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Monthly limit")}</DialogTitle>
            <DialogDescription>{editing?.displayName}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2" role="radiogroup">
            {(
              [
                ["inherit", t("Workspace default")],
                ["unlimited", t("No limit")],
                ["limit", t("Custom limit")],
              ] as const
            ).map(([value, label]) => (
              <label className="flex items-center gap-2 text-sm" key={value}>
                <input
                  checked={mode === value}
                  name="usage-mode"
                  onChange={() => setMode(value)}
                  type="radio"
                />
                {label}
              </label>
            ))}
            {mode === "limit" && (
              <Input
                aria-label={t("Monthly limit in tokens")}
                inputMode="numeric"
                onChange={(event) => setMemberLimit(event.target.value)}
                placeholder="1000000"
                value={memberLimit}
              />
            )}
          </div>
          {dialogError && (
            <Alert variant="destructive">
              <AlertDescription>{t(dialogError)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              onClick={() => setEditing(null)}
              type="button"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={saving}
              onClick={() => void saveMember()}
              type="button"
            >
              {saving && <Spinner />} {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
