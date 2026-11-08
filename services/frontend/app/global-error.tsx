"use client"

import "./globals.css"

import { ErrorScreen } from "@/components/error-screen"

/** Last resort when the root layout itself fails: no providers are available here. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ErrorScreen
          kind="server"
          status={500}
          reference={error.digest}
          onRetry={reset}
          fullScreen
        />
      </body>
    </html>
  )
}
