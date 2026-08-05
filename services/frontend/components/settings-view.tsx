"use client"

import { BookOpen, Check, ExternalLink, LockKeyhole, LogOut, ShieldCheck, UserRound } from "lucide-react"
import Link from "next/link"

import { api } from "@/lib/api"
import type { Organization, User } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export function SettingsView({ user, organizations }: { user: User; organizations: Organization[] }) {
  async function logout() {
    try {
      await api.post("/api/v1/auth/logout")
    } finally {
      window.location.assign("/login")
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div><div className="mb-2 flex items-center gap-2"><Badge variant="secondary">Workspace controls</Badge><span className="text-xs text-muted-foreground">Security and access</span></div><h2 className="font-heading text-2xl font-semibold tracking-tight">Settings</h2><p className="mt-1 text-sm text-muted-foreground">Keep provider credentials, organization access, and runtime behavior easy to inspect.</p></div>
      <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><UserRound aria-hidden="true" />Your account</CardTitle><CardDescription>Authenticated workspace identity.</CardDescription></CardHeader><CardContent><div className="space-y-3 text-sm"><div><p className="text-xs text-muted-foreground">Display name</p><p className="mt-1 font-medium">{user.displayName}</p></div><div><p className="text-xs text-muted-foreground">Email</p><p className="mt-1 font-medium">{user.email}</p></div><div className="flex flex-wrap gap-2"><Badge variant="outline">{user.platformAdmin ? "Platform admin" : "Member"}</Badge>{organizations.map((organization) => <Badge key={organization.id} variant="secondary">{organization.name} · {organization.role}</Badge>)}</div></div><Separator className="my-5" /><Button variant="outline" size="sm" onClick={() => void logout()}><LogOut data-icon="inline-start" aria-hidden="true" />Sign out</Button></CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><LockKeyhole aria-hidden="true" />Secrets boundary</CardTitle><CardDescription>Provider and MCP credentials stay on the backend.</CardDescription></CardHeader><CardContent className="space-y-3"><SettingRow icon={ShieldCheck} label="Encrypted credentials" value="AES-GCM at rest" /><SettingRow icon={Check} label="Browser access" value="No provider keys" /><SettingRow icon={BookOpen} label="Audit trail" value="Requests + tool calls" /></CardContent></Card></div>
      <Card><CardHeader><CardTitle className="text-base">Runtime notes</CardTitle><CardDescription>Local development is intentionally straightforward; production deployment hardening comes after the product surface stabilizes.</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Button variant="outline" size="sm" render={<a href="https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization" target="_blank" rel="noreferrer" />}><ExternalLink data-icon="inline-start" aria-hidden="true" />MCP auth docs</Button><Button variant="outline" size="sm" render={<Link href="/login" />}><UserRound data-icon="inline-start" aria-hidden="true" />Open sign-in</Button></CardContent></Card>
    </div>
  )
}

function SettingRow({ icon: Icon, label, value }: { icon: typeof ShieldCheck; label: string; value: string }) {
  return <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-3"><Icon aria-hidden="true" className="text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{value}</p></div></div>
}
