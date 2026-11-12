"use client"

import { useEffect, useRef, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { cn } from "@/lib/utils"

const minHeight = 160
const maxHeight = 720
const defaultHeight = 384

/**
 * Sandboxed preview for generated HTML. The frame has no `allow-same-origin`,
 * so it cannot reach cookies or the JustAI API. It sizes itself to its content
 * (the document reports its height) and can be shown full screen.
 */
export function HtmlPreviewFrame({
  srcDoc,
  className,
}: {
  srcDoc: string
  className?: string
}) {
  const { t } = useTranslations()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(defaultHeight)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (data?.type !== "preview-height" || typeof data.height !== "number") {
        return
      }
      setHeight(
        Math.min(maxHeight, Math.max(minHeight, Math.ceil(data.height)))
      )
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return (
    <div className={cn("relative", className)}>
      <iframe
        className="w-full rounded-xl bg-white"
        ref={frameRef}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-modals"
        srcDoc={srcDoc}
        style={{ height }}
        title={t("Preview")}
      />
      <button
        className="absolute top-2 right-2 rounded-md bg-background/80 px-2 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => void frameRef.current?.requestFullscreen?.()}
        type="button"
      >
        {t("Fullscreen")}
      </button>
    </div>
  )
}
