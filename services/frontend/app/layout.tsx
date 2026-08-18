import "./globals.css"
import type { Metadata } from "next"

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
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
      </body>
    </html>
  )
}
