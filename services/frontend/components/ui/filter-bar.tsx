import type { ReactNode } from "react"
import { Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type FilterBarSearch = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  disabled?: boolean
}

export type FilterBarProps = {
  /** Optional free-text search displayed as the leading control. */
  search?: FilterBarSearch
  /** Selects, tabs, or other controls that refine the result set. */
  children?: ReactNode
  /** Number of results currently shown after applying the filters. */
  resultCount?: number
  /** Optional total result count when only a page or subset is loaded. */
  resultTotal?: number
  /** Singular/plural noun used in the result summary. */
  resultLabel?: string
  /** Render a clear action when this is true. */
  hasActiveFilters?: boolean
  onClear?: () => void
  clearLabel?: string
  /** Optional secondary actions aligned with the result metadata. */
  actions?: ReactNode
  className?: string
}

/**
 * Shared filter toolbar for data views.
 *
 * Search and controls wrap independently so a narrow viewport never leaves
 * result metadata stranded beside a filter. Keeping the summary in its own
 * row also gives every page a predictable place for clear/reset affordances.
 */
export function FilterBar({
  search,
  children,
  resultCount,
  resultTotal,
  resultLabel = "results",
  hasActiveFilters = Boolean(search?.value.trim()),
  onClear,
  clearLabel = "Clear filters",
  actions,
  className,
}: FilterBarProps) {
  const showSummary =
    resultCount !== undefined ||
    (hasActiveFilters && Boolean(onClear)) ||
    Boolean(actions)

  return (
    <div
      aria-label="Filters"
      className={cn("flex flex-col gap-2 border-y px-4 py-3", className)}
      data-slot="filter-bar"
      role="search"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {search && (
          <div className="relative w-full min-w-0 sm:min-w-56 sm:flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={search.label ?? "Search"}
              className="h-8 pl-8"
              disabled={search.disabled}
              onChange={(event) => search.onChange(event.target.value)}
              placeholder={search.placeholder}
              value={search.value}
            />
          </div>
        )}
        {children && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {children}
          </div>
        )}
      </div>
      {showSummary && (
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {resultCount !== undefined ? (
            <span aria-live="polite">
              {resultTotal !== undefined && resultTotal !== resultCount
                ? `${resultCount} of ${resultTotal}`
                : resultCount}{" "}
              {resultLabel}
            </span>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="flex items-center gap-2">
            {actions}
            {hasActiveFilters && onClear && (
              <Button
                aria-label={clearLabel}
                className="-mr-1"
                onClick={onClear}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" data-icon="inline-start" />
                {clearLabel}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
