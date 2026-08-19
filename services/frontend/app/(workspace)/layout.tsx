import { Suspense, type ReactNode } from "react"

import { Workspace } from "@/components/workspace"

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={<div className="min-h-full flex-1 bg-background" />}>
        <Workspace />
      </Suspense>
    </>
  )
}
