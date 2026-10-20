"use client"

import { useSyncExternalStore, type ComponentProps, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/** Slot in the workspace header bar (right of the breadcrumb). */
export const PAGE_ACTIONS_SLOT_ID = "workspace-header-actions"

const subscribeNever = () => () => {}

function Page({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page"
      className={cn(
        "mx-auto flex min-h-full w-full max-w-[1440px] flex-col gap-6",
        className
      )}
      {...props}
    />
  )
}

function PageHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
      {...props}
    />
  )
}

function PageHeading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-heading"
      className={cn("max-w-3xl min-w-0", className)}
      {...props}
    />
  )
}

function PageEyebrow({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="page-eyebrow"
      className={cn(
        "mb-2 text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

// The workspace header breadcrumb already shows where the user is, so the
// title stays in the DOM for the heading outline but is not rendered twice.
function PageTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-title"
      className={cn("sr-only", className)}
      {...props}
    />
  )
}

function PageDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="page-description"
      className={cn(
        "max-w-2xl text-sm leading-6 text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

// On desktop the actions move into the workspace header bar, next to the
// breadcrumb. On mobile (or outside the workspace shell) they stay inline.
function PageActions({ className, ...props }: ComponentProps<"div">) {
  const isMobile = useIsMobile()
  const slot = useSyncExternalStore(
    subscribeNever,
    () => document.getElementById(PAGE_ACTIONS_SLOT_ID),
    () => null
  )
  const actions = (
    <div
      data-slot="page-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
  return slot && !isMobile ? createPortal(actions, slot) : actions
}

function PageToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-toolbar"
      className={cn(
        "flex min-h-12 flex-wrap items-center gap-2 rounded-2xl bg-card p-2 shadow-xs",
        className
      )}
      {...props}
    />
  )
}

function PageSection({
  title,
  description,
  action,
  className,
  children,
  ...props
}: ComponentProps<"section"> & {
  title?: string
  description?: string
  action?: ReactNode
}) {
  return (
    <section
      data-slot="page-section"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    >
      {(title || description || action) && (
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export {
  Page,
  PageActions,
  PageDescription,
  PageEyebrow,
  PageHeader,
  PageHeading,
  PageSection,
  PageTitle,
  PageToolbar,
}
