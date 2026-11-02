export type ActivityCategory =
  "chat" | "mcp" | "agents" | "transcription" | "audit"
export type ActivityOutcome = "success" | "failed" | "cancelled" | "pending"
export type InsightsDay = {
  date: string
  chatRuns: number
  mcpCalls: number
  agentRuns: number
  transcriptions: number
  activeUsers: number
}
export type ActivityEntry = {
  id: string
  userId: string | null
  userName: string
  userEmail: string
  organizationId: string | null
  workspaceName: string
  category: ActivityCategory
  action: string
  outcome: ActivityOutcome
  occurredAt: string
  serverId: string | null
  serverName: string | null
  tool: string | null
  metadata: Record<string, string | number | boolean | null>
}
export type AnalyticsInsights = {
  period: { from: string; to: string }
  bucket?: "minute" | "hour" | "day"
  page: number
  pageSize: number
  summary: {
    activeUsers: number
    activeWorkspaces: number
    chatRuns: number
    mcpCalls: number
    mcpFailures: number
    agentRuns: number
    transcriptions: number
    events: number
  }
  daily: InsightsDay[]
  users: Array<{
    id: string
    name: string
    email: string
    events: number
    chatRuns: number
    mcpCalls: number
    agentRuns: number
    transcriptions: number
    tokens: number | null
    lastActive: string
  }>
  workspaces: Array<{
    id: string
    name: string
    activeUsers: number
    chatRuns: number
    mcpCalls: number
    agentRuns: number
    transcriptions: number
    events: number
    lastActive: string
  }>
  tools: Array<{
    serverId: string
    serverName: string
    tool: string
    calls: number
    failed: number
    users: number
    lastUsed: string
  }>
  activity: { items: ActivityEntry[]; total: number }
}

/** Include every UTC bucket (minute, hour or day) intersecting the half-open reporting interval. */
export function insightsDays(
  insights: Pick<AnalyticsInsights, "period" | "daily" | "bucket">
): InsightsDay[] {
  const start = new Date(insights.period.from)
  const end = new Date(new Date(insights.period.to).getTime() - 1)
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start > end
  )
    return []
  const bucket = insights.bucket ?? "day"
  const step = { minute: 60000, hour: 3600000, day: 86400000 }[bucket]
  const key = (time: number) =>
    new Date(time)
      .toISOString()
      .slice(0, { minute: 16, hour: 13, day: 10 }[bucket]) +
    (bucket === "hour" ? ":00" : "")
  const floor = (time: number) => Math.floor(time / step) * step
  const first = floor(start.getTime())
  const last = floor(end.getTime())
  const days = new Map(insights.daily.map((day) => [day.date, day]))
  const result: InsightsDay[] = []
  for (let time = first; time <= last && result.length < 400; time += step) {
    const date = key(time)
    result.push(
      days.get(date) ?? {
        date,
        chatRuns: 0,
        mcpCalls: 0,
        agentRuns: 0,
        transcriptions: 0,
        activeUsers: 0,
      }
    )
  }
  return result
}

export const activityCategoryLabels: Record<ActivityCategory, string> = {
  chat: "Model requests",
  mcp: "MCP tools",
  agents: "Agent runs",
  transcription: "Transcriptions",
  audit: "Administration",
}
export const activityOutcomeLabels: Record<ActivityOutcome, string> = {
  success: "Successful",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "In progress",
}
