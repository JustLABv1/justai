import { cn } from "@/lib/utils"

type BrandMarkProps = {
  className?: string
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative block size-9 shrink-0 text-primary", className)}
    >
      <svg
        aria-hidden="true"
        className="size-full"
        fill="none"
        viewBox="0 0 64 64"
      >
        <path
          d="M10 12v6c0 7 6 12 15 12"
          opacity="0.48"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="6"
        />
        <path
          d="M54 12v6c0 7-6 12-15 12"
          opacity="0.48"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="6"
        />
        <path
          d="M32 20v19c0 9-5 14-13 14-6 0-10-3-13-7"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="7"
        />
        <circle cx="32" cy="9" r="4.5" fill="currentColor" />
      </svg>
    </span>
  )
}
