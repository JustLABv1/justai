"use client"

import Link from "next/link"
import { ArrowUpRight, Mic } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Card, CardContent } from "@/components/panelui/card"
import { parseJustAIAction } from "@/lib/justai-control-action"

export function JustAIActionCard({ value }: { value: unknown }) {
  const { t } = useTranslations()
  const action = parseJustAIAction(value)
  if (!action) return null
  const live = action.href === "/live-transcription?create=1"
  const Icon = live ? Mic : ArrowUpRight
  return (
    <Card size="sm" className="my-3 w-full max-w-xl">
      <CardContent className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t(action.title)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(action.description)}
          </p>
        </div>
        <Button size="sm" render={<Link href={action.href} />}>
          {live ? t("Set up recording") : t("Open page")}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  )
}
