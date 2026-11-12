"use client"

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import type { RunnerLanguage } from "@/lib/code-preview"
import {
  buildRunnerDocument,
  parseRunnerMessage,
  runnerLimits,
  usesPythonInput,
} from "@/lib/code-runner"
import { cn } from "@/lib/utils"

type OutputLine = { kind: "log" | "error" | "warn"; text: string }

type RunState = {
  runId: number
  status: "idle" | "loading" | "running" | "done" | "error"
  lines: OutputLine[]
  images: string[]
  truncated: boolean
}

const idleState: RunState = {
  runId: 0,
  status: "idle",
  lines: [],
  images: [],
  truncated: false,
}

const lineClass: Record<OutputLine["kind"], string> = {
  log: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

/**
 * Shows a code block with a Run button. The code executes in the isolated
 * runner iframe from `lib/code-runner.ts`, never in the app's own context.
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
  const [state, setState] = useState<RunState>(idleState)
  const [stdin, setStdin] = useState("")
  const frameRef = useRef<HTMLIFrameElement>(null)
  const active = state.status === "loading" || state.status === "running"
  const needsInput = language === "python" && usesPythonInput(code)

  useEffect(() => {
    if (state.runId === 0) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const message = parseRunnerMessage(event.data)
      if (!message) return
      setState((current) => {
        if (current.runId !== state.runId) return current
        switch (message.type) {
          case "status":
            return { ...current, status: message.text }
          case "log": {
            if (current.lines.length >= runnerLimits.maxOutputLines) {
              return { ...current, truncated: true }
            }
            const kind =
              message.level === "error"
                ? "error"
                : message.level === "warn"
                  ? "warn"
                  : "log"
            return {
              ...current,
              lines: [...current.lines, { kind, text: message.text }],
            }
          }
          case "image":
            return current.images.length >= runnerLimits.maxImages
              ? current
              : { ...current, images: [...current.images, message.src] }
          case "done":
            return { ...current, status: "done" }
          case "error":
            return {
              ...current,
              status: "error",
              lines: [
                ...current.lines,
                {
                  kind: "error",
                  text:
                    message.text === "timeout"
                      ? t("The code ran for too long and was stopped.")
                      : message.text.includes("EOFError")
                        ? `${message.text}\n\n${t("The program asked for more input than provided. Add one line per input() call above.")}`
                        : message.text,
                },
              ],
            }
        }
      })
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [state.runId, t])

  const run = useCallback(() => {
    setState((current) => ({
      ...idleState,
      runId: current.runId + 1,
      status: "loading",
    }))
  }, [])

  const stop = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "stop" }, "*")
    setState((current) => ({ ...current, status: "done" }))
  }, [])

  const hasOutput = state.lines.length > 0 || state.images.length > 0

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
      <div className="mt-1 flex items-center gap-2">
        <button
          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={active ? stop : run}
          type="button"
        >
          {active ? t("Stop") : t("Run")}
        </button>
        <span className="text-xs text-muted-foreground">
          {state.status === "loading" && language === "python"
            ? t("Loading Python…")
            : state.status === "idle"
              ? t("Runs in an isolated sandbox in your browser.")
              : active
                ? t("Running…")
                : null}
        </span>
      </div>
      {state.runId > 0 && (
        // No allow-same-origin: the frame gets an opaque origin without access
        // to cookies, storage or the JustAI API.
        <iframe
          className="hidden"
          key={state.runId}
          ref={frameRef}
          sandbox="allow-scripts"
          srcDoc={buildRunnerDocument(language)}
          tabIndex={-1}
          title={t("Output")}
          onLoad={() =>
            frameRef.current?.contentWindow?.postMessage(
              { type: "run", code, stdin },
              "*"
            )
          }
        />
      )}
      {(hasOutput || state.status === "done") && (
        <div
          aria-label={t("Output")}
          className="mt-2 space-y-2 rounded-xl bg-muted/50 p-3 font-mono text-xs leading-5"
          role="log"
        >
          {state.lines.map((line, index) => (
            <pre
              className={cn("whitespace-pre-wrap break-words", lineClass[line.kind])}
              key={index}
            >
              {line.text}
            </pre>
          ))}
          {state.truncated && <p className="text-muted-foreground">…</p>}
          {state.images.map((src, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={`${t("Output")} ${index + 1}`}
              className="max-w-full rounded-lg bg-white"
              key={index}
              src={src}
            />
          ))}
          {!hasOutput && (
            <p className="text-muted-foreground">{t("No output")}</p>
          )}
        </div>
      )}
    </div>
  )
}
