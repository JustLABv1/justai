"use client"

import { FileText } from "lucide-react"
import type { SourceMessagePartComponent } from "@assistant-ui/react"

export const AssistantSource: SourceMessagePartComponent = (part) => {
  const metadata =
    part.providerMetadata &&
    typeof part.providerMetadata === "object" &&
    "justai" in part.providerMetadata &&
    typeof part.providerMetadata.justai === "object" &&
    part.providerMetadata.justai !== null
      ? (part.providerMetadata.justai as Record<string, unknown>)
      : undefined
  const locator = typeof metadata?.locator === "string" ? metadata.locator : ""
  const snippet = typeof metadata?.snippet === "string" ? metadata.snippet : ""
  const chunkIndex =
    typeof metadata?.chunkIndex === "number" ? metadata.chunkIndex : undefined

  return (
    <details className="my-2 max-w-xl rounded-lg border bg-muted/20 px-2.5 py-1.5 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <FileText className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{part.title ?? "Source"}</span>
      </summary>
      <div className="mt-2 space-y-1 whitespace-pre-wrap text-muted-foreground">
        {part.url && (
          <a
            className="break-all text-primary underline-offset-2 hover:underline"
            href={part.url}
            rel="noreferrer"
            target="_blank"
          >
            {part.url}
          </a>
        )}
        {!part.url && <p>Source ID: {part.id}</p>}
        {locator && <p>Location: {locator}</p>}
        {chunkIndex !== undefined && <p>Chunk {chunkIndex + 1}</p>}
        {snippet && <p className="max-w-md">{snippet}</p>}
      </div>
    </details>
  )
}
