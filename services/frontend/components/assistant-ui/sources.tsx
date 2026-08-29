"use client"

import { Database, ExternalLink, FileText, ShieldCheck } from "lucide-react"
import {
  useAui,
  useAuiState,
  type SourceMessagePartComponent,
} from "@assistant-ui/react"

export const AssistantSource: SourceMessagePartComponent = (part) => {
  const aui = useAui()
  const messageId = useAuiState((state) => state.message.id)
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
  const quoteText = snippet || part.title || part.id
  const isExternal = Boolean(part.url)
  const provenance = isExternal ? "External source" : "Workspace source"
  const trustLabel = isExternal ? "Linked source" : "Attached context"

  return (
    <details className="my-2 max-w-xl rounded-lg border bg-muted/20 px-2.5 py-1.5 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <FileText
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="truncate">{part.title ?? "Source"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-normal text-muted-foreground">
          <ShieldCheck className="size-3 text-primary" aria-hidden="true" />
          {trustLabel}
        </span>
      </summary>
      <div className="mt-2 space-y-1 whitespace-pre-wrap text-muted-foreground">
        <div className="flex items-center gap-1.5 text-[11px]">
          {isExternal ? (
            <ExternalLink className="size-3" aria-hidden="true" />
          ) : (
            <Database className="size-3" aria-hidden="true" />
          )}
          <span>{provenance}</span>
        </div>
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
        <button
          className="mt-1 rounded-md border px-2 py-1 font-medium text-foreground hover:bg-muted"
          onClick={() =>
            aui.thread.composer().setQuote({
              messageId,
              text: quoteText,
            })
          }
          type="button"
        >
          Ask about this source
        </button>
      </div>
    </details>
  )
}
