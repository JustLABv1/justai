"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { AlertCircle, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ToolCallEntry } from "@/components/ui/tool-calls-section"

type ApprovalContextValue = {
  setMessageApprovals: (messageId: string, approvals: ToolCallEntry[]) => void
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null)
const ApprovalCardsContext = createContext<{
  approvals: ToolCallEntry[]
} | null>(null)

export function useMCPApprovalQueue() {
  return useContext(ApprovalContext)
}

export function MCPApprovalProvider({ children }: { children: ReactNode }) {
  const approvalsByMessage = useRef(new Map<string, ToolCallEntry[]>())
  const [approvals, setApprovals] = useState<ToolCallEntry[]>([])

  const setMessageApprovals = (messageId: string, next: ToolCallEntry[]) => {
    if (next.length) approvalsByMessage.current.set(messageId, next)
    else approvalsByMessage.current.delete(messageId)
    setApprovals(Array.from(approvalsByMessage.current.values()).flat())
  }

  const value = useMemo(() => ({ setMessageApprovals }), [])

  return (
    <ApprovalContext.Provider value={value}>
      <ApprovalCardsContext.Provider value={{ approvals }}>
        {children}
      </ApprovalCardsContext.Provider>
    </ApprovalContext.Provider>
  )
}

export function MCPApprovalCards() {
  const queue = useContext(ApprovalCardsContext)
  if (!queue) return null
  return <MCPApprovalCardsContent approvals={queue.approvals} />
}

function MCPApprovalCardsContent({
  approvals,
}: {
  approvals: ToolCallEntry[]
}) {
  const [submitting, setSubmitting] = useState<Set<string>>(new Set())
  if (!approvals.length) return null

  return (
    <div
      className="mx-auto w-full max-w-3xl px-3 sm:px-5"
      aria-live="assertive"
    >
      <div className="mcp-approval-shimmer relative mb-2 overflow-hidden rounded-[1.45rem] p-px shadow-[0_12px_32px_-22px_color-mix(in_oklch,var(--primary)_80%,transparent)]">
        <div className="relative flex flex-col gap-3 rounded-[calc(1.45rem-1px)] bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="size-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <AlertCircle
                className="size-3.5 text-primary"
                aria-hidden="true"
              />
              {approvals.length === 1
                ? "Action needs your approval"
                : `${approvals.length} actions need approval`}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {approvals
                .map((approval) =>
                  approval.integration_name
                    ? `${approval.integration_name}: ${approval.message}`
                    : approval.message
                )
                .join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {approvals.map((approval, index) => {
              const id =
                approval.tool_call_id ?? `${approval.tool_name}-${index}`
              const busy = submitting.has(id)
              return (
                <div className="flex gap-1.5" key={id}>
                  <Button
                    size="sm"
                    disabled={busy || !approval.respondToApproval}
                    aria-busy={busy}
                    onClick={() => {
                      setSubmitting((current) => new Set(current).add(id))
                      approval.respondToApproval?.({ approved: true })
                    }}
                  >
                    {busy
                      ? "Allowing…"
                      : approvals.length > 1
                        ? `Allow ${index + 1}`
                        : "Allow"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !approval.respondToApproval}
                    onClick={() =>
                      approval.respondToApproval?.({
                        approved: false,
                        reason: "Denied by user",
                      })
                    }
                  >
                    Deny
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export function RegisterMCPApprovals({
  messageId,
  approvals,
}: {
  messageId: string
  approvals: ToolCallEntry[]
}) {
  const queue = useMCPApprovalQueue()
  useEffect(() => {
    queue?.setMessageApprovals(messageId, approvals)
    return () => queue?.setMessageApprovals(messageId, [])
  }, [approvals, messageId, queue])
  return null
}
