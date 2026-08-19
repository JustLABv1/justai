import { redirect } from "next/navigation"

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

  return null
}
