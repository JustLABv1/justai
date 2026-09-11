const avatarTones = [
  "bg-primary/10 text-primary",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
] as const

export function initialsFor(
  name: string | null | undefined,
  fallback = "U"
): string {
  const initials = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return initials || fallback
}

export function avatarToneFor(id: string | null | undefined): string {
  let hash = 0
  for (const character of id ?? "") {
    hash = (hash * 31 + character.charCodeAt(0)) | 0
  }
  return avatarTones[Math.abs(hash) % avatarTones.length]
}

export function versionedAvatarURL(
  url: string | null | undefined,
  version: string | number | null | undefined
): string | null {
  if (!url) return null
  if (version === undefined || version === null || version === "") return url
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}v=${encodeURIComponent(String(version))}`
}
