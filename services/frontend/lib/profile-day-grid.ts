/** Local calendar days, including empty days; noon avoids DST boundary drift. */
export function buildProfileDays(
  activity: Array<{ date: string; count: number }>,
  today = new Date()
) {
  const counts = new Map(
    activity.map((day) => [day.date, Math.max(0, day.count)])
  )
  const end = new Date(today)
  end.setHours(12, 0, 0, 0)
  const start = new Date(end)
  start.setDate(start.getDate() - 89)
  const days = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    return { date, key, count: counts.get(key) ?? 0 }
  })
  const max = Math.max(1, ...days.map((day) => day.count))
  return {
    days: days.map((day) => ({
      ...day,
      level:
        day.count === 0
          ? (0 as const)
          : (Math.min(4, Math.ceil((day.count / max) * 4)) as 1 | 2 | 3 | 4),
    })),
    offset: (start.getDay() + 6) % 7,
  }
}
