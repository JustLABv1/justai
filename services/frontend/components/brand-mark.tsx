import { cn } from "@/lib/utils"

type BrandMarkProps = {
  className?: string
  /** Remove the signet's built-in clear space for compact brand placements. */
  cropped?: boolean
}

/** JustAI's Geflecht signet, shared by navigation, onboarding and chat status. */
export function BrandMark({ className, cropped = false }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block size-9 shrink-0 text-[var(--brand-foreground)]",
        className
      )}
    >
      <svg
        aria-hidden="true"
        className="size-full"
        fill="currentColor"
        viewBox={cropped ? "40 36 176 176" : "0 0 256 256"}
      >
        <path d="M40 36H88V132C88 150.78 103.22 166 122 166H216V212H122C76.71 212 40 176.18 40 132Z" />
        <path d="M120 52H200V132H152V98H120Z" />
      </svg>
    </span>
  )
}

/** Custom outlined wordmark; independent of installed fonts. */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <svg
      aria-label="JustAI"
      role="img"
      className={cn(
        "h-6 w-auto shrink-0 text-[var(--brand-foreground)]",
        className
      )}
      fill="currentColor"
      viewBox="0 -4 408 110"
    >
      <path
        transform="translate(0 0)"
        fillRule="evenodd"
        d="M42 0H56V66C56 89 45 102 26 102C9 102 0 92 0 76H14C14 84 18 89 26 89C37 89 42 81 42 66Z"
      />
      <path
        transform="translate(72 0)"
        fillRule="evenodd"
        d="M0 28H14V72C14 84 20 89 29 89C40 89 46 82 46 70V28H60V100H47V92C42 99 35 102 26 102C9 102 0 92 0 74Z"
      />
      <path
        transform="translate(148 0)"
        fillRule="evenodd"
        d="M53 34L47 45C41 41 35 39 28 39C19 39 14 42 14 47C14 52 19 54 30 57C47 61 56 67 56 79C56 94 44 102 27 102C16 102 6 99 0 93L7 82C13 87 20 90 28 90C37 90 42 87 42 81C42 76 37 73 26 71C9 67 0 61 0 48C0 34 12 26 28 26C38 26 46 29 53 34Z"
      />
      <path
        transform="translate(220 0)"
        fillRule="evenodd"
        d="M12 8H26V28H46V40H26V76C26 85 29 89 37 89H46V101H35C20 101 12 93 12 77V40H0V28H12Z"
      />
      <path
        transform="translate(286 0)"
        fillRule="evenodd"
        d="M37 0H53L90 100H75L66 75H24L15 100H0ZM29 62H61L45 17Z"
      />
      <path
        transform="translate(394 0)"
        fillRule="evenodd"
        d="M0 0H14V100H0Z"
      />
    </svg>
  )
}
