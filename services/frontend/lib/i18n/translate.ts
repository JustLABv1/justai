import { de } from "./de.ts"
import type { Locale } from "./locale.ts"

export type TranslationValues = Record<
  string,
  string | number | null | undefined
>

/** English source messages are also the fallback for newly added UI text. */
export function translate(
  locale: Locale,
  message: string | null | undefined,
  values?: TranslationValues
): string {
  if (message == null) return ""
  const text =
    locale === "de" && Object.hasOwn(de, message)
      ? de[message as keyof typeof de]
      : message
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    values && Object.hasOwn(values, name)
      ? String(values[name] ?? "")
      : placeholder
  )
}

/** Localize static UI definitions while preserving machine identifiers and values. */
export function translateMessages<T>(locale: Locale, value: T): T {
  if (typeof value === "string") return translate(locale, value) as T
  if (Array.isArray(value))
    return value.map((entry) => translateMessages(locale, entry)) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        [
          "id",
          "value",
          "type",
          "kind",
          "icon",
          "feature",
          "scope",
          "status",
          "provider",
          "authType",
        ].includes(key)
          ? entry
          : translateMessages(locale, entry),
      ])
    ) as T
  }
  return value
}
