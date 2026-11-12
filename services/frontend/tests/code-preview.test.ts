import assert from "node:assert/strict"
import test from "node:test"

import { buildPreviewDocument, previewLanguage } from "../lib/code-preview.ts"

test("detects previewable languages from code class names", () => {
  assert.equal(previewLanguage("language-html"), "html")
  assert.equal(previewLanguage("foo language-SVG"), "svg")
  assert.equal(previewLanguage("language-python"), null)
  assert.equal(previewLanguage(undefined), null)
})

test("wraps fragments and injects a restrictive CSP", () => {
  const doc = buildPreviewDocument("<h1>Hi</h1>", "html")
  assert.match(doc, /^<!doctype html>/)
  assert.match(doc, /Content-Security-Policy/)
  assert.match(doc, /default-src 'none'/)
  assert.match(doc, /<h1>Hi<\/h1>/)
})

test("keeps full documents and prepends the CSP", () => {
  const doc = buildPreviewDocument("<!doctype html><html><body>x</body></html>", "html")
  assert.ok(doc.startsWith("<meta http-equiv"))
  assert.equal(doc.match(/<!doctype/gi)?.length, 1)
})

test("wraps svg in a centered body", () => {
  const doc = buildPreviewDocument("<svg></svg>", "svg")
  assert.match(doc, /<body[^>]*><svg><\/svg><\/body>/)
})
