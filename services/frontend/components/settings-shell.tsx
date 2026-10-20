"use client"

import { useState } from "react"
import {
  Cpu,
  Plug,
  Plus,
  ShieldCheck,
  Settings2,
  UserPlus,
  Users,
} from "lucide-react"

import { AdminView } from "@/components/admin-view"
import { EndpointsView } from "@/components/endpoints-view"
import { MCPView } from "@/components/mcp-view"
import { PrivacyView } from "@/components/privacy-view"
import { SettingsView } from "@/components/settings-view"
import { Button } from "@/components/ui/button"
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@/components/ui/page"
import { SettingsLayout, SettingsNav } from "@/components/ui/settings"
import type {
  Endpoint,
  MCPServer,
  Organization,
  SettingsTab,
  User,
} from "@/lib/types"

type SettingsShellProps = {
  activeTab: SettingsTab
  activeOrganizationId: string | null
  organizations: Organization[]
  user: User
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  onTabChange: (tab: SettingsTab) => void
  onOrganizationSelect: (organizationId: string) => void
  onOrganizationCreated: (organization: Organization) => void
  onOrganizationUpdated: (organization: Organization) => void
  onOrganizationRemoved?: (organizationId: string) => void
  onEndpointsChange: (endpoints: Endpoint[]) => void
  onMCPChange: (servers: MCPServer[]) => void
  resourceErrors?: Partial<Record<"endpoints" | "mcp", string>>
  onRetryResource?: () => void
}

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings2 }> =
  [
    { id: "workspace", label: "Overview", icon: Settings2 },
    { id: "endpoints", label: "AI models", icon: Cpu },
    { id: "mcp", label: "Tools", icon: Plug },
    { id: "members", label: "Members", icon: Users },
    { id: "privacy", label: "Data & privacy", icon: ShieldCheck },
  ]

export function SettingsShell({
  activeTab,
  activeOrganizationId,
  organizations,
  user,
  endpoints,
  mcpServers,
  onTabChange,
  onOrganizationSelect,
  onOrganizationCreated,
  onOrganizationUpdated,
  onOrganizationRemoved,
  onEndpointsChange,
  onMCPChange,
  resourceErrors = {},
  onRetryResource,
}: SettingsShellProps) {
  const activeOrganization =
    organizations.find((item) => item.id === activeOrganizationId) ??
    organizations[0]
  const visibleTabs = tabs
  const pageMeta = {
    workspace: {
      eyebrow: "Workspace summary",
      title: "Overview",
      description: "Review activity, connected capacity, and workspace health.",
    },
    endpoints: {
      eyebrow: "AI infrastructure",
      title: "AI models",
      description:
        "Configure the model providers and transcription services available here.",
    },
    knowledge: {
      eyebrow: "Knowledge",
      title: "Knowledge",
      description:
        "Index sources that can be attached to conversations and cited in answers.",
    },
    mcp: {
      eyebrow: "Connected tools",
      title: "Tools & MCP",
      description:
        "Manage the remote tools and integrations available to assistants.",
    },
    members: {
      eyebrow: "Access",
      title: "Members",
      description: "Invite people and manage access for the active workspace.",
    },
    privacy: {
      eyebrow: "Data controls",
      title: "Data & privacy",
      description:
        "Control retention, cleanup, and exports for your workspace data.",
    },
    admin: {
      eyebrow: "Operations",
      title: "Workspace operations",
      description:
        "Set chat defaults and review usage and reliability metrics.",
    },
  } satisfies Record<
    SettingsTab,
    { eyebrow: string; title: string; description: string }
  >
  const currentPage = pageMeta[activeTab]
  const [endpointCreateRequest, setEndpointCreateRequest] = useState(0)
  const [mcpCreateRequest, setMcpCreateRequest] = useState(0)
  const [workspaceCreateRequest, setWorkspaceCreateRequest] = useState(0)
  const [memberCreateRequest, setMemberCreateRequest] = useState(0)
  const pageAction =
    activeTab === "workspace" ? (
      <Button onClick={() => setWorkspaceCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" /> New workspace
      </Button>
    ) : activeTab === "members" &&
      (user.platformAdmin ||
        activeOrganization?.role === "owner" ||
        activeOrganization?.role === "admin") ? (
      <Button onClick={() => setMemberCreateRequest((value) => value + 1)}>
        <UserPlus data-icon="inline-start" aria-hidden="true" /> Add member
      </Button>
    ) : activeTab === "endpoints" ? (
      <Button onClick={() => setEndpointCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        Add endpoint
      </Button>
    ) : activeTab === "mcp" ? (
      <Button onClick={() => setMcpCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        Add MCP server
      </Button>
    ) : null

  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Workspace settings</PageTitle>
          <PageDescription>
            Configure {activeOrganization?.name ?? "your active workspace"} and
            everything available to its members.
          </PageDescription>
        </PageHeading>
        {pageAction && <PageActions>{pageAction}</PageActions>}
      </PageHeader>

      <SettingsLayout>
        <SettingsNav
          activeId={activeTab}
          aria-label="Workspace settings sections"
          groups={[{ items: visibleTabs }]}
          onSelect={(id) => onTabChange(id as SettingsTab)}
        />

        <div
          aria-labelledby={`settings-tab-${activeTab}`}
          className="min-w-0"
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          tabIndex={0}
        >
          <div className="mb-4 px-1">
            <h2 className="font-heading text-lg font-semibold tracking-tight">
              {currentPage.title}
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              {currentPage.description}
            </p>
          </div>
          {activeTab === "workspace" || activeTab === "members" ? (
            <SettingsView
              activeOrganizationId={activeOrganizationId}
              endpoints={endpoints}
              mcpServers={mcpServers}
              onOrganizationSelect={onOrganizationSelect}
              onOrganizationCreated={onOrganizationCreated}
              onOrganizationUpdated={onOrganizationUpdated}
              onOrganizationRemoved={onOrganizationRemoved}
              workspaceCreateRequest={workspaceCreateRequest}
              memberCreateRequest={memberCreateRequest}
              organizations={organizations}
              section={activeTab === "members" ? "members" : "workspace"}
              user={user}
            />
          ) : null}
          {activeTab === "endpoints" ? (
            <EndpointsView
              endpoints={endpoints}
              onChange={onEndpointsChange}
              organizationRole={activeOrganization?.role}
              platformAdmin={user.platformAdmin}
              userId={user.id}
              createRequest={endpointCreateRequest}
              resourceError={resourceErrors.endpoints}
              onRetryResource={onRetryResource}
            />
          ) : null}
          {activeTab === "mcp" ? (
            <MCPView
              mode="advanced"
              servers={mcpServers}
              onChange={onMCPChange}
              organizationRole={activeOrganization?.role}
              platformAdmin={user.platformAdmin}
              userId={user.id}
              createRequest={mcpCreateRequest}
              resourceError={resourceErrors.mcp}
              onRetryResource={onRetryResource}
            />
          ) : null}
          {activeTab === "privacy" ? <PrivacyView /> : null}
          {activeTab === "admin" ? (
            <AdminView
              endpoints={endpoints}
              mcpServers={mcpServers}
              organizationId={activeOrganization?.id ?? null}
              organizationRole={activeOrganization?.role}
              platformAdmin={user.platformAdmin}
            />
          ) : null}
        </div>
      </SettingsLayout>
    </Page>
  )
}
