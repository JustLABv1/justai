"use client"

import { useEffect, useRef } from "react"

import { cn } from "@/lib/utils"

export type ListeningOrbState = "idle" | "listening" | "speaking" | "paused" | "error"

export function ListeningOrb({
  level,
  state,
  className,
}: {
  level: number
  state: ListeningOrbState
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const levelRef = useRef(level)
  const stateRef = useRef(state)

  useEffect(() => {
    levelRef.current = level
  }, [level])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext("2d")
    if (!context) return
    let frame = 0
    let animationFrame = 0
    let reduceMotion = false

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    const updateMotion = () => {
      reduceMotion = mediaQuery.matches
    }
    updateMotion()
    mediaQuery.addEventListener("change", updateMotion)

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      const bounds = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(bounds.width * ratio))
      canvas.height = Math.max(1, Math.floor(bounds.height * ratio))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const draw = (timestamp: number) => {
      const bounds = canvas.getBoundingClientRect()
      const width = bounds.width
      const height = bounds.height
      const centerX = width / 2
      const centerY = height / 2
      const radius = Math.min(width, height) * 0.27
      const currentState = stateRef.current
      const currentLevel = Math.max(0, Math.min(1, levelRef.current))
      const phase = reduceMotion ? 0 : timestamp / 2200
      const movement = currentState === "speaking" ? currentLevel * 0.18 : currentLevel * 0.07
      const pulse = reduceMotion ? 0 : Math.sin(phase) * movement

      context.clearRect(0, 0, width, height)
      const background = context.createRadialGradient(centerX, centerY, radius * 0.1, centerX, centerY, radius * 2.2)
      const accent = currentState === "error" ? "244, 63, 94" : currentState === "paused" ? "148, 163, 184" : "124, 92, 246"
      background.addColorStop(0, `rgba(${accent}, ${0.26 + currentLevel * 0.18})`)
      background.addColorStop(0.45, `rgba(${accent}, ${0.11 + currentLevel * 0.08})`)
      background.addColorStop(1, `rgba(${accent}, 0)`)
      context.fillStyle = background
      context.fillRect(0, 0, width, height)

      const orbRadius = radius * (1 + pulse)
      const orb = context.createRadialGradient(centerX - orbRadius * 0.28, centerY - orbRadius * 0.32, orbRadius * 0.08, centerX, centerY, orbRadius)
      orb.addColorStop(0, currentState === "paused" ? "rgba(226,232,240,0.96)" : "rgba(255,255,255,0.96)")
      orb.addColorStop(0.22, `rgba(${accent}, 0.98)`)
      orb.addColorStop(0.75, `rgba(${accent}, 0.78)`)
      orb.addColorStop(1, `rgba(${accent}, 0.42)`)
      context.beginPath()
      context.arc(centerX, centerY, orbRadius, 0, Math.PI * 2)
      context.fillStyle = orb
      context.fill()

      context.lineWidth = 1
      for (let ring = 1; ring <= 3; ring++) {
        const ringRadius = radius * (1.35 + ring * 0.24 + pulse * ring * 0.5)
        context.beginPath()
        context.arc(centerX, centerY, ringRadius, 0, Math.PI * 2)
        context.strokeStyle = `rgba(${accent}, ${0.14 - ring * 0.025 + currentLevel * 0.07})`
        context.stroke()
      }

      frame = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(draw)
      }, reduceMotion ? 100 : 16)
    }

    animationFrame = window.requestAnimationFrame(draw)
    return () => {
      window.clearTimeout(frame)
      window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
      mediaQuery.removeEventListener("change", updateMotion)
    }
  }, [])

  return (
    <div
      aria-label={`Listening state: ${state}`}
      className={cn("relative aspect-square w-full max-w-[28rem]", className)}
      role="img"
    >
      <canvas className="size-full" ref={canvasRef} />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="size-2 rounded-full bg-primary-foreground/90 shadow-[0_0_18px_currentColor]" />
      </div>
    </div>
  )
}
