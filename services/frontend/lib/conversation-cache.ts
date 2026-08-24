export function conversationCacheKey(scope: string, conversationId: string) {
  // JSON encoding keeps the tenant/user scope and conversation id unambiguous
  // even if either value contains the separator used by a human-readable key.
  return JSON.stringify([scope, conversationId])
}
