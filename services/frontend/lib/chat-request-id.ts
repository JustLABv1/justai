type ChatRequestPart = {
  type?: unknown
  state?: unknown
  approvalId?: unknown
  approval?: unknown
}

type ChatRequestMessage = {
  id?: unknown
  role?: unknown
  parts?: unknown
}

function respondedApprovalId(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined

  for (const value of [...parts].reverse()) {
    if (!value || typeof value !== "object") continue
    const part = value as ChatRequestPart
    const approval =
      part.approval && typeof part.approval === "object"
        ? (part.approval as { id?: unknown; approved?: unknown })
        : undefined
    const responded =
      part.state === "approval-responded" ||
      part.type === "tool-approval-response" ||
      typeof approval?.approved === "boolean"
    if (!responded) continue

    const approvalId =
      typeof approval?.id === "string"
        ? approval.id
        : typeof part.approvalId === "string"
          ? part.approvalId
          : undefined
    if (approvalId) return approvalId
  }

  return undefined
}

export function chatRequestId(
  messages: readonly ChatRequestMessage[]
): string | undefined {
  const latestMessage = messages.at(-1)
  if (
    latestMessage?.role === "assistant" &&
    typeof latestMessage.id === "string"
  ) {
    const approvalId = respondedApprovalId(latestMessage.parts)
    return approvalId
      ? `approval:${latestMessage.id}:${approvalId}`
      : `approval:${latestMessage.id}`
  }

  const latestUser = [...messages]
    .reverse()
    .find((message) => message?.role === "user")
  return typeof latestUser?.id === "string"
    ? `turn:${latestUser.id}`
    : undefined
}
