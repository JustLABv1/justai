import "./globals.css"
import type { Metadata } from "next"
import { cookies, headers } from "next/headers"
import { LocaleProvider } from "@/components/locale-provider"
import { localeCookieName, resolveLocale } from "@/lib/i18n/locale"

import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/toast"
import {
  PlatformBannerStack,
  PlatformConfigProvider,
} from "@/components/platform-config"

export const metadata: Metadata = {
  title: "JustAI",
  description: "JustLAB workspace for endpoints, chat, MCP, and RAG.",
  icons: {
    icon: "/images/logos/justai-logo.svg",
  },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [cookieStore, requestHeaders] = await Promise.all([
    cookies(),
    headers(),
  ])
  const locale = resolveLocale(
    cookieStore.get(localeCookieName)?.value,
    requestHeaders.get("accept-language") ?? ""
  )
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="antialiased">
        <LocaleProvider initialLocale={locale}>
          <ThemeProvider>
            <TooltipProvider>
              <PlatformConfigProvider>
                <div className="flex h-svh min-h-svh flex-col">
                  <PlatformBannerStack />
                  <div className="flex h-full min-h-0 flex-1 flex-col">
                    {children}
                  </div>
                </div>
                <Toaster />
              </PlatformConfigProvider>
            </TooltipProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  )
}
