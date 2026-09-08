"use client"

import {
  memo,
  type ReactNode,
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
  ChevronDown,
  CircleAlert,
  Clock3,
  Cloud,
  GitBranch,
  KeyRound,
  Link2,
  ListChecks,
  Maximize2,
  MessageSquare,
  Minimize2,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
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
import { StaticAssistantMarkdown } from "@/components/assistant-ui/markdown-text"
import {
  formatWorkflowNextRun,
  validateWorkflowDefinition,
  validateWorkflowResources,
  workflowInputNames,
  workflowScheduleDescription,
} from "@/lib/agent-workflow-logic"
import type {
  Agent,
  AgentApproval,
  AgentConnection,
  AgentContextScope,
  AgentInputBinding,
  AgentRun,
  AgentRunEvent,
  AgentRunNode,
  AgentSchedule,
  AgentTab,
  AgentWorkflow,
  AgentWorkflowDefinition,
  AgentWorkflowNode,
  Endpoint,
  KnowledgeSpace,
  KnowledgeSource,
  MCPServer,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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

type DeleteTarget =
  | { kind: "agent"; item: Agent }
  | { kind: "connection"; item: AgentConnection }
  | { kind: "workflow"; item: AgentWorkflow }

type WorkflowRunInput = Record<string, string>

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

function remoteConnectionPayload(form: RemoteAgentForm) {
  return {
    scopeType: form.connectionScope,
    name: form.name.trim(),
    endpointUrl: form.endpointUrl.trim(),
    authType: form.authType,
    credential: form.credential.trim() || undefined,
    username: form.username.trim() || undefined,
    password: form.password || undefined,
    accessToken: form.accessToken.trim() || undefined,
    clientSecret: form.clientSecret || undefined,
    certificate: form.certificate.trim() || undefined,
    privateKey: form.privateKey.trim() || undefined,
    oauthAuthorizationUrl: form.oauthAuthorizationUrl.trim() || undefined,
    oauthTokenUrl: form.oauthTokenUrl.trim() || undefined,
    oauthClientId: form.oauthClientId.trim() || undefined,
    oauthScopes: form.oauthScopes.trim() || undefined,
    trustedReadOnly: form.trustedReadOnly,
  }
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

type WorkflowTemplateId =
  "research-brief" | "meeting-actions" | "content-review" | "daily-news"

const workflowTemplates: Array<{
  id: WorkflowTemplateId
  name: string
  description: string
}> = [
  {
    id: "daily-news",
    name: "Daily news briefing",
    description:
      "Let specialist agents analyze one storage folder, then synthesize a daily brief.",
  },
  {
    id: "research-brief",
    name: "Research brief",
    description: "Research a question, then synthesize the findings.",
  },
  {
    id: "meeting-actions",
    name: "Meeting actions",
    description: "Turn a transcript into decisions and next steps.",
  },
  {
    id: "content-review",
    name: "Content review",
    description: "Review source material, then produce an editorial pass.",
  },
]

function workflowTemplateDraft(templateID: WorkflowTemplateId): WorkflowDraft {
  const draft = emptyWorkflow()
  switch (templateID) {
    case "daily-news":
      return {
        ...draft,
        name: "Daily news briefing",
        description:
          "Parallel political and economic analysis of the latest files in a storage folder.",
        definition: {
          nodes: [
            {
              ...draft.definition.nodes[0],
              id: "politics",
              instruction:
                "Analyze the current news material for German federal politics. Return factual, deduplicated bullets with portal, publication date, headline, URL, political relevance, and uncertainty where applicable.",
            },
            {
              ...draft.definition.nodes[0],
              id: "economy",
              instruction:
                "Analyze the current news material for economic, fiscal, labor-market, and business implications in Germany. Return factual, deduplicated bullets with portal, publication date, headline, URL, impact, and uncertainty where applicable.",
            },
            {
              ...draft.definition.nodes[0],
              id: "editor",
              instruction:
                "Combine the specialist analyses into a concise German daily briefing. Lead with the most consequential developments, remove duplicates, preserve source URLs, distinguish facts from interpretation, and end with items to monitor.",
              inputBindings: [
                {
                  name: "politics",
                  source: "node",
                  nodeId: "politics",
                  path: "summary",
                },
                {
                  name: "economy",
                  source: "node",
                  nodeId: "economy",
                  path: "summary",
                },
              ],
            },
          ],
          edges: [
            { from: "politics", to: "editor" },
            { from: "economy", to: "editor" },
          ],
        },
        schedule: { kind: "daily", interval: 1, time: "08:00" },
      }
    case "meeting-actions":
      return {
        ...draft,
        name: "Meeting action plan",
        description:
          "Extract decisions, owners, and next steps from a transcript.",
        definition: {
          nodes: [
            {
              ...draft.definition.nodes[0],
              id: "extract-actions",
              instruction:
                "Read the supplied transcript and extract decisions, owners, deadlines, and unresolved questions. Return concise, factual action items.",
              inputBindings: [{ name: "transcript", source: "input" }],
            },
          ],
          edges: [],
        },
      }
    case "content-review":
      return {
        ...draft,
        name: "Content review",
        description:
          "Review source material and turn the findings into an editorial pass.",
        definition: {
          nodes: [
            {
              ...draft.definition.nodes[0],
              id: "review-source",
              instruction:
                "Review the supplied source material for factual gaps, unclear claims, and risks. Return a prioritized editorial checklist.",
              inputBindings: [{ name: "source", source: "input" }],
            },
            {
              ...draft.definition.nodes[0],
              id: "write-pass",
              instruction:
                "Use the review findings to produce a concise, improved editorial pass. Preserve supported facts and call out anything that still needs verification.",
              inputBindings: [
                {
                  name: "review",
                  source: "node",
                  nodeId: "review-source",
                  path: "result",
                },
              ],
            },
          ],
          edges: [{ from: "review-source", to: "write-pass" }],
        },
      }
    case "research-brief":
    default:
      return {
        ...draft,
        name: "Research brief",
        description:
          "Research a question, then synthesize a source-aware brief.",
        definition: {
          nodes: [
            {
              ...draft.definition.nodes[0],
              id: "research",
              instruction:
                "Investigate the supplied question using the approved context and return the strongest findings with their supporting sources.",
              inputBindings: [{ name: "question", source: "input" }],
            },
            {
              ...draft.definition.nodes[0],
              id: "synthesize",
              instruction:
                "Synthesize the research into a concise brief with an answer first, evidence, caveats, and clearly labeled open questions.",
              inputBindings: [
                {
                  name: "findings",
                  source: "node",
                  nodeId: "research",
                  path: "result",
                },
              ],
            },
          ],
          edges: [{ from: "research", to: "synthesize" }],
        },
      }
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

function knowledgeSpacePath(space: KnowledgeSpace, spaces: KnowledgeSpace[]) {
  const names = [space.name]
  const seen = new Set([space.id])
  let parentId = space.parentId
  while (parentId) {
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = spaces.find((candidate) => candidate.id === parentId)
    if (!parent) break
    names.unshift(parent.name)
    parentId = parent.parentId
  }
  return names.join(" / ")
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

function parseDelimitedList(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function formatDelimitedList(value: string[] | undefined) {
  return (value ?? []).join(", ")
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
            {data.agentName || "No agent selected"}
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
    <div className="h-full min-h-0 w-full flex-1">
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
        onNodeDragStop={(_, node) => onPositionChange(node.id, node.position)}
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
  return agent?.name ?? "No agent selected"
}

function updateAgentRunURL(runID?: string) {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  url.searchParams.set("tab", "runs")
  if (runID) url.searchParams.set("run", runID)
  else url.searchParams.delete("run")
  window.history.replaceState(window.history.state, "", url)
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
  const [knowledgeSpaces, setKnowledgeSpaces] = useState<KnowledgeSpace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [nativeOpen, setNativeOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [editingConnection, setEditingConnection] =
    useState<AgentConnection | null>(null)
  const [nativeForm, setNativeForm] = useState<NativeAgentForm>(emptyNativeForm)
  const [remoteForm, setRemoteForm] = useState<RemoteAgentForm>(emptyRemoteForm)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null)
  const [runDialogOpen, setRunDialogOpen] = useState(false)
  const [runInput, setRunInput] = useState<WorkflowRunInput>({})
  const [running, setRunning] = useState(false)
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
      const [connectionResult, workflowResult, runResult, spaceResult] =
        await Promise.all([
          api.get<{ connections: AgentConnection[] }>(
            "/api/v1/agent-connections"
          ),
          api.get<{ workflows: AgentWorkflow[] }>("/api/v1/agent-workflows"),
          api.get<{ runs: AgentRun[] }>("/api/v1/agent-runs"),
          api
            .get<{ spaces: KnowledgeSpace[] }>("/api/v1/knowledge/spaces")
            .catch(() => ({ spaces: [] })),
        ])
      setConnections(connectionResult.connections ?? [])
      setWorkflows(workflowResult.workflows ?? [])
      setRuns(runResult.runs ?? [])
      setKnowledgeSpaces(spaceResult.spaces ?? [])
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
    setEditingConnection(null)
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

  const openRemote = useCallback(
    (agent?: Agent) => {
      const connection = agent?.connectionId
        ? (connections.find((item) => item.id === agent.connectionId) ?? null)
        : null
      setEditingAgent(agent ?? null)
      setEditingConnection(connection)
      setRemoteForm(
        agent && connection
          ? {
              ...emptyRemoteForm,
              name: agent.name || connection.name,
              description: agent.description,
              endpointUrl: connection.endpointUrl,
              authType: connection.authType,
              visibility:
                agent.visibility === "workspace" ? "workspace" : "private",
              connectionScope:
                connection.scopeType === "organization"
                  ? "organization"
                  : "user",
              trustedReadOnly: connection.trustedReadOnly,
            }
          : { ...emptyRemoteForm }
      )
      setError("")
      setDiscoveryMessage("")
      setRemoteOpen(true)
    },
    [connections]
  )

  const openAgent = useCallback(
    (agent?: Agent) => {
      if (agent?.kind === "remote") {
        openRemote(agent)
      } else {
        openNative(agent)
      }
    },
    [openNative, openRemote]
  )

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

  function removeAgent(agent: Agent) {
    setDeleteTarget({ kind: "agent", item: agent })
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
    if (!remoteForm.name.trim() || !remoteForm.endpointUrl.trim()) {
      setError("Give the remote agent a name and endpoint URL.")
      return
    }
    if (
      remoteForm.visibility === "workspace" &&
      remoteForm.connectionScope !== "organization"
    ) {
      setError("Workspace agents require a workspace connection.")
      return
    }
    setSaving(true)
    setError("")
    const connectionPayload = remoteConnectionPayload(remoteForm)
    const shouldStartOAuth =
      remoteForm.authType === "oauth2" || remoteForm.authType === "oidc"
    try {
      let connection: AgentConnection
      let agent: Agent

      if (editingAgent?.kind === "remote" && editingConnection) {
        const connectionResult = await api.patch<{
          connection: AgentConnection
        }>(
          `/api/v1/agent-connections/${editingConnection.id}`,
          connectionPayload
        )
        connection = connectionResult.connection
        const agentResult = await api.patch<{ agent: Agent }>(
          `/api/v1/agents/${editingAgent.id}`,
          {
            kind: "remote",
            name: remoteForm.name.trim(),
            description: remoteForm.description.trim(),
            visibility: remoteForm.visibility,
            connectionId: connection.id,
          }
        )
        agent = agentResult.agent
        onAgentsChange(
          agents.map((item) => (item.id === agent.id ? agent : item))
        )
        setConnections((current) =>
          current.map((item) => (item.id === connection.id ? connection : item))
        )
      } else {
        const connectionResult = await api.post<{
          connection: AgentConnection
        }>("/api/v1/agent-connections", connectionPayload)
        connection = connectionResult.connection
        try {
          const agentResult = await api.post<{ agent: Agent }>(
            "/api/v1/agents",
            {
              kind: "remote",
              name: remoteForm.name.trim(),
              description: remoteForm.description.trim(),
              visibility: remoteForm.visibility,
              connectionId: connection.id,
            }
          )
          agent = agentResult.agent
        } catch (caught) {
          // Creating a connection and agent are two API operations. Roll back
          // the connection if the second operation fails so a half-created
          // remote setup does not remain in the workspace.
          await api
            .delete(`/api/v1/agent-connections/${connection.id}`)
            .catch(() => undefined)
          throw caught
        }
        onAgentsChange([agent, ...agents])
        setConnections((current) => [connection, ...current])
      }
      setRemoteOpen(false)
      setRemoteForm(emptyRemoteForm)
      setEditingAgent(null)
      setEditingConnection(null)
      setDiscoveryMessage("")
      if (shouldStartOAuth) {
        const oauth = await api.get<{ authorizationUrl: string }>(
          `/api/v1/agent-connections/${connection.id}/oauth/start`
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

  function deleteConnection(connection: AgentConnection) {
    setDeleteTarget({ kind: "connection", item: connection })
  }

  const openWorkflow = useCallback(
    (workflow?: AgentWorkflow) => {
      const next = workflow ? cloneWorkflow(workflow) : emptyWorkflow()
      if (!workflow && agents[0]) {
        next.definition.nodes = next.definition.nodes.map((node) => ({
          ...node,
          agentId: agents[0].id,
        }))
      }
      setWorkflowDraft(next)
      setSelectedNodeId(next.definition.nodes[0]?.id ?? "")
      setPositions({})
      setValidationMessage("")
    },
    [agents]
  )

  const openWorkflowTemplate = useCallback(
    (templateID: WorkflowTemplateId) => {
      const next = workflowTemplateDraft(templateID)
      if (agents[0]) {
        next.definition.nodes = next.definition.nodes.map((node) => ({
          ...node,
          agentId: agents[0].id,
        }))
      }
      setWorkflowDraft(next)
      setSelectedNodeId(next.definition.nodes[0]?.id ?? "")
      setPositions({})
      setValidationMessage(
        "Template loaded. Choose agents and review the mappings before saving."
      )
    },
    [agents]
  )

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
      agentId: agents[0]?.id,
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
    const unassignedNode = workflowDraft.definition.nodes.find(
      (node) => !node.agentId
    )
    if (unassignedNode) {
      setValidationMessage(`Node ${unassignedNode.id} needs an agent.`)
      return
    }
    const localError = validateWorkflowDefinition(workflowDraft.definition)
    if (localError) {
      setValidationMessage(localError)
      return
    }
    const resourceError = validateWorkflowResources(
      workflowDraft.definition,
      workflowDraft.visibility,
      agents,
      connections
    )
    if (resourceError) {
      setValidationMessage(resourceError)
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
    const unassignedNode = workflowDraft.definition.nodes.find(
      (node) => !node.agentId
    )
    if (unassignedNode) {
      setValidationMessage(`Node ${unassignedNode.id} needs an agent.`)
      return
    }
    const localError = validateWorkflowDefinition(workflowDraft.definition)
    if (localError) {
      setValidationMessage(localError)
      return
    }
    const resourceError = validateWorkflowResources(
      workflowDraft.definition,
      workflowDraft.visibility,
      agents,
      connections
    )
    if (resourceError) {
      setValidationMessage(resourceError)
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

  function openRunDialog() {
    if (!workflowDraft?.id) {
      setValidationMessage("Save the workflow before running it.")
      return
    }
    const names = workflowInputNames(workflowDraft.definition)
    setRunInput(
      Object.fromEntries(names.map((name) => [name, ""])) as WorkflowRunInput
    )
    setRunDialogOpen(true)
  }

  async function runWorkflow(input: WorkflowRunInput) {
    if (!workflowDraft?.id || running) return
    setRunning(true)
    try {
      const result = await api.post<{ run: AgentRun }>(
        `/api/v1/agent-workflows/${workflowDraft.id}/runs`,
        { input }
      )
      setRuns((current) => [result.run, ...current])
      setRunDialogOpen(false)
      onTabChange("runs")
      updateAgentRunURL(result.run.id)
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error
          ? caught.message
          : "The workflow could not be started."
      )
    } finally {
      setRunning(false)
    }
  }

  function deleteWorkflow(workflow: AgentWorkflow) {
    setDeleteTarget({ kind: "workflow", item: workflow })
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return
    const target = deleteTarget
    setDeleting(true)
    setError("")
    try {
      if (target.kind === "agent") {
        await api.delete(`/api/v1/agents/${target.item.id}`)
        onAgentsChange(agents.filter((item) => item.id !== target.item.id))
      } else if (target.kind === "connection") {
        await api.delete(`/api/v1/agent-connections/${target.item.id}`)
        setConnections((current) =>
          current.filter((item) => item.id !== target.item.id)
        )
      } else {
        await api.delete(`/api/v1/agent-workflows/${target.item.id}`)
        setWorkflows((current) =>
          current.filter((item) => item.id !== target.item.id)
        )
        if (workflowDraft?.id === target.item.id) setWorkflowDraft(null)
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : target.kind === "agent"
            ? "The agent could not be deleted."
            : target.kind === "connection"
              ? "The connection could not be removed."
              : "The workflow could not be deleted."
      )
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
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
  const currentRunInputNames = workflowDraft
    ? workflowInputNames(workflowDraft.definition)
    : []

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
            <Button variant="outline" onClick={() => openRemote()}>
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
              onEdit={openAgent}
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
            connections={connections}
            mcpServers={mcpServers}
            knowledgeSpaces={knowledgeSpaces}
            knowledgeSources={knowledgeSources}
            selectedNode={selectedNode}
            selectedNodeId={selectedNodeId}
            graphNodes={graphNodes}
            graphEdges={graphEdges}
            validationMessage={validationMessage}
            saving={saving}
            validating={validating}
            onOpen={openWorkflow}
            onClose={() => setWorkflowDraft(null)}
            onOpenTemplate={openWorkflowTemplate}
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
            onRun={openRunDialog}
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
                        ? (endpoints.find(
                            (endpoint) => endpoint.id === nativeForm.endpointId
                          )?.name ?? "Selected endpoint")
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
                  aria-label="Use memory"
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
                  aria-label="Use deep context"
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

      <Dialog
        open={remoteOpen}
        onOpenChange={(open) => {
          setRemoteOpen(open)
          if (!open) {
            setEditingAgent(null)
            setEditingConnection(null)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingAgent ? "Configure A2A agent" : "Connect an A2A agent"}
            </DialogTitle>
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
                  disabled={remoteForm.visibility === "workspace"}
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
                  <SelectValue>
                    {authTypeLabel(remoteForm.authType)}
                  </SelectValue>
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
                aria-label="Trust read-only operations"
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
              {saving
                ? editingAgent
                  ? "Saving…"
                  : "Connecting…"
                : editingAgent
                  ? "Save changes"
                  : "Save encrypted connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
        <DialogContent className="max-h-[min(720px,calc(100svh-2rem))] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run workflow</DialogTitle>
            <DialogDescription>
              Provide the values declared by this workflow. They are captured
              with the immutable run snapshot and passed only to mapped nodes.
            </DialogDescription>
          </DialogHeader>
          {currentRunInputNames.length ? (
            <FieldGroup>
              {currentRunInputNames.map((name) => (
                <Field key={name}>
                  <FieldLabel htmlFor={`workflow-run-input-${name}`}>
                    {name}
                  </FieldLabel>
                  <Textarea
                    id={`workflow-run-input-${name}`}
                    rows={3}
                    value={runInput[name] ?? ""}
                    onChange={(event) =>
                      setRunInput((current) => ({
                        ...current,
                        [name]: event.target.value,
                      }))
                    }
                    placeholder="Enter a value"
                  />
                </Field>
              ))}
            </FieldGroup>
          ) : (
            <Alert>
              <ListChecks data-icon="inline-start" />
              <AlertDescription>
                This workflow has no declared inputs. Add a “Workflow input”
                binding to a node if the run should accept a value.
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRunDialogOpen(false)}
              disabled={running}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void runWorkflow(runInput)}
              disabled={running}
            >
              {running ? "Starting…" : "Start run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "agent"
                ? `Delete ${deleteTarget.item.name}?`
                : deleteTarget?.kind === "connection"
                  ? `Remove the ${deleteTarget.item.name} connection?`
                  : `Delete ${deleteTarget?.item.name ?? "this workflow"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "agent"
                ? "Existing conversations keep their pinned agent version. New runs will no longer be able to select this agent."
                : deleteTarget?.kind === "connection"
                  ? "Remote agents using this connection may stop working. This cannot be undone."
                  : "Existing runs stay inspectable, but this workflow will no longer be available for new runs or schedules."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "Removing…" : "Confirm deletion"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  connections,
  mcpServers,
  knowledgeSpaces,
  knowledgeSources,
  selectedNode,
  selectedNodeId,
  graphNodes,
  graphEdges,
  validationMessage,
  saving,
  validating,
  onOpen,
  onClose,
  onOpenTemplate,
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
  connections: AgentConnection[]
  mcpServers: MCPServer[]
  knowledgeSpaces: KnowledgeSpace[]
  knowledgeSources: KnowledgeSource[]
  selectedNode?: AgentWorkflowNode
  selectedNodeId: string
  graphNodes: Node<FlowNodeData>[]
  graphEdges: Edge[]
  validationMessage: string
  saving: boolean
  validating: boolean
  onOpen: (workflow?: AgentWorkflow) => void
  onClose: () => void
  onOpenTemplate: (templateID: WorkflowTemplateId) => void
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
    <div
      className={cn(
        "grid gap-5",
        !draft && "xl:grid-cols-[18rem_minmax(0,1fr)]"
      )}
    >
      {!draft && (
        <Card className="h-fit max-h-[calc(100vh-13rem)] overflow-y-auto">
          <CardHeader>
            <CardTitle>Workflow library</CardTitle>
            <CardDescription>
              Bounded DAGs keep runs replayable.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {workflows.map((workflow) => (
              <button
                key={workflow.id}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50",
                  "focus-visible:border-primary"
                )}
                onClick={() => onOpen(workflow)}
              >
                <span className="block truncate text-sm font-medium">
                  {workflow.name}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {workflow.definition.nodes.length} nodes ·{" "}
                  {workflowScheduleDescription(workflow.schedule)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Next run:{" "}
                  {formatWorkflowNextRun(workflow.nextRunAt, workflow.timezone)}
                </span>
              </button>
            ))}
            {!workflows.length && (
              <p className="py-5 text-center text-xs text-muted-foreground">
                No saved workflows.
              </p>
            )}
            <div className="mt-2 border-t pt-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <Sparkles className="size-3.5 text-primary" />
                Start from a template
              </p>
              <div className="flex flex-col gap-1.5">
                {workflowTemplates.map((template) => (
                  <button
                    key={template.id}
                    className="rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/60"
                    onClick={() => onOpenTemplate(template.id)}
                    type="button"
                  >
                    <span className="block font-medium">{template.name}</span>
                    <span className="mt-0.5 block text-muted-foreground">
                      {template.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {draft ? (
        <Card
          ref={editorRef}
          className={cn(
            "min-w-0",
            isFullscreen &&
              "fixed inset-0 z-50 min-h-screen w-screen overflow-y-auto rounded-none bg-background py-6"
          )}
        >
          <CardHeader
            className={cn(
              isFullscreen &&
                "sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm"
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={onClose}
                  >
                    Workflows
                  </Button>
                  <CardTitle>
                    {draft.id ? draft.name || "Edit workflow" : "New workflow"}
                  </CardTitle>
                </div>
                <CardDescription>
                  Connect agent nodes, bind outputs, and make every context
                  grant explicit.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {draft.id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      const workflow = workflows.find(
                        (item) => item.id === draft.id
                      )
                      if (workflow) onDelete(workflow)
                    }}
                  >
                    <Trash2 data-icon="inline-start" />
                    Delete
                  </Button>
                )}
                <Button
                  type="button"
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
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onValidate}
                  disabled={validating}
                >
                  <CheckCircle2 data-icon="inline-start" />
                  {validating ? "Validating…" : "Validate"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onSave}
                  disabled={disabled || saving}
                >
                  <Check data-icon="inline-start" />
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onRun}
                  disabled={disabled}
                >
                  <Play data-icon="inline-start" />
                  Run
                </Button>
              </div>
            </div>
            {validationMessage && (
              <Alert
                className="mt-3"
                role="status"
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
                    <SelectValue>
                      {visibilityLabel(draft.visibility)}
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
              <div className="max-h-[min(46rem,calc(100vh-12rem))] overflow-y-auto pr-1">
                <NodeInspector
                  node={selectedNode}
                  selectedNodeId={selectedNodeId}
                  agents={agents}
                  connections={connections}
                  workflowNodes={draft.definition.nodes}
                  mcpServers={mcpServers}
                  knowledgeSpaces={knowledgeSpaces}
                  knowledgeSources={knowledgeSources}
                  onUpdate={onUpdateNode}
                  onRemove={onRemoveNode}
                  disabled={disabled}
                />
              </div>
            </div>
            <ScheduleEditor
              schedule={draft.schedule}
              enabled={draft.enabled}
              nextRunAt={
                draft.id
                  ? workflows.find((workflow) => workflow.id === draft.id)
                      ?.nextRunAt
                  : null
              }
              timezone={draft.timezone}
              onScheduleChange={(schedule) => onUpdate({ schedule })}
              onEnabledChange={(enabled) => onUpdate({ enabled })}
              disabled={disabled}
            />
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
            <Button
              className="mt-5"
              onClick={() => onOpen()}
              disabled={disabled}
            >
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
  connections,
  workflowNodes,
  mcpServers,
  knowledgeSpaces,
  knowledgeSources,
  onUpdate,
  onRemove,
  disabled = false,
}: {
  node?: AgentWorkflowNode
  selectedNodeId: string
  agents: Agent[]
  connections: AgentConnection[]
  workflowNodes: AgentWorkflowNode[]
  mcpServers: MCPServer[]
  knowledgeSpaces: KnowledgeSpace[]
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
  const inputBindings = node.inputBindings ?? []
  const otherNodes = workflowNodes.filter(
    (candidate) => candidate.id !== node.id
  )
  const selectedAgent = agents.find((agent) => agent.id === node.agentId)
  const selectedConnection = selectedAgent?.connectionId
    ? connections.find(
        (connection) => connection.id === selectedAgent.connectionId
      )
    : undefined

  const updateBinding = (index: number, patch: Partial<AgentInputBinding>) => {
    const next = inputBindings.map((binding, bindingIndex) =>
      bindingIndex === index ? { ...binding, ...patch } : binding
    )
    onUpdate(node.id, { inputBindings: next })
  }

  const addBinding = () => {
    const existingNames = new Set(inputBindings.map((binding) => binding.name))
    let name = "input"
    let suffix = 2
    while (existingNames.has(name)) {
      name = `input_${suffix}`
      suffix += 1
    }
    onUpdate(node.id, {
      inputBindings: [...inputBindings, { name, source: "input" }],
    })
  }

  const removeBinding = (index: number) => {
    onUpdate(node.id, {
      inputBindings: inputBindings.filter(
        (_, bindingIndex) => bindingIndex !== index
      ),
    })
  }

  const updateDelimitedContext = (
    key: "repositoryIds" | "noteIds" | "transcriptionSessionIds" | "mcpTools",
    value: string
  ) => {
    onUpdate(node.id, {
      context: updateContext(context, { [key]: parseDelimitedList(value) }),
    })
  }

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
            value={node.agentId}
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate(node.id, {
                agentId: value ?? undefined,
              })
            }
          >
            <SelectTrigger>
              <SelectValue>
                {selectedAgent
                  ? `${agentToSavedLabel(selectedAgent)} · ${
                      selectedAgent.kind ?? "native"
                    }${
                      selectedAgent.kind === "remote" && selectedConnection
                        ? ` · ${connectionScopeLabel(selectedConnection.scopeType)}`
                        : ""
                    }`
                  : "Select an agent"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {agents.map((agent) => {
                  const connection = agent.connectionId
                    ? connections.find(
                        (candidate) => candidate.id === agent.connectionId
                      )
                    : undefined
                  return (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.kind}
                      {agent.kind === "remote" && connection
                        ? ` · ${connectionScopeLabel(connection.scopeType)}`
                        : ""}
                    </SelectItem>
                  )
                })}
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
          <div className="flex items-start justify-between gap-3">
            <div>
              <FieldLegend variant="label">
                Input and output mappings
              </FieldLegend>
              <FieldDescription>
                Give this node named values from the workflow run or a connected
                previous node.
              </FieldDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addBinding}
              disabled={disabled}
            >
              <Plus data-icon="inline-start" />
              Add mapping
            </Button>
          </div>
          {inputBindings.length ? (
            <div className="flex flex-col gap-3">
              {inputBindings.map((binding, index) => {
                const source = binding.source.trim().toLowerCase()
                return (
                  <div
                    key={`${node.id}-binding-${index}`}
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                      <Field>
                        <FieldLabel
                          htmlFor={`binding-name-${node.id}-${index}`}
                        >
                          Name
                        </FieldLabel>
                        <Input
                          id={`binding-name-${node.id}-${index}`}
                          value={binding.name}
                          disabled={disabled}
                          onChange={(event) =>
                            updateBinding(index, { name: event.target.value })
                          }
                          placeholder="research_question"
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Source</FieldLabel>
                        <Select
                          value={source === "node" ? "node" : "input"}
                          disabled={disabled}
                          onValueChange={(value) =>
                            updateBinding(index, {
                              source: value === "node" ? "node" : "input",
                              nodeId:
                                value === "node" ? binding.nodeId : undefined,
                              path: value === "node" ? binding.path : undefined,
                            })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue>
                              {source === "node"
                                ? "Previous output"
                                : "Workflow input"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="input">
                                Workflow input
                              </SelectItem>
                              <SelectItem value="node">
                                Previous output
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="self-end"
                        onClick={() => removeBinding(index)}
                        disabled={disabled}
                        aria-label={`Remove ${binding.name || "input"} mapping`}
                      >
                        <X data-icon="inline-start" />
                      </Button>
                    </div>
                    {source === "node" && (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel>Previous node</FieldLabel>
                          <Select
                            value={binding.nodeId ?? "none"}
                            disabled={disabled || !otherNodes.length}
                            onValueChange={(value) =>
                              updateBinding(index, {
                                nodeId:
                                  value === "none"
                                    ? undefined
                                    : (value ?? undefined),
                              })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue>
                                {otherNodes.find(
                                  (candidate) => candidate.id === binding.nodeId
                                )?.id ?? "Choose a connected node"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="none">
                                  Choose a connected node
                                </SelectItem>
                                {otherNodes.map((candidate) => (
                                  <SelectItem
                                    key={candidate.id}
                                    value={candidate.id}
                                  >
                                    {candidate.id}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel
                            htmlFor={`binding-path-${node.id}-${index}`}
                          >
                            Output path (optional)
                          </FieldLabel>
                          <Input
                            id={`binding-path-${node.id}-${index}`}
                            value={binding.path ?? ""}
                            disabled={disabled}
                            onChange={(event) =>
                              updateBinding(index, {
                                path: event.target.value || undefined,
                              })
                            }
                            placeholder="result.summary"
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No mappings yet. Nodes receive the workflow context by default.
            </p>
          )}
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Delegation allowlist</FieldLegend>
          <FieldDescription>
            These agents may be selected by this node when it delegates work.
          </FieldDescription>
          <div className="flex max-h-32 flex-col gap-2 overflow-y-auto">
            {agents.length ? (
              agents
                .filter((agent) => agent.id !== node.agentId)
                .map((agent) => (
                  <label
                    key={agent.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <input
                      className="size-3.5 accent-primary"
                      type="checkbox"
                      checked={
                        node.delegationAgentIds?.includes(agent.id) ?? false
                      }
                      disabled={disabled}
                      onChange={() => {
                        const current = node.delegationAgentIds ?? []
                        onUpdate(node.id, {
                          delegationAgentIds: current.includes(agent.id)
                            ? current.filter((id) => id !== agent.id)
                            : [...current, agent.id],
                        })
                      }}
                    />
                    <span className="truncate">{agent.name}</span>
                    <span className="text-muted-foreground">{agent.kind}</span>
                  </label>
                ))
            ) : (
              <span className="text-xs text-muted-foreground">
                Add another agent to enable delegation.
              </span>
            )}
          </div>
        </FieldSet>
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
          <FieldLegend variant="label">Storage folder grants</FieldLegend>
          <FieldDescription>
            Every run reads the current contents of the selected folder and all
            of its subfolders. The resolved files are frozen in the run snapshot
            for auditability.
          </FieldDescription>
          <div className="flex max-h-32 flex-col gap-2 overflow-y-auto">
            {knowledgeSpaces.length ? (
              knowledgeSpaces.map((space) => (
                <label
                  key={space.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    className="size-3.5 accent-primary"
                    type="checkbox"
                    checked={
                      context.knowledgeSpaceIds?.includes(space.id) ?? false
                    }
                    disabled={disabled}
                    onChange={() => {
                      const current = context.knowledgeSpaceIds ?? []
                      onUpdate(node.id, {
                        context: updateContext(context, {
                          knowledgeSpaceIds: current.includes(space.id)
                            ? current.filter((id) => id !== space.id)
                            : [...current, space.id],
                        }),
                      })
                    }}
                  />
                  <span className="truncate">
                    {knowledgeSpacePath(space, knowledgeSpaces)}
                  </span>
                  <span className="text-muted-foreground">
                    {space.itemCount}
                  </span>
                </label>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                Create a folder in Storage first.
              </span>
            )}
          </div>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Individual file grants</FieldLegend>
          <div className="flex max-h-24 flex-col gap-2 overflow-y-auto">
            {knowledgeSources.length ? (
              knowledgeSources.map((source) => (
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
        <FieldSet>
          <FieldLegend variant="label">
            Additional context references
          </FieldLegend>
          <FieldDescription>
            Optional comma-separated IDs or tool names. Access is evaluated at
            run time and remains scoped to this node.
          </FieldDescription>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`repositories-${node.id}`}>
                Repository IDs
              </FieldLabel>
              <Input
                id={`repositories-${node.id}`}
                value={formatDelimitedList(context.repositoryIds)}
                disabled={disabled}
                onChange={(event) =>
                  updateDelimitedContext("repositoryIds", event.target.value)
                }
                placeholder="repo_123, repo_456"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`notes-${node.id}`}>Note IDs</FieldLabel>
              <Input
                id={`notes-${node.id}`}
                value={formatDelimitedList(context.noteIds)}
                disabled={disabled}
                onChange={(event) =>
                  updateDelimitedContext("noteIds", event.target.value)
                }
                placeholder="note_123, note_456"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`transcriptions-${node.id}`}>
                Transcription session IDs
              </FieldLabel>
              <Input
                id={`transcriptions-${node.id}`}
                value={formatDelimitedList(context.transcriptionSessionIds)}
                disabled={disabled}
                onChange={(event) =>
                  updateDelimitedContext(
                    "transcriptionSessionIds",
                    event.target.value
                  )
                }
                placeholder="session_123"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`mcp-tools-${node.id}`}>
                MCP tool names
              </FieldLabel>
              <Input
                id={`mcp-tools-${node.id}`}
                value={formatDelimitedList(context.mcpTools)}
                disabled={disabled}
                onChange={(event) =>
                  updateDelimitedContext("mcpTools", event.target.value)
                }
                placeholder="search, fetch"
              />
            </Field>
          </FieldGroup>
        </FieldSet>
      </CardContent>
    </Card>
  )
}

function ScheduleEditor({
  schedule,
  enabled,
  nextRunAt,
  timezone,
  onScheduleChange,
  onEnabledChange,
  disabled = false,
}: {
  schedule: AgentSchedule
  enabled: boolean
  nextRunAt?: string | null
  timezone: string
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
            aria-label="Enable schedule"
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
            {kind === "weekly" && (
              <Field>
                <FieldLabel>Weekday</FieldLabel>
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
              </Field>
            )}
            {kind === "monthly" && (
              <Field>
                <FieldLabel>Day of month</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={schedule.weekday ?? 1}
                  disabled={disabled}
                  onChange={(event) =>
                    onScheduleChange({
                      ...schedule,
                      weekday: Math.max(
                        1,
                        Math.min(31, Number(event.target.value) || 1)
                      ),
                    })
                  }
                />
              </Field>
            )}
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
      <div className="rounded-lg border bg-background/70 px-3 py-2 text-xs">
        <p className="font-medium">{workflowScheduleDescription(schedule)}</p>
        <p className="mt-1 text-muted-foreground">
          Next run: {formatWorkflowNextRun(nextRunAt, timezone)}
        </p>
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
  const [selectedID, setSelectedID] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const requested = new URLSearchParams(window.location.search).get("run")
      if (requested) return requested
    }
    return runs[0]?.id ?? null
  })
  const [detail, setDetail] = useState<AgentRun | null>(null)
  const [events, setEvents] = useState<AgentRunEvent[]>([])
  const [error, setError] = useState("")
  const runsRef = useRef(runs)
  const onRunsChangeRef = useRef(onRunsChange)
  const runStatusRef = useRef<string | undefined>(undefined)
  const selectedSummary = runs.find((run) => run.id === selectedID)
  const selectedRunStatus = detail?.status ?? selectedSummary?.status

  useEffect(() => {
    const runID = new URLSearchParams(window.location.search).get("run")
    if (!runID && selectedID) updateAgentRunURL(selectedID)
  }, [selectedID])

  useEffect(() => {
    runStatusRef.current = selectedRunStatus
  }, [selectedRunStatus])

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

  const appendEvent = useCallback((event: AgentRunEvent) => {
    if (!event.id || !event.eventType) return
    setEvents((current) => {
      if (current.some((item) => item.id === event.id)) return current
      return [...current, event].sort((left, right) => left.id - right.id)
    })
  }, [])

  useEffect(() => {
    if (!selectedID) return
    const timer = window.setTimeout(() => void reload(selectedID), 0)
    return () => window.clearTimeout(timer)
  }, [reload, selectedID])

  useEffect(() => {
    if (!selectedID) return
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
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ""
          for (const block of blocks) {
            const idLine = block
              .split(/\r?\n/)
              .find((line) => line.startsWith("id:"))
            if (idLine)
              lastEventID = Number(idLine.slice(3).trim()) || lastEventID
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n")
            if (data) {
              try {
                const event = JSON.parse(data) as Partial<AgentRunEvent>
                if (
                  typeof event.id === "number" &&
                  typeof event.eventType === "string"
                ) {
                  appendEvent(event as AgentRunEvent)
                }
              } catch {
                /* reconnectable event payload */
              }
              void reload(selectedID)
            }
          }
        }
        if (
          !stopped &&
          !["completed", "failed", "cancelled"].includes(
            runStatusRef.current ?? ""
          )
        ) {
          retryTimer = window.setTimeout(() => void connect(), 1200)
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
  }, [appendEvent, reload, selectedID])

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
      selectRun(result.run.id)
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

  const selectedWorkflow = workflows.find(
    (workflow) => workflow.id === (detail ?? selectedSummary)?.workflowId
  )

  function selectRun(id: string) {
    if (id === selectedID) return
    setDetail(null)
    setEvents([])
    setSelectedID(id)
    updateAgentRunURL(id)
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
                onClick={() => selectRun(run.id)}
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
          workflow={selectedWorkflow}
          events={events}
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
  workflow,
  events,
  onCancel,
  onRetry,
  onDecision,
  disabled = false,
}: {
  run: AgentRun
  agents: Agent[]
  workflow?: AgentWorkflow
  events: AgentRunEvent[]
  onCancel: () => void
  onRetry: () => void
  onDecision: (
    approval: AgentApproval,
    decision: "approved" | "rejected"
  ) => void
  disabled?: boolean
}) {
  const nodes = run.nodes ?? []
  const completed = nodes.filter(
    (node) => node.status === "completed" || node.status === "skipped"
  ).length
  const failed = nodes.filter((node) => node.status === "failed").length
  const pendingApprovals = (run.approvals ?? []).filter(
    (approval) => approval.status === "pending"
  )
  const activityCount =
    events.filter((event) => event.eventType !== "node.progress").length +
    new Set(
      events
        .filter((event) => event.eventType === "node.progress")
        .map((event) => event.nodeId ?? "run")
    ).size
  const duration = formatRunDuration(run.startedAt, run.finishedAt)
  const flowNodes: Node<FlowNodeData>[] = nodes.map((node, index) => ({
    id: node.nodeKey,
    type: "agent",
    position: {
      x: (index % 3) * 260 + 30,
      y: Math.floor(index / 3) * 150 + 35,
    },
    data: {
      label: node.nodeKey,
      agentName: agentToSavedLabel(
        agents.find((agent) => agent.id === node.agentId)
      ),
      instruction: node.definition?.instruction ?? "",
      status: node.status,
    },
  }))
  const flowEdges: Edge[] =
    workflow?.definition.edges.map((edge) => ({
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
    })) ?? []

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity data-icon="inline-start" />
              {workflow?.name ?? "Workflow run"}
            </CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={badgeVariant(run.status)}>
                {statusLabel(run.status)}
              </Badge>
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>{run.sourceType}</span>
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
      <CardContent className="flex flex-col gap-6">
        <section className="grid gap-3 sm:grid-cols-3" aria-label="Run summary">
          <div className="rounded-xl border bg-muted/[0.18] px-4 py-3">
            <p className="text-xs text-muted-foreground">Nodes successful</p>
            <p className="mt-1 text-xl font-semibold">
              {completed}/{nodes.length || 1}
            </p>
          </div>
          <div className="rounded-xl border bg-muted/[0.18] px-4 py-3">
            <p className="text-xs text-muted-foreground">Duration</p>
            <p className="mt-1 flex items-center gap-2 text-xl font-semibold">
              <Clock3 className="size-4 text-muted-foreground" />
              {duration}
            </p>
          </div>
          <div className="rounded-xl border bg-muted/[0.18] px-4 py-3">
            <p className="text-xs text-muted-foreground">Health</p>
            <p className="mt-1 text-xl font-semibold">
              {failed
                ? `${failed} failed`
                : completed === nodes.length && nodes.length
                  ? "All successful"
                  : "In progress"}
            </p>
          </div>
        </section>
        <Progress value={nodes.length ? (completed / nodes.length) * 100 : 0} />

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

        <section
          className="flex flex-col gap-3"
          aria-labelledby="node-status-title"
        >
          <div>
            <h3 id="node-status-title" className="font-medium">
              Node status
            </h3>
            <p className="text-xs text-muted-foreground">
              Outcome and duration for every task in this run.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {nodes.map((node) => (
              <RunNodeOverview key={node.id} node={node} agents={agents} />
            ))}
          </div>
        </section>

        {run.summary ? (
          <section aria-labelledby="run-result-title">
            <div className="mb-3 flex items-center gap-2">
              <CheckCircle2 className="size-4 text-primary" />
              <h3 id="run-result-title" className="font-medium">
                Final result
              </h3>
            </div>
            <div className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-5 sm:p-6">
              <StaticAssistantMarkdown
                content={run.summary}
                className="break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              />
            </div>
          </section>
        ) : run.error ? (
          <RunErrorMessage content={run.error} />
        ) : (
          <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            The final result will appear here when the workflow completes.
          </div>
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

        <RunDisclosure
          title="Flow and execution details"
          description="Inspect the workflow graph, prompts, intermediate responses, and raw values."
        >
          {flowNodes.length > 0 && (
            <div className="mb-5 h-80 overflow-hidden rounded-xl border bg-muted/20">
              <WorkflowCanvas
                nodes={flowNodes}
                edges={flowEdges}
                disabled
                onConnect={() => undefined}
                onSelectNode={() => undefined}
                onPositionChange={() => undefined}
              />
            </div>
          )}
          <div className="flex flex-col gap-5 rounded-2xl border bg-muted/[0.12] p-3 sm:p-5">
            <RunUserMessage input={run.input} />
            {nodes.map((node) => {
              const workflowNode = workflow?.definition.nodes.find(
                (candidate) => candidate.id === node.nodeKey
              )
              return (
                <RunAgentMessage
                  key={node.id}
                  agent={agents.find((agent) => agent.id === node.agentId)}
                  events={events.filter((event) => event.nodeId === node.id)}
                  instruction={
                    workflowNode?.instruction ?? node.definition?.instruction
                  }
                  node={node}
                />
              )
            })}
          </div>
        </RunDisclosure>

        <RunDisclosure
          title="Activity log"
          description={`${activityCount} activities (${events.length} raw events) for troubleshooting and audit.`}
        >
          <RunEventLog agents={agents} events={events} nodes={nodes} />
        </RunDisclosure>
      </CardContent>
    </Card>
  )
}

function RunDisclosure({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30">
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </CollapsibleTrigger>
      {open && (
        <CollapsibleContent className="border-t p-4">
          {children}
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

function formatRunDuration(startedAt: string, finishedAt?: string | null) {
  const start = new Date(startedAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "—"
  const seconds = Math.round((end - start) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes < 60) return `${minutes}m ${remaining}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function RunUserMessage({ input }: { input: unknown }) {
  const content = runInputText(input)
  if (!content) return null

  return (
    <div className="flex justify-end">
      <div className="max-w-[min(44rem,92%)] rounded-[1.35rem] rounded-br-md border border-primary/15 bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-sm">
        <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px] font-medium text-primary-foreground/75">
          <MessageSquare className="size-3.5" />
          Run input
        </div>
        <p className="break-words whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  )
}

function RunAgentMessage({
  node,
  agent,
  instruction,
  events,
}: {
  node: AgentRunNode
  agent?: Agent
  instruction?: string
  events: AgentRunEvent[]
}) {
  const progress = events
    .filter((event) => event.eventType === "node.progress")
    .map((event) => eventText(event))
    .filter(Boolean)
    .join("")
  const output = runNodeOutputText(node.output)
  const response = output || progress
  const isWorking = ["queued", "running", "waiting_approval"].includes(
    node.status
  )

  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-primary shadow-sm ring-1 ring-border">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">
            {agent?.name ?? "Agent unavailable"}
          </span>
          <span className="text-xs text-muted-foreground">{node.nodeKey}</span>
          <Badge variant={badgeVariant(node.status)}>
            {statusLabel(node.status)}
          </Badge>
        </div>
        <div className="rounded-2xl rounded-tl-md border bg-background px-4 py-3 shadow-sm">
          {instruction && (
            <div className="mb-3 border-b pb-3">
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Instruction
              </p>
              <p className="text-sm leading-6 break-words whitespace-pre-wrap">
                {instruction}
              </p>
            </div>
          )}
          {response ? (
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {output ? "Response" : "Live response"}
              </p>
              <StaticAssistantMarkdown
                content={response}
                className="break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              />
            </div>
          ) : isWorking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="size-4 animate-pulse" />
              Agent is working…
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              This agent did not return a response.
            </p>
          )}
          {node.error && (
            <p className="mt-3 flex items-start gap-2 border-t pt-3 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="break-words whitespace-pre-wrap">
                {node.error}
              </span>
            </p>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>{events.length} activity events</span>
          <span aria-hidden="true">·</span>
          <span>attempt {node.attempt || 0}</span>
          {node.providerTaskId && <span>· remote task attached</span>}
        </div>
        <details className="group mt-2 rounded-xl border bg-muted/[0.16] px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
            Execution details
          </summary>
          <div className="mt-3 flex flex-col gap-3 border-t pt-3">
            <RunDetailValue label="Input" value={node.input} />
            <RunDetailValue label="Output" value={node.output} />
            {node.providerTaskId && (
              <div>
                <p className="mb-1 font-medium text-muted-foreground">
                  Remote task
                </p>
                <p className="font-mono text-[11px] break-all">
                  {node.providerTaskId}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {node.startedAt && (
                <span>Started {new Date(node.startedAt).toLocaleString()}</span>
              )}
              {node.finishedAt && (
                <span>
                  Finished {new Date(node.finishedAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}

function RunErrorMessage({ content }: { content: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive ring-1 ring-destructive/15">
        <CircleAlert className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-sm font-medium text-destructive">Run error</p>
        <div className="rounded-2xl rounded-tl-md border border-destructive/25 bg-destructive/[0.04] px-4 py-3 text-sm leading-6 text-destructive">
          <p className="break-words whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    </div>
  )
}

function RunEventLog({
  events,
  nodes,
  agents,
}: {
  events: AgentRunEvent[]
  nodes: AgentRunNode[]
  agents: Agent[]
}) {
  type ActivityItem =
    | { kind: "event"; event: AgentRunEvent }
    | {
        kind: "progress"
        event: AgentRunEvent
        count: number
        characters: number
      }
  const activityItems: ActivityItem[] = []
  const progressByNode = new Map<
    string,
    Extract<ActivityItem, { kind: "progress" }>
  >()
  for (const event of events) {
    if (event.eventType !== "node.progress") {
      activityItems.push({ kind: "event", event })
      continue
    }
    const key = event.nodeId ?? "run"
    const existing = progressByNode.get(key)
    const text = eventText(event)
    if (existing) {
      existing.count += 1
      existing.characters += text.length
      continue
    }
    const item: Extract<ActivityItem, { kind: "progress" }> = {
      kind: "progress",
      event,
      count: 1,
      characters: text.length,
    }
    progressByNode.set(key, item)
    activityItems.push(item)
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="run-events-title">
      <Separator />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="run-events-title"
            className="flex items-center gap-2 font-medium"
          >
            <Terminal className="size-4 text-muted-foreground" />
            Agent activity
          </h3>
          <p className="text-xs text-muted-foreground">
            Durable events replayed from this run, including progress and
            failures.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">
          {activityItems.length}
        </Badge>
      </div>
      {activityItems.length ? (
        <div className="max-h-[28rem] overflow-y-auto rounded-xl border bg-muted/[0.12] p-3">
          <div className="flex flex-col">
            {activityItems.map((item, index) => {
              const event = item.event
              const node = event.nodeId
                ? nodes.find((candidate) => candidate.id === event.nodeId)
                : undefined
              const agent = node
                ? agents.find((candidate) => candidate.id === node.agentId)
                : undefined
              return (
                <div
                  key={`${item.kind}-${event.id}`}
                  className="flex gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex w-3 shrink-0 flex-col items-center">
                    <span className="mt-1.5 size-2 rounded-full bg-primary" />
                    {index < activityItems.length - 1 && (
                      <span className="mt-1 w-px flex-1 bg-border" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 pb-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-xs font-medium">
                        {item.kind === "progress"
                          ? "Response generated"
                          : formatEventType(event.eventType)}
                      </span>
                      {agent && (
                        <span className="text-[11px] text-muted-foreground">
                          · {agent.name}
                        </span>
                      )}
                      <time className="text-[11px] text-muted-foreground">
                        {formatRunTime(event.createdAt)}
                      </time>
                    </div>
                    <p className="mt-1 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground">
                      {item.kind === "progress"
                        ? `${item.count} streaming chunks combined · ${item.characters.toLocaleString()} characters`
                        : eventText(event)}
                    </p>
                    {item.kind === "event" && (
                      <details className="group mt-1.5 text-[11px]">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
                          View event payload
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto rounded-lg border bg-background p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap">
                          {formatRunValue(event.payload)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
          No persisted activity events are available for this run yet.
        </div>
      )}
    </section>
  )
}

function RunDetailValue({ label, value }: { label: string; value: unknown }) {
  if (!hasRunValue(value)) return null
  return (
    <div>
      <p className="mb-1 font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-48 overflow-auto rounded-lg border bg-background p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap">
        {formatRunValue(value)}
      </pre>
    </div>
  )
}

function RunNodeOverview({
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
            "Agent unavailable"}{" "}
          · attempt {node.attempt || 0}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="size-3.5" />
          {node.startedAt
            ? formatRunDuration(node.startedAt, node.finishedAt)
            : "Not started"}
        </p>
        {node.providerTaskId && (
          <p className="text-[11px] break-all text-muted-foreground">
            Remote task: {node.providerTaskId}
          </p>
        )}
        {node.error && <p className="text-xs text-destructive">{node.error}</p>}
      </CardContent>
    </Card>
  )
}

function runInputText(input: unknown): string {
  const value = asRunRecord(input)
  if (value) {
    for (const key of ["text", "prompt", "task", "message", "request"]) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return value[key].trim()
      }
    }
  }
  return hasRunValue(input) ? formatRunValue(input) : ""
}

function runNodeOutputText(output: unknown): string {
  const value = asRunRecord(output)
  if (!value || !Object.keys(value).length) return ""
  if (typeof value.summary === "string" && value.summary.trim()) {
    return value.summary.trim()
  }
  const visible = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "providerTaskId")
  )
  return Object.keys(visible).length ? formatRunValue(visible) : ""
}

function eventText(event: AgentRunEvent): string {
  const payload = asRunRecord(event.payload)
  const stringValue = (...keys: string[]) => {
    for (const key of keys) {
      const candidate = payload?.[key]
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim()
      }
    }
    return ""
  }

  switch (event.eventType) {
    case "run.created":
      return `Run created from ${stringValue("sourceType") || "request"}.`
    case "run.started":
      return "Worker claimed the run and started execution."
    case "node.started":
      return "Agent started processing this node."
    case "node.progress":
      return typeof payload?.delta === "string" && payload.delta
        ? payload.delta
        : "Agent sent a progress update."
    case "tool.started":
      return `Calling ${stringValue("tool") || "MCP tool"}${stringValue("serverName") ? ` on ${stringValue("serverName")}` : ""}.`
    case "tool.completed":
      return `${stringValue("tool") || "MCP tool"} completed successfully.`
    case "tool.failed":
      return `${stringValue("tool") || "MCP tool"} failed${stringValue("error") ? `: ${stringValue("error")}` : "."}`
    case "node.completed":
      return stringValue("summary") || "Agent completed this node."
    case "node.retry":
      return `Retrying attempt ${payload?.attempt ?? ""}${stringValue("error") ? `: ${stringValue("error")}` : "."}`
    case "node.failed":
      return stringValue("error") || "Agent node failed."
    case "approval.requested":
      return `Approval requested for ${stringValue("actionType") || "an agent action"}.`
    case "approval.approved":
      return "The exact requested action was approved."
    case "approval.rejected":
      return "The requested action was rejected."
    case "approval.expired":
      return "The approval expired before the action was approved."
    case "run.completed":
      return stringValue("summary") || "Workflow completed."
    case "run.failed":
      return stringValue("error") || "Workflow failed."
    case "run.cancelled":
      return stringValue("reason") || "Workflow was cancelled."
    case "run.cancel_requested":
      return "Cancellation was requested."
    default:
      return hasRunValue(event.payload)
        ? formatRunValue(event.payload)
        : "Event recorded."
  }
}

function formatEventType(eventType: string): string {
  return eventType
    .split(".")
    .map((part) =>
      part
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase())
    )
    .join(" · ")
}

function formatRunTime(value?: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function asRunRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasRunValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return true
}

function formatRunValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    const formatted = JSON.stringify(value, null, 2)
    return formatted === undefined ? String(value) : formatted
  } catch {
    return String(value)
  }
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
