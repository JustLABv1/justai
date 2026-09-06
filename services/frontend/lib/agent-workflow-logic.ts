import type {
  Agent,
  AgentConnection,
  AgentSchedule,
  AgentWorkflowDefinition,
} from "./types"

/**
 * Keep the client-side workflow checks aligned with the bounded graph language
 * enforced by the agent worker. These checks are intentionally advisory: the
 * API remains the source of truth at save/run time.
 */
export function validateWorkflowDefinition(
  definition: AgentWorkflowDefinition
): string | null {
  if (definition.nodes.length === 0) return "Add at least one agent node."
  if (definition.nodes.length > 16) return "Workflows are limited to 16 nodes."

  const ids = new Set<string>()
  const children = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  const edges = new Set<string>()

  for (const node of definition.nodes) {
    const id = node.id.trim()
    if (!id) return "Every node needs an id."
    if (ids.has(id)) return `Node ${id} is duplicated.`
    ids.add(id)
    indegree.set(id, 0)
    if (!node.instruction.trim()) return `Node ${id} needs an instruction.`

    const bindingNames = new Set<string>()
    for (const binding of node.inputBindings ?? []) {
      const name = binding.name.trim()
      if (!name) return `Node ${id} has an input binding without a name.`
      if (bindingNames.has(name)) {
        return `Node ${id} has duplicate input binding ${name}.`
      }
      bindingNames.add(name)
      const source = binding.source.trim().toLowerCase()
      if (source !== "input" && source !== "node") {
        return `Node ${id} has an invalid input binding source.`
      }
      if (source === "node" && !binding.nodeId?.trim()) {
        return `Node ${id} has a node binding without a source node.`
      }
    }
  }

  for (const edge of definition.edges) {
    const from = edge.from.trim()
    const to = edge.to.trim()
    if (!ids.has(from) || !ids.has(to)) {
      return "Every edge must connect existing nodes."
    }
    if (from === to) return "A node cannot connect to itself."
    const key = `${from}\u0000${to}`
    if (edges.has(key)) return `The edge ${from} → ${to} is duplicated.`
    edges.add(key)
    const next = children.get(from) ?? []
    next.push(to)
    children.set(from, next)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
    if (next.length > 4) return `Node ${from} exceeds the fan-out limit.`
  }

  for (const node of definition.nodes) {
    for (const binding of node.inputBindings ?? []) {
      if (binding.source.trim().toLowerCase() !== "node") continue
      const dependency = binding.nodeId?.trim() ?? ""
      if (!ids.has(dependency)) {
        return `Node ${node.id} binds an unknown node ${dependency}.`
      }
      if (dependency === node.id) {
        return `Node ${node.id} cannot bind its own output.`
      }
      if (!edges.has(`${dependency}\u0000${node.id}`)) {
        return `Node ${node.id} binds ${dependency} without a directed edge.`
      }
    }
  }

  const queue = [...definition.nodes]
    .filter((node) => indegree.get(node.id.trim()) === 0)
    .map((node) => node.id.trim())
  const depth = new Map(queue.map((id) => [id, 1]))
  let processed = 0
  while (queue.length) {
    const id = queue.shift()!
    processed += 1
    if ((depth.get(id) ?? 1) > 8) return "Workflow depth cannot exceed 8 nodes."
    for (const child of children.get(id) ?? []) {
      depth.set(
        child,
        Math.max(depth.get(child) ?? 1, (depth.get(id) ?? 1) + 1)
      )
      indegree.set(child, (indegree.get(child) ?? 1) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }

  return processed === definition.nodes.length
    ? null
    : "Workflow graphs must be acyclic."
}

/**
 * Workspace workflows must be reproducible for every member. Mirror the
 * server's shared-resource guard so an ineligible graph is explained before a
 * network request is made.
 */
export function validateWorkflowResources(
  definition: AgentWorkflowDefinition,
  visibility: string,
  agents: Agent[],
  connections: AgentConnection[]
): string | null {
  if (visibility !== "workspace") return null

  const validateAgent = (agentID: string, location: string) => {
    const agent = agents.find((candidate) => candidate.id === agentID)
    if (!agent) return `${location} uses an agent that is no longer available.`
    if (agent.visibility !== "workspace") {
      return `${location} uses private agent “${agent.name}”, which cannot be shared.`
    }
    if (agent.kind === "remote") {
      const connection = agent.connectionId
        ? connections.find((candidate) => candidate.id === agent.connectionId)
        : undefined
      if (!connection || connection.scopeType !== "organization") {
        return `${location} uses remote agent “${agent.name}” with a private connection. Choose a workspace connection.`
      }
      if (!connection.enabled) {
        return `${location} uses remote agent “${agent.name}”, but its workspace connection is disabled.`
      }
    }
    return null
  }

  for (const node of definition.nodes) {
    if (!node.agentId) {
      return `Node “${node.id}” must select a workspace agent before sharing.`
    }
    const agentError = validateAgent(node.agentId, `Node “${node.id}”`)
    if (agentError) return agentError
    for (const delegatedID of node.delegationAgentIds ?? []) {
      const delegationError = validateAgent(
        delegatedID,
        `Node “${node.id}” delegation`
      )
      if (delegationError) return delegationError
    }
  }
  return null
}

export function workflowInputNames(definition: AgentWorkflowDefinition) {
  const names = new Set<string>()
  for (const node of definition.nodes) {
    for (const binding of node.inputBindings ?? []) {
      if (binding.source.trim().toLowerCase() !== "input") continue
      const name = binding.name.trim()
      if (name) names.add(name)
    }
  }
  return [...names]
}

export function workflowScheduleDescription(schedule: AgentSchedule) {
  const kind = schedule.kind || "manual"
  if (kind === "manual") return "Manual only"
  const interval = schedule.interval || 1
  const time = schedule.time || "09:00"
  const unit = kind === "daily" ? "day" : kind === "weekly" ? "week" : "month"
  const count = interval === 1 ? unit : `${unit}s`
  if (kind === "weekly") {
    return `Every ${interval} ${count} on ${weekdayLabel(schedule.weekday)} at ${time}`
  }
  if (kind === "monthly") {
    return `Every ${interval} ${count} on day ${schedule.weekday || 1} at ${time}`
  }
  return `Every ${interval} ${count} at ${time}`
}

export function formatWorkflowNextRun(
  value: string | null | undefined,
  timezone: string
) {
  if (!value) return "Save this workflow to calculate its next run."
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

function weekdayLabel(weekday: number | undefined) {
  return (
    [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][weekday ?? 1] ?? "Monday"
  )
}
