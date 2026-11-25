import assert from "node:assert/strict"
import test from "node:test"
import { api, APIError } from "../lib/api.ts"
import {
  backupChunkRanges,
  backupConflictOffset,
  backupResumeMatches,
  backupResumeOffset,
  backupExportPath,
  backupRestoreIsActive,
  backupRestorePercent,
  formatBackupBytes,
  parseStoredBackupRestore,
} from "../lib/platform-backup.ts"

test("backup upload reports unexpected proxy responses as API errors", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<html>Proxy error</html>", { status: 200 })
  )
  const upload = () =>
    api.binary("/api/v1/admin/backup/restores/job/chunks?offset=0", new Blob())

  await assert.rejects(
    upload,
    (error) => error instanceof APIError && error.code === "invalid_response"
  )

  fetchMock.mock.mockImplementation(
    async () => new Response(null, { status: 413 })
  )
  await assert.rejects(upload, {
    name: "APIError",
    status: 413,
    message: "HTTP 413",
  })
})

test("chunk ranges cover the file exactly once in order", () => {
  assert.deepEqual(backupChunkRanges(10, 4), [
    { offset: 0, end: 4 },
    { offset: 4, end: 8 },
    { offset: 8, end: 10 },
  ])
  assert.deepEqual(backupChunkRanges(8, 4), [
    { offset: 0, end: 4 },
    { offset: 4, end: 8 },
  ])
  assert.deepEqual(backupChunkRanges(0, 4), [])
  assert.deepEqual(backupChunkRanges(5, 0), [])
})

test("byte sizes use binary units with one decimal below 100", () => {
  assert.equal(formatBackupBytes(0), "0 B")
  assert.equal(formatBackupBytes(512), "512 B")
  assert.equal(formatBackupBytes(1536), "1.5 KB")
  assert.equal(formatBackupBytes(250 * 1024 * 1024), "250 MB")
  assert.equal(formatBackupBytes(3 * 1024 ** 3), "3.0 GB")
  assert.equal(formatBackupBytes(1536, "de"), "1,5 KB")
})

test("restore progress moves forward through every phase", () => {
  const withFiles = { rowsTotal: 100, bytesTotal: 1000 }
  const steps = [
    backupRestorePercent({ ...withFiles, phase: "database", rowsDone: 0 }),
    backupRestorePercent({ ...withFiles, phase: "database", rowsDone: 50 }),
    backupRestorePercent({ ...withFiles, phase: "constraints", rowsDone: 100 }),
    backupRestorePercent({ ...withFiles, phase: "files", bytesDone: 500 }),
    backupRestorePercent({ ...withFiles, phase: "files", bytesDone: 1000 }),
    backupRestorePercent({ ...withFiles, phase: "done" }),
  ]
  for (let index = 1; index < steps.length; index++) {
    assert.ok(steps[index] >= steps[index - 1], `step ${index}: ${steps}`)
  }
  assert.equal(steps[0], 0)
  assert.equal(steps.at(-1), 100)
  assert.ok(steps[4] < 100, "only a finished restore reports 100%")
  assert.equal(
    backupRestorePercent({ phase: "constraints", rowsTotal: 0 }),
    86,
    "a database-only restore spends most of its range on rows"
  )
})

test("active states keep polling", () => {
  assert.equal(backupRestoreIsActive("validating"), true)
  assert.equal(backupRestoreIsActive("restoring"), true)
  assert.equal(backupRestoreIsActive("ready"), false)
  assert.equal(backupRestoreIsActive("failed"), false)
})

test("stored restore tokens are validated before use", () => {
  const id = "2422b4b0-b843-4ee3-b02e-11a6695d052a"
  const token = "a".repeat(43)
  assert.deepEqual(parseStoredBackupRestore(JSON.stringify({ id, token })), {
    id,
    token,
  })
  assert.equal(parseStoredBackupRestore(null), null)
  assert.equal(parseStoredBackupRestore("{"), null)
  assert.equal(
    parseStoredBackupRestore(JSON.stringify({ id: "../x", token })),
    null
  )
  assert.equal(
    parseStoredBackupRestore(JSON.stringify({ id, token: "short" })),
    null
  )
})

test("export path encodes the file choice", () => {
  assert.equal(backupExportPath(true), "/api/v1/admin/backup/export?files=true")
  assert.equal(
    backupExportPath(false),
    "/api/v1/admin/backup/export?files=false"
  )
})

test("a paused upload only continues with the same file", () => {
  const job = { fileName: "justai-backup.zip", expectedBytes: 100 }
  assert.equal(
    backupResumeMatches(job, { name: "justai-backup.zip", size: 100 }),
    true
  )
  assert.equal(
    backupResumeMatches(job, { name: "justai-backup.zip", size: 99 }),
    false
  )
  assert.equal(
    backupResumeMatches(job, { name: "other.zip", size: 100 }),
    false
  )
})

test("uploads resume at the last complete chunk", () => {
  assert.equal(backupResumeOffset(0, 16), 0)
  assert.equal(backupResumeOffset(32, 16), 32)
  assert.equal(backupResumeOffset(40, 16), 32)
  assert.equal(backupResumeOffset(-1, 16), 0)
})

test("conflict details yield the server's received bytes", () => {
  assert.equal(backupConflictOffset({ receivedBytes: 32 }), 32)
  assert.equal(backupConflictOffset({ receivedBytes: "32" }), null)
  assert.equal(backupConflictOffset({ receivedBytes: -1 }), null)
  assert.equal(backupConflictOffset(null), null)
})
