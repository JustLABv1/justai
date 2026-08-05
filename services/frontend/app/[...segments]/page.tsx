import { Suspense } from "react"

import { Workspace } from "@/components/workspace"

export default function WorkspaceRoutePage() {
  return (
    <Suspense fallback={<div className="min-h-svh bg-background" />}>
      <Workspace />
    </Suspense>
  )
}
