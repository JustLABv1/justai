export interface GeneratedFileResult {
  id?: string
  url: string
  filename: string
  title: string
  mimeType: string
  size?: number
  createdAt?: string
}

type RecordValue = Record<string, unknown>
const generatedPDFURLPattern =
  /^\/api\/v1\/pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isGeneratedPDFURL(value: string): boolean {
  return generatedPDFURLPattern.test(value)
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseToolResult(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function hasFileResultShape(value: unknown): boolean {
  const parsed = parseToolResult(value)
  return (
    isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "file")
  )
}

export function parseGeneratedFileResult(
  value: unknown
): GeneratedFileResult | null {
  const parsed = parseToolResult(value)
  if (!isRecord(parsed) || !isRecord(parsed.file)) return null

  const file = parsed.file
  const url = typeof file.url === "string" ? file.url.trim() : ""
  if (!isGeneratedPDFURL(url)) return null

  const filename =
    typeof file.filename === "string" && file.filename.trim()
      ? file.filename.trim()
      : "document.pdf"
  const title =
    typeof file.title === "string" && file.title.trim()
      ? file.title.trim()
      : "Generated PDF"
  const mimeType =
    typeof file.mimeType === "string" && file.mimeType.trim()
      ? file.mimeType.trim()
      : "application/pdf"
  const size =
    typeof file.size === "number" &&
    Number.isFinite(file.size) &&
    file.size >= 0
      ? file.size
      : undefined

  const result: GeneratedFileResult = {
    filename,
    mimeType,
    title,
    url,
  }
  if (typeof file.createdAt === "string") result.createdAt = file.createdAt
  if (typeof file.id === "string") result.id = file.id
  if (size !== undefined) result.size = size
  return result
}

export function formatFileSize(size: number | undefined): string | undefined {
  if (size === undefined || !Number.isFinite(size) || size < 0) return undefined
  if (size < 1024) return `${Math.round(size)} B`

  const units = ["B", "KB", "MB", "GB", "TB"]
  const unitIndex = Math.min(
    Math.floor(Math.log(size) / Math.log(1024)),
    units.length - 1
  )
  const value = size / 1024 ** unitIndex
  const formatted = value.toFixed(1).replace(/\.0$/, "")
  return `${formatted} ${units[unitIndex]}`
}
