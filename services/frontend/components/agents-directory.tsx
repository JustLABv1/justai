"use client"

import { useMemo, useState } from "react"
import {
  Bot,
  CircleAlert,
  KeyRound,
  MoreHorizontal,
  Link2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Alert } from "@/components/panelui/alert"
import { Avatar } from "@/components/panelui/avatar"
import { Badge, type BadgeProps } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Card } from "@/components/panelui/card"
import { Frame } from "@/components/panelui/frame"
import { Input } from "@/components/panelui/input"
import { Menu } from "@/components/panelui/menu"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import type { Agent, AgentConnection } from "@/lib/types"

function statusBadge(status: string): BadgeProps["variant"] {
  if (
    [
      "failed",
      "cancelled",
      "disabled",
      "degraded",
      "expired",
      "rejected",
    ].includes(status)
  )
    return "destructive"
  if (["completed", "approved", "ready", "active", "enabled"].includes(status))
    return "success"
  if (["running", "waiting_approval", "pending", "queued"].includes(status))
    return "info"
  return "secondary"
}

function statusText(status: string) {
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

const SEARCH_FROM = 5

/** The agents of a workspace as cards, and the encrypted connections the remote ones use. */
export function AgentsPanel({
  agents,
  connections,
  onEdit,
  onDelete,
  onTest,
  onToggleConnection,
  onDeleteConnection,
  onCreateNative,
  onConnectRemote,
  testingConnectionId,
  updatingConnectionId,
  disabled = false,
}: {
  agents: Agent[]
  connections: AgentConnection[]
  onEdit: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  onTest: (connection: AgentConnection) => void
  onToggleConnection: (connection: AgentConnection, enabled: boolean) => void
  onDeleteConnection: (connection: AgentConnection) => void
  onCreateNative: () => void
  onConnectRemote: () => void
  testingConnectionId: string
  updatingConnectionId: string
  disabled?: boolean
}) {
  const { t } = useTranslations()
  const [query, setQuery] = useState("")

  const visibleAgents = useMemo(
    () =>
      agents.filter((agent) =>
        `${agent.name} ${agent.description} ${agent.kind}`
          .toLowerCase()
          .includes(query.toLowerCase())
      ),
    [agents, query]
  )

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        {/* A few cards need no search; it appears once the list grows. */}
        {agents.length > SEARCH_FROM && (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Input.Group className="w-full sm:w-72">
              <Input.Addon>
                <Search aria-hidden="true" />
              </Input.Addon>
              <Input
                aria-label={t("Search agents")}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search agents…")}
                value={query}
              />
            </Input.Group>
          </div>
        )}

        {agents.length === 0 ? (
          <Card className="border-dashed">
            <Card.Content className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
              <Avatar
                fallback={<Bot aria-hidden="true" />}
                name={t("Agents")}
                shape="square"
                size="lg"
              />
              <div className="grid max-w-md gap-1.5">
                <h2 className="text-base font-semibold">
                  {t("No agents yet")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Create a native specialist or connect an A2A agent. Both can be selected in chat and placed in workflows."
                  )}
                </p>
              </div>
              {!disabled && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={onCreateNative}>
                    <Plus />
                    {t("New native agent")}
                  </Button>
                  <Button onClick={onConnectRemote} variant="outline">
                    <Link2 />
                    {t("Connect remote")}
                  </Button>
                </div>
              )}
            </Card.Content>
          </Card>
        ) : visibleAgents.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("No agents match your search.")}
          </p>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {visibleAgents.map((agent) => {
              const connection = connections.find(
                (item) => item.id === agent.connectionId
              )
              const remote = agent.kind === "remote"
              return (
                <Card as="article" className="h-full" key={agent.id}>
                  <Card.Header>
                    <div className="flex items-start gap-3">
                      <Avatar
                        fallback={<Bot aria-hidden="true" />}
                        name={agent.name}
                        shape="square"
                      />
                      <div className="min-w-0 flex-1">
                        <Card.Title className="truncate">
                          {agent.name}
                        </Card.Title>
                        <Card.Description className="mt-0.5 line-clamp-2">
                          {agent.description ||
                            (remote
                              ? t("Connected A2A agent")
                              : t("Native JustAI agent"))}
                        </Card.Description>
                      </div>
                      <Menu>
                        <Menu.Trigger
                          render={
                            <Button
                              aria-label={t("More actions for {value0}", {
                                value0: agent.name,
                              })}
                              className="-me-1 -mt-1 shrink-0"
                              disabled={disabled}
                              size="icon-sm"
                              variant="ghost"
                            />
                          }
                        >
                          <MoreHorizontal />
                        </Menu.Trigger>
                        <Menu.Content align="end">
                          <Menu.Item onClick={() => onEdit(agent)}>
                            {t("Configure")}
                          </Menu.Item>
                          <Menu.Separator />
                          <Menu.Item
                            onClick={() => onDelete(agent)}
                            variant="destructive"
                          >
                            <Trash2 />
                            {t("Delete")}
                          </Menu.Item>
                        </Menu.Content>
                      </Menu>
                    </div>
                  </Card.Header>
                  <Card.Content className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={statusBadge(agent.status)} dot>
                        {statusText(agent.status)}
                      </Badge>
                      <Badge variant="outline">
                        {remote ? "A2A" : t("Native")}
                      </Badge>
                      {remote ? (
                        agent.credentialConfigured ? (
                          <Badge variant="outline">
                            <KeyRound />
                            {t("Credential saved")}
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            {t("Credential missing")}
                          </Badge>
                        )
                      ) : (
                        <>
                          <Badge variant="outline">
                            <ShieldCheck />
                            {t("JustAI runtime")}
                          </Badge>
                          {agent.useMemory && (
                            <Badge variant="outline">{t("Memory")}</Badge>
                          )}
                          {agent.deepContext && (
                            <Badge variant="outline">{t("Deep context")}</Badge>
                          )}
                        </>
                      )}
                    </div>
                    {remote && connection?.lastError && (
                      <Alert tone="destructive">
                        <Alert.Icon>
                          <CircleAlert />
                        </Alert.Icon>
                        <Alert.Description>
                          {connection.lastError}
                        </Alert.Description>
                      </Alert>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {agent.delegationAgentIds?.length
                        ? `${t("Can delegate to")} ${agent.delegationAgentIds.length} ${t(
                            "allowlisted agent"
                          )}${agent.delegationAgentIds.length === 1 ? "" : "s"}.`
                        : t("No delegation targets configured.")}
                    </p>
                  </Card.Content>
                  <Card.Footer className="justify-end" variant="panel">
                    <Button
                      disabled={disabled}
                      onClick={() => onEdit(agent)}
                      size="sm"
                      variant="outline"
                    >
                      {t("Configure")}
                    </Button>
                  </Card.Footer>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Connections")}</Frame.Title>
          <Frame.Description>
            {t(
              "Encrypted remote access shared by the workspace or kept personal."
            )}
          </Frame.Description>
          <Frame.Action>
            {connections.length} {t("configured")}
          </Frame.Action>
        </Frame.Header>
        <Frame.Panel>
          {connections.length === 0 ? (
            <Frame.Row>
              <Frame.Content>
                <Frame.Description className="text-center">
                  {t("No remote connections configured.")}
                </Frame.Description>
              </Frame.Content>
            </Frame.Row>
          ) : (
            connections.map((connection) => (
              <Frame.Row key={connection.id}>
                <Frame.Media>
                  <Link2 aria-hidden="true" />
                </Frame.Media>
                <Frame.Content>
                  <Frame.Title as="p">{connection.name}</Frame.Title>
                  <Frame.Description>
                    {connection.endpointUrl}
                  </Frame.Description>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge
                      dot
                      size="sm"
                      variant={connection.enabled ? "success" : "secondary"}
                    >
                      {connection.enabled ? t("Enabled") : t("Disabled")}
                    </Badge>
                    <Badge
                      size="sm"
                      variant={
                        connection.lastError
                          ? "destructive"
                          : connection.lastTestedAt
                            ? "info"
                            : "outline"
                      }
                    >
                      {connection.lastError
                        ? t("Needs attention")
                        : connection.lastTestedAt
                          ? t("Tested")
                          : t("Not tested")}
                    </Badge>
                    {connection.trustedReadOnly && (
                      <Badge size="sm" variant="outline">
                        {t("Trusted read-only")}
                      </Badge>
                    )}
                  </div>
                </Frame.Content>
                <Frame.Actions>
                  <Switch
                    checked={connection.enabled}
                    disabled={disabled || Boolean(updatingConnectionId)}
                    label={t("Enable {value0}", { value0: connection.name })}
                    onCheckedChange={(checked) =>
                      onToggleConnection(connection, checked)
                    }
                    pending={updatingConnectionId === connection.id}
                  />
                  <Button
                    aria-label={t("Test {value0}", { value0: connection.name })}
                    disabled={disabled || Boolean(testingConnectionId)}
                    onClick={() => onTest(connection)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    {testingConnectionId === connection.id ? (
                      <Spinner />
                    ) : (
                      <RefreshCw />
                    )}
                  </Button>
                  <Button
                    aria-label={t("Delete {value0}", {
                      value0: connection.name,
                    })}
                    disabled={disabled}
                    onClick={() => onDeleteConnection(connection)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </Frame.Actions>
              </Frame.Row>
            ))
          )}
        </Frame.Panel>
      </Frame>
    </div>
  )
}
