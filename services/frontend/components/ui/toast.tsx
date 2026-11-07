"use client"

import { Toast, createToaster } from "@/components/panelui/toast"
import { resolveLocale } from "@/lib/i18n/locale"
import { translate } from "@/lib/i18n/translate"

const manager = createToaster()
type ToastOptions = Parameters<typeof manager.add>[0]
const recent: Array<{ text: string; at: number; id: string }> = []

/** Compatibility entry point: every existing notification uses PanelUI. */
export const toast = {
  ...manager,
  add(options: ToastOptions) {
    const locale = resolveLocale(
      typeof document === "undefined" ? null : document.documentElement.lang
    )
    const localize = (value: ToastOptions["title"]) =>
      typeof value === "string" ? translate(locale, value) : value
    const title = localize(options.title)
    const description = localize(options.description)
    const text =
      typeof description === "string" && description
        ? description
        : typeof title === "string"
          ? title
          : ""
    const now = Date.now()
    // Some legacy actions report the same error via both feedback and page state.
    const duplicate =
      text &&
      recent.find((entry) => entry.text === text && now - entry.at < 1000)
    if (duplicate) return duplicate.id
    const id = manager.add({
      ...options,
      title,
      description,
      type: options.type === "error" ? "destructive" : options.type,
    })
    if (text) {
      recent.push({ text, at: now, id })
      while (recent.length > 30) recent.shift()
    }
    return id
  },
}

export function Toaster() {
  return (
    <Toast.Provider
      toastManager={manager}
      position="bottom-right"
      timeout={6000}
    />
  )
}
