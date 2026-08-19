"use client"

import * as React from "react"
import {
  ThemeProvider as NextThemesProvider,
  useTheme,
  type UseThemeProps,
} from "next-themes"

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => {
    finished: Promise<void>
  }
}

const ThemeTransitionContext = React.createContext<UseThemeProps | null>(null)

function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      {...props}
    >
      <ThemeTransitionController>
        <ThemeHotkey />
        {children}
      </ThemeTransitionController>
    </NextThemesProvider>
  )
}

function ThemeTransitionController({ children }: React.PropsWithChildren) {
  const theme = useTheme()
  const nextThemesSetTheme = theme.setTheme
  const setTheme = React.useCallback<UseThemeProps["setTheme"]>(
    (nextTheme) => {
      const requestedTheme =
        typeof nextTheme === "function"
          ? nextTheme(theme.theme ?? "system")
          : nextTheme
      const resolvedTheme =
        requestedTheme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : requestedTheme
      const viewTransitionDocument = document as ViewTransitionDocument
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      const applyTheme = () => {
        const root = document.documentElement
        root.classList.remove("light", "dark")
        root.classList.add(resolvedTheme)
        root.style.colorScheme = resolvedTheme
        nextThemesSetTheme(requestedTheme)
      }

      if (reducedMotion || !viewTransitionDocument.startViewTransition) {
        applyTheme()
        return
      }

      try {
        const transition =
          viewTransitionDocument.startViewTransition(applyTheme)

        void transition.finished.catch(() => undefined)
      } catch {
        // A second transition can be requested while the first one is still
        // running. Keep the theme change reliable even in that edge case.
        applyTheme()
      }
    },
    [nextThemesSetTheme, theme.theme]
  )

  const value = React.useMemo<UseThemeProps>(
    () => ({ ...theme, setTheme }),
    [setTheme, theme]
  )

  return (
    <ThemeTransitionContext.Provider value={value}>
      {children}
    </ThemeTransitionContext.Provider>
  )
}

function useThemeTransition() {
  const context = React.useContext(ThemeTransitionContext)
  if (!context) {
    throw new Error("useThemeTransition must be used inside ThemeProvider")
  }
  return context
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

function ThemeHotkey() {
  const { resolvedTheme, setTheme } = useThemeTransition()

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (typeof event.key !== "string" || event.key.toLowerCase() !== "d") {
        return
      }

      if (isTypingTarget(event.target)) {
        return
      }

      setTheme(resolvedTheme === "dark" ? "light" : "dark")
    }

    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [resolvedTheme, setTheme])

  return null
}

export { ThemeProvider, useThemeTransition }
