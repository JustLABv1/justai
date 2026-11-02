"use client"

import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useRef, useState } from "react"
import { LoaderCircle, Plus, RefreshCw, TestTube2, Trash2 } from "lucide-react"

import { AdminListFooter, useAdminList } from "@/components/admin-list-controls"
import { FilterBar } from "@/components/ui/filter-bar"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { AdminOIDCProvider } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"

type ProviderForm = {
  slug: string
  displayName: string
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string
  redirectUrl: string
  enabled: boolean
}

type Props = {
  createRequest?: number
  showCreateAction?: boolean
}

const emptyForm: ProviderForm = {
  slug: "",
  displayName: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
  redirectUrl: "",
  enabled: true,
}

export function PlatformAuthenticationView({
  createRequest,
  showCreateAction = false,
}: Props) {
  const { t, locale } = useTranslations()

  const [providers, setProviders] = useState<AdminOIDCProvider[]>([])
  const list = useAdminList(
    providers,
    (provider, query, status) =>
      `${provider.displayName} ${provider.issuer} ${provider.slug}`
        .toLocaleLowerCase()
        .includes(query) &&
      (status === "all" ||
        (status === "enabled" ? provider.enabled : !provider.enabled))
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState("")
  const [error, setError] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(emptyForm)
  const [removeTarget, setRemoveTarget] = useState<AdminOIDCProvider | null>(
    null
  )
  const [removing, setRemoving] = useState(false)
  const createRequestRef = useRef(createRequest ?? 0)

  const load = useCallback(async () => {
    setError("")
    try {
      const result = await api.get<{
        providers: AdminOIDCProvider[]
      }>("/api/v1/admin/oidc/providers")
      setProviders(result.providers)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Providers could not be loaded."
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm(emptyForm)
    setError("")
    setDialogOpen(true)
  }, [])

  useEffect(() => {
    if (!createRequest || createRequest === createRequestRef.current) return
    createRequestRef.current = createRequest
    openCreate()
  }, [createRequest, openCreate])

  function openEdit(provider: AdminOIDCProvider) {
    setEditingId(provider.id)
    setForm({
      slug: provider.slug,
      displayName: provider.displayName,
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: "",
      scopes: provider.scopes,
      redirectUrl: provider.redirectUrl,
      enabled: provider.enabled,
    })
    setError("")
    setDialogOpen(true)
  }

  async function save(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    setError("")
    if (
      !form.displayName.trim() ||
      !form.slug.trim() ||
      !form.issuer.trim() ||
      !form.clientId.trim() ||
      !form.redirectUrl.trim()
    ) {
      setError(
        "Display name, slug, issuer, client ID, and redirect URL are required."
      )
      return
    }
    if (!editingId && !form.clientSecret.trim()) {
      setError("A client secret is required for a new provider.")
      return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        clientSecret: form.clientSecret.trim() || undefined,
      }
      if (editingId) {
        await api.patch(`/api/v1/admin/oidc/providers/${editingId}`, payload)
      } else {
        await api.post("/api/v1/admin/oidc/providers", payload)
      }
      setDialogOpen(false)
      notifySuccess(
        editingId ? "Identity provider updated" : "Identity provider added"
      )
      await load()
    } catch (caught) {
      setError(
        notifyError(
          "Identity provider could not be saved",
          caught,
          "Provider could not be saved."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function test(provider: AdminOIDCProvider) {
    setTestingId(provider.id)
    setError("")
    try {
      await api.post(`/api/v1/admin/oidc/providers/${provider.id}/test`)
      notifySuccess("OIDC discovery succeeded", provider.displayName)
      await load()
    } catch (caught) {
      setError(
        notifyError("OIDC discovery failed", caught, "OIDC discovery failed.")
      )
      await load()
    } finally {
      setTestingId("")
    }
  }

  async function remove(provider: AdminOIDCProvider) {
    setRemoving(true)
    setError("")
    try {
      await api.delete(`/api/v1/admin/oidc/providers/${provider.id}`)
      notifySuccess("Identity provider removed", provider.displayName)
      setRemoveTarget(null)
      await load()
    } catch (caught) {
      setError(
        notifyError(
          "Identity provider could not be deleted",
          caught,
          "Provider could not be deleted."
        )
      )
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert aria-live="polite" role="alert" variant="destructive">
          <AlertTitle>{t("Authentication request failed")}</AlertTitle>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}

      <Card>
        <div className="px-4">
          <FilterBar
            className="border-0 p-0"
            search={{
              label: t("Search identity providers"),
              placeholder: t("Search identity providers…"),
              value: list.query,
              onChange: list.setQuery,
            }}
            hasActiveFilters={Boolean(list.query || list.status !== "all")}
            onClear={list.clear}
          >
            <Select
              value={list.status}
              onValueChange={(value) => list.setStatus(value ?? "all")}
            >
              <SelectTrigger size="sm" aria-label={t("Status")}>
                <SelectValue>
                  {t(
                    list.status === "enabled"
                      ? "Enabled"
                      : list.status === "disabled"
                        ? "Disabled"
                        : "All statuses"
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">{t("All statuses")}</SelectItem>
                  <SelectItem value="enabled">{t("Enabled")}</SelectItem>
                  <SelectItem value="disabled">{t("Disabled")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {showCreateAction && (
              <Button size="sm" onClick={openCreate}>
                <Plus data-icon="inline-start" />
                {t("Add identity provider")}
              </Button>
            )}
            <Button
              aria-label={t("Refresh OIDC providers")}
              onClick={() => void load()}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCw />
            </Button>
          </FilterBar>
        </div>
        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <div
              aria-live="polite"
              className="flex items-center justify-center py-10 text-sm text-muted-foreground"
            >
              <LoaderCircle className="mr-2 size-4 animate-spin" />{" "}
              {t("Loading providers…")}
            </div>
          ) : list.total === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t(
                providers.length
                  ? "No results"
                  : "No OIDC providers configured."
              )}
            </p>
          ) : (
            list.pageItems.map((provider) => (
              <div
                className="flex min-w-0 flex-col gap-3 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"
                key={provider.id || provider.slug}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openEdit(provider)}
                    >
                      {provider.displayName}
                    </button>
                    <Badge
                      variant={
                        provider.lastError
                          ? "destructive"
                          : provider.enabled
                            ? "success"
                            : "secondary"
                      }
                    >
                      {provider.lastError
                        ? t("Check failed")
                        : provider.enabled
                          ? t("Enabled")
                          : t("Disabled")}
                    </Badge>
                    {provider.secretConfigured && (
                      <Badge variant="outline">{t("Secret configured")}</Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {provider.issuer}
                  </p>
                  {provider.lastTestedAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("Last tested")}{" "}
                      {new Date(provider.lastTestedAt).toLocaleString(locale)}
                    </p>
                  )}
                  {provider.lastError && (
                    <p className="mt-1 text-xs break-words text-destructive">
                      {provider.lastError}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    disabled={testingId === provider.id}
                    onClick={() => void test(provider)}
                    size="sm"
                    variant="outline"
                  >
                    {testingId === provider.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <TestTube2 />
                    )}{" "}
                    {t("Test")}
                  </Button>
                  <Button
                    onClick={() => openEdit(provider)}
                    size="sm"
                    variant="outline"
                  >
                    {t("Edit")}
                  </Button>
                  <Button
                    onClick={() => setRemoveTarget(provider)}
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("Delete {value0}", {
                      value0: provider.displayName,
                    })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
        {!loading && (
          <AdminListFooter
            page={list.page}
            total={list.total}
            onPageChange={list.setPage}
          />
        )}
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!saving) setDialogOpen(open)
        }}
      >
        <DialogContent className="min-w-0 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t("Edit OIDC provider") : t("Add OIDC provider")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Use the issuer URL from the provider’s OpenID Connect discovery configuration."
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert aria-live="polite" role="alert" variant="destructive">
              <AlertTitle>{t("Could not save provider")}</AlertTitle>
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => void save(event)}
          >
            <label
              className="grid gap-1.5 text-xs font-medium"
              htmlFor="oidc-display-name"
            >
              {t("Display name")}
              <Input
                disabled={saving}
                id="oidc-display-name"
                required
                value={form.displayName}
                onChange={(event) =>
                  setForm({ ...form, displayName: event.target.value })
                }
                placeholder={t("Company SSO")}
              />
            </label>
            <label
              className="grid gap-1.5 text-xs font-medium"
              htmlFor="oidc-slug"
            >
              {t("Slug")}
              <Input
                disabled={saving}
                id="oidc-slug"
                required
                value={form.slug}
                onChange={(event) =>
                  setForm({ ...form, slug: event.target.value })
                }
                placeholder="company-sso"
              />
            </label>
            <label
              className="grid gap-1.5 text-xs font-medium sm:col-span-2"
              htmlFor="oidc-issuer"
            >
              {t("Issuer URL")}
              <Input
                disabled={saving}
                id="oidc-issuer"
                required
                type="url"
                value={form.issuer}
                onChange={(event) =>
                  setForm({ ...form, issuer: event.target.value })
                }
                placeholder="https://id.example.com"
              />
            </label>
            <label
              className="grid gap-1.5 text-xs font-medium"
              htmlFor="oidc-client-id"
            >
              {t("Client ID")}
              <Input
                disabled={saving}
                id="oidc-client-id"
                required
                value={form.clientId}
                onChange={(event) =>
                  setForm({ ...form, clientId: event.target.value })
                }
              />
            </label>
            <label
              className="grid gap-1.5 text-xs font-medium"
              htmlFor="oidc-client-secret"
            >
              {t("Client secret")}
              <Input
                disabled={saving}
                id="oidc-client-secret"
                type="password"
                value={form.clientSecret}
                onChange={(event) =>
                  setForm({ ...form, clientSecret: event.target.value })
                }
                placeholder={
                  editingId ? t("Leave blank to preserve") : t("Required")
                }
              />
            </label>
            <label
              className="grid gap-1.5 text-xs font-medium sm:col-span-2"
              htmlFor="oidc-redirect-url"
            >
              {t("Redirect URL")}
              <Input
                disabled={saving}
                id="oidc-redirect-url"
                required
                type="url"
                value={form.redirectUrl}
                onChange={(event) =>
                  setForm({ ...form, redirectUrl: event.target.value })
                }
                placeholder="https://app.example.com/api/v1/auth/oidc/callback"
              />
              <span className="font-normal text-muted-foreground">
                {t(
                  "Register this exact callback URL with this identity provider."
                )}
              </span>
            </label>
            <label
              className="grid gap-1.5 text-xs font-medium sm:col-span-2"
              htmlFor="oidc-scopes"
            >
              {t("Scopes")}
              <Textarea
                className="min-h-16"
                disabled={saving}
                id="oidc-scopes"
                value={form.scopes}
                onChange={(event) =>
                  setForm({ ...form, scopes: event.target.value })
                }
              />
            </label>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <p className="text-xs font-medium">{t("Provider enabled")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("Show this provider on the login page.")}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                disabled={saving}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                aria-label={t("Provider enabled")}
              />
            </div>
            <DialogFooter className="sm:col-span-2">
              <Button
                onClick={() => setDialogOpen(false)}
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving} type="submit">
                {saving && <LoaderCircle className="animate-spin" />}{" "}
                {saving ? t("Saving…") : t("Save provider")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog
        open={Boolean(removeTarget)}
        title={t("Delete {value0}?", {
          value0: removeTarget?.displayName ?? "identity provider",
        })}
        description={t(
          "Users will no longer be able to sign in with this provider. Existing JustAI sessions are not revoked."
        )}
        confirmLabel={t("Delete provider")}
        pending={removing}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) return remove(removeTarget)
        }}
      />
    </div>
  )
}
