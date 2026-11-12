/** Languages whose fenced code blocks can be previewed in a sandboxed frame. */
const previewableLanguages = new Set(["html", "htm", "svg"])

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
