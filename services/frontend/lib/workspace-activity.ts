/** Analytics omits inactive UTC days; keep the full reporting window on the axis. */
export function workspaceActivityDays(
  days: ReadonlyArray<{ date: string; requests: number }>,
  now = new Date()
) {
  const counts = new Map(days.map((day) => [day.date, day.requests]))
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(end - (89 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    return { date, requests: counts.get(date) ?? 0 }
  })
}
