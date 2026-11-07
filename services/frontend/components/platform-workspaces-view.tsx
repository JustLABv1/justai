"use client"
import { ToastFeedback } from "@/components/toast-feedback"
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react"
import {
  Archive,
  ArrowLeftRight,
  Ban,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { MemberDirectoryRow } from "@/components/member-directory-row"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import { Frame } from "@/components/panelui/frame"
import { Avatar } from "@/components/panelui/avatar"

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
import { api } from "@/lib/api"
export function PlatformWorkspacesView({
  workspaces,
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
  workspaces: any[]
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
  const { t } = useTranslations()

  const [detail, setDetail] = useState<any | null>(null)
  const [actionError, setActionError] = useState("")
  const [transferCandidate, setTransferCandidate] = useState<any | null>(null)
  const [newOwnerID, setNewOwnerID] = useState("")
  const [deleteCandidate, setDeleteCandidate] = useState<any | null>(null)
  const [deletePhrase, setDeletePhrase] = useState("")
  const [confirmAction, setConfirmAction] = useState<{
    item: any
    patch: Record<string, unknown>
    title: string
    description: string
    confirmLabel: string
  } | null>(null)
  const [confirmPending, setConfirmPending] = useState(false)

  function requestWorkspaceAction(item: any, patch: Record<string, unknown>) {
    const nextStatus = patch.status
    const isArchive = item.status === "archived" || nextStatus === "archived"
    const isSuspend = !isArchive && nextStatus === "suspended"
    const verb = isArchive
      ? item.status === "archived"
        ? t("Restore")
        : t("Archive")
      : isSuspend
        ? t("Suspend")
        : t("Unsuspend")
    setConfirmAction({
      item,
      patch,
      title: `${verb} ${item.name ?? "this workspace"}?`,
      description: isArchive
        ? item.status === "archived"
          ? t(
              "Restoring this workspace makes its resources available to members again."
            )
          : t(
              "Archiving this workspace hides it from normal use until an administrator restores it."
            )
        : isSuspend
          ? t(
              "Suspending this workspace blocks member access and active work until it is unsuspended."
            )
          : t("Members will be able to access this workspace again."),
      confirmLabel: verb,
    })
  }

  async function confirmWorkspaceAction() {
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
    setActionError("")
    try {
      setDetail(await api.get(`/api/v1/admin/organizations/${id}`))
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "Workspace details could not be loaded."
      )
    }
  }

  return (
    <>
      {actionError && (
        <ToastFeedback message={actionError} type={"destructive"} />
      )}
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Workspace directory")}</Frame.Title>
          <Frame.Description>
            {t("Manage workspaces, members and access across the platform.")}
          </Frame.Description>
          <Frame.Action>
            {t(total === 1 ? "{count} workspace" : "{count} workspaces", {
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
                  aria-label={t("Search workspaces…")}
                  placeholder={t("Search workspaces…")}
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                />
              </Input.Group>
              <Select
                value={status || "all"}
                onValueChange={(value) =>
                  onStatusChange(!value || value === "all" ? "" : value)
                }
              >
                <SelectTrigger aria-label={t("Filter by status")}>
                  <SelectValue>
                    {t(
                      status === "active"
                        ? "Active"
                        : status === "suspended"
                          ? "Suspended"
                          : status === "archived"
                            ? "Archived"
                            : "All statuses"
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">{t("All statuses")}</SelectItem>
                    <SelectItem value="active">{t("Active")}</SelectItem>
                    <SelectItem value="suspended">{t("Suspended")}</SelectItem>
                    <SelectItem value="archived">{t("Archived")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </Frame.Row>
          {workspaces.map((item) => (
            <Frame.Row key={item.id} className="flex-wrap gap-y-3">
              <Frame.Media>
                <Avatar name={item.name} size="sm" />
              </Frame.Media>
              <Frame.Content className="min-w-40">
                <Frame.Title as="p">
                  <button
                    type="button"
                    className="max-w-full truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void showDetail(item.id)}
                  >
                    {item.name}
                  </button>
                </Frame.Title>
                <Frame.Description>{item.slug}</Frame.Description>
              </Frame.Content>
              <Frame.Actions className="ml-auto flex-wrap justify-end gap-3">
                <span className="text-xs text-muted-foreground">
                  {item.members} {t(item.members === 1 ? "member" : "members")}
                </span>
                <Badge
                  variant={
                    item.status === "suspended"
                      ? "destructive"
                      : item.status === "archived"
                        ? "secondary"
                        : "success"
                  }
                >
                  {t(
                    item.status === "suspended"
                      ? "Suspended"
                      : item.status === "archived"
                        ? "Archived"
                        : "Active"
                  )}
                </Badge>{" "}
                <Menu>
                  <Menu.Trigger
                    render={
                      <Button
                        aria-label={t("Actions for {value0}", {
                          value0: item.name,
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
                          requestWorkspaceAction(item, {
                            status:
                              item.status === "archived"
                                ? "active"
                                : "archived",
                          })
                        }
                      >
                        {item.status === "archived" ? (
                          <RotateCcw aria-hidden="true" />
                        ) : (
                          <Archive aria-hidden="true" />
                        )}
                        {item.status === "archived"
                          ? t("Restore")
                          : t("Archive")}
                      </Menu.Item>
                      <Menu.Item
                        onClick={() =>
                          requestWorkspaceAction(item, {
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
                        onClick={() => {
                          setNewOwnerID("")
                          setTransferCandidate(item)
                        }}
                      >
                        <ArrowLeftRight aria-hidden="true" />{" "}
                        {t("Transfer ownership")}
                      </Menu.Item>
                    </Menu.Group>
                    <Menu.Separator />
                    <Menu.Item
                      onClick={() => {
                        setDeletePhrase("")
                        setDeleteCandidate(item)
                      }}
                      variant="destructive"
                    >
                      <Trash2 aria-hidden="true" /> {t("Delete workspace")}
                    </Menu.Item>
                  </Menu.Content>
                </Menu>
              </Frame.Actions>
            </Frame.Row>
          ))}
          {!workspaces.length && (
            <Frame.Row>
              <Frame.Description>
                {t("No workspaces match this search.")}
              </Frame.Description>
            </Frame.Row>
          )}
        </Frame.Panel>
        {total > 0 && (
          <Frame.Footer className="flex flex-wrap items-center justify-between gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {t("{start}–{end} of {total}", {
                start: (page - 1) * pageSize + 1,
                end: Math.min((page - 1) * pageSize + workspaces.length, total),
                total,
              })}
            </span>
            {total > pageSize && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)}
                >
                  {t("Previous page")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
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
              {detail?.organization?.name ?? t("Workspace details")}
            </Sheet.Title>
            <Sheet.Description className="break-all">
              {detail?.organization?.slug}
            </Sheet.Description>
          </Sheet.Header>
          <Sheet.Body>
            {detail && (
              <div className="flex min-w-0 flex-col gap-5">
                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant={
                      detail.organization.status === "suspended"
                        ? "destructive"
                        : detail.organization.status === "archived"
                          ? "secondary"
                          : "success"
                    }
                  >
                    {t(
                      detail.organization.status === "suspended"
                        ? "Suspended"
                        : detail.organization.status === "archived"
                          ? "Archived"
                          : "Active"
                    )}
                  </Badge>
                  <Badge variant="outline">
                    {detail.members?.length ?? 0}{" "}
                    {t(detail.members?.length === 1 ? "member" : "members")}
                  </Badge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ResourceCount
                    label={t("Conversations")}
                    value={detail.resources?.conversations}
                  />
                  <ResourceCount
                    label={t("Endpoints")}
                    value={detail.resources?.endpoints}
                  />
                  <ResourceCount
                    label={t("MCP servers")}
                    value={detail.resources?.mcpServers}
                  />
                  <ResourceCount
                    label={t("Knowledge sources")}
                    value={detail.resources?.knowledgeSources}
                  />
                  <ResourceCount
                    label={t("Transcriptions")}
                    value={detail.resources?.transcriptions}
                  />
                </div>
                <section
                  aria-label={t("Members")}
                  className="flex min-w-0 flex-col gap-2 text-xs"
                >
                  <h3 className="text-sm font-medium">{t("Members")}</h3>
                  <Frame>
                    <Frame.Panel className="max-h-64 overflow-y-auto">
                      {(detail.members ?? []).map((member: any) => (
                        <MemberDirectoryRow
                          key={member.id}
                          name={member.displayName}
                          email={member.email}
                          actions={
                            <Badge variant="secondary">
                              {t(
                                member.role === "owner"
                                  ? "Owner"
                                  : member.role === "admin"
                                    ? "Admin"
                                    : "Member"
                              )}
                            </Badge>
                          }
                        />
                      ))}
                      {!detail.members?.length && (
                        <Frame.Row>
                          <Frame.Description>
                            {t("No members found.")}
                          </Frame.Description>
                        </Frame.Row>
                      )}
                    </Frame.Panel>
                  </Frame>
                </section>
              </div>
            )}
          </Sheet.Body>
          <Sheet.Footer>
            <Button onClick={() => setDetail(null)} variant="outline">
              {t("Close")}
            </Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet>
      <Dialog
        open={transferCandidate !== null}
        onOpenChange={(open) => !open && setTransferCandidate(null)}
      >
        <Dialog.Content className="sm:max-w-md">
          <Dialog.Header>
            <Dialog.Title>{t("Transfer workspace ownership")}</Dialog.Title>
            <Dialog.Description>
              {t("Enter the user ID of the new owner for")}{" "}
              {transferCandidate?.name ?? "this workspace"}.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Input
              aria-label={t("New owner user ID")}
              autoComplete="off"
              onChange={(event) => setNewOwnerID(event.target.value)}
              placeholder={t("User ID")}
              value={newOwnerID}
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button
              onClick={() => setTransferCandidate(null)}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={!newOwnerID.trim()}
              onClick={() => {
                const workspace = transferCandidate
                const newOwnerId = newOwnerID.trim()
                if (!workspace || !newOwnerId) return
                void api
                  .post(
                    `/api/v1/admin/organizations/${workspace.id}/transfer-ownership`,
                    { newOwnerId }
                  )
                  .then(() => onUpdate(workspace.id, {}))
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error
                        ? caught.message
                        : "Ownership could not be transferred."
                    )
                  )
                  .finally(() => setTransferCandidate(null))
              }}
            >
              {t("Transfer ownership")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => !open && setDeleteCandidate(null)}
      >
        <Dialog.Content className="sm:max-w-md">
          <Dialog.Header>
            <Dialog.Title>{t("Permanently delete workspace")}</Dialog.Title>
            <Dialog.Description>
              {t("Type")} {deleteCandidate?.name ?? "the workspace name"}{" "}
              {t("to permanently delete this workspace and its data.")}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Input
              aria-label={t("Type workspace name to confirm")}
              autoComplete="off"
              onChange={(event) => setDeletePhrase(event.target.value)}
              placeholder={deleteCandidate?.name ?? t("Workspace name")}
              value={deletePhrase}
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button onClick={() => setDeleteCandidate(null)} variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              disabled={deletePhrase !== deleteCandidate?.name}
              onClick={() => {
                const workspace = deleteCandidate
                if (!workspace || deletePhrase !== workspace.name) return
                void api
                  .delete(`/api/v1/admin/organizations/${workspace.id}`, {
                    confirmName: deletePhrase,
                  })
                  .then(onReload)
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error
                        ? caught.message
                        : "Workspace could not be deleted."
                    )
                  )
                  .finally(() => setDeleteCandidate(null))
              }}
              variant="destructive"
            >
              {t("Delete workspace")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
      <ConfirmActionDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? "Confirm workspace action"}
        description={confirmAction?.description ?? ""}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        pending={confirmPending}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        onConfirm={confirmWorkspaceAction}
      />
    </>
  )
}

function ResourceCount({ label, value }: { label: string; value: unknown }) {
  return (
    <Frame variant="band">
      <Frame.Header>
        <Frame.Title>{label}</Frame.Title>
      </Frame.Header>
      <Frame.Panel className="px-4 py-3">
        <p className="text-xl font-semibold tabular-nums">
          {typeof value === "number" ? value : "—"}
        </p>
      </Frame.Panel>
    </Frame>
  )
}
