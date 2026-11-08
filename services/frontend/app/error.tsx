"use client"

import { useEffect } from "react"

import { ErrorScreen } from "@/components/error-screen"
import { errorPageKindFor, errorStatusFor } from "@/lib/error-pages"

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])
  const kind = errorPageKindFor(error)
  const status = errorStatusFor(error) ?? (kind === "unreachable" ? 0 : 500)
  return (
    <ErrorScreen
      kind={kind}
      status={status}
      reference={error.digest}
      onRetry={reset}
      fullScreen
    />
  )
}
