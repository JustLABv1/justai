"use client"

import { useTranslations } from "@/components/locale-provider"
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
import { Page, PageActions, PageTitle } from "@/components/ui/page"
import {
  Tabs,
  ScrollableTabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
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
    { id: "lifecycle", label: "Management", icon: Settings2 },
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
  const { t } = useTranslations()

  const activeOrganization =
    organizations.find((item) => item.id === activeOrganizationId) ??
    organizations[0]
  const visibleTabs = tabs.map((tab) => ({ ...tab, label: t(tab.label) }))
  const pageMeta = {
    lifecycle: {
      eyebrow: t("Management"),
      title: t("Management"),
      description: t("Archive, leave, or permanently remove this workspace."),
    },
    workspace: {
      eyebrow: t("Workspace summary"),
      title: t("Overview"),
      description: t(
        "Review activity, connected capacity, and workspace health."
      ),
    },
    endpoints: {
      eyebrow: t("AI infrastructure"),
      title: t("AI models"),
      description: t(
        "Configure the model providers and transcription services available here."
      ),
    },
    knowledge: {
      eyebrow: t("Knowledge"),
      title: t("Knowledge"),
      description: t(
        "Index sources that can be attached to conversations and cited in answers."
      ),
    },
    mcp: {
      eyebrow: t("Connected tools"),
      title: t("Tools & MCP"),
      description: t(
        "Manage the remote tools and integrations available to assistants."
      ),
    },
    members: {
      eyebrow: t("Access"),
      title: t("Members"),
      description: t(
        "Invite people and manage access for the active workspace."
      ),
    },
    privacy: {
      eyebrow: t("Data controls"),
      title: t("Data & privacy"),
      description: t(
        "Control retention, cleanup, and exports for your workspace data."
      ),
    },
    admin: {
      eyebrow: t("Operations"),
      title: t("Workspace operations"),
      description: t(
        "Set chat defaults and review usage and reliability metrics."
      ),
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
        <Plus data-icon="inline-start" aria-hidden="true" />{" "}
        {t("New workspace")}
      </Button>
    ) : activeTab === "members" &&
      (user.platformAdmin ||
        activeOrganization?.role === "owner" ||
        activeOrganization?.role === "admin") ? (
      <Button onClick={() => setMemberCreateRequest((value) => value + 1)}>
        <UserPlus data-icon="inline-start" aria-hidden="true" />{" "}
        {t("Add member")}
      </Button>
    ) : activeTab === "endpoints" ? (
      <Button onClick={() => setEndpointCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {t("Add endpoint")}
      </Button>
    ) : activeTab === "mcp" ? (
      <Button onClick={() => setMcpCreateRequest((value) => value + 1)}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {t("Add MCP server")}
      </Button>
    ) : null

  return (
    <Page>
      <PageTitle>{t("Workspace settings")}</PageTitle>
      {pageAction && <PageActions>{pageAction}</PageActions>}

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as SettingsTab)}
        className="gap-6"
      >
        <ScrollableTabsList
          aria-label={t("Workspace settings sections")}
          variant="line"
        >
          {visibleTabs.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id}>
              <Icon aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </ScrollableTabsList>

        <TabsContent key={activeTab} value={activeTab} className="min-w-0">
          {activeTab !== "lifecycle" && (
            <div className="mb-4 px-1">
              <p className="max-w-2xl text-sm text-muted-foreground">
                {currentPage.description}
              </p>
            </div>
          )}
          {activeTab === "workspace" ||
          activeTab === "members" ||
          activeTab === "lifecycle" ? (
            <SettingsView
              key={activeOrganization?.id}
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
              section={activeTab}
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
        </TabsContent>
      </Tabs>
    </Page>
  )
}
