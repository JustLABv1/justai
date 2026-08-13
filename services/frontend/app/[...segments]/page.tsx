import { Suspense } from "react"
import { redirect } from "next/navigation"

import { Workspace } from "@/components/workspace"
import { workspacePath } from "@/lib/workspace-routes"

type RouteParams = { segments?: string[] }

export default async function WorkspaceRoutePage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { segments = [] } = await params
  const [section, id] = segments

  if (section === "conversation" || section === "chat") {
    redirect(workspacePath("chat", id ?? null))
  }
  if (section === "endpoints" || section === "knowledge" || section === "mcp") {
    redirect(workspacePath(section))
  }

  return (
    <Suspense fallback={<div className="min-h-svh bg-background" />}>
      <Workspace />
    </Suspense>
  )
}
