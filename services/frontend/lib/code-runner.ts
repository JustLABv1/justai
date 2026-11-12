import { type RunnerLanguage, scriptLiteral } from "./code-preview.ts"

/**
 * Browser sandbox for running generated code.
 *
 * The code runs inside a Web Worker that lives in a `sandbox="allow-scripts"`
 * iframe without `allow-same-origin`. The iframe has an opaque origin, so the
 * code can neither read JustAI cookies/storage nor call the JustAI API, and the
 * Content-Security-Policy below blocks all network access except the CDN the
 * runtimes load from. The worker can be terminated at any time, so endless
 * loops are stopped by the timeout.
 *
 * Python and SQL keep their worker (and with it variables, tables and files)
 * between runs; JavaScript and TypeScript start fresh every time.
 */

/** True when Python code reads from stdin, so the UI can ask for inputs. */
export function usesPythonInput(code: string): boolean {
  return /(?<![\w.])input\s*\(/.test(code)
}

export const pyodideVersion = "0.27.7"
export const pyodideBaseURL = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`
const sqlJsBaseURL = "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/"
const babelURL = "https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js"

export const runnerLimits = {
  javascriptTimeoutMs: 10_000,
  typescriptTimeoutMs: 30_000,
  sqlTimeoutMs: 30_000,
  pythonTimeoutMs: 90_000,
  maxOutputLines: 500,
  maxLineChars: 4_000,
  maxImages: 6,
  maxFiles: 3,
  maxFileBytes: 2_000_000,
  maxCsvChars: 200_000,
} as const

const persistentLanguages: ReadonlySet<RunnerLanguage> = new Set([
  "python",
  "sql",
])

export type RunnerMessage =
  | { type: "status"; text: "loading" | "running" }
  | { type: "log"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
  | { type: "image"; src: string }
  | { type: "table"; csv: string }
  | { type: "file"; name: string; mime: string; data: string }
  | { type: "done" }
  | { type: "error"; text: string }

const logLevels = new Set(["log", "info", "warn", "error", "debug"])
const imagePattern = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/
const fileNamePattern = /^[\w][\w .-]{0,99}$/
const base64Pattern = /^[A-Za-z0-9+/=]*$/
// Never let the sandbox pick a type a browser would render (html, svg, js).
const safeFileTypes = new Set([
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
  "image/png",
])

/** Validates data coming from the sandbox; it is untrusted by definition. */
export function parseRunnerMessage(data: unknown): RunnerMessage | null {
  if (typeof data !== "object" || data === null) return null
  const message = data as Record<string, unknown>
  switch (message.type) {
    case "status":
      return message.text === "loading" || message.text === "running"
        ? { type: "status", text: message.text }
        : null
    case "log":
      if (typeof message.text !== "string") return null
      return {
        type: "log",
        level: logLevels.has(String(message.level))
          ? (message.level as "log")
          : "log",
        text: message.text.slice(0, runnerLimits.maxLineChars),
      }
    case "image":
      return typeof message.src === "string" && imagePattern.test(message.src)
        ? { type: "image", src: message.src }
        : null
    case "table":
      return typeof message.csv === "string"
        ? { type: "table", csv: message.csv.slice(0, runnerLimits.maxCsvChars) }
        : null
    case "file": {
      const { name, mime, data: content } = message
      if (
        typeof name !== "string" ||
        typeof mime !== "string" ||
        typeof content !== "string" ||
        !fileNamePattern.test(name) ||
        !base64Pattern.test(content) ||
        content.length > runnerLimits.maxFileBytes * 1.4
      ) {
        return null
      }
      return {
        type: "file",
        name,
        mime: safeFileTypes.has(mime) ? mime : "application/octet-stream",
        data: content,
      }
    }
    case "done":
      return { type: "done" }
    case "error":
      return typeof message.text === "string"
        ? { type: "error", text: message.text.slice(0, runnerLimits.maxLineChars) }
        : null
    default:
      return null
  }
}

// The worker sources are plain strings that run inside the sandbox.
// String.raw keeps the backslashes, so escapes like \n are written once.

function javascriptWorker(typescript: boolean): string {
  return String.raw`
const format = (value) => {
  if (typeof value === "string") return value
  try {
    return typeof value === "object" && value !== null
      ? JSON.stringify(value, null, 2)
      : String(value)
  } catch {
    return String(value)
  }
}
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) =>
    postMessage({ type: "log", level, text: args.map(format).join(" ") })
}
const TYPESCRIPT = ${typescript}
self.onmessage = async (event) => {
  try {
    let code = event.data.code
    if (TYPESCRIPT) {
      postMessage({ type: "status", text: "loading" })
      importScripts("${babelURL}")
      code = Babel.transform(code, {
        presets: [["typescript", { allExtensions: true }]],
        filename: "main.ts",
      }).code.replace(/^\s*export\s+/gm, "")
    }
    postMessage({ type: "status", text: "running" })
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await new AsyncFunction(code)()
    postMessage({ type: "done" })
  } catch (error) {
    postMessage({ type: "error", text: String((error && error.stack) || error) })
  }
}
`
}

const pythonWorker = String.raw`
let pyodidePromise
const HOME = "/home/pyodide"
const MIME = { csv: "text/csv", txt: "text/plain", json: "application/json", png: "image/png", md: "text/markdown" }
const FIGURES = [
  "import io, base64",
  "import matplotlib.pyplot as plt",
  "_images = []",
  "for _n in plt.get_fignums():",
  "    _buffer = io.BytesIO()",
  "    plt.figure(_n).savefig(_buffer, format='png', dpi=100, bbox_inches='tight')",
  "    _images.append(base64.b64encode(_buffer.getvalue()).decode())",
  "plt.close('all')",
  "_images",
].join("\n")
const TO_CSV = [
  "def _to_csv(obj):",
  "    import pandas as pd",
  "    if isinstance(obj, pd.Series):",
  "        obj = obj.to_frame()",
  "    return obj.head(500).to_csv(index=not isinstance(obj.index, pd.RangeIndex))",
  "_to_csv",
].join("\n")

// Drop Pyodide's own frames and keep the ones from the user's code.
function cleanTraceback(message) {
  const start = message.indexOf('  File "<exec>"')
  return start > 0 ? "Traceback (most recent call last):\n" + message.slice(start) : message
}

function snapshot(pyodide) {
  const result = {}
  try {
    for (const name of pyodide.FS.readdir(HOME)) {
      if (name === "." || name === "..") continue
      const stat = pyodide.FS.stat(HOME + "/" + name)
      if (pyodide.FS.isFile(stat.mode)) result[name] = stat.mtime.getTime() + ":" + stat.size
    }
  } catch {}
  return result
}

function toBase64(bytes) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// Like a notebook: show the value of the last expression (DataFrames as a table).
function showResult(pyodide, result) {
  if (result === undefined || result === null) return
  if (typeof result === "object" && (result.type === "DataFrame" || result.type === "Series")) {
    postMessage({ type: "table", csv: pyodide.runPython(TO_CSV)(result) })
  } else {
    postMessage({ type: "log", level: "log", text: String(result) })
  }
  if (typeof result.destroy === "function") result.destroy()
}

self.onmessage = async (event) => {
  try {
    if (!pyodidePromise) {
      postMessage({ type: "status", text: "loading" })
      importScripts("${pyodideBaseURL}pyodide.js")
      pyodidePromise = loadPyodide({ indexURL: "${pyodideBaseURL}" })
    }
    const pyodide = await pyodidePromise
    pyodide.setStdout({ batched: (text) => postMessage({ type: "log", level: "log", text }) })
    pyodide.setStderr({
      batched: (text) => {
        if (!text.startsWith("Matplotlib is building the font cache")) {
          postMessage({ type: "log", level: "error", text })
        }
      },
    })
    // There is no keyboard in the sandbox: input() reads the lines the user
    // typed beforehand and hits EOF (EOFError) once they are used up.
    const lines = String(event.data.stdin || "").split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    pyodide.setStdin({ stdin: () => (lines.length ? lines.shift() : undefined) })
    const code = event.data.code
    // Package downloads are reported through the status line, not the output.
    await pyodide.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} })
    postMessage({ type: "status", text: "running" })
    const before = snapshot(pyodide)
    const usesPlots = /matplotlib/.test(code)
    if (usesPlots) await pyodide.runPythonAsync("import matplotlib\nmatplotlib.use('agg')")
    showResult(pyodide, await pyodide.runPythonAsync(code))
    if (usesPlots) {
      const images = await pyodide.runPythonAsync(FIGURES)
      for (const base64 of images.toJs().slice(0, ${runnerLimits.maxImages})) {
        postMessage({ type: "image", src: "data:image/png;base64," + base64 })
      }
    }
    // Files the code wrote to its working directory become downloads.
    const after = snapshot(pyodide)
    let sent = 0
    for (const name of Object.keys(after)) {
      if (before[name] === after[name] || sent >= ${runnerLimits.maxFiles}) continue
      const bytes = pyodide.FS.readFile(HOME + "/" + name)
      if (bytes.length > ${runnerLimits.maxFileBytes}) continue
      const extension = name.split(".").pop().toLowerCase()
      postMessage({ type: "file", name, mime: MIME[extension] || "application/octet-stream", data: toBase64(bytes) })
      sent += 1
    }
    postMessage({ type: "done" })
  } catch (error) {
    postMessage({ type: "error", text: cleanTraceback(String((error && error.message) || error)) })
  }
}
`

const sqlWorker = String.raw`
let databasePromise
function cell(value) {
  const text = value === null ? "NULL" : String(value)
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}
function toCsv(columns, rows) {
  return [columns, ...rows.slice(0, 500)].map((row) => row.map(cell).join(",")).join("\n")
}
self.onmessage = async (event) => {
  try {
    if (!databasePromise) {
      postMessage({ type: "status", text: "loading" })
      importScripts("${sqlJsBaseURL}sql-wasm.js")
      databasePromise = initSqlJs({ locateFile: (file) => "${sqlJsBaseURL}" + file }).then((SQL) => new SQL.Database())
    }
    const database = await databasePromise
    postMessage({ type: "status", text: "running" })
    const results = database.exec(event.data.code)
    for (const result of results) {
      postMessage({ type: "table", csv: toCsv(result.columns, result.values) })
    }
    if (results.length === 0) {
      postMessage({ type: "log", level: "log", text: "OK" })
    }
    postMessage({ type: "done" })
  } catch (error) {
    postMessage({ type: "error", text: String((error && error.message) || error) })
  }
}
`

function workerSource(language: RunnerLanguage): string {
  switch (language) {
    case "python":
      return pythonWorker
    case "sql":
      return sqlWorker
    case "typescript":
      return javascriptWorker(true)
    default:
      return javascriptWorker(false)
  }
}

function timeoutFor(language: RunnerLanguage): number {
  switch (language) {
    case "python":
      return runnerLimits.pythonTimeoutMs
    case "sql":
      return runnerLimits.sqlTimeoutMs
    case "typescript":
      return runnerLimits.typescriptTimeoutMs
    default:
      return runnerLimits.javascriptTimeoutMs
  }
}

function csp(language: RunnerLanguage): string {
  const connect =
    language === "python" || language === "sql"
      ? "connect-src https://cdn.jsdelivr.net"
      : "connect-src 'none'"
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net blob:",
    "worker-src blob:",
    connect,
  ].join("; ")
}

/**
 * Document for the hidden runner iframe. It waits for `run`, `stop` and
 * `reset` messages from the page that embeds it.
 */
export function buildRunnerDocument(language: RunnerLanguage): string {
  const persist = persistentLanguages.has(language)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(language)}"></head><body><script>
const WORKER_SOURCE = ${scriptLiteral(workerSource(language))}
const PERSIST = ${persist}
const TIMEOUT = ${timeoutFor(language)}
let worker
let timer
let busy = false
const send = (message) => parent.postMessage(message, "*")
function stop() {
  clearTimeout(timer)
  if (worker) worker.terminate()
  worker = undefined
  busy = false
}
function finish() {
  clearTimeout(timer)
  busy = false
  if (!PERSIST) stop()
}
addEventListener("message", (event) => {
  if (event.source !== parent || !event.data) return
  if (event.data.type === "stop" || event.data.type === "reset") return stop()
  if (event.data.type !== "run" || busy) return
  busy = true
  if (!worker) {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }))
    worker = new Worker(url)
    worker.onmessage = (message) => {
      send(message.data)
      if (message.data && (message.data.type === "done" || message.data.type === "error")) finish()
    }
    worker.onerror = (error) => {
      send({ type: "error", text: error.message || "The code could not be run." })
      stop()
    }
  }
  timer = setTimeout(() => {
    stop()
    send({ type: "error", text: "timeout" })
  }, TIMEOUT)
  worker.postMessage({ code: String(event.data.code), stdin: String(event.data.stdin || "") })
})
</script></body></html>`
}
