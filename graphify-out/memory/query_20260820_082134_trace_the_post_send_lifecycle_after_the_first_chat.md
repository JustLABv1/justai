---
type: "query"
date: "2026-08-20T08:21:34.030795+00:00"
question: "Trace the post-send lifecycle after the first chat and explain why a persisted two-message conversation can show a fresh empty composer until a manual browser refresh."
contributor: "graphify"
outcome: "useful"
source_nodes: ["ChatView()", "Workspace()"]
---

# Q: Trace the post-send lifecycle after the first chat and explain why a persisted two-message conversation can show a fresh empty composer until a manual browser refresh.

## Answer

Expanded from original query via graph vocab: [chat, conversation, ensure, history, message, route, send, stream, view, workspace, new]. The first send creates or promotes a pending conversation and the live AssistantChatSurface keeps initialMessages empty while the stream owns the messages. When refreshConversations fills in conversation.assistantId, assistantSurfaceKey changed, which changed the React key and remounted the live surface with initialMessages=[]; the history list had the persisted two messages, but the visible runtime was fresh. Fixed by using a stable local key while surfaceKey is new, preserving assistant hydration keys for normally loaded conversations.

## Outcome

- Signal: useful

## Source Nodes

- ChatView()
- Workspace()