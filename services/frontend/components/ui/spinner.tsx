"use client"

import { useTranslations } from "@/components/locale-provider"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

function Spinner({
  className,
  strokeWidth,
  ...props
}: React.ComponentProps<"svg">) {
  const { t } = useTranslations()

  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      {...props}
      strokeWidth={typeof strokeWidth === "number" ? strokeWidth : 2}
      data-slot="spinner"
      role="status"
      aria-label={t("Loading")}
      className={cn("size-4 animate-spin", className)}
    />
  )
}

export { Spinner }
