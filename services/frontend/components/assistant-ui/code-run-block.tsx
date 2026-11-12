"use client"

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { useCodeActions } from "@/components/assistant-ui/code-actions"
import { DelimitedTable } from "@/components/assistant-ui/data-previews"
import { useTranslations } from "@/components/locale-provider"
import type { RunnerLanguage } from "@/lib/code-preview"
import {
  buildRunnerDocument,
  parseRunnerMessage,
  runnerLimits,
  usesPythonInput,
} from "@/lib/code-runner"
import { cn } from "@/lib/utils"

type OutputItem =
  | { kind: "line"; level: "log" | "error" | "warn"; text: string }
  | { kind: "table"; csv: string }
  | { kind: "image"; src: string }
  | { kind: "file"; name: string; mime: string; data: string }

type RunState = {
  runId: number
  status: "idle" | "loading" | "running" | "done" | "error"
  items: OutputItem[]
  truncated: boolean
  error: string
}

const idleState: RunState = {
  runId: 0,
  status: "idle",
  items: [],
  truncated: false,
  error: "",
}

const lineClass = {
  log: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

const keepsSession = (language: RunnerLanguage) =>
  language === "python" || language === "sql"

const buttonClass =
  "rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring"

/**
 * Shows a code block with a Run button. The code executes in the isolated
 * runner iframe from `lib/code-runner.ts`, never in the app's own context.
 * Python and SQL keep their session between runs; the iframe stays mounted.
 */
export function CodeRunBlock({
  code,
  language,
  codeView,
}: {
  code: string
  language: RunnerLanguage
  codeView: ReactNode
}) {
  const { t } = useTranslations()
  const { sendMessage } = useCodeActions()
  const [state, setState] = useState<RunState>(idleState)
  const [stdin, setStdin] = useState("")
  const [mounted, setMounted] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const loadedRef = useRef(false)
  const pendingRef = useRef({ code, stdin })
  const srcDoc = useMemo(() => buildRunnerDocument(language), [language])
  const active = state.status === "loading" || state.status === "running"
  const needsInput = language === "python" && usesPythonInput(code)
  const sessionKept = keepsSession(language)

  useEffect(() => {
    if (state.runId === 0) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const message = parseRunnerMessage(event.data)
      if (!message) return
      setState((current) => {
        if (current.runId !== state.runId) return current
        const add = (item: OutputItem, limit?: number) =>
          limit !== undefined &&
          current.items.filter((entry) => entry.kind === item.kind).length >= limit
            ? current
            : { ...current, items: [...current.items, item] }
        switch (message.type) {
          case "status":
            return { ...current, status: message.text }
          case "log": {
            const lines = current.items.filter((entry) => entry.kind === "line")
            if (lines.length >= runnerLimits.maxOutputLines) {
              return { ...current, truncated: true }
            }
            return add({
              kind: "line",
              level:
                message.level === "error" || message.level === "warn"
                  ? message.level
                  : "log",
              text: message.text,
            })
          }
          case "image":
            return add({ kind: "image", src: message.src }, runnerLimits.maxImages)
          case "table":
            return add({ kind: "table", csv: message.csv }, 20)
          case "file":
            return add(
              {
                kind: "file",
                name: message.name,
                mime: message.mime,
                data: message.data,
              },
              runnerLimits.maxFiles
            )
          case "done":
            return { ...current, status: "done" }
          case "error": {
            const text =
              message.text === "timeout"
                ? t("The code ran for too long and was stopped.")
                : message.text.includes("EOFError")
                  ? `${message.text}\n\n${t("The program asked for more input than provided. Add one line per input() call above.")}`
                  : message.text
            return {
              ...current,
              status: "error",
              error: text,
              items: [...current.items, { kind: "line", level: "error", text }],
            }
          }
        }
      })
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [state.runId, t])

  const postRun = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "run", ...pendingRef.current },
      "*"
    )
  }, [])

  const run = useCallback(() => {
    pendingRef.current = { code, stdin }
    setState((current) => ({
      ...idleState,
      runId: current.runId + 1,
      status: "loading",
    }))
    if (loadedRef.current) postRun()
    else setMounted(true) // the iframe's onLoad sends the run request
  }, [code, stdin, postRun])

  const stop = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "stop" }, "*")
    setState((current) => ({ ...current, status: "done" }))
  }, [])

  const reset = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "reset" }, "*")
    setState((current) => ({ ...idleState, runId: current.runId }))
  }, [])

  const askForFix = () => {
    sendMessage?.(
      [
        t(
          "The following {value0} code failed with an error when run. Please fix it and show the corrected code.",
          { value0: language }
        ),
        "",
        "```" + language,
        code,
        "```",
        "",
        t("Error:"),
        "```",
        state.error,
        "```",
      ].join("\n")
    )
  }

  const hasOutput = state.items.length > 0

  return (
    <div className="my-3">
      {codeView}
      {needsInput && (
        <label className="mt-1 block text-xs text-muted-foreground">
          {t("Inputs for input() (one line per call)")}
          <textarea
            className="mt-1 block min-h-16 w-full resize-y rounded-lg bg-muted/50 p-2 font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            disabled={active}
            onChange={(event) => setStdin(event.target.value)}
            placeholder={t("e.g. 1\n-3\n2")}
            spellCheck={false}
            value={stdin}
          />
        </label>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          className={cn(
            buttonClass,
            "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
          onClick={active ? stop : run}
          type="button"
        >
          {active ? t("Stop") : t("Run")}
        </button>
        {sessionKept && state.runId > 0 && !active && (
          <button
            className={cn(buttonClass, "text-muted-foreground hover:text-foreground")}
            onClick={reset}
            type="button"
          >
            {t("Reset session")}
          </button>
        )}
        {state.status === "error" && sendMessage && (
          <button
            className={cn(buttonClass, "bg-destructive/10 text-destructive hover:bg-destructive/20")}
            onClick={askForFix}
            type="button"
          >
            {t("Fix error")}
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          {state.status === "loading"
            ? language === "python"
              ? t("Loading Python…")
              : t("Loading…")
            : state.status === "idle"
              ? t("Runs in an isolated sandbox in your browser.")
              : state.status === "running"
                ? t("Running…")
                : null}
        </span>
      </div>
      {mounted && (
        // No allow-same-origin: the frame gets an opaque origin without access
        // to cookies, storage or the JustAI API.
        <iframe
          className="hidden"
          onLoad={() => {
            loadedRef.current = true
            postRun()
          }}
          ref={frameRef}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          tabIndex={-1}
          title={t("Output")}
        />
      )}
      {(hasOutput || state.status === "done") && (
        <div
          aria-label={t("Output")}
          className="mt-2 space-y-2 rounded-xl bg-muted/50 p-3 font-mono text-xs leading-5"
          role="log"
        >
          {state.items.map((item, index) => {
            switch (item.kind) {
              case "line":
                return (
                  <pre
                    className={cn("whitespace-pre-wrap break-words", lineClass[item.level])}
                    key={index}
                  >
                    {item.text}
                  </pre>
                )
              case "table":
                return (
                  <DelimitedTable
                    code={item.csv}
                    delimiter=","
                    key={index}
                    language="csv"
                  />
                )
              case "image":
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={`${t("Output")} ${index + 1}`}
                    className="max-w-full rounded-lg bg-white"
                    key={index}
                    src={item.src}
                  />
                )
              case "file":
                return (
                  <a
                    className="inline-block rounded-md bg-primary px-2 py-1 font-sans text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    download={item.name}
                    href={`data:${item.mime};base64,${item.data}`}
                    key={index}
                  >
                    {t("Download {value0}", { value0: item.name })}
                  </a>
                )
            }
          })}
          {state.truncated && <p className="text-muted-foreground">…</p>}
          {!hasOutput && (
            <p className="text-muted-foreground">{t("No output")}</p>
          )}
        </div>
      )}
    </div>
  )
}
