"use client"

import { UsageAdminCard } from "@/components/usage-admin-card"
import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useRef, useState } from "react"
import { Search, Trash2, UserPlus } from "lucide-react"

import { api, resolveAPIURL } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type {
  AdminAnalyticsResponse,
  Endpoint,
  MCPServer,
  Organization,
  OrganizationMember,
  User,
} from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { MemberDirectoryRow } from "@/components/member-directory-row"
import { Frame } from "@/components/panelui/frame"
import { Button } from "@/components/panelui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "@/components/panelui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/panelui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import { versionedAvatarURL } from "@/lib/identity"
import { WorkspaceSettingsDashboard } from "@/components/workspace-settings-dashboard"

type MemberRole = OrganizationMember["role"]

type SettingsViewProps = {
  user: User
  organizations: Organization[]
  endpoints?: Endpoint[]
  mcpServers?: MCPServer[]
  activeOrganizationId: string | null
  onOrganizationSelect: (organizationId: string) => void
  onOrganizationCreated: (organization: Organization) => void
  onOrganizationUpdated: (organization: Organization) => void
  onOrganizationRemoved?: (organizationId: string) => void
  workspaceCreateRequest?: number
  memberCreateRequest?: number
  section?: "workspace" | "members" | "lifecycle"
}

export function SettingsView({
  user,
  organizations,
  endpoints = [],
  mcpServers = [],
  activeOrganizationId,
  onOrganizationCreated,
  onOrganizationUpdated,
  onOrganizationRemoved,
  workspaceCreateRequest,
  memberCreateRequest,
  section = "workspace",
}: SettingsViewProps) {
  const { t, locale } = useTranslations()

  const [members, setMembers] = useState<OrganizationMember[]>([])
  const [memberSearch, setMemberSearch] = useState("")
  const [memberFilter, setMemberFilter] = useState("all")
  const [memberPage, setMemberPage] = useState(1)
  const [memberTotal, setMemberTotal] = useState(0)
  const [memberFiltered, setMemberFiltered] = useState(0)
  const memberRequest = useRef(0)
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState("")
  const [analyticsResult, setAnalyticsResult] = useState<{
    organizationId: string
    data: AdminAnalyticsResponse
  } | null>(null)
  const [actionError, setActionError] = useState("")
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [memberDialogOpen, setMemberDialogOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState("")
  const [memberEmail, setMemberEmail] = useState("")
  const [memberRole, setMemberRole] = useState<MemberRole>("member")
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [updatingMemberId, setUpdatingMemberId] = useState("")
  const [lifecycleAction, setLifecycleAction] = useState<
    "archive" | "leave" | null
  >(null)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState("")
  const [ownerTransferTarget, setOwnerTransferTarget] =
    useState<OrganizationMember | null>(null)
  const [ownerTransferBusy, setOwnerTransferBusy] = useState(false)
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
  const isMembersSection = section === "members"

  const loadMembers = useCallback(async () => {
    if (!activeOrganization) {
      setMembers([])
      return
    }
    const request = ++memberRequest.current
    setMembersLoading(true)
    setMembersError("")
    try {
      const params = new URLSearchParams({
        page: String(memberPage),
        search: memberSearch,
        role: memberFilter === "all" ? "" : memberFilter,
      })
      const result = await api.get<{
        members: OrganizationMember[]
        total: number
        filtered: number
        page: number
      }>(`/api/v1/organizations/${activeOrganization.id}/members?${params}`)
      if (request !== memberRequest.current) return
      setMembers(result.members)
      setMemberTotal(result.total)
      setMemberFiltered(result.filtered)
      setMemberPage(result.page)
    } catch (caught) {
      if (request !== memberRequest.current) return
      setMembersError(
        caught instanceof Error
          ? caught.message
          : "Members could not be loaded."
      )
    } finally {
      if (request === memberRequest.current) setMembersLoading(false)
    }
  }, [activeOrganization, memberPage, memberSearch, memberFilter])

  const invalidateMemberRequest = useCallback(() => {
    memberRequest.current++
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMembers()
    }, 250)
    return () => {
      window.clearTimeout(timer)
      invalidateMemberRequest()
    }
  }, [loadMembers, invalidateMemberRequest])

  useEffect(() => {
    if (section !== "workspace" || !activeOrganization || !canManageMembers) {
      return
    }
    let cancelled = false
    void api
      .get<AdminAnalyticsResponse>(
        `/api/v1/organizations/${activeOrganization.id}/admin/analytics?days=90`
      )
      .then((result) => {
        if (!cancelled) {
          setAnalyticsResult({
            organizationId: activeOrganization.id,
            data: result,
          })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeOrganization, canManageMembers, section])

  const analytics =
    analyticsResult?.organizationId === activeOrganization?.id
      ? analyticsResult.data
      : null
  const analyticsLoading = canManageMembers && analytics === null

  const openWorkspaceDialog = useCallback(() => {
    setWorkspaceName("")
    setActionError("")
    setWorkspaceDialogOpen(true)
  }, [])

  const openMemberDialog = useCallback(() => {
    setMemberEmail("")
    setMemberRole("member")
    setActionError("")
    setMemberDialogOpen(true)
  }, [])

  function resetWorkspaceDialog() {
    setWorkspaceName("")
    setWorkspaceDialogOpen(false)
  }

  function openRenameDialog() {
    setWorkspaceName(activeOrganization?.name ?? "")
    setActionError("")
    setRenameDialogOpen(true)
  }

  async function createWorkspace(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
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
      notifySuccess("Workspace created", result.organization.name)
      resetWorkspaceDialog()
    } catch (caught) {
      setActionError(
        notifyError(
          "Workspace could not be created",
          caught,
          "The workspace could not be created."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function renameWorkspace(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
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
      notifySuccess("Workspace renamed", result.organization.name)
      setRenameDialogOpen(false)
    } catch (caught) {
      setActionError(
        notifyError(
          "Workspace could not be renamed",
          caught,
          "The workspace could not be renamed."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function addMember(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
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
      notifySuccess("Member added")
      await loadMembers()
    } catch (caught) {
      setActionError(
        notifyError(
          "Member could not be added",
          caught,
          "The member could not be added."
        )
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
    if (updatingMemberId) return
    if (role === "owner" && member.role !== "owner") {
      setOwnerTransferTarget(member)
      return
    }
    setUpdatingMemberId(member.id)
    setActionError("")
    try {
      await api.patch(
        `/api/v1/organizations/${activeOrganization.id}/members/${member.id}`,
        { role }
      )
      await loadMembers()
    } catch (caught) {
      setActionError(
        notifyError(
          "Member role could not be updated",
          caught,
          "The member role could not be updated."
        )
      )
    } finally {
      setUpdatingMemberId("")
    }
  }

  async function transferOwnership() {
    if (!activeOrganization || !ownerTransferTarget) return
    const target = ownerTransferTarget
    setOwnerTransferBusy(true)
    setActionError("")
    try {
      await api.patch(
        `/api/v1/organizations/${activeOrganization.id}/members/${target.id}`,
        { role: "owner" }
      )
      setOwnerTransferTarget(null)
      notifySuccess("Ownership transferred", target.displayName || target.email)
      await loadMembers()
    } catch (caught) {
      setActionError(
        notifyError(
          "Ownership could not be transferred",
          caught,
          "The workspace ownership could not be transferred."
        )
      )
    } finally {
      setOwnerTransferBusy(false)
    }
  }

  async function removeMember() {
    if (!activeOrganization || !removeTarget) return
    const target = removeTarget
    setRemoving(true)
    setActionError("")
    try {
      await api.delete(
        `/api/v1/organizations/${activeOrganization.id}/members/${target.id}`
      )
      setRemoveTarget(null)
      notifySuccess("Member removed", target.displayName || target.email)
      await loadMembers()
    } catch (caught) {
      setActionError(
        notifyError(
          "Member could not be removed",
          caught,
          "The member could not be removed."
        )
      )
    } finally {
      setRemoving(false)
    }
  }

  async function archiveWorkspace() {
    if (!activeOrganization) return
    setLifecycleBusy(true)
    setActionError("")
    try {
      await api.post(`/api/v1/organizations/${activeOrganization.id}/archive`)
      notifySuccess("Workspace archived", activeOrganization.name)
      setLifecycleAction(null)
      onOrganizationRemoved?.(activeOrganization.id)
    } catch (caught) {
      setActionError(
        notifyError(
          "Workspace could not be archived",
          caught,
          "The workspace could not be archived."
        )
      )
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function leaveWorkspace() {
    if (!activeOrganization) return
    setLifecycleBusy(true)
    setActionError("")
    try {
      await api.delete(`/api/v1/organizations/${activeOrganization.id}/leave`)
      notifySuccess("You left the workspace", activeOrganization.name)
      setLifecycleAction(null)
      onOrganizationRemoved?.(activeOrganization.id)
    } catch (caught) {
      setActionError(
        notifyError(
          "Could not leave workspace",
          caught,
          "You could not leave this workspace."
        )
      )
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function deleteWorkspace(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!activeOrganization || deleteConfirmation !== activeOrganization.name)
      return
    setLifecycleBusy(true)
    setActionError("")
    try {
      await api.delete(`/api/v1/organizations/${activeOrganization.id}`, {
        confirmation: deleteConfirmation,
      })
      notifySuccess("Workspace deleted", activeOrganization.name)
      setDeleteDialogOpen(false)
      setDeleteConfirmation("")
      onOrganizationRemoved?.(activeOrganization.id)
    } catch (caught) {
      setActionError(
        notifyError(
          "Workspace could not be deleted",
          caught,
          "The workspace could not be deleted."
        )
      )
    } finally {
      setLifecycleBusy(false)
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
    <div className="w-full space-y-5">
      {actionError && (
        <Alert aria-live="polite" role="alert" variant="destructive">
          <AlertTitle>{t("Could not save changes")}</AlertTitle>
          <AlertDescription>{t(actionError)}</AlertDescription>
        </Alert>
      )}

      {activeOrganization && section === "workspace" && (
        <WorkspaceSettingsDashboard
          analytics={analytics}
          analyticsLoading={analyticsLoading}
          canManage={canManageMembers}
          endpoints={endpoints}
          mcpServers={mcpServers}
          memberCount={memberTotal}
          membersLoading={membersLoading}
          onRename={openRenameDialog}
          organization={activeOrganization}
        />
      )}

      {activeOrganization && section === "lifecycle" && (
        <Frame>
          <Frame.Header>
            <Frame.Title>{t("Workspace lifecycle")}</Frame.Title>
            <Frame.Description>
              {t("Archive, leave, or permanently remove this workspace.")}
            </Frame.Description>
          </Frame.Header>
          <Frame.Panel>
            {activeOrganization.role !== "owner" ? (
              <Frame.Row>
                <Frame.Content>
                  <Frame.Title as="p">{t("Leave workspace")}</Frame.Title>
                  <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                    {t("Remove yourself from this workspace.")}
                  </Frame.Description>
                </Frame.Content>
                <Frame.Actions>
                  <Button
                    onClick={() => setLifecycleAction("leave")}
                    size="sm"
                    variant="outline"
                  >
                    {t("Leave workspace")}
                  </Button>
                </Frame.Actions>
              </Frame.Row>
            ) : (
              <>
                <Frame.Row>
                  <Frame.Content>
                    <Frame.Title as="p">{t("Archive workspace")}</Frame.Title>
                    <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                      {t("Hide this workspace without deleting its content.")}
                    </Frame.Description>
                  </Frame.Content>
                  <Frame.Actions>
                    <Button
                      onClick={() => setLifecycleAction("archive")}
                      size="sm"
                      variant="outline"
                    >
                      {t("Archive workspace")}
                    </Button>
                  </Frame.Actions>
                </Frame.Row>
                <Frame.Row>
                  <Frame.Content>
                    <Frame.Title as="p">{t("Delete workspace")}</Frame.Title>
                    <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                      {t(
                        "Permanently remove it and its content. This cannot be undone."
                      )}
                    </Frame.Description>
                  </Frame.Content>
                  <Frame.Actions>
                    <Button
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setDeleteConfirmation("")
                        setDeleteDialogOpen(true)
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {t("Delete workspace")}
                    </Button>
                  </Frame.Actions>
                </Frame.Row>
              </>
            )}
          </Frame.Panel>
        </Frame>
      )}

      {activeOrganization && isMembersSection && (
        <UsageAdminCard
          key={activeOrganization.id}
          organizationId={activeOrganization.id}
          canManage={canManageMembers}
        >
          {(renderMemberUsage) => (
            <Frame>
              <Frame.Header>
                <Frame.Title>{t("Member directory")}</Frame.Title>
                <Frame.Description>
                  {t("People with access to")} {activeOrganization.name}.
                </Frame.Description>
                {!membersLoading && (
                  <Frame.Action>
                    {memberTotal} {t(memberTotal === 1 ? "member" : "members")}
                  </Frame.Action>
                )}
              </Frame.Header>
              <Frame.Panel>
                {(memberTotal > 20 ||
                  memberSearch ||
                  memberFilter !== "all") && (
                  <Frame.Row>
                    <Frame.Content className="flex flex-row flex-wrap items-center gap-2">
                      <Input.Group className="w-full sm:max-w-sm">
                        <Input.Addon>
                          <Search aria-hidden="true" />
                        </Input.Addon>
                        <Input
                          aria-label={t("Search members")}
                          placeholder={t("Search by name or email…")}
                          value={memberSearch}
                          onChange={(event) => {
                            setMemberSearch(event.target.value)
                            setMemberPage(1)
                            memberRequest.current++
                            setMembersLoading(true)
                          }}
                        />
                      </Input.Group>
                      <Select
                        value={memberFilter}
                        onValueChange={(value) => {
                          if (value) {
                            setMemberFilter(value)
                            setMemberPage(1)
                            memberRequest.current++
                            setMembersLoading(true)
                          }
                        }}
                      >
                        <SelectTrigger
                          aria-label={t("Filter by role")}
                          className="w-40"
                        >
                          <SelectValue>
                            {memberFilter === "all"
                              ? t("All roles")
                              : t(
                                  memberFilter === "owner"
                                    ? "Owner"
                                    : memberFilter === "admin"
                                      ? "Admin"
                                      : "Member"
                                )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {[
                              ["all", "All roles"],
                              ["owner", "Owner"],
                              ["admin", "Admin"],
                              ["member", "Member"],
                            ].map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {t(label)}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Frame.Content>
                  </Frame.Row>
                )}
                {membersError ? (
                  <Frame.Row>
                    <Frame.Content className="items-start gap-3">
                      <p className="text-sm text-destructive" role="alert">
                        {t("Members could not be loaded.")}
                      </p>
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => void loadMembers()}
                      >
                        {t("Try again")}
                      </Button>
                    </Frame.Content>
                  </Frame.Row>
                ) : membersLoading ? (
                  <Frame.Row>
                    <Frame.Content>
                      <p
                        aria-live="polite"
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                        role="status"
                      >
                        <Spinner /> {t("Loading members…")}
                      </p>
                    </Frame.Content>
                  </Frame.Row>
                ) : members.length === 0 ? (
                  <Frame.Row>
                    <Frame.Content>
                      <p className="text-center text-sm text-muted-foreground">
                        {t("No members found.")}
                      </p>
                    </Frame.Content>
                  </Frame.Row>
                ) : (
                  members.map((member) => (
                    <MemberDirectoryRow
                      key={member.id}
                      name={member.displayName}
                      email={member.email}
                      avatarUrl={
                        member.avatarUrl
                          ? resolveAPIURL(
                              versionedAvatarURL(
                                member.avatarUrl,
                                member.avatarVersion
                              ) ?? member.avatarUrl
                            )
                          : undefined
                      }
                      detail={
                        <>
                          {t("Joined")} {formatDate(member.createdAt, locale)}
                        </>
                      }
                      actions={
                        <>
                          {renderMemberUsage(member.id)}
                          <Select
                            disabled={
                              !canManageMembers ||
                              Boolean(updatingMemberId) ||
                              (!user.platformAdmin &&
                                activeOrganization.role === "admin" &&
                                member.role !== "member")
                            }
                            onValueChange={(value) => {
                              if (value)
                                void updateMemberRole(
                                  member,
                                  value as MemberRole
                                )
                            }}
                            value={member.role}
                          >
                            <SelectTrigger
                              className="w-32"
                              aria-label={t("Role for {value0}", {
                                value0: member.displayName,
                              })}
                            >
                              <SelectValue>
                                {t(
                                  member.role === "owner"
                                    ? "Owner"
                                    : member.role === "admin"
                                      ? "Admin"
                                      : "Member"
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="member">
                                  {t("Member")}
                                </SelectItem>
                                <SelectItem value="admin">
                                  {t("Admin")}
                                </SelectItem>
                                {(activeOrganization.role === "owner" ||
                                  user.platformAdmin) && (
                                  <SelectItem value="owner">
                                    {t("Owner")}
                                  </SelectItem>
                                )}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {canManageMembers && member.role !== "owner" && (
                            <Button
                              aria-label={t("Remove {value0}", {
                                value0: member.displayName,
                              })}
                              onClick={() => setRemoveTarget(member)}
                              size="icon-sm"
                              title={t("Remove {value0}", {
                                value0: member.displayName,
                              })}
                              variant="ghost"
                            >
                              <Trash2 className="text-destructive" />
                            </Button>
                          )}
                        </>
                      }
                    />
                  ))
                )}
              </Frame.Panel>
              {!membersError && memberFiltered > 20 && (
                <nav
                  aria-label={t("Member pagination")}
                  className="mt-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <p
                    aria-live="polite"
                    className="text-xs text-muted-foreground"
                  >
                    {t("{start}–{end} of {total}", {
                      start: (memberPage - 1) * 20 + 1,
                      end: Math.min(memberPage * 20, memberFiltered),
                      total: memberFiltered,
                    })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={membersLoading || memberPage === 1}
                      onClick={() => {
                        setMemberPage(memberPage - 1)
                        setMembersLoading(true)
                      }}
                    >
                      {t("Previous page")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        membersLoading || memberPage * 20 >= memberFiltered
                      }
                      onClick={() => {
                        setMemberPage(memberPage + 1)
                        setMembersLoading(true)
                      }}
                    >
                      {t("Next page")}
                    </Button>
                  </div>
                </nav>
              )}
            </Frame>
          )}
        </UsageAdminCard>
      )}

      <Dialog
        open={workspaceDialogOpen}
        onOpenChange={(open) => {
          if (!saving) setWorkspaceDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="contents"
            onSubmit={(event) => void createWorkspace(event)}
          >
            <DialogHeader>
              <DialogTitle>{t("Create workspace")}</DialogTitle>
              <DialogDescription>
                {t(
                  "Start a separate workspace for another team, project, or environment."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {actionError && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertDescription>{t(actionError)}</AlertDescription>
                </Alert>
              )}
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="workspace-name">
                    {t("Workspace name")}
                  </FieldLabel>
                  <Input
                    id="workspace-name"
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder={t("Product team")}
                    required
                    value={workspaceName}
                  />
                </Field>
                <FieldDescription>
                  {t(
                    "Everyone you add will see the workspace’s conversations and shared integrations."
                  )}
                </FieldDescription>
              </FieldGroup>
            </DialogBody>
            <DialogFooter>
              <Button
                onClick={resetWorkspaceDialog}
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving || !workspaceName.trim()} type="submit">
                {saving ? (
                  <>
                    <Spinner data-icon="inline-start" /> {t("Creating…")}
                  </>
                ) : (
                  t("Create workspace")
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameDialogOpen}
        onOpenChange={(open) => {
          if (!saving) setRenameDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="contents"
            onSubmit={(event) => void renameWorkspace(event)}
          >
            <DialogHeader>
              <DialogTitle>{t("Rename workspace")}</DialogTitle>
              <DialogDescription>
                {t("Use a clear name so members can identify this workspace.")}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {actionError && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertDescription>{t(actionError)}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="rename-workspace-name">
                  {t("Workspace name")}
                </FieldLabel>
                <Input
                  id="rename-workspace-name"
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  value={workspaceName}
                  required
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button
                onClick={() => setRenameDialogOpen(false)}
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving || !workspaceName.trim()} type="submit">
                {saving ? t("Saving…") : t("Save changes")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={memberDialogOpen}
        onOpenChange={(open) => {
          if (!saving) setMemberDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="contents"
            onSubmit={(event) => void addMember(event)}
          >
            <DialogHeader>
              <DialogTitle>{t("Add workspace member")}</DialogTitle>
              <DialogDescription>
                {t(
                  "The person must already have a JustAI account. Invitations by email can be added once mail delivery is configured."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {actionError && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertDescription>{t(actionError)}</AlertDescription>
                </Alert>
              )}
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="member-email">
                    {t("Account email")}
                  </FieldLabel>
                  <Input
                    autoComplete="email"
                    id="member-email"
                    onChange={(event) => setMemberEmail(event.target.value)}
                    placeholder="teammate@example.com"
                    type="email"
                    value={memberEmail}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="member-role">{t("Role")}</FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      value && setMemberRole(value as MemberRole)
                    }
                    value={memberRole}
                  >
                    <SelectTrigger className="w-full" id="member-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">{t("Member")}</SelectItem>
                      <SelectItem value="admin">{t("Admin")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
            </DialogBody>
            <DialogFooter>
              <Button
                onClick={() => setMemberDialogOpen(false)}
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={saving || !memberEmail.trim()} type="submit">
                {saving ? (
                  <>
                    <Spinner data-icon="inline-start" /> {t("Adding…")}
                  </>
                ) : (
                  <>
                    <UserPlus data-icon="inline-start" /> {t("Add member")}
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={removeTarget !== null}
        title={t("Remove {value0}?", {
          value0:
            removeTarget?.displayName || removeTarget?.email || "this member",
        })}
        description={t(
          "This person will lose access to {value0}. Their existing workspace data remains available to the workspace.",
          { value0: activeOrganization?.name ?? "this workspace" }
        )}
        confirmLabel={t("Remove member")}
        pending={removing}
        onOpenChange={(open) => {
          if (!open && !removing) setRemoveTarget(null)
        }}
        onConfirm={removeMember}
      />

      <ConfirmActionDialog
        open={ownerTransferTarget !== null}
        title={t("Transfer ownership to {value0}?", {
          value0:
            ownerTransferTarget?.displayName ||
            ownerTransferTarget?.email ||
            "this member",
        })}
        description={t(
          "You will become an admin of {value0}. {value1} will become the new owner.",
          {
            value0: activeOrganization?.name ?? "this workspace",
            value1:
              ownerTransferTarget?.displayName ||
              ownerTransferTarget?.email ||
              "This member",
          }
        )}
        confirmLabel={t("Transfer ownership")}
        pending={ownerTransferBusy}
        destructive={false}
        onOpenChange={(open) => {
          if (!open && !ownerTransferBusy) setOwnerTransferTarget(null)
        }}
        onConfirm={transferOwnership}
      />

      <ConfirmActionDialog
        open={lifecycleAction !== null}
        title={
          lifecycleAction === "archive"
            ? t("Archive {value0}?", {
                value0: activeOrganization?.name ?? "this workspace",
              })
            : t("Leave {value0}?", {
                value0: activeOrganization?.name ?? "this workspace",
              })
        }
        description={
          lifecycleAction === "archive"
            ? t(
                "Members will lose access until a platform administrator restores the workspace. Existing data is retained."
              )
            : t(
                "You will lose access to this workspace. Existing workspace data remains available to its members."
              )
        }
        confirmLabel={
          lifecycleAction === "archive"
            ? t("Archive workspace")
            : t("Leave workspace")
        }
        pending={lifecycleBusy}
        onOpenChange={(open) => {
          if (!open && !lifecycleBusy) setLifecycleAction(null)
        }}
        onConfirm={
          lifecycleAction === "archive" ? archiveWorkspace : leaveWorkspace
        }
      />

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!lifecycleBusy) setDeleteDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form
            className="contents"
            onSubmit={(event) => void deleteWorkspace(event)}
          >
            <DialogHeader>
              <DialogTitle>
                {t("Delete")} {activeOrganization?.name ?? "workspace"}?
              </DialogTitle>
              <DialogDescription>
                {t(
                  "This permanently removes the workspace and its data. Type the exact workspace name to confirm."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field>
                <FieldLabel htmlFor="delete-workspace-confirmation">
                  {t("Workspace name")}
                </FieldLabel>
                <Input
                  autoComplete="off"
                  id="delete-workspace-confirmation"
                  value={deleteConfirmation}
                  onChange={(event) =>
                    setDeleteConfirmation(event.target.value)
                  }
                  placeholder={activeOrganization?.name}
                  required
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteDialogOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  lifecycleBusy ||
                  deleteConfirmation !== (activeOrganization?.name ?? "")
                }
              >
                {lifecycleBusy ? t("Deleting…") : t("Delete workspace")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatDate(value: string, locale: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "recently"
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
}
