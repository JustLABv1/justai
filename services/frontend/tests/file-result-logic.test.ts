import assert from "node:assert/strict"
import test from "node:test"

import {
  formatFileSize,
  hasFileResultShape,
  isGeneratedPDFURL,
  parseGeneratedFileResult,
} from "../lib/file-result-logic.ts"

test("parses an AI-generated file result object", () => {
  assert.deepEqual(
    parseGeneratedFileResult({
      file: {
        createdAt: "2026-08-25T12:00:00.000Z",
        filename: "report.pdf",
        id: "da7de815-6cf6-4e27-a35c-066f1c790452",
        mimeType: "application/pdf",
        size: 12345,
        title: "Report",
        url: "/api/v1/pdfs/da7de815-6cf6-4e27-a35c-066f1c790452",
      },
    }),
    {
      createdAt: "2026-08-25T12:00:00.000Z",
      filename: "report.pdf",
      id: "da7de815-6cf6-4e27-a35c-066f1c790452",
      mimeType: "application/pdf",
      size: 12345,
      title: "Report",
      url: "/api/v1/pdfs/da7de815-6cf6-4e27-a35c-066f1c790452",
    }
  )
})

test("parses a JSON-string file result and applies safe defaults", () => {
  const result = parseGeneratedFileResult(
    JSON.stringify({
      file: { url: " /api/v1/pdfs/a4c45855-3f7c-4e69-831a-33fb3ccfd403 " },
    })
  )

  assert.deepEqual(result, {
    filename: "document.pdf",
    mimeType: "application/pdf",
    title: "Generated PDF",
    url: "/api/v1/pdfs/a4c45855-3f7c-4e69-831a-33fb3ccfd403",
  })
  assert.equal(hasFileResultShape(JSON.stringify({ file: {} })), true)
})

test("rejects absent and malformed file result shapes", () => {
  assert.equal(hasFileResultShape({ content: "not a file" }), false)
  assert.equal(parseGeneratedFileResult({ content: "not a file" }), null)
  assert.equal(
    parseGeneratedFileResult({ file: { filename: "report.pdf" } }),
    null
  )
  assert.equal(parseGeneratedFileResult("not JSON"), null)
  assert.equal(
    parseGeneratedFileResult({
      file: { url: "https://attacker.example/report.pdf" },
    }),
    null
  )
})

test("recognizes only scoped JustAI PDF download URLs", () => {
  assert.equal(
    isGeneratedPDFURL(
      "/api/v1/pdfs/da7de815-6cf6-4e27-a35c-066f1c790452"
    ),
    true
  )
  assert.equal(isGeneratedPDFURL("/api/v1/pdfs/not-a-uuid"), false)
  assert.equal(
    isGeneratedPDFURL("https://attacker.example/api/v1/pdfs/file.pdf"),
    false
  )
})

test("formats generated file sizes for the result card", () => {
  assert.equal(formatFileSize(512), "512 B")
  assert.equal(formatFileSize(12345), "12.1 KB")
  assert.equal(formatFileSize(2 * 1024 * 1024), "2 MB")
  assert.equal(formatFileSize(undefined), undefined)
})
