/** Stable, top-to-bottom dependency layout, including disconnected or invalid graphs. */
export function layoutAgentGraph(
  ids: string[],
  edges: { from: string; to: string }[]
) {
  const remaining = new Set(ids)
  const levels = new Map<string, number>()
  while (remaining.size) {
    const ready = [...remaining].filter(
      (id) => !edges.some((edge) => edge.to === id && remaining.has(edge.from))
    )
    // Cycles remain editable so validation can explain the problem.
    if (!ready.length) ready.push([...remaining][0])
    for (const id of ready) {
      const parents = edges.filter(
        (edge) => edge.to === id && levels.has(edge.from)
      )
      levels.set(
        id,
        Math.max(0, ...parents.map((edge) => levels.get(edge.from)! + 1))
      )
      remaining.delete(id)
    }
  }
  const rows = new Map<number, string[]>()
  for (const id of ids) {
    const level = levels.get(id) ?? 0
    rows.set(level, [...(rows.get(level) ?? []), id])
  }
  const width = Math.max(1, ...[...rows.values()].map((row) => row.length))
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [level, row] of rows)
    row.forEach((id, index) => {
      positions[id] = {
        x: 40 + ((width - row.length) / 2 + index) * 300,
        y: 40 + level * 210,
      }
    })
  return positions
}
