"use client"

import { useSyncExternalStore, type CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { getCurrentSeason } from "@/lib/season"
import { useSeasonsDisabled } from "@/lib/season-preference"
import styles from "./aurora-backdrop.module.css"

const fade = "linear-gradient(to bottom, black 0%, black 30%, transparent 85%)"

const summerLeaves = [
  "translate(6 22) rotate(-88) scale(.8)",
  "translate(14 43) rotate(-20) scale(.9)",
  "translate(30 64) rotate(-105) scale(.75)",
  "translate(43 83) rotate(-15) scale(.85)",
  "translate(60 102) rotate(-92) scale(.65)",
  "translate(74 121) rotate(5) scale(.75)",
  "translate(91 141) rotate(-70) scale(.55)",
  "translate(42 39) rotate(-85) scale(.65)",
  "translate(59 46) rotate(-18) scale(.7)",
  "translate(77 51) rotate(-65) scale(.5)",
]

function SummerFoliage() {
  return (
    <div className={styles.foliage}>
      {[false, true].map((mirrored) => (
        <svg
          key={String(mirrored)}
          viewBox="0 0 130 190"
          className={mirrored ? styles.foliageRight : styles.foliageLeft}
          fill="none"
        >
          <path
            d="M-8-16C-1 23 18 63 44 86S76 127 100 153M11 36C33 35 53 45 82 52"
            stroke="#6c8054"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          {summerLeaves.map((transform, index) => (
            <path
              key={transform}
              transform={transform}
              d="M0 0C5-10 23-16 35-8 26 1 12 7 0 0Z"
              fill={["#708b57", "#8ba263", "#5e7d51"][index % 3]}
              opacity={0.65 + (index % 3) * 0.1}
            />
          ))}
        </svg>
      ))}
    </div>
  )
}

function subscribeToCalendar(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000)
  window.addEventListener("focus", onChange)
  window.addEventListener("popstate", onChange)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener("focus", onChange)
    window.removeEventListener("popstate", onChange)
  }
}

const particles = Array.from(
  { length: 24 },
  (_, index) =>
    ({
      left: `${(index * 43 + 7) % 100}%`,
      "--size": `${10 + ((index * 7) % 15)}px`,
      "--duration": `${18 + ((index * 7) % 19)}s`,
      "--delay": `${-((index * 13) % 37)}s`,
      "--sway": `${35 + ((index * 17) % 90)}px`,
      "--turn": `${index % 2 ? 280 : -220}deg`,
    }) as CSSProperties
)

/**
 * Sky illustration (day in light mode, night in dark mode) that fades into the page background. Position and
 * size it from the call site; it never intercepts pointer events.
 */
export function AuroraBackdrop({
  className,
  composerWeather = false,
}: {
  className?: string
  composerWeather?: boolean
}) {
  const seasonsDisabled = useSeasonsDisabled()
  const calendarSeason = useSyncExternalStore(
    subscribeToCalendar,
    getCurrentSeason,
    () => null
  )
  const season = seasonsDisabled ? null : calendarSeason
  return (
    <div
      aria-hidden="true"
      data-season={season ?? undefined}
      className={cn(
        styles.backdrop,
        "pointer-events-none overflow-hidden motion-safe:animate-in motion-safe:duration-700 motion-safe:fade-in-0",
        className
      )}
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      <div
        className={cn(
          styles.sky,
          "absolute inset-0 bg-cover bg-top opacity-95 dark:hidden"
        )}
        style={{ backgroundImage: "url(/images/chat-backdrop-day.svg)" }}
      />
      <div
        className={cn(
          styles.sky,
          "absolute inset-0 hidden bg-cover bg-top opacity-50 dark:block"
        )}
        style={{ backgroundImage: "url(/images/chat-backdrop.svg)" }}
      />
      <div className={styles.atmosphere} />
      {season === "summer" && (
        <>
          <div className={styles.sunlight} />
          <SummerFoliage />
        </>
      )}
      {season && season !== "summer" && !composerWeather && (
        <div className={styles.particles}>
          {particles.map((style, index) => (
            <span key={index} className={styles.particle} style={style}>
              {season === "autumn" ? (
                <svg viewBox="0 0 32 36" fill="none">
                  <path
                    d="m16 1 4 9 5-4-1 8 7-1-4 7 4 3-12 5-2 7h-2l1-8L3 23l4-4-6-6 9 1-1-8 5 4z"
                    fill="currentColor"
                  />
                  <path
                    d="m16 29 1-18m-1 12-7-5m8 1 7-4"
                    stroke="currentColor"
                    strokeWidth="1"
                    className={styles.veins}
                  />
                </svg>
              ) : (
                <i className={styles.mote} />
              )}
            </span>
          ))}
        </div>
      )}
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
