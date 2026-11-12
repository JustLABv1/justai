import assert from "node:assert/strict"
import test from "node:test"

import { parseChartSpec } from "../lib/chart-spec.ts"
import {
  buildPreviewDocument,
  buildReactPreviewDocument,
  codeFileName,
  looksLikeHTML,
  opensAsPreview,
  prepareReactSource,
  previewKind,
  resolvePreviewLanguage,
  runnerLanguage,
} from "../lib/code-preview.ts"
import { buildRunnerDocument, parseRunnerMessage } from "../lib/code-runner.ts"

test("recognises untagged HTML documents only", () => {
  assert.equal(looksLikeHTML("<!DOCTYPE html>\n<html></html>"), true)
  assert.equal(looksLikeHTML("  <html lang='de'>"), true)
  assert.equal(looksLikeHTML("<div>fragment</div>"), false)
  assert.equal(resolvePreviewLanguage(undefined, "<!doctype html><p>x"), "html")
  // An explicit tag always wins, and tagged non-HTML is never guessed.
  assert.equal(resolvePreviewLanguage("language-text", "<!doctype html>"), null)
  assert.equal(resolvePreviewLanguage("language-json", "{}"), "json")
})

test("maps new languages to preview kinds and runners", () => {
  assert.equal(previewKind("dot"), "graphviz")
  assert.equal(previewKind("diff"), "diff")
  assert.equal(previewKind("chart"), "chart")
  assert.equal(previewKind("tsx"), "frame")
  assert.equal(opensAsPreview("mermaid"), true)
  assert.equal(opensAsPreview("frame"), false)
  assert.equal(runnerLanguage("language-ts"), "typescript")
  assert.equal(runnerLanguage("language-sql"), "sql")
})

test("names saved code files by language", () => {
  assert.equal(codeFileName("python"), "code.py")
  assert.equal(codeFileName("TypeScript"), "code.ts")
  assert.equal(codeFileName(""), "code.txt")
  assert.equal(codeFileName("unknown-lang"), "code.txt")
})

test("html previews report their height and allow inline script only", () => {
  const doc = buildPreviewDocument("<h1>Hi</h1>", "html")
  assert.match(doc, /preview-height/)
  assert.match(doc, /default-src 'none'/)
})

test("react snippets are prepared for the UMD globals", () => {
  const source = prepareReactSource(
    [
      'import React, { useState, useEffect as useFx } from "react"',
      'import { createRoot } from "react-dom/client"',
      "export default function Counter() {",
      "  const [n, setN] = useState(0)",
      "  return <button onClick={() => setN(n + 1)}>{n}</button>",
      "}",
    ].join("\n")
  )
  assert.match(source, /const \{ useState, useFx: useEffect \}|const \{ useState, useEffect: useFx \}/)
  assert.match(source, /const \{ createRoot \} = ReactDOM;/)
  assert.doesNotMatch(source, /export default/)
  assert.doesNotMatch(source, /from "react"/)
  assert.match(source, /typeof Counter !== "undefined"/)
  assert.match(source, /ReactDOM\.createRoot/)
})

test("react snippets that mount themselves are left alone", () => {
  const source = prepareReactSource(
    "const App = () => <p/>\nReactDOM.createRoot(document.getElementById('root')).render(<App/>)"
  )
  assert.equal(source.match(/createRoot/g)?.length, 1)
})

test("react preview document embeds the source safely", () => {
  const doc = buildReactPreviewDocument("const App = () => <p>x</p>\n// </script>")
  // Three CDN scripts, the bootstrap and the height reporter; the user's own
  // "</script>" is escaped and must not add a sixth.
  assert.equal(doc.match(/<\/script>/g)?.length, 5)
  assert.match(doc, /react@18\.3\.1/)
  assert.match(doc, /isTSX: true/)
})

test("parses chart definitions", () => {
  const parsed = parseChartSpec(
    JSON.stringify({
      type: "bar",
      title: "Umsatz",
      data: [
        { monat: "Jan", umsatz: 10, kosten: "4,5" },
        { monat: "Feb", umsatz: 12, kosten: 5 },
      ],
    })
  )
  assert.ok(parsed.ok)
  if (parsed.ok) {
    assert.equal(parsed.spec.x, "monat")
    assert.deepEqual(parsed.spec.series, ["umsatz", "kosten"])
    assert.equal(parsed.spec.data[0].kosten, 4.5)
    assert.equal(parsed.spec.title, "Umsatz")
  }
  assert.equal(parseChartSpec("nope").ok, false)
  assert.equal(parseChartSpec('{"type":"radar","data":[{"a":1}]}').ok, false)
  assert.equal(parseChartSpec('{"type":"bar","data":[]}').ok, false)
  assert.equal(parseChartSpec('{"type":"bar","data":[{"name":"x"}]}').ok, false)
})

test("runner documents exist for every language and stay valid", () => {
  for (const language of ["javascript", "typescript", "python", "sql"] as const) {
    const doc = buildRunnerDocument(language)
    const script = /<script>([\s\S]*)<\/script>/.exec(doc)?.[1] ?? ""
    assert.doesNotThrow(() => new Function(script), language)
    const source = /const WORKER_SOURCE = (".*")\n/.exec(script)?.[1] ?? ""
    assert.doesNotThrow(() => new Function(JSON.parse(source) as string), language)
    assert.equal(doc.match(/<\/script>/g)?.length, 1, language)
  }
  assert.match(buildRunnerDocument("python"), /const PERSIST = true/)
  assert.match(buildRunnerDocument("sql"), /const PERSIST = true/)
  assert.match(buildRunnerDocument("javascript"), /const PERSIST = false/)
  assert.match(buildRunnerDocument("sql"), /connect-src https:\/\/cdn\.jsdelivr\.net/)
  assert.match(buildRunnerDocument("typescript"), /connect-src 'none'/)
})

test("validates table and file messages from the sandbox", () => {
  assert.deepEqual(parseRunnerMessage({ type: "table", csv: "a,b\n1,2" }), {
    type: "table",
    csv: "a,b\n1,2",
  })
  assert.equal(parseRunnerMessage({ type: "table", csv: 5 }), null)

  const file = parseRunnerMessage({
    type: "file",
    name: "out.csv",
    mime: "text/csv",
    data: "YSxiCjEsMg==",
  })
  assert.deepEqual(file, {
    type: "file",
    name: "out.csv",
    mime: "text/csv",
    data: "YSxiCjEsMg==",
  })
  // Dangerous types are downgraded; bad names and payloads are rejected.
  const html = parseRunnerMessage({ type: "file", name: "x.html", mime: "text/html", data: "AAAA" })
  assert.equal(html?.type === "file" ? html.mime : "", "application/octet-stream")
  assert.equal(parseRunnerMessage({ type: "file", name: "../x", mime: "text/csv", data: "AAAA" }), null)
  assert.equal(parseRunnerMessage({ type: "file", name: "x.csv", mime: "text/csv", data: "<script>" }), null)
})
