---
type: "query"
date: "2026-09-10T08:17:25.995571+00:00"
question: "As you can see on the screenshot at my prod instance attaching files to the chat is again not working because the AI says that there is nothing. Why is this happening again?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Attachment()", "chat-view.tsx", "api"]
---

# Q: As you can see on the screenshot at my prod instance attaching files to the chat is again not working because the AI says that there is nothing. Why is this happening again?

## Answer

Expanded from original query via vocab: [attachment, upload, file, csv, message, part, content, chat, route, api, model, storage]. The screenshot proves the CSV upload and message rendering succeeded, but not that the model received its contents. In the current code, the attachment upload route is gated by attachments_enabled, while resolving the justai-source UUID and retrieving chunks in assistantUIChat is entirely gated by knowledge_enabled through unified_knowledge. Therefore production can accept and render an attachment while silently sending no attachment context to the model when attachments_enabled is true and knowledge_enabled is false. The client still emits file plus data-justai-attachment parts, and assistant-ui 0.15.18 with react-ai-sdk 1.4.9 preserves them, so the recent dependency patch is not the cause. The earlier catalog-sync race fix is present in v0.31.0 and current main. Confirm production platform_settings flags and knowledge retrieval logs; if knowledge_enabled is true, capture the api v1 chat request because that would indicate a production version mismatch or malformed request payload.

## Outcome

- Signal: useful

## Source Nodes

- Attachment()
- chat-view.tsx
- api