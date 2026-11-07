"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Spinner } from "@/components/panelui/spinner"
import { Alert } from "@/components/panelui/alert"
import { Button } from "@/components/panelui/button"
import { Frame } from "@/components/panelui/frame"
import { Field } from "@/components/panelui/field"
import { Input } from "@/components/panelui/input"
import { Dialog } from "@/components/panelui/dialog"
import { RadioGroup } from "@/components/panelui/radio-group"
import { Usage } from "@/components/panelui/usage"
import { api } from "@/lib/api"
import { notifyUsageChanged } from "@/lib/use-usage"
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
export function UsageAdminCard({
  organizationId,
  canManage = true,
  children,
}: {
  organizationId: string
  canManage?: boolean
  children: (renderMemberUsage: (memberId: string) => ReactNode) => ReactNode
}) {
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
  const [notice, setNotice] = useState("")

  const number = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  })

  const [reloadKey, setReloadKey] = useState(0)
  const load = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    if (!canManage) return
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
  }, [organizationId, reloadKey, canManage])

  async function saveDefault() {
    const limit = defaultLimit.trim() === "" ? null : parseLimit(defaultLimit)
    if (defaultLimit.trim() !== "" && limit === null) {
      setError("Enter the limit as a whole number of tokens.")
      return
    }
    setSavingDefault(true)
    setError("")
    setNotice("")
    try {
      await api.put(
        `/api/v1/organizations/${organizationId}/admin/usage/default`,
        {
          monthlyTokenLimit: limit,
        }
      )
      load()
      notifyUsageChanged()
      setNotice("Default limit saved.")
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
    setDialogError("")
    setNotice("")
    try {
      await api.put(
        `/api/v1/organizations/${organizationId}/admin/usage/members/${editing.id}`,
        { mode, monthlyTokenLimit: mode === "limit" ? limit : null }
      )
      setEditing(null)
      setNotice("Member limit saved.")
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

  const defaultLimitLabel = usage?.defaultMonthlyTokenLimit
    ? `${number.format(usage.defaultMonthlyTokenLimit)} ${t("tokens")}`
    : t("No limit")

  function renderMemberUsage(memberId: string) {
    const member = usage?.members.find((item) => item.id === memberId)
    if (!canManage || !member) return null
    const limit = member.monthlyTokenLimit
    const hasLimit = limit !== null && limit > 0
    return (
      <>
        <div className="w-48 shrink-0">
          {hasLimit ? (
            <Usage
              value={member.totalTokens}
              limit={limit}
              label={t("Monthly tokens")}
              locales={locale}
            >
              <Usage.Meter
                label={t("Monthly tokens")}
                value={Math.min(member.totalTokens, limit)}
                limit={limit}
                display={`${compact.format(member.totalTokens)} / ${compact.format(limit)}`}
                note={
                  member.totalTokens >= limit
                    ? t("Monthly limit reached")
                    : t(
                        member.limitSource === "member"
                          ? "Personal setting"
                          : "Workspace default"
                      )
                }
              />
            </Usage>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium tabular-nums">
                {number.format(member.totalTokens)} {t("tokens")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("No limit")}
              </span>
            </div>
          )}
        </div>
        <Button
          onClick={() => edit(member)}
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("Set limit for {value0}", {
            value0: member.displayName,
          })}
        >
          {t("Set limit")}
        </Button>
      </>
    )
  }

  if (!canManage) return children(() => null)

  return (
    <section aria-label={t("Usage and limits")} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("Usage and limits")}</h2>
        <span className="text-xs text-muted-foreground">
          {t("Monthly token allowance")}
        </span>
      </div>
      {error && (
        <Alert tone="destructive" variant="plain">
          <Alert.Description>{t(error)}</Alert.Description>
          {!usage && (
            <Alert.Actions>
              <Button variant="outline" size="sm" onClick={load}>
                {t("Retry")}
              </Button>
            </Alert.Actions>
          )}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" variant="plain">
          <Alert.Description>{t(notice)}</Alert.Description>
        </Alert>
      )}
      <Frame variant="band">
        <Frame.Header>
          <Frame.Title>{t("Workspace default")}</Frame.Title>
          <Frame.Description>
            {t("Applies to members without a personal limit.")}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel className="p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void saveDefault()
            }}
            className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <Field disabled={savingDefault || !usage}>
              <Field.Label>{t("Default monthly limit per member")}</Field.Label>
              <Input.Group>
                <Input
                  id="usage-default-limit"
                  aria-label={t("Default monthly limit per member")}
                  inputMode="numeric"
                  value={defaultLimit}
                  onChange={(event) => setDefaultLimit(event.target.value)}
                  placeholder={t("No limit")}
                  disabled={savingDefault || !usage}
                />
                <Input.Addon align="end">{t("tokens")}</Input.Addon>
              </Input.Group>
              <Field.Description>
                {t("Leave empty or enter 0 for no limit.")}
              </Field.Description>
            </Field>
            <Button
              className="sm:self-center"
              disabled={savingDefault || !usage}
              type="submit"
              size="sm"
            >
              {savingDefault && <Spinner className="size-4" />}
              {t("Save default")}
            </Button>
          </form>
        </Frame.Panel>
      </Frame>
      {children(renderMemberUsage)}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null)
        }}
      >
        <Dialog.Content className="sm:max-w-lg">
          <Dialog.Header
            title={t("Monthly limit")}
            description={editing?.displayName}
          />
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              void saveMember()
            }}
          >
            <Dialog.Body>
              <RadioGroup
                aria-label={t("Monthly limit")}
                value={mode}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "unlimited" ||
                    value === "limit"
                  ) {
                    setMode(value)
                    setDialogError("")
                  }
                }}
                disabled={saving}
              >
                <RadioGroup.Card value="inherit" appearance="filled">
                  <RadioGroup.CardBody>
                    <RadioGroup.CardTitle>
                      {t("Workspace default")}
                    </RadioGroup.CardTitle>
                    <RadioGroup.CardDescription>
                      {defaultLimitLabel}
                    </RadioGroup.CardDescription>
                  </RadioGroup.CardBody>
                </RadioGroup.Card>
                <RadioGroup.Card value="unlimited" appearance="filled">
                  <RadioGroup.CardBody>
                    <RadioGroup.CardTitle>{t("No limit")}</RadioGroup.CardTitle>
                    <RadioGroup.CardDescription>
                      {t("This member has no monthly token cap.")}
                    </RadioGroup.CardDescription>
                  </RadioGroup.CardBody>
                </RadioGroup.Card>
                <RadioGroup.Card value="limit" appearance="filled">
                  <RadioGroup.CardBody>
                    <RadioGroup.CardTitle>
                      {t("Custom limit")}
                    </RadioGroup.CardTitle>
                    <RadioGroup.CardDescription>
                      {t("Set a monthly token allowance for this member.")}
                    </RadioGroup.CardDescription>
                  </RadioGroup.CardBody>
                </RadioGroup.Card>
              </RadioGroup>
              {mode === "limit" && (
                <Field disabled={saving} invalid={Boolean(dialogError)}>
                  <Field.Label>{t("Monthly limit in tokens")}</Field.Label>
                  <Input.Group>
                    <Input
                      inputMode="numeric"
                      disabled={saving}
                      value={memberLimit}
                      onChange={(event) => setMemberLimit(event.target.value)}
                      placeholder="1000000"
                      autoFocus
                    />
                    <Input.Addon align="end">{t("tokens")}</Input.Addon>
                  </Input.Group>
                </Field>
              )}
              {dialogError && (
                <Alert tone="destructive" variant="plain">
                  <Alert.Description>{t(dialogError)}</Alert.Description>
                </Alert>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                disabled={saving}
                onClick={() => setEditing(null)}
                variant="secondary"
                type="button"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving} type="submit">
                {saving && <Spinner className="size-4" />}
                {t("Save changes")}
              </Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog>
    </section>
  )
}
