"use client"

import { useEffect, useRef, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { codeFileName } from "@/lib/code-preview"

const buttonClass =
  "rounded-md px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"

/** Language label with Copy and Save buttons, shown above every code block. */
export function CodeToolbar({
  code,
  language,
}: {
  code: string
  language: string | undefined
}) {
  const { t } = useTranslations()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be blocked; there is nothing useful to show.
    }
  }

  const save = () => {
    const url = URL.createObjectURL(
      new Blob([code], { type: "text/plain;charset=utf-8" })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = codeFileName(language)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="mt-3 -mb-2 flex items-center justify-between px-1 text-xs">
      <span className="text-muted-foreground">{language || ""}</span>
      <span className="flex gap-1">
        <button className={buttonClass} onClick={() => void copy()} type="button">
          {copied ? t("Copied") : t("Copy")}
        </button>
        <button className={buttonClass} onClick={save} type="button">
          {t("Save")}
        </button>
      </span>
    </div>
  )
}
