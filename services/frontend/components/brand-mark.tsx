import Image from "next/image"

import { cn } from "@/lib/utils"

type BrandMarkProps = {
  className?: string
  priority?: boolean
}

export function BrandMark({ className, priority = false }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block size-9 shrink-0 overflow-hidden rounded-xl border border-border bg-background shadow-sm dark:border-transparent",
        className
      )}
    >
      <Image
        alt=""
        className="object-contain dark:hidden"
        fill
        priority={priority}
        sizes="40px"
        src="/images/logos/logo-dark.png"
      />
      <Image
        alt=""
        className="hidden object-contain dark:block"
        fill
        priority={priority}
        sizes="40px"
        src="/images/logos/logo-light.png"
      />
    </span>
  )
}
