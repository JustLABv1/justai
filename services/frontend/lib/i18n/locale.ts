export const locales = ["de", "en"] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = "en"
export const localeCookieName = "justai.locale"

export function isLocale(value: unknown): value is Locale {
  return value === "de" || value === "en"
}

/** An explicit preference wins; otherwise honor the browser's weighted languages. */
export function resolveLocale(
  preference?: string | null,
  acceptLanguage = ""
): Locale {
  if (isLocale(preference)) return preference
  const languages = acceptLanguage
    .split(",")
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(";")
      const quality = parameters.find((parameter) =>
        parameter.trim().startsWith("q=")
      )
      return {
        locale: tag.toLowerCase().split("-")[0],
        quality: quality ? Number(quality.trim().slice(2)) : 1,
        index,
      }
    })
    .filter(
      ({ quality }) => Number.isFinite(quality) && quality > 0 && quality <= 1
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
  return (
    (languages.find(({ locale }) => isLocale(locale))?.locale as
      Locale | undefined) ?? defaultLocale
  )
}
