import { cn } from "@/lib/utils"

const fade = "linear-gradient(to bottom, black 0%, black 30%, transparent 85%)"

/**
 * Sky illustration (day in light mode, night in dark mode) that fades into the page background. Position and
 * size it from the call site; it never intercepts pointer events.
 */
export function AuroraBackdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none overflow-hidden motion-safe:animate-in motion-safe:duration-700 motion-safe:fade-in-0",
        className
      )}
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      <div
        className="absolute inset-0 bg-cover bg-top opacity-95 dark:hidden"
        style={{ backgroundImage: "url(/images/chat-backdrop-day.svg)" }}
      />
      <div
        className="absolute inset-0 hidden bg-cover bg-top opacity-50 dark:block"
        style={{ backgroundImage: "url(/images/chat-backdrop.svg)" }}
      />
      <div
        className="absolute inset-0 opacity-10 mix-blend-multiply dark:opacity-30 dark:mix-blend-normal"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgb(0 0 0 / 0.55) 0.7px, transparent 0.9px)",
          backgroundSize: "4px 4px",
        }}
      />
    </div>
  )
}
