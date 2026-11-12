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
