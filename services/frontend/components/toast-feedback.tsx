"use client"

import { useEffect, useRef } from "react"
import { toast } from "@/components/ui/toast"

/** Bridge retained request state to transient notifications without layout shifts. */
export function ToastFeedback({
  message,
  type = "info",
}: {
  message?: string | null
  type?: "success" | "destructive" | "info" | "warning"
}) {
  const last = useRef("")
  useEffect(() => {
    if (!message) {
      last.current = ""
      return
    }
    if (last.current === message) return
    last.current = message
    toast.add({
      title: message,
      type,
      timeout: type === "destructive" ? 10000 : 6000,
      priority: type === "destructive" ? "high" : "low",
    })
  }, [message, type])
  return null
}
