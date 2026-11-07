export type Season = "spring" | "summer" | "autumn" | "winter"

/** Development previews share one override across the sky and composer weather. */
export function getCurrentSeason(): Season {
  if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
    const preview = new URLSearchParams(window.location.search).get("season")
    if (
      preview === "spring" ||
      preview === "summer" ||
      preview === "autumn" ||
      preview === "winter"
    )
      return preview
  }
  return getSeason(new Date())
}

/** Meteorological seasons, using the viewer's local calendar. */
export function getSeason(date: Date): Season {
  const month = date.getMonth()
  if (month >= 2 && month <= 4) return "spring"
  if (month >= 5 && month <= 7) return "summer"
  if (month >= 8 && month <= 10) return "autumn"
  return "winter"
}
