---
type: "query"
date: "2026-09-10T08:19:17.102027+00:00"
question: "As you can see on the screenshot at my prod instance attaching files to the chat is again not working because the AI says that there is nothing. Why is this happening again?"
contributor: "graphify"
outcome: "corrected"
correction: "Both feature flags are enabled. The remaining code-level defect is multi-organization misattribution: user-scoped uploads are cataloged under the users oldest organization instead of the active conversation organization, causing authorization/retrieval joins to return zero context."
source_nodes: ["chat-view.tsx", "api", "Attachment()"]
---

# Q: As you can see on the screenshot at my prod instance attaching files to the chat is again not working because the AI says that there is nothing. Why is this happening again?

## Answer

Expanded from original query via graph vocabulary. After the user confirmed both feature flags are enabled, the feature-gate hypothesis was rejected. The likely root cause is incorrect organization attribution in knowledgeCatalogSyncSQL: chat attachments are created as user-scoped knowledge_sources, without the active organization, and catalog sync maps each such source to the first organization_members row ordered by created_at. For users belonging to multiple organizations, this can assign the uploaded attachment to a different organization than the conversation. conversationHasKnowledge and retrieval then require knowledge_items.organization_id to equal the active conversation organization, so they silently find nothing even though upload, ingestion, and UI rendering succeeded. The earlier sync fix only ensured a catalog row existed; it did not ensure it belonged to the active organization.

## Outcome

- Signal: corrected
- Correction: Both feature flags are enabled. The remaining code-level defect is multi-organization misattribution: user-scoped uploads are cataloged under the users oldest organization instead of the active conversation organization, causing authorization/retrieval joins to return zero context.

## Source Nodes

- chat-view.tsx
- api
- Attachment()