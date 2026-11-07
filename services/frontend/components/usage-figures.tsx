"use client"

import { useTranslations } from "@/components/locale-provider"
import type { UsageSummary } from "@/lib/usage"

/** The month's requests and tokens as rows, for popovers and cards. */
export function UsageFigures({ usage }: { usage: UsageSummary }) {
  const { t, locale } = useTranslations()
  const number = new Intl.NumberFormat(locale)
  return (
    <dl className="grid gap-1.5 text-sm">
      {[
        [t("Requests"), usage.requests],
        [t("Input tokens"), usage.inputTokens],
        [t("Output tokens"), usage.outputTokens],
      ].map(([label, value]) => (
        <div className="flex items-center justify-between" key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{number.format(Number(value))}</dd>
        </div>
      ))}
    </dl>
  )
}
