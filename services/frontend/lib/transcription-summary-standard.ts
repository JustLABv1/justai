export type SummaryStandard = {
  name: string
  format: string
  instructions: string
  summary: boolean
  chapters: boolean
  topics: boolean
  actionItems: boolean
  boldSpeakers: boolean
}

export const defaultSummaryStandard: SummaryStandard = {
  name: "",
  format: "pdf",
  instructions: "",
  summary: true,
  chapters: true,
  topics: true,
  actionItems: true,
  boldSpeakers: false,
}

export type SummaryExportDraft = {
  revision: string
  summaryParagraphs: string[]
  chapterIndices: number[]
  topicIndices: number[]
  actionItemIndices: number[]
}

export function summaryParagraphs(summary: string) {
  return summary
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
    )
    .filter(Boolean)
}

// Match the timestamps shown in the transcript (m:ss or h:mm:ss).
export function summaryTimeOffset(value: string): number | undefined | null {
  const text = value.trim()
  if (!text) return undefined
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(text)) return null
  const parts = text.split(":").map(Number)
  if (parts.slice(1).some((part) => part > 59)) return null
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null
}

export type SummaryTemplate = SummaryStandard & {
  id: string
  exclusionRules: string
  updatedAt: string
  canEdit: boolean
}

export type SummaryTemplateDraft = SummaryStandard & {
  id?: string
  exclusionRules: string
  revision?: string
}

export type SummaryOmission = {
  segmentIds: string[]
  reason: string
  text: string
  speaker: string
  startOffsetMs: number
  endOffsetMs: number
}

export const summaryTemplateStarters = [
  {
    key: "plenary",
    name: "Plenary debate – substantive report",
    instructions:
      "Report political positions, arguments, proposals, and disagreements neutrally and attribute them to the speakers. Preserve distinct positions and substantive contributions.",
    exclusionRules:
      "Leave out purely organizational contributions: opening the sitting, greetings, speaking-time announcements, handing over the floor, procedural interruptions, adjournments, and closing the sitting. Keep all substantive statements, arguments, decisions, and disagreements, including those from the chair. Never exclude a speaker as a whole or a fixed opening or closing time range. Keep mixed or uncertain passages.",
  },
  {
    key: "customer",
    name: "Customer conversation",
    instructions:
      "Focus on customer needs, objections, commitments, and agreed next steps. Attribute statements to their speakers.",
    exclusionRules:
      "Leave out purely social greetings, small talk, and technical connection checks. Preserve any customer needs, objections, promises, or relevant context, including in mixed passages.",
  },
  {
    key: "project",
    name: "Project meeting",
    instructions:
      "Focus on decisions, open questions, risks, responsibilities, and next steps. Preserve disagreements and unresolved issues.",
    exclusionRules:
      "Leave out purely social greetings and technical connection checks. Keep substantive updates, decisions, dependencies, risks, and disagreements. Keep mixed or uncertain passages.",
  },
  {
    key: "interview",
    name: "Interview",
    instructions:
      "Preserve the interviewee's statements, reasoning, and relevant questions. Attribute opinions and preserve important qualifications.",
    exclusionRules:
      "Leave out purely organizational recording arrangements and connection checks. Preserve statements, reasoning, meaningful questions, and substantive context, including in mixed passages.",
  },
] as const

export function resolveSummaryTemplateDefaults(
  templates: SummaryTemplate[],
  rememberedId: string,
  personal: SummaryStandard | null,
  session?: {
    templateId?: string
    instructions?: string
    exclusionRules?: string
    instructionsOverridden?: boolean
    rulesOverridden?: boolean
  }
) {
  const template = templates.find(
    (item) => item.id === (session?.templateId ?? rememberedId)
  )
  let instructions = template?.instructions ?? personal?.instructions ?? ""
  let exclusionRules = template?.exclusionRules ?? ""
  if (session) {
    if (
      !template ||
      session.instructionsOverridden ||
      (!session.templateId && session.instructions)
    ) {
      instructions = session.instructions ?? instructions
    }
    if (
      session.exclusionRules !== undefined &&
      (!template || session.rulesOverridden || !session.templateId)
    ) {
      exclusionRules = session.exclusionRules
    }
  }
  return {
    template,
    instructions,
    exclusionRules,
    exportPreferences: personal ?? template ?? defaultSummaryStandard,
  }
}
