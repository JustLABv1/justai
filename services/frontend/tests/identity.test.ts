import assert from "node:assert/strict"
import test from "node:test"

import { avatarToneFor, initialsFor, versionedAvatarURL } from "../lib/identity.ts"

test("builds resilient initials for irregular display names", () => {
  assert.equal(initialsFor("  Ada   Lovelace "), "AL")
  assert.equal(initialsFor(""), "U")
  assert.equal(initialsFor("   ", "?"), "?")
})

test("keeps fallback tone deterministic per identity", () => {
  assert.equal(avatarToneFor("user-1"), avatarToneFor("user-1"))
  assert.notEqual(avatarToneFor("user-1"), avatarToneFor("user-2"))
})

test("versions avatar URLs without dropping existing query parameters", () => {
  assert.equal(versionedAvatarURL("/api/v1/profile/avatar", "123"), "/api/v1/profile/avatar?v=123")
  assert.equal(versionedAvatarURL("/avatar?size=small", "a b"), "/avatar?size=small&v=a%20b")
  assert.equal(versionedAvatarURL("", "123"), null)
})
