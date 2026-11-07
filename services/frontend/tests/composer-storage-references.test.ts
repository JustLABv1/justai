import assert from "node:assert/strict"
import { test } from "node:test"
import { storageReferenceItems } from "../lib/composer-storage-references.ts"
import type { KnowledgeItem } from "../lib/types.ts"

function item(resourceType: string): KnowledgeItem {
  return {
    id: `catalog-${resourceType}`,
    resourceId: `resource-${resourceType}`,
    resourceType,
    title: `Stored ${resourceType}`,
    status: "ready",
    visibility: "private",
    createdAt: "",
    updatedAt: "",
  }
}

test("composer references include stored files, notes and transcripts using resource IDs", () => {
  const refs = storageReferenceItems([
    item("source"),
    item("note"),
    item("transcript"),
  ])
  assert.deepEqual(
    refs.map((ref) => [ref.id, ref.type, ref.metadata.resourceId]),
    [
      ["knowledge:resource-source", "knowledge", "resource-source"],
      ["note:resource-note", "note", "resource-note"],
      [
        "transcription:resource-transcript",
        "transcription",
        "resource-transcript",
      ],
    ]
  )
})
test("unsupported storage entries do not become invalid chat references", () => {
  assert.deepEqual(
    storageReferenceItems([item("memory"), item("repository")]),
    []
  )
})
