"use client"

import { useLayoutEffect, useRef, type ReactNode, type CSSProperties } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import styles from "./transcription-creation-flow.module.css"

type CreationStep = { label: string; description: string }

export function TranscriptionCreationFlow({
  title, description, steps, step, onStepChange, busy = false, children, footer,
}: {
  title: string
  description: string
  steps: readonly CreationStep[]
  step: number
  onStepChange: (step: number) => void
  busy?: boolean
  children: ReactNode
  footer: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const previousStep = useRef(step)
  const keyboard = useRef(false)

  useLayoutEffect(() => {
    const previous = previousStep.current
    previousStep.current = step
    const element = panel.current
    if (!element || previous === step) return
    element.focus({ preventScroll: true })
    if (keyboard.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const animation = element.animate([
      { opacity: 0, transform: `translateX(${step > previous ? 24 : -24}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" })
    return () => animation.cancel()
  }, [step])

  return (
    <section
      aria-label={title}
      className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-4 sm:py-8"
      onPointerDown={() => { keyboard.current = false }}
      onKeyDown={() => { keyboard.current = true }}
    >
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">TRANSCRIPTION</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="grid min-w-0 gap-6 md:grid-cols-[190px_minmax(0,1fr)] md:gap-10">
        <nav aria-label={`${title} steps`} className={styles.navigation} style={{ "--step": step, "--steps": steps.length } as CSSProperties}>
          <div aria-hidden="true" className={styles.track}><div className={styles.progress} /></div>
          <ol className={styles.steps}>
            {steps.map((item, index) => (
              <li key={item.label}>
                <button
                  type="button"
                  aria-current={step === index ? "step" : undefined}
                  disabled={busy || index > step}
                  onClick={() => onStepChange(index)}
                  className={cn(styles.step, "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring", step === index ? "text-foreground" : "text-muted-foreground")}
                >
                  <span className={cn(styles.number, index <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    {index < step ? <Check className="size-3.5" aria-hidden="true" /> : String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium sm:text-sm">{item.label}</span>
                    <span className="hidden text-xs text-muted-foreground md:block">{item.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="min-w-0 rounded-3xl bg-card p-5 sm:p-7">
          <div ref={panel} tabIndex={-1} role="group" aria-label={`Step ${step + 1} of ${steps.length}: ${steps[step].label}`} className="min-h-72 outline-none" aria-busy={busy}>
            {children}
          </div>
          <div className="mt-8">{footer}</div>
        </div>
      </div>
    </section>
  )
}
