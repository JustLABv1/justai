/** Languages whose fenced code blocks can be previewed. */
const previewableLanguages = new Set([
  "html",
  "htm",
  "svg",
  "jsx",
  "tsx",
  "mermaid",
  "dot",
  "graphviz",
  "gv",
  "markdown",
  "md",
  "json",
  "csv",
  "tsv",
  "diff",
  "patch",
  "chart",
])

export type PreviewKind =
  | "frame"
  | "mermaid"
  | "graphviz"
  | "markdown"
  | "json"
  | "table"
  | "diff"
  | "chart"

export function previewKind(language: string): PreviewKind {
  if (language === "mermaid") return "mermaid"
  if (language === "dot" || language === "graphviz" || language === "gv") {
    return "graphviz"
  }
  if (language === "markdown" || language === "md") return "markdown"
  if (language === "json") return "json"
  if (language === "csv" || language === "tsv") return "table"
  if (language === "diff" || language === "patch") return "diff"
  if (language === "chart") return "chart"
  return "frame"
}

/** Diagrams and charts are the point of the block, so they open rendered. */
export function opensAsPreview(kind: PreviewKind): boolean {
  return (
    kind === "mermaid" ||
    kind === "graphviz" ||
    kind === "diff" ||
    kind === "chart"
  )
}

export type RunnerLanguage = "javascript" | "typescript" | "python" | "sql"

const runnerLanguages: Record<string, RunnerLanguage> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  python3: "python",
  sql: "sql",
  sqlite: "sql",
}

function languageOf(className: string | undefined): string | undefined {
  return /(?:^|\s)language-([\w-]+)/.exec(className ?? "")?.[1]?.toLowerCase()
}

/** Language tag of a fenced code block, from its `language-xyz` class. */
export const fenceLanguage = languageOf

/** Languages whose code blocks can be run in the browser sandbox. */
export function runnerLanguage(
  className: string | undefined
): RunnerLanguage | null {
  return runnerLanguages[languageOf(className) ?? ""] ?? null
}

/**
 * Network lockdown for previews: inline scripts/styles and a few well-known
 * script CDNs work, but nothing can call out (no fetch, forms, frames, images).
 */
const previewCSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src data: blob:",
  "media-src data: blob:",
].join("; ")

export function previewLanguage(className: string | undefined): string | null {
  const language = languageOf(className)
  return language && previewableLanguages.has(language) ? language : null
}

/** Models often forget the ```html tag; recognise full HTML documents. */
export function looksLikeHTML(code: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(code)
}

/** Preview language from the fence tag, or from the content for untagged HTML. */
export function resolvePreviewLanguage(
  className: string | undefined,
  code: string
): string | null {
  const tagged = previewLanguage(className)
  if (tagged) return tagged
  return languageOf(className) === undefined && looksLikeHTML(code)
    ? "html"
    : null
}

/** Embeds a string as a JS literal that is safe inside an inline script. */
export function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/** Reports the content height once the page has settled; used for auto-sizing. */
const heightReporter = `<script>(function(){function r(){parent.postMessage({type:"preview-height",height:Math.ceil(document.documentElement.scrollHeight)},"*")}addEventListener("load",function(){r();setTimeout(r,300);setTimeout(r,1200)})})()</script>`

const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${previewCSP}">`
const viewportMeta =
  '<meta name="viewport" content="width=device-width, initial-scale=1">'

const reactGlobals: Record<string, string> = {
  react: "React",
  "react-dom": "ReactDOM",
  "react-dom/client": "ReactDOM",
}

/**
 * Turns a React/TSX snippet into a script that runs without a bundler: react
 * imports map to the UMD globals, `export default` is removed, and the
 * component (App or the default export) is mounted unless the code mounts itself.
 */
export function prepareReactSource(code: string): string {
  let defaultName: string | null = null
  let source = code.replace(
    /^[ \t]*import\s+([^;]*?)\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
    (match, clause: string, module: string) => {
      const global = reactGlobals[module]
      if (!global) return match
      const named = /\{([^}]*)\}/.exec(clause)?.[1]
      if (!named) return ""
      const names = named
        .split(",")
        .map((part) => part.trim().replace(/\s+as\s+/, ": "))
        .filter(Boolean)
      return names.length ? `const { ${names.join(", ")} } = ${global};` : ""
    }
  )
  source = source.replace(
    /^[ \t]*export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/m,
    (match, name: string) => {
      defaultName = name
      return match.replace(/export\s+default\s+/, "")
    }
  )
  source = source.replace(/^[ \t]*export\s+default\s+(\w+)\s*;?[ \t]*$/m, (_m, name: string) => {
    defaultName ??= name
    return ""
  })
  source = source.replace(/^[ \t]*export\s+default\s+/m, () => {
    defaultName = "__Default"
    return "const __Default = "
  })
  source = source.replace(/^([ \t]*)export\s+(?=(?:const|let|var|function|class|type|interface|enum)\b)/gm, "$1")

  if (/\.render\s*\(/.test(source)) return source
  const candidates = [defaultName, "App"].filter(Boolean)
  const pick = candidates
    .map((name) => `typeof ${name} !== "undefined" ? ${name}`)
    .join(" : ")
  return `${source}\n;{ const __Component = ${pick} : undefined; if (__Component) ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(__Component)); else document.getElementById("root").textContent = "No App component found." }`
}

const reactCDN = "https://cdn.jsdelivr.net/npm"

export function buildReactPreviewDocument(code: string): string {
  const source = scriptLiteral(prepareReactSource(code))
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}${viewportMeta}<style>body{font-family:system-ui,sans-serif;margin:16px}pre.err{color:#c00;white-space:pre-wrap}</style></head><body><div id="root"></div><script src="${reactCDN}/react@18.3.1/umd/react.production.min.js"></script><script src="${reactCDN}/react-dom@18.3.1/umd/react-dom.production.min.js"></script><script src="${reactCDN}/@babel/standalone@7.26.4/babel.min.js"></script><script>
function showError(error) {
  const pre = document.createElement("pre")
  pre.className = "err"
  pre.textContent = String((error && error.message) || error)
  document.getElementById("root").replaceChildren(pre)
}
addEventListener("error", (event) => showError(event.error || event.message))
try {
  const output = Babel.transform(${source}, {
    presets: [["typescript", { isTSX: true, allExtensions: true }], "react"],
    filename: "app.tsx",
  }).code
  ;(0, eval)(output)
} catch (error) {
  showError(error)
}
</script>${heightReporter}</body></html>`
}

export function buildPreviewDocument(code: string, language: string): string {
  if (language === "jsx" || language === "tsx") {
    return buildReactPreviewDocument(code)
  }
  const body =
    language === "svg"
      ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body>`
      : code
  const isFullDocument = /<(?:!doctype|html|head|body)[\s>]/i.test(body)
  if (isFullDocument) {
    return `${cspMeta}${viewportMeta}${body}${heightReporter}`
  }
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}${viewportMeta}</head><body>${body}${heightReporter}</body></html>`
}

const fileExtensions: Record<string, string> = {
  python: "py",
  py: "py",
  javascript: "js",
  js: "js",
  mjs: "mjs",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  csv: "csv",
  tsv: "tsv",
  markdown: "md",
  md: "md",
  svg: "svg",
  sql: "sql",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  yaml: "yml",
  yml: "yml",
  xml: "xml",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  rust: "rs",
  rs: "rs",
  dot: "dot",
  mermaid: "mmd",
  diff: "diff",
}

/** File name for saving a code block, e.g. `code.py`. */
export function codeFileName(language: string | undefined): string {
  const key = (language ?? "").toLowerCase()
  return `code.${fileExtensions[key] ?? "txt"}`
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
