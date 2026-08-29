"use client"

import { MCPView } from "@/components/mcp-view"
import type { MCPServer, Organization, User } from "@/lib/types"

type Props = {
  servers: MCPServer[]
  onChange: (servers: MCPServer[]) => void
  organization?: Organization
  user: User
}

export function IntegrationsView({ servers, onChange, organization, user }: Props) {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <header>
        <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
          Connected work
        </p>
        <h1 className="font-heading mt-2 text-3xl font-semibold tracking-tight">
          Integrations
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Connect the services JustAI can use in your everyday work. Technical MCP servers stay in Settings.
        </p>
      </header>
      <MCPView
        mode="integrations"
        servers={servers}
        onChange={onChange}
        organizationRole={organization?.role}
        platformAdmin={user.platformAdmin}
        userId={user.id}
      />
    </div>
  )
}
