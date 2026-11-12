export type CaptionReviewFilter = "all" | "review" | "missing" | "applied"

type ReviewResult = {
  speakerId: string
  name?: string
  applied: boolean
  conflict: boolean
}

export function filterCaptionResults<T extends ReviewResult>(
  results: readonly T[],
  filter: CaptionReviewFilter,
  query: string,
  speakerNames: ReadonlyMap<string, string>
): T[] {
  const normalize = (value: string) =>
    value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase()
  const needle = normalize(query.trim())
  return results.filter((result) => {
    if (filter === "review" && (!result.name || result.applied)) return false
    if (filter === "missing" && result.name) return false
    if (filter === "applied" && !result.applied) return false
    return (
      !needle ||
      normalize(
        `${speakerNames.get(result.speakerId) ?? ""} ${result.name ?? ""}`
      ).includes(needle)
    )
  })
}

/** Keep alternate views of one timestamp together without losing their evidence. */
export function groupCaptionEvidence(
  indices: readonly number[],
  frames: readonly { offsetMs: number; view?: string }[]
): { offsetMs: number; images: { index: number; view: string }[] }[] {
  const groups = new Map<
    number,
    { offsetMs: number; images: { index: number; view: string }[] }
  >()
  for (const index of new Set(indices)) {
    const frame = frames[index]
    if (!frame) continue
    const group = groups.get(frame.offsetMs) ?? {
      offsetMs: frame.offsetMs,
      images: [],
    }
    group.images.push({ index, view: frame.view || "crop" })
    groups.set(frame.offsetMs, group)
  }
  return [...groups.values()].sort((a, b) => a.offsetMs - b.offsetMs)
}
