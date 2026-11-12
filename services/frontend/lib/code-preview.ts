/** Languages whose fenced code blocks can be previewed. */
const previewableLanguages = new Set([
  "html",
  "htm",
  "svg",
  "mermaid",
  "markdown",
  "md",
  "json",
  "csv",
  "tsv",
])

export type PreviewKind = "frame" | "mermaid" | "markdown" | "json" | "table"

export function previewKind(language: string): PreviewKind {
  if (language === "mermaid") return "mermaid"
  if (language === "markdown" || language === "md") return "markdown"
  if (language === "json") return "json"
  if (language === "csv" || language === "tsv") return "table"
  return "frame"
}

export type RunnerLanguage = "javascript" | "python"

const runnerLanguages: Record<string, RunnerLanguage> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  py: "python",
  python: "python",
  python3: "python",
}

/** Languages whose code blocks can be run in the browser sandbox. */
export function runnerLanguage(
  className: string | undefined
): RunnerLanguage | null {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className ?? "")
  return runnerLanguages[match?.[1]?.toLowerCase() ?? ""] ?? null
}

/**
 * Network lockdown for previews: inline scripts/styles and a few well-known
 * script CDNs work, but nothing can call out (no fetch, forms, frames, images).
 */
const previewCSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src data: blob:",
  "media-src data: blob:",
].join("; ")

export function previewLanguage(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className ?? "")
  const language = match?.[1]?.toLowerCase()
  return language && previewableLanguages.has(language) ? language : null
}

export function buildPreviewDocument(code: string, language: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${previewCSP}">`
  const body =
    language === "svg"
      ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body>`
      : code
  const isFullDocument = /<(?:!doctype|html|head|body)[\s>]/i.test(body)
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">'
  if (isFullDocument) return `${meta}${viewport}${body}`
  return `<!doctype html><html><head><meta charset="utf-8">${meta}${viewport}</head><body>${body}</body></html>`
}

/** Preview language for a generated file, from its MIME type or extension. */
export function filePreviewLanguage(
  mimeType: string,
  filename: string
): "html" | "csv" | "tsv" | "json" | "md" | null {
  const mime = mimeType.toLowerCase()
  const name = filename.toLowerCase()
  if (mime.startsWith("text/html") || /\.html?$/.test(name)) return "html"
  if (mime.startsWith("text/csv") || name.endsWith(".csv")) return "csv"
  if (mime.startsWith("text/tab-separated-values") || name.endsWith(".tsv")) return "tsv"
  if (mime.startsWith("application/json") || name.endsWith(".json")) return "json"
  if (mime.startsWith("text/markdown") || /\.(md|markdown)$/.test(name)) return "md"
  return null
}
