export type UsageSummary = {
  periodStart: string
  periodEnd: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  /** null when nothing limits the member. */
  monthlyTokenLimit: number | null
  limitSource: "member" | "workspace" | "none"
}

export type MemberUsage = UsageSummary & {
  id: string
  displayName: string
  email: string
  role: "owner" | "admin" | "member"
}

export type OrganizationUsage = {
  periodStart: string
  periodEnd: string
  defaultMonthlyTokenLimit: number | null
  members: MemberUsage[]
}

export type MemberLimitMode = "inherit" | "unlimited" | "limit"

export type UsageDay = {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}
