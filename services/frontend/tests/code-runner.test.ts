import assert from "node:assert/strict"
import test from "node:test"

import { runnerLanguage, previewKind, previewLanguage } from "../lib/code-preview.ts"
import { buildRunnerDocument, parseRunnerMessage } from "../lib/code-runner.ts"
import { detectDelimiter, parseDelimited, parseJSON } from "../lib/data-preview.ts"
import { normalizeMath } from "../lib/inline-math.ts"

test("detects runnable languages", () => {
  assert.equal(runnerLanguage("language-js"), "javascript")
  assert.equal(runnerLanguage("language-Python"), "python")
  assert.equal(runnerLanguage("language-py"), "python")
  assert.equal(runnerLanguage("language-go"), null)
  assert.equal(runnerLanguage(undefined), null)
})

test("maps json and csv to data previews", () => {
  assert.equal(previewLanguage("language-json"), "json")
  assert.equal(previewKind("json"), "json")
  assert.equal(previewKind("csv"), "table")
  assert.equal(previewKind("tsv"), "table")
})

test("only accepts well-formed runner messages", () => {
  assert.deepEqual(parseRunnerMessage({ type: "log", level: "warn", text: "hi" }), {
    type: "log",
    level: "warn",
    text: "hi",
  })
  assert.equal(parseRunnerMessage({ type: "log", level: "log" }), null)
  assert.equal(parseRunnerMessage({ type: "unknown" }), null)
  assert.equal(parseRunnerMessage("nope"), null)
  assert.equal(parseRunnerMessage({ type: "image", src: "https://evil.test/x.png" }), null)
  assert.equal(parseRunnerMessage({ type: "image", src: "data:image/svg+xml;base64,AAAA" }), null)
  assert.deepEqual(
    parseRunnerMessage({ type: "image", src: "data:image/png;base64,iVBORw0KGgo=" }),
    { type: "image", src: "data:image/png;base64,iVBORw0KGgo=" }
  )
})

test("runner document is locked down and escapes script terminators", () => {
  const js = buildRunnerDocument("javascript")
  assert.match(js, /connect-src 'none'/)
  assert.doesNotMatch(js, /cdn\.jsdelivr\.net\/pyodide/)
  const python = buildRunnerDocument("python")
  assert.match(python, /connect-src https:\/\/cdn\.jsdelivr\.net/)
  assert.match(python, /pyodide\.js/)
  // Only the outer script's own closing tag may appear.
  assert.equal(js.match(/<\/script>/g)?.length, 1)
  assert.equal(python.match(/<\/script>/g)?.length, 1)
})

test("worker sources are valid JavaScript", () => {
  for (const language of ["javascript", "python"] as const) {
    const doc = buildRunnerDocument(language)
    const script = /<script>([\s\S]*)<\/script>/.exec(doc)?.[1] ?? ""
    assert.doesNotThrow(() => new Function(script), language)
    const source = /const WORKER_SOURCE = (".*")\n/.exec(script)?.[1] ?? ""
    assert.doesNotThrow(() => new Function(JSON.parse(source) as string), language)
  }
})

test("parses CSV with quotes, newlines and delimiters", () => {
  assert.deepEqual(parseDelimited('a,b\n"x,1","he said ""hi"""\n', ","), [
    ["a", "b"],
    ["x,1", 'he said "hi"'],
  ])
  assert.deepEqual(parseDelimited('a,b\r\n"multi\nline",2', ","), [
    ["a", "b"],
    ["multi\nline", "2"],
  ])
  assert.equal(detectDelimiter("csv", "a;b\n1;2"), ";")
  assert.equal(detectDelimiter("csv", "a,b;c"), ",")
  assert.equal(detectDelimiter("tsv", "a\tb"), "\t")
})

test("parses JSON safely", () => {
  assert.deepEqual(parseJSON('{"a":[1,2]}'), { ok: true, value: { a: [1, 2] } })
  assert.deepEqual(parseJSON("{nope"), { ok: false })
})

test("normalizes math delimiters without touching prices or code", () => {
  assert.equal(normalizeMath("Wert $x^2 + 1$ hier"), "Wert $$x^2 + 1$$ hier")
  assert.equal(normalizeMath("Sei $x$ gegeben"), "Sei $$x$$ gegeben")
  assert.equal(normalizeMath("\\(a^2\\)"), "$$a^2$$")
  assert.equal(normalizeMath("\\[a=b\\]"), "\n$$\na=b\n$$\n")
  assert.equal(normalizeMath("Kostet $5 und $10 total"), "Kostet $5 und $10 total")
  assert.equal(normalizeMath("`$x^2$`"), "`$x^2$`")
  assert.equal(normalizeMath("```\n$a^2$\n```"), "```\n$a^2$\n```")
  assert.equal(normalizeMath("$$\nE=mc^2\n$$"), "$$\nE=mc^2\n$$")
})

test("picks a preview language for generated files", async () => {
  const { filePreviewLanguage } = await import("../lib/code-preview.ts")
  assert.equal(filePreviewLanguage("text/csv", "x.csv"), "csv")
  assert.equal(filePreviewLanguage("application/octet-stream", "data.json"), "json")
  assert.equal(filePreviewLanguage("text/markdown", "a.md"), "md")
  assert.equal(filePreviewLanguage("text/html; charset=utf-8", "a.html"), "html")
  assert.equal(filePreviewLanguage("application/pdf", "a.pdf"), null)
})
