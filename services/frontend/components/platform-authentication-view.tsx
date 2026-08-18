"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TestTube2,
  Trash2,
} from "lucide-react"

import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { AdminOIDCProvider } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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

type ProviderForm = {
  slug: string
  displayName: string
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string
  enabled: boolean
}

type Props = {
  createRequest?: number
}

const emptyForm: ProviderForm = {
  slug: "",
  displayName: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
  enabled: true,
}

export function PlatformAuthenticationView({ createRequest }: Props) {
  const [providers, setProviders] = useState<AdminOIDCProvider[]>([])
  const [callbackUrl, setCallbackUrl] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState("")
  const [error, setError] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(emptyForm)
  const createRequestRef = useRef(createRequest ?? 0)

  const load = useCallback(async () => {
    setError("")
    try {
      const result = await api.get<{
        providers: AdminOIDCProvider[]
        callbackUrl: string
      }>("/api/v1/admin/oidc/providers")
      setProviders(result.providers)
      setCallbackUrl(result.callbackUrl)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Providers could not be loaded.")
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
      enabled: provider.enabled,
    })
    setError("")
    setDialogOpen(true)
  }

  async function save() {
    setError("")
    if (!form.displayName.trim() || !form.slug.trim() || !form.issuer.trim() || !form.clientId.trim()) {
      setError("Display name, slug, issuer, and client ID are required.")
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
    if (!window.confirm(`Delete the ${provider.displayName} provider?`)) return
    setError("")
    try {
      await api.delete(`/api/v1/admin/oidc/providers/${provider.id}`)
      notifySuccess("Identity provider removed", provider.displayName)
      await load()
    } catch (caught) {
      setError(
        notifyError(
          "Identity provider could not be deleted",
          caught,
          "Provider could not be deleted."
        )
      )
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Authentication request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> OIDC providers
          </CardTitle>
          <CardDescription>
            Platform-wide identity providers shown on the login page. Provider secrets are encrypted and never returned to the browser.
          </CardDescription>
          <CardAction>
            <div className="flex gap-2">
              <Button aria-label="Refresh OIDC providers" onClick={() => void load()} size="icon-sm" variant="outline">
                <RefreshCw />
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Callback URL</p>
            <p className="mt-1 break-all">{callbackUrl || "Configure oidc.redirect_url on the backend first."}</p>
            {callbackUrl && (
              <p className="mt-1 inline-flex items-center gap-1">
                Register this URL with every identity provider. <ExternalLink className="size-3" />
              </p>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin" /> Loading providers…
            </div>
          ) : providers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No OIDC providers configured.</p>
          ) : (
            providers.map((provider) => (
              <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between" key={provider.id || provider.slug}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{provider.displayName}</p>
                    <Badge variant={provider.enabled ? "default" : "secondary"}>{provider.enabled ? "Enabled" : "Disabled"}</Badge>
                    {provider.secretConfigured && <Badge variant="outline">Secret configured</Badge>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{provider.issuer}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {provider.slug} · {provider.scopes}
                    {provider.lastTestedAt ? ` · tested ${new Date(provider.lastTestedAt).toLocaleString()}` : ""}
                  </p>
                  {provider.lastError && <p className="mt-1 text-xs text-destructive">{provider.lastError}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button disabled={testingId === provider.id} onClick={() => void test(provider)} size="sm" variant="outline">
                    {testingId === provider.id ? <LoaderCircle className="animate-spin" /> : <TestTube2 />} Test
                  </Button>
                  <Button onClick={() => openEdit(provider)} size="sm" variant="outline">Edit</Button>
                  <Button onClick={() => void remove(provider)} size="icon-sm" variant="ghost" aria-label={`Delete ${provider.displayName}`}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit OIDC provider" : "Add OIDC provider"}</DialogTitle>
            <DialogDescription>
              Use the issuer URL from the provider’s OpenID Connect discovery configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium">
              Display name
              <Input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Company SSO" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Slug
              <Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="company-sso" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium sm:col-span-2">
              Issuer URL
              <Input value={form.issuer} onChange={(event) => setForm({ ...form, issuer: event.target.value })} placeholder="https://id.example.com" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Client ID
              <Input value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Client secret
              <Input type="password" value={form.clientSecret} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} placeholder={editingId ? "Leave blank to preserve" : "Required"} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium sm:col-span-2">
              Scopes
              <Textarea className="min-h-16" value={form.scopes} onChange={(event) => setForm({ ...form, scopes: event.target.value })} />
            </label>
            <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
              <div>
                <p className="text-xs font-medium">Provider enabled</p>
                <p className="text-xs text-muted-foreground">Show this provider on the login page.</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} aria-label="Provider enabled" />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setDialogOpen(false)} variant="outline">Cancel</Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving && <LoaderCircle className="animate-spin" />} {saving ? "Saving…" : "Save provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
