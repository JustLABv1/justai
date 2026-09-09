import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type WorkspaceDetailHeaderProps = {
  eyebrow: ReactNode
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  className?: string
}

/**
 * Shared detail heading for the transcription workspaces.
 *
 * The heading and action group intentionally stack on narrow screens. This
 * keeps long session titles and destructive actions from forcing horizontal
 * overflow while preserving a single, predictable header shape on desktop.
 */
export function WorkspaceDetailHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  icon,
  className,
}: WorkspaceDetailHeaderProps) {
  return (
    <header
      className={cn(
        "flex shrink-0 flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {eyebrow}
          </div>
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
          {meta ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  )
}
