import { redirect } from "next/navigation"

import { workspacePath } from "@/lib/workspace-routes"
import type { ViewId } from "@/lib/types"

const validViews: ViewId[] = [
  "chat",
  "transcription",
  "endpoints",
  "knowledge",
  "mcp",
  "settings",
]

type SearchParams = Record<string, string | string[] | undefined>

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const requestedView = firstValue(params.view) as ViewId | undefined
  const view = requestedView && validViews.includes(requestedView) ? requestedView : "chat"
  const conversationId = firstValue(params.conversation) ?? null
  const sessionId = firstValue(params.session) ?? null

  redirect(workspacePath(view, view === "chat" ? conversationId : null, view === "transcription" ? sessionId : null))
}
