"use client"

import { useEffect, useRef, useState } from "react"
import { FileVideo } from "lucide-react"
import { api } from "@/lib/api"

export function VideoTranscriptionThumbnail({
  url,
  scope,
}: {
  url?: string
  scope: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const key = `${scope}:${url ?? ""}`
  const [image, setImage] = useState<{ key: string; url: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const src = image?.key === key && failed !== key ? image.url : ""

  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    let active = true
    let objectURL = ""
    let started = false
    const load = async () => {
      if (started) return
      started = true
      try {
        // The API client supplies the active workspace and session credentials.
        // A plain image URL cannot supply the required workspace header.
        const blob = await api.getBlob(url, { signal: controller.signal })
        if (!active || blob.type !== "image/jpeg") return
        objectURL = URL.createObjectURL(blob)
        setImage({ key, url: objectURL })
      } catch {
        // Incomplete or expired recordings keep a quiet placeholder.
      }
    }
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== "undefined" && root.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect()
            void load()
          }
        },
        { rootMargin: "120px" }
      )
      observer.observe(root.current)
    } else void load()
    return () => {
      active = false
      observer?.disconnect()
      controller.abort()
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [url, key])

  return (
    <div
      ref={root}
      className="relative aspect-video w-full shrink-0 overflow-hidden bg-muted"
    >
      {src ? (
        // Private, short-lived blob URLs intentionally bypass the public image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(key)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <FileVideo aria-hidden="true" className="size-10" />
        </div>
      )}
    </div>
  )
}
