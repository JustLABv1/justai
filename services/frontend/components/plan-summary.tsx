import { CalendarClock } from "lucide-react"

import { cn } from "@/lib/utils"

/** A muted box that says in one or two sentences what is going to happen. */
export function PlanSummary({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl bg-muted/60 px-3 py-2.5 text-sm leading-5",
        className
      )}
    >
      <CalendarClock
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-primary"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
