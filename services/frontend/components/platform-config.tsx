"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  CheckCircle2,
  ExternalLink,
  Info,
  TriangleAlert,
  X,
} from "lucide-react"

import { api } from "@/lib/api"
import {
  platformBannerDismissalKey,
  sortPlatformBanners,
} from "@/lib/platform-config-logic"
import type { AuthConfig, PlatformBanner } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

type PlatformConfigContextValue = {
  config: AuthConfig | null
  loading: boolean
  refresh: () => Promise<void>
}

const PlatformConfigContext = createContext<PlatformConfigContextValue>({
  config: null,
  loading: true,
  refresh: async () => undefined,
})

export function PlatformConfigProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setConfig(await api.getAuthConfig())
    } catch {
      // The public configuration is optional for app boot. Authenticated
      // workspace requests still remain the source of truth for access.
      setConfig((current) => current ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const value = useMemo(
    () => ({ config, loading, refresh }),
    [config, loading, refresh]
  )

  return (
    <PlatformConfigContext.Provider value={value}>
      {children}
    </PlatformConfigContext.Provider>
  )
}

export function usePlatformConfig() {
  return useContext(PlatformConfigContext)
}

const dismissedStorageKey = (banner: PlatformBanner) =>
  platformBannerDismissalKey(banner.id, banner.updatedAt)

function iconForSeverity(severity: PlatformBanner["severity"]) {
  if (severity === "success") return CheckCircle2
  if (severity === "warning" || severity === "danger") return TriangleAlert
  return Info
}

function classForSeverity(severity: PlatformBanner["severity"]) {
  if (severity === "success") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100"
  }
  if (severity === "warning") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100"
  }
  if (severity === "danger") {
    return "border-destructive/30 bg-destructive/10 text-destructive"
  }
  return "border-primary/25 bg-primary/5"
}

export function PlatformBannerStack() {
  const { config } = usePlatformConfig()
  const banners = useMemo(() => config?.banners ?? [], [config?.banners])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = new Set<string>()
      banners.forEach((banner) => {
        if (
          banner.dismissible &&
          window.localStorage.getItem(dismissedStorageKey(banner)) === "true"
        ) {
          stored.add(banner.id)
        }
      })
      setDismissed(stored)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [banners])

  const visible = sortPlatformBanners(banners).filter(
    (banner) => !dismissed.has(banner.id)
  )
  if (visible.length === 0) return null

  function dismiss(banner: PlatformBanner) {
    setDismissed((current) => {
      const next = new Set(current)
      next.add(banner.id)
      return next
    })
    if (typeof window !== "undefined" && banner.dismissible) {
      window.localStorage.setItem(dismissedStorageKey(banner), "true")
    }
  }

  return (
    <div className="z-40 flex w-full shrink-0 flex-col">
      {visible.map((banner) => {
        const Icon = iconForSeverity(banner.severity)
        return (
          <Alert
            className={cn(
              "flex items-center justify-center rounded-none border-x-0 border-t-0 px-4 py-2 pr-12 text-center shadow-none sm:px-6 sm:pr-12",
              classForSeverity(banner.severity)
            )}
            key={banner.id}
          >
            <AlertTitle className="sr-only">Platform announcement</AlertTitle>
            <AlertDescription className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-current">
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span>{banner.message}</span>
              {banner.linkUrl && (
                <a
                  className="inline-flex items-center gap-1 font-medium underline underline-offset-3 hover:no-underline"
                  href={banner.linkUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Learn more <ExternalLink className="size-3" />
                </a>
              )}
            </AlertDescription>
            {banner.dismissible && (
              <AlertAction>
                <Button
                  aria-label="Dismiss announcement"
                  className="size-6"
                  onClick={() => dismiss(banner)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <X aria-hidden="true" />
                </Button>
              </AlertAction>
            )}
          </Alert>
        )
      })}
    </div>
  )
}
