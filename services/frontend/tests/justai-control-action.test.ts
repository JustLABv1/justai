import assert from "node:assert/strict"
import test from "node:test"
import { parseJustAIAction } from "../lib/justai-control-action.ts"
const result = (href: string) => ({
  action: { href, title: "Profile", description: "Open page" },
})
test("JustAI actions accept known pages and setup routes", () => {
  for (const href of [
    "/profile",
    "/admin?tab=audit",
    "/agents?tab=runs",
    "/live-transcription?create=1",
  ]) {
    assert.equal(parseJustAIAction(result(href))?.href, href)
  }
  assert.equal(
    parseJustAIAction(JSON.stringify(result("/profile")))?.title,
    "Profile"
  )
})
test("persisted tool results cannot inject external or arbitrary action URLs", () => {
  for (const href of [
    "https://evil.test",
    "//evil.test",
    "javascript:alert(1)",
    "/api/v1/auth/logout",
    "/profile?tab=audit",
    "/agents?tab=admin",
    "/profile#x",
    "/live-transcription?create=2",
    "/\\evil.test",
  ]) {
    assert.equal(parseJustAIAction(result(href)), null, href)
  }
  assert.equal(parseJustAIAction({ action: { href: "/profile" } }), null)
})
