import { Suspense, type ReactNode } from "react"
import { cookies } from "next/headers"

import { Workspace } from "@/components/workspace"

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={<div className="min-h-full flex-1 bg-background" />}>
        <PersistedWorkspace />
      </Suspense>
    </>
  )
}

async function PersistedWorkspace() {
  const cookieStore = await cookies()
  const defaultSidebarOpen = cookieStore.get("sidebar_state")?.value !== "false"

  return <Workspace defaultSidebarOpen={defaultSidebarOpen} />
}
