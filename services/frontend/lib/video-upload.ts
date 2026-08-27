export type VideoUploadPartResult = {
  partNumber: number
  etag: string
  sizeBytes?: number
}

export type VideoUploadProgress = {
  loadedBytes: number
  totalBytes: number
  percent: number
}

type UploadPartOptions = {
  uploadId: string
  partNumber: number
  body: Blob
  contentType: string
  signal: AbortSignal
  organizationId?: string
  url?: string
  onProgress?: (loadedBytes: number, totalBytes: number) => void
}

type UploadPartsOptions = {
  uploadId: string
  file: Blob
  partSize: number
  partCount: number
  contentType: string
  signal: AbortSignal
  organizationId?: string
  resolvePartURL?: (path: string) => string
  concurrency?: number
  maxAttempts?: number
  retryDelayBaseMs?: number
  onProgress?: (progress: VideoUploadProgress) => void
  uploadPart?: typeof uploadVideoPart
  uploadedParts?: VideoUploadPartResult[]
}

const DEFAULT_CONCURRENCY = 3
const DEFAULT_MAX_ATTEMPTS = 3
const PART_RETRY_BASE_DELAY_MS = 500
const PART_TIMEOUT_MS = 10 * 60 * 1000

export class VideoUploadError extends Error {
  status: number
  code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "VideoUploadError"
    this.status = status
    this.code = code
  }
}

export function videoUploadPartPath(uploadId: string, partNumber: number) {
  return `/api/v1/transcription/video-uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`
}

export function uploadVideoPart({
  uploadId,
  partNumber,
  body,
  contentType,
  signal,
  organizationId,
  url,
  onProgress,
}: UploadPartOptions): Promise<VideoUploadPartResult> {
  if (signal.aborted) {
    return Promise.reject(videoUploadAbortError())
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false

    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      callback()
    }

    const abort = () => {
      xhr.abort()
    }

    const fail = (error: Error) => settle(() => reject(error))

    xhr.upload.onprogress = (event) => {
      onProgress?.(event.loaded, event.total || body.size)
    }
    xhr.onerror = () => {
      fail(
        new VideoUploadError(
          `Part ${partNumber} could not reach the JustAI backend. Check your connection and try again.`,
          0,
          "video_upload_network_error"
        )
      )
    }
    xhr.ontimeout = () => {
      fail(
        new VideoUploadError(
          `Part ${partNumber} timed out while uploading. Please retry the upload.`,
          408,
          "video_upload_part_timeout"
        )
      )
    }
    xhr.onabort = () => fail(videoUploadAbortError())
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(videoUploadErrorFromResponse(xhr, partNumber))
        return
      }

      const payload = parseJSON(xhr.responseText) as {
        partNumber?: unknown
        etag?: unknown
        ETag?: unknown
      } | null
      const responsePartNumber =
        typeof payload?.partNumber === "number"
          ? payload.partNumber
          : partNumber
      const etag =
        (typeof payload?.etag === "string" && payload.etag.trim()) ||
        (typeof payload?.ETag === "string" && payload.ETag.trim()) ||
        xhr.getResponseHeader("ETag")?.trim() ||
        ""

      if (responsePartNumber !== partNumber || !etag) {
        fail(
          new VideoUploadError(
            `The JustAI backend did not confirm uploaded part ${partNumber}. Please retry the upload.`,
            502,
            "video_upload_part_confirmation_missing"
          )
        )
        return
      }

      onProgress?.(body.size, body.size)
      settle(() => resolve({ partNumber, etag }))
    }

    signal.addEventListener("abort", abort, { once: true })
    xhr.open("PUT", url ?? videoUploadPartPath(uploadId, partNumber))
    xhr.withCredentials = true
    xhr.timeout = PART_TIMEOUT_MS
    if (organizationId)
      xhr.setRequestHeader("X-Organization-ID", organizationId)
    xhr.setRequestHeader(
      "Content-Type",
      contentType || "application/octet-stream"
    )
    try {
      xhr.send(body)
    } catch (caught) {
      fail(
        caught instanceof Error
          ? caught
          : new VideoUploadError(
              `Part ${partNumber} could not be uploaded.`,
              0,
              "video_upload_send_failed"
            )
      )
    }
  })
}

export async function uploadVideoParts({
  uploadId,
  file,
  partSize,
  partCount,
  contentType,
  signal,
  organizationId,
  resolvePartURL = (path) => path,
  concurrency = DEFAULT_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayBaseMs = PART_RETRY_BASE_DELAY_MS,
  onProgress,
  uploadPart = uploadVideoPart,
  uploadedParts = [],
}: UploadPartsOptions): Promise<VideoUploadPartResult[]> {
  if (signal.aborted) throw videoUploadAbortError()
  if (partCount <= 0 || partSize <= 0) {
    throw new Error("The backend returned invalid video upload part metadata.")
  }
  if (file.size <= 0) throw new Error("The selected video file is empty.")
  if (Math.ceil(file.size / partSize) !== partCount) {
    throw new Error(
      "The selected video does not match the backend upload part metadata. Choose the original file again."
    )
  }

  const partBytes = new Map<number, number>()
  const results = new Map<number, VideoUploadPartResult>()

  for (const part of uploadedParts) {
    if (
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > partCount ||
      typeof part.etag !== "string" ||
      !part.etag.trim() ||
      results.has(part.partNumber)
    ) {
      throw new Error("The backend returned invalid uploaded video parts.")
    }
    const expectedBytes = Math.min(
      partSize,
      file.size - (part.partNumber - 1) * partSize
    )
    if (
      part.sizeBytes !== undefined &&
      part.sizeBytes !== expectedBytes
    ) {
      throw new Error("The backend returned an invalid uploaded part size.")
    }
    results.set(part.partNumber, part)
    partBytes.set(part.partNumber, expectedBytes)
  }

  const partNumbers = Array.from(
    { length: partCount },
    (_, index) => index + 1
  )
  const missingPartNumbers = partNumbers.filter(
    (partNumber) => !results.has(partNumber)
  )
  const controller = new AbortController()
  let fatalError: Error | null = null

  const abortFromCaller = () => controller.abort()
  signal.addEventListener("abort", abortFromCaller, { once: true })

  const reportProgress = () => {
    const loadedBytes = Math.min(
      file.size,
      [...partBytes.values()].reduce((total, loaded) => total + loaded, 0)
    )
    onProgress?.({
      loadedBytes,
      totalBytes: file.size,
      percent: Math.min(100, Math.floor((loadedBytes / file.size) * 100)),
    })
  }

  reportProgress()

  let nextPartIndex = 0
  const worker = async () => {
    while (nextPartIndex < missingPartNumbers.length) {
      if (controller.signal.aborted) throw videoUploadAbortError()
      const partNumber = missingPartNumbers[nextPartIndex++]
      const start = (partNumber - 1) * partSize
      const end = Math.min(file.size, start + partSize)
      const body = file.slice(start, end)
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (controller.signal.aborted) throw videoUploadAbortError()
        partBytes.set(partNumber, 0)
        reportProgress()
        try {
          const result = await uploadPart({
            uploadId,
            partNumber,
            body,
            contentType,
            signal: controller.signal,
            organizationId,
            url: resolvePartURL(videoUploadPartPath(uploadId, partNumber)),
            onProgress: (loadedBytes, totalBytes) => {
              const reportedTotal = totalBytes > 0 ? totalBytes : body.size
              partBytes.set(
                partNumber,
                Math.min(
                  body.size,
                  Math.max(0, (loadedBytes / reportedTotal) * body.size)
                )
              )
              reportProgress()
            },
          })
          partBytes.set(partNumber, body.size)
          results.set(partNumber, result)
          reportProgress()
          lastError = null
          break
        } catch (caught) {
          if (controller.signal.aborted) throw caught
          lastError =
            caught instanceof Error
              ? caught
              : new Error(`Part ${partNumber} could not be uploaded.`)
          if (
            attempt >= maxAttempts ||
            !isRetryableVideoUploadError(lastError)
          ) {
            break
          }
          await delayWithSignal(
            retryDelayBaseMs * 2 ** (attempt - 1),
            controller.signal
          )
        }
      }

      if (lastError) {
        fatalError = lastError
        controller.abort()
        throw lastError
      }
    }
  }

  try {
    await Promise.all(
      Array.from(
        {
          length: Math.max(
            1,
            Math.min(concurrency, missingPartNumbers.length)
          ),
        },
        () => worker()
      )
    )
  } catch (caught) {
    if (fatalError) throw fatalError
    if (signal.aborted || controller.signal.aborted) {
      throw videoUploadAbortError()
    }
    throw caught instanceof Error ? caught : new Error("Video upload failed.")
  } finally {
    signal.removeEventListener("abort", abortFromCaller)
  }

  return partNumbers.map((partNumber) => {
    const result = results.get(partNumber)
    if (!result) throw new Error(`Part ${partNumber} was not uploaded.`)
    return result
  })
}

export function videoUploadAbortError() {
  return new VideoUploadError(
    "The video upload was cancelled.",
    499,
    "video_upload_cancelled"
  )
}

export function isRetryableVideoUploadError(error: unknown) {
  if (!(error instanceof VideoUploadError)) return true
  return (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  )
}

function delayWithSignal(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      callback()
    }
    const timeout = globalThis.setTimeout(() => finish(resolve), delayMs)
    const abort = () => {
      globalThis.clearTimeout(timeout)
      finish(() => reject(videoUploadAbortError()))
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function parseJSON(value: string) {
  if (!value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function videoUploadErrorFromResponse(xhr: XMLHttpRequest, partNumber: number) {
  const payload = parseJSON(xhr.responseText) as {
    error?: string | { message?: string; code?: string; requestId?: string }
    message?: string
    code?: string
    requestId?: string
  } | null
  const error = typeof payload?.error === "object" ? payload.error : undefined
  const message =
    error?.message ??
    (typeof payload?.error === "string" ? payload.error : payload?.message) ??
    `The backend rejected video upload part ${partNumber} (${xhr.status}).`
  return new VideoUploadError(
    message,
    xhr.status,
    error?.code ?? payload?.code ?? "video_upload_part_rejected"
  )
}
