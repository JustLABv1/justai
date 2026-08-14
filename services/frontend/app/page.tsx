import { Suspense } from "react"

import { Workspace } from "@/components/workspace"

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-full flex-1 bg-background" />}>
      <Workspace />
    </Suspense>
  )
}
