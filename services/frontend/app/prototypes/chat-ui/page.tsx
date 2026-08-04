"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react"

import { FocusVariant } from "./focus"
import { PulseVariant } from "./pulse"
import { StudioVariant } from "./studio"
import styles from "./prototype.module.css"

const variants: Array<{ name: string; Component: ComponentType }> = [
  { name: "Studio", Component: StudioVariant },
  { name: "Focus", Component: FocusVariant },
  { name: "Pulse", Component: PulseVariant },
]

function readVariantFromUrl() {
  if (typeof window === "undefined") {
    return 0
  }

  const value = Number(new URLSearchParams(window.location.search).get("v"))
  return Number.isInteger(value) && value >= 1 && value <= variants.length
    ? value - 1
    : 0
}

export default function ChatUIPrototype() {
  const [current, setCurrent] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [ready, setReady] = useState(false)
  const [replayKey, setReplayKey] = useState(0)
  const pickerRef = useRef<HTMLElement>(null)
  const highlightRef = useRef<HTMLSpanElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveHighlight = useCallback(() => {
    const item = itemRefs.current[current]
    const highlight = highlightRef.current

    if (!item || !highlight) {
      return
    }

    highlight.style.width = `${item.offsetWidth}px`
    highlight.style.transform = `translateX(${item.offsetLeft}px)`
  }, [current])

  useLayoutEffect(() => {
    moveHighlight()
  }, [moveHighlight])

  useEffect(() => {
    window.addEventListener("resize", moveHighlight)
    return () => window.removeEventListener("resize", moveHighlight)
  }, [moveHighlight])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCurrent(readVariantFromUrl())
      setHydrated(true)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    let secondFrame: number | null = null
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setReady(true))
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame)
      }
    }
  }, [])

  const setActive = useCallback((index: number) => {
    if (index < 0 || index >= variants.length) {
      return
    }

    setCurrent(index)
    const url = new URL(window.location.href)
    url.searchParams.set("v", String(index + 1))
    window.history.replaceState(null, "", url.toString())
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select") || target.isContentEditable)
      ) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      const number = Number.parseInt(event.key, 10)
      if (number >= 1 && number <= variants.length) {
        event.preventDefault()
        setActive(number - 1)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        setActive((current + 1) % variants.length)
      } else if (event.key === "ArrowLeft") {
        event.preventDefault()
        setActive((current - 1 + variants.length) % variants.length)
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault()
        setReplayKey((key) => key + 1)
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [current, setActive])

  const ActiveVariant = variants[current]?.Component ?? StudioVariant

  return (
    <div className={styles.stage}>
      {hydrated ? <ActiveVariant key={`${current}-${replayKey}`} /> : null}
      <nav
        aria-label="Prototype variants"
        className="proto-picker"
        data-position="top"
        data-ready={ready ? "" : undefined}
        ref={pickerRef}
      >
        <span
          aria-hidden="true"
          className="proto-picker-highlight"
          ref={highlightRef}
        />
        {variants.map((variant, index) => (
          <button
            aria-current={current === index ? "true" : undefined}
            className="proto-picker-item"
            data-active={current === index ? "" : undefined}
            key={variant.name}
            onClick={() => setActive(index)}
            ref={(node) => {
              itemRefs.current[index] = node
            }}
            type="button"
          >
            {variant.name}
          </button>
        ))}
        <span aria-hidden="true" className="proto-picker-divider" />
        <button
          aria-label="Replay animation (R)"
          className="proto-picker-item proto-picker-replay"
          onClick={() => setReplayKey((key) => key + 1)}
          type="button"
        >
          ↻
        </button>
      </nav>
    </div>
  )
}
