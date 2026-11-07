"use client"

import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { UsageSummary } from "@/lib/usage"

const USAGE_CHANGED = "justai:usage-changed"

/** Tell every open usage reading to load again, such as after a limit was changed. */
export function notifyUsageChanged() {
  window.dispatchEvent(new Event(USAGE_CHANGED))
}

/**
 * The signed-in member's monthly usage. It is read again when `refreshKey`
 * changes, when a limit is changed in this browser, when the tab is shown
 * again, and every minute, so a limit an admin changed elsewhere shows up
 * without a page refresh.
 */
export function useUsage(refreshKey?: unknown) {
  const [usage, setUsage] = useState<UsageSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api
        .get<UsageSummary>("/api/v1/usage")
        .then((result) => {
          if (!cancelled) setUsage(result)
        })
        .catch(() => {})
    }
    load()
    const onVisible = () => {
      if (document.visibilityState === "visible") load()
    }
    window.addEventListener(USAGE_CHANGED, load)
    window.addEventListener("focus", load)
    document.addEventListener("visibilitychange", onVisible)
    const timer = window.setInterval(onVisible, 60_000)
    return () => {
      cancelled = true
      window.removeEventListener(USAGE_CHANGED, load)
      window.removeEventListener("focus", load)
      document.removeEventListener("visibilitychange", onVisible)
      window.clearInterval(timer)
    }
  }, [refreshKey])

  return usage
}

export function usageLimitReached(usage: UsageSummary | null) {
  return (
    usage !== null &&
    usage.monthlyTokenLimit !== null &&
    usage.totalTokens >= usage.monthlyTokenLimit
  )
}
