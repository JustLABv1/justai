"use client"

import { Check, ChevronDown, Copy, Download } from "lucide-react"
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { useTranslations } from "@/components/locale-provider"
import {
  COLLAPSE_AFTER_LINES,
  COLLAPSED_LINES,
  codeFileName,
  codeLines,
} from "@/lib/code-preview"
import { cn } from "@/lib/utils"

type ShellButtonVariant = "ghost" | "primary" | "danger" | "active"

const buttonVariants: Record<ShellButtonVariant, string> = {
  ghost: "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
  active: "bg-primary text-primary-foreground",
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  danger: "bg-destructive/10 text-destructive hover:bg-destructive/20",
}

/** Compact button used in the title bar of code blocks. */
export function ShellButton({
  variant = "ghost",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ShellButtonVariant }) {
  return (
    <button
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
        buttonVariants[variant],
        className
      )}
      type="button"
      {...props}
    />
  )
}

function CopyAndSave({
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
    <>
      <ShellButton
        aria-label={copied ? t("Copied") : t("Copy")}
        onClick={() => void copy()}
        title={copied ? t("Copied") : t("Copy")}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-emerald-500" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </ShellButton>
      <ShellButton aria-label={t("Save")} onClick={save} title={t("Save")}>
        <Download aria-hidden="true" className="size-3.5" />
      </ShellButton>
    </>
  )
}

/**
 * Terminal-style frame for every code block: a title bar with the language,
 * optional tabs and actions (Run, Copy, Save), the content, and an optional
 * footer such as the output of a run.
 */
export function CodeShell({
  code,
  language,
  tabs,
  actions,
  footer,
  children,
}: {
  code: string
  language?: string | undefined
  /** Shown next to the language, for example the Code / Preview switch. */
  tabs?: ReactNode
  /** Shown before Copy and Save, for example the Run button. */
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="my-3 overflow-hidden rounded-xl bg-muted text-sm">
      <div className="flex h-9 items-center gap-2 bg-foreground/5 px-3">
        <span aria-hidden="true" className="flex shrink-0 gap-1.5">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {language || "text"}
        </span>
        {tabs}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
          <CopyAndSave code={code} language={language} />
        </span>
      </div>
      <div>{children}</div>
      {footer}
    </div>
  )
}

/** The Code / Preview switch that lives in the title bar. */
export function ShellTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <span className="ml-2 flex gap-0.5" role="tablist">
      {tabs.map((tab) => (
        <ShellButton
          aria-selected={value === tab.id}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          variant={value === tab.id ? "active" : "ghost"}
        >
          {tab.label}
        </ShellButton>
      ))}
    </span>
  )
}

/**
 * Code with line numbers. Long blocks start collapsed to a few lines with a
 * fade and can be expanded.
 */
export function CollapsibleCode({ code }: { code: string }) {
  const { t } = useTranslations()
  const lines = useMemo(() => codeLines(code), [code])
  const collapsible = lines.length > COLLAPSE_AFTER_LINES
  const [expanded, setExpanded] = useState(false)
  const clipped = collapsible && !expanded
  const numbers = useMemo(
    () => lines.map((_line, index) => index + 1).join("\n"),
    [lines]
  )

  return (
    <div className="relative">
      {/* Padding lives on these wrappers: the markdown styles reset padding
          on every <pre> with !important, so it cannot be set on the <pre>. */}
      <div
        className="overflow-x-auto overflow-y-hidden font-mono text-[13px] leading-6"
        style={
          clipped ? { maxHeight: `${COLLAPSED_LINES * 1.5 + 1}rem` } : undefined
        }
      >
        <div className="flex w-max min-w-full py-2">
          {lines.length > 1 && (
            <div className="shrink-0 pr-4 pl-3 text-right text-muted-foreground/50 select-none">
              <pre
                aria-hidden="true"
                className="m-0! rounded-none! border-0! bg-transparent! p-0!"
              >
                {numbers}
              </pre>
            </div>
          )}
          <div className={cn("min-w-0 pr-4", lines.length <= 1 && "pl-3")}>
            <pre className="m-0! rounded-none! border-0! bg-transparent! p-0! whitespace-pre text-foreground">
              <code className="rounded-none! bg-transparent! p-0! text-[13px]!">
                {lines.join("\n")}
              </code>
            </pre>
          </div>
        </div>
      </div>
      {clipped && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-7 h-16 bg-[linear-gradient(to_top,var(--muted),transparent)]"
        />
      )}
      {collapsible && (
        <button
          aria-expanded={expanded}
          className="relative z-10 flex h-7 w-full items-center justify-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
          {expanded
            ? t("Show less")
            : t("Show all {value0} lines", { value0: String(lines.length) })}
        </button>
      )}
    </div>
  )
}

/** The output area under the code, styled like terminal output. */
export function TerminalPanel({
  command,
  children,
  label,
}: {
  /** Shell command shown as the prompt line, e.g. `python main.py`. */
  command?: string
  children: ReactNode
  label: string
}) {
  return (
    <div
      aria-label={label}
      className="border-t border-border bg-background/60 px-3 py-2 font-mono text-xs leading-5"
      role="log"
    >
      {command && (
        <div aria-hidden="true" className="mb-1 text-muted-foreground select-none">
          <span className="text-primary">$</span> {command}
        </div>
      )}
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}
