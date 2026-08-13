"use client"

import { BarChart3, BookOpen, Cpu, Plug, Settings2, Users } from "lucide-react"

import { AdminView } from "@/components/admin-view"
import { EndpointsView } from "@/components/endpoints-view"
import { KnowledgeView } from "@/components/knowledge-view"
import { MCPView } from "@/components/mcp-view"
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
    { id: "admin", label: "Admin", icon: BarChart3 },
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
  const canManageAdmin =
    user.platformAdmin ||
    activeOrganization?.role === "owner" ||
    activeOrganization?.role === "admin"
  const visibleTabs = tabs.filter((tab) => tab.id !== "admin" || canManageAdmin)

  return (
    <div className="min-h-full w-full bg-muted/10 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <div>
          <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
            JustAI settings
          </p>
          <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight">
            Workspace settings
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Configure models, knowledge, tools, access, and operational controls
            for {activeOrganization?.name ?? "your workspace"}.
          </p>
        </div>

        <div className="flex flex-wrap gap-1 rounded-xl border bg-background p-1">
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
            onOrganizationCreated={onOrganizationCreated}
            onOrganizationSelect={onOrganizationSelect}
            onOrganizationUpdated={onOrganizationUpdated}
            organizations={organizations}
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
          />
        ) : null}
        {activeTab === "knowledge" ? (
          <KnowledgeView
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
          />
        ) : null}
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
