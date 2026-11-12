"use client"

import { Play, RotateCcw, Square } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  buildFixPrompt,
  useCodeActions,
} from "@/components/assistant-ui/code-actions"
import {
  CodeShell,
  CollapsibleCode,
  ShellButton,
  TerminalPanel,
} from "@/components/assistant-ui/code-shell"
import { DelimitedTable } from "@/components/assistant-ui/data-previews"
import { Spinner } from "@/components/panelui/spinner"
import { useTranslations } from "@/components/locale-provider"
import { type RunnerLanguage, runCommand } from "@/lib/code-preview"
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
  startedAt: number
  durationMs: number
}

const idleState: RunState = {
  runId: 0,
  status: "idle",
  items: [],
  truncated: false,
  error: "",
  startedAt: 0,
  durationMs: 0,
}

const lineClass = {
  log: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

const keepsSession = (language: RunnerLanguage) =>
  language === "python" || language === "sql"

/**
 * A runnable code block: terminal-style card with a Run button in the title
 * bar and the output underneath. The code executes in the isolated runner
 * iframe from `lib/code-runner.ts`, never in the app's own context. Python and
 * SQL keep their session between runs; the iframe stays mounted.
 */
export function CodeRunBlock({
  code,
  language,
}: {
  code: string
  language: RunnerLanguage
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
        const elapsed = Date.now() - current.startedAt
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
            return { ...current, status: "done", durationMs: elapsed }
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
              durationMs: elapsed,
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
      startedAt: Date.now(),
    }))
    if (loadedRef.current) postRun()
    else setMounted(true) // the iframe's onLoad sends the run request
  }, [code, stdin, postRun])

  const stop = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "stop" }, "*")
    setState((current) => ({
      ...current,
      status: "done",
      durationMs: Date.now() - current.startedAt,
    }))
  }, [])

  const reset = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "reset" }, "*")
    setState((current) => ({ ...idleState, runId: current.runId }))
  }, [])

  const askForFix = () => {
    sendMessage?.(buildFixPrompt(t, language, code, state.error))
  }

  const seconds = (state.durationMs / 1000).toFixed(
    state.durationMs < 10_000 ? 1 : 0
  )

  const actions = (
    <>
      {state.status === "error" && sendMessage && (
        <ShellButton onClick={askForFix} variant="danger">
          {t("Fix error")}
        </ShellButton>
      )}
      {sessionKept && state.runId > 0 && !active && (
        <ShellButton
          aria-label={t("Reset session")}
          onClick={reset}
          title={t("Reset session")}
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
        </ShellButton>
      )}
      <ShellButton
        onClick={active ? stop : run}
        title={t("Runs in an isolated sandbox in your browser.")}
        variant="primary"
      >
        {active ? (
          <Square aria-hidden="true" className="size-3 fill-current" />
        ) : (
          <Play aria-hidden="true" className="size-3 fill-current" />
        )}
        {active ? t("Stop") : t("Run")}
      </ShellButton>
    </>
  )

  const footer =
    state.status === "idle" ? null : (
      <TerminalPanel command={runCommand(language)} label={t("Output")}>
        {state.items.map((item, index) => {
          switch (item.kind) {
            case "line":
              return (
                <pre
                  className={cn(
                    "m-0! rounded-none! border-0! bg-transparent! p-0! text-xs! whitespace-pre-wrap break-words",
                    lineClass[item.level]
                  )}
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
        {state.status === "done" && state.items.length === 0 && (
          <p className="text-muted-foreground">{t("No output")}</p>
        )}
        <p
          className={cn(
            "flex items-center gap-1.5 text-muted-foreground select-none",
            state.status === "error" && "text-destructive",
            state.status === "done" && "text-emerald-600 dark:text-emerald-400"
          )}
        >
          {active ? (
            <>
              <Spinner aria-hidden="true" className="size-3" />
              {state.status === "loading" && language === "python"
                ? t("Loading Python…")
                : state.status === "loading"
                  ? t("Loading…")
                  : t("Running…")}
            </>
          ) : state.status === "error" ? (
            <>✗ {t("Failed")}</>
          ) : (
            <>✓ {t("Finished in {value0} s", { value0: seconds })}</>
          )}
        </p>
      </TerminalPanel>
    )

  return (
    <CodeShell actions={actions} code={code} footer={footer} language={language}>
      <CollapsibleCode code={code} />
      {needsInput && (
        <label className="block px-3 pb-2 text-xs text-muted-foreground">
          {t("Inputs for input() (one line per call)")}
          <textarea
            className="mt-1 block min-h-16 w-full resize-y rounded-lg bg-background/60 p-2 font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            disabled={active}
            onChange={(event) => setStdin(event.target.value)}
            placeholder={t("e.g. 1\n-3\n2")}
            spellCheck={false}
            value={stdin}
          />
        </label>
      )}
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
    </CodeShell>
  )
}
