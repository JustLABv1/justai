"use client"
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from "react"
import { Activity, AlertTriangle, CheckCircle2 } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Frame } from "@/components/panelui/frame"
import { Spinner } from "@/components/panelui/spinner"
type HealthState = "healthy" | "warning" | "down" | "unknown"

function healthState(value: any): HealthState {
  if (typeof value === "boolean") return value ? "healthy" : "down"
  if (!value || typeof value !== "object") return "unknown"

  const failures = Number(value.recentFailures ?? value.failures ?? 0)
  if (value.ok === false) return "down"
  if (failures > 0) return "warning"
  if (value.ok === true) return "healthy"

  const signals = Object.values(value).filter(
    (item): item is boolean => typeof item === "boolean"
  )
  if (signals.length > 0) return signals.every(Boolean) ? "healthy" : "down"
  return "unknown"
}

function HealthStatusBadge({ state }: { state: HealthState }) {
  const { t } = useTranslations()

  const Icon =
    state === "healthy"
      ? CheckCircle2
      : state === "unknown"
        ? Activity
        : AlertTriangle
  const label =
    state === "healthy"
      ? t("Operational")
      : state === "warning"
        ? t("Degraded")
        : state === "down"
          ? t("Unavailable")
          : t("Unknown")
  const variant =
    state === "healthy"
      ? "success"
      : state === "down"
        ? "destructive"
        : state === "warning"
          ? "warning"
          : "secondary"
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" />
      {label}
    </Badge>
  )
}

function HealthMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  const { t } = useTranslations()
  return (
    <div className="min-w-0 py-1">
      <p className="text-xs text-muted-foreground">{t(label)}</p>
      <p className="mt-1 text-base font-semibold tracking-tight">{t(value)}</p>
      {detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{t(detail)}</p>
      )}
    </div>
  )
}

function HealthPanel({
  title,
  description,
  state,
  children,
}: {
  title: string
  description: string
  state: HealthState
  children: ReactNode
}) {
  return (
    <Frame variant="band">
      <Frame.Header>
        <Frame.Title>{title}</Frame.Title>
        <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
          {description}
        </Frame.Description>
        <Frame.Action>
          <HealthStatusBadge state={state} />
        </Frame.Action>
      </Frame.Header>
      <Frame.Panel className="p-4">{children}</Frame.Panel>
    </Frame>
  )
}

export function PlatformHealthView({
  health,
}: {
  health: Record<string, any> | null
}) {
  const { t, locale } = useTranslations()

  if (!health) {
    return (
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Service health")}</Frame.Title>
          <Frame.Description>
            {t(
              "Runtime checks for the platform services and background workers."
            )}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel
          className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner className="size-4" />
          {t("Loading health checks…")}
        </Frame.Panel>
      </Frame>
    )
  }

  const database = health?.database ?? {}
  const providers = health?.providers ?? {}
  const mcp = health?.mcp ?? {}
  const agents = health?.agents ?? {}
  const workers = health?.workers ?? {}
  const providerFailures = Number(providers.recentFailures ?? 0)
  const mcpFailures = Number(mcp.failures ?? 0)
  const states = [
    healthState(database),
    healthState(providers),
    healthState(mcp),
    healthState(agents),
    healthState(workers),
  ]
  const overallState = states.includes("down")
    ? "down"
    : states.includes("warning")
      ? "warning"
      : states.includes("unknown")
        ? "unknown"
        : "healthy"
  const checkedAt =
    typeof health?.checkedAt === "string" ? new Date(health.checkedAt) : null
  const checkedLabel =
    checkedAt && !Number.isNaN(checkedAt.getTime())
      ? checkedAt.toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null
  const enabledProviders = Number(providers.enabled ?? 0)
  const totalProviders = Number(providers.total ?? 0)
  const enabledMcp = Number(mcp.enabled ?? 0)
  const totalMcp = Number(mcp.total ?? 0)
  const workerDetails = Array.isArray(workers.details) ? workers.details : []
  const workerEntries = [
    ["RAG worker", workers.rag],
    ["Transcription worker", workers.transcription],
    ["Agent worker", workers.agents],
  ] as const

  return (
    <div className="flex flex-col gap-4">
      <Frame>
        <Frame.Header>
          <div>
            <Frame.Title>{t("Service health")}</Frame.Title>
            <Frame.Description>
              {t(
                "Runtime checks for the platform services and background workers."
              )}
            </Frame.Description>
          </div>
          <Frame.Action className="flex flex-col items-end gap-1.5">
            <HealthStatusBadge state={overallState} />
            {checkedLabel && (
              <span className="text-xs text-muted-foreground">
                {t("Checked at")} {checkedLabel}
              </span>
            )}
          </Frame.Action>
        </Frame.Header>
      </Frame>

      <div className="grid gap-4 sm:grid-cols-2">
        <HealthPanel
          description={t("PostgreSQL connectivity and readiness.")}
          state={healthState(database)}
          title={t("Database")}
        >
          <HealthMetric
            detail="Primary application store"
            label={t("Connection")}
            value={
              typeof database.ok === "boolean"
                ? database.ok
                  ? "Connected"
                  : "Unavailable"
                : "Unknown"
            }
          />
        </HealthPanel>
        <HealthPanel
          description={t(
            "Configured model endpoints and recent request failures."
          )}
          state={healthState(providers)}
          title={t("Providers")}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthMetric
              detail={t("{count} configured", { count: totalProviders })}
              label={t("Enabled")}
              value={`${enabledProviders} / ${totalProviders}`}
            />
            <HealthMetric
              detail="Last hour"
              label={t("Recent failures")}
              value={String(providerFailures)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description={t("Connected tool servers and MCP execution.")}
          state={healthState(mcp)}
          title="MCP"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthMetric
              detail={t("{count} configured", { count: totalMcp })}
              label={t("Enabled")}
              value={`${enabledMcp} / ${totalMcp}`}
            />
            <HealthMetric
              detail="Across configured servers"
              label={t("Failures")}
              value={String(mcpFailures)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description={t(
            "Agent execution, durable runs, and approval backlog."
          )}
          state={healthState(agents)}
          title={t("Agents")}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <HealthMetric
              detail="Native and remote"
              label={t("Configured")}
              value={String(agents.total ?? 0)}
            />
            <HealthMetric
              detail="Currently active"
              label={t("Runs")}
              value={String(agents.activeRuns ?? 0)}
            />
            <HealthMetric
              detail="Awaiting a decision"
              label={t("Approvals")}
              value={String(agents.pendingApprovals ?? 0)}
            />
          </div>
        </HealthPanel>
        <HealthPanel
          description={t(
            "Background jobs that keep retrieval and transcription moving."
          )}
          state={healthState(workers)}
          title={t("Workers")}
        >
          <Frame variant="plain">
            <Frame.Panel>
              {workerEntries.map(([label, value]) => (
                <Frame.Row key={label}>
                  <Frame.Content>
                    <Frame.Title as="p">{t(label)}</Frame.Title>
                  </Frame.Content>
                  <Frame.Actions>
                    <Badge
                      variant={
                        typeof value !== "boolean"
                          ? "secondary"
                          : value
                            ? "success"
                            : "destructive"
                      }
                    >
                      {t(
                        typeof value !== "boolean"
                          ? "Unknown"
                          : value
                            ? "Online"
                            : "Offline"
                      )}
                    </Badge>
                  </Frame.Actions>
                </Frame.Row>
              ))}
            </Frame.Panel>
          </Frame>
          {workerDetails.length > 0 && (
            <details className="mt-3 border-t border-border pt-3">
              <summary className="cursor-pointer rounded-sm text-xs font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
                {t("Heartbeat diagnostics")}
              </summary>
              <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
                {workerDetails.map((worker: any, index: number) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    key={`${worker.name}-${worker.instanceId ?? index}`}
                  >
                    <span className="font-medium">
                      {String(worker.name)
                        .replace(/[-_]/g, " ")
                        .replace(/^./, (value) => value.toUpperCase())}
                      {worker.instanceId
                        ? ` · ${String(worker.instanceId).slice(0, 8)}`
                        : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {worker.heartbeatAgeSeconds >= 0
                        ? t("{value0}s since heartbeat", {
                            value0: worker.heartbeatAgeSeconds,
                          })
                        : worker.started
                          ? t("Awaiting heartbeat")
                          : t("Not started")}
                      {worker.lastError ? ` · ${worker.lastError}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </HealthPanel>
      </div>

      {(providerFailures > 0 || mcpFailures > 0) && (
        <Alert tone="destructive" variant="plain">
          <Alert.Title>{t("Recent service failures")}</Alert.Title>
          <Alert.Description>
            {providerFailures > 0 &&
              t("{value0} provider {value1} recorded in the last hour.", {
                value0: providerFailures,
                value1: t(providerFailures === 1 ? "failure" : "failures"),
              })}
            {providerFailures > 0 && mcpFailures > 0 && " "}
            {mcpFailures > 0 &&
              t("{value0} MCP {value1} reported.", {
                value0: mcpFailures,
                value1: t(mcpFailures === 1 ? "failure" : "failures"),
              })}
          </Alert.Description>
        </Alert>
      )}
    </div>
  )
}
