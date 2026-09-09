"use client"

import { MCPView } from "@/components/mcp-view"
import {
  Page,
  PageDescription,
  PageEyebrow,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@/components/ui/page"
import type { MCPServer, Organization, User } from "@/lib/types"

type Props = {
  servers: MCPServer[]
  onChange: (servers: MCPServer[]) => void
  organization?: Organization
  user: User
}

export function IntegrationsView({
  servers,
  onChange,
  organization,
  user,
}: Props) {
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageEyebrow>Connected work</PageEyebrow>
          <PageTitle>Integrations</PageTitle>
          <PageDescription>
            Connect the services JustAI can use in your everyday work. Technical
            MCP servers stay in Settings.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <MCPView
        mode="integrations"
        servers={servers}
        onChange={onChange}
        organizationRole={organization?.role}
        platformAdmin={user.platformAdmin}
        userId={user.id}
      />
    </Page>
  )
}
