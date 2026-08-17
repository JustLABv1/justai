"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  LoaderCircle,
  Pencil,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react"

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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type MemberRole = OrganizationMember["role"]

type SettingsViewProps = {
  user: User
  organizations: Organization[]
  activeOrganizationId: string | null
  onOrganizationSelect: (organizationId: string) => void
  onOrganizationCreated: (organization: Organization) => void
  onOrganizationUpdated: (organization: Organization) => void
  workspaceCreateRequest?: number
  memberCreateRequest?: number
  section?: "workspace" | "members"
}

export function SettingsView({
  user,
  organizations,
  activeOrganizationId,
  onOrganizationSelect,
  onOrganizationCreated,
  onOrganizationUpdated,
  workspaceCreateRequest,
  memberCreateRequest,
  section = "workspace",
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
  const [removeTarget, setRemoveTarget] = useState<OrganizationMember | null>(
    null
  )
  const workspaceCreateRequestRef = useRef(workspaceCreateRequest ?? 0)
  const memberCreateRequestRef = useRef(memberCreateRequest ?? 0)

  const activeOrganization =
    organizations.find(
      (organization) => organization.id === activeOrganizationId
    ) ?? organizations[0]
  const canManageMembers =
    user.platformAdmin ||
    activeOrganization?.role === "owner" ||
    activeOrganization?.role === "admin"
  const canRenameWorkspace = canManageMembers
  const isMembersSection = section === "members"

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
      setMembersError(
        caught instanceof Error
          ? caught.message
          : "Members could not be loaded."
      )
    } finally {
      setMembersLoading(false)
    }
  }, [activeOrganization])

  useEffect(() => {
    if (!isMembersSection) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadMembers()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isMembersSection, loadMembers])

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

  const openWorkspaceDialog = useCallback(() => {
    setWorkspaceName("")
    setWorkspaceDialogOpen(true)
  }, [])

  const openMemberDialog = useCallback(() => {
    setMemberEmail("")
    setMemberRole("member")
    setMemberDialogOpen(true)
  }, [])

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
      const result = await api.post<{ organization: Organization }>(
        "/api/v1/organizations",
        { name }
      )
      onOrganizationCreated(result.organization)
      resetWorkspaceDialog()
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The workspace could not be created."
      )
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
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The workspace could not be renamed."
      )
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
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The member could not be added."
      )
    } finally {
      setSaving(false)
    }
  }

  async function updateMemberRole(
    member: OrganizationMember,
    role: MemberRole
  ) {
    if (!activeOrganization || member.role === role) return
    setActionError("")
    try {
      await api.patch(
        `/api/v1/organizations/${activeOrganization.id}/members/${member.id}`,
        { role }
      )
      await loadMembers()
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The member role could not be updated."
      )
    }
  }

  async function removeMember() {
    if (!activeOrganization || !removeTarget) return
    const target = removeTarget
    setRemoveTarget(null)
    setActionError("")
    try {
      await api.delete(
        `/api/v1/organizations/${activeOrganization.id}/members/${target.id}`
      )
      await loadMembers()
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The member could not be removed."
      )
    }
  }

  useEffect(() => {
    if (
      !workspaceCreateRequest ||
      workspaceCreateRequest === workspaceCreateRequestRef.current
    )
      return
    workspaceCreateRequestRef.current = workspaceCreateRequest
    openWorkspaceDialog()
  }, [openWorkspaceDialog, workspaceCreateRequest])

  useEffect(() => {
    if (
      !memberCreateRequest ||
      memberCreateRequest === memberCreateRequestRef.current
    )
      return
    memberCreateRequestRef.current = memberCreateRequest
    openMemberDialog()
  }, [memberCreateRequest, openMemberDialog])

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>Could not save changes</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {!isMembersSection && (
        <Card size="sm">
          <CardHeader className="flex flex-row items-start gap-6">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Users aria-hidden="true" /> Workspaces
              </CardTitle>
              <CardDescription className="mt-1 text-sm">
                Each workspace keeps conversations and integrations separate.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {organizations.map((organization) => {
                const selected = organization.id === activeOrganization?.id
                return (
                  <button
                    aria-pressed={selected}
                    aria-label={`${selected ? "Current" : "Switch to"} workspace ${organization.name}`}
                    className={`cursor-pointer rounded-xl border p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${selected ? "border-primary bg-primary/5 shadow-sm" : "bg-card"}`}
                    onClick={() => onOrganizationSelect(organization.id)}
                    type="button"
                    key={organization.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                        <Users aria-hidden="true" />
                      </span>
                      {selected && (
                        <Check
                          className="size-4 text-primary"
                          aria-label="Selected workspace"
                        />
                      )}
                    </div>
                    <p className="mt-3 truncate text-sm font-medium">
                      {organization.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selected ? "Active workspace" : "Available workspace"}
                    </p>
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {activeOrganization && (
        <Card size="sm">
          <CardHeader className="flex flex-row items-start justify-between gap-6">
            <div className="min-w-0">
              <CardTitle className="truncate text-xl">
                {activeOrganization.name}
              </CardTitle>
              <CardDescription className="mt-1 truncate text-sm">
                {isMembersSection
                  ? "People with access to this workspace"
                  : "Active workspace details"}
              </CardDescription>
            </div>
            {canRenameWorkspace && !isMembersSection && (
              <Button
                className="shrink-0"
                onClick={openRenameDialog}
                variant="outline"
              >
                <Pencil data-icon="inline-start" /> Rename
              </Button>
            )}
          </CardHeader>
          <CardContent className="pt-0">
            {!isMembersSection ? (
              <div className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Workspace slug
                  </p>
                  <p className="mt-1 truncate font-mono text-xs">
                    {activeOrganization.slug}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-5">
                  <div>
                    <h3 className="text-base font-medium">Members</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      People with access to this workspace.
                    </p>
                  </div>
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
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No members found.
                  </div>
                ) : (
                  <div className="divide-y rounded-xl border bg-card">
                    {members.map((member) => (
                      <div
                        className="flex flex-wrap items-center gap-4 p-4"
                        key={member.id}
                      >
                        <Avatar className="size-9" size="sm">
                          <AvatarFallback>
                            {initials(member.displayName || member.email)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-base font-medium">
                            {member.displayName}
                          </p>
                          <p className="truncate text-sm text-muted-foreground">
                            {member.email}
                          </p>
                        </div>
                        <span className="hidden text-xs text-muted-foreground lg:block">
                          Joined {formatDate(member.createdAt)}
                        </span>
                        <Select
                          disabled={
                            !canManageMembers ||
                            (!user.platformAdmin &&
                              activeOrganization.role === "admin" &&
                              member.role !== "member")
                          }
                          onValueChange={(value) => {
                            if (value)
                              void updateMemberRole(member, value as MemberRole)
                          }}
                          value={member.role}
                        >
                          <SelectTrigger
                            className="w-32"
                            aria-label={`Role for ${member.displayName}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                            {(activeOrganization.role === "owner" ||
                              user.platformAdmin) && (
                              <SelectItem value="owner">Owner</SelectItem>
                            )}
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
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>
              Start a separate workspace for another team, project, or
              environment.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
              <Input
                autoFocus
                id="workspace-name"
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="Product team"
                value={workspaceName}
              />
            </Field>
            <FieldDescription>
              Everyone you add will see the workspace’s conversations and shared
              integrations.
            </FieldDescription>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={resetWorkspaceDialog} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={saving || !workspaceName.trim()}
              onClick={() => void createWorkspace()}
            >
              {saving ? (
                <>
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />{" "}
                  Creating…
                </>
              ) : (
                "Create workspace"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              Use a clear name so members can identify this workspace.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rename-workspace-name">
              Workspace name
            </FieldLabel>
            <Input
              id="rename-workspace-name"
              onChange={(event) => setWorkspaceName(event.target.value)}
              value={workspaceName}
            />
          </Field>
          <DialogFooter>
            <Button
              onClick={() => setRenameDialogOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={saving || !workspaceName.trim()}
              onClick={() => void renameWorkspace()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={memberDialogOpen} onOpenChange={setMemberDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add workspace member</DialogTitle>
            <DialogDescription>
              The person must already have a JustAI account. Invitations by
              email can be added once mail delivery is configured.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="member-email">Account email</FieldLabel>
              <Input
                autoComplete="email"
                id="member-email"
                onChange={(event) => setMemberEmail(event.target.value)}
                placeholder="teammate@example.com"
                type="email"
                value={memberEmail}
              />
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Select
                onValueChange={(value) =>
                  value && setMemberRole(value as MemberRole)
                }
                value={memberRole}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              onClick={() => setMemberDialogOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={saving || !memberEmail.trim()}
              onClick={() => void addMember()}
            >
              {saving ? (
                <>
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />{" "}
                  Adding…
                </>
              ) : (
                <>
                  <UserPlus data-icon="inline-start" /> Add member
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removeTarget?.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This person will lose access to {activeOrganization?.name}. Their
              existing workspace data remains available to the workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void removeMember()}
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "recently"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    date
  )
}
