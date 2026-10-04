"use client"

import { useEffect, useState } from "react"
import { useAuiState } from "@assistant-ui/react"
import {
  LexicalComposerInput,
  type LexicalComposerInputProps,
} from "@assistant-ui/react-lexical"

const prompts = [
  "Hi, what do you need today?",
  "What would you like to explore?",
  "Let's turn your ideas into a plan.",
  "Need a summary? Just ask.",
  "What can I help you create?",
] as const

export function AnimatedComposerInput(
  props: Omit<LexicalComposerInputProps, "placeholder">
) {
  const empty = useAuiState((state) => state.composer.text.length === 0)
  const [focused, setFocused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(true)
  const [visible, setVisible] = useState(true)
  const [index, setIndex] = useState(0)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)")
    const updateMotion = () => {
      setReducedMotion(preference.matches)
      setExiting(false)
    }
    const updateVisibility = () => {
      setVisible(!document.hidden)
      setExiting(false)
    }
    updateMotion()
    updateVisibility()
    preference.addEventListener("change", updateMotion)
    document.addEventListener("visibilitychange", updateVisibility)
    return () => {
      preference.removeEventListener("change", updateMotion)
      document.removeEventListener("visibilitychange", updateVisibility)
    }
  }, [])

  useEffect(() => {
    if (!empty || focused || reducedMotion || !visible) return
    let swap: ReturnType<typeof setTimeout> | undefined
    const rotation = setInterval(() => {
      setExiting(true)
      swap = setTimeout(() => {
        setIndex((current) => (current + 1) % prompts.length)
        setExiting(false)
      }, 140)
    }, 5000)
    return () => {
      clearInterval(rotation)
      clearTimeout(swap)
    }
  }, [empty, focused, reducedMotion, visible])

  return (
    <LexicalComposerInput
      {...props}
      placeholder=""
      onFocusCapture={(event) => {
        setFocused(true)
        setExiting(false)
        props.onFocusCapture?.(event)
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false)
        props.onBlurCapture?.(event)
      }}
    >
      {props.children}
      {empty && (
        <span
          aria-hidden="true"
          className="aui-lexical-placeholder composer-prompt"
        >
          <span
            key={reducedMotion ? "static" : index}
            className="composer-prompt-text"
            data-exiting={exiting && !reducedMotion && !focused}
            data-animate={!reducedMotion && !focused && index > 0}
          >
            {prompts[reducedMotion ? 0 : index]}
          </span>
        </span>
      )}
    </LexicalComposerInput>
  )
}
