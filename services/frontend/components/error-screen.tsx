"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { motion, useReducedMotion, type Variants } from "motion/react"

import { Button } from "@/components/panelui/button"
import { useOptionalTranslations } from "@/components/locale-provider"
import { API_URL } from "@/lib/api"
import type { ErrorPageKind } from "@/lib/error-pages"
import { cn } from "@/lib/utils"

const RETRY_SECONDS = 8

type Copy = { title: string; description: string; label: string }

function copyFor(kind: ErrorPageKind, status: number | null): Copy {
  if (kind === "not-found")
    return {
      label: "Not found",
      title: "This page wandered off",
      description:
        "The address may be mistyped, or the page was moved or removed. Nothing here for you to fix.",
    }
  if (kind === "unreachable")
    return {
      label: "Backend unreachable",
      title: "We can't reach JustAI right now",
      description:
        "The server isn't answering. It may be restarting or your connection dropped. Your work is safe, and we'll reconnect on our own.",
    }
  if (kind === "server")
    return {
      label: "Server error",
      title: "Something broke on our side",
      description:
        "The server hit an unexpected problem while handling this. It isn't you. Try again in a moment.",
    }
  switch (status) {
    case 401:
      return {
        label: "Signed out",
        title: "Your session has ended",
        description: "Sign in again to pick up where you left off.",
      }
    case 403:
      return {
        label: "No access",
        title: "You don't have access to this",
        description:
          "Your account isn't allowed to open this page. Ask a workspace admin if you think it should be.",
      }
    case 408:
      return {
        label: "Timed out",
        title: "That took too long",
        description:
          "The request timed out before it finished. Please try again.",
      }
    case 429:
      return {
        label: "Slow down",
        title: "Too many requests",
        description:
          "You're going faster than we can keep up. Wait a moment, then retry.",
      }
    default:
      return {
        label: "Request problem",
        title: "We couldn't complete that request",
        description:
          "Something about the request wasn't accepted. Go back and try again, or head home.",
      }
  }
}

const stage: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
}
const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1] },
  },
}

/* ---------------------------------------------------------------- scenes */

const signetA =
  "M40 36H88V132C88 150.78 103.22 166 122 166H216V212H122C76.71 212 40 176.18 40 132Z"
const signetB = "M120 52H200V132H152V98H120Z"

function Signet({ still }: { still: boolean }) {
  return (
    <motion.g
      animate={still ? undefined : { y: [0, -6, 0] }}
      transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
    >
      <g transform="translate(100 56) scale(0.4)" fill="currentColor">
        <path d={signetA} />
        <path d={signetB} />
      </g>
    </motion.g>
  )
}

const ORBIT_RADIUS = 74
const ORBIT_SECONDS = 24

/** Small badge icons drawn around (0, 0); they sit on the dashed ring. */
const orbitIcons = [
  // magnifier
  <g
    key="search"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <circle cx="-1.5" cy="-1.5" r="4.5" />
    <path d="M2 2l4 4" />
  </g>,
  // question mark
  <path
    key="question"
    d="M-3.5-3a3.5 3.5 0 116 2.4c-1.2 1-2.5 1.4-2.5 3M0 6.2v.1"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  />,
  // page with a folded corner
  <g
    key="page"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M-4.5-6.5h6l3.5 3.5v9.5h-9.5z" />
    <path d="M1.5-6.5V-3H5" />
  </g>,
]

function NotFoundScene({ still }: { still: boolean }) {
  return (
    <g className="text-primary">
      <circle
        cx="160"
        cy="100"
        r={ORBIT_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="3 9"
        strokeLinecap="round"
        opacity={0.45}
      />
      {/* Native SVG rotation takes the pivot as an explicit point in the
          viewBox, which CSS transform-origin on SVG groups does not. */}
      <g>
        {!still && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 160 100"
            to="360 160 100"
            dur={`${ORBIT_SECONDS}s`}
            repeatCount="indefinite"
          />
        )}
        {orbitIcons.map((icon, index) => {
          const angle = (index * 2 * Math.PI) / orbitIcons.length
          const x = 160 + ORBIT_RADIUS * Math.sin(angle)
          const y = 100 - ORBIT_RADIUS * Math.cos(angle)
          return (
            // Counter-rotate about the badge itself so it stays upright.
            <g key={index}>
              {!still && (
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from={`0 ${x} ${y}`}
                  to={`-360 ${x} ${y}`}
                  dur={`${ORBIT_SECONDS}s`}
                  repeatCount="indefinite"
                />
              )}
              <g transform={`translate(${x} ${y})`}>
                <circle
                  r="13"
                  fill="var(--background)"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                {icon}
              </g>
            </g>
          )
        })}
      </g>
      <Signet still={still} />
    </g>
  )
}

function ClientScene({ still }: { still: boolean }) {
  return (
    <g className="text-warning">
      {[0, 1].map((i) => (
        <motion.circle
          key={i}
          cx="160"
          cy="112"
          r="40"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{ transformOrigin: "160px 112px" }}
          initial={{ scale: 1, opacity: 0 }}
          animate={
            still ? { opacity: 0.2 } : { scale: [1, 2.1], opacity: [0.5, 0] }
          }
          transition={{
            duration: 2.6,
            repeat: Infinity,
            delay: i * 1.3,
            ease: "easeOut",
          }}
        />
      ))}
      <motion.g
        initial={{ y: -12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 220, damping: 16 }}
      >
        {/* shackle shakes once the lock lands */}
        <motion.path
          d="M138 100V86a22 22 0 0144 0v14"
          fill="none"
          stroke="currentColor"
          strokeWidth="9"
          strokeLinecap="round"
          style={{ transformOrigin: "160px 100px" }}
          animate={still ? undefined : { rotate: [0, -7, 7, -5, 5, 0] }}
          transition={{
            delay: 0.7,
            duration: 0.7,
            repeat: Infinity,
            repeatDelay: 3.2,
          }}
        />
        <rect
          x="124"
          y="98"
          width="72"
          height="56"
          rx="14"
          fill="currentColor"
        />
        <circle cx="160" cy="122" r="7" fill="var(--background)" />
        <rect
          x="157"
          y="126"
          width="6"
          height="14"
          rx="3"
          fill="var(--background)"
        />
      </motion.g>
    </g>
  )
}

function ServerScene({ still }: { still: boolean }) {
  return (
    <g className="text-destructive">
      {[0, 1, 2].map((row) => (
        <motion.g
          key={row}
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{
            delay: 0.1 + row * 0.12,
            type: "spring",
            stiffness: 200,
            damping: 20,
          }}
        >
          <rect
            x="102"
            y={52 + row * 40}
            width="116"
            height="32"
            rx="9"
            fill="var(--card)"
            stroke="var(--border)"
            strokeWidth="1.5"
          />
          <rect
            x="102"
            y={52 + row * 40}
            width="116"
            height="32"
            rx="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity={0.15}
          />
          <rect
            x="116"
            y={64 + row * 40}
            width="46"
            height="8"
            rx="4"
            fill="currentColor"
            opacity={0.18}
          />
          <motion.circle
            cx="198"
            cy={68 + row * 40}
            r="4.5"
            fill={row === 1 ? "currentColor" : "var(--success)"}
            animate={
              still
                ? undefined
                : { opacity: row === 1 ? [1, 0.15, 1, 0.15, 1] : [1, 0.4, 1] }
            }
            transition={{
              duration: row === 1 ? 1 : 2.4,
              repeat: Infinity,
              delay: row * 0.3,
            }}
          />
        </motion.g>
      ))}
      <motion.path
        d="M170 90l-14 22h12l-6 20 20-26h-13l8-16z"
        fill="currentColor"
        animate={
          still
            ? undefined
            : { opacity: [0, 1, 0.2, 1, 0], scale: [0.9, 1, 0.95, 1, 0.9] }
        }
        transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 1.4 }}
        style={{ transformOrigin: "165px 112px" }}
      />
    </g>
  )
}

function UnreachableScene({
  still,
  checking,
}: {
  still: boolean
  checking: boolean
}) {
  return (
    <g className="text-primary">
      {/* local node */}
      <g transform="translate(46 84)">
        <rect
          width="52"
          height="52"
          rx="14"
          fill="var(--card)"
          stroke="currentColor"
          strokeWidth="2"
        />
        <rect
          x="14"
          y="16"
          width="24"
          height="16"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M20 40h12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
      {/* remote node, dimmed */}
      <g transform="translate(222 84)" className="text-muted-foreground">
        <rect
          width="52"
          height="52"
          rx="14"
          fill="var(--card)"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 4"
        />
        <g
          transform="translate(13 13) scale(0.1)"
          fill="currentColor"
          opacity={0.8}
        >
          <path d={signetA} />
          <path d={signetB} />
        </g>
      </g>
      {/* line with a break */}
      <path
        d="M104 110H138"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="2 7"
      />
      <path
        d="M182 110H216"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="2 7"
        className="text-muted-foreground"
      />
      {/* break marker */}
      <motion.g
        style={{ transformOrigin: "160px 110px" }}
        animate={
          still ? undefined : { rotate: [0, -10, 10, 0], scale: [1, 1.08, 1] }
        }
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        className="text-destructive"
      >
        <circle
          cx="160"
          cy="110"
          r="14"
          fill="var(--card)"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M154 104l12 12M166 104l-12 12"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </motion.g>
      {/* packet that goes out and bounces back */}
      <motion.circle
        r="5"
        cy="110"
        fill="currentColor"
        animate={
          still ? { cx: 104 } : { cx: [104, 136, 104], opacity: [0, 1, 0] }
        }
        transition={{
          duration: checking ? 0.9 : 2.2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      {checking && !still && (
        <motion.circle
          cx="72"
          cy="110"
          r="34"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{ transformOrigin: "72px 110px" }}
          animate={{ scale: [0.8, 1.5], opacity: [0.6, 0] }}
          transition={{ duration: 1, repeat: Infinity, ease: "easeOut" }}
        />
      )}
    </g>
  )
}

function Scene({ kind, checking }: { kind: ErrorPageKind; checking: boolean }) {
  const reduce = useReducedMotion() ?? false
  return (
    <svg
      viewBox="0 0 320 200"
      role="presentation"
      aria-hidden="true"
      className="h-auto w-full max-w-[22rem] overflow-visible"
    >
      <defs>
        <radialGradient id="error-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <motion.ellipse
        cx="160"
        cy="104"
        rx="150"
        ry="90"
        fill="url(#error-glow)"
        className={
          kind === "server"
            ? "text-destructive"
            : kind === "client"
              ? "text-warning"
              : "text-primary"
        }
        animate={reduce ? undefined : { opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
      />
      {kind === "not-found" && <NotFoundScene still={reduce} />}
      {kind === "client" && <ClientScene still={reduce} />}
      {kind === "server" && <ServerScene still={reduce} />}
      {kind === "unreachable" && (
        <UnreachableScene still={reduce} checking={checking} />
      )}
    </svg>
  )
}

/* ------------------------------------------------------------ the screen */

export type ErrorScreenProps = {
  kind: ErrorPageKind
  /** HTTP status shown as the large code. Omit for the unreachable page. */
  status?: number | null
  title?: string
  description?: string
  /** Backend request id or Next digest, shown so support can find the failure. */
  reference?: string
  /** Called by "Try again". For the unreachable page it also runs once the backend answers. */
  onRetry?: () => void
  /** Where "Back to workspace" goes. Pass null to hide it. */
  homeHref?: string | null
  /** Fill the viewport (root pages) instead of the parent (inside the workspace). */
  fullScreen?: boolean
  /** Keep probing the backend and call `onRetry` as soon as it answers. Unreachable only. */
  autoRetry?: boolean
  children?: ReactNode
}

export function ErrorScreen({
  kind,
  status = null,
  title,
  description,
  reference,
  onRetry,
  homeHref = "/",
  fullScreen = false,
  autoRetry = kind === "unreachable",
  children,
}: ErrorScreenProps) {
  const { t } = useOptionalTranslations()
  const copy = copyFor(kind, status)
  const [seconds, setSeconds] = useState(RETRY_SECONDS)
  const [checking, setChecking] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const busy = useRef(false)
  const retryRef = useRef(onRetry)
  useEffect(() => {
    retryRef.current = onRetry
  }, [onRetry])

  const probe = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setChecking(true)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(`${API_URL}/api/v1/health/live`, {
        cache: "no-store",
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
      if (response.ok) {
        setRecovered(true)
        // Let the "reconnected" state register before the content swaps back in.
        setTimeout(
          () =>
            retryRef.current ? retryRef.current() : window.location.reload(),
          700
        )
        return
      }
    } catch {
      // Still down; the countdown starts over.
    } finally {
      busy.current = false
      setChecking(false)
      setSeconds(RETRY_SECONDS)
    }
  }, [])

  useEffect(() => {
    if (kind !== "unreachable" || !autoRetry || recovered) return
    const id = setInterval(() => {
      setSeconds((value) => {
        if (value <= 1) {
          void probe()
          return RETRY_SECONDS
        }
        return value - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [kind, autoRetry, recovered, probe])

  const code =
    status && status > 0 ? String(status) : kind === "unreachable" ? "···" : ""
  const handleRetry = () => {
    if (kind === "unreachable") void probe()
    else onRetry?.()
  }

  return (
    <main
      role={kind === "not-found" ? undefined : "alert"}
      className={cn(
        "relative isolate flex w-full flex-1 items-center justify-center overflow-hidden bg-background px-6 py-12",
        fullScreen ? "min-h-svh" : "min-h-full"
      )}
    >
      <motion.div
        variants={stage}
        initial="hidden"
        animate="show"
        className="flex w-full max-w-md flex-col items-center text-center"
      >
        <motion.div variants={rise} className="flex w-full justify-center">
          <Scene kind={kind} checking={checking} />
        </motion.div>

        {code && (
          <motion.p
            variants={rise}
            className="mt-2 flex font-mono text-6xl font-semibold tracking-tight text-foreground/90 tabular-nums select-none"
            aria-label={status ? `${t("Error")} ${status}` : undefined}
          >
            {code.split("").map((char, index) => (
              <motion.span
                key={index}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: 0.25 + index * 0.08,
                  type: "spring",
                  stiffness: 260,
                  damping: 18,
                }}
              >
                {char}
              </motion.span>
            ))}
          </motion.p>
        )}

        <motion.p
          variants={rise}
          className="mt-3 text-xs font-medium tracking-widest text-muted-foreground uppercase"
        >
          {t(copy.label)}
        </motion.p>
        <motion.h1
          variants={rise}
          className="mt-2 text-2xl font-semibold text-balance text-foreground"
        >
          {t(title ?? copy.title)}
        </motion.h1>
        <motion.p
          variants={rise}
          className="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground"
        >
          {t(description ?? copy.description)}
        </motion.p>

        {kind === "unreachable" && autoRetry && (
          <motion.p
            variants={rise}
            role="status"
            aria-live="polite"
            className="mt-5 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                recovered
                  ? "bg-success"
                  : checking
                    ? "animate-pulse bg-primary"
                    : "bg-warning"
              )}
            />
            {recovered
              ? t("Reconnected")
              : checking
                ? t("Checking connection…")
                : t("Retrying in {seconds}s", { seconds })}
          </motion.p>
        )}

        {children && (
          <motion.div variants={rise} className="mt-5 w-full">
            {children}
          </motion.div>
        )}

        <motion.div
          variants={rise}
          className="mt-7 flex flex-wrap items-center justify-center gap-3"
        >
          {status === 401 ? (
            <Button render={<Link href="/login" />}>{t("Sign in")}</Button>
          ) : kind !== "not-found" && (onRetry || kind === "unreachable") ? (
            <Button onClick={handleRetry} loading={checking}>
              {t(kind === "unreachable" ? "Retry now" : "Try again")}
            </Button>
          ) : null}
          {homeHref && status !== 401 && (
            <Button
              variant={kind === "not-found" ? "default" : "outline"}
              render={<a href={homeHref} />}
            >
              {t("Back to workspace")}
            </Button>
          )}
        </motion.div>

        {reference && (
          <motion.p
            variants={rise}
            className="mt-6 font-mono text-[11px] text-muted-foreground/80"
          >
            {t("Reference")}: <span className="select-all">{reference}</span>
          </motion.p>
        )}
      </motion.div>
    </main>
  )
}
