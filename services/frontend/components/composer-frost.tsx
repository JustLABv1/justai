"use client"

import { useEffect, useMemo, type CSSProperties } from "react"
import { useState } from "react"
import { Snowflake } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { iceCracksToOpen } from "@/lib/season-play"
import styles from "./composer-frost.module.css"

function FrozenSurface({
  composer,
  onThaw,
}: {
  composer: HTMLElement
  onThaw: () => void
}) {
  const { t } = useTranslations()
  const [cracks, setCracks] = useState<{ x: number; y: number }[]>([])
  const thaw = () => {
    onThaw()
    composer
      .querySelector<HTMLElement>(
        'textarea, [contenteditable="true"], input:not([type="file"])'
      )
      ?.focus()
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onThaw()
      }
    }
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(
          'textarea, [contenteditable="true"], input:not([type="file"])'
        )
      )
        onThaw()
    }
    document.addEventListener("keydown", escape)
    composer.addEventListener("focusin", focus)
    return () => {
      document.removeEventListener("keydown", escape)
      composer.removeEventListener("focusin", focus)
    }
  }, [composer, onThaw])

  return (
    <button
      type="button"
      className={styles.iceSurface}
      aria-label={t("Crack the ice · {value0} taps left", {
        value0: iceCracksToOpen - cracks.length,
      })}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const point =
          event.detail === 0
            ? { x: 35 + cracks.length * 15, y: 42 + cracks.length * 8 }
            : {
                x: ((event.clientX - bounds.left) / bounds.width) * 100,
                y: ((event.clientY - bounds.top) / bounds.height) * 100,
              }
        if (cracks.length + 1 >= iceCracksToOpen) thaw()
        else setCracks([...cracks, point])
      }}
    >
      <svg
        aria-hidden="true"
        className={styles.cracks}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {cracks.map((point, index) => (
          <g key={index} transform={`translate(${point.x} ${point.y})`}>
            {[0, 1, 2, 3, 4, 5].map((ray) => (
              <path
                key={ray}
                transform={`rotate(${ray * 60 + index * 17})`}
                d="M0 0 6 -2 13 1 22 -4 32 -2 M13 1 15 7 22 10"
              />
            ))}
          </g>
        ))}
      </svg>
      <span className={styles.iceHint}>
        <Snowflake className="size-5" />
        <span>{t("Tap to crack the ice")}</span>
        <span className="text-xs font-normal" aria-live="polite">
          {t("{value0} taps left", { value0: iceCracksToOpen - cracks.length })}
        </span>
        <span className="text-xs font-normal">{t("Esc to thaw")}</span>
      </span>
    </button>
  )
}

/** Frost starts at the rim and gradually closes over an idle, empty prompt. */
export function ComposerFrost({
  composer,
  frost,
  onThaw,
}: {
  composer: HTMLElement
  frost: number
  onThaw: () => void
}) {
  // The card's rounded corners live on the nearest styled ancestor, not always the composer itself.
  const radius = useMemo(() => {
    for (
      let node: HTMLElement | null = composer;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const value = getComputedStyle(node).borderTopLeftRadius
      if (parseFloat(value) > 0) return value
    }
    return "22px"
  }, [composer])
  if (frost <= 0) return null
  return (
    <div
      className={styles.ice}
      data-frozen={frost >= 1 ? "true" : undefined}
      style={{ "--frost": frost, borderRadius: radius } as CSSProperties}
    >
      <div aria-hidden="true" className={styles.rim} />
      <div aria-hidden="true" className={styles.veil} />
      <div aria-hidden="true" className={styles.grain} />
      <div aria-hidden="true" className={styles.bevel} />
      {frost >= 1 ? (
        <FrozenSurface composer={composer} onThaw={onThaw} />
      ) : null}
    </div>
  )
}
