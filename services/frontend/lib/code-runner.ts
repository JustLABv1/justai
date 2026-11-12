import type { RunnerLanguage } from "./code-preview"

/**
 * Browser sandbox for running generated code.
 *
 * The code runs inside a Web Worker that lives in a `sandbox="allow-scripts"`
 * iframe without `allow-same-origin`. The iframe has an opaque origin, so the
 * code can neither read JustAI cookies/storage nor call the JustAI API, and the
 * Content-Security-Policy below blocks all network access except the Pyodide
 * CDN (Python only). The worker can be terminated at any time, so endless
 * loops are stopped by the timeout.
 */

/** True when Python code reads from stdin, so the UI can ask for inputs. */
export function usesPythonInput(code: string): boolean {
  return /(?<![\w.])input\s*\(/.test(code)
}

export const pyodideVersion = "0.27.7"
export const pyodideBaseURL = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`

export const runnerLimits = {
  javascriptTimeoutMs: 10_000,
  pythonTimeoutMs: 90_000,
  maxOutputLines: 500,
  maxLineChars: 4_000,
  maxImages: 6,
} as const

export type RunnerMessage =
  | { type: "status"; text: "loading" | "running" }
  | { type: "log"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
  | { type: "image"; src: string }
  | { type: "done" }
  | { type: "error"; text: string }

const logLevels = new Set(["log", "info", "warn", "error", "debug"])
const imagePattern = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/

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

const javascriptWorker = `
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
self.onmessage = async (event) => {
  postMessage({ type: "status", text: "running" })
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await new AsyncFunction(event.data.code)()
    postMessage({ type: "done" })
  } catch (error) {
    postMessage({ type: "error", text: String((error && error.stack) || error) })
  }
}
`

const pythonWorker = `
let pyodidePromise
// Drop Pyodide's own frames and keep the ones from the user's code.
function cleanTraceback(message) {
  const start = message.indexOf('  File "<exec>"')
  return start > 0 ? "Traceback (most recent call last):\\n" + message.slice(start) : message
}
const figures = \`
import io, base64
import matplotlib.pyplot as plt
_images = []
for _n in plt.get_fignums():
    _buffer = io.BytesIO()
    plt.figure(_n).savefig(_buffer, format="png", dpi=100, bbox_inches="tight")
    _images.append(base64.b64encode(_buffer.getvalue()).decode())
plt.close("all")
_images
\`
self.onmessage = async (event) => {
  try {
    if (!pyodidePromise) {
      postMessage({ type: "status", text: "loading" })
      importScripts("${pyodideBaseURL}pyodide.js")
      pyodidePromise = loadPyodide({ indexURL: "${pyodideBaseURL}" })
    }
    const pyodide = await pyodidePromise
    pyodide.setStdout({ batched: (text) => postMessage({ type: "log", level: "log", text }) })
    pyodide.setStderr({ batched: (text) => postMessage({ type: "log", level: "error", text }) })
    // There is no keyboard in the sandbox: input() reads the lines the user
    // typed beforehand and hits EOF (EOFError) once they are used up.
    const lines = String(event.data.stdin || "").split("\\n")
    if (lines[lines.length - 1] === "") lines.pop()
    pyodide.setStdin({ stdin: () => (lines.length ? lines.shift() : undefined) })
    const code = event.data.code
    await pyodide.loadPackagesFromImports(code)
    postMessage({ type: "status", text: "running" })
    const usesPlots = /matplotlib/.test(code)
    if (usesPlots) await pyodide.runPythonAsync("import matplotlib\\nmatplotlib.use('agg')")
    await pyodide.runPythonAsync(code)
    if (usesPlots) {
      const images = await pyodide.runPythonAsync(figures)
      for (const base64 of images.toJs().slice(0, ${runnerLimits.maxImages})) {
        postMessage({ type: "image", src: "data:image/png;base64," + base64 })
      }
    }
    postMessage({ type: "done" })
  } catch (error) {
    postMessage({ type: "error", text: cleanTraceback(String((error && error.message) || error)) })
  }
}
`

function csp(language: RunnerLanguage): string {
  const connect =
    language === "python" ? "connect-src https://cdn.jsdelivr.net" : "connect-src 'none'"
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net blob:",
    "worker-src blob:",
    connect,
  ].join("; ")
}

/** Embeds a string as a JS literal that is safe inside an inline script. */
function literal(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/** Document for the hidden runner iframe; it waits for a `run` message. */
export function buildRunnerDocument(language: RunnerLanguage): string {
  const timeout =
    language === "python"
      ? runnerLimits.pythonTimeoutMs
      : runnerLimits.javascriptTimeoutMs
  const source = language === "python" ? pythonWorker : javascriptWorker
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(language)}"></head><body><script>
const WORKER_SOURCE = ${literal(source)}
let worker
let timer
const send = (message) => parent.postMessage(message, "*")
function stop() {
  clearTimeout(timer)
  if (worker) worker.terminate()
  worker = undefined
}
addEventListener("message", (event) => {
  if (event.source !== parent || !event.data) return
  if (event.data.type === "stop") return stop()
  if (event.data.type !== "run" || worker) return
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }))
  worker = new Worker(url)
  worker.onmessage = (message) => {
    send(message.data)
    if (message.data && (message.data.type === "done" || message.data.type === "error")) stop()
  }
  worker.onerror = (error) => {
    send({ type: "error", text: error.message || "The code could not be run." })
    stop()
  }
  timer = setTimeout(() => {
    stop()
    send({ type: "error", text: "timeout" })
  }, ${timeout})
  worker.postMessage({ code: String(event.data.code), stdin: String(event.data.stdin || "") })
})
</script></body></html>`
}
