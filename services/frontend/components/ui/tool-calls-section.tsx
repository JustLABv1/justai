"use client"

import type { ReactNode } from "react"
import { useMemo, useState } from "react"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons"
import type { ToolApprovalResponse } from "@assistant-ui/react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatToolName, getToolCategoryIcon } from "@/lib/utils/tool-icons"
import { CompactMarkdown } from "@/components/ui/compact-markdown"

// ============================================================================
// Types
// ============================================================================

export interface ToolCallEntry {
  /** Name of the tool that was called */
  tool_name: string
  /** Category/integration the tool belongs to (e.g., "gmail", "search", "memory") */
  tool_category: string
  /** Human-readable message describing what the tool did */
  message?: string
  /** Whether to show the category label (default: true) */
  show_category?: boolean
  /** Unique ID for this tool call */
  tool_call_id?: string
  /** Input parameters passed to the tool */
  inputs?: Record<string, unknown>
  /** Output/result from the tool */
  output?: string
  /** Error returned by the tool, if any */
  error?: string
  /** Current execution state */
  status?: "running" | "waiting" | "completed" | "failed" | "cancelled"
  /** Approval state for tools that require confirmation */
  approval?: {
    approved?: boolean
    reason?: string
    resolution?: "cancelled" | "expired"
  }
  /** Respond to a pending approval request */
  respondToApproval?: (response: ToolApprovalResponse) => void
  /** URL to custom icon for integrations */
  icon_url?: string
  /** Friendly name for the integration (e.g., "Linear", "Slack") */
  integration_name?: string
}

export interface IntegrationInfo {
  iconUrl?: string
  name?: string
}

export interface ToolCallsSectionProps {
  /** Array of tool call entries to display */
  toolCalls: ToolCallEntry[]
  /** Optional map of integration IDs to their info for icon/name lookup */
  integrations?: Map<string, IntegrationInfo>
  /** Maximum number of icons to show in the stacked display (default: 10) */
  maxIconsToShow?: number
  /** Whether to start with the accordion expanded (default: false) */
  defaultExpanded?: boolean
  /** Custom class name for the container */
  className?: string
  /** Custom icon size (default: 21) */
  iconSize?: number
  /** Custom icon renderer override */
  renderIcon?: (call: ToolCallEntry, size: number) => ReactNode
  /** Custom content renderer override for inputs/outputs */
  renderContent?: (
    content: unknown,
    call: ToolCallEntry,
    kind: "input" | "output"
  ) => ReactNode
}

// ============================================================================
// Helper Components
// ============================================================================

interface ChevronIconProps {
  isExpanded: boolean
  size?: number
  className?: string
}

function ChevronIcon({
  isExpanded,
  size = 18,
  className = "",
}: ChevronIconProps) {
  return (
    <HugeiconsIcon
      icon={ArrowDown01Icon}
      size={size}
      className={cn(
        "transition-transform duration-200",
        isExpanded && "rotate-180",
        className
      )}
    />
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function ToolCallsSection({
  toolCalls,
  integrations,
  maxIconsToShow = 10,
  defaultExpanded = false,
  className,
  iconSize = 21,
  renderIcon,
  renderContent,
}: ToolCallsSectionProps) {
  const pendingApprovalIndices = useMemo(
    () =>
      toolCalls.reduce<number[]>((indices, call, index) => {
        if (call.status === "waiting") indices.push(index)
        return indices
      }, []),
    [toolCalls]
  )
  const hasPendingApprovals = pendingApprovalIndices.length > 0
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [expandedCalls, setExpandedCalls] = useState<Set<number>>(new Set())
  const isGroupExpanded = isExpanded || hasPendingApprovals

  // Create a lookup map for custom integrations by id
  const integrationLookup = useMemo(() => {
    if (integrations) return integrations
    return new Map<string, IntegrationInfo>()
  }, [integrations])

  // Helper to get icon_url with fallback to integrations lookup
  const getIconUrl = (call: ToolCallEntry): string | undefined => {
    if (call.icon_url) return call.icon_url
    const integration = integrationLookup.get(call.tool_category)
    return integration?.iconUrl
  }

  // Helper to get integration_name with fallback to integrations lookup
  const getIntegrationName = (call: ToolCallEntry): string | undefined => {
    if (call.integration_name) return call.integration_name
    const integration = integrationLookup.get(call.tool_category)
    return integration?.name
  }

  const toggleCallExpansion = (index: number) => {
    setExpandedCalls((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  if (toolCalls.length === 0) return null

  // Default icon renderer
  const defaultRenderIcon = (call: ToolCallEntry, size: number) => {
    const icon = getToolCategoryIcon(
      call.tool_category || "general",
      { width: size, height: size },
      getIconUrl(call)
    )
    return (
      icon || (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-200 p-1 text-zinc-600 backdrop-blur dark:bg-zinc-800 dark:text-zinc-400">
          <HugeiconsIcon icon={ToolsIcon} size={size} />
        </div>
      )
    )
  }

  const iconRenderer = renderIcon || defaultRenderIcon

  // Default content renderer
  const defaultRenderContent = (content: unknown) => (
    <CompactMarkdown content={content} />
  )

  const contentRenderer = renderContent || defaultRenderContent

  // Render stacked rotated icons (deduplicated by category for cleaner display)
  const renderStackedIcons = () => {
    const seenCategories = new Set<string>()
    const uniqueIcons = toolCalls.filter((call) => {
      const category = call.tool_category || "general"
      if (seenCategories.has(category)) return false
      seenCategories.add(category)
      return true
    })
    const displayIcons = uniqueIcons.slice(0, maxIconsToShow)

    return (
      <div className="flex min-h-8 items-center -space-x-2">
        {displayIcons.map((call, index) => (
          <div
            key={call.tool_call_id ?? `${call.tool_name}-${index}`}
            className="relative flex min-w-8 items-center justify-center"
            style={{
              rotate:
                displayIcons.length > 1
                  ? index % 2 === 0
                    ? "8deg"
                    : "-8deg"
                  : "0deg",
              zIndex: index,
            }}
          >
            {iconRenderer(call, iconSize)}
          </div>
        ))}
        {uniqueIcons.length > maxIconsToShow && (
          <div className="z-0 flex size-7 min-h-7 min-w-7 items-center justify-center rounded-lg bg-zinc-200 text-xs font-normal text-zinc-600 dark:bg-zinc-700/60 dark:text-zinc-500">
            +{uniqueIcons.length - maxIconsToShow}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cn("w-fit max-w-[35rem]", className)}>
      {/* Collapsible Header */}
      <button
        type="button"
        aria-expanded={isGroupExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex cursor-pointer items-center gap-2 py-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
      >
        {renderStackedIcons()}
        <span className="text-xs font-medium transition-all duration-200">
          Used {toolCalls.length} tool
          {toolCalls.length > 1 ? "s" : ""}
        </span>
        {hasPendingApprovals && (
          <span
            aria-live="polite"
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
          >
            <HugeiconsIcon icon={AlertCircleIcon} size={13} />
            {pendingApprovalIndices.length === 1
              ? "Approval required"
              : `${pendingApprovalIndices.length} approvals required`}
          </span>
        )}
        <ChevronIcon isExpanded={isGroupExpanded} />
      </button>

      {/* Collapsible Content */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          isGroupExpanded ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="space-y-0 pt-1">
          {toolCalls.map((call, index) => {
            const hasCategoryText =
              call.show_category !== false &&
              call.tool_category &&
              call.tool_category !== "unknown"
            const requiresApproval = call.status === "waiting"
            const hasInput = Boolean(
              call.inputs && Object.keys(call.inputs).length > 0
            )
            const hasDetails = Boolean(
              hasInput ||
              call.output !== undefined ||
              call.error ||
              requiresApproval
            )
            const isCallExpanded = expandedCalls.has(index) || requiresApproval
            const statusLabel =
              call.status === "waiting"
                ? "Approval needed"
                : call.status === "running"
                  ? "Running"
                  : call.status === "failed"
                    ? "Failed"
                    : call.status === "cancelled"
                      ? "Cancelled"
                      : "Completed"

            return (
              <div
                key={call.tool_call_id ?? `${call.tool_name}-step-${index}`}
                className="flex items-stretch gap-2"
              >
                {/* Icon column with connector line */}
                <div className="flex flex-col items-center self-stretch">
                  <div className="flex min-h-8 min-w-8 shrink-0 items-center justify-center">
                    {iconRenderer(call, iconSize)}
                  </div>
                  {index < toolCalls.length - 1 && (
                    <div className="min-h-4 w-px flex-1 bg-zinc-300 dark:bg-zinc-700" />
                  )}
                </div>

                {/* Content column */}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className={cn(
                      "group/parent flex items-center gap-1",
                      hasDetails ? "cursor-pointer" : "",
                      !hasCategoryText ? "pt-2" : ""
                    )}
                    onClick={() => hasDetails && toggleCallExpansion(index)}
                  >
                    <p
                      className={cn(
                        "text-xs font-medium text-zinc-600 dark:text-zinc-400",
                        hasDetails &&
                          "group-hover/parent:text-zinc-900 dark:group-hover/parent:text-white"
                      )}
                    >
                      {call.message || formatToolName(call.tool_name)}
                    </p>
                    <span
                      className={cn(
                        "text-[10px] font-normal",
                        call.status === "failed" && "text-destructive",
                        call.status === "running" && "text-primary",
                        call.status === "waiting" && "text-amber-500",
                        !call.status && "text-muted-foreground"
                      )}
                    >
                      {statusLabel}
                    </span>
                    {hasDetails && (
                      <ChevronIcon isExpanded={isCallExpanded} size={14} />
                    )}
                  </button>

                  {hasCategoryText && (
                    <p className="text-[11px] text-zinc-400 capitalize dark:text-zinc-500">
                      {getIntegrationName(call) ||
                        call.tool_category
                          .replace(/_/g, " ")
                          .split(" ")
                          .map(
                            (word) =>
                              word.charAt(0).toUpperCase() +
                              word.slice(1).toLowerCase()
                          )
                          .join(" ")}
                    </p>
                  )}

                  {isCallExpanded && hasDetails && (
                    <div className="mt-2 mb-3 w-fit space-y-2 rounded-xl bg-zinc-100 p-3 text-[11px] dark:bg-zinc-800/50">
                      {requiresApproval && (
                        <div
                          aria-live="assertive"
                          role="alert"
                          className="rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100"
                        >
                          <div className="flex items-center gap-1.5 font-semibold">
                            <HugeiconsIcon
                              aria-hidden="true"
                              icon={AlertCircleIcon}
                              size={14}
                            />
                            Approval required
                          </div>
                          <p className="mt-1 text-[10px] text-amber-800/80 dark:text-amber-200/80">
                            Review this MCP request before it runs.
                          </p>
                          {call.respondToApproval && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                onClick={() =>
                                  call.respondToApproval?.({ approved: true })
                                }
                              >
                                Allow
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  call.respondToApproval?.({
                                    approved: false,
                                    reason: "Denied by user",
                                  })
                                }
                              >
                                Deny
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                      {hasInput && (
                        <div className="flex flex-col">
                          <span className="mb-1 font-medium text-zinc-400 dark:text-zinc-500">
                            Input
                          </span>
                          {contentRenderer(call.inputs, call, "input")}
                        </div>
                      )}
                      {call.output !== undefined && (
                        <div className="flex flex-col">
                          <span className="mb-1 font-medium text-zinc-400 dark:text-zinc-500">
                            Output
                          </span>
                          {contentRenderer(call.output, call, "output")}
                        </div>
                      )}
                      {call.error && (
                        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-destructive">
                          {call.error}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ToolCallsSection
