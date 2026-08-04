"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  LibraryBig,
  LogIn,
  MessageSquare,
  Plug,
  Plus,
  Settings2,
  Sparkles,
} from "lucide-react"

import { api } from "@/lib/api"
import type {
  Endpoint,
  KnowledgeSource,
  MCPServer,
  Organization,
  User,
  ViewId,
} from "@/lib/types"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { ChatView } from "@/components/chat-view"
import { EndpointsView } from "@/components/endpoints-view"
import { KnowledgeView } from "@/components/knowledge-view"
import { MCPView } from "@/components/mcp-view"
import { SettingsView } from "@/components/settings-view"
import { ThemeSwitcher } from "@/components/theme-switcher"

const navigation: Array<{
  id: ViewId
  label: string
  icon: typeof MessageSquare
  hint: string
}> = [
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    hint: "Conversations and live context",
  },
  {
    id: "endpoints",
    label: "Endpoints",
    icon: Cpu,
    hint: "Models and providers",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    icon: LibraryBig,
    hint: "Sources and retrieval",
  },
  { id: "mcp", label: "MCP", icon: Plug, hint: "Tools and connections" },
]

const conversations = [
  {
    id: "onboarding",
    title: "Onboarding notes",
    detail: "8 messages",
    time: "2m",
    unread: true,
  },
  {
    id: "provider-routing",
    title: "Provider routing",
    detail: "14 messages",
    time: "1h",
    unread: false,
  },
  {
    id: "product-brief",
    title: "Product brief",
    detail: "6 messages",
    time: "Yesterday",
    unread: false,
  },
  {
    id: "mcp-playground",
    title: "MCP playground",
    detail: "22 messages",
    time: "Mon",
    unread: false,
  },
  {
    id: "rag-evaluation",
    title: "RAG evaluation",
    detail: "11 messages",
    time: "Sun",
    unread: false,
  },
]

const demoUser: User = {
  id: "demo-user",
  email: "you@justlab.local",
  displayName: "JustLAB operator",
  platformAdmin: true,
}

export function Workspace() {
  const searchParams = useSearchParams()
  const requestedView = searchParams.get("view") as ViewId | null
  const activeView: ViewId =
    requestedView &&
    ["chat", "endpoints", "knowledge", "mcp", "settings"].includes(
      requestedView
    )
      ? requestedView
      : "chat"
  const [user, setUser] = useState<User>(demoUser)
  const [organizations, setOrganizations] = useState<Organization[]>([
    { id: "demo-org", name: "JustLAB", slug: "justlab", role: "owner" },
  ])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [servers, setServers] = useState<MCPServer[]>([])
  const [activeConversationId, setActiveConversationId] = useState("onboarding")

  useEffect(() => {
    let cancelled = false
    async function loadWorkspace() {
      try {
        const me = await api.get<{ user: User; organizations: Organization[] }>(
          "/api/v1/auth/me"
        )
        if (cancelled) return
        setUser(me.user)
        setOrganizations(me.organizations)
        const [endpointResult, sourceResult, serverResult] =
          await Promise.allSettled([
            api.get<{ endpoints: Endpoint[] }>("/api/v1/endpoints"),
            api.get<{ sources: KnowledgeSource[] }>(
              "/api/v1/knowledge/sources"
            ),
            api.get<{ servers: MCPServer[] }>("/api/v1/mcp/servers"),
          ])
        if (cancelled) return
        if (endpointResult.status === "fulfilled")
          setEndpoints(endpointResult.value.endpoints)
        if (sourceResult.status === "fulfilled")
          setSources(sourceResult.value.sources)
        if (serverResult.status === "fulfilled")
          setServers(serverResult.value.servers)
      } catch {
        // Keep the demo workspace data when the backend is unavailable.
      }
    }
    void loadWorkspace()
    return () => {
      cancelled = true
    }
  }, [])

  const activeOrganization = organizations[0]
  const initials = useMemo(() => {
    return user.displayName
      .split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  }, [user.displayName])

  function navigate(view: ViewId) {
    window.history.pushState({}, "", view === "chat" ? "/" : `/?view=${view}`)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }

  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className="gap-3">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles aria-hidden="true" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate font-heading text-sm font-semibold tracking-tight">
                JustAI
              </p>
              <p className="truncate text-xs text-muted-foreground">
                JustLAB workspace
              </p>
            </div>
          </div>

          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip={`${activeOrganization?.name ?? "JustLAB"} organization`}
                variant="outline"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <Bot aria-hidden="true" />
                </div>
                <span className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
                  <span className="block truncate text-xs font-medium">
                    {activeOrganization?.name ?? "JustLAB"}
                  </span>
                  <span className="block truncate text-[11px] font-normal text-muted-foreground">
                    {activeOrganization?.role ?? "owner"} access
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="text-muted-foreground group-data-[collapsible=icon]:hidden"
                />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => {
                  const ItemIcon = item.icon
                  const active = item.id === activeView

                  if (item.id === "chat") {
                    return (
                      <Collapsible
                        className="group/collapsible"
                        defaultOpen
                        key={item.id}
                      >
                        <SidebarMenuItem>
                          <CollapsibleTrigger
                            render={
                              <SidebarMenuButton
                                isActive={active}
                                onClick={() => navigate("chat")}
                                tooltip={item.hint}
                              >
                                <ItemIcon data-icon="inline-start" />
                                <span>{item.label}</span>
                                <ChevronRight className="ml-auto transition-transform group-data-[open]/collapsible:rotate-90" />
                              </SidebarMenuButton>
                            }
                          />
                          <CollapsibleContent>
                            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
                              Conversations
                            </div>
                            <SidebarMenuSub className="mt-0">
                              {conversations.map((conversation) => (
                                <SidebarMenuSubItem key={conversation.id}>
                                  <SidebarMenuSubButton
                                    href="/"
                                    isActive={
                                      activeConversationId === conversation.id
                                    }
                                    onClick={(event) => {
                                      event.preventDefault()
                                      setActiveConversationId(conversation.id)
                                      navigate("chat")
                                    }}
                                    title={`${conversation.title} · ${conversation.detail}`}
                                  >
                                    <span
                                      className={
                                        conversation.unread
                                          ? "size-1.5 shrink-0 rounded-full bg-primary"
                                          : "size-1.5 shrink-0 rounded-full bg-border"
                                      }
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {conversation.title}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                      {conversation.time}
                                    </span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ))}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                          <SidebarMenuAction
                            aria-label="New chat"
                            onClick={(event) => {
                              event.stopPropagation()
                              setActiveConversationId(`new-${Date.now()}`)
                              navigate("chat")
                            }}
                            showOnHover
                            title="New chat"
                          >
                            <Plus aria-hidden="true" />
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      </Collapsible>
                    )
                  }

                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active}
                        onClick={(event) => {
                          event.preventDefault()
                          navigate(item.id)
                        }}
                        tooltip={item.hint}
                      >
                        <ItemIcon data-icon="inline-start" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={activeView === "settings"}
                    onClick={(event) => {
                      event.preventDefault()
                      navigate("settings")
                    }}
                    tooltip="Workspace preferences"
                  >
                    <Settings2 data-icon="inline-start" />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <a
                        href="https://modelcontextprotocol.io"
                        rel="noreferrer"
                        target="_blank"
                      />
                    }
                    tooltip="MCP and integration docs"
                  >
                    <CircleHelp data-icon="inline-start" />
                    <span>Docs &amp; guides</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="flex items-center justify-between gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center">
                <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  Appearance
                </span>
                <ThemeSwitcher />
              </div>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip={`${user.displayName} · ${user.email}`}
              >
                <Avatar size="sm">
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium">
                    {user.displayName}
                  </span>
                  <span className="block truncate text-[11px] font-normal text-muted-foreground">
                    {user.email}
                  </span>
                </span>
              </SidebarMenuButton>
              <SidebarMenuAction
                aria-label="Open login"
                render={<a href="/login" />}
                showOnHover
                title="Open login"
              >
                <LogIn aria-hidden="true" />
              </SidebarMenuAction>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <div className="mx-auto min-h-svh max-w-[1440px] p-4 sm:p-6 lg:p-8">
          {activeView === "chat" && (
            <ChatView
              endpoints={endpoints}
              key={activeConversationId}
              onNavigate={navigate}
            />
          )}
          {activeView === "endpoints" && (
            <EndpointsView endpoints={endpoints} onChange={setEndpoints} />
          )}
          {activeView === "knowledge" && (
            <KnowledgeView sources={sources} onChange={setSources} />
          )}
          {activeView === "mcp" && (
            <MCPView servers={servers} onChange={setServers} />
          )}
          {activeView === "settings" && (
            <SettingsView user={user} organizations={organizations} />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
