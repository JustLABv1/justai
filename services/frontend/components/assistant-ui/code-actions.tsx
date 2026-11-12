"use client"

import { createContext, useContext } from "react"

/**
 * Actions that code blocks can trigger in the surrounding chat. They are only
 * provided inside a live thread; static renderings leave them undefined.
 */
export type CodeActions = {
  /** Sends a message as the user, e.g. to ask the model to fix a failing script. */
  sendMessage?: (text: string) => void
}

const CodeActionsContext = createContext<CodeActions>({})

export const CodeActionsProvider = CodeActionsContext.Provider

export function useCodeActions(): CodeActions {
  return useContext(CodeActionsContext)
}

/** Message asking the model to repair a program that failed when run. */
export function buildFixPrompt(
  t: (text: string, values?: Record<string, string>) => string,
  language: string,
  code: string,
  error: string
): string {
  return [
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
    error,
    "```",
  ].join("\n")
}
