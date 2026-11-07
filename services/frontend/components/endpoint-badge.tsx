"use client"

import { useState, type ReactNode } from "react"

import { resolveAPIURL } from "@/lib/api"
import { cn } from "@/lib/utils"

/** Up to two uppercase initials taken from the endpoint's display name. */
export function endpointInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word)[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

/**
 * Identifies an endpoint: its uploaded logo when available, otherwise initials.
 * A logo that fails to load falls back to the initials instead of a broken image.
 */
export function EndpointBadge({
  name,
  logoUrl,
  className,
  fallback,
}: {
  name: string
  logoUrl?: string
  className?: string
  fallback?: ReactNode
}) {
  const [failedUrl, setFailedUrl] = useState("")
  const showLogo = Boolean(logoUrl) && failedUrl !== logoUrl
  if (showLogo) {
    return (
      // Uploaded logos are served by JustAI itself, so no Next Image allowlist.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt=""
        aria-hidden="true"
        className={cn("rounded-full object-cover", className)}
        onError={() => setFailedUrl(logoUrl ?? "")}
        src={/^(data|blob):/.test(logoUrl!) ? logoUrl : resolveAPIURL(logoUrl!)}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center rounded-full text-sm font-medium",
        className
      )}
    >
      {fallback ?? endpointInitials(name)}
    </span>
  )
}
