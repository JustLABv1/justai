"use client"

import type { ReactNode } from "react"
import { Avatar } from "@/components/panelui/avatar"
import { Frame } from "@/components/panelui/frame"

/** Shared identity and action layout for workspace members and platform users. */
export function MemberDirectoryRow({
  name,
  email,
  avatarUrl,
  detail,
  onOpen,
  actions,
}: {
  name: string
  email: string
  avatarUrl?: string
  detail?: ReactNode
  onOpen?: () => void
  actions: ReactNode
}) {
  return (
    <Frame.Row className="flex-wrap gap-y-3">
      <Frame.Media>
        <Avatar name={name || email} src={avatarUrl} size="sm" />
      </Frame.Media>
      <Frame.Content className="min-w-40">
        <Frame.Title as="p">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="max-w-full truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {name || email}
            </button>
          ) : (
            name || email
          )}
        </Frame.Title>
        <Frame.Description title={email}>{email}</Frame.Description>
        {detail && <Frame.Description>{detail}</Frame.Description>}
      </Frame.Content>
      <Frame.Actions className="ml-auto flex-wrap justify-end gap-3">
        {actions}
      </Frame.Actions>
    </Frame.Row>
  )
}
