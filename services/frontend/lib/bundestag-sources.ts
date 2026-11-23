import type { StreamPlanSession } from "./types.ts"

/** A stream relay source as listed by the backend. */
export type RelaySource = {
  id: string
  name: string
  url: string
  relay: string
  status: "live" | "idle" | "offline"
}

/**
 * Relay sources named "bundestag" or "bundestag-hk<N>" carry the Bundestag's
 * broadcast channels. Users pick a sitting, and the backend routes the capture to
 * that sitting's channel, so the picker offers them as one "Bundestag" card.
 */
export function isBundestagChannelSource(source: RelaySource) {
  return /^bundestag(-hk\d+)?$/i.test(source.id)
}

function channelOf(source: RelaySource) {
  const match = /-hk(\d+)$/i.exec(source.id)
  return match ? Number(match[1]) : 1
}

export type RelayChoice =
  | { kind: "source"; key: string; source: RelaySource }
  | {
      kind: "bundestag"
      key: string
      /** The source whose URL is stored; any channel source routes alike. */
      source: RelaySource
      members: RelaySource[]
      channels: number[]
      status: RelaySource["status"]
    }

/** Relay sources as picker choices: Bundestag channels merged per relay. */
export function relayChoices(sources: RelaySource[]): RelayChoice[] {
  const choices: RelayChoice[] = []
  const groups = new Map<string, RelaySource[]>()
  for (const source of sources) {
    if (!isBundestagChannelSource(source)) {
      choices.push({
        kind: "source",
        key: `${source.relay}/${source.id}`,
        source,
      })
      continue
    }
    const members = groups.get(source.relay)
    if (members) {
      members.push(source)
      continue
    }
    groups.set(source.relay, [source])
    // Keep the card where its first channel was listed.
    choices.push({
      kind: "bundestag",
      key: `${source.relay}/bundestag`,
      source,
      members: [],
      channels: [],
      status: "offline",
    })
  }
  for (const choice of choices) {
    if (choice.kind !== "bundestag") continue
    const members = [...(groups.get(choice.source.relay) ?? [])].sort(
      (a, b) => channelOf(a) - channelOf(b) || a.id.length - b.id.length
    )
    choice.members = members
    choice.channels = [...new Set(members.map(channelOf))]
    choice.source =
      members.find((item) => item.id.toLowerCase() === "bundestag") ??
      members[0]
    choice.status = members.some((item) => item.status === "live")
      ? "live"
      : members.some((item) => item.status === "idle")
        ? "idle"
        : "offline"
  }
  return choices
}

/** The choice a stored stream URL belongs to. */
export function relayChoiceForURL(choices: RelayChoice[], url: string) {
  const wanted = url.trim()
  if (!wanted) return undefined
  return choices.find((choice) =>
    choice.kind === "bundestag"
      ? choice.members.some((member) => member.url === wanted)
      : choice.source.url === wanted
  )
}

const planWindowLeadMs = 15 * 60_000

/**
 * The session a Bundestag capture that starts right away records, mirroring the
 * backend: the plenary while it runs, otherwise the only running session.
 */
export function runningPlanSession(
  plan: StreamPlanSession[],
  now = Date.now()
): StreamPlanSession | undefined {
  const running = plan.filter(
    (session) =>
      Boolean(session.channel) &&
      now >= new Date(session.startAt).getTime() - planWindowLeadMs &&
      now < new Date(session.endAt).getTime()
  )
  return (
    running.find((session) => session.channel === 1) ??
    (running.length === 1 ? running[0] : undefined)
  )
}

/** Sessions on air now, for listing them when no single one is captured. */
export function sessionsOnAir(plan: StreamPlanSession[], now = Date.now()) {
  return plan.filter(
    (session) =>
      Boolean(session.channel) &&
      now >= new Date(session.startAt).getTime() &&
      now < new Date(session.endAt).getTime()
  )
}
