import { cn } from "@/lib/utils"

type BrandMarkProps = {
  className?: string
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block size-9 shrink-0 overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm dark:border-transparent",
        className
      )}
    >
      <svg
        aria-hidden="true"
        className="size-full p-1.5"
        viewBox="245 268 770 720"
      >
        <use href="/images/logos/justai-logo.svg#justai-logo" />
      </svg>
    </span>
  )
}
