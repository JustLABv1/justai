import type { ConversationContext } from "./types.ts"

export function chatContextLabel(context: ConversationContext, hasAttachments: boolean, text: string) {
  if (hasAttachments) return "Message attachments only"
  if (/:knowledge\[[^\r\n]*?\]\{name="?knowledge:[0-9a-f-]{36}"?\}/i.test(text)) {
    return "Referenced files only"
  }
  if (context.transcriptionSessions.length || context.knowledgeSources.some((source) => source.contextScope === "persistent")) {
    return "Selected sources only"
  }
  return null
}
