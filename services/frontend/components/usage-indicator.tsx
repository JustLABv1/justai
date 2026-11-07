"use client"

import { useTranslations } from "@/components/locale-provider"
import { Usage } from "@/components/panelui/usage"
import { UsageFigures } from "@/components/usage-figures"
import type { UsageSummary } from "@/lib/usage"

/** The signed-in member's monthly token budget as a small ring that opens into the figures. Shown only while a limit applies. */
export function UsageIndicator({
  usage,
  className,
}: {
  usage: UsageSummary | null
  className?: string
}) {
  const { t, locale } = useTranslations()

  if (!usage) return null
  if (usage.monthlyTokenLimit === null) return <QuietUsage usage={usage} />
  const resets = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(usage.periodEnd))

  return (
    <Usage
      label={t("Monthly usage")}
      limit={Math.max(1, usage.monthlyTokenLimit)}
      locales={locale}
      value={usage.totalTokens}
    >
      <Usage.Trigger className={className} variant="ring" />
      <Usage.Content>
        <Usage.Summary label={t("Monthly usage")} unit={t("tokens")} />
        <Usage.Section title={t("This month")}>
          <UsageFigures usage={usage} />
        </Usage.Section>
        <Usage.Footer>
          {t("Resets on {value0}.", { value0: resets })}
        </Usage.Footer>
      </Usage.Content>
    </Usage>
  )
}

/**
 * With no limit there is nothing to fill, so the same small ring is drawn grey
 * and the popover only writes the month's figures out.
 */
function QuietUsage({ usage }: { usage: UsageSummary }) {
  const { t, locale } = useTranslations()
  const total = new Intl.NumberFormat(locale).format(usage.totalTokens)
  return (
    <Usage
      label={t("Usage this month")}
      limit={1}
      locales={locale}
      state="idle"
      value={0}
    >
      <Usage.Trigger variant="ring" />
      <Usage.Content>
        <Usage.Section aside={t("No limit")} title={t("This month")}>
          <p className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
            {total}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {t("tokens")}
            </span>
          </p>
          <UsageFigures usage={usage} />
        </Usage.Section>
      </Usage.Content>
    </Usage>
  )
}
