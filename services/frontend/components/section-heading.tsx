import type { ElementType, ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The heading of a page or section: a title, an optional count and a line of
 * description on the left, and the actions that belong to it on the right.
 * Every list or library page uses this one, so they all read the same.
 */
export function SectionHeading({
  title,
  count,
  description,
  actions,
  eyebrow,
  as: Heading = "h1",
  id,
  className,
}: {
  title: ReactNode
  /** A quiet number or short phrase after the title, such as "3 items". */
  count?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Small context above the title, such as a path back up. */
  eyebrow?: ReactNode
  as?: ElementType
  id?: string
  className?: string
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-3",
        className
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-xs">{eyebrow}</div> : null}
        <Heading
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xl font-semibold tracking-tight"
          id={id}
        >
          <span className="min-w-0 truncate">{title}</span>
          {count ? (
            <span
              aria-live="polite"
              className="text-sm font-normal text-muted-foreground tabular-nums"
            >
              {count}
            </span>
          ) : null}
        </Heading>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  )
}
