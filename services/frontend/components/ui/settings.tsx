import type { ComponentProps, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/** Two-column settings page: section list on the left, panels on the right. */
function SettingsLayout({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-layout"
      className={cn(
        "grid items-start gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]",
        className
      )}
      {...props}
    />
  )
}

type SettingsNavGroup = {
  label?: string
  items: Array<{ id: string; label: string; icon: LucideIcon }>
}

function SettingsNav({
  "aria-label": ariaLabel,
  activeId,
  groups,
  onSelect,
  className,
}: {
  "aria-label": string
  activeId: string
  groups: SettingsNavGroup[]
  onSelect: (id: string) => void
  className?: string
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 gap-4 overflow-x-auto lg:sticky lg:top-0 lg:flex-col lg:gap-5 lg:overflow-visible",
        className
      )}
      data-slot="settings-nav"
    >
      {groups.map((group, index) => (
        <div
          className="flex min-w-max flex-col gap-0.5 lg:min-w-0"
          key={group.label ?? index}
        >
          {group.label && (
            <p className="px-2.5 pb-1 text-xs text-muted-foreground">
              {group.label}
            </p>
          )}
          <div className="flex gap-1 lg:flex-col lg:gap-0.5">
            {group.items.map(({ id, label, icon: Icon }) => (
              <button
                aria-current={id === activeId ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  id === activeId && "bg-muted font-medium text-foreground"
                )}
                key={id}
                onClick={() => onSelect(id)}
                type="button"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}

/** A titled card whose body is a stack of `SettingsRow`s. */
function SettingsSection({
  title,
  description,
  footer,
  children,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
}) {
  return (
    <section
      data-slot="settings-section"
      className={cn("overflow-hidden rounded-2xl bg-card", className)}
      {...props}
    >
      <header className="flex flex-col gap-0.5 px-5 py-4">
        <h2 className="font-heading text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="flex flex-col">{children}</div>
      {footer && (
        <footer className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-5 py-3">
          {footer}
        </footer>
      )}
    </section>
  )
}

/** Label and help text on the left, the control on the right. */
function SettingsRow({
  label,
  description,
  htmlFor,
  badge,
  children,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  badge?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "grid items-start gap-3 border-t border-border/60 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] sm:gap-6",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium" htmlFor={htmlFor}>
            {label}
          </label>
          {badge}
        </div>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col items-stretch gap-2 sm:items-end [&>[role=switch]]:self-start sm:[&>[role=switch]]:self-end">
        {children}
      </div>
    </div>
  )
}

export { SettingsLayout, SettingsNav, SettingsRow, SettingsSection }
export type { SettingsNavGroup }
