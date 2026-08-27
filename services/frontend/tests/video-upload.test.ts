import assert from "node:assert/strict"
import test from "node:test"

import {
  uploadVideoParts,
  videoUploadPartPath,
  VideoUploadError,
  isRetryableVideoUploadError,
} from "../lib/video-upload.ts"

test("builds the same-origin backend part route", () => {
  assert.equal(
    videoUploadPartPath("upload/with spaces", 7),
    "/api/v1/transcription/video-uploads/upload%2Fwith%20spaces/parts/7"
  )
})

test("uploads multipart data with bounded concurrency and aggregate byte progress", async () => {
  const controller = new AbortController()
  const progress: number[] = []
  const active: number[] = []
  const resolvedUrls: string[] = []
  let activeCount = 0

  const parts = await uploadVideoParts({
    uploadId: "upload",
    file: new Blob(["abcdefghij"]),
    partSize: 4,
    partCount: 3,
    contentType: "video/mp4",
    signal: controller.signal,
    concurrency: 2,
    resolvePartURL: (path) => `http://localhost:8080${path}`,
    uploadPart: async ({ partNumber, body, onProgress, url }) => {
      resolvedUrls.push(url ?? "")
      activeCount += 1
      active.push(activeCount)
      onProgress?.(Math.floor(body.size / 2), body.size)
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
      onProgress?.(body.size, body.size)
      activeCount -= 1
      return { partNumber, etag: `etag-${partNumber}` }
    },
    onProgress: ({ loadedBytes, percent }) => {
      progress.push(loadedBytes)
      assert.equal(percent, Math.floor((loadedBytes / 10) * 100))
    },
  })

  assert.deepEqual(parts, [
    { partNumber: 1, etag: "etag-1" },
    { partNumber: 2, etag: "etag-2" },
    { partNumber: 3, etag: "etag-3" },
  ])
  assert.ok(Math.max(...active) <= 2)
  assert.equal(progress.at(-1), 10)
  assert.deepEqual(resolvedUrls.sort(), [
    "http://localhost:8080/api/v1/transcription/video-uploads/upload/parts/1",
    "http://localhost:8080/api/v1/transcription/video-uploads/upload/parts/2",
    "http://localhost:8080/api/v1/transcription/video-uploads/upload/parts/3",
  ])
})

test("retries a failed part and returns each part in part-number order", async () => {
  const controller = new AbortController()
  const attempts = new Map<number, number>()

  const parts = await uploadVideoParts({
    uploadId: "upload",
    file: new Blob(["abcdefgh"]),
    partSize: 4,
    partCount: 2,
    contentType: "video/mp4",
    signal: controller.signal,
    concurrency: 1,
    maxAttempts: 2,
    retryDelayBaseMs: 0,
    uploadPart: async ({ partNumber, body }) => {
      const attempt = (attempts.get(partNumber) ?? 0) + 1
      attempts.set(partNumber, attempt)
      if (partNumber === 1 && attempt === 1) {
        throw new Error("temporary backend failure")
      }
      return { partNumber, etag: `etag-${body.size}-${attempt}` }
    },
  })

  assert.equal(attempts.get(1), 2)
  assert.equal(attempts.get(2), 1)
  assert.deepEqual(parts, [
    { partNumber: 1, etag: "etag-4-2" },
    { partNumber: 2, etag: "etag-4-1" },
  ])
})

test("cancels active multipart work without reporting completion", async () => {
  const controller = new AbortController()
  let started = false
  const pending = uploadVideoParts({
    uploadId: "upload",
    file: new Blob(["abcdefgh"]),
    partSize: 4,
    partCount: 2,
    contentType: "video/mp4",
    signal: controller.signal,
    uploadPart: ({ signal }) => {
      started = true
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        })
      })
    },
  })

  while (!started)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  controller.abort()

  await assert.rejects(pending, (error: unknown) => {
    return (
      error instanceof VideoUploadError &&
      error.code === "video_upload_cancelled"
    )
  })
})

test("does not retry deterministic client errors", async () => {
  const controller = new AbortController()
  let attempts = 0

  await assert.rejects(
    uploadVideoParts({
      uploadId: "upload",
      file: new Blob(["abcd"]),
      partSize: 4,
      partCount: 1,
      contentType: "video/mp4",
      signal: controller.signal,
      maxAttempts: 3,
      retryDelayBaseMs: 0,
      uploadPart: async () => {
        attempts += 1
        throw new VideoUploadError("invalid part", 400, "invalid_part")
      },
    }),
    /invalid part/
  )

  assert.equal(attempts, 1)
  assert.equal(
    isRetryableVideoUploadError(
      new VideoUploadError("bad request", 400, "invalid_part")
    ),
    false
  )
  assert.equal(
    isRetryableVideoUploadError(
      new VideoUploadError("temporary failure", 503, "upstream_unavailable")
    ),
    true
  )
})

test("resumes by uploading only parts the backend has not persisted", async () => {
  const controller = new AbortController()
  const uploaded: number[] = []

  const parts = await uploadVideoParts({
    uploadId: "upload",
    file: new Blob(["abcdefghij"]),
    partSize: 4,
    partCount: 3,
    contentType: "video/mp4",
    signal: controller.signal,
    uploadedParts: [
      { partNumber: 1, etag: "etag-1", sizeBytes: 4 },
      { partNumber: 3, etag: "etag-3", sizeBytes: 2 },
    ],
    uploadPart: async ({ partNumber }) => {
      uploaded.push(partNumber)
      return { partNumber, etag: `etag-${partNumber}` }
    },
  })

  assert.deepEqual(uploaded, [2])
  assert.deepEqual(
    parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
    [
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
      { partNumber: 3, etag: "etag-3" },
    ]
  )
})

test("does not start work for an already-cancelled upload", async () => {
  const controller = new AbortController()
  controller.abort()
  let started = false

  await assert.rejects(
    uploadVideoParts({
      uploadId: "upload",
      file: new Blob(["abcd"]),
      partSize: 4,
      partCount: 1,
      contentType: "video/mp4",
      signal: controller.signal,
      uploadPart: async ({ partNumber }) => {
        started = true
        return { partNumber, etag: "etag" }
      },
    }),
    (error: unknown) =>
      error instanceof VideoUploadError &&
      error.code === "video_upload_cancelled"
  )

  assert.equal(started, false)
})
