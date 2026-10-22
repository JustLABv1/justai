export const LANGUAGE_OPTIONS = [
  { value: "auto", label: "Detect automatically" },
  { value: "de", label: "German" },
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "pt", label: "Portuguese" },
  { value: "pl", label: "Polish" },
  { value: "tr", label: "Turkish" },
  { value: "ru", label: "Russian" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "ar", label: "Arabic" },
]

/** The language list, plus the current value when it is a custom code. */
export function languageItemsFor(current: string) {
  return LANGUAGE_OPTIONS.some((item) => item.value === current)
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, { value: current, label: current }]
}
