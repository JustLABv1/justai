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
  // Knowledge is the canonical workspace route. Redirect only the legacy
  // settings aliases here; redirecting `/knowledge` to itself causes an
  // endless server-side navigation loop in the App Router.
  if (section === "endpoints" || section === "mcp") {
    redirect(workspacePath(section))
  }

  return null
}
