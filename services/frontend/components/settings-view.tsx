"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  BookOpen,
  Check,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react"
import Link from "next/link"

import { api } from "@/lib/api"
import type { Organization, OrganizationMember, User } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"

type MemberRole = OrganizationMember["role"]

type SettingsViewProps = {
  user: User
  organizations: Organization[]
  activeOrganizationId: string | null
  onOrganizationSelect: (organizationId: string) => void
  onOrganizationCreated: (organization: Organization) => void
  onOrganizationUpdated: (organization: Organization) => void
}

export function SettingsView({
  user,
  organizations,
  activeOrganizationId,
  onOrganizationSelect,
  onOrganizationCreated,
  onOrganizationUpdated,
}: SettingsViewProps) {
  const [members, setMembers] = useState<OrganizationMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState("")
  const [actionError, setActionError] = useState("")
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [memberDialogOpen, setMemberDialogOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState("")
  const [memberEmail, setMemberEmail] = useState("")
  const [memberRole, setMemberRole] = useState<MemberRole>("member")
  const [saving, setSaving] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<OrganizationMember | null>(null)

  const activeOrganization = organizations.find(
    (organization) => organization.id === activeOrganizationId
  ) ?? organizations[0]
  const canManageMembers = activeOrganization?.role === "owner" || activeOrganization?.role === "admin"
  const canRenameWorkspace = canManageMembers

  const loadMembers = useCallback(async () => {
    if (!activeOrganization) {
      setMembers([])
      return
    }
    setMembersLoading(true)
    setMembersError("")
    try {
      const result = await api.get<{ members: OrganizationMember[] }>(
        `/api/v1/organizations/${activeOrganization.id}/members`
      )
      setMembers(result.members)
    } catch (caught) {
      setMembersError(caught instanceof Error ? caught.message : "Members could not be loaded.")
    } finally {
      setMembersLoading(false)
    }
  }, [activeOrganization])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMembers()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadMembers])

  const initials = useMemo(
    () => (name: string) =>
      name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
    []
  )

  function resetWorkspaceDialog() {
    setWorkspaceName("")
    setWorkspaceDialogOpen(false)
  }

  function openRenameDialog() {
    setWorkspaceName(activeOrganization?.name ?? "")
    setRenameDialogOpen(true)
  }

  async function createWorkspace() {
    const name = workspaceName.trim()
    if (!name) return
    setSaving(true)
    setActionError("")
    try {
      const result = await api.post<{ organization: Organization }>("/api/v1/organizations", { name })
      onOrganizationCreated(result.organization)
      resetWorkspaceDialog()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The workspace could not be created.")
    } finally {
      setSaving(false)
    }
  }

  async function renameWorkspace() {
    if (!activeOrganization) return
    const name = workspaceName.trim()
    if (!name) return
    setSaving(true)
    setActionError("")
    try {
      const result = await api.patch<{ organization: Organization }>(
        `/api/v1/organizations/${activeOrganization.id}`,
        { name }
      )
      onOrganizationUpdated(result.organization)
      setRenameDialogOpen(false)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The workspace could not be renamed.")
    } finally {
      setSaving(false)
    }
  }

  async function addMember() {
    if (!activeOrganization || !memberEmail.trim()) return
    setSaving(true)
    setActionError("")
    try {
      await api.post(`/api/v1/organizations/${activeOrganization.id}/members`, {
        email: memberEmail.trim(),
        role: memberRole,
      })
      setMemberEmail("")
      setMemberRole("member")
      setMemberDialogOpen(false)
      await loadMembers()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The member could not be added.")
    } finally {
      setSaving(false)
    }
  }

  async function updateMemberRole(member: OrganizationMember, role: MemberRole) {
    if (!activeOrganization || member.role === role) return
    setActionError("")
    try {
      await api.patch(`/api/v1/organizations/${activeOrganization.id}/members/${member.id}`, { role })
      await loadMembers()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The member role could not be updated.")
    }
  }

  async function removeMember() {
    if (!activeOrganization || !removeTarget) return
    const target = removeTarget
    setRemoveTarget(null)
    setActionError("")
    try {
      await api.delete(`/api/v1/organizations/${activeOrganization.id}/members/${target.id}`)
      await loadMembers()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The member could not be removed.")
    }
  }

  async function logout() {
    try {
      await api.post("/api/v1/auth/logout")
    } finally {
      api.setOrganizationId(null)
      window.location.assign("/login")
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Badge variant="secondary">Workspace controls</Badge>
          <span className="text-sm text-muted-foreground">Security and access</span>
        </div>
        <h2 className="font-heading text-3xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-2 max-w-2xl text-base text-muted-foreground">
          Create workspaces, choose the active team, and manage who can access it.
        </p>
      </div>

      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>Could not save changes</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-6 p-6">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users aria-hidden="true" /> Workspaces
            </CardTitle>
            <CardDescription className="mt-1 text-sm">Each workspace has its own conversations, endpoints, knowledge, and members.</CardDescription>
          </div>
          <Button className="shrink-0" onClick={() => setWorkspaceDialogOpen(true)}>
            <Plus data-icon="inline-start" /> New workspace
          </Button>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {organizations.map((organization) => {
              const selected = organization.id === activeOrganization?.id
              return (
                <button
                  className={`min-h-36 rounded-xl border p-5 text-left transition-colors hover:bg-accent ${selected ? "border-primary bg-primary/5 shadow-sm" : "bg-card"}`}
                  key={organization.id}
                  onClick={() => onOrganizationSelect(organization.id)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                      <Users aria-hidden="true" />
                    </span>
                    {selected && <Check className="size-4 text-primary" aria-label="Selected workspace" />}
                  </div>
                  <p className="mt-4 truncate text-base font-medium">{organization.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{organization.role ?? "member"} access</p>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {activeOrganization && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-6 p-6">
            <div className="min-w-0">
              <CardTitle className="truncate text-xl">{activeOrganization.name}</CardTitle>
              <CardDescription className="mt-1 truncate text-sm">{activeOrganization.slug} · {activeOrganization.role ?? "member"} access</CardDescription>
            </div>
            {canRenameWorkspace && (
              <Button className="shrink-0" onClick={openRenameDialog} variant="outline">
                <Pencil data-icon="inline-start" /> Rename
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-6 pt-0">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-medium">Members</h3>
                <p className="mt-1 text-sm text-muted-foreground">People with access to this workspace.</p>
              </div>
              {canManageMembers && (
                <Button className="shrink-0" onClick={() => setMemberDialogOpen(true)} variant="outline">
                  <UserPlus data-icon="inline-start" /> Add member
                </Button>
              )}
            </div>
            {membersError && (
              <Alert className="mb-4" variant="destructive">
                <AlertDescription>{membersError}</AlertDescription>
              </Alert>
            )}
            {membersLoading ? (
              <div className="flex items-center gap-2 rounded-xl border p-4 text-sm text-muted-foreground">
                <LoaderCircle className="animate-spin" /> Loading members…
              </div>
            ) : members.length === 0 ? (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No members found.</div>
            ) : (
              <div className="divide-y rounded-xl border bg-card">
                {members.map((member) => (
                  <div className="flex flex-wrap items-center gap-4 p-4" key={member.id}>
                    <Avatar className="size-9" size="sm">
                      <AvatarFallback>{initials(member.displayName || member.email)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-medium">{member.displayName}</p>
                      <p className="truncate text-sm text-muted-foreground">{member.email}</p>
                    </div>
                    <span className="hidden text-xs text-muted-foreground lg:block">
                      Joined {formatDate(member.createdAt)}
                    </span>
                    <Select
                      disabled={!canManageMembers || (activeOrganization.role === "admin" && member.role !== "member")}
                      onValueChange={(value) => {
                        if (value) void updateMemberRole(member, value as MemberRole)
                      }}
                      value={member.role}
                    >
                      <SelectTrigger className="w-32" aria-label={`Role for ${member.displayName}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                        {activeOrganization.role === "owner" && <SelectItem value="owner">Owner</SelectItem>}
                      </SelectContent>
                    </Select>
                    {canManageMembers && member.role !== "owner" && (
                      <Button
                        aria-label={`Remove ${member.displayName}`}
                        onClick={() => setRemoveTarget(member)}
                        size="icon-sm"
                        title={`Remove ${member.displayName}`}
                        variant="ghost"
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><UserRound aria-hidden="true" />Your account</CardTitle>
            <CardDescription className="text-sm">Authenticated JustAI identity.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div><p className="text-xs text-muted-foreground">Display name</p><p className="mt-1 font-medium">{user.displayName}</p></div>
              <div><p className="text-xs text-muted-foreground">Email</p><p className="mt-1 font-medium">{user.email}</p></div>
              <Badge variant="outline">{user.platformAdmin ? "Platform admin" : "Member"}</Badge>
            </div>
            <Separator className="my-5" />
            <Button onClick={() => void logout()} size="sm" variant="outline"><LogOut data-icon="inline-start" aria-hidden="true" />Sign out</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><LockKeyhole aria-hidden="true" />Secrets boundary</CardTitle>
            <CardDescription className="text-sm">Provider and MCP credentials stay on the backend.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3"><SettingRow icon={ShieldCheck} label="Encrypted credentials" value="AES-GCM at rest" /><SettingRow icon={Check} label="Browser access" value="No provider keys" /><SettingRow icon={BookOpen} label="Audit trail" value="Requests + tool calls" /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Runtime notes</CardTitle><CardDescription>Production deployment hardening comes after the product surface stabilizes.</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap gap-2"><Button render={<a href="https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization" rel="noreferrer" target="_blank" />} size="sm" variant="outline"><ExternalLink data-icon="inline-start" aria-hidden="true" />MCP auth docs</Button><Button render={<Link href="/login" />} size="sm" variant="outline"><UserRound data-icon="inline-start" aria-hidden="true" />Open sign-in</Button></CardContent>
      </Card>

      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>Start a separate workspace for another team, project, or environment.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field><FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel><Input autoFocus id="workspace-name" onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Product team" value={workspaceName} /></Field>
            <FieldDescription>Everyone you add will see the workspace’s conversations and shared integrations.</FieldDescription>
          </FieldGroup>
          <DialogFooter><Button onClick={resetWorkspaceDialog} variant="outline">Cancel</Button><Button disabled={saving || !workspaceName.trim()} onClick={() => void createWorkspace()}>{saving ? <><LoaderCircle className="animate-spin" data-icon="inline-start" /> Creating…</> : "Create workspace"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Rename workspace</DialogTitle><DialogDescription>Use a clear name so members can identify this workspace.</DialogDescription></DialogHeader>
          <Field><FieldLabel htmlFor="rename-workspace-name">Workspace name</FieldLabel><Input id="rename-workspace-name" onChange={(event) => setWorkspaceName(event.target.value)} value={workspaceName} /></Field>
          <DialogFooter><Button onClick={() => setRenameDialogOpen(false)} variant="outline">Cancel</Button><Button disabled={saving || !workspaceName.trim()} onClick={() => void renameWorkspace()}>{saving ? "Saving…" : "Save changes"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={memberDialogOpen} onOpenChange={setMemberDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add workspace member</DialogTitle><DialogDescription>The person must already have a JustAI account. Invitations by email can be added once mail delivery is configured.</DialogDescription></DialogHeader>
          <FieldGroup>
            <Field><FieldLabel htmlFor="member-email">Account email</FieldLabel><Input autoComplete="email" id="member-email" onChange={(event) => setMemberEmail(event.target.value)} placeholder="teammate@example.com" type="email" value={memberEmail} /></Field>
            <Field><FieldLabel>Role</FieldLabel><Select onValueChange={(value) => value && setMemberRole(value as MemberRole)} value={memberRole}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="member">Member</SelectItem><SelectItem value="admin">Admin</SelectItem></SelectContent></Select></Field>
          </FieldGroup>
          <DialogFooter><Button onClick={() => setMemberDialogOpen(false)} variant="outline">Cancel</Button><Button disabled={saving || !memberEmail.trim()} onClick={() => void addMember()}>{saving ? <><LoaderCircle className="animate-spin" data-icon="inline-start" /> Adding…</> : <><UserPlus data-icon="inline-start" /> Add member</>}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Remove {removeTarget?.displayName}?</AlertDialogTitle><AlertDialogDescription>This person will lose access to {activeOrganization?.name}. Their existing workspace data remains available to the workspace.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void removeMember()}>Remove member</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "recently"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
}

function SettingRow({ icon: Icon, label, value }: { icon: typeof ShieldCheck; label: string; value: string }) {
  return <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-3"><Icon aria-hidden="true" className="text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{value}</p></div></div>
}
