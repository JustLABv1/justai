"use client"

import { motion, useReducedMotion } from "motion/react"
import type { CSSProperties, ReactNode } from "react"

import { cn } from "@/lib/utils"

/*
 * Isometric line illustrations for the onboarding: thin outlines of plates, blocks and
 * grids, with one element in the accent colour. Faces are filled with the surface
 * colour (--iso-face, set by the container) so nearer shapes hide farther ones; shapes
 * are listed back to front. Elements settle in one after another and the accent
 * floats gently, unless the reader prefers reduced motion.
 */

const UNIT = 7.4
const COS = 0.866

type Point = readonly [number, number]

/** Projects a point in plan units (x right-back, y left-back, z up) to the canvas. */
function project(x: number, y: number, z: number, origin: Point): Point {
  return [
    origin[0] + (x - y) * COS * UNIT,
    origin[1] + (x + y) * 0.5 * UNIT - z * UNIT,
  ]
}

const points = (list: Point[]) =>
  list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")

const faceStyle = (accent: boolean): CSSProperties => ({
  fill: accent
    ? "color-mix(in oklab, var(--primary) 22%, var(--iso-face, var(--card)))"
    : "var(--iso-face, var(--card))",
})

type Shape = {
  x: number
  y: number
  z?: number
  w: number
  d: number
  h: number
  accent?: boolean
  dashed?: boolean
}

/** A block: its top and the two faces that look at the viewer. */
function blockFaces({ x, y, z = 0, w, d, h }: Shape, origin: Point) {
  const p = (px: number, py: number, pz: number) => project(px, py, pz, origin)
  return {
    top: [
      p(x, y, z + h),
      p(x + w, y, z + h),
      p(x + w, y + d, z + h),
      p(x, y + d, z + h),
    ],
    right: [
      p(x + w, y, z),
      p(x + w, y + d, z),
      p(x + w, y + d, z + h),
      p(x + w, y, z + h),
    ],
    left: [
      p(x, y + d, z),
      p(x + w, y + d, z),
      p(x + w, y + d, z + h),
      p(x, y + d, z + h),
    ],
  }
}

function Settle({
  n,
  children,
  float = false,
}: {
  n: number
  children: ReactNode
  float?: boolean
}) {
  const reduce = useReducedMotion()
  if (reduce) return <g>{children}</g>
  return (
    <motion.g
      animate={{ opacity: 1, y: 0 }}
      initial={{ opacity: 0, y: -10 }}
      transition={{
        delay: 0.08 + n * 0.07,
        duration: 0.45,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {float ? (
        <motion.g
          animate={{ y: [0, -3, 0] }}
          transition={{
            delay: 0.8 + n * 0.07,
            duration: 3.2,
            ease: "easeInOut",
            repeat: Infinity,
          }}
        >
          {children}
        </motion.g>
      ) : (
        children
      )}
    </motion.g>
  )
}

const stroke = (accent?: boolean) =>
  accent ? "stroke-primary" : "stroke-foreground/40"

function Block({
  shape,
  origin,
  n = 0,
  float,
  children,
}: {
  shape: Shape
  origin: Point
  n?: number
  float?: boolean
  children?: ReactNode
}) {
  const faces = blockFaces(shape, origin)
  const common = {
    className: stroke(shape.accent),
    strokeDasharray: shape.dashed ? "3 2.5" : undefined,
    style: shape.dashed ? { fill: "none" } : faceStyle(Boolean(shape.accent)),
    vectorEffect: "non-scaling-stroke" as const,
  }
  return (
    <Settle float={float} n={n}>
      <polygon points={points(faces.left)} {...common} />
      <polygon points={points(faces.right)} {...common} />
      <polygon points={points(faces.top)} {...common} />
      {children}
    </Settle>
  )
}

/** A thin line on the canvas. */
function Line({
  from,
  to,
  accent,
  soft,
}: {
  from: Point
  to: Point
  accent?: boolean
  soft?: boolean
}) {
  return (
    <line
      className={
        accent
          ? "stroke-primary"
          : soft
            ? "stroke-foreground/25"
            : "stroke-foreground/40"
      }
      vectorEffect="non-scaling-stroke"
      x1={from[0]}
      x2={to[0]}
      y1={from[1]}
      y2={to[1]}
    />
  )
}

/** Grid lines on the top of a plate. */
function Grid({
  shape,
  origin,
  step = 2,
}: {
  shape: Shape
  origin: Point
  step?: number
}) {
  const { x, y, z = 0, w, d, h } = shape
  const top = z + h
  const lines: ReactNode[] = []
  for (let i = step; i < w; i += step)
    lines.push(
      <Line
        from={project(x + i, y, top, origin)}
        key={`x${i}`}
        soft
        to={project(x + i, y + d, top, origin)}
      />
    )
  for (let j = step; j < d; j += step)
    lines.push(
      <Line
        from={project(x, y + j, top, origin)}
        key={`y${j}`}
        soft
        to={project(x + w, y + j, top, origin)}
      />
    )
  return <>{lines}</>
}

/** Lines of text written on the top of a block. */
function TextLines({
  shape,
  origin,
  lengths,
  accent,
}: {
  shape: Shape
  origin: Point
  lengths: number[]
  accent?: boolean
}) {
  const { x, y, z = 0, d, h } = shape
  const top = z + h
  const gap = d / (lengths.length + 1)
  return (
    <>
      {lengths.map((length, i) => (
        <Line
          accent={accent}
          from={project(x + 0.8, y + gap * (i + 1), top, origin)}
          key={i}
          soft={!accent}
          to={project(x + 0.8 + length, y + gap * (i + 1), top, origin)}
        />
      ))}
    </>
  )
}

/** A small standing figure: a capsule with a head. */
function Person({
  at,
  origin,
  n = 0,
  accent,
}: {
  at: [number, number, number]
  origin: Point
  n?: number
  accent?: boolean
}) {
  const [cx, cy] = project(at[0], at[1], at[2], origin)
  return (
    <Settle n={n}>
      <rect
        className={stroke(accent)}
        height={13}
        rx={3.5}
        style={faceStyle(Boolean(accent))}
        vectorEffect="non-scaling-stroke"
        width={7}
        x={cx - 3.5}
        y={cy - 13}
      />
      <circle
        className={stroke(accent)}
        cx={cx}
        cy={cy - 17}
        r={3.4}
        style={faceStyle(Boolean(accent))}
        vectorEffect="non-scaling-stroke"
      />
    </Settle>
  )
}

function Canvas({
  children,
  label,
  className,
}: {
  children: ReactNode
  label: string
  className?: string
}) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label || undefined}
      className={cn("h-auto w-full", className)}
      fill="none"
      role={label ? "img" : undefined}
      strokeLinejoin="round"
      strokeWidth={1}
      viewBox="0 0 240 160"
    >
      {children}
    </svg>
  )
}

export type SketchName =
  "chat" | "live" | "video" | "agents" | "knowledge" | "notifications"

/** The illustration for one JustAI capability. */
export function FeatureSketch({
  name,
  label,
  className,
}: {
  name: SketchName
  label: string
  className?: string
}) {
  const o: Point = [120, 34]
  switch (name) {
    case "chat": {
      const plate = { x: 0, y: 0, w: 14, d: 14, h: 0.5 }
      const question = { x: 1.5, y: 1.5, z: 0.5, w: 7.5, d: 3.6, h: 0.8 }
      const answer = {
        x: 4.5,
        y: 6.8,
        z: 0.5,
        w: 8,
        d: 5.4,
        h: 0.8,
        accent: true,
      }
      return (
        <Canvas className={className} label={label}>
          <Block n={0} origin={o} shape={plate}>
            <Grid origin={o} shape={plate} />
          </Block>
          <Block n={1} origin={o} shape={question}>
            <TextLines lengths={[5, 3.4]} origin={o} shape={question} />
          </Block>
          <Block
            n={2}
            origin={o}
            shape={{ x: 1, y: 8, z: 0.5, w: 2.4, d: 2.4, h: 2.4 }}
          />
          <Block float n={3} origin={o} shape={answer}>
            <TextLines
              accent
              lengths={[6, 4.6, 5.4]}
              origin={o}
              shape={answer}
            />
          </Block>
        </Canvas>
      )
    }
    case "live": {
      const strip = { x: 0, y: 3, w: 15, d: 8, h: 0.5 }
      const transcript = { x: 8.6, y: 4, z: 0.5, w: 5.6, d: 6, h: 0.6 }
      const bars = [1.6, 3.2, 5, 2.4, 4, 2]
      return (
        <Canvas className={className} label={label}>
          <Block n={0} origin={[116, 30]} shape={strip} />
          {bars.map((height, i) => (
            <Block
              float={i === 2}
              key={i}
              n={2 + i}
              origin={[116, 30]}
              shape={{
                x: 1.2 + i * 1.1,
                y: 6,
                z: 0.5,
                w: 0.6,
                d: 2,
                h: height,
                accent: i === 2,
              }}
            />
          ))}
          <Person at={[1.4, 9.6, 0.5]} n={8} origin={[116, 30]} />
          <Block n={9} origin={[116, 30]} shape={transcript}>
            <TextLines
              lengths={[4, 2.8, 3.6, 2.2]}
              origin={[116, 30]}
              shape={transcript}
            />
          </Block>
        </Canvas>
      )
    }
    case "video": {
      const plate = { x: 0, y: 0, w: 14, d: 14, h: 0.5 }
      const screen = { x: 1.5, y: 1.5, z: 0.5, w: 10, d: 0.6, h: 4.8 }
      const v: Point = [120, 44]
      const faces = blockFaces(screen, v)
      const front = faces.left
      // A play symbol in the middle of the screen's front.
      const mid: Point = [
        (front[0][0] + front[2][0]) / 2,
        (front[0][1] + front[2][1]) / 2,
      ]
      return (
        <Canvas className={className} label={label}>
          <Block n={0} origin={v} shape={plate}>
            <Grid origin={v} shape={plate} step={2} />
          </Block>
          <Block n={1} origin={v} shape={screen}>
            <polygon
              className="stroke-primary"
              points={points([
                [mid[0] - 4, mid[1] - 6],
                [mid[0] + 6, mid[1] + 1],
                [mid[0] - 4, mid[1] + 6],
              ])}
              style={faceStyle(true)}
              vectorEffect="non-scaling-stroke"
            />
          </Block>
          <Block
            n={2}
            origin={v}
            shape={{ x: 1.5, y: 8.5, z: 0.5, w: 11, d: 2, h: 0.4 }}
          />
          {[3, 6.5, 9.5].map((x, i) => (
            <Block
              key={x}
              n={3 + i}
              origin={v}
              shape={{ x, y: 8.9, z: 0.9, w: 0.4, d: 1.2, h: 0.8 }}
            />
          ))}
          <Block
            float
            n={6}
            origin={v}
            shape={{
              x: 7.6,
              y: 8.9,
              z: 0.9,
              w: 1.2,
              d: 1.2,
              h: 1.2,
              accent: true,
            }}
          />
        </Canvas>
      )
    }
    case "agents": {
      const origin: Point = [98, 26]
      return (
        <Canvas className={className} label={label}>
          <Block
            n={0}
            origin={origin}
            shape={{ x: 0, y: 2, w: 20, d: 9, h: 0.5 }}
          />
          <Block
            n={1}
            origin={origin}
            shape={{ x: 0.6, y: 5.6, z: 0.5, w: 18.8, d: 1.8, h: 0.2 }}
          />
          <Block
            n={2}
            origin={origin}
            shape={{ x: 1, y: 5, z: 0.7, w: 3, d: 3, h: 3 }}
          />
          <Block
            float
            n={3}
            origin={origin}
            shape={{ x: 6.5, y: 5, z: 0.7, w: 3, d: 3, h: 3, accent: true }}
          />
          {/* A gate: work passes only once it is approved. */}
          <Block
            n={4}
            origin={origin}
            shape={{ x: 13, y: 3.6, z: 0.5, w: 0.7, d: 0.7, h: 5.2 }}
          />
          <Block
            n={5}
            origin={origin}
            shape={{ x: 13, y: 3.6, z: 5.7, w: 0.7, d: 5.4, h: 0.7 }}
          />
          <Block
            n={6}
            origin={origin}
            shape={{
              x: 15.5,
              y: 5,
              z: 0.7,
              w: 2.6,
              d: 2.6,
              h: 2.6,
              dashed: true,
            }}
          />
          <Block
            n={7}
            origin={origin}
            shape={{ x: 13, y: 8.3, z: 0.5, w: 0.7, d: 0.7, h: 5.2 }}
          />
        </Canvas>
      )
    }
    case "knowledge": {
      const origin: Point = [116, 40]
      const layers = [0, 1.25, 2.5, 3.75, 5]
      return (
        <Canvas className={className} label={label}>
          {layers.map((z, i) => {
            const pulled = i === 2
            const shape = {
              x: pulled ? 3.2 : 1.5,
              y: 1.5,
              z,
              w: 10,
              d: 10,
              h: 0.95,
              accent: pulled,
            }
            const faces = blockFaces(shape, origin)
            const dot = faces.right[1]
            return (
              <Block float={pulled} key={z} n={i} origin={origin} shape={shape}>
                <circle
                  className={stroke(pulled)}
                  cx={dot[0] - 6}
                  cy={dot[1] - 6}
                  r={1.3}
                  vectorEffect="non-scaling-stroke"
                />
              </Block>
            )
          })}
        </Canvas>
      )
    }
    case "notifications": {
      const plate = { x: 0, y: 0, w: 14, d: 14, h: 0.5 }
      return (
        <Canvas className={className} label={label}>
          <Block n={0} origin={o} shape={plate} />
          <Person at={[2, 2, 0.5]} n={1} origin={o} />
          <Block
            n={2}
            origin={o}
            shape={{ x: 5, y: 2.5, z: 0.5, w: 5, d: 3.6, h: 0.8 }}
          />
          <Block
            n={3}
            origin={o}
            shape={{ x: 5, y: 6.8, z: 0.5, w: 5, d: 3.6, h: 0.8 }}
          />
          <Block
            n={4}
            origin={o}
            shape={{
              x: 5,
              y: 11.1,
              z: 0.5,
              w: 5,
              d: 2.4,
              h: 0.6,
              dashed: true,
            }}
          />
          <Block
            float
            n={5}
            origin={o}
            shape={{
              x: 6.2,
              y: 11.4,
              z: 2.2,
              w: 2.6,
              d: 1.8,
              h: 1.8,
              accent: true,
            }}
          />
        </Canvas>
      )
    }
  }
}

/** The welcome scene: a workspace grid with blocks for the things JustAI brings together. */
export function WelcomeSketch({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  const o: Point = [120, 30]
  const plate = { x: 0, y: 0, w: 15, d: 15, h: 0.5 }
  const blocks: Shape[] = [
    { x: 1.5, y: 1.5, z: 0.5, w: 2.6, d: 2.6, h: 2.6 },
    { x: 5.6, y: 1.5, z: 0.5, w: 2.6, d: 2.6, h: 4.2 },
    { x: 1.5, y: 6, z: 0.5, w: 2.6, d: 2.6, h: 1.6 },
    { x: 10.6, y: 6, z: 0.5, w: 2.6, d: 2.6, h: 3 },
    { x: 6, y: 10.6, z: 0.5, w: 2.6, d: 2.6, h: 2 },
  ]
  return (
    <Canvas className={className} label={label}>
      <Block n={0} origin={o} shape={plate}>
        <Grid origin={o} shape={plate} step={2.5} />
      </Block>
      {blocks.map((shape, i) => (
        <Block key={i} n={1 + i} origin={o} shape={shape} />
      ))}
      <Block
        float
        n={7}
        origin={o}
        shape={{ x: 6.1, y: 6.1, z: 1.4, w: 2.6, d: 2.6, h: 2.6, accent: true }}
      />
    </Canvas>
  )
}
