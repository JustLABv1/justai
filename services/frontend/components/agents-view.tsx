"use client"

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Cloud,
  GitBranch,
  KeyRound,
  Link2,
  ListChecks,
  Maximize2,
  Minimize2,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react"
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react"

import "@xyflow/react/dist/style.css"

import { api, resolveAPIURL } from "@/lib/api"
import type {
  Agent,
  AgentApproval,
  AgentConnection,
  AgentContextScope,
  AgentRun,
  AgentRunNode,
  AgentSchedule,
  AgentTab,
  AgentWorkflow,
  AgentWorkflowDefinition,
  AgentWorkflowNode,
  Endpoint,
  KnowledgeSource,
  MCPServer,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

type AgentsViewProps = {
  activeTab: AgentTab
  agents: Agent[]
  endpoints: Endpoint[]
  mcpServers: MCPServer[]
  knowledgeSources: KnowledgeSource[]
  disabled?: boolean
  onAgentsChange: (agents: Agent[]) => void
  onTabChange: (tab: AgentTab) => void
}

type NativeAgentForm = {
  name: string
  description: string
  instructions: string
  endpointId: string
  model: string
  visibility: "private" | "workspace"
  useMemory: boolean
  deepContext: boolean
  delegationAgentIds: string[]
}

type RemoteAgentForm = {
  name: string
  description: string
  endpointUrl: string
  authType: AgentConnection["authType"]
  credential: string
  username: string
  password: string
  accessToken: string
  clientSecret: string
  certificate: string
  privateKey: string
  oauthAuthorizationUrl: string
  oauthTokenUrl: string
  oauthClientId: string
  oauthScopes: string
  visibility: "private" | "workspace"
  connectionScope: "user" | "organization"
  trustedReadOnly: boolean
}

type WorkflowDraft = {
  id: string
  name: string
  description: string
  visibility: "private" | "workspace"
  definition: AgentWorkflowDefinition
  schedule: AgentSchedule
  timezone: string
  enabled: boolean
}

type FlowNodeData = {
  label: string
  agentName: string
  instruction: string
  status?: string
  selected?: boolean
}

const emptyNativeForm: NativeAgentForm = {
  name: "",
  description: "",
  instructions: "",
  endpointId: "",
  model: "",
  visibility: "private",
  useMemory: true,
  deepContext: false,
  delegationAgentIds: [],
}

const emptyRemoteForm: RemoteAgentForm = {
  name: "",
  description: "",
  endpointUrl: "",
  authType: "none",
  credential: "",
  username: "",
  password: "",
  accessToken: "",
  clientSecret: "",
  certificate: "",
  privateKey: "",
  oauthAuthorizationUrl: "",
  oauthTokenUrl: "",
  oauthClientId: "",
  oauthScopes: "",
  visibility: "private",
  connectionScope: "user",
  trustedReadOnly: false,
}

function emptyWorkflow(): WorkflowDraft {
  return {
    id: "",
    name: "",
    description: "",
    visibility: "private",
    definition: {
      nodes: [
        {
          id: "agent-1",
          type: "agent",
          instruction:
            "Complete the assigned task and return a concise result.",
          approvalMode: "read_only_auto",
          retry: { maxAttempts: 3 },
          timeoutSeconds: 600,
          context: {},
        },
      ],
      edges: [],
    },
    schedule: { kind: "manual" },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    enabled: true,
  }
}

function cloneWorkflow(workflow: AgentWorkflow): WorkflowDraft {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDraft
}

function badgeVariant(
  status: string
): "default" | "secondary" | "destructive" | "outline" {
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
  if (["completed", "approved", "ready"].includes(status)) return "default"
  if (["running", "waiting_approval", "pending", "queued"].includes(status))
    return "secondary"
  return "outline"
}

function statusLabel(status: string) {
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function approvalModeLabel(mode: string | undefined) {
  return mode === "read_only_auto"
    ? "Automatic for trusted read-only"
    : "Always review"
}

function visibilityLabel(visibility: string | undefined) {
  return visibility === "workspace" ? "Workspace shared" : "Private"
}

function scheduleKindLabel(kind: string | undefined) {
  switch (kind) {
    case "daily":
      return "Daily"
    case "weekly":
      return "Weekly"
    case "monthly":
      return "Monthly"
    default:
      return "Manual only"
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

function connectionScopeLabel(scope: string | undefined) {
  return scope === "organization"
    ? "Workspace connection"
    : "Private connection"
}

function authTypeLabel(authType: string | undefined) {
  switch (authType) {
    case "api_key":
      return "API key"
    case "http":
      return "HTTP Basic / auth header"
    case "oauth2":
      return "OAuth2"
    case "oidc":
      return "OIDC"
    case "mtls":
      return "mTLS certificate"
    default:
      return "No authentication"
  }
}

function updateContext(
  scope: AgentContextScope | undefined,
  patch: Partial<AgentContextScope>
): AgentContextScope {
  return { ...(scope ?? {}), ...patch }
}

function validateWorkflowDefinition(
  definition: AgentWorkflowDefinition
): string | null {
  if (definition.nodes.length === 0) return "Add at least one agent node."
  if (definition.nodes.length > 16) return "Workflows are limited to 16 nodes."
  const ids = new Set<string>()
  const children = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const node of definition.nodes) {
    if (!node.id.trim()) return "Every node needs an id."
    if (ids.has(node.id)) return `Node ${node.id} is duplicated.`
    ids.add(node.id)
    indegree.set(node.id, 0)
    if (!node.instruction.trim()) return `Node ${node.id} needs an instruction.`
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to))
      return "Every edge must connect existing nodes."
    if (edge.from === edge.to) return "A node cannot connect to itself."
    const next = children.get(edge.from) ?? []
    next.push(edge.to)
    children.set(edge.from, next)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    if (next.length > 4) return `Node ${edge.from} exceeds the fan-out limit.`
  }
  const queue = [
    ...definition.nodes
      .filter((node) => indegree.get(node.id) === 0)
      .map((node) => node.id),
  ]
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

const AgentFlowNode = memo(function AgentFlowNode({
  data,
}: NodeProps<Node<FlowNodeData>>) {
  return (
    <div
      className={cn(
        "min-w-48 rounded-xl border bg-card px-3 py-2 shadow-sm",
        data.selected && "border-primary ring-2 ring-primary/20"
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="size-2! bg-primary"
      />
      <div className="flex items-start gap-2">
        <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
          <Bot data-icon="inline-start" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">{data.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {data.agentName || "Default native agent"}
          </p>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] text-muted-foreground">
        {data.instruction}
      </p>
      {data.status && (
        <Badge className="mt-2" variant={badgeVariant(data.status)}>
          {statusLabel(data.status)}
        </Badge>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        className="size-2! bg-primary"
      />
    </div>
  )
})

const flowNodeTypes = { agent: AgentFlowNode }

function WorkflowCanvas({
  nodes,
  edges,
  disabled,
  onConnect,
  onSelectNode,
  onPositionChange,
}: {
  nodes: Node<FlowNodeData>[]
  edges: Edge[]
  disabled: boolean
  onConnect: (connection: Connection) => void
  onSelectNode: (id: string) => void
  onPositionChange: (id: string, position: { x: number; y: number }) => void
}) {
  // Keep pointer-move state inside the canvas. The parent owns the durable
  // position snapshot, but does not re-render the editor on every drag frame.
  const [localNodes, setLocalNodes] = useState(nodes)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLocalNodes((current) => {
        const currentByID = new Map(current.map((node) => [node.id, node]))
        const next = nodes.map((node) => {
          const existing = currentByID.get(node.id)
          return existing ? { ...node, position: existing.position } : node
        })
        const unchanged =
          next.length === current.length &&
          next.every((node, index) => {
            const previous = current[index]
            return (
              previous.id === node.id &&
              previous.position.x === node.position.x &&
              previous.position.y === node.position.y &&
              previous.data === node.data
            )
          })
        return unchanged ? current : next
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [nodes])

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<FlowNodeData>>[]) => {
      setLocalNodes((current) => applyNodeChanges(changes, current))
    },
    []
  )

  return (
    <div className="min-h-0 flex-1">
      <ReactFlow
        nodes={localNodes}
        edges={edges}
        nodeTypes={flowNodeTypes}
        onNodesChange={handleNodesChange}
        onConnect={onConnect}
        nodesDraggable={!disabled}
        nodesConnectable={!disabled}
        onlyRenderVisibleElements
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDragStop={(_, node) =>
          onPositionChange(node.id, node.position)
        }
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  )
}

function agentToSavedLabel(agent: Agent | undefined) {
  return agent?.name ?? "Default native agent"
}

export function AgentsView({
  activeTab,
  agents,
  endpoints,
  mcpServers,
  knowledgeSources,
  disabled = false,
  onAgentsChange,
  onTabChange,
}: AgentsViewProps) {
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [workflows, setWorkflows] = useState<AgentWorkflow[]>([])
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [nativeOpen, setNativeOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [nativeForm, setNativeForm] = useState<NativeAgentForm>(emptyNativeForm)
  const [remoteForm, setRemoteForm] = useState<RemoteAgentForm>(emptyRemoteForm)
  const [saving, setSaving] = useState(false)
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState("agent-1")
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [validating, setValidating] = useState(false)
  const [validationMessage, setValidationMessage] = useState("")
  const [discoveryMessage, setDiscoveryMessage] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [connectionResult, workflowResult, runResult] = await Promise.all([
        api.get<{ connections: AgentConnection[] }>(
          "/api/v1/agent-connections"
        ),
        api.get<{ workflows: AgentWorkflow[] }>("/api/v1/agent-workflows"),
        api.get<{ runs: AgentRun[] }>("/api/v1/agent-runs"),
      ])
      setConnections(connectionResult.connections ?? [])
      setWorkflows(workflowResult.workflows ?? [])
      setRuns(runResult.runs ?? [])
      setError("")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The agent workspace could not be loaded."
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const openNative = useCallback((agent?: Agent) => {
    setEditingAgent(agent ?? null)
    setNativeForm(
      agent
        ? {
            name: agent.name,
            description: agent.description,
            instructions: agent.instructions ?? "",
            endpointId: agent.endpointId ?? "",
            model: agent.model ?? "",
            visibility:
              agent.visibility === "workspace" ? "workspace" : "private",
            useMemory: agent.useMemory,
            deepContext: agent.deepContext,
            delegationAgentIds: agent.delegationAgentIds ?? [],
          }
        : emptyNativeForm
    )
    setError("")
    setNativeOpen(true)
  }, [])

  async function saveNative() {
    setSaving(true)
    setError("")
    try {
      const body = {
        kind: "native",
        ...nativeForm,
        endpointId: nativeForm.endpointId || undefined,
        model: nativeForm.model || undefined,
      }
      const result = editingAgent
        ? await api.patch<{ agent: Agent }>(
            `/api/v1/agents/${editingAgent.id}`,
            body
          )
        : await api.post<{ agent: Agent }>("/api/v1/agents", body)
      onAgentsChange(
        editingAgent
          ? agents.map((item) =>
              item.id === result.agent.id ? result.agent : item
            )
          : [result.agent, ...agents]
      )
      setNativeOpen(false)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The native agent could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }

  async function removeAgent(agent: Agent) {
    if (
      !window.confirm(
        `Delete ${agent.name}? Existing conversations keep their version pin.`
      )
    )
      return
    try {
      await api.delete(`/api/v1/agents/${agent.id}`)
      onAgentsChange(agents.filter((item) => item.id !== agent.id))
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The agent could not be deleted."
      )
    }
  }

  async function discoverRemote() {
    if (!remoteForm.endpointUrl.trim()) return
    setDiscoveryMessage("Discovering Agent Card…")
    try {
      const result = await api.post<{ name?: string; description?: string }>(
        "/api/v1/agent-connections/discover",
        { endpointUrl: remoteForm.endpointUrl }
      )
      setRemoteForm((current) => ({
        ...current,
        name: current.name || result.name || "",
        description: current.description || result.description || "",
      }))
      setDiscoveryMessage(
        "Agent Card found. Review the access policy before saving."
      )
    } catch (caught) {
      setDiscoveryMessage(
        caught instanceof Error
          ? caught.message
          : "Agent Card discovery failed."
      )
    }
  }

  async function saveRemote() {
    setSaving(true)
    setError("")
    try {
      const connectionResult = await api.post<{ connection: AgentConnection }>(
        "/api/v1/agent-connections",
        {
          scopeType: remoteForm.connectionScope,
          name: remoteForm.name,
          endpointUrl: remoteForm.endpointUrl,
          authType: remoteForm.authType,
          credential: remoteForm.credential || undefined,
          username: remoteForm.username || undefined,
          password: remoteForm.password || undefined,
          accessToken: remoteForm.accessToken || undefined,
          clientSecret: remoteForm.clientSecret || undefined,
          certificate: remoteForm.certificate || undefined,
          privateKey: remoteForm.privateKey || undefined,
          oauthAuthorizationUrl: remoteForm.oauthAuthorizationUrl || undefined,
          oauthTokenUrl: remoteForm.oauthTokenUrl || undefined,
          oauthClientId: remoteForm.oauthClientId || undefined,
          oauthScopes: remoteForm.oauthScopes || undefined,
          trustedReadOnly: remoteForm.trustedReadOnly,
        }
      )
      const agentResult = await api.post<{ agent: Agent }>("/api/v1/agents", {
        kind: "remote",
        name: remoteForm.name,
        description: remoteForm.description,
        visibility: remoteForm.visibility,
        connectionId: connectionResult.connection.id,
      })
      onAgentsChange([agentResult.agent, ...agents])
      setConnections((current) => [connectionResult.connection, ...current])
      setRemoteOpen(false)
      setRemoteForm(emptyRemoteForm)
      setDiscoveryMessage("")
      if (remoteForm.authType === "oauth2" || remoteForm.authType === "oidc") {
        const oauth = await api.get<{ authorizationUrl: string }>(
          `/api/v1/agent-connections/${connectionResult.connection.id}/oauth/start`
        )
        window.location.assign(oauth.authorizationUrl)
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The remote agent could not be connected."
      )
    } finally {
      setSaving(false)
    }
  }

  async function testConnection(connection: AgentConnection) {
    try {
      await api.post(`/api/v1/agent-connections/${connection.id}/test`)
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The connection test failed."
      )
      await refresh()
    }
  }

  async function toggleConnection(
    connection: AgentConnection,
    enabled: boolean
  ) {
    try {
      const result = await api.patch<{ connection: AgentConnection }>(
        `/api/v1/agent-connections/${connection.id}`,
        { enabled }
      )
      setConnections((current) =>
        current.map((item) =>
          item.id === connection.id ? result.connection : item
        )
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The connection could not be updated."
      )
    }
  }

  async function deleteConnection(connection: AgentConnection) {
    if (!window.confirm(`Remove the ${connection.name} connection?`)) return
    try {
      await api.delete(`/api/v1/agent-connections/${connection.id}`)
      setConnections((current) =>
        current.filter((item) => item.id !== connection.id)
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The connection could not be removed."
      )
    }
  }

  const openWorkflow = useCallback((workflow?: AgentWorkflow) => {
    const next = workflow ? cloneWorkflow(workflow) : emptyWorkflow()
    setWorkflowDraft(next)
    setSelectedNodeId(next.definition.nodes[0]?.id ?? "")
    setPositions({})
    setValidationMessage("")
  }, [])

  const updateWorkflow = useCallback((patch: Partial<WorkflowDraft>) => {
    setWorkflowDraft((current) =>
      current ? { ...current, ...patch } : current
    )
  }, [])

  const updateWorkflowNode = useCallback(
    (nodeID: string, patch: Partial<AgentWorkflowNode>) => {
      setWorkflowDraft((current) => {
        if (!current) return current
        return {
          ...current,
          definition: {
            ...current.definition,
            nodes: current.definition.nodes.map((node) =>
              node.id === nodeID ? { ...node, ...patch } : node
            ),
          },
        }
      })
    },
    []
  )

  function addWorkflowNode() {
    if (!workflowDraft || workflowDraft.definition.nodes.length >= 16) return
    const id = `agent-${workflowDraft.definition.nodes.length + 1}`
    const node: AgentWorkflowNode = {
      id,
      type: "agent",
      instruction: "Complete the assigned task and return a concise result.",
      approvalMode: "read_only_auto",
      retry: { maxAttempts: 3 },
      timeoutSeconds: 600,
      context: {},
    }
    setWorkflowDraft({
      ...workflowDraft,
      definition: {
        ...workflowDraft.definition,
        nodes: [...workflowDraft.definition.nodes, node],
      },
    })
    setSelectedNodeId(id)
  }

  function removeWorkflowNode() {
    if (!workflowDraft || !selectedNodeId) return
    const nodes = workflowDraft.definition.nodes.filter(
      (node) => node.id !== selectedNodeId
    )
    if (!nodes.length) return
    setWorkflowDraft({
      ...workflowDraft,
      definition: {
        nodes,
        edges: workflowDraft.definition.edges.filter(
          (edge) => edge.from !== selectedNodeId && edge.to !== selectedNodeId
        ),
      },
    })
    setSelectedNodeId(nodes[0]?.id ?? "")
  }

  function handleConnect(connection: Connection) {
    if (!workflowDraft || !connection.source || !connection.target) return
    if (
      workflowDraft.definition.edges.some(
        (edge) =>
          edge.from === connection.source && edge.to === connection.target
      )
    )
      return
    const next = {
      ...workflowDraft.definition,
      edges: [
        ...workflowDraft.definition.edges,
        { from: connection.source, to: connection.target },
      ],
    }
    setWorkflowDraft({ ...workflowDraft, definition: next })
  }

  async function validateWorkflow() {
    if (!workflowDraft) return
    const localError = validateWorkflowDefinition(workflowDraft.definition)
    if (localError) {
      setValidationMessage(localError)
      return
    }
    if (!workflowDraft.id) {
      setValidationMessage("Valid bounded DAG · ready to save")
      return
    }
    setValidating(true)
    try {
      const result = await api.post<{
        valid: boolean
        error?: string
        maxDepth?: number
      }>(`/api/v1/agent-workflows/${workflowDraft.id}/validate`)
      setValidationMessage(
        result.valid
          ? `Valid bounded DAG · depth ${result.maxDepth ?? "within limit"}`
          : result.error || "Workflow is invalid"
      )
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error ? caught.message : "Workflow validation failed."
      )
    } finally {
      setValidating(false)
    }
  }

  async function saveWorkflow() {
    if (!workflowDraft) return
    const localError = validateWorkflowDefinition(workflowDraft.definition)
    if (localError) {
      setValidationMessage(localError)
      return
    }
    if (!workflowDraft.name.trim()) {
      setValidationMessage("Give the workflow a name before saving.")
      return
    }
    setSaving(true)
    try {
      const body = {
        name: workflowDraft.name,
        description: workflowDraft.description,
        visibility: workflowDraft.visibility,
        definition: workflowDraft.definition,
        schedule: workflowDraft.schedule,
        timezone: workflowDraft.timezone,
        enabled: workflowDraft.enabled,
      }
      const result = workflowDraft.id
        ? await api.patch<{ workflow: AgentWorkflow }>(
            `/api/v1/agent-workflows/${workflowDraft.id}`,
            body
          )
        : await api.post<{ workflow: AgentWorkflow }>(
            "/api/v1/agent-workflows",
            body
          )
      setWorkflows((current) =>
        workflowDraft.id
          ? current.map((item) =>
              item.id === result.workflow.id ? result.workflow : item
            )
          : [result.workflow, ...current]
      )
      setWorkflowDraft(cloneWorkflow(result.workflow))
      setValidationMessage(
        "Saved. Runs use an immutable workflow and agent-version snapshot."
      )
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error
          ? caught.message
          : "The workflow could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }

  async function runWorkflow() {
    if (!workflowDraft?.id) {
      setValidationMessage("Save the workflow before running it.")
      return
    }
    try {
      const result = await api.post<{ run: AgentRun }>(
        `/api/v1/agent-workflows/${workflowDraft.id}/runs`,
        { input: {} }
      )
      setRuns((current) => [result.run, ...current])
      onTabChange("runs")
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error
          ? caught.message
          : "The workflow could not be started."
      )
    }
  }

  async function deleteWorkflow(workflow: AgentWorkflow) {
    if (
      !window.confirm(
        `Delete ${workflow.name}? Existing runs stay inspectable.`
      )
    )
      return
    try {
      await api.delete(`/api/v1/agent-workflows/${workflow.id}`)
      setWorkflows((current) =>
        current.filter((item) => item.id !== workflow.id)
      )
      if (workflowDraft?.id === workflow.id) setWorkflowDraft(null)
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error
          ? caught.message
          : "The workflow could not be deleted."
      )
    }
  }

  const selectedNode = workflowDraft?.definition.nodes.find(
    (node) => node.id === selectedNodeId
  )
  const graphNodes = useMemo<Node<FlowNodeData>[]>(() => {
    if (!workflowDraft) return []
    return workflowDraft.definition.nodes.map((node, index) => ({
      id: node.id,
      type: "agent",
      position: positions[node.id] ?? {
        x: (index % 3) * 260 + 30,
        y: Math.floor(index / 3) * 150 + 35,
      },
      data: {
        label: node.id,
        agentName: agentToSavedLabel(
          agents.find((agent) => agent.id === node.agentId)
        ),
        instruction: node.instruction,
        selected: node.id === selectedNodeId,
      },
    }))
  }, [agents, positions, selectedNodeId, workflowDraft])
  const graphEdges = useMemo<Edge[]>(
    () =>
      workflowDraft?.definition.edges.map((edge) => ({
        id: `${edge.from}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        animated: false,
      })) ?? [],
    [workflowDraft]
  )

  return (
    <div className="flex w-full flex-col gap-6">
      {disabled && (
        <Alert role="status">
          <ShieldCheck data-icon="inline-start" />
          <AlertTitle>Agents are disabled</AlertTitle>
          <AlertDescription>
            The platform administrator disabled new agent runs and scheduling.
            Existing agents, workflows, and run history remain inspectable.
          </AlertDescription>
        </Alert>
      )}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <GitBranch data-icon="inline-start" />
            <span className="text-sm font-medium">Agents</span>
            <Badge variant="secondary">Native + A2A</Badge>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            A home for work that can move.
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Create JustAI agents, connect trusted remote agents, and compose
            bounded workflows with durable approvals, artifacts, and run
            history.
          </p>
        </div>
        {activeTab === "agents" && !disabled && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setRemoteOpen(true)}>
              <Link2 data-icon="inline-start" />
              Connect remote
            </Button>
            <Button onClick={() => openNative()}>
              <Plus data-icon="inline-start" />
              New native agent
            </Button>
          </div>
        )}
        {activeTab === "workflows" && !disabled && (
          <Button onClick={() => openWorkflow()}>
            <Plus data-icon="inline-start" />
            New workflow
          </Button>
        )}
      </header>

      {error && (
        <Alert variant="destructive">
          <CircleAlert data-icon="inline-start" />
          <AlertTitle>Agent workspace needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as AgentTab)}
      >
        <TabsList variant="line" className="w-full justify-start border-b pb-0">
          <TabsTrigger value="agents">
            <Bot data-icon="inline-start" />
            Agents{" "}
            <span className="ml-1 text-muted-foreground">{agents.length}</span>
          </TabsTrigger>
          <TabsTrigger value="workflows">
            <GitBranch data-icon="inline-start" />
            Workflows{" "}
            <span className="ml-1 text-muted-foreground">
              {workflows.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="runs">
            <Activity data-icon="inline-start" />
            Runs{" "}
            <span className="ml-1 text-muted-foreground">{runs.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="agents" className="pt-6">
          {loading && !agents.length ? (
            <LoadingState label="Loading agents…" />
          ) : (
            <AgentsPanel
              agents={agents}
              connections={connections}
              onEdit={openNative}
              onDelete={removeAgent}
              onTest={testConnection}
              onToggleConnection={toggleConnection}
              onDeleteConnection={deleteConnection}
              disabled={disabled}
            />
          )}
        </TabsContent>
        <TabsContent value="workflows" className="pt-6">
          <WorkflowsPanel
            workflows={workflows}
            draft={workflowDraft}
            agents={agents}
            mcpServers={mcpServers}
            knowledgeSources={knowledgeSources}
            selectedNode={selectedNode}
            selectedNodeId={selectedNodeId}
            graphNodes={graphNodes}
            graphEdges={graphEdges}
            validationMessage={validationMessage}
            saving={saving}
            validating={validating}
            onOpen={openWorkflow}
            onDelete={deleteWorkflow}
            onUpdate={updateWorkflow}
            onUpdateNode={updateWorkflowNode}
            onSelectNode={setSelectedNodeId}
            onAddNode={addWorkflowNode}
            onRemoveNode={removeWorkflowNode}
            onConnect={handleConnect}
            onPositionChange={(id, position) =>
              setPositions((current) => ({ ...current, [id]: position }))
            }
            onValidate={() => void validateWorkflow()}
            onSave={() => void saveWorkflow()}
            onRun={() => void runWorkflow()}
            disabled={disabled}
          />
        </TabsContent>
        <TabsContent value="runs" className="pt-6">
          <RunsPanel
            runs={runs}
            onRunsChange={setRuns}
            agents={agents}
            workflows={workflows}
            disabled={disabled}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={nativeOpen} onOpenChange={setNativeOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingAgent ? "Edit native agent" : "Create native agent"}
            </DialogTitle>
            <DialogDescription>
              Native agents use JustAI’s configured model, memory, MCP
              permissions, and conversation runtime.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="native-agent-name">Name</FieldLabel>
                <Input
                  id="native-agent-name"
                  value={nativeForm.name}
                  onChange={(event) =>
                    setNativeForm({ ...nativeForm, name: event.target.value })
                  }
                  placeholder="Research lead"
                />
              </Field>
              <Field>
                <FieldLabel>Visibility</FieldLabel>
                <Select
                  value={nativeForm.visibility}
                  onValueChange={(value) =>
                    setNativeForm({
                      ...nativeForm,
                      visibility: (value ??
                        "private") as NativeAgentForm["visibility"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {visibilityLabel(nativeForm.visibility)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="workspace">
                        Workspace shared
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="native-agent-description">
                Description
              </FieldLabel>
              <Input
                id="native-agent-description"
                value={nativeForm.description}
                onChange={(event) =>
                  setNativeForm({
                    ...nativeForm,
                    description: event.target.value,
                  })
                }
                placeholder="What this agent is good at"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="native-agent-instructions">
                Instructions
              </FieldLabel>
              <Textarea
                id="native-agent-instructions"
                rows={7}
                value={nativeForm.instructions}
                onChange={(event) =>
                  setNativeForm({
                    ...nativeForm,
                    instructions: event.target.value,
                  })
                }
                placeholder="Act as a careful research editor…"
              />
              <FieldDescription>
                These instructions are versioned. Existing conversations keep
                their pinned version.
              </FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Chat endpoint</FieldLabel>
                <Select
                  value={nativeForm.endpointId || "default"}
                  onValueChange={(value) =>
                    setNativeForm({
                      ...nativeForm,
                      endpointId: value === "default" ? "" : (value ?? ""),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {nativeForm.endpointId
                        ? endpoints.find(
                            (endpoint) => endpoint.id === nativeForm.endpointId
                          )?.name ?? "Selected endpoint"
                        : "Workspace default"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="default">Workspace default</SelectItem>
                      {endpoints
                        .filter(
                          (endpoint) =>
                            endpoint.enabled && endpoint.capabilities?.chat
                        )
                        .map((endpoint) => (
                          <SelectItem key={endpoint.id} value={endpoint.id}>
                            {endpoint.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="native-agent-model">
                  Model override
                </FieldLabel>
                <Input
                  id="native-agent-model"
                  value={nativeForm.model}
                  onChange={(event) =>
                    setNativeForm({ ...nativeForm, model: event.target.value })
                  }
                  placeholder="Use endpoint default"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field orientation="horizontal">
                <Switch
                  checked={nativeForm.useMemory}
                  onCheckedChange={(checked) =>
                    setNativeForm({ ...nativeForm, useMemory: checked })
                  }
                />
                <div>
                  <FieldLabel>Use memory</FieldLabel>
                  <FieldDescription>
                    Include the user’s approved persistent preferences.
                  </FieldDescription>
                </div>
              </Field>
              <Field orientation="horizontal">
                <Switch
                  checked={nativeForm.deepContext}
                  onCheckedChange={(checked) =>
                    setNativeForm({ ...nativeForm, deepContext: checked })
                  }
                />
                <div>
                  <FieldLabel>Deep context</FieldLabel>
                  <FieldDescription>
                    Use attached workspace context when available.
                  </FieldDescription>
                </div>
              </Field>
            </div>
            <FieldSet>
              <FieldLegend variant="label">Delegation allowlist</FieldLegend>
              <FieldDescription>
                Only these agents may be selected by <code>delegate_agent</code>
                .
              </FieldDescription>
              {agents.filter((agent) => agent.id !== editingAgent?.id)
                .length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {agents
                    .filter((agent) => agent.id !== editingAgent?.id)
                    .map((agent) => (
                      <label
                        key={agent.id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-primary/50 has-[:checked]:bg-primary/[0.06]"
                      >
                        <input
                          className="size-4 accent-primary"
                          type="checkbox"
                          checked={nativeForm.delegationAgentIds.includes(
                            agent.id
                          )}
                          onChange={() =>
                            setNativeForm((current) => ({
                              ...current,
                              delegationAgentIds:
                                current.delegationAgentIds.includes(agent.id)
                                  ? current.delegationAgentIds.filter(
                                      (id) => id !== agent.id
                                    )
                                  : [...current.delegationAgentIds, agent.id],
                            }))
                          }
                        />
                        <span className="truncate">{agent.name}</span>
                        <Badge className="ml-auto" variant="outline">
                          {agent.kind}
                        </Badge>
                      </label>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Create another agent to enable delegation.
                </p>
              )}
            </FieldSet>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNativeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                saving ||
                !nativeForm.name.trim() ||
                !nativeForm.instructions.trim()
              }
              onClick={() => void saveNative()}
            >
              {saving
                ? "Saving…"
                : editingAgent
                  ? "Save changes"
                  : "Create agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect an A2A agent</DialogTitle>
            <DialogDescription>
              JustAI makes outbound A2A 1.0 HTTP+JSON/SSE calls. Credentials are
              encrypted and never included in cards, prompts, logs, or audit
              details.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="remote-agent-name">
                  Display name
                </FieldLabel>
                <Input
                  id="remote-agent-name"
                  value={remoteForm.name}
                  onChange={(event) =>
                    setRemoteForm({ ...remoteForm, name: event.target.value })
                  }
                  placeholder="Vendor research agent"
                />
              </Field>
              <Field>
                <FieldLabel>Visibility</FieldLabel>
                <Select
                  value={remoteForm.visibility}
                  onValueChange={(value) =>
                    setRemoteForm({
                      ...remoteForm,
                      visibility: (value ??
                        "private") as RemoteAgentForm["visibility"],
                      connectionScope:
                        value === "workspace"
                          ? "organization"
                          : remoteForm.connectionScope,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {visibilityLabel(remoteForm.visibility)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="workspace">
                        Workspace shared
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Connection scope</FieldLabel>
                <Select
                  value={remoteForm.connectionScope}
                  onValueChange={(value) =>
                    setRemoteForm({
                      ...remoteForm,
                      connectionScope: (value ??
                        "user") as RemoteAgentForm["connectionScope"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {connectionScopeLabel(remoteForm.connectionScope)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="user">Private connection</SelectItem>
                      <SelectItem value="organization">
                        Workspace connection
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Workspace agents require a workspace connection. Shared
                  connections are managed by owners and admins.
                </FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="remote-agent-url">
                A2A endpoint URL
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="remote-agent-url"
                  value={remoteForm.endpointUrl}
                  onChange={(event) =>
                    setRemoteForm({
                      ...remoteForm,
                      endpointUrl: event.target.value,
                    })
                  }
                  placeholder="https://agent.example/a2a"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void discoverRemote()}
                  disabled={!remoteForm.endpointUrl.trim()}
                >
                  <Cloud data-icon="inline-start" />
                  Discover
                </Button>
              </div>
              <FieldDescription>
                Private network targets are controlled by the backend safe-dial
                policy.
              </FieldDescription>
            </Field>
            {discoveryMessage && (
              <Alert>
                <Cloud data-icon="inline-start" />
                <AlertDescription>{discoveryMessage}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel>Authentication</FieldLabel>
              <Select
                value={remoteForm.authType}
                onValueChange={(value) =>
                  setRemoteForm({
                    ...remoteForm,
                    authType: (value ?? "none") as RemoteAgentForm["authType"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue>{authTypeLabel(remoteForm.authType)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="none">No authentication</SelectItem>
                    <SelectItem value="api_key">API key</SelectItem>
                    <SelectItem value="http">
                      HTTP Basic / auth header
                    </SelectItem>
                    <SelectItem value="oauth2">OAuth2</SelectItem>
                    <SelectItem value="oidc">OIDC</SelectItem>
                    <SelectItem value="mtls">mTLS certificate</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {remoteForm.authType === "api_key" && (
              <Field>
                <FieldLabel htmlFor="remote-api-key">API key</FieldLabel>
                <Input
                  id="remote-api-key"
                  type="password"
                  value={remoteForm.credential}
                  onChange={(event) =>
                    setRemoteForm({
                      ...remoteForm,
                      credential: event.target.value,
                    })
                  }
                  autoComplete="new-password"
                />
              </Field>
            )}
            {remoteForm.authType === "http" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="remote-username">Username</FieldLabel>
                  <Input
                    id="remote-username"
                    value={remoteForm.username}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        username: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remote-password">Password</FieldLabel>
                  <Input
                    id="remote-password"
                    type="password"
                    value={remoteForm.password}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        password: event.target.value,
                      })
                    }
                    autoComplete="new-password"
                  />
                </Field>
              </div>
            )}
            {(remoteForm.authType === "oauth2" ||
              remoteForm.authType === "oidc") && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="remote-oauth-client">
                    Client ID
                  </FieldLabel>
                  <Input
                    id="remote-oauth-client"
                    value={remoteForm.oauthClientId}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        oauthClientId: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remote-oauth-scopes">Scopes</FieldLabel>
                  <Input
                    id="remote-oauth-scopes"
                    value={remoteForm.oauthScopes}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        oauthScopes: event.target.value,
                      })
                    }
                    placeholder="openid agent:run"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remote-oauth-auth">
                    Authorization URL
                  </FieldLabel>
                  <Input
                    id="remote-oauth-auth"
                    value={remoteForm.oauthAuthorizationUrl}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        oauthAuthorizationUrl: event.target.value,
                      })
                    }
                    placeholder="https://idp.example/authorize"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remote-oauth-token">
                    Token URL
                  </FieldLabel>
                  <Input
                    id="remote-oauth-token"
                    value={remoteForm.oauthTokenUrl}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        oauthTokenUrl: event.target.value,
                      })
                    }
                    placeholder="https://idp.example/token"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remote-client-secret">
                    Client secret
                  </FieldLabel>
                  <Input
                    id="remote-client-secret"
                    type="password"
                    value={remoteForm.clientSecret}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        clientSecret: event.target.value,
                      })
                    }
                    autoComplete="new-password"
                  />
                </Field>
              </div>
            )}
            {remoteForm.authType === "mtls" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="remote-certificate">
                    Client certificate
                  </FieldLabel>
                  <Textarea
                    id="remote-certificate"
                    rows={5}
                    value={remoteForm.certificate}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        certificate: event.target.value,
                      })
                    }
                    placeholder="-----BEGIN CERTIFICATE-----"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="remote-private-key">
                    Private key
                  </FieldLabel>
                  <Textarea
                    id="remote-private-key"
                    rows={5}
                    value={remoteForm.privateKey}
                    onChange={(event) =>
                      setRemoteForm({
                        ...remoteForm,
                        privateKey: event.target.value,
                      })
                    }
                    placeholder="-----BEGIN PRIVATE KEY-----"
                  />
                </Field>
              </div>
            )}
            <Field orientation="horizontal">
              <Switch
                checked={remoteForm.trustedReadOnly}
                onCheckedChange={(checked) =>
                  setRemoteForm({ ...remoteForm, trustedReadOnly: checked })
                }
              />
              <div>
                <FieldLabel>Trust read-only operations</FieldLabel>
                <FieldDescription>
                  Only enable this for a connection you control. Otherwise
                  remote runs pause for approval.
                </FieldDescription>
              </div>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoteOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                saving ||
                !remoteForm.name.trim() ||
                !remoteForm.endpointUrl.trim()
              }
              onClick={() => void saveRemote()}
            >
              <LockKeyhole data-icon="inline-start" />
              {saving ? "Connecting…" : "Save encrypted connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function LoadingState({ label }: { label: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 animate-spin" data-icon="inline-start" />
        {label}
      </CardContent>
    </Card>
  )
}

function AgentsPanel({
  agents,
  connections,
  onEdit,
  onDelete,
  onTest,
  onToggleConnection,
  onDeleteConnection,
  disabled = false,
}: {
  agents: Agent[]
  connections: AgentConnection[]
  onEdit: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  onTest: (connection: AgentConnection) => void
  onToggleConnection: (connection: AgentConnection, enabled: boolean) => void
  onDeleteConnection: (connection: AgentConnection) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-8">
      {agents.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {agents.map((agent) => {
            const connection = connections.find(
              (item) => item.id === agent.connectionId
            )
            return (
              <Card key={agent.id} className="min-h-56">
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "rounded-xl p-2",
                        agent.kind === "remote"
                          ? "bg-secondary text-secondary-foreground"
                          : "bg-primary/10 text-primary"
                      )}
                    >
                      <Bot />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">
                        {agent.name}
                      </CardTitle>
                      <CardDescription className="mt-1 line-clamp-2">
                        {agent.description ||
                          (agent.kind === "remote"
                            ? "Connected A2A agent"
                            : "Native JustAI agent")}
                      </CardDescription>
                    </div>
                    <CardAction>
                      <Badge variant={badgeVariant(agent.status)}>
                        {agent.kind === "remote" ? "A2A" : "Native"} ·{" "}
                        {statusLabel(agent.status)}
                      </Badge>
                    </CardAction>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 text-sm">
                  <div className="flex flex-wrap gap-2">
                    {agent.kind === "remote" ? (
                      <>
                        <Badge variant="outline">
                          <Link2 data-icon="inline-start" />
                          {connection?.authType ?? "A2A"}
                        </Badge>
                        {agent.credentialConfigured ? (
                          <Badge variant="outline">
                            <KeyRound data-icon="inline-start" />
                            Credential saved
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            Credential missing
                          </Badge>
                        )}
                      </>
                    ) : (
                      <>
                        <Badge variant="outline">
                          <ShieldCheck data-icon="inline-start" />
                          JustAI runtime
                        </Badge>
                        {agent.useMemory && (
                          <Badge variant="outline">Memory</Badge>
                        )}
                        {agent.deepContext && (
                          <Badge variant="outline">Deep context</Badge>
                        )}
                      </>
                    )}
                  </div>
                  {agent.kind === "remote" && connection?.lastError && (
                    <Alert variant="destructive">
                      <CircleAlert data-icon="inline-start" />
                      <AlertDescription>
                        {connection.lastError}
                      </AlertDescription>
                    </Alert>
                  )}
                  {agent.delegationAgentIds?.length ? (
                    <p className="text-xs text-muted-foreground">
                      Can delegate to {agent.delegationAgentIds.length}{" "}
                      allowlisted agent
                      {agent.delegationAgentIds.length === 1 ? "" : "s"}.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No delegation targets configured.
                    </p>
                  )}
                </CardContent>
                <CardFooter className="justify-end gap-1 border-t">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onDelete(agent)}
                    aria-label={`Delete ${agent.name}`}
                  >
                    <Trash2 data-icon="inline-start" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => onEdit(agent)}
                  >
                    Configure
                  </Button>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex min-h-64 flex-col items-center justify-center text-center">
            <div className="rounded-full bg-muted p-3">
              <Bot />
            </div>
            <h2 className="mt-4 font-medium">No agents yet</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Create a native specialist or connect an A2A agent. Both can be
              selected in chat and placed in workflows.
            </p>
          </CardContent>
        </Card>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Connections</h2>
            <p className="text-sm text-muted-foreground">
              Encrypted remote access shared by the workspace or kept personal.
            </p>
          </div>
          <Badge variant="outline">{connections.length} configured</Badge>
        </div>
        {connections.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {connections.map((connection) => (
              <Card key={connection.id} size="sm">
                <CardContent className="flex items-center gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Link2 />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{connection.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {connection.endpointUrl}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge
                        variant={connection.enabled ? "secondary" : "outline"}
                      >
                        {connection.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Badge
                        variant={
                          connection.lastError ? "destructive" : "outline"
                        }
                      >
                        {connection.lastError
                          ? "Needs attention"
                          : connection.lastTestedAt
                            ? "Tested"
                            : "Not tested"}
                      </Badge>
                      {connection.trustedReadOnly && (
                        <Badge variant="outline">Trusted read-only</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Switch
                      checked={connection.enabled}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        onToggleConnection(connection, checked)
                      }
                      aria-label={`Enable ${connection.name}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => onTest(connection)}
                      aria-label={`Test ${connection.name}`}
                    >
                      <RefreshCw data-icon="inline-start" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => onDeleteConnection(connection)}
                      aria-label={`Delete ${connection.name}`}
                    >
                      <Trash2 data-icon="inline-start" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No remote connections configured.
          </p>
        )}
      </section>
    </div>
  )
}

function WorkflowsPanel({
  workflows,
  draft,
  agents,
  mcpServers,
  knowledgeSources,
  selectedNode,
  selectedNodeId,
  graphNodes,
  graphEdges,
  validationMessage,
  saving,
  validating,
  onOpen,
  onDelete,
  onUpdate,
  onUpdateNode,
  onSelectNode,
  onAddNode,
  onRemoveNode,
  onConnect,
  onPositionChange,
  onValidate,
  onSave,
  onRun,
  disabled = false,
}: {
  workflows: AgentWorkflow[]
  draft: WorkflowDraft | null
  agents: Agent[]
  mcpServers: MCPServer[]
  knowledgeSources: KnowledgeSource[]
  selectedNode?: AgentWorkflowNode
  selectedNodeId: string
  graphNodes: Node<FlowNodeData>[]
  graphEdges: Edge[]
  validationMessage: string
  saving: boolean
  validating: boolean
  onOpen: (workflow?: AgentWorkflow) => void
  onDelete: (workflow: AgentWorkflow) => void
  onUpdate: (patch: Partial<WorkflowDraft>) => void
  onUpdateNode: (id: string, patch: Partial<AgentWorkflowNode>) => void
  onSelectNode: (id: string) => void
  onAddNode: () => void
  onRemoveNode: () => void
  onConnect: (connection: Connection) => void
  onPositionChange: (id: string, position: { x: number; y: number }) => void
  onValidate: () => void
  onSave: () => void
  onRun: () => void
  disabled?: boolean
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === editorRef.current)
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (!isFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isFullscreen])

  const toggleFullscreen = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    if (isFullscreen) {
      setIsFullscreen(false)
      if (document.fullscreenElement === editor) {
        await document.exitFullscreen().catch(() => undefined)
      }
      return
    }
    setIsFullscreen(true)
    try {
      await editor.requestFullscreen()
    } catch {
      // Keep the fixed focus mode when the browser blocks the native API.
    }
  }, [isFullscreen])

  return (
    <div className="grid gap-5 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Workflow library</CardTitle>
          <CardDescription>Bounded DAGs keep runs replayable.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50",
                draft?.id === workflow.id && "border-primary bg-primary/[0.04]"
              )}
              onClick={() => onOpen(workflow)}
            >
              <span className="block truncate text-sm font-medium">
                {workflow.name}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {workflow.definition.nodes.length} nodes ·{" "}
                {workflow.schedule.kind === "manual"
                  ? "Manual"
                  : `${workflow.schedule.kind} · ${workflow.timezone}`}
              </span>
            </button>
          ))}
          {!workflows.length && (
            <p className="py-5 text-center text-xs text-muted-foreground">
              No saved workflows.
            </p>
          )}
        </CardContent>
        {draft?.id && (
          <CardFooter className="border-t">
            <Button
              className="w-full"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                onDelete(workflows.find((item) => item.id === draft.id)!)
              }
            >
              <Trash2 data-icon="inline-start" />
              Delete workflow
            </Button>
          </CardFooter>
        )}
      </Card>
      {draft ? (
        <Card
          ref={editorRef}
          className={cn(
            "min-w-0",
            isFullscreen &&
              "fixed inset-0 z-50 min-h-screen w-screen overflow-y-auto rounded-none bg-background py-6"
          )}
        >
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>
                  {draft.id ? "Edit workflow" : "New workflow"}
                </CardTitle>
                <CardDescription>
                  Connect agent nodes, bind outputs, and make every context
                  grant explicit.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void toggleFullscreen()}
                  aria-label={
                    isFullscreen
                      ? "Exit full screen editor"
                      : "Open full screen editor"
                  }
                >
                  {isFullscreen ? (
                    <Minimize2 data-icon="inline-start" />
                  ) : (
                    <Maximize2 data-icon="inline-start" />
                  )}
                  <span className="hidden sm:inline">
                    {isFullscreen ? "Exit full screen" : "Full screen"}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onValidate}
                  disabled={validating}
                >
                  <CheckCircle2 data-icon="inline-start" />
                  {validating ? "Validating…" : "Validate"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onSave}
                  disabled={disabled || saving}
                >
                  <Check data-icon="inline-start" />
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button size="sm" onClick={onRun} disabled={disabled}>
                  <Play data-icon="inline-start" />
                  Run
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="workflow-name">Name</FieldLabel>
                <Input
                  id="workflow-name"
                  value={draft.name}
                  disabled={disabled}
                  onChange={(event) => onUpdate({ name: event.target.value })}
                  placeholder="Research then synthesize"
                />
              </Field>
              <Field>
                <FieldLabel>Visibility</FieldLabel>
                <Select
                  value={draft.visibility}
                  disabled={disabled}
                  onValueChange={(value) =>
                    onUpdate({
                      visibility: (value ??
                        "private") as WorkflowDraft["visibility"],
                    })
                }
                >
                  <SelectTrigger>
                    <SelectValue>{visibilityLabel(draft.visibility)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="workspace">
                        Workspace shared
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Timezone</FieldLabel>
                <Input
                  value={draft.timezone}
                  disabled={disabled}
                  onChange={(event) =>
                    onUpdate({ timezone: event.target.value })
                  }
                  placeholder="Europe/Berlin"
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="workflow-description">
                Description
              </FieldLabel>
              <Input
                id="workflow-description"
                value={draft.description}
                disabled={disabled}
                onChange={(event) =>
                  onUpdate({ description: event.target.value })
                }
                placeholder="What this workflow produces"
              />
            </Field>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="flex min-h-[430px] flex-col gap-2 overflow-hidden rounded-xl border bg-muted/20">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <div>
                    <p className="text-xs font-medium">Execution graph</p>
                    <p className="text-[11px] text-muted-foreground">
                      Drag nodes; connect bottom handles to top handles.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onAddNode}
                    disabled={disabled || draft.definition.nodes.length >= 16}
                  >
                    <Plus data-icon="inline-start" />
                    Agent node
                  </Button>
                </div>
                <WorkflowCanvas
                  key={draft.id || "new"}
                  nodes={graphNodes}
                  edges={graphEdges}
                  disabled={disabled}
                  onConnect={onConnect}
                  onSelectNode={onSelectNode}
                  onPositionChange={onPositionChange}
                />
              </div>
              <NodeInspector
                node={selectedNode}
                selectedNodeId={selectedNodeId}
                agents={agents}
                mcpServers={mcpServers}
                knowledgeSources={knowledgeSources}
                onUpdate={onUpdateNode}
                onRemove={onRemoveNode}
                disabled={disabled}
              />
            </div>
            <ScheduleEditor
              schedule={draft.schedule}
              enabled={draft.enabled}
              onScheduleChange={(schedule) => onUpdate({ schedule })}
              onEnabledChange={(enabled) => onUpdate({ enabled })}
              disabled={disabled}
            />
            {validationMessage && (
              <Alert
                variant={
                  validationMessage.toLowerCase().includes("valid") ||
                  validationMessage.toLowerCase().includes("saved")
                    ? undefined
                    : "destructive"
                }
              >
                <ListChecks data-icon="inline-start" />
                <AlertDescription>{validationMessage}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex min-h-96 flex-col items-center justify-center text-center">
            <div className="rounded-full bg-muted p-3">
              <GitBranch />
            </div>
            <h2 className="mt-4 font-medium">Build your first workflow</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Start with a node, add a second agent, connect them, and run a
              parallel or fan-in graph with durable progress.
            </p>
            <Button className="mt-5" onClick={() => onOpen()} disabled={disabled}>
              <Plus data-icon="inline-start" />
              New workflow
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function NodeInspector({
  node,
  selectedNodeId,
  agents,
  mcpServers,
  knowledgeSources,
  onUpdate,
  onRemove,
  disabled = false,
}: {
  node?: AgentWorkflowNode
  selectedNodeId: string
  agents: Agent[]
  mcpServers: MCPServer[]
  knowledgeSources: KnowledgeSource[]
  onUpdate: (id: string, patch: Partial<AgentWorkflowNode>) => void
  onRemove: () => void
  disabled?: boolean
}) {
  if (!node)
    return (
      <Card className="h-fit border-dashed">
        <CardContent className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
          Select a node to configure its agent, context, and safety policy.
        </CardContent>
      </Card>
    )
  const context = node.context ?? {}
  return (
    <Card className="h-fit">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Node configuration</CardTitle>
            <CardDescription>{selectedNodeId}</CardDescription>
          </div>
          <Button
            size="icon"
            variant="ghost"
            disabled={disabled}
            onClick={onRemove}
            aria-label="Remove selected node"
          >
            <X data-icon="inline-start" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel>Agent</FieldLabel>
          <Select
            value={node.agentId ?? "default"}
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate(node.id, {
                agentId: value === "default" ? undefined : (value ?? undefined),
              })
            }
          >
            <SelectTrigger>
              <SelectValue>
                {node.agentId
                  ? `${agentToSavedLabel(
                      agents.find((agent) => agent.id === node.agentId)
                    )} · ${
                      agents.find((agent) => agent.id === node.agentId)?.kind ??
                      "native"
                    }`
                  : "Default native agent"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="default">Default native agent</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} · {agent.kind}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`instruction-${node.id}`}>
            Instruction
          </FieldLabel>
          <Textarea
            id={`instruction-${node.id}`}
            rows={5}
            value={node.instruction}
            disabled={disabled}
            onChange={(event) =>
              onUpdate(node.id, { instruction: event.target.value })
            }
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>Approval</FieldLabel>
            <Select
              value={node.approvalMode || "review"}
              disabled={disabled}
              onValueChange={(value) =>
                onUpdate(node.id, { approvalMode: value ?? "review" })
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {approvalModeLabel(node.approvalMode || "review")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="read_only_auto">
                    Auto trusted read-only
                  </SelectItem>
                  <SelectItem value="review">Always review</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Max attempts</FieldLabel>
            <Input
              type="number"
              min={1}
              max={3}
              value={node.retry?.maxAttempts ?? 3}
              disabled={disabled}
              onChange={(event) =>
                onUpdate(node.id, {
                  retry: {
                    maxAttempts: Math.max(
                      1,
                      Math.min(3, Number(event.target.value) || 1)
                    ),
                  },
                })
              }
            />
          </Field>
        </div>
        <Field>
          <FieldLabel>Node timeout (seconds)</FieldLabel>
          <Input
            type="number"
            min={1}
            max={600}
            value={node.timeoutSeconds ?? 600}
            disabled={disabled}
            onChange={(event) =>
              onUpdate(node.id, {
                timeoutSeconds: Math.max(
                  1,
                  Math.min(600, Number(event.target.value) || 600)
                ),
              })
            }
          />
        </Field>
        <FieldSet>
          <FieldLegend variant="label">MCP grants</FieldLegend>
          <FieldDescription>
            Only selected servers and tools enter this node’s immutable context
            scope.
          </FieldDescription>
          <div className="flex max-h-32 flex-col gap-2 overflow-y-auto">
            {mcpServers.length ? (
              mcpServers.map((server) => (
                <label
                  key={server.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    className="size-3.5 accent-primary"
                    type="checkbox"
                    checked={context.mcpServerIds?.includes(server.id) ?? false}
                    disabled={disabled}
                    onChange={() => {
                      const current = context.mcpServerIds ?? []
                      onUpdate(node.id, {
                        context: updateContext(context, {
                          mcpServerIds: current.includes(server.id)
                            ? current.filter((id) => id !== server.id)
                            : [...current, server.id],
                        }),
                      })
                    }}
                  />
                  <span className="truncate">{server.name}</span>
                </label>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                No MCP servers connected.
              </span>
            )}
          </div>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Knowledge grants</FieldLegend>
          <div className="flex max-h-24 flex-col gap-2 overflow-y-auto">
            {knowledgeSources.length ? (
              knowledgeSources.slice(0, 8).map((source) => (
                <label
                  key={source.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    className="size-3.5 accent-primary"
                    type="checkbox"
                    checked={
                      context.knowledgeSourceIds?.includes(source.id) ?? false
                    }
                    disabled={disabled}
                    onChange={() => {
                      const current = context.knowledgeSourceIds ?? []
                      onUpdate(node.id, {
                        context: updateContext(context, {
                          knowledgeSourceIds: current.includes(source.id)
                            ? current.filter((id) => id !== source.id)
                            : [...current, source.id],
                        }),
                      })
                    }}
                  />
                  <span className="truncate">{source.title}</span>
                </label>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                No knowledge sources available.
              </span>
            )}
          </div>
        </FieldSet>
      </CardContent>
    </Card>
  )
}

function ScheduleEditor({
  schedule,
  enabled,
  onScheduleChange,
  onEnabledChange,
  disabled = false,
}: {
  schedule: AgentSchedule
  enabled: boolean
  onScheduleChange: (schedule: AgentSchedule) => void
  onEnabledChange: (enabled: boolean) => void
  disabled?: boolean
}) {
  const kind = schedule.kind || "manual"
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Schedule</h3>
          <p className="text-xs text-muted-foreground">
            Daily, weekly, and monthly recurrence use the workflow timezone.
          </p>
        </div>
        <Field orientation="horizontal">
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
          />
          <FieldLabel>Enabled</FieldLabel>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field>
          <FieldLabel>Recurrence</FieldLabel>
          <Select
            value={kind}
            disabled={disabled}
            onValueChange={(value) =>
              onScheduleChange(
                value === "manual"
                  ? { kind: "manual" }
                  : {
                      ...schedule,
                      kind: value ?? "manual",
                      interval: schedule.interval || 1,
                      time: schedule.time || "09:00",
                      weekday:
                        schedule.weekday || (value === "monthly" ? 1 : 1),
                    }
              )
            }
          >
            <SelectTrigger>
              <SelectValue>{scheduleKindLabel(kind)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="manual">Manual only</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {kind !== "manual" && (
          <>
            <Field>
              <FieldLabel>Every</FieldLabel>
              <Input
                type="number"
                min={1}
                max={365}
                value={schedule.interval ?? 1}
                disabled={disabled}
                onChange={(event) =>
                  onScheduleChange({
                    ...schedule,
                    interval: Math.max(1, Number(event.target.value) || 1),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>
                {kind === "monthly"
                  ? "Day of month"
                  : kind === "weekly"
                    ? "Weekday"
                    : "Time"}
              </FieldLabel>
              {kind === "weekly" ? (
                <Select
                  value={String(schedule.weekday ?? 1)}
                  disabled={disabled}
                  onValueChange={(value) =>
                    onScheduleChange({
                      ...schedule,
                      weekday: Number(value ?? 1),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>{weekdayLabel(schedule.weekday)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ].map((day, index) => (
                        <SelectItem key={day} value={String(index)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={kind === "monthly" ? "number" : "time"}
                  min={kind === "monthly" ? 1 : undefined}
                  max={kind === "monthly" ? 31 : undefined}
                  value={
                    kind === "monthly"
                      ? (schedule.weekday ?? 1)
                      : (schedule.time ?? "09:00")
                  }
                  disabled={disabled}
                  onChange={(event) =>
                    onScheduleChange(
                      kind === "monthly"
                        ? {
                            ...schedule,
                            weekday: Number(event.target.value) || 1,
                          }
                        : { ...schedule, time: event.target.value }
                    )
                  }
                />
              )}
            </Field>
            <Field>
              <FieldLabel>Time</FieldLabel>
              <Input
                type="time"
                value={schedule.time ?? "09:00"}
                disabled={disabled}
                onChange={(event) =>
                  onScheduleChange({ ...schedule, time: event.target.value })
                }
              />
            </Field>
          </>
        )}
      </div>
    </section>
  )
}

function RunsPanel({
  runs,
  onRunsChange,
  agents,
  workflows,
  disabled = false,
}: {
  runs: AgentRun[]
  onRunsChange: (runs: AgentRun[]) => void
  agents: Agent[]
  workflows: AgentWorkflow[]
  disabled?: boolean
}) {
  const [selectedID, setSelectedID] = useState<string | null>(
    runs[0]?.id ?? null
  )
  const [detail, setDetail] = useState<AgentRun | null>(null)
  const [error, setError] = useState("")
  const runsRef = useRef(runs)
  const onRunsChangeRef = useRef(onRunsChange)
  const selectedSummary = runs.find((run) => run.id === selectedID)
  const detailStatus = detail?.status

  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  useEffect(() => {
    onRunsChangeRef.current = onRunsChange
  }, [onRunsChange])

  useEffect(() => {
    if (selectedID || !runs[0]) return
    const timer = window.setTimeout(() => setSelectedID(runs[0].id), 0)
    return () => window.clearTimeout(timer)
  }, [runs, selectedID])

  const reload = useCallback(async (id: string) => {
    try {
      const result = await api.get<{ run: AgentRun }>(
        `/api/v1/agent-runs/${id}`
      )
      setDetail(result.run)
      onRunsChangeRef.current(
        runsRef.current.map((run) =>
          run.id === result.run.id ? { ...run, ...result.run } : run
        )
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The run could not be loaded."
      )
    }
  }, [])

  useEffect(() => {
    if (!selectedID) return
    const timer = window.setTimeout(() => void reload(selectedID), 0)
    return () => window.clearTimeout(timer)
  }, [reload, selectedID])

  useEffect(() => {
    if (
      !selectedID ||
      !detailStatus ||
      ["completed", "failed", "cancelled"].includes(detailStatus)
    )
      return
    let stopped = false
    let retryTimer: number | undefined
    let lastEventID = 0
    const controller = new AbortController()
    const connect = async () => {
      if (stopped) return
      try {
        const query = lastEventID ? `?after=${lastEventID}` : ""
        const headers: Record<string, string> = {}
        const organizationID = api.getOrganizationId()
        if (organizationID) headers["X-Organization-ID"] = organizationID
        const response = await fetch(
          resolveAPIURL(`/api/v1/agent-runs/${selectedID}/events${query}`),
          { credentials: "include", headers, signal: controller.signal }
        )
        if (!response.ok || !response.body)
          throw new Error("Run event stream unavailable")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (!stopped) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const blocks = buffer.split("\n\n")
          buffer = blocks.pop() ?? ""
          for (const block of blocks) {
            const idLine = block
              .split("\n")
              .find((line) => line.startsWith("id:"))
            if (idLine)
              lastEventID = Number(idLine.slice(3).trim()) || lastEventID
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n")
            if (data) {
              try {
                JSON.parse(data)
              } catch {
                /* reconnectable event payload */
              }
              void reload(selectedID)
            }
          }
        }
      } catch {
        if (!stopped) retryTimer = window.setTimeout(() => void connect(), 1200)
      }
    }
    void connect()
    return () => {
      stopped = true
      controller.abort()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [detailStatus, reload, selectedID])

  async function cancelRun() {
    if (!selectedID) return
    try {
      const result = await api.post<{ run: AgentRun }>(
        `/api/v1/agent-runs/${selectedID}/cancel`
      )
      setDetail(result.run)
      await reload(selectedID)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The run could not be cancelled."
      )
    }
  }

  async function retryRun() {
    if (!selectedID) return
    try {
      const result = await api.post<{ run: AgentRun }>(
        `/api/v1/agent-runs/${selectedID}/retry`
      )
      onRunsChange([result.run, ...runs])
      setSelectedID(result.run.id)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The run could not be retried."
      )
    }
  }

  async function decide(
    approval: AgentApproval,
    decision: "approved" | "rejected"
  ) {
    if (!selectedID) return
    try {
      const result = await api.post<{ run: AgentRun }>(
        `/api/v1/agent-runs/${selectedID}/approvals/${approval.id}/decision`,
        { decision, argumentHash: approval.argumentHash }
      )
      setDetail(result.run)
      await reload(selectedID)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The approval decision could not be saved."
      )
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[20rem_minmax(0,1fr)]">
      {error && (
        <Alert className="xl:col-span-2" variant="destructive">
          <CircleAlert data-icon="inline-start" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card className="h-fit">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Run history</CardTitle>
              <CardDescription>
                Replayable events and immutable snapshots.
              </CardDescription>
            </div>
            <Badge variant="outline">{runs.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex max-h-[620px] flex-col gap-2 overflow-y-auto">
          {runs.length ? (
            runs.map((run) => (
              <button
                key={run.id}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left hover:bg-muted/50",
                  selectedID === run.id && "border-primary bg-primary/[0.04]"
                )}
                onClick={() => setSelectedID(run.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {workflows.find(
                      (workflow) => workflow.id === run.workflowId
                    )?.name ??
                      (run.sourceType === "chat"
                        ? "Chat delegation"
                        : "Agent run")}
                  </span>
                  <Badge variant={badgeVariant(run.status)}>
                    {statusLabel(run.status)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(run.createdAt).toLocaleString()} · {run.sourceType}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {run.summary || run.error || "Waiting for execution…"}
                </p>
              </button>
            ))
          ) : (
            <EmptyRuns />
          )}
        </CardContent>
      </Card>
      {detail || selectedSummary ? (
        <RunDetail
          run={detail ?? selectedSummary!}
          agents={agents}
          onCancel={() => void cancelRun()}
          onRetry={() => void retryRun()}
          onDecision={(approval, decision) => void decide(approval, decision)}
          disabled={disabled}
        />
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            Select a run to inspect its graph and live events.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function EmptyRuns() {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="rounded-full bg-muted p-3">
        <Activity />
      </div>
      <p className="font-medium">No runs yet</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Run a workflow or delegate from chat and progress will appear here.
      </p>
    </div>
  )
}

function RunDetail({
  run,
  agents,
  onCancel,
  onRetry,
  onDecision,
  disabled = false,
}: {
  run: AgentRun
  agents: Agent[]
  onCancel: () => void
  onRetry: () => void
  onDecision: (
    approval: AgentApproval,
    decision: "approved" | "rejected"
  ) => void
  disabled?: boolean
}) {
  const nodes = run.nodes ?? []
  const completed = nodes.filter((node) => node.status === "completed").length
  const pendingApprovals = (run.approvals ?? []).filter(
    (approval) => approval.status === "pending"
  )
  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity data-icon="inline-start" />
              {statusLabel(run.status)}
            </CardTitle>
            <CardDescription className="mt-1">
              {run.id} · {run.sourceType} · started{" "}
              {new Date(run.startedAt).toLocaleString()}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {["queued", "running", "waiting_approval"].includes(run.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={onCancel}
                disabled={disabled}
              >
                <X data-icon="inline-start" />
                Cancel
              </Button>
            )}
            {["failed", "cancelled"].includes(run.status) && (
              <Button size="sm" onClick={onRetry} disabled={disabled}>
                <RotateCcw data-icon="inline-start" />
                Retry
              </Button>
            )}
            {run.conversationId && (
              <Button
                size="sm"
                variant="ghost"
                render={<a href={`/${run.conversationId}`} />}
              >
                <MessageLink />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span>Node progress</span>
            <span className="text-muted-foreground">
              {completed}/{nodes.length || 1}
            </span>
          </div>
          <Progress
            value={nodes.length ? (completed / nodes.length) * 100 : 0}
          />
        </div>
        {run.summary && (
          <Alert>
            <CheckCircle2 data-icon="inline-start" />
            <AlertDescription>{run.summary}</AlertDescription>
          </Alert>
        )}
        {run.error && (
          <Alert variant="destructive">
            <CircleAlert data-icon="inline-start" />
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {nodes.map((node) => (
            <RunNodeCard key={node.id} node={node} agents={agents} />
          ))}
        </div>
        {pendingApprovals.length > 0 && (
          <section className="flex flex-col gap-3">
            <Separator />
            <div>
              <h3 className="font-medium">Approvals required</h3>
              <p className="text-xs text-muted-foreground">
                The action hash is checked server-side before the decision is
                accepted.
              </p>
            </div>
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecision={onDecision}
              />
            ))}
          </section>
        )}
        {run.artifacts?.length ? (
          <section className="flex flex-col gap-2">
            <Separator />
            <h3 className="font-medium">Artifacts</h3>
            {run.artifacts.map((artifact) => (
              <a
                className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm hover:bg-muted/50"
                key={artifact.id}
                href={resolveAPIURL(
                  `/api/v1/agent-runs/${run.id}/artifacts/${artifact.id}`
                )}
                target="_blank"
                rel="noreferrer"
              >
                <span className="truncate">{artifact.name}</span>
                <span className="text-xs text-muted-foreground">
                  {Math.ceil(artifact.sizeBytes / 1024)} KB
                </span>
              </a>
            ))}
          </section>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RunNodeCard({
  node,
  agents,
}: {
  node: AgentRunNode
  agents: Agent[]
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="rounded-md bg-muted p-1.5">
              <Bot />
            </div>
            <span className="truncate text-sm font-medium">{node.nodeKey}</span>
          </div>
          <Badge variant={badgeVariant(node.status)}>
            {statusLabel(node.status)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {agents.find((agent) => agent.id === node.agentId)?.name ??
            "Default native agent"}{" "}
          · attempt {node.attempt || 0}
        </p>
        {node.providerTaskId && (
          <p className="break-all text-[11px] text-muted-foreground">
            Remote task: {node.providerTaskId}
          </p>
        )}
        {node.error && <p className="text-xs text-destructive">{node.error}</p>}
      </CardContent>
    </Card>
  )
}

function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: AgentApproval
  onDecision: (
    approval: AgentApproval,
    decision: "approved" | "rejected"
  ) => void
}) {
  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 text-primary" />
          <div className="min-w-0">
            <p className="font-medium">{statusLabel(approval.actionType)}</p>
            <p className="text-xs text-muted-foreground">
              Expires {new Date(approval.expiresAt).toLocaleString()}
            </p>
          </div>
        </div>
        <pre className="max-h-36 overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] whitespace-pre-wrap">
          {JSON.stringify(approval.action, null, 2)}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDecision(approval, "rejected")}
          >
            <X data-icon="inline-start" />
            Reject
          </Button>
          <Button size="sm" onClick={() => onDecision(approval, "approved")}>
            <Check data-icon="inline-start" />
            Approve exact action
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MessageLink() {
  return (
    <span className="inline-flex items-center gap-1">
      <UserRound data-icon="inline-start" />
      Open chat
    </span>
  )
}
