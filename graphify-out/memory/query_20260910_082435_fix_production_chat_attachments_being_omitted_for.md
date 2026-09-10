---
type: "query"
date: "2026-09-10T08:24:35.566505+00:00"
question: "Fix production chat attachments being omitted for users in multiple organizations."
contributor: "graphify"
outcome: "useful"
source_nodes: ["Conversation", "NewSource()", "database.go"]
---

# Q: Fix production chat attachments being omitted for users in multiple organizations.

## Answer

Expanded from graph vocabulary: [attachment, upload, source, knowledge, organization, conversation, scope, database]. Fixed explicit message attachment retrieval so it is authorized directly by conversation_knowledge_sources instead of depending on a global knowledge_items organization row. Persistent and automatic Knowledge still require the catalog ownership envelope. Removed the synchronous catalog sync from the explicit attachment chat path. Added regression tests for attachment availability and ordered source coverage without a catalog row. Full go test ./... and go vet ./... pass.

## Outcome

- Signal: useful

## Source Nodes

- Conversation
- NewSource()
- database.go