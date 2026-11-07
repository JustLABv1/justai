"use client"

import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

import {
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
  Link2,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  X,
} from "lucide-react"
import { layoutAgentGraph } from "@/lib/agent-graph-layout"
import { RunFiles } from "@/components/agent-run-files"
import { Inspector } from "@/components/panelui/inspector"
import { WorkflowEditor, WorkflowRunGraph } from "@/components/workflow-editor"
import { AgentsPanel } from "@/components/agents-directory"
import { api, resolveAPIURL } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
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
import { Alert as PuAlert } from "@/components/panelui/alert"
import { Card as PuCard } from "@/components/panelui/card"
import { Frame } from "@/components/panelui/frame"
import { Menu } from "@/components/panelui/menu"
import { Stat } from "@/components/panelui/stat"
import { Tabs as PuTabs } from "@/components/panelui/tabs"
import { Badge } from "@/components/panelui/badge"
import { Chip } from "@/components/panelui/chip"
import { Checkbox } from "@/components/panelui/checkbox"
import { Button } from "@/components/panelui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field"
import { Input } from "@/components/panelui/input"
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@/components/ui/page"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/panelui/sheet"
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
} from "@/components/panelui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/panelui/switch"
import { Textarea } from "@/components/panelui/textarea"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"

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

type GraphNode = {
  id: string
  position: { x: number; y: number }
  data: FlowNodeData
}

type DeleteTarget =
  | { kind: "agent"; item: Agent }
  | { kind: "connection"; item: AgentConnection }
  | { kind: "workflow"; item: AgentWorkflow }

type WorkflowRunInput = Record<string, string>
type WorkflowValidationTarget = "build" | "name" | null
type WorkflowValidationTone = "success" | "error" | "info"

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

const workflowTemplatesMessages: Array<{
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
):
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "info"
  | "warning" {
  if (
    ["failed", "disabled", "degraded", "expired", "rejected"].includes(status)
  )
    return "destructive"
  if (["completed", "approved", "ready", "active", "enabled"].includes(status))
    return "success"
  if (status === "running") return "info"
  if (["waiting_approval", "pending", "queued"].includes(status))
    return "warning"
  if (status === "cancelled") return "secondary"
  return "outline"
}

function statusLabel(status: string) {
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function outputFormatLabel(format: AgentWorkflowNode["outputFormat"]) {
  switch (format) {
    case "pdf":
      return "PDF file"
    case "md":
      return "Markdown file"
    case "txt":
      return "Plain text file"
    case "json":
      return "JSON file"
    case "csv":
      return "CSV file"
    case "html":
      return "HTML file"
    default:
      return "Response only"
  }
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
  const { t } = useTranslations()

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
  const [runsCursor, setRunsCursor] = useState("")
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [validating, setValidating] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [testingConnectionId, setTestingConnectionId] = useState("")
  const [updatingConnectionId, setUpdatingConnectionId] = useState("")
  const [validationMessage, setValidationMessage] = useState("")
  const [validationTarget, setValidationTarget] =
    useState<WorkflowValidationTarget>(null)
  const [validationTone, setValidationTone] =
    useState<WorkflowValidationTone>("info")
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
          api.get<{ runs: AgentRun[]; nextCursor?: string }>(
            "/api/v1/agent-runs"
          ),
          api
            .get<{ spaces: KnowledgeSpace[] }>("/api/v1/knowledge/spaces")
            .catch(() => ({ spaces: [] })),
        ])
      setConnections(connectionResult.connections ?? [])
      setWorkflows(workflowResult.workflows ?? [])
      setRuns(runResult.runs ?? [])
      setRunsCursor(runResult.nextCursor ?? "")
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

  async function saveNative(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!nativeForm.name.trim() || !nativeForm.instructions.trim() || saving) {
      setError("Name and instructions are required for a native agent.")
      return
    }
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
      notifySuccess(
        editingAgent ? "Native agent updated" : "Native agent created",
        result.agent.name
      )
      setNativeOpen(false)
    } catch (caught) {
      setError(
        notifyError(
          "Native agent could not be saved",
          caught,
          "The native agent could not be saved."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  function removeAgent(agent: Agent) {
    setDeleteTarget({ kind: "agent", item: agent })
  }

  async function discoverRemote() {
    if (!remoteForm.endpointUrl.trim() || discovering) return
    setDiscovering(true)
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
          : t("Agent Card discovery failed.")
      )
    } finally {
      setDiscovering(false)
    }
  }

  async function saveRemote(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
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
      notifySuccess(
        editingAgent ? "Remote agent updated" : "Remote agent connected",
        agent.name
      )
      if (shouldStartOAuth) {
        const oauth = await api.get<{ authorizationUrl: string }>(
          `/api/v1/agent-connections/${connection.id}/oauth/start`
        )
        window.location.assign(oauth.authorizationUrl)
      }
    } catch (caught) {
      setError(
        notifyError(
          "Remote agent could not be connected",
          caught,
          "The remote agent could not be connected."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function testConnection(connection: AgentConnection) {
    if (testingConnectionId) return
    setTestingConnectionId(connection.id)
    try {
      await api.post(`/api/v1/agent-connections/${connection.id}/test`)
      notifySuccess("Connection test passed", connection.name)
      await refresh()
    } catch (caught) {
      setError(
        notifyError(
          "Connection test failed",
          caught,
          "The connection test failed."
        )
      )
      await refresh()
    } finally {
      setTestingConnectionId("")
    }
  }

  async function toggleConnection(
    connection: AgentConnection,
    enabled: boolean
  ) {
    if (updatingConnectionId) return
    setUpdatingConnectionId(connection.id)
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
        notifyError(
          "Connection could not be updated",
          caught,
          "The connection could not be updated."
        )
      )
    } finally {
      setUpdatingConnectionId("")
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
      setValidationTarget(null)
      setValidationTone("info")
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
      setValidationTarget("build")
      setValidationTone("info")
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
    let suffix = workflowDraft.definition.nodes.length + 1
    while (
      workflowDraft.definition.nodes.some(
        (node) => node.id === `agent-${suffix}`
      )
    )
      suffix++
    const id = `agent-${suffix}`
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

  function handleConnect(connection: { source: string; target: string }) {
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
      setValidationTarget("build")
      setValidationTone("error")
      setSelectedNodeId(unassignedNode.id)
      return
    }
    const localError = validateWorkflowDefinition(workflowDraft.definition)
    if (localError) {
      setValidationMessage(localError)
      setValidationTarget("build")
      setValidationTone("error")
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
      setValidationTarget("build")
      setValidationTone("error")
      return
    }
    if (!workflowDraft.id) {
      setValidationMessage("Valid bounded DAG · ready to save")
      setValidationTarget(null)
      setValidationTone("success")
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
      setValidationTarget(result.valid ? null : "build")
      setValidationTone(result.valid ? "success" : "error")
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error
          ? caught.message
          : t("Workflow validation failed.")
      )
      setValidationTarget(null)
      setValidationTone("error")
    } finally {
      setValidating(false)
    }
  }

  async function saveWorkflow() {
    if (!workflowDraft) return
    if (!workflowDraft.name.trim()) {
      setValidationMessage(
        "A workflow name is required. Enter a name in Settings, then save again."
      )
      setValidationTarget("name")
      setValidationTone("error")
      return
    }
    const unassignedNode = workflowDraft.definition.nodes.find(
      (node) => !node.agentId
    )
    if (unassignedNode) {
      setValidationMessage(`Node ${unassignedNode.id} needs an agent.`)
      setValidationTarget("build")
      setValidationTone("error")
      setSelectedNodeId(unassignedNode.id)
      return
    }
    const localError = validateWorkflowDefinition(workflowDraft.definition)
    if (localError) {
      setValidationMessage(localError)
      setValidationTarget("build")
      setValidationTone("error")
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
      setValidationTarget("build")
      setValidationTone("error")
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
      setValidationTarget(null)
      setValidationTone("success")
    } catch (caught) {
      setValidationMessage(
        caught instanceof Error
          ? caught.message
          : t("The workflow could not be saved.")
      )
      setValidationTarget(null)
      setValidationTone("error")
    } finally {
      setSaving(false)
    }
  }

  function openRunDialog() {
    if (!workflowDraft?.id) {
      setValidationMessage("Save the workflow before running it.")
      setValidationTarget(workflowDraft?.name.trim() ? null : "name")
      setValidationTone("error")
      return
    }
    const names = workflowInputNames(workflowDraft.definition)
    setRunInput(
      Object.fromEntries(names.map((name) => [name, ""])) as WorkflowRunInput
    )
    setRunDialogOpen(true)
  }

  async function runWorkflow(
    input: WorkflowRunInput,
    event?: React.FormEvent<HTMLFormElement>
  ) {
    event?.preventDefault()
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
        notifyError(
          "Workflow could not be started",
          caught,
          "The workflow could not be started."
        )
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
      notifySuccess(
        target.kind === "agent"
          ? "Agent deleted"
          : target.kind === "connection"
            ? "Connection removed"
            : "Workflow deleted"
      )
      setDeleteTarget(null)
    } catch (caught) {
      setError(
        notifyError(
          target.kind === "agent"
            ? "Agent could not be deleted"
            : target.kind === "connection"
              ? "Connection could not be removed"
              : "Workflow could not be deleted",
          caught,
          target.kind === "agent"
            ? "The agent could not be deleted."
            : target.kind === "connection"
              ? "The connection could not be removed."
              : "The workflow could not be deleted."
        )
      )
    } finally {
      setDeleting(false)
    }
  }

  const selectedNode = workflowDraft?.definition.nodes.find(
    (node) => node.id === selectedNodeId
  )
  const graphNodes = useMemo<GraphNode[]>(() => {
    if (!workflowDraft) return []
    const layout = layoutAgentGraph(
      workflowDraft.definition.nodes.map((node) => node.id),
      workflowDraft.definition.edges
    )
    return workflowDraft.definition.nodes.map((node) => ({
      id: node.id,
      type: "agent",
      position: positions[node.id] ?? layout[node.id],
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
  const currentRunInputNames = workflowDraft
    ? workflowInputNames(workflowDraft.definition)
    : []

  const editingWorkflow = activeTab === "workflows" && workflowDraft !== null

  return (
    <Page>
      {disabled && (
        <PuAlert role="status" tone="info">
          <PuAlert.Icon>
            <ShieldCheck />
          </PuAlert.Icon>
          <PuAlert.Title>{t("Agents are disabled")}</PuAlert.Title>
          <PuAlert.Description>
            {t(
              "The platform administrator disabled new agent runs and scheduling. Existing agents, workflows, and run history remain inspectable."
            )}
          </PuAlert.Description>
        </PuAlert>
      )}
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("Agent workspace")}</PageTitle>
          <PageDescription>
            {t(
              "Manage your team of agents, design workflows, and monitor execution."
            )}
          </PageDescription>
        </PageHeading>
        <PageActions>
          {activeTab === "agents" && !disabled && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => openRemote()} variant="outline">
                <Link2 />
                {t("Connect remote")}
              </Button>
              <Button onClick={() => openNative()}>
                <Plus />
                {t("New native agent")}
              </Button>
            </div>
          )}
          {activeTab === "workflows" && !disabled && (
            <Button onClick={() => openWorkflow()}>
              <Plus />
              {t("New workflow")}
            </Button>
          )}
        </PageActions>
      </PageHeader>

      {error && (
        <PuAlert aria-live="polite" role="alert" tone="destructive">
          <PuAlert.Icon>
            <CircleAlert />
          </PuAlert.Icon>
          <PuAlert.Title>{t("Agent workspace needs attention")}</PuAlert.Title>
          <PuAlert.Description>{t(error)}</PuAlert.Description>
        </PuAlert>
      )}

      {!editingWorkflow && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              label: t("Agents"),
              value: agents.length,
              note: t("{value0} remote", {
                value0: agents.filter((agent) => agent.kind === "remote")
                  .length,
              }),
              icon: Bot,
            },
            {
              label: t("Workflows"),
              value: workflows.length,
              note: t("Reusable multi-step runs"),
              icon: GitBranch,
            },
            {
              label: t("Runs"),
              value: runs.length,
              note: t("{value0} running", {
                value0: runs.filter((run) => run.status === "running").length,
              }),
              icon: Activity,
            },
          ].map(({ label, value, note, icon: Icon }) => (
            <PuCard as="section" className="gap-0" key={label} size="sm">
              <PuCard.Content className="flex items-start justify-between gap-3">
                <Stat>
                  <Stat.Content>
                    <Stat.Label>{label}</Stat.Label>
                    <Stat.Value size="md">{value}</Stat.Value>
                    <Stat.Description>{note}</Stat.Description>
                  </Stat.Content>
                </Stat>
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </PuCard.Content>
            </PuCard>
          ))}
        </div>
      )}

      <PuTabs
        onValueChange={(value) => onTabChange(value as AgentTab)}
        value={activeTab}
      >
        <PuTabs.List
          aria-label={t("Agent workspace sections")}
          className={editingWorkflow ? "hidden" : undefined}
        >
          <PuTabs.Trigger value="agents">
            <Bot />
            {t("Agents")}
          </PuTabs.Trigger>
          <PuTabs.Trigger value="workflows">
            <GitBranch />
            {t("Workflows")}
          </PuTabs.Trigger>
          <PuTabs.Trigger value="runs">
            <Activity />
            {t("Runs")}
          </PuTabs.Trigger>
        </PuTabs.List>
        <PuTabs.Content value="agents" className="pt-1">
          {loading && !agents.length ? (
            <LoadingState label={t("Loading agents…")} />
          ) : (
            <AgentsPanel
              agents={agents}
              connections={connections}
              onEdit={openAgent}
              onDelete={removeAgent}
              onTest={testConnection}
              onToggleConnection={toggleConnection}
              onDeleteConnection={deleteConnection}
              onCreateNative={() => openNative()}
              onConnectRemote={() => openRemote()}
              testingConnectionId={testingConnectionId}
              updatingConnectionId={updatingConnectionId}
              disabled={disabled}
            />
          )}
        </PuTabs.Content>
        <PuTabs.Content value="workflows" className="pt-1">
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
            validationMessage={validationMessage}
            validationTarget={validationTarget}
            validationTone={validationTone}
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
            onValidationDismiss={() => setValidationTarget(null)}
            disabled={disabled}
          />
        </PuTabs.Content>
        <PuTabs.Content value="runs" className="pt-1">
          <RunsPanel
            nextCursor={runsCursor}
            onCursorChange={setRunsCursor}
            runs={runs}
            onRunsChange={setRuns}
            agents={agents}
            workflows={workflows}
            disabled={disabled}
          />
        </PuTabs.Content>
      </PuTabs>

      <Dialog
        open={nativeOpen}
        onOpenChange={(open) => {
          if (!saving) setNativeOpen(open)
        }}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {editingAgent ? t("Edit native agent") : t("Create native agent")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Native agents use JustAI’s configured model, memory, MCP permissions, and conversation runtime."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>{t("Could not save native agent")}</AlertTitle>
                <AlertDescription>{t(error)}</AlertDescription>
              </Alert>
            )}
            <form
              id="agent-native-form"
              onSubmit={(event) => void saveNative(event)}
            >
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="native-agent-name">
                      {t("Name")}
                    </FieldLabel>
                    <Input
                      id="native-agent-name"
                      value={nativeForm.name}
                      onChange={(event) =>
                        setNativeForm({
                          ...nativeForm,
                          name: event.target.value,
                        })
                      }
                      placeholder={t("Research lead")}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="native-agent-visibility">
                      {t("Visibility")}
                    </FieldLabel>
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
                      <SelectTrigger id="native-agent-visibility">
                        <SelectValue>
                          {t(visibilityLabel(nativeForm.visibility))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="private">
                            {t("Private")}
                          </SelectItem>
                          <SelectItem value="workspace">
                            {t("Workspace shared")}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="native-agent-description">
                    {t("Description")}
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
                    placeholder={t("What this agent is good at")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="native-agent-instructions">
                    {t("Instructions")}
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
                    placeholder={t("Act as a careful research editor…")}
                  />
                  <FieldDescription>
                    {t(
                      "These instructions are versioned. Existing conversations keep their pinned version."
                    )}
                  </FieldDescription>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="native-agent-endpoint">
                      {t("Chat endpoint")}
                    </FieldLabel>
                    <Select
                      value={nativeForm.endpointId || "default"}
                      onValueChange={(value) =>
                        setNativeForm({
                          ...nativeForm,
                          endpointId: value === "default" ? "" : (value ?? ""),
                        })
                      }
                    >
                      <SelectTrigger id="native-agent-endpoint">
                        <SelectValue>
                          {nativeForm.endpointId
                            ? (endpoints.find(
                                (endpoint) =>
                                  endpoint.id === nativeForm.endpointId
                              )?.name ?? "Selected endpoint")
                            : t("Workspace default")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="default">
                            {t("Workspace default")}
                          </SelectItem>
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
                      {t("Model override")}
                    </FieldLabel>
                    <Input
                      id="native-agent-model"
                      value={nativeForm.model}
                      onChange={(event) =>
                        setNativeForm({
                          ...nativeForm,
                          model: event.target.value,
                        })
                      }
                      placeholder={t("Use endpoint default")}
                    />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field orientation="horizontal">
                    <Switch
                      aria-label={t("Use memory")}
                      checked={nativeForm.useMemory}
                      onCheckedChange={(checked) =>
                        setNativeForm({ ...nativeForm, useMemory: checked })
                      }
                    />
                    <div>
                      <FieldLabel>{t("Use memory")}</FieldLabel>
                      <FieldDescription>
                        {t(
                          "Include the user’s approved persistent preferences."
                        )}
                      </FieldDescription>
                    </div>
                  </Field>
                  <Field orientation="horizontal">
                    <Switch
                      aria-label={t("Use deep context")}
                      checked={nativeForm.deepContext}
                      onCheckedChange={(checked) =>
                        setNativeForm({ ...nativeForm, deepContext: checked })
                      }
                    />
                    <div>
                      <FieldLabel>{t("Deep context")}</FieldLabel>
                      <FieldDescription>
                        {t("Use attached workspace context when available.")}
                      </FieldDescription>
                    </div>
                  </Field>
                </div>
                <FieldSet>
                  <FieldLegend variant="label">
                    {t("Delegation allowlist")}
                  </FieldLegend>
                  <FieldDescription>
                    {t("Only these agents may be selected by")}{" "}
                    <code>delegate_agent</code>.
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
                            <Checkbox
                              checked={nativeForm.delegationAgentIds.includes(
                                agent.id
                              )}
                              onCheckedChange={() =>
                                setNativeForm((current) => ({
                                  ...current,
                                  delegationAgentIds:
                                    current.delegationAgentIds.includes(
                                      agent.id
                                    )
                                      ? current.delegationAgentIds.filter(
                                          (id) => id !== agent.id
                                        )
                                      : [
                                          ...current.delegationAgentIds,
                                          agent.id,
                                        ],
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
                      {t("Create another agent to enable delegation.")}
                    </p>
                  )}
                </FieldSet>
              </FieldGroup>
            </form>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setNativeOpen(false)}
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                saving ||
                !nativeForm.name.trim() ||
                !nativeForm.instructions.trim()
              }
              form="agent-native-form"
              type="submit"
            >
              {saving
                ? t("Saving…")
                : editingAgent
                  ? t("Save changes")
                  : t("Create agent")}
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
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {editingAgent
                ? t("Configure A2A agent")
                : t("Connect an A2A agent")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "JustAI makes outbound A2A 1.0 HTTP+JSON/SSE calls. Credentials are encrypted and never included in cards, prompts, logs, or audit details."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>{t("Could not save remote agent")}</AlertTitle>
                <AlertDescription>{t(error)}</AlertDescription>
              </Alert>
            )}
            <form
              id="agent-remote-form"
              onSubmit={(event) => void saveRemote(event)}
            >
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="remote-agent-name">
                      {t("Display name")}
                    </FieldLabel>
                    <Input
                      id="remote-agent-name"
                      value={remoteForm.name}
                      onChange={(event) =>
                        setRemoteForm({
                          ...remoteForm,
                          name: event.target.value,
                        })
                      }
                      placeholder={t("Vendor research agent")}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="remote-agent-visibility">
                      {t("Visibility")}
                    </FieldLabel>
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
                      <SelectTrigger id="remote-agent-visibility">
                        <SelectValue>
                          {t(visibilityLabel(remoteForm.visibility))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="private">
                            {t("Private")}
                          </SelectItem>
                          <SelectItem value="workspace">
                            {t("Workspace shared")}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="remote-connection-scope">
                      {t("Connection scope")}
                    </FieldLabel>
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
                      <SelectTrigger id="remote-connection-scope">
                        <SelectValue>
                          {t(connectionScopeLabel(remoteForm.connectionScope))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="user">
                            {t("Private connection")}
                          </SelectItem>
                          <SelectItem value="organization">
                            {t("Workspace connection")}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t(
                        "Workspace agents require a workspace connection. Shared connections are managed by owners and admins."
                      )}
                    </FieldDescription>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="remote-agent-url">
                    {t("A2A endpoint URL")}
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
                      disabled={discovering || !remoteForm.endpointUrl.trim()}
                    >
                      <Cloud
                        className={discovering ? "animate-pulse" : ""}
                        data-icon="inline-start"
                      />
                      {discovering ? t("Discovering…") : t("Discover")}
                    </Button>
                  </div>
                  <FieldDescription>
                    {t(
                      "Private network targets are controlled by the backend safe-dial policy."
                    )}
                  </FieldDescription>
                </Field>
                {discoveryMessage && (
                  <Alert aria-live="polite" role="status">
                    <Cloud data-icon="inline-start" />
                    <AlertDescription>{discoveryMessage}</AlertDescription>
                  </Alert>
                )}
                <Field>
                  <FieldLabel htmlFor="remote-authentication">
                    {t("Authentication")}
                  </FieldLabel>
                  <Select
                    value={remoteForm.authType}
                    onValueChange={(value) =>
                      setRemoteForm({
                        ...remoteForm,
                        authType: (value ??
                          "none") as RemoteAgentForm["authType"],
                      })
                    }
                  >
                    <SelectTrigger id="remote-authentication">
                      <SelectValue>
                        {t(authTypeLabel(remoteForm.authType))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">
                          {t("No authentication")}
                        </SelectItem>
                        <SelectItem value="api_key">{t("API key")}</SelectItem>
                        <SelectItem value="http">
                          {t("HTTP Basic / auth header")}
                        </SelectItem>
                        <SelectItem value="oauth2">OAuth2</SelectItem>
                        <SelectItem value="oidc">OIDC</SelectItem>
                        <SelectItem value="mtls">
                          {t("mTLS certificate")}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                {remoteForm.authType === "api_key" && (
                  <Field>
                    <FieldLabel htmlFor="remote-api-key">
                      {t("API key")}
                    </FieldLabel>
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
                      <FieldLabel htmlFor="remote-username">
                        {t("Username")}
                      </FieldLabel>
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
                      <FieldLabel htmlFor="remote-password">
                        {t("Password")}
                      </FieldLabel>
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
                        {t("Client ID")}
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
                      <FieldLabel htmlFor="remote-oauth-scopes">
                        {t("Scopes")}
                      </FieldLabel>
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
                        {t("Authorization URL")}
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
                        {t("Token URL")}
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
                        {t("Client secret")}
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
                        {t("Client certificate")}
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
                        {t("Private key")}
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
                    aria-label={t("Trust read-only operations")}
                    checked={remoteForm.trustedReadOnly}
                    onCheckedChange={(checked) =>
                      setRemoteForm({ ...remoteForm, trustedReadOnly: checked })
                    }
                  />
                  <div>
                    <FieldLabel>{t("Trust read-only operations")}</FieldLabel>
                    <FieldDescription>
                      {t(
                        "Only enable this for a connection you control. Otherwise remote runs pause for approval."
                      )}
                    </FieldDescription>
                  </div>
                </Field>
              </FieldGroup>
            </form>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setRemoteOpen(false)}
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                saving ||
                !remoteForm.name.trim() ||
                !remoteForm.endpointUrl.trim()
              }
              form="agent-remote-form"
              type="submit"
            >
              <LockKeyhole data-icon="inline-start" />
              {saving
                ? editingAgent
                  ? t("Saving…")
                  : t("Connecting…")
                : editingAgent
                  ? t("Save changes")
                  : t("Save encrypted connection")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={runDialogOpen}
        onOpenChange={(open) => {
          if (!running) setRunDialogOpen(open)
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("Run workflow")}</DialogTitle>
            <DialogDescription>
              {t(
                "Provide the values declared by this workflow. They are captured with the immutable run snapshot and passed only to mapped nodes."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form
              id="agent-run-form"
              onSubmit={(event) => void runWorkflow(runInput, event)}
            >
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
                        placeholder={t("Enter a value")}
                      />
                    </Field>
                  ))}
                </FieldGroup>
              ) : (
                <Alert>
                  <ListChecks data-icon="inline-start" />
                  <AlertDescription>
                    {t(
                      "This workflow has no declared inputs. Add a “Workflow input” binding to a node if the run should accept a value."
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </form>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRunDialogOpen(false)}
              type="button"
              disabled={running}
            >
              {t("Cancel")}
            </Button>
            <Button form="agent-run-form" type="submit" disabled={running}>
              {running ? t("Starting…") : t("Start run")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={deleteTarget !== null}
        title={
          deleteTarget?.kind === "agent"
            ? t("Delete {value0}?", { value0: deleteTarget.item.name })
            : deleteTarget?.kind === "connection"
              ? t("Remove the {value0} connection?", {
                  value0: deleteTarget.item.name,
                })
              : t("Delete {value0}?", {
                  value0: deleteTarget?.item.name ?? "this workflow",
                })
        }
        description={
          deleteTarget?.kind === "agent"
            ? t(
                "Existing conversations keep their pinned agent version. New runs will no longer be able to select this agent."
              )
            : deleteTarget?.kind === "connection"
              ? t(
                  "Remote agents using this connection may stop working. This cannot be undone."
                )
              : t(
                  "Existing runs stay inspectable, but this workflow will no longer be available for new runs or schedules."
                )
        }
        confirmLabel={
          deleteTarget?.kind === "connection"
            ? t("Remove connection")
            : deleteTarget?.kind === "agent"
              ? t("Delete agent")
              : t("Delete workflow")
        }
        pending={deleting}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void confirmDelete()}
      />
    </Page>
  )
}

function LoadingState({ label }: { label: string }) {
  return (
    <Card aria-busy="true" className="border-dashed">
      <CardContent
        aria-live="polite"
        className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        <RefreshCw className="mr-2 animate-spin" data-icon="inline-start" />
        {label}
      </CardContent>
    </Card>
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
  validationMessage,
  validationTarget,
  validationTone,
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
  onValidationDismiss,
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
  graphNodes: GraphNode[]
  validationMessage: string
  validationTarget: WorkflowValidationTarget
  validationTone: WorkflowValidationTone
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
  onConnect: (connection: { source: string; target: string }) => void
  onPositionChange: (id: string, position: { x: number; y: number }) => void
  onValidate: () => void
  onSave: () => void
  onRun: () => void
  onValidationDismiss: () => void
  disabled?: boolean
}) {
  const workflowTemplates = useTranslatedConfig(workflowTemplatesMessages)

  const { t } = useTranslations()

  const [workflowQuery, setWorkflowQuery] = useState("")
  return (
    <div className={cn("grid gap-5", !draft && "grid-cols-1")}>
      {!draft && (
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-4">
            {workflows.length > 5 && (
              <Input.Group className="w-full self-end sm:w-80">
                <Input.Addon>
                  <Search aria-hidden="true" />
                </Input.Addon>
                <Input
                  aria-label={t("Search workflows")}
                  onChange={(event) => setWorkflowQuery(event.target.value)}
                  placeholder={t("Search workflows…")}
                  value={workflowQuery}
                />
              </Input.Group>
            )}
            {workflows.length === 0 ? (
              <PuCard className="border-dashed">
                <PuCard.Content className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
                  <GitBranch
                    aria-hidden="true"
                    className="size-6 text-muted-foreground"
                  />
                  <div className="grid max-w-md gap-1.5">
                    <h2 className="text-base font-semibold">
                      {t("Create a custom workflow")}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {t(
                        "Start with a node, add a second agent, connect them, and run a parallel or fan-in graph with durable progress."
                      )}
                    </p>
                  </div>
                  {!disabled && (
                    <Button onClick={() => onOpen()}>
                      <Plus />
                      {t("New workflow")}
                    </Button>
                  )}
                </PuCard.Content>
              </PuCard>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {workflows
                  .filter((workflow) =>
                    `${workflow.name} ${workflow.description}`
                      .toLowerCase()
                      .includes(workflowQuery.toLowerCase())
                  )
                  .map((workflow) => (
                    <PuCard as="article" className="h-full" key={workflow.id}>
                      <PuCard.Header>
                        <PuCard.Action>
                          <Menu>
                            <Menu.Trigger
                              render={
                                <Button
                                  aria-label={t("More actions for {value0}", {
                                    value0: workflow.name,
                                  })}
                                  disabled={disabled}
                                  size="icon-sm"
                                  variant="ghost"
                                />
                              }
                            >
                              <MoreHorizontal />
                            </Menu.Trigger>
                            <Menu.Content align="end">
                              <Menu.Item onClick={() => onOpen(workflow)}>
                                {t("Open builder")}
                              </Menu.Item>
                              <Menu.Separator />
                              <Menu.Item
                                onClick={() => onDelete(workflow)}
                                variant="destructive"
                              >
                                <Trash2 />
                                {t("Delete")}
                              </Menu.Item>
                            </Menu.Content>
                          </Menu>
                        </PuCard.Action>
                        <PuCard.Title className="truncate">
                          {workflow.name}
                        </PuCard.Title>
                        <PuCard.Description className="line-clamp-2">
                          {workflow.description || t("Reusable workflow")}
                        </PuCard.Description>
                      </PuCard.Header>
                      <PuCard.Content className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline">
                            <GitBranch />
                            {workflow.definition.nodes.length} {t("nodes")}
                          </Badge>
                          <Badge variant="secondary">
                            <Clock3 />
                            {workflowScheduleDescription(workflow.schedule)}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("Next run:")}{" "}
                          {formatWorkflowNextRun(
                            workflow.nextRunAt,
                            workflow.timezone
                          )}
                        </p>
                      </PuCard.Content>
                      <PuCard.Footer className="justify-end" variant="panel">
                        <Button
                          onClick={() => onOpen(workflow)}
                          size="sm"
                          variant="outline"
                        >
                          {t("Open builder")}
                        </Button>
                      </PuCard.Footer>
                    </PuCard>
                  ))}
              </div>
            )}
          </section>
          <Frame>
            <Frame.Header>
              <Frame.Title>{t("Start from a template")}</Frame.Title>
              <Frame.Description>
                {t("Pick a ready-made graph and adjust it in the builder.")}
              </Frame.Description>
            </Frame.Header>
            <Frame.Panel>
              {workflowTemplates.map((template) => (
                <Frame.Row
                  chevron
                  key={template.id}
                  onClick={() => onOpenTemplate(template.id)}
                >
                  <Frame.Media>
                    <Sparkles aria-hidden="true" />
                  </Frame.Media>
                  <Frame.Content>
                    <Frame.Title as="p">{template.name}</Frame.Title>
                    <Frame.Description>
                      {template.description}
                    </Frame.Description>
                  </Frame.Content>
                </Frame.Row>
              ))}
            </Frame.Panel>
          </Frame>
        </div>
      )}
      {draft ? (
        <WorkflowEditor
          canDelete={Boolean(draft.id)}
          description={draft.description}
          disabled={disabled}
          edges={draft.definition.edges}
          graphKey={draft.id || "new"}
          isNew={!draft.id}
          maxNodes={16}
          nodePanel={
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
          }
          nodes={graphNodes.map((node) => ({
            id: node.id,
            position: node.position,
            agentName: node.data.agentName,
            instruction: node.data.instruction,
            selected: Boolean(node.data.selected),
            status: node.data.status,
          }))}
          onAddNode={onAddNode}
          onAutoLayout={() => {
            const layout = layoutAgentGraph(
              draft.definition.nodes.map((node) => node.id),
              draft.definition.edges
            )
            Object.entries(layout).forEach(([id, position]) =>
              onPositionChange(id, position)
            )
          }}
          onClose={onClose}
          onConnect={onConnect}
          onDelete={() => {
            const workflow = workflows.find((item) => item.id === draft.id)
            if (workflow) onDelete(workflow)
          }}
          onPositionChange={onPositionChange}
          onRemoveEdge={(edge) =>
            onUpdate({
              definition: {
                ...draft.definition,
                edges: draft.definition.edges.filter(
                  (candidate) =>
                    candidate.from !== edge.from || candidate.to !== edge.to
                ),
              },
            })
          }
          onRun={onRun}
          onSave={onSave}
          onSelectNode={onSelectNode}
          onValidate={onValidate}
          onValidationDismiss={onValidationDismiss}
          saving={saving}
          schedulePanel={
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
          }
          settingsPanel={
            <Inspector.Section>
              <Inspector.SectionTitle>
                {t("Workflow settings")}
              </Inspector.SectionTitle>
              <Inspector.SectionContent>
                <Field data-invalid={validationTarget === "name"}>
                  <FieldLabel htmlFor="workflow-name">{t("Name")}</FieldLabel>
                  <Input
                    id="workflow-name"
                    aria-invalid={validationTarget === "name"}
                    autoFocus={validationTarget === "name"}
                    value={draft.name}
                    disabled={disabled}
                    onChange={(event) => onUpdate({ name: event.target.value })}
                    placeholder={t("Research then synthesize")}
                  />
                  {validationTarget === "name" && (
                    <FieldDescription>
                      {t(
                        "Enter a name so this workflow can be saved and found later."
                      )}
                    </FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="workflow-description">
                    {t("Description")}
                  </FieldLabel>
                  <Textarea
                    id="workflow-description"
                    minRows={2}
                    value={draft.description}
                    disabled={disabled}
                    onChange={(event) =>
                      onUpdate({ description: event.target.value })
                    }
                    placeholder={t("What this workflow produces")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="workflow-visibility">
                    {t("Visibility")}
                  </FieldLabel>
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
                    <SelectTrigger id="workflow-visibility">
                      <SelectValue>
                        {t(visibilityLabel(draft.visibility))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="private">{t("Private")}</SelectItem>
                        <SelectItem value="workspace">
                          {t("Workspace shared")}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="workflow-timezone">
                    {t("Timezone")}
                  </FieldLabel>
                  <Input
                    id="workflow-timezone"
                    value={draft.timezone}
                    disabled={disabled}
                    onChange={(event) =>
                      onUpdate({ timezone: event.target.value })
                    }
                    placeholder="Europe/Berlin"
                  />
                </Field>
              </Inspector.SectionContent>
            </Inspector.Section>
          }
          title={draft.name}
          validating={validating}
          validationMessage={validationMessage}
          validationTarget={validationTarget}
          validationTone={validationTone}
        />
      ) : null}
    </div>
  )
}

function InspectorSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t pt-3">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm font-medium">
        {title}
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 py-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
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
  const { t } = useTranslations()

  if (!node)
    return (
      <Card className="h-fit border-dashed">
        <CardContent className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
          {t(
            "Select a node to configure its agent, context, and safety policy."
          )}
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
            <CardTitle className="text-sm">{t("Node configuration")}</CardTitle>
            <CardDescription>{selectedNodeId}</CardDescription>
          </div>
          <Button
            size="icon"
            variant="ghost"
            disabled={disabled}
            onClick={onRemove}
            aria-label={t("Remove selected node")}
          >
            <X data-icon="inline-start" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`agent-${node.id}`}>{t("Agent")}</FieldLabel>
          <Select
            value={node.agentId}
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate(node.id, {
                agentId: value ?? undefined,
              })
            }
          >
            <SelectTrigger id={`agent-${node.id}`}>
              <SelectValue>
                {selectedAgent
                  ? `${agentToSavedLabel(selectedAgent)} · ${
                      selectedAgent.kind ?? "native"
                    }${
                      selectedAgent.kind === "remote" && selectedConnection
                        ? ` · ${t(connectionScopeLabel(selectedConnection.scopeType))}`
                        : ""
                    }`
                  : t("Select an agent")}
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
                        ? ` · ${t(connectionScopeLabel(connection.scopeType))}`
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
            {t("Instruction")}
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
        <Field>
          <FieldLabel htmlFor={`output-format-${node.id}`}>
            {t("Output format")}
          </FieldLabel>
          <Select
            value={node.outputFormat || "response"}
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate(node.id, {
                outputFormat: (value === "response"
                  ? ""
                  : value) as AgentWorkflowNode["outputFormat"],
              })
            }
          >
            <SelectTrigger
              aria-label={t("Output format")}
              className="w-full"
              id={`output-format-${node.id}`}
            >
              <SelectValue>
                {t(outputFormatLabel(node.outputFormat))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="response">{t("Response only")}</SelectItem>
                {["pdf", "md", "txt", "json", "csv", "html"].map((format) => (
                  <SelectItem key={format} value={format}>
                    {format.toUpperCase()} file
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            {t(
              "The final response is saved as a downloadable file. Agents can also create files when instructed."
            )}
          </FieldDescription>
        </Field>
        <InspectorSection title={t("Safety & execution")}>
          {" "}
          <div className="grid gap-3">
            <Field>
              <FieldLabel htmlFor={`approval-${node.id}`}>
                {t("Approval")}
              </FieldLabel>
              <Select
                value={node.approvalMode || "review"}
                disabled={disabled}
                onValueChange={(value) =>
                  onUpdate(node.id, { approvalMode: value ?? "review" })
                }
              >
                <SelectTrigger id={`approval-${node.id}`}>
                  <SelectValue>
                    {t(approvalModeLabel(node.approvalMode || "review"))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="read_only_auto">
                      {t("Auto trusted read-only")}
                    </SelectItem>
                    <SelectItem value="review">{t("Always review")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`max-attempts-${node.id}`}>
                {t("Max attempts")}
              </FieldLabel>
              <Input
                id={`max-attempts-${node.id}`}
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
            <FieldLabel htmlFor={`timeout-${node.id}`}>
              {t("Node timeout (seconds)")}
            </FieldLabel>
            <Input
              id={`timeout-${node.id}`}
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
        </InspectorSection>
        <InspectorSection title={t("Input & output mappings")}>
          {" "}
          <FieldSet>
            <div className="flex items-start justify-between gap-3">
              <div>
                <FieldLegend variant="label">
                  {t("Input and output mappings")}
                </FieldLegend>
                <FieldDescription>
                  {t(
                    "Give this node named values from the workflow run or a connected previous node."
                  )}
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
                {t("Add mapping")}
              </Button>
            </div>
            {inputBindings.length ? (
              <div className="flex flex-col gap-3">
                {inputBindings.map((binding, index) => {
                  const source = binding.source.trim().toLowerCase()
                  return (
                    <div
                      key={`${node.id}-binding-${index}`}
                      className="rounded-xl bg-muted/50 p-3"
                    >
                      <div className="grid gap-3">
                        <Field>
                          <FieldLabel
                            htmlFor={`binding-name-${node.id}-${index}`}
                          >
                            {t("Name")}
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
                          <FieldLabel
                            htmlFor={`binding-source-${node.id}-${index}`}
                          >
                            {t("Source")}
                          </FieldLabel>
                          <Select
                            value={source === "node" ? "node" : "input"}
                            disabled={disabled}
                            onValueChange={(value) =>
                              updateBinding(index, {
                                source: value === "node" ? "node" : "input",
                                nodeId:
                                  value === "node" ? binding.nodeId : undefined,
                                path:
                                  value === "node" ? binding.path : undefined,
                              })
                            }
                          >
                            <SelectTrigger
                              id={`binding-source-${node.id}-${index}`}
                            >
                              <SelectValue>
                                {source === "node"
                                  ? t("Previous output")
                                  : t("Workflow input")}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="input">
                                  {t("Workflow input")}
                                </SelectItem>
                                <SelectItem value="node">
                                  {t("Previous output")}
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
                          aria-label={t("Remove {value0} mapping", {
                            value0: binding.name || "input",
                          })}
                        >
                          <X data-icon="inline-start" />
                        </Button>
                      </div>
                      {source === "node" && (
                        <div className="mt-3 grid gap-3">
                          <Field>
                            <FieldLabel
                              htmlFor={`binding-node-${node.id}-${index}`}
                            >
                              {t("Previous node")}
                            </FieldLabel>
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
                              <SelectTrigger
                                id={`binding-node-${node.id}-${index}`}
                              >
                                <SelectValue>
                                  {otherNodes.find(
                                    (candidate) =>
                                      candidate.id === binding.nodeId
                                  )?.id ?? t("Choose a connected node")}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="none">
                                    {t("Choose a connected node")}
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
                              {t("Output path (optional)")}
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
                {t(
                  "No mappings yet. Nodes receive the workflow context by default."
                )}
              </p>
            )}
          </FieldSet>
        </InspectorSection>
        <InspectorSection title={t("Context & permissions")}>
          {" "}
          <FieldSet>
            <FieldLegend variant="label">
              {t("Delegation allowlist")}
            </FieldLegend>
            <FieldDescription>
              {t(
                "These agents may be selected by this node when it delegates work."
              )}
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
                      <Checkbox
                        checked={
                          node.delegationAgentIds?.includes(agent.id) ?? false
                        }
                        disabled={disabled}
                        onCheckedChange={() => {
                          const current = node.delegationAgentIds ?? []
                          onUpdate(node.id, {
                            delegationAgentIds: current.includes(agent.id)
                              ? current.filter((id) => id !== agent.id)
                              : [...current, agent.id],
                          })
                        }}
                      />
                      <span className="truncate">{agent.name}</span>
                      <span className="text-muted-foreground">
                        {agent.kind}
                      </span>
                    </label>
                  ))
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("Add another agent to enable delegation.")}
                </span>
              )}
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">{t("MCP grants")}</FieldLegend>
            <FieldDescription>
              {t(
                "Only selected servers and tools enter this node’s immutable context scope."
              )}
            </FieldDescription>
            <div className="flex max-h-32 flex-col gap-2 overflow-y-auto">
              {mcpServers.length ? (
                mcpServers.map((server) => (
                  <label
                    key={server.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Checkbox
                      checked={
                        context.mcpServerIds?.includes(server.id) ?? false
                      }
                      disabled={disabled}
                      onCheckedChange={() => {
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
                  {t("No MCP servers connected.")}
                </span>
              )}
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">
              {t("Storage folder grants")}
            </FieldLegend>
            <FieldDescription>
              {t(
                "Every run reads the current contents of the selected folder and all of its subfolders. The resolved files are frozen in the run snapshot for auditability."
              )}
            </FieldDescription>
            <div className="flex max-h-32 flex-col gap-2 overflow-y-auto">
              {knowledgeSpaces.length ? (
                knowledgeSpaces.map((space) => (
                  <label
                    key={space.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Checkbox
                      checked={
                        context.knowledgeSpaceIds?.includes(space.id) ?? false
                      }
                      disabled={disabled}
                      onCheckedChange={() => {
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
                  {t("Create a folder in Storage first.")}
                </span>
              )}
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">
              {t("Individual file grants")}
            </FieldLegend>
            <div className="flex max-h-24 flex-col gap-2 overflow-y-auto">
              {knowledgeSources.length ? (
                knowledgeSources.map((source) => (
                  <label
                    key={source.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Checkbox
                      checked={
                        context.knowledgeSourceIds?.includes(source.id) ?? false
                      }
                      disabled={disabled}
                      onCheckedChange={() => {
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
                  {t("No knowledge sources available.")}
                </span>
              )}
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">
              {t("Additional context references")}
            </FieldLegend>
            <FieldDescription>
              {t(
                "Optional comma-separated IDs or tool names. Access is evaluated at run time and remains scoped to this node."
              )}
            </FieldDescription>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`repositories-${node.id}`}>
                  {t("Repository IDs")}
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
                <FieldLabel htmlFor={`notes-${node.id}`}>
                  {t("Note IDs")}
                </FieldLabel>
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
                  {t("Transcription session IDs")}
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
                  {t("MCP tool names")}
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
        </InspectorSection>{" "}
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
  const { t } = useTranslations()

  const kind = schedule.kind || "manual"
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-muted/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{t("Schedule")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Daily, weekly, and monthly recurrence use the workflow timezone."
            )}
          </p>
        </div>
        <Field orientation="horizontal">
          <Switch
            aria-label={t("Enable schedule")}
            id="schedule-enabled"
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
          />
          <FieldLabel htmlFor="schedule-enabled">{t("Enabled")}</FieldLabel>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field>
          <FieldLabel htmlFor="schedule-recurrence">
            {t("Recurrence")}
          </FieldLabel>
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
            <SelectTrigger id="schedule-recurrence">
              <SelectValue>{t(scheduleKindLabel(kind))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="manual">{t("Manual only")}</SelectItem>
                <SelectItem value="daily">{t("Daily")}</SelectItem>
                <SelectItem value="weekly">{t("Weekly")}</SelectItem>
                <SelectItem value="monthly">{t("Monthly")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {kind !== "manual" && (
          <>
            <Field>
              <FieldLabel htmlFor="schedule-interval">{t("Every")}</FieldLabel>
              <Input
                id="schedule-interval"
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
                <FieldLabel htmlFor="schedule-weekday">
                  {t("Weekday")}
                </FieldLabel>
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
                  <SelectTrigger id="schedule-weekday">
                    <SelectValue>{weekdayLabel(schedule.weekday)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[
                        t("Sunday"),
                        t("Monday"),
                        t("Tuesday"),
                        t("Wednesday"),
                        t("Thursday"),
                        t("Friday"),
                        t("Saturday"),
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
                <FieldLabel htmlFor="schedule-day-of-month">
                  {t("Day of month")}
                </FieldLabel>
                <Input
                  id="schedule-day-of-month"
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
              <FieldLabel htmlFor="schedule-time">{t("Time")}</FieldLabel>
              <Input
                id="schedule-time"
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
          {t("Next run:")} {formatWorkflowNextRun(nextRunAt, timezone)}
        </p>
      </div>
    </section>
  )
}

function RunsPanel({
  nextCursor,
  onCursorChange,
  runs,
  onRunsChange,
  agents,
  workflows,
  disabled = false,
}: {
  nextCursor: string
  onCursorChange: (cursor: string) => void
  runs: AgentRun[]
  onRunsChange: (runs: AgentRun[]) => void
  agents: Agent[]
  workflows: AgentWorkflow[]
  disabled?: boolean
}) {
  const { t } = useTranslations()

  const [selectedID, setSelectedID] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const requested = new URLSearchParams(window.location.search).get("run")
      if (requested) return requested
    }
    return runs[0]?.id ?? null
  })
  const [page, setPage] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [showDetail, setShowDetail] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("run")
  )
  const [detail, setDetail] = useState<AgentRun | null>(null)
  const [events, setEvents] = useState<AgentRunEvent[]>([])
  const [error, setError] = useState("")
  const [deleteRunTarget, setDeleteRunTarget] = useState<AgentRun | null>(null)
  const [deletingRun, setDeletingRun] = useState(false)
  const selectedIDRef = useRef(selectedID)
  const runsRef = useRef(runs)
  const onRunsChangeRef = useRef(onRunsChange)
  const runStatusRef = useRef<string | undefined>(undefined)
  const selectedSummary = runs.find((run) => run.id === selectedID)
  const selectedRunStatus = detail?.status ?? selectedSummary?.status

  useEffect(() => {
    if (showDetail && selectedID) updateAgentRunURL(selectedID)
  }, [selectedID, showDetail])

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

  useEffect(() => {
    selectedIDRef.current = selectedID
  }, [selectedID])

  const reload = useCallback(async (id: string) => {
    try {
      const result = await api.get<{ run: AgentRun }>(
        `/api/v1/agent-runs/${id}`
      )
      if (selectedIDRef.current !== id) return
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
    if (!selectedID || !showDetail) return
    const timer = window.setTimeout(() => void reload(selectedID), 0)
    return () => window.clearTimeout(timer)
  }, [reload, selectedID, showDetail])

  useEffect(() => {
    if (!selectedID || !showDetail) return
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
  }, [appendEvent, reload, selectedID, showDetail])

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

  async function deleteRun() {
    if (!deleteRunTarget || deletingRun) return
    setDeletingRun(true)
    setError("")
    try {
      await api.delete(`/api/v1/agent-runs/${deleteRunTarget.id}`)
      const remaining = runsRef.current.filter(
        (run) => run.id !== deleteRunTarget.id
      )
      onRunsChange(remaining)
      if (selectedID === deleteRunTarget.id) {
        selectedIDRef.current = null
        setSelectedID(null)
        setDetail(null)
        setEvents([])
        setShowDetail(false)
        updateAgentRunURL()
      }
      setDeleteRunTarget(null)
      notifySuccess("Run deleted")
    } catch (caught) {
      setError(
        notifyError(
          "Run could not be deleted",
          caught,
          "The run could not be deleted."
        )
      )
    } finally {
      setDeletingRun(false)
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
    setShowDetail(true)
    if (id === selectedID) return
    selectedIDRef.current = id
    setError("")
    setDetail(null)
    setEvents([])
    setSelectedID(id)
    updateAgentRunURL(id)
  }

  async function loadOlderRuns() {
    if (!nextCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const result = await api.get<{ runs: AgentRun[]; nextCursor?: string }>(
        `/api/v1/agent-runs?cursor=${encodeURIComponent(nextCursor)}`
      )
      const existing = new Set(runsRef.current.map((run) => run.id))
      onRunsChange([
        ...runsRef.current,
        ...result.runs.filter((run) => !existing.has(run.id)),
      ])
      onCursorChange(result.nextCursor ?? "")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Older runs could not be loaded."
      )
    } finally {
      setLoadingOlder(false)
    }
  }

  const runName = (run: AgentRun) =>
    workflows.find((workflow) => workflow.id === run.workflowId)?.name ??
    (run.sourceType === "chat" ? t("Chat delegation") : t("Agent run"))
  const filteredRuns = [...runs]
    .filter(
      (run) =>
        (statusFilter === "all" || run.status === statusFilter) &&
        `${runName(run)} ${run.id} ${run.summary ?? ""} ${run.error ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase())
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const pageCount = Math.max(1, Math.ceil(filteredRuns.length / 25))
  const currentPage = Math.min(page, pageCount - 1)
  const pageRuns = filteredRuns.slice(currentPage * 25, (currentPage + 1) * 25)
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Input.Group className="w-full sm:w-80">
          <Input.Addon>
            <Search aria-hidden="true" />
          </Input.Addon>
          <Input
            aria-label={t("Search runs")}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
            placeholder={t("Search workflows, run IDs, or results…")}
            value={query}
          />
        </Input.Group>
        <Chip.Group
          aria-label={t("Filter run status")}
          multiple={false}
          onValueChange={(value) => {
            setStatusFilter((value[0] as string | undefined) ?? "all")
            setPage(0)
          }}
          value={[statusFilter]}
        >
          {["all", ...[...new Set(runs.map((run) => run.status))].sort()].map(
            (status) => {
              const count =
                status === "all"
                  ? runs.length
                  : runs.filter((run) => run.status === status).length
              const tone = badgeVariant(status)
              return (
                <Chip
                  color={
                    tone === "success" ||
                    tone === "info" ||
                    tone === "warning" ||
                    tone === "destructive"
                      ? tone
                      : "primary"
                  }
                  key={status}
                  size="sm"
                  value={status}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {status !== "all" && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 rounded-full bg-muted-foreground",
                          tone === "success" && "bg-success",
                          tone === "info" && "bg-info",
                          tone === "warning" && "bg-warning",
                          tone === "destructive" && "bg-destructive"
                        )}
                      />
                    )}
                    {status === "all" ? t("All statuses") : statusLabel(status)}
                    <span className="text-muted-foreground tabular-nums">
                      {count}
                    </span>
                  </span>
                </Chip>
              )
            }
          )}
        </Chip.Group>
      </div>
      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Run history")}</Frame.Title>
          <Frame.Description>
            {t("Track execution, investigate failures, and review approvals.")}
          </Frame.Description>
          <Frame.Action>
            {filteredRuns.length} {t("of")} {runs.length}
          </Frame.Action>
        </Frame.Header>
        <Frame.Panel>
          {pageRuns.length === 0 ? (
            <Frame.Row>
              <Frame.Content className="flex flex-col items-center gap-2 py-10 text-center">
                <span className="rounded-full bg-muted p-3 text-muted-foreground">
                  <Activity aria-hidden="true" className="size-5" />
                </span>
                <Frame.Title as="p">
                  {runs.length
                    ? t("No runs match your search.")
                    : t("No runs yet")}
                </Frame.Title>
                {!runs.length && (
                  <Frame.Description className="max-w-xs">
                    {t(
                      "Run a workflow or delegate from chat and progress will appear here."
                    )}
                  </Frame.Description>
                )}
              </Frame.Content>
            </Frame.Row>
          ) : (
            pageRuns.map((run) => {
              const active = ["queued", "running", "waiting_approval"].includes(
                run.status
              )
              return (
                <Frame.Row
                  data-state={
                    showDetail && selectedID === run.id ? "selected" : undefined
                  }
                  key={run.id}
                >
                  <Frame.Media>
                    <Activity aria-hidden="true" />
                  </Frame.Media>
                  <Frame.Content>
                    <button
                      className="w-fit cursor-pointer text-start text-sm font-medium hover:underline"
                      onClick={() => selectRun(run.id)}
                      type="button"
                    >
                      {runName(run)}
                    </button>
                    <Frame.Description className="truncate">
                      {run.error || run.summary || run.id.slice(0, 12)}
                    </Frame.Description>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      {run.sourceType} · {formatRunTime(run.createdAt)} ·{" "}
                      {formatRunDuration(run.startedAt, run.finishedAt)}
                    </p>
                  </Frame.Content>
                  <Frame.Actions>
                    <Badge dot variant={badgeVariant(run.status)}>
                      {statusLabel(run.status)}
                    </Badge>
                    <Menu>
                      <Menu.Trigger
                        render={
                          <Button
                            aria-label={t("More actions for {value0}", {
                              value0: runName(run),
                            })}
                            size="icon-sm"
                            variant="ghost"
                          />
                        }
                      >
                        <MoreHorizontal />
                      </Menu.Trigger>
                      <Menu.Content align="end">
                        <Menu.Item onClick={() => selectRun(run.id)}>
                          {t("Run details")}
                        </Menu.Item>
                        <Menu.Separator />
                        <Menu.Item
                          disabled={disabled || active}
                          onClick={() => setDeleteRunTarget(run)}
                          variant="destructive"
                        >
                          <Trash2 />
                          {active
                            ? t("Cancel this run before deleting it")
                            : t("Delete run")}
                        </Menu.Item>
                      </Menu.Content>
                    </Menu>
                  </Frame.Actions>
                </Frame.Row>
              )
            })
          )}
        </Frame.Panel>
        {(pageCount > 1 || nextCursor) && (
          <Frame.Footer>
            <nav
              aria-label={t("Run history pagination")}
              className="flex w-full flex-wrap items-center justify-between gap-3"
            >
              <span
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {currentPage * 25 + 1}–
                {Math.min((currentPage + 1) * 25, filteredRuns.length)}{" "}
                {t("of")} {filteredRuns.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t("Previous")}
                </Button>
                <span className="text-xs">
                  {t("Page")} {currentPage + 1} {t("of")} {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t("Next")}
                </Button>
                {nextCursor && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingOlder}
                    onClick={() => void loadOlderRuns()}
                  >
                    {loadingOlder ? t("Loading…") : t("Load older runs")}
                  </Button>
                )}
              </div>
            </nav>
          </Frame.Footer>
        )}
      </Frame>
      <Sheet
        open={showDetail}
        side="right"
        onOpenChange={(open) => {
          setShowDetail(open)
          if (!open) updateAgentRunURL()
        }}
      >
        <SheetContent className="w-[min(56rem,calc(100vw-2*var(--sheet-gap)))]!">
          <SheetHeader className="shrink-0 border-b pr-12">
            <SheetTitle>{t("Run details")}</SheetTitle>
            <SheetDescription>
              {t(
                "Execution, results, and approvals. Your place in the run history is preserved."
              )}
            </SheetDescription>
          </SheetHeader>
          <div
            key={selectedID}
            className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{t(error)}</AlertDescription>
              </Alert>
            )}
            {showDetail && (detail || selectedSummary) ? (
              <RunDetail
                run={detail ?? selectedSummary!}
                agents={agents}
                workflow={selectedWorkflow}
                events={events}
                onCancel={() => void cancelRun()}
                onRetry={() => void retryRun()}
                onDelete={() => setDeleteRunTarget(detail ?? selectedSummary!)}
                onDecision={(approval, decision) =>
                  void decide(approval, decision)
                }
                disabled={disabled}
              />
            ) : showDetail ? (
              <Card className="border-dashed">
                <CardContent className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
                  {t("Loading run details…")}
                </CardContent>
              </Card>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmActionDialog
        open={deleteRunTarget !== null}
        title={t("Delete this run?")}
        description={t(
          "This permanently removes the run, its execution events, approvals, and generated artifacts. This cannot be undone."
        )}
        confirmLabel={t("Delete run")}
        pending={deletingRun}
        onOpenChange={(open) => {
          if (!open && !deletingRun) setDeleteRunTarget(null)
        }}
        onConfirm={deleteRun}
      />
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
  onDelete,
  onDecision,
  disabled = false,
}: {
  run: AgentRun
  agents: Agent[]
  workflow?: AgentWorkflow
  events: AgentRunEvent[]
  onCancel: () => void
  onRetry: () => void
  onDelete: () => void
  onDecision: (
    approval: AgentApproval,
    decision: "approved" | "rejected"
  ) => void
  disabled?: boolean
}) {
  const { t, locale } = useTranslations()

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
  const runLayout = layoutAgentGraph(
    nodes.map((node) => node.nodeKey),
    workflow?.definition.edges ?? []
  )
  const flowNodes: GraphNode[] = nodes.map((node) => ({
    id: node.nodeKey,
    position: runLayout[node.nodeKey],
    data: {
      label: node.nodeKey,
      agentName: agentToSavedLabel(
        agents.find((agent) => agent.id === node.agentId)
      ),
      instruction: node.definition?.instruction ?? "",
      status: node.status,
    },
  }))
  const flowEdges =
    workflow?.definition.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
    })) ?? []

  const active = ["queued", "running", "waiting_approval"].includes(run.status)
  const health = failed
    ? t("{value0} failed", { value0: failed })
    : completed === nodes.length && nodes.length
      ? t("All successful")
      : t("In progress")

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Activity
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            {workflow?.name ?? "Workflow run"}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge dot variant={badgeVariant(run.status)}>
              {statusLabel(run.status)}
            </Badge>
            <span>{new Date(run.startedAt).toLocaleString(locale)}</span>
            <span aria-hidden="true">·</span>
            <span>{run.sourceType}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {active && (
            <Button
              size="sm"
              variant="outline"
              onClick={onCancel}
              disabled={disabled}
            >
              <X data-icon="inline-start" />
              {t("Cancel")}
            </Button>
          )}
          {["failed", "cancelled"].includes(run.status) && (
            <Button size="sm" onClick={onRetry} disabled={disabled}>
              <RotateCcw data-icon="inline-start" />
              {t("Retry")}
            </Button>
          )}
          <Menu>
            <Menu.Trigger
              render={
                <Button
                  aria-label={t("More actions for {value0}", {
                    value0: workflow?.name ?? "Workflow run",
                  })}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontal />
            </Menu.Trigger>
            <Menu.Content align="end">
              {run.conversationId && (
                <Menu.Item render={<a href={`/${run.conversationId}`} />}>
                  <MessageLink />
                  {t("Open conversation")}
                </Menu.Item>
              )}
              <Menu.Separator />
              <Menu.Item
                disabled={disabled || active}
                onClick={onDelete}
                variant="destructive"
              >
                <Trash2 />
                {active
                  ? t("Cancel this run before deleting it")
                  : t("Delete run")}
              </Menu.Item>
            </Menu.Content>
          </Menu>
        </div>
      </header>

      <PuCard size="sm">
        <PuCard.Content className="flex flex-col gap-3">
          <section
            aria-label={t("Run summary")}
            className="grid grid-cols-3 gap-6"
          >
            <Stat>
              <Stat.Content>
                <Stat.Label>{t("Nodes successful")}</Stat.Label>
                <Stat.Value size="sm" className="text-base">
                  {completed}/{nodes.length || 1}
                </Stat.Value>
              </Stat.Content>
            </Stat>
            <Stat>
              <Stat.Content>
                <Stat.Label>{t("Duration")}</Stat.Label>
                <Stat.Value size="sm" className="text-base">
                  {duration}
                </Stat.Value>
              </Stat.Content>
            </Stat>
            <Stat>
              <Stat.Content>
                <Stat.Label>{t("Health")}</Stat.Label>
                <Stat.Value size="sm" className="text-base">
                  {health}
                </Stat.Value>
              </Stat.Content>
            </Stat>
          </section>
          <Progress
            value={nodes.length ? (completed / nodes.length) * 100 : 0}
          />
        </PuCard.Content>
      </PuCard>

      {pendingApprovals.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="font-medium">{t("Approvals required")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "The action hash is checked server-side before the decision is accepted."
              )}
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

      {run.summary ? (
        <PuCard>
          <PuCard.Header>
            <PuCard.Title className="flex items-center gap-2">
              <CheckCircle2
                aria-hidden="true"
                className="size-4 text-primary"
              />
              {t("Final result")}
            </PuCard.Title>
          </PuCard.Header>
          <PuCard.Content>
            <StaticAssistantMarkdown
              content={run.summary}
              className="break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </PuCard.Content>
        </PuCard>
      ) : run.error ? (
        <RunErrorMessage content={run.error} />
      ) : (
        <PuAlert tone="info">
          <PuAlert.Description>
            {t(
              "The final result will appear here when the workflow completes."
            )}
          </PuAlert.Description>
        </PuAlert>
      )}

      <RunFiles run={run} />

      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Node status")}</Frame.Title>
          <Frame.Description>
            {t("Outcome and duration for every task in this run.")}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel>
          {nodes.map((node) => (
            <RunNodeOverview key={node.id} node={node} agents={agents} />
          ))}
        </Frame.Panel>
      </Frame>

      <RunDisclosure
        title={t("Flow and execution details")}
        description={t(
          "Inspect the workflow graph, prompts, intermediate responses, and raw values."
        )}
      >
        {flowNodes.length > 0 && (
          <div className="mb-5 h-80 overflow-hidden rounded-xl bg-muted/50">
            <WorkflowRunGraph
              nodes={flowNodes.map((node) => ({
                id: node.id,
                position: node.position,
                agentName: node.data.agentName,
                instruction: node.data.instruction,
                selected: false,
                status: node.data.status,
              }))}
              edges={flowEdges}
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
        title={t("Activity log")}
        description={t(
          "{value0} activities ({value1} raw events) for troubleshooting and audit.",
          { value0: activityCount, value1: events.length }
        )}
      >
        <RunEventLog agents={agents} events={events} nodes={nodes} />
      </RunDisclosure>
    </div>
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
  const { t } = useTranslations()

  const content = runInputText(input)
  if (!content) return null

  return (
    <div className="flex justify-end">
      <div className="max-w-[min(44rem,92%)] rounded-[1.35rem] rounded-br-md border border-primary/15 bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-sm">
        <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px] font-medium text-primary-foreground/75">
          <MessageSquare className="size-3.5" />
          {t("Run input")}
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
  const { t, locale } = useTranslations()

  const progress = events
    .filter((event) => event.eventType === "node.progress")
    .map((event) => t(eventText(event)))
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
                {t("Instruction")}
              </p>
              <p className="text-sm leading-6 break-words whitespace-pre-wrap">
                {instruction}
              </p>
            </div>
          )}
          {response ? (
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {output ? t("Response") : t("Live response")}
              </p>
              <StaticAssistantMarkdown
                content={response}
                className="break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              />
            </div>
          ) : isWorking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="size-4 animate-pulse" />
              {t("Agent is working…")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("This agent did not return a response.")}
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
          <span>
            {events.length} {t("activity events")}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {t("attempt")} {node.attempt || 0}
          </span>
          {node.providerTaskId && <span>{t("· remote task attached")}</span>}
        </div>
        <details className="group mt-2 rounded-xl border bg-muted/[0.16] px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
            {t("Execution details")}
          </summary>
          <div className="mt-3 flex flex-col gap-3 border-t pt-3">
            <RunDetailValue label={t("Input")} value={node.input} />
            <RunDetailValue label={t("Output")} value={node.output} />
            {node.providerTaskId && (
              <div>
                <p className="mb-1 font-medium text-muted-foreground">
                  {t("Remote task")}
                </p>
                <p className="font-mono text-[11px] break-all">
                  {node.providerTaskId}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {node.startedAt && (
                <span>
                  {t("Started")}{" "}
                  {new Date(node.startedAt).toLocaleString(locale)}
                </span>
              )}
              {node.finishedAt && (
                <span>
                  {t("Finished")}{" "}
                  {new Date(node.finishedAt).toLocaleString(locale)}
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
  const { t } = useTranslations()

  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive ring-1 ring-destructive/15">
        <CircleAlert className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-sm font-medium text-destructive">
          {t("Run error")}
        </p>
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
  const { t, locale } = useTranslations()

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
    const text = t(eventText(event))
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
            {t("Agent activity")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Durable events replayed from this run, including progress and failures."
            )}
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
                          ? t("Response generated")
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
                        ? t(
                            "{value0} streaming chunks combined · {value1} characters",
                            {
                              value0: item.count,
                              value1: item.characters.toLocaleString(locale),
                            }
                          )
                        : t(eventText(event))}
                    </p>
                    {item.kind === "event" && (
                      <details className="group mt-1.5 text-[11px]">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
                          {t("View event payload")}
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
          {t("No persisted activity events are available for this run yet.")}
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
  const { t } = useTranslations()

  return (
    <Frame.Row>
      <Frame.Media>
        <Bot aria-hidden="true" />
      </Frame.Media>
      <Frame.Content>
        <Frame.Title as="p">{node.nodeKey}</Frame.Title>
        <Frame.Description>
          {agents.find((agent) => agent.id === node.agentId)?.name ??
            "Agent unavailable"}{" "}
          {t("· attempt")} {node.attempt || 0} ·{" "}
          {node.startedAt
            ? formatRunDuration(node.startedAt, node.finishedAt)
            : t("Not started")}
        </Frame.Description>
        {node.providerTaskId && (
          <p className="text-[11px] break-all text-muted-foreground">
            {t("Remote task:")} {node.providerTaskId}
          </p>
        )}
        {node.error && <p className="text-xs text-destructive">{node.error}</p>}
      </Frame.Content>
      <Frame.Actions>
        <Badge dot variant={badgeVariant(node.status)}>
          {statusLabel(node.status)}
        </Badge>
      </Frame.Actions>
    </Frame.Row>
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
  const { t, locale } = useTranslations()

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 text-primary" />
          <div className="min-w-0">
            <p className="font-medium">{statusLabel(approval.actionType)}</p>
            <p className="text-xs text-muted-foreground">
              {t("Expires")}{" "}
              {new Date(approval.expiresAt).toLocaleString(locale)}
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
            {t("Reject")}
          </Button>
          <Button size="sm" onClick={() => onDecision(approval, "approved")}>
            <Check data-icon="inline-start" />
            {t("Approve exact action")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MessageLink() {
  const { t } = useTranslations()

  return (
    <span className="inline-flex items-center gap-1">
      <UserRound data-icon="inline-start" />
      {t("Open chat")}
    </span>
  )
}
