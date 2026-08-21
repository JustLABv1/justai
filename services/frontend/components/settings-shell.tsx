"use client"

import { useRef, useState } from "react"
import {
  BookOpen,
  Cpu,
  Link2,
  Plug,
  Plus,
  ShieldCheck,
  Settings2,
  UploadCloud,
  UserPlus,
  Users,
} from "lucide-react"

import { AdminView } from "@/components/admin-view"
import { EndpointsView } from "@/components/endpoints-view"
import {
  KnowledgeView,
  type KnowledgeViewHandle,
} from "@/components/knowledge-view"
import { MCPView } from "@/components/mcp-view"
import { PrivacyView } from "@/components/privacy-view"
import { SettingsView } from "@/components/settings-view"
import { Button } from "@/components/ui/button"
import type {
  Endpoint,
  KnowledgeSource,
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
  knowledgeSources: KnowledgeSource[]
  mcpServers: MCPServer[]
  onTabChange: (tab: SettingsTab) => void
  onOrganizationSelect: (organizationId: string) => void
  onOrganizationCreated: (organization: Organization) => void
  onOrganizationUpdated: (organization: Organization) => void
  onEndpointsChange: (endpoints: Endpoint[]) => void
  onKnowledgeChange: (sources: KnowledgeSource[]) => void
  onMCPChange: (servers: MCPServer[]) => void
}

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings2 }> =
  [
    { id: "workspace", label: "Workspace", icon: Settings2 },
    { id: "endpoints", label: "Endpoints", icon: Cpu },
    { id: "knowledge", label: "Knowledge", icon: BookOpen },
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
  knowledgeSources,
  mcpServers,
  onTabChange,
  onOrganizationSelect,
  onOrganizationCreated,
  onOrganizationUpdated,
  onEndpointsChange,
  onKnowledgeChange,
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
  const knowledgeViewRef = useRef<KnowledgeViewHandle>(null)

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
    ) : activeTab === "knowledge" ? (
      <div className="flex shrink-0 gap-2">
        <Button
          variant="outline"
          onClick={() => knowledgeViewRef.current?.openAddUrl()}
        >
          <Link2 data-icon="inline-start" aria-hidden="true" />
          Add URL
        </Button>
        <Button onClick={() => knowledgeViewRef.current?.openFilePicker()}>
          <UploadCloud data-icon="inline-start" aria-hidden="true" />
          Upload file
        </Button>
      </div>
    ) : null

  return (
    <div className="min-h-full w-full bg-muted/10 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              {currentPage.eyebrow}
            </p>
            <h1 className="font-heading mt-2 text-3xl font-semibold tracking-tight">
              {currentPage.title}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {currentPage.description}
            </p>
          </div>
          {pageAction}
        </div>

        <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border bg-background p-1">
          {visibleTabs.map(({ id, label, icon: Icon }) => (
            <Button
              aria-current={activeTab === id ? "page" : undefined}
              className="gap-2"
              key={id}
              onClick={() => onTabChange(id)}
              variant={activeTab === id ? "secondary" : "ghost"}
            >
              <Icon className="size-4" />
              {label}
            </Button>
          ))}
        </div>

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
        {activeTab === "knowledge" ? (
          <KnowledgeView
            ref={knowledgeViewRef}
            sources={knowledgeSources}
            onChange={onKnowledgeChange}
            organizationRole={activeOrganization?.role}
            platformAdmin={user.platformAdmin}
            userId={user.id}
          />
        ) : null}
        {activeTab === "mcp" ? (
          <MCPView
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
      </div>
    </div>
  )
}
