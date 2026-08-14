import assert from "node:assert/strict"
import test from "node:test"

import {
  oidcLoginPath,
  platformBannerDismissalKey,
  safeInternalPath,
  sortPlatformBanners,
} from "../lib/platform-config-logic.ts"

test("builds an independent login URL for each OIDC provider", () => {
  assert.equal(
    oidcLoginPath("company/sso", "/admin?tab=authentication"),
    "/api/v1/auth/oidc/company%2Fsso/start?next=%2Fadmin%3Ftab%3Dauthentication"
  )
  assert.equal(
    oidcLoginPath("", "/"),
    "/api/v1/auth/oidc/start?next=%2F"
  )
})

test("rejects unsafe OIDC redirect targets", () => {
  assert.equal(safeInternalPath("https://attacker.example"), "/")
  assert.equal(safeInternalPath("//attacker.example"), "/")
  assert.equal(safeInternalPath("/workspace?tab=chat"), "/workspace?tab=chat")
})

test("orders announcements by priority and keeps dismissal versioned", () => {
  const banners = [
    {
      id: "low",
      priority: 1,
      startsAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "high",
      priority: 10,
      startsAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ] as unknown as Parameters<typeof sortPlatformBanners>[0]
  assert.deepEqual(
    sortPlatformBanners(banners).map((banner) => banner.id),
    ["high", "low"]
  )
  assert.equal(
    platformBannerDismissalKey("high", "2026-01-02T00:00:00Z"),
    "justai.platform-banner.high.2026-01-02T00:00:00Z"
  )
  assert.notEqual(
    platformBannerDismissalKey("high", "2026-01-03T00:00:00Z"),
    platformBannerDismissalKey("high", "2026-01-02T00:00:00Z")
  )
})
