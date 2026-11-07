"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  GitBranch,
  ListChecks,
  LayoutGrid,
  Maximize2,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
  X,
  SlidersHorizontal,
} from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Alert } from "@/components/panelui/alert"
import { Badge, type BadgeProps } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Flow } from "@/components/panelui/flow"
import { Inspector } from "@/components/panelui/inspector"
import { Menu } from "@/components/panelui/menu"
import { Spinner } from "@/components/panelui/spinner"
import { Toolbar } from "@/components/panelui/toolbar"
import { Workbench, useWorkbench } from "@/components/panelui/workbench"

export type EditorNode = {
  id: string
  position: { x: number; y: number }
  agentName: string
  instruction: string
  selected: boolean
  status?: string
}

export type EditorEdge = { from: string; to: string }

type InspectorPage = "node" | "connections" | "workflow" | "schedule"

function statusVariant(status: string): BadgeProps["variant"] {
  if (["failed", "cancelled", "rejected"].includes(status)) return "destructive"
  if (["completed", "approved"].includes(status)) return "success"
  if (["running", "waiting_approval", "pending", "queued"].includes(status))
    return "info"
  return "secondary"
}

function InspectorAutoOpen({ selectedId }: { selectedId: string }) {
  const { compact, setInspectorOpen } = useWorkbench()
  const previous = useRef(selectedId)
  useEffect(() => {
    if (previous.current !== selectedId && selectedId && compact)
      setInspectorOpen(true)
    previous.current = selectedId
  }, [selectedId, compact, setInspectorOpen])
  return null
}

function FocusButton() {
  const { t } = useTranslations()
  const { focus, setFocus } = useWorkbench()
  return (
    <Toolbar.Button
      label={focus ? t("Show panels") : t("Focus on the graph")}
      onClick={() => setFocus(!focus)}
      shortcut="\"
    >
      <Maximize2 />
    </Toolbar.Button>
  )
}

/**
 * The workflow builder: a header with the actions, then a Workbench with the
 * graph on a canvas, a floating toolbar over it and an inspector beside it.
 * What the inspector pages hold is passed in, so this file only lays out.
 */
export function WorkflowEditor({
  title,
  description,
  isNew,
  nodes,
  edges,
  graphKey,
  disabled,
  saving,
  validating,
  canDelete,
  validationMessage,
  validationTone,
  validationTarget,
  maxNodes,
  nodePanel,
  settingsPanel,
  schedulePanel,
  onClose,
  onDelete,
  onValidate,
  onSave,
  onRun,
  onAddNode,
  onAutoLayout,
  onSelectNode,
  onConnect,
  onPositionChange,
  onRemoveEdge,
  onValidationDismiss,
}: {
  title: string
  description: string
  isNew: boolean
  nodes: EditorNode[]
  edges: EditorEdge[]
  graphKey: string
  disabled: boolean
  saving: boolean
  validating: boolean
  canDelete: boolean
  validationMessage: string
  validationTone: "error" | "success" | "info"
  validationTarget: string | null
  maxNodes: number
  nodePanel: ReactNode
  settingsPanel: ReactNode
  schedulePanel: ReactNode
  onClose: () => void
  onDelete: () => void
  onValidate: () => void
  onSave: () => void
  onRun: () => void
  onAddNode: () => void
  onAutoLayout: () => void
  onSelectNode: (id: string) => void
  onConnect: (connection: { source: string; target: string }) => void
  onPositionChange: (id: string, position: { x: number; y: number }) => void
  onRemoveEdge: (edge: EditorEdge) => void
  onValidationDismiss: () => void
}) {
  const { t } = useTranslations()
  const [page, setPage] = useState<InspectorPage>("node")
  // The workbench grows its columns in for half a second; the graph is fitted
  // to its box once that has settled.
  const [settled, setSettled] = useState(0)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(1), 650)
    return () => window.clearTimeout(timer)
  }, [])
  // A validation problem points at the page that holds the fix.
  const openPage: InspectorPage = validationTarget
    ? validationTarget === "name"
      ? "workflow"
      : "node"
    : page

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button
            className="-ms-2 mb-1"
            onClick={onClose}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ChevronLeft />
            {t("Workflows")}
          </Button>
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight">
              {title || (isNew ? t("New workflow") : t("Edit workflow"))}
            </h2>
            {isNew && <Badge variant="secondary">{t("Draft")}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {description ||
              t("Design the flow, configure each step, then validate and run.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canDelete && (
            <Menu>
              <Menu.Trigger
                render={
                  <Button
                    aria-label={t("More actions")}
                    disabled={disabled}
                    size="icon"
                    variant="ghost"
                  />
                }
              >
                <MoreHorizontal />
              </Menu.Trigger>
              <Menu.Content align="end">
                <Menu.Item onClick={onDelete} variant="destructive">
                  <Trash2 />
                  {t("Delete")}
                </Menu.Item>
              </Menu.Content>
            </Menu>
          )}
          <Button
            disabled={validating}
            onClick={onValidate}
            type="button"
            variant="outline"
          >
            {validating ? <Spinner /> : <CheckCircle2 />}
            {validating ? t("Validating…") : t("Validate")}
          </Button>
          <Button
            disabled={disabled || saving}
            onClick={onSave}
            type="button"
            variant="outline"
          >
            {saving ? <Spinner /> : <Save />}
            {saving ? t("Saving…") : t("Save")}
          </Button>
          <Button disabled={disabled} onClick={onRun} type="button">
            <Play />
            {t("Run")}
          </Button>
        </div>
      </div>

      {validationMessage && (
        <Alert
          role={validationTone === "error" ? "alert" : "status"}
          tone={
            validationTone === "error"
              ? "destructive"
              : validationTone === "success"
                ? "success"
                : "info"
          }
        >
          <Alert.Icon>
            <ListChecks />
          </Alert.Icon>
          <Alert.Title>
            {validationTone === "error"
              ? t("Workflow needs attention")
              : validationTone === "success"
                ? t("Workflow ready")
                : t("Workflow setup")}
          </Alert.Title>
          <Alert.Description>{validationMessage}</Alert.Description>
        </Alert>
      )}

      <Workbench
        compactBelow={640}
        inspectorWidth={440}
        className="h-[max(36rem,calc(100dvh-14rem))]"
      >
        <InspectorAutoOpen
          selectedId={nodes.find((node) => node.selected)?.id ?? ""}
        />
        <Workbench.Bar>
          <Toolbar aria-label={t("Workflow tools")}>
            <Toolbar.Button
              disabled={disabled || nodes.length >= maxNodes}
              label={t("Add agent node")}
              onClick={onAddNode}
            >
              <Plus />
            </Toolbar.Button>
            <Toolbar.Button
              disabled={disabled}
              label={t("Auto layout")}
              onClick={onAutoLayout}
            >
              <LayoutGrid />
            </Toolbar.Button>
            <Toolbar.Separator />
            <FocusButton />
            <Workbench.InspectorTrigger className="w-auto gap-1.5 px-3 text-sm font-medium">
              <SlidersHorizontal />
              {t("Inspector")}
            </Workbench.InspectorTrigger>
          </Toolbar>
        </Workbench.Bar>

        <Workbench.Canvas className="p-0!">
          <div className="absolute inset-0">
            <Flow
              className="h-full w-full rounded-none border-0 bg-transparent"
              fitViewOnMount
              key={`${graphKey}:${settled}`}
              label={t("Execution graph")}
              onConnect={(connection) => {
                if (!disabled) onConnect(connection)
              }}
              onNodeDragEnd={onPositionChange}
            >
              <Flow.Background variant="dots" />
              {edges.map((edge) => (
                <Flow.Edge
                  arrow
                  from={edge.from}
                  fromSide="bottom"
                  key={`${edge.from}-${edge.to}`}
                  to={edge.to}
                  toSide="top"
                  variant="smoothstep"
                />
              ))}
              {nodes.map((node, index) => (
                <Flow.Node
                  className="w-64"
                  draggable={!disabled}
                  id={node.id}
                  key={node.id}
                  onPress={() => onSelectNode(node.id)}
                  position={node.position}
                  selected={node.selected}
                >
                  <Flow.NodeHeader>
                    <Flow.NodeDescription>
                      {index + 1} · {node.id}
                    </Flow.NodeDescription>
                    {node.status ? (
                      <Flow.NodeBadge
                        color={
                          statusVariant(node.status) === "destructive"
                            ? "destructive"
                            : statusVariant(node.status) === "success"
                              ? "success"
                              : "info"
                        }
                      >
                        {node.status.replaceAll("_", " ")}
                      </Flow.NodeBadge>
                    ) : null}
                  </Flow.NodeHeader>
                  <Flow.NodeContent>
                    <Flow.NodeTitle className="flex items-center gap-1.5">
                      <Bot aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {node.agentName || t("No agent selected")}
                      </span>
                    </Flow.NodeTitle>
                    <Flow.NodeDescription className="line-clamp-2">
                      {node.instruction}
                    </Flow.NodeDescription>
                  </Flow.NodeContent>
                  <Flow.Handle id="in" position="top" />
                  <Flow.Handle id="out" position="bottom" />
                </Flow.Node>
              ))}
              <Flow.Controls position="bottom-left" />
            </Flow>
          </div>
        </Workbench.Canvas>

        <Workbench.Inspector title={t("Workflow inspector")}>
          <Inspector
            onValueChange={(value) => {
              setPage(value as InspectorPage)
              if (validationTarget) onValidationDismiss()
            }}
            value={openPage}
          >
            <Inspector.Rail>
              <Inspector.Tab label={t("Step")} value="node">
                <Bot />
              </Inspector.Tab>
              <Inspector.Tab label={t("Connections")} value="connections">
                <GitBranch />
              </Inspector.Tab>
              <Inspector.RailSeparator />
              <Inspector.Tab label={t("Settings")} value="workflow">
                <Settings2 />
              </Inspector.Tab>
              <Inspector.Tab label={t("Schedule")} value="schedule">
                <Clock3 />
              </Inspector.Tab>
            </Inspector.Rail>
            <Inspector.Panel>
              <Inspector.Page value="node">{nodePanel}</Inspector.Page>
              <Inspector.Page value="connections">
                <Inspector.Section>
                  <Inspector.SectionTitle>
                    {t("Connections ({value0})", { value0: edges.length })}
                  </Inspector.SectionTitle>
                  <Inspector.SectionContent>
                    {edges.length ? (
                      edges.map((edge) => (
                        <div
                          className="flex items-center justify-between gap-2 text-sm"
                          key={`${edge.from}-${edge.to}`}
                        >
                          <span className="truncate">
                            {edge.from} → {edge.to}
                          </span>
                          <Button
                            aria-label={t(
                              "Remove connection {value0} to {value1}",
                              { value0: edge.from, value1: edge.to }
                            )}
                            disabled={disabled}
                            onClick={() => onRemoveEdge(edge)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <X />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("Connect nodes using the handles on the canvas.")}
                      </p>
                    )}
                  </Inspector.SectionContent>
                </Inspector.Section>
              </Inspector.Page>
              <Inspector.Page value="workflow">{settingsPanel}</Inspector.Page>
              <Inspector.Page value="schedule">{schedulePanel}</Inspector.Page>
            </Inspector.Panel>
          </Inspector>
        </Workbench.Inspector>
      </Workbench>
    </div>
  )
}

/** The graph of a finished or running run: the same nodes, read only, with each step's status. */
export function WorkflowRunGraph({
  nodes,
  edges,
}: {
  nodes: EditorNode[]
  edges: EditorEdge[]
}) {
  const { t } = useTranslations()
  return (
    <Flow
      className="h-full w-full rounded-none border-0 bg-transparent"
      fitViewOnMount
      label={t("Execution graph")}
    >
      <Flow.Background variant="dots" />
      {edges.map((edge) => (
        <Flow.Edge
          arrow
          from={edge.from}
          fromSide="bottom"
          key={`${edge.from}-${edge.to}`}
          to={edge.to}
          toSide="top"
          variant="smoothstep"
        />
      ))}
      {nodes.map((node, index) => (
        <Flow.Node
          className="w-64"
          draggable={false}
          id={node.id}
          key={node.id}
          position={node.position}
        >
          <Flow.NodeHeader>
            <Flow.NodeDescription>
              {index + 1} · {node.id}
            </Flow.NodeDescription>
            {node.status ? (
              <Flow.NodeBadge
                color={
                  statusVariant(node.status) === "destructive"
                    ? "destructive"
                    : statusVariant(node.status) === "success"
                      ? "success"
                      : "info"
                }
              >
                {node.status.replaceAll("_", " ")}
              </Flow.NodeBadge>
            ) : null}
          </Flow.NodeHeader>
          <Flow.NodeContent>
            <Flow.NodeTitle className="flex items-center gap-1.5">
              <Bot aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">
                {node.agentName || t("No agent selected")}
              </span>
            </Flow.NodeTitle>
            <Flow.NodeDescription className="line-clamp-2">
              {node.instruction}
            </Flow.NodeDescription>
          </Flow.NodeContent>
          <Flow.Handle id="in" position="top" />
          <Flow.Handle id="out" position="bottom" />
        </Flow.Node>
      ))}
      <Flow.Controls position="bottom-left" />
    </Flow>
  )
}
