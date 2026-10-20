"use client"

import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Check } from "lucide-react"
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper"

type CreationStep = { label: string; description?: string }

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
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-4 sm:py-8"
      onPointerDown={() => { keyboard.current = false }}
      onKeyDown={() => { keyboard.current = true }}
    >
      <header className="mx-auto flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-6">
        <Stepper
          className="w-full"
          indicators={{ completed: <Check aria-hidden="true" className="size-3.5" /> }}
          onValueChange={(value) => onStepChange(value - 1)}
          value={step + 1}
        >
          <StepperNav aria-label={`${title} steps`}>
            {steps.map((item, index) => (
              <StepperItem
                className="relative flex-1"
                disabled={busy || index > step}
                key={item.label}
                step={index + 1}
              >
                <StepperTrigger className="flex justify-start gap-2">
                  <StepperIndicator>{index + 1}</StepperIndicator>
                  <StepperTitle>{item.label}</StepperTitle>
                </StepperTrigger>
                {index < steps.length - 1 && (
                  <StepperSeparator className="group-data-[state=completed]/step:bg-primary md:mx-2.5" />
                )}
              </StepperItem>
            ))}
          </StepperNav>
        </Stepper>
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
