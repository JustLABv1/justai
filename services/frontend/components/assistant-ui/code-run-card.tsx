"use client"

import { useAui } from "@assistant-ui/react"
import { useEffect, useState } from "react"

import { buildFixPrompt } from "@/components/assistant-ui/code-actions"
import {
  CodeShell,
  CollapsibleCode,
  ShellButton,
  TerminalPanel,
} from "@/components/assistant-ui/code-shell"
import { GeneratedFileCard } from "@/components/assistant-ui/tool-fallback"
import { useTranslations } from "@/components/locale-provider"
import { api } from "@/lib/api"
import { runCommand } from "@/lib/code-preview"
import {
  type GeneratedFileResult,
  codeRunSucceeded,
  isImageFile,
  parseCodeRunResult,
} from "@/lib/file-result-logic"
import { cn } from "@/lib/utils"

/** A stored image from a run, fetched with the user's session. */
function RunImage({ file }: { file: GeneratedFileResult }) {
  const { t } = useTranslations()
  const [state, setState] = useState<{ url: string; src?: string }>({ url: "" })

  useEffect(() => {
    let objectURL = ""
    let active = true
    const controller = new AbortController()
    void api
      .getBlob(file.url, { signal: controller.signal })
      .then((blob) => {
        objectURL = URL.createObjectURL(blob)
        if (active) setState({ url: file.url, src: objectURL })
        else URL.revokeObjectURL(objectURL)
      })
      .catch(() => {
        if (active) setState({ url: file.url })
      })
    return () => {
      active = false
      controller.abort()
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [file.url])

  if (state.url !== file.url) {
    return (
      <div
        aria-hidden="true"
        className="h-48 w-full animate-pulse rounded-lg bg-muted"
      />
    )
  }
  if (!state.src) {
    return (
      <p className="text-xs text-destructive" role="alert">
        {t("The image could not be loaded.")}
      </p>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={file.title}
      className="max-h-96 max-w-full rounded-lg bg-white"
      src={state.src}
    />
  )
}

/**
 * What the model's `run_code` call produced: the program, its output, charts
 * and files, shown like a terminal session. The code ran in the isolated
 * code-runner service on the server.
 */
export function CodeRunCard({
  code,
  value,
}: {
  code?: string
  value: unknown
}) {
  const { t } = useTranslations()
  const aui = useAui()
  const run = parseCodeRunResult(value)
  if (!run) return null

  const succeeded = codeRunSucceeded(run)
  const images = run.files.filter(isImageFile)
  const otherFiles = run.files.filter((file) => !isImageFile(file))
  const hasOutput = run.stdout.trim() !== "" || run.stderr.trim() !== ""
  const seconds = (run.durationMs / 1000).toFixed(run.durationMs < 10_000 ? 1 : 0)

  const askForFix = () => {
    const error = run.timedOut
      ? t("The code ran for too long and was stopped.")
      : run.stderr.trim() || `exit code ${run.exitCode ?? "?"}`
    const composer = aui.thread.composer()
    composer.setText(buildFixPrompt(t, run.language, code ?? "", error))
    composer.send()
  }

  return (
    <CodeShell
      actions={
        !succeeded && (
          <ShellButton onClick={askForFix} variant="danger">
            {t("Fix error")}
          </ShellButton>
        )
      }
      code={code ?? ""}
      footer={
        <TerminalPanel command={runCommand(run.language)} label={t("Output")}>
          {run.stdout.trim() !== "" && (
            <pre className="m-0! rounded-none! border-0! bg-transparent! p-0! text-xs! whitespace-pre-wrap break-words text-foreground">
              {run.stdout}
            </pre>
          )}
          {run.stderr.trim() !== "" && (
            <pre className="m-0! rounded-none! border-0! bg-transparent! p-0! text-xs! whitespace-pre-wrap break-words text-destructive">
              {run.stderr}
            </pre>
          )}
          {!hasOutput && images.length === 0 && otherFiles.length === 0 && (
            <p className="text-muted-foreground">{t("No output")}</p>
          )}
          {run.truncated && (
            <p className="text-muted-foreground">
              {t("The output was shortened.")}
            </p>
          )}
          {images.map((file) => (
            <RunImage file={file} key={file.url} />
          ))}
          {otherFiles.map((file) => (
            <div className="font-sans" key={file.url}>
              <GeneratedFileCard value={{ file }} />
            </div>
          ))}
          <p
            className={cn(
              "select-none",
              succeeded
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive"
            )}
          >
            {run.timedOut
              ? `✗ ${t("Timed out")}`
              : succeeded
                ? `✓ ${t("Finished in {value0} s", { value0: seconds })}`
                : `✗ ${t("Exit code {value0}", { value0: String(run.exitCode ?? "?") })}`}
          </p>
        </TerminalPanel>
      }
      language={run.language}
    >
      {code ? <CollapsibleCode code={code} /> : null}
    </CodeShell>
  )
}
