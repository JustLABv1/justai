"use client"
import { ToastFeedback } from "@/components/toast-feedback"
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react"
import {
  Ban,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { MemberDirectoryRow } from "@/components/member-directory-row"
import { Frame } from "@/components/panelui/frame"

import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Input } from "@/components/panelui/input"
import { Dialog } from "@/components/panelui/dialog"
import { Sheet } from "@/components/panelui/sheet"
import { Menu } from "@/components/panelui/menu"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/panelui/select"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import { api } from "@/lib/api"
import { notifySuccess } from "@/lib/feedback"
import type { PlatformSession } from "@/lib/types"

export function PlatformUsersView({
  users,
  query,
  status,
  onQueryChange,
  onStatusChange,
  onUpdate,
  onReload,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  users: any[]
  query: string
  status: string
  onQueryChange: (value: string) => void
  onStatusChange: (value: string) => void
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  onReload: () => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t, locale } = useTranslations()

  const [detail, setDetail] = useState<any | null>(null)
  const [actionError, setActionError] = useState("")
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<{
    item: any
    owned: any[]
  } | null>(null)
  const [deletePhrase, setDeletePhrase] = useState("")
  const [revokeCandidate, setRevokeCandidate] = useState<any | null>(null)
  const [sessionBusyId, setSessionBusyId] = useState("")
  const [confirmAction, setConfirmAction] = useState<{
    item: any
    patch: Record<string, unknown>
    title: string
    description: string
    confirmLabel: string
    destructive?: boolean
  } | null>(null)
  const [confirmPending, setConfirmPending] = useState(false)

  function requestUserAction(item: any, patch: Record<string, unknown>) {
    const isAdminChange = Object.prototype.hasOwnProperty.call(
      patch,
      "platformAdmin"
    )
    const isSuspension = patch.status === "suspended"
    const verb = isAdminChange
      ? item.platformAdmin
        ? t("Demote")
        : t("Promote")
      : isSuspension
        ? t("Suspend")
        : t("Unsuspend")
    setConfirmAction({
      item,
      patch,
      title: `${verb} ${item.displayName ?? "this user"}?`,
      description: isAdminChange
        ? t(
            "Changing platform administrator access affects every workspace and platform control."
          )
        : isSuspension
          ? t(
              "Suspending this user revokes their current access and prevents new sign-ins until they are unsuspended."
            )
          : t(
              "This user will be able to sign in and use their workspaces again."
            ),
      confirmLabel: verb,
      destructive: isSuspension || isAdminChange,
    })
  }

  async function confirmUserAction() {
    if (!confirmAction) return
    setConfirmPending(true)
    try {
      await onUpdate(confirmAction.item.id, confirmAction.patch)
      setConfirmAction(null)
    } finally {
      setConfirmPending(false)
    }
  }

  async function showDetail(id: string) {
    setLoadingDetail(true)
    setActionError("")
    try {
      const [result, sessionResult] = await Promise.all([
        api.get<{ user: any; organizations: any[] }>(
          `/api/v1/admin/users/${id}`
        ),
        api.get<{ sessions: PlatformSession[] }>(
          `/api/v1/admin/users/${id}/sessions`
        ),
      ])
      setDetail({ ...result, sessions: sessionResult.sessions ?? [] })
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "User details could not be loaded."
      )
    } finally {
      setLoadingDetail(false)
    }
  }

  async function revokeSession(session: PlatformSession) {
    const userID = detail?.user?.id
    if (!userID || !session.active) return
    setSessionBusyId(session.id)
    setActionError("")
    try {
      await api.post(
        `/api/v1/admin/users/${userID}/sessions/${session.id}/revoke`
      )
      setDetail((current: any) =>
        current
          ? {
              ...current,
              sessions: (current.sessions ?? []).map((item: PlatformSession) =>
                item.id === session.id
                  ? {
                      ...item,
                      active: false,
                      revokedAt: new Date().toISOString(),
                    }
                  : item
              ),
            }
          : current
      )
      notifySuccess("Session revoked")
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "Session could not be revoked."
      )
    } finally {
      setSessionBusyId("")
    }
  }

  async function openDeleteUser(item: any) {
    setActionError("")
    try {
      const result = await api.get<{ organizations: any[] }>(
        `/api/v1/admin/users/${item.id}`
      )
      const owned = (result.organizations ?? []).filter(
        (organization) => organization.role === "owner"
      )
      setDeletePhrase("")
      setDeleteCandidate({ item, owned })
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "User could not be deleted."
      )
    }
  }

  async function deleteUser() {
    if (!deleteCandidate || deletePhrase !== "DELETE") return
    setActionError("")
    try {
      await api.delete(`/api/v1/admin/users/${deleteCandidate.item.id}`, {
        confirm: true,
        deleteOrganizationIds: deleteCandidate.owned.map(
          (organization) => organization.id
        ),
      })
      setDetail(null)
      setDeleteCandidate(null)
      onReload()
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "User could not be deleted."
      )
    }
  }

  return (
    <>
      {actionError && !detail && (
        <ToastFeedback message={actionError} type={"destructive"} />
      )}
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Member directory")}</Frame.Title>
          <Frame.Description>
            {t("Manage accounts and access across the platform.")}
          </Frame.Description>
          <Frame.Action>
            {t(total === 1 ? "{count} user" : "{count} users", {
              count: total,
            })}
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
                  aria-label={t("Search users…")}
                  placeholder={t("Search by name or email…")}
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                />
              </Input.Group>
              <Select
                value={status || "all"}
                onValueChange={(value) =>
                  onStatusChange(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger aria-label={t("Filter by status")}>
                  <SelectValue>
                    {t(
                      status === "active"
                        ? "Active"
                        : status === "suspended"
                          ? "Suspended"
                          : "All statuses"
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">{t("All statuses")}</SelectItem>
                    <SelectItem value="active">{t("Active")}</SelectItem>
                    <SelectItem value="suspended">{t("Suspended")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </Frame.Row>
          {users.map((item) => (
            <MemberDirectoryRow
              key={item.id}
              name={item.displayName}
              email={item.email}
              onOpen={() => void showDetail(item.id)}
              detail={
                item.createdAt ? (
                  <>
                    {t("Joined")}{" "}
                    {new Date(item.createdAt).toLocaleDateString(locale)}
                  </>
                ) : undefined
              }
              actions={
                <>
                  <Badge
                    variant={
                      item.status === "suspended" ? "destructive" : "success"
                    }
                  >
                    {t(item.status === "suspended" ? "Suspended" : "Active")}
                  </Badge>
                  <Select
                    value={item.platformAdmin ? "admin" : "member"}
                    onValueChange={(value) => {
                      if (
                        value &&
                        (value === "admin") !== Boolean(item.platformAdmin)
                      )
                        requestUserAction(item, {
                          platformAdmin: value === "admin",
                        })
                    }}
                  >
                    <SelectTrigger
                      className="w-40"
                      aria-label={t("Role for {value0}", {
                        value0: item.displayName,
                      })}
                    >
                      <SelectValue>
                        {t(
                          item.platformAdmin
                            ? "Platform admin"
                            : "Standard access"
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="member">
                          {t("Standard access")}
                        </SelectItem>
                        <SelectItem value="admin">
                          {t("Platform admin")}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Menu>
                    <Menu.Trigger
                      render={
                        <Button
                          aria-label={t("Actions for {value0}", {
                            value0: item.displayName,
                          })}
                          size="icon-sm"
                          variant="ghost"
                        />
                      }
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Menu.Trigger>
                    <Menu.Content align="end">
                      <Menu.Group>
                        <Menu.Item onClick={() => void showDetail(item.id)}>
                          <Search aria-hidden="true" /> {t("Details")}
                        </Menu.Item>
                        <Menu.Item
                          onClick={() =>
                            requestUserAction(item, {
                              status:
                                item.status === "suspended"
                                  ? "active"
                                  : "suspended",
                            })
                          }
                        >
                          {item.status === "suspended" ? (
                            <RotateCcw aria-hidden="true" />
                          ) : (
                            <Ban aria-hidden="true" />
                          )}
                          {item.status === "suspended"
                            ? t("Unsuspend")
                            : t("Suspend")}
                        </Menu.Item>
                        <Menu.Item
                          onClick={() =>
                            requestUserAction(item, {
                              platformAdmin: !item.platformAdmin,
                            })
                          }
                        >
                          <ShieldCheck aria-hidden="true" />
                          {item.platformAdmin
                            ? t("Demote admin")
                            : t("Promote admin")}
                        </Menu.Item>
                        <Menu.Item onClick={() => setRevokeCandidate(item)}>
                          <RefreshCw aria-hidden="true" />{" "}
                          {t("Revoke sessions")}
                        </Menu.Item>
                      </Menu.Group>
                      <Menu.Separator />
                      <Menu.Item
                        onClick={() => void openDeleteUser(item)}
                        variant="destructive"
                      >
                        <Trash2 aria-hidden="true" /> {t("Delete user")}
                      </Menu.Item>
                    </Menu.Content>
                  </Menu>
                </>
              }
            />
          ))}
          {!users.length && (
            <Frame.Row>
              <Frame.Description>
                {t("No users match this search.")}
              </Frame.Description>
            </Frame.Row>
          )}
        </Frame.Panel>
        {total > 0 && (
          <Frame.Footer className="flex flex-wrap items-center justify-between gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {t("{start}–{end} of {total}", {
                start: (page - 1) * pageSize + 1,
                end: Math.min((page - 1) * pageSize + users.length, total),
                total,
              })}
            </span>
            {total > pageSize && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)}
                >
                  {t("Previous page")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page * pageSize >= total}
                  onClick={() => onPageChange(page + 1)}
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
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <Sheet.Content className="w-[min(40rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header className="min-w-0 pr-6">
            <Sheet.Title className="break-words">
              {detail?.user?.displayName ?? t("User details")}
            </Sheet.Title>
            <Sheet.Description className="break-all">
              {detail?.user?.email}
            </Sheet.Description>
          </Sheet.Header>
          <Sheet.Body className="flex flex-col gap-5">
            {actionError && (
              <ToastFeedback message={actionError} type={"destructive"} />
            )}
            {loadingDetail ? (
              <p className="text-sm text-muted-foreground">
                {t("Loading user details…")}
              </p>
            ) : detail ? (
              <div className="flex min-w-0 flex-col gap-5 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant={
                      detail.user.status === "suspended"
                        ? "destructive"
                        : "success"
                    }
                  >
                    {t(
                      detail.user.status === "suspended"
                        ? "Suspended"
                        : "Active"
                    )}
                  </Badge>
                  {detail.user.platformAdmin && (
                    <Badge variant="secondary">
                      <ShieldCheck data-icon="inline-start" />
                      {t("platform admin")}
                    </Badge>
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-medium">{t("Workspaces")}</h3>
                  <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                    {(detail.organizations ?? []).map((organization: any) => (
                      <div
                        className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 p-3"
                        key={organization.id}
                      >
                        <span className="min-w-0 font-medium break-words">
                          {organization.name}
                        </span>
                        <span>
                          {t(
                            organization.role === "owner"
                              ? "Owner"
                              : organization.role === "admin"
                                ? "Admin"
                                : "Member"
                          )}{" "}
                          ·{" "}
                          {t(
                            organization.status === "suspended"
                              ? "Suspended"
                              : organization.status === "archived"
                                ? "Archived"
                                : "Active"
                          )}
                        </span>
                      </div>
                    ))}
                    {detail.organizations?.length === 0 && (
                      <span>{t("None")}</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{t("Sessions")}</p>
                    <span className="text-xs text-muted-foreground">
                      {
                        (detail.sessions ?? []).filter(
                          (session: PlatformSession) => session.active
                        ).length
                      }{" "}
                      {t("Active")}
                    </span>
                  </div>
                  <div className="mt-2 flex max-h-64 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain text-xs">
                    {(detail.sessions ?? []).map((session: PlatformSession) => (
                      <div
                        className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-xl bg-muted/50 p-3"
                        key={session.id}
                      >
                        <div className="min-w-0 flex-1 basis-48">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              variant={session.active ? "success" : "secondary"}
                            >
                              {session.active ? t("Active") : t("Revoked")}
                            </Badge>
                            <span className="text-muted-foreground">
                              {t("Last seen")}{" "}
                              {new Date(session.lastSeenAt).toLocaleString(
                                locale
                              )}
                            </span>
                          </div>
                          <details className="mt-2 min-w-0 text-muted-foreground">
                            <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                              {t("Device details")}
                            </summary>
                            <p className="mt-2 break-all whitespace-normal">
                              {session.userAgent || t("No device metadata")}
                            </p>
                            {session.ipAddress && (
                              <p className="mt-1 break-all">
                                IP: {session.ipAddress}
                              </p>
                            )}
                          </details>
                        </div>
                        {session.active && (
                          <Button
                            aria-label={t("Revoke this session")}
                            disabled={sessionBusyId === session.id}
                            onClick={() => void revokeSession(session)}
                            size="sm"
                            variant="outline"
                          >
                            {sessionBusyId === session.id
                              ? t("Revoking…")
                              : t("Revoke")}
                          </Button>
                        )}
                      </div>
                    ))}
                    {detail.sessions?.length === 0 && (
                      <span className="text-muted-foreground">
                        {t("No sessions found.")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </Sheet.Body>
          <Sheet.Footer className="sm:flex-row sm:justify-end">
            {detail?.user && (
              <Menu>
                <Menu.Trigger render={<Button variant="outline" />}>
                  <MoreHorizontal data-icon="inline-start" /> {t("Actions")}
                </Menu.Trigger>
                <Menu.Content align="end">
                  <Menu.Group>
                    <Menu.Item
                      onClick={() =>
                        requestUserAction(detail.user, {
                          status:
                            detail.user.status === "suspended"
                              ? "active"
                              : "suspended",
                        })
                      }
                    >
                      {detail.user.status === "suspended" ? (
                        <RotateCcw aria-hidden="true" />
                      ) : (
                        <Ban aria-hidden="true" />
                      )}
                      {detail.user.status === "suspended"
                        ? t("Unsuspend")
                        : t("Suspend")}
                    </Menu.Item>
                    <Menu.Item
                      onClick={() =>
                        requestUserAction(detail.user, {
                          platformAdmin: !detail.user.platformAdmin,
                        })
                      }
                    >
                      <ShieldCheck aria-hidden="true" />
                      {detail.user.platformAdmin
                        ? t("Demote admin")
                        : t("Promote admin")}
                    </Menu.Item>
                    <Menu.Item onClick={() => setRevokeCandidate(detail.user)}>
                      <RefreshCw aria-hidden="true" /> {t("Revoke sessions")}
                    </Menu.Item>
                  </Menu.Group>
                  <Menu.Separator />
                  <Menu.Item
                    onClick={() => void openDeleteUser(detail.user)}
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" /> {t("Delete user")}
                  </Menu.Item>
                </Menu.Content>
              </Menu>
            )}
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet>
      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteCandidate(null)
            setDeletePhrase("")
          }
        }}
      >
        <Dialog.Content className="sm:max-w-md">
          <Dialog.Header>
            <Dialog.Title>{t("Permanently delete user")}</Dialog.Title>
            <Dialog.Description>
              {deleteCandidate?.owned.length
                ? t(
                    "This also deletes {value0} owned workspace(s). Type DELETE to continue.",
                    { value0: deleteCandidate.owned.length }
                  )
                : t(
                    "This permanently removes {value0}. Type DELETE to continue.",
                    { value0: deleteCandidate?.item.displayName ?? "this user" }
                  )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Input
              aria-label={t("Type DELETE to confirm")}
              autoComplete="off"
              onChange={(event) => setDeletePhrase(event.target.value)}
              placeholder="DELETE"
              value={deletePhrase}
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button onClick={() => setDeleteCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              disabled={deletePhrase !== "DELETE"}
              onClick={() => void deleteUser()}
              variant="destructive"
            >
              {t("Delete user")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
      <Dialog
        open={revokeCandidate !== null}
        onOpenChange={(open) => !open && setRevokeCandidate(null)}
      >
        <Dialog.Content className="sm:max-w-md">
          <Dialog.Header>
            <Dialog.Title>{t("Revoke active sessions")}</Dialog.Title>
            <Dialog.Description>
              {t(
                "Every active session for {value0} will need to sign in again.",
                { value0: revokeCandidate?.displayName ?? "this user" }
              )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button onClick={() => setRevokeCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              onClick={() => {
                const userToRevoke = revokeCandidate
                if (!userToRevoke) return
                void api
                  .post(
                    `/api/v1/admin/users/${userToRevoke.id}/revoke-sessions`
                  )
                  .then(onReload)
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error
                        ? caught.message
                        : "Sessions could not be revoked."
                    )
                  )
                  .finally(() => setRevokeCandidate(null))
              }}
            >
              {t("Revoke sessions")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
      <ConfirmActionDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? "Confirm user action"}
        description={confirmAction?.description ?? ""}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        destructive={confirmAction?.destructive}
        pending={confirmPending}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        onConfirm={confirmUserAction}
      />
    </>
  )
}
