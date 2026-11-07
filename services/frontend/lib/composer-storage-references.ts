import type { KnowledgeItem } from "./types.ts"

/** The reference kinds understood by the composer and the chat backend. */
export function storageReferenceItems(items: KnowledgeItem[]) {
  return items.flatMap((item) => {
    const type =
      item.resourceType === "source"
        ? ("knowledge" as const)
        : item.resourceType === "note"
          ? ("note" as const)
          : item.resourceType === "transcript"
            ? ("transcription" as const)
            : null
    return type
      ? [
          {
            id: `${type}:${item.resourceId}`,
            type,
            label: item.title,
            description: item.status,
            metadata: { resourceId: item.resourceId },
          },
        ]
      : []
  })
}
