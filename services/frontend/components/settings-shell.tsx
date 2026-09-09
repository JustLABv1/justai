"use client"

import { useEffect, useRef, useState } from "react"
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
  PageEyebrow,
  PageHeader,
  PageHeading,
  PageTitle,
  PageToolbar,
} from "@/components/ui/page"
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
  onEndpointsChange: (endpoints: Endpoint[]) => void
  onMCPChange: (servers: MCPServer[]) => void
}

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings2 }> =
  [
    { id: "workspace", label: "Workspace", icon: Settings2 },
    { id: "endpoints", label: "Endpoints", icon: Cpu },
    { id: "mcp", label: "MCP", icon: Plug },
    { id: "members", label: "Members", icon: Users },
    { id: "privacy", label: "Privacy", icon: ShieldCheck },
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
  onEndpointsChange,
  onMCPChange,
}: SettingsShellProps) {
  const activeOrganization =
    organizations.find((item) => item.id === activeOrganizationId) ??
    organizations[0]
  const visibleTabs = tabs
  const pageMeta = {
    workspace: {
      eyebrow: "Workspace",
      title: "Workspace",
      description:
        "Create and rename workspaces, then manage workspace access.",
    },
    endpoints: {
      eyebrow: "Models",
      title: "Endpoints",
      description:
        "Connect providers and configure the models available to your workspace.",
    },
    knowledge: {
      eyebrow: "Knowledge",
      title: "Knowledge",
      description:
        "Index sources that can be attached to conversations and cited in answers.",
    },
    mcp: {
      eyebrow: "Tools",
      title: "MCP servers",
      description:
        "Connect and manage the remote tools available to your workspace.",
    },
    members: {
      eyebrow: "Access",
      title: "Members",
      description: "Invite people and manage access for the active workspace.",
    },
    privacy: {
      eyebrow: "Privacy",
      title: "Privacy & lifecycle",
      description:
        "Control retention, export your data, and decide when completed workspace data is removed.",
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
  const activeTabRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  }, [activeTab])

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
          <PageEyebrow>{currentPage.eyebrow}</PageEyebrow>
          <PageTitle>{currentPage.title}</PageTitle>
          <PageDescription>{currentPage.description}</PageDescription>
        </PageHeading>
        {pageAction && <PageActions>{pageAction}</PageActions>}
      </PageHeader>

      <PageToolbar
        aria-label="Workspace settings sections"
        className="w-full max-w-full flex-nowrap overflow-x-auto"
        role="tablist"
      >
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <Button
            aria-current={activeTab === id ? "page" : undefined}
            aria-selected={activeTab === id}
            className="shrink-0 gap-2"
            key={id}
            onClick={() => onTabChange(id)}
            ref={activeTab === id ? activeTabRef : undefined}
            role="tab"
            variant={activeTab === id ? "secondary" : "ghost"}
          >
            <Icon className="size-4" />
            {label}
          </Button>
        ))}
      </PageToolbar>

      {activeTab === "workspace" || activeTab === "members" ? (
        <SettingsView
          activeOrganizationId={activeOrganizationId}
          onOrganizationSelect={onOrganizationSelect}
          onOrganizationCreated={onOrganizationCreated}
          onOrganizationUpdated={onOrganizationUpdated}
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
    </Page>
  )
}
