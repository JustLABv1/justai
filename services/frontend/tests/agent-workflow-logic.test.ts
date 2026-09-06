import assert from "node:assert/strict"
import test from "node:test"

import {
  validateWorkflowDefinition,
  validateWorkflowResources,
  workflowInputNames,
  workflowScheduleDescription,
} from "../lib/agent-workflow-logic.ts"
import type {
  Agent,
  AgentConnection,
  AgentWorkflowDefinition,
} from "../lib/types"

const nativeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agent-1",
  kind: "native",
  name: "Researcher",
  description: "",
  icon: "",
  visibility: "workspace",
  useMemory: true,
  deepContext: false,
  delegationAgentIds: [],
  status: "ready",
  credentialConfigured: true,
  createdAt: "",
  updatedAt: "",
  ...overrides,
})

const connection = (
  overrides: Partial<AgentConnection> = {}
): AgentConnection => ({
  id: "connection-1",
  scopeType: "organization",
  scopeId: "workspace-1",
  name: "Research service",
  protocol: "a2a",
  endpointUrl: "https://example.com/agent",
  authType: "none",
  credentialConfigured: true,
  agentCard: {},
  enabled: true,
  trustedReadOnly: true,
  createdAt: "",
  updatedAt: "",
  ...overrides,
})

test("validates node bindings against graph edges", () => {
  const definition: AgentWorkflowDefinition = {
    nodes: [
      {
        id: "source",
        type: "agent",
        instruction: "Source",
        approvalMode: "review",
      },
      {
        id: "sink",
        type: "agent",
        instruction: "Sink",
        approvalMode: "review",
        inputBindings: [{ name: "summary", source: "node", nodeId: "source" }],
      },
    ],
    edges: [{ from: "source", to: "sink" }],
  }

  assert.equal(validateWorkflowDefinition(definition), null)
  assert.match(
    validateWorkflowDefinition({ ...definition, edges: [] }) ?? "",
    /without a directed edge/
  )
})

test("collects unique workflow inputs and describes recurrence", () => {
  const definition: AgentWorkflowDefinition = {
    nodes: [
      {
        id: "source",
        type: "agent",
        instruction: "Source",
        approvalMode: "review",
        inputBindings: [
          { name: "question", source: "input" },
          { name: "question", source: "input" },
        ],
      },
    ],
    edges: [],
  }

  assert.deepEqual(workflowInputNames(definition), ["question"])
  assert.equal(
    workflowScheduleDescription({
      kind: "weekly",
      interval: 2,
      weekday: 1,
      time: "09:30",
    }),
    "Every 2 weeks on Monday at 09:30"
  )
})

test("requires workspace-visible agents and connections for shared workflows", () => {
  const definition: AgentWorkflowDefinition = {
    nodes: [
      {
        id: "remote",
        type: "agent",
        agentId: "agent-remote",
        instruction: "Run remote task",
        approvalMode: "review",
      },
    ],
    edges: [],
  }
  const remote = nativeAgent({
    id: "agent-remote",
    kind: "remote",
    name: "Remote",
    connectionId: "connection-1",
  })

  assert.equal(
    validateWorkflowResources(
      definition,
      "workspace",
      [remote],
      [connection()]
    ),
    null
  )
  assert.match(
    validateWorkflowResources(
      definition,
      "workspace",
      [remote],
      [connection({ scopeType: "user" })]
    ) ?? "",
    /private connection/
  )
  assert.match(
    validateWorkflowResources(
      {
        ...definition,
        nodes: [{ ...definition.nodes[0], agentId: undefined }],
      },
      "workspace",
      [remote],
      [connection()]
    ) ?? "",
    /must select a workspace agent/
  )
})
