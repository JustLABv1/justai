import type { PlatformBanner } from "@/lib/types"

export function oidcLoginPath(providerSlug: string, nextPath: string) {
  const providerPath = providerSlug
    ? `/api/v1/auth/oidc/${encodeURIComponent(providerSlug)}/start`
    : "/api/v1/auth/oidc/start"
  return `${providerPath}?next=${encodeURIComponent(safeInternalPath(nextPath))}`
}

export function safeInternalPath(value: string) {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//")
  ) {
    return "/"
  }
  return trimmed
}

export function sortPlatformBanners(banners: PlatformBanner[]) {
  return [...banners].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.startsAt.localeCompare(right.startsAt) ||
      right.updatedAt.localeCompare(left.updatedAt)
  )
}

export function platformBannerDismissalKey(id: string, updatedAt: string) {
  return `justai.platform-banner.${id}.${updatedAt}`
}
