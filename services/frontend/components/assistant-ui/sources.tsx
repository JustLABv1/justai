"use client"

import { useTranslations } from "@/components/locale-provider"
import { Database, ExternalLink, FileText, ShieldCheck } from "lucide-react"
import {
  useAui,
  useAuiState,
  type SourceMessagePartComponent,
} from "@assistant-ui/react"

import { Button } from "@/components/ui/button"

export const AssistantSource: SourceMessagePartComponent = (part) => {
  const { t } = useTranslations()

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
  const contextOrigin = metadata?.contextOrigin
  const chunkIndex =
    typeof metadata?.chunkIndex === "number" ? metadata.chunkIndex : undefined
  const quoteText = snippet || part.title || part.id
  const isExternal = Boolean(part.url)
  const provenance = isExternal ? t("External source") : t("Workspace source")
  const trustLabel =
    contextOrigin === "selected"
      ? t("Selected source")
      : contextOrigin === "automatic"
        ? t("Found automatically")
        : isExternal
          ? t("Linked source")
          : t("Source provided to model")

  return (
    <details className="my-2 max-w-xl rounded-xl bg-card px-2.5 py-1.5 text-xs text-card-foreground">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <FileText
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="truncate">{part.title ?? t("Source")}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-normal text-muted-foreground">
          <ShieldCheck className="size-3 text-primary" aria-hidden="true" />
          {trustLabel}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1 whitespace-pre-wrap text-muted-foreground">
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
        {!part.url && (
          <p>
            {t("Source ID:")} {part.id}
          </p>
        )}
        {locator && (
          <p>
            {t("Location:")} {locator}
          </p>
        )}
        {chunkIndex !== undefined && (
          <p>
            {t("Chunk")} {chunkIndex + 1}
          </p>
        )}
        {snippet && <p className="max-w-md">{snippet}</p>}
        <Button
          className="mt-1"
          onClick={() =>
            aui.thread.composer().setQuote({
              messageId,
              text: quoteText,
            })
          }
          size="sm"
          type="button"
          variant="outline"
        >
          {t("Ask about this source")}
        </Button>
      </div>
    </details>
  )
}
