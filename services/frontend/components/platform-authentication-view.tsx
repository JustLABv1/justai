"use client"

import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  TestTube2,
  Trash2,
} from "lucide-react"

import { useAdminList } from "@/components/admin-list-controls"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/panelui/select"
import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { AdminOIDCProvider } from "@/lib/types"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Menu } from "@/components/panelui/menu"
import { Frame } from "@/components/panelui/frame"
import { Field } from "@/components/panelui/field"
import { Sheet } from "@/components/panelui/sheet"
import { Input } from "@/components/panelui/input"
import { Switch } from "@/components/panelui/switch"
import { Textarea } from "@/components/panelui/textarea"
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
      const message = notifyError(
        "OIDC discovery failed",
        caught,
        "OIDC discovery failed."
      )
      await load()
      setError(message)
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
    <div className="flex flex-col gap-5">
      {error && !dialogOpen && (
        <Alert tone="destructive" variant="plain" role="alert">
          <Alert.Title>{t("Authentication request failed")}</Alert.Title>
          <Alert.Description>{t(error)}</Alert.Description>
        </Alert>
      )}
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Identity providers")}</Frame.Title>
          <Frame.Description>
            {t("Manage OpenID Connect providers for platform sign-in.")}
          </Frame.Description>
          <Frame.Action>
            <div className="flex gap-2">
              {showCreateAction && (
                <Button size="sm" onClick={openCreate}>
                  <Plus />
                  {t("Add identity provider")}
                </Button>
              )}
              <Button
                aria-label={t("Refresh OIDC providers")}
                size="icon-sm"
                variant="ghost"
                onClick={() => void load()}
              >
                <RefreshCw />
              </Button>
            </div>
          </Frame.Action>
        </Frame.Header>
        <Frame.Panel>
          <Frame.Row>
            <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <Input.Group>
                <Input.Addon>
                  <Search className="size-4" />
                </Input.Addon>
                <Input
                  aria-label={t("Search identity providers")}
                  placeholder={t("Search identity providers…")}
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
            </div>
          </Frame.Row>
          {loading ? (
            <Frame.Row>
              <span
                role="status"
                className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
              >
                <Spinner className="size-4" />
                {t("Loading providers…")}
              </span>
            </Frame.Row>
          ) : list.total === 0 ? (
            <Frame.Row>
              <Frame.Description>
                {t(
                  providers.length
                    ? "No results"
                    : "No OIDC providers configured."
                )}
              </Frame.Description>
            </Frame.Row>
          ) : (
            list.pageItems.map((provider) => (
              <Frame.Row
                key={provider.id || provider.slug}
                className="items-start gap-3 py-4"
              >
                <Frame.Content className="min-w-0">
                  <Frame.Title as="p">
                    <button
                      type="button"
                      className="max-w-full truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openEdit(provider)}
                    >
                      {provider.displayName}
                    </button>
                  </Frame.Title>
                  <Frame.Description title={provider.issuer}>
                    {provider.issuer}
                  </Frame.Description>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        provider.lastError
                          ? "destructive"
                          : provider.enabled
                            ? "success"
                            : "secondary"
                      }
                    >
                      {t(
                        provider.lastError
                          ? "Check failed"
                          : provider.enabled
                            ? "Enabled"
                            : "Disabled"
                      )}
                    </Badge>
                    {provider.secretConfigured && (
                      <Badge variant="outline">{t("Secret configured")}</Badge>
                    )}
                  </div>
                  {provider.lastTestedAt && (
                    <Frame.Description>
                      {t("Last tested")}{" "}
                      {new Date(provider.lastTestedAt).toLocaleString(locale)}
                    </Frame.Description>
                  )}
                  {provider.lastError && (
                    <p className="mt-1 text-xs break-words text-destructive">
                      {provider.lastError}
                    </p>
                  )}
                </Frame.Content>
                <Frame.Actions className="self-start">
                  {testingId === provider.id && (
                    <Spinner
                      className="size-4 text-muted-foreground"
                      aria-label={t("Test connection")}
                    />
                  )}
                  <Menu>
                    <Menu.Trigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("Actions for {value0}", {
                            value0: provider.displayName,
                          })}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </Menu.Trigger>
                    <Menu.Content align="end">
                      <Menu.Item onClick={() => openEdit(provider)}>
                        <Pencil />
                        {t("Edit")}
                      </Menu.Item>
                      <Menu.Item
                        disabled={Boolean(testingId)}
                        onClick={() => void test(provider)}
                      >
                        <TestTube2 />
                        {t("Test connection")}
                      </Menu.Item>
                      <Menu.Separator />
                      <Menu.Item
                        variant="destructive"
                        onClick={() => setRemoveTarget(provider)}
                      >
                        <Trash2 />
                        {t("Delete provider")}
                      </Menu.Item>
                    </Menu.Content>
                  </Menu>
                </Frame.Actions>
              </Frame.Row>
            ))
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
        open={dialogOpen}
        dismissible={!saving}
        onOpenChange={(open) => {
          if (!saving) setDialogOpen(open)
        }}
      >
        <Sheet.Content className="w-[min(40rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header>
            <Sheet.Title>
              {t(editingId ? "Edit OIDC provider" : "Add OIDC provider")}
            </Sheet.Title>
            <Sheet.Description>
              {t(
                "Use the issuer URL from the provider’s OpenID Connect discovery configuration."
              )}
            </Sheet.Description>
          </Sheet.Header>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void save(event)}
          >
            <Sheet.Body className="flex flex-col gap-5">
              {error && (
                <Alert tone="destructive" variant="plain" role="alert">
                  <Alert.Title>{t("Could not save provider")}</Alert.Title>
                  <Alert.Description>{t(error)}</Alert.Description>
                </Alert>
              )}
              <Frame variant="band">
                <Frame.Header>
                  <Frame.Title>{t("Provider details")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel className="grid gap-4 p-4 sm:grid-cols-2">
                  <Field disabled={saving}>
                    <Field.Label>{t("Display name")}</Field.Label>
                    <Input
                      required
                      placeholder={t("Company SSO")}
                      disabled={saving}
                      value={form.displayName}
                      onChange={(event) =>
                        setForm({ ...form, displayName: event.target.value })
                      }
                    />
                  </Field>
                  <Field disabled={saving}>
                    <Field.Label>{t("Slug")}</Field.Label>
                    <Input
                      required
                      placeholder="company-sso"
                      disabled={saving}
                      value={form.slug}
                      onChange={(event) =>
                        setForm({ ...form, slug: event.target.value })
                      }
                    />
                  </Field>
                  <Field disabled={saving} className="sm:col-span-2">
                    <Field.Label>{t("Issuer URL")}</Field.Label>
                    <Input
                      required
                      type="url"
                      placeholder="https://id.example.com"
                      disabled={saving}
                      value={form.issuer}
                      onChange={(event) =>
                        setForm({ ...form, issuer: event.target.value })
                      }
                    />
                  </Field>
                </Frame.Panel>
              </Frame>
              <Frame variant="band">
                <Frame.Header>
                  <Frame.Title>{t("Client credentials")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel className="grid gap-4 p-4 sm:grid-cols-2">
                  <Field disabled={saving}>
                    <Field.Label>{t("Client ID")}</Field.Label>
                    <Input
                      required
                      autoComplete="off"
                      disabled={saving}
                      value={form.clientId}
                      onChange={(event) =>
                        setForm({ ...form, clientId: event.target.value })
                      }
                    />
                  </Field>
                  <Field disabled={saving}>
                    <Field.Label>{t("Client secret")}</Field.Label>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      required={!editingId}
                      placeholder={
                        editingId ? t("Leave blank to preserve") : t("Required")
                      }
                      disabled={saving}
                      value={form.clientSecret}
                      onChange={(event) =>
                        setForm({ ...form, clientSecret: event.target.value })
                      }
                    />
                    <Field.Description>
                      {t(
                        editingId
                          ? "Leave blank to preserve the existing client secret."
                          : "A client secret is required for a new provider."
                      )}
                    </Field.Description>
                  </Field>
                </Frame.Panel>
              </Frame>
              <Frame variant="band">
                <Frame.Header>
                  <Frame.Title>{t("Sign-in configuration")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel className="flex flex-col gap-4 p-4">
                  <Field disabled={saving}>
                    <Field.Label>{t("Redirect URL")}</Field.Label>
                    <Input
                      required
                      type="url"
                      placeholder="https://app.example.com/api/v1/auth/oidc/callback"
                      disabled={saving}
                      value={form.redirectUrl}
                      onChange={(event) =>
                        setForm({ ...form, redirectUrl: event.target.value })
                      }
                    />
                    <Field.Description>
                      {t(
                        "Register this exact callback URL with this identity provider."
                      )}
                    </Field.Description>
                  </Field>
                  <Field disabled={saving}>
                    <Field.Label>{t("Scopes")}</Field.Label>
                    <Textarea
                      minRows={2}
                      disabled={saving}
                      value={form.scopes}
                      onChange={(event) =>
                        setForm({ ...form, scopes: event.target.value })
                      }
                    />
                  </Field>
                  <Frame.Row className="px-0">
                    <Frame.Content>
                      <Frame.Title as="p">
                        <label htmlFor="oidc-enabled">
                          {t("Provider enabled")}
                        </label>
                      </Frame.Title>
                      <Frame.Description
                        id="oidc-enabled-description"
                        className="overflow-visible! text-clip! whitespace-normal!"
                      >
                        {t("Show this provider on the login page.")}
                      </Frame.Description>
                    </Frame.Content>
                    <Frame.Actions>
                      <Switch
                        size="sm"
                        id="oidc-enabled"
                        aria-describedby="oidc-enabled-description"
                        checked={form.enabled}
                        disabled={saving}
                        onCheckedChange={(enabled) =>
                          setForm({ ...form, enabled })
                        }
                      />
                    </Frame.Actions>
                  </Frame.Row>
                </Frame.Panel>
              </Frame>
            </Sheet.Body>
            <Sheet.Footer className="sm:flex-row sm:justify-end">
              <Button
                disabled={saving}
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving} loading={saving} type="submit">
                {t(saving ? "Saving…" : "Save provider")}
              </Button>
            </Sheet.Footer>
          </form>
        </Sheet.Content>
      </Sheet>
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
