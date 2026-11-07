"use client"

import { useEffect, useRef } from "react"
import { getCurrentSeason } from "@/lib/season"
import { useSeasonsDisabled } from "@/lib/season-preference"

const leafOutline =
  "m16 1 4 9 5-4-1 8 7-1-4 7 4 3-12 5-2 7h-2l1-8L3 23l4-4-6-6 9 1-1-8 5 4z"

/** A bounded weather layer: particles land on the actual composer edge. */
export function ComposerWeather() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const seasonsDisabled = useSeasonsDisabled()

  useEffect(() => {
    if (seasonsDisabled) return
    const canvas = canvasRef.current
    const shell = canvas?.parentElement
    if (!canvas || !shell) return
    const context = canvas.getContext("2d")
    if (!context) return
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const leaf = new Path2D(leafOutline)
    const petal = new Path2D("M0 9C-11 1-9-9-3-8L0-5 3-8C10-9 10 2 0 9Z")
    const colors = ["#d89537", "#bb6440", "#c47b2d"]
    const petalColors = ["#f3afc5", "#f7c5d5", "#e899b5"]
    const snow = new Float32Array(96)
    let frame = 0
    let previous = 0
    let width = 0
    let height = 0
    let initialFallHeight = 0
    let season = getCurrentSeason()
    const summerStarted = performance.now()

    function drawButterflies(
      now: number,
      edge: number,
      left: number,
      right: number
    ) {
      if (!context) return
      const count = width < 640 ? 2 : 3
      const smooth = (value: number) => {
        const t = Math.max(0, Math.min(1, value))
        return t * t * (3 - 2 * t)
      }
      for (let index = 0; index < count; index++) {
        const time = (now - summerStarted) / 1000 + index * 14
        const cycle = time % 42
        const perch = smooth((cycle - 10) / 5) * (1 - smooth((cycle - 21) / 6))
        const targetX = left + (right - left) * [0.2, 0.72, 0.46][index]
        const flightX = width * (0.5 + Math.sin(time * 0.16 + index * 2) * 0.32)
        const flightY = Math.max(
          65,
          edge * (0.38 + Math.sin(time * 0.23 + index) * 0.2)
        )
        const x = flightX + (targetX - flightX) * perch
        const y = flightY + (edge - 8 - flightY) * perch
        const resting = cycle > 15 && cycle < 21
        const flap = resting
          ? 0.4 + Math.sin(time * 2) * 0.12
          : 0.25 + Math.abs(Math.sin(time * 10)) * 0.75
        context.save()
        context.translate(x, y)
        context.rotate(Math.sin(time * 0.9) * 0.25 * (1 - perch))
        context.scale(index === 1 ? 0.8 : 0.95, index === 1 ? 0.8 : 0.95)
        context.globalAlpha = 0.85
        for (const side of [-1, 1]) {
          context.save()
          context.scale(side * flap, 1)
          context.fillStyle = ["#c79545", "#94b3c3", "#c6b575"][index]
          context.strokeStyle = ["#93713f", "#6d8e9e", "#a2925a"][index]
          context.lineWidth = 0.45
          context.beginPath()
          context.moveTo(1, 0)
          context.bezierCurveTo(4, -15, 21, -18, 17, -5)
          context.bezierCurveTo(16, 1, 7, 4, 1, 2)
          context.fill()
          context.stroke()
          context.beginPath()
          context.moveTo(1, 2)
          context.bezierCurveTo(12, -2, 16, 8, 9, 11)
          context.bezierCurveTo(3, 12, 2, 5, 1, 2)
          context.fill()
          context.stroke()
          // Fine wing veins instead of reflective spots.
          context.strokeStyle = "#655b4440"
          context.lineWidth = 0.5
          context.beginPath()
          context.moveTo(2, 1)
          context.quadraticCurveTo(7, -6, 13, -10)
          context.moveTo(2, 3)
          context.quadraticCurveTo(6, 4, 10, 8)
          context.stroke()
          context.restore()
        }
        context.strokeStyle = "#594b39"
        context.lineWidth = 1.5
        context.lineCap = "round"
        context.beginPath()
        context.moveTo(0, -5)
        context.lineTo(0, 8)
        context.stroke()
        context.lineWidth = 0.65
        context.beginPath()
        context.moveTo(0, -4)
        context.quadraticCurveTo(-2, -10, -4, -10)
        context.moveTo(0, -4)
        context.quadraticCurveTo(2, -10, 4, -10)
        context.stroke()
        context.restore()
      }
    }
    type Particle = {
      x: number
      y: number
      size: number
      speed: number
      phase: number
      rotation: number
      landedAt: number
      landingX: number
      color: string
      depth: number
    }
    const particles: Particle[] = []
    function reset(particle: Particle, initial = false) {
      Object.assign(particle, {
        x: Math.random() * width,
        y: initial ? Math.random() * initialFallHeight : -30,
        size:
          season === "winter"
            ? 0.7 + Math.random() * 1.5
            : season === "spring"
              ? 8 + Math.random() * 6
              : 13 + Math.random() * 10,
        speed:
          season === "winter"
            ? 10 + Math.random() * 22
            : 18 + Math.random() * 15,
        phase: Math.random() * Math.PI * 2,
        rotation: Math.random() * Math.PI,
        landedAt: 0,
        landingX: 0,
        color: (season === "spring" ? petalColors : colors)[
          Math.floor(Math.random() * colors.length)
        ],
        depth: 0.3 + Math.random() * 0.7,
      })
    }
    function resize() {
      if (!canvas || !shell || !context) return
      const bounds = shell.getBoundingClientRect()
      width = bounds.width
      height = bounds.height
      const composer = shell.querySelector<HTMLElement>(
        "[data-seasonal-composer]"
      )
      initialFallHeight = Math.max(
        0,
        (composer?.getBoundingClientRect().top ?? bounds.top + height * 0.4) -
          bounds.top -
          30
      )
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      context.setTransform(scale, 0, 0, scale, 0, 0)
      particles.length = 0
      snow.fill(0)
      const count =
        season === "summer"
          ? 0
          : season === "winter"
            ? width < 640
              ? 50
              : 100
            : width < 640
              ? 16
              : 30
      for (let index = 0; index < count; index++) {
        const particle = {} as Particle
        reset(particle, true)
        particles.push(particle)
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(shell)
    resize()

    function draw(now: number) {
      if (!context || !canvas || !shell) return
      frame = requestAnimationFrame(draw)
      if (now - previous < 32) return
      const delta = Math.min((now - previous) / 1000, 0.05)
      previous = now
      context.clearRect(0, 0, width, height)
      const nextSeason = getCurrentSeason()
      if (season !== nextSeason) {
        season = nextSeason
        resize()
      }
      if (reducedMotion.matches || document.hidden) return
      const composer = shell.querySelector<HTMLElement>(
        "[data-seasonal-composer]"
      )
      if (!composer) return
      const bounds = composer.getBoundingClientRect()
      const origin = shell.getBoundingClientRect()
      const edge = bounds.top - origin.top
      const left = bounds.left - origin.left + 24
      const right = bounds.right - origin.left - 24
      if (season === "summer") {
        drawButterflies(now, edge, left, right)
        return
      }
      if (season === "winter") {
        // Snow merges into a shallow, uneven dusting rather than a row of beads.
        for (let index = 0; index < snow.length; index++)
          snow[index] *= Math.exp(-delta / 35)
        const spacing = (right - left) / (snow.length - 1)
        const frost = context.createLinearGradient(0, edge - 6, 0, edge + 2)
        frost.addColorStop(0, "#ffffffed")
        frost.addColorStop(1, "#bfd1e3b3")
        context.fillStyle = frost
        context.beginPath()
        context.moveTo(left, edge + 0.5)
        for (let index = 0; index < snow.length; index++) {
          const height =
            ((snow[index - 1] ?? 0) +
              snow[index] * 2 +
              (snow[index + 1] ?? 0)) /
            4
          context.lineTo(left + index * spacing, edge + 0.5 - height)
        }
        context.lineTo(right, edge + 0.5)
        context.closePath()
        context.fill()
      }
      for (const particle of particles) {
        let opacity = season === "winter" ? particle.depth * 0.8 : 0.65
        if (particle.landedAt) {
          const age = (now - particle.landedAt) / 1000
          if (age > 24) {
            reset(particle)
            continue
          }
          // Keep deposits attached when the composer resizes or moves.
          particle.x = left + particle.landingX * (right - left)
          particle.y = edge - particle.size * (season === "winter" ? 0.4 : 0.2)
          opacity *= Math.min(1, (24 - age) / 5)
        } else {
          const oldBottom = particle.y + particle.size * 0.4
          particle.x += Math.sin(now / 1400 + particle.phase) * delta * 12
          particle.y += particle.speed * delta
          particle.rotation += delta * 0.35
          if (
            oldBottom <= edge &&
            particle.y + particle.size * 0.4 >= edge &&
            particle.x >= left &&
            particle.x <= right
          ) {
            if (season === "winter") {
              const bin = Math.round(
                ((particle.x - left) / Math.max(1, right - left)) *
                  (snow.length - 1)
              )
              for (let offset = -3; offset <= 3; offset++) {
                const index = bin + offset
                if (index >= 0 && index < snow.length) {
                  const taper = Math.min(
                    1,
                    index / 4,
                    (snow.length - 1 - index) / 4
                  )
                  snow[index] = Math.min(
                    6,
                    snow[index] +
                      Math.exp((-offset * offset) / 4) * 0.85 * taper
                  )
                }
              }
              reset(particle)
              continue
            }
            particle.landedAt = now
            particle.landingX = (particle.x - left) / Math.max(1, right - left)
            particle.y = edge - particle.size * 0.2
            particle.rotation =
              (season === "spring" ? 0 : Math.PI / 2) +
              (particle.phase - Math.PI) * 0.3
          }
          if (particle.y > height + 30) {
            reset(particle)
            continue
          }
          if (!particle.landedAt)
            opacity *= Math.max(
              0,
              Math.min(1, (height * 0.8 - particle.y) / (height * 0.3))
            )
        }
        context.save()
        context.globalAlpha = opacity
        context.translate(particle.x, particle.y)
        context.rotate(particle.rotation)
        context.fillStyle = season === "winter" ? "#eef6ff" : particle.color
        if (season === "winter") {
          context.beginPath()
          context.arc(0, 0, particle.size, 0, Math.PI * 2)
          context.fill()
        } else if (season === "spring") {
          context.scale(particle.size / 18, particle.size / 18)
          context.scale(
            1,
            particle.landedAt
              ? 0.45
              : 0.65 + Math.sin(now / 600 + particle.phase) * 0.25
          )
          context.fill(petal)
        } else {
          context.scale(particle.size / 32, particle.size / 32)
          context.translate(-16, -18)
          context.fill(leaf)
          context.strokeStyle = "#683a1e66"
          context.lineWidth = 1
          context.beginPath()
          context.moveTo(16, 29)
          context.lineTo(17, 11)
          context.stroke()
        }
        context.restore()
      }
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      context.clearRect(0, 0, width, height)
    }
  }, [seasonsDisabled])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 size-full"
    />
  )
}
