"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import { CommandVariant } from "./command"
import { FocusVariant } from "./focus"
import { QuietVariant } from "./quiet"
import styles from "./prototype.module.css"

const variants = [
  { name: "Quiet", Component: QuietVariant },
  { name: "Command", Component: CommandVariant },
  { name: "Focus", Component: FocusVariant },
]

function variantFromUrl() {
  const value = Number.parseInt(
    new URLSearchParams(window.location.search).get("v") ?? "1",
    10
  )
  return Number.isFinite(value) && value >= 1 && value <= variants.length
    ? value - 1
    : 0
}

export default function NavigationChatPrototype() {
  const [current, setCurrent] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [ready, setReady] = useState(false)
  const [replayKey, setReplayKey] = useState(0)
  const pickerRef = useRef<HTMLElement | null>(null)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveHighlight = useCallback(() => {
    const picker = pickerRef.current
    const button = buttonRefs.current[current]
    if (!picker || !button) return

    const pickerBounds = picker.getBoundingClientRect()
    const buttonBounds = button.getBoundingClientRect()
    const left = buttonBounds.left - pickerBounds.left
    const highlight = picker.querySelector<HTMLElement>(
      ".proto-picker-highlight"
    )
    if (!highlight) return

    highlight.style.width = `${buttonBounds.width}px`
    highlight.style.transform = `translateX(${left}px)`
  }, [current])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCurrent(variantFromUrl())
      setHydrated(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useLayoutEffect(() => {
    moveHighlight()
  }, [moveHighlight, hydrated])

  useEffect(() => {
    function onResize() {
      moveHighlight()
    }

    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [moveHighlight])

  useEffect(() => {
    if (!hydrated) return
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => setReady(true))
      return () => window.cancelAnimationFrame(secondFrame)
    })
    return () => window.cancelAnimationFrame(firstFrame)
  }, [hydrated])

  const setActive = useCallback((index: number) => {
    setCurrent(index)
    const url = new URL(window.location.href)
    url.searchParams.set("v", String(index + 1))
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    )
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target?.matches("input, textarea, select, [contenteditable='true']") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return
      }

      if (/^[1-3]$/.test(event.key)) {
        event.preventDefault()
        setActive(Number(event.key) - 1)
        return
      }

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault()
        setActive((current + 1) % variants.length)
        return
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault()
        setActive((current - 1 + variants.length) % variants.length)
        return
      }

      if (event.key.toLowerCase() === "r") {
        event.preventDefault()
        setReplayKey((key) => key + 1)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [current, setActive])

  const ActiveVariant = variants[current].Component

  return (
    <div className={styles.stage}>
      {hydrated && <ActiveVariant key={`${current}-${replayKey}`} />}
      <nav
        aria-label="Prototype variants"
        className="proto-picker"
        data-position="top"
        data-ready={ready ? "" : undefined}
        ref={pickerRef}
      >
        <span aria-hidden="true" className="proto-picker-highlight" />
        {variants.map((variant, index) => (
          <button
            aria-pressed={current === index}
            className="proto-picker-item"
            data-active={current === index ? "" : undefined}
            key={variant.name}
            onClick={() => setActive(index)}
            ref={(element) => {
              buttonRefs.current[index] = element
            }}
            type="button"
          >
            {variant.name}
          </button>
        ))}
        <span aria-hidden="true" className="proto-picker-divider" />
        <button
          aria-label="Replay current variant"
          className="proto-picker-item proto-picker-replay"
          onClick={() => setReplayKey((key) => key + 1)}
          title="Replay"
          type="button"
        >
          ↻
        </button>
      </nav>
    </div>
  )
}
