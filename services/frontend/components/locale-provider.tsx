"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { isLocale, localeCookieName, type Locale } from "@/lib/i18n/locale"
import {
  translate,
  translateMessages,
  type TranslationValues,
} from "@/lib/i18n/translate"

type LocaleContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (message: string | null | undefined, values?: TranslationValues) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale
  children: React.ReactNode
}) {
  const [locale, updateLocale] = useState(initialLocale)
  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return
    updateLocale(next)
    document.cookie = `${localeCookieName}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`
  }, [])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  const t = useCallback(
    (message: string | null | undefined, values?: TranslationValues) =>
      translate(locale, message, values),
    [locale]
  )
  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  )
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  )
}

export function useTranslations() {
  const context = useContext(LocaleContext)
  if (!context) throw new Error("useTranslations requires a LocaleProvider")
  return context
}

/** Static UI configuration remains stable until the selected language changes. */
export function useTranslatedConfig<T>(messages: T): T {
  const { locale } = useTranslations()
  return useMemo(() => translateMessages(locale, messages), [locale, messages])
}
