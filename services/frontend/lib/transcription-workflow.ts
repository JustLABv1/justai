import { workflowInputNames } from "./agent-workflow-logic.ts"
import type {
  AgentWorkflow,
  TranscriptionInsights,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSpeaker,
} from "./types"

export const TRANSCRIPTION_WORKFLOW_TRANSCRIPT_LIMIT = 100_000

export type TranscriptionWorkflowSource = {
  session: Pick<TranscriptionSession, "id" | "title" | "kind">
  segments: TranscriptionSegment[]
  speakers: TranscriptionSpeaker[]
  insights: TranscriptionInsights
  url: string
}

function timestamp(offsetMs: number) {
  const seconds = Math.max(0, Math.floor(offsetMs / 1000))
  return [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

export function transcriptionWorkflowTranscript(
  source: TranscriptionWorkflowSource
) {
  const speakers = new Map(
    source.speakers.map((speaker) => [
      speaker.id,
      speaker.displayName || speaker.label,
    ])
  )
  const full = source.segments
    .filter((segment) => segment.canonical)
    .map((segment) => {
      const text =
        segment.editedText?.trim() ||
        segment.polishedText?.trim() ||
        segment.text.trim()
      if (!text) return ""
      const speaker = segment.speakerId
        ? speakers.get(segment.speakerId)
        : undefined
      return `[${timestamp(segment.startOffsetMs)}] ${speaker ? `${speaker}: ` : ""}${text}`
    })
    .filter(Boolean)
    .join("\n")
  const truncated = full.length > TRANSCRIPTION_WORKFLOW_TRANSCRIPT_LIMIT
  return {
    text: truncated
      ? `${full.slice(0, TRANSCRIPTION_WORKFLOW_TRANSCRIPT_LIMIT)}\n[Transcript excerpt ends here]`
      : full,
    truncated,
  }
}

export function transcriptionWorkflowPrefill(
  workflow: AgentWorkflow,
  source: TranscriptionWorkflowSource
) {
  const transcript = transcriptionWorkflowTranscript(source).text
  const actions = (source.insights.actionItems ?? [])
    .map((item) => `- ${item}`)
    .join("\n")
  const summary = source.insights.summary?.trim() ?? ""
  const overview = [
    source.session.title,
    summary,
    actions && `Action items:\n${actions}`,
    `Transcript: ${source.url}`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return Object.fromEntries(
    workflowInputNames(workflow.definition).map((name) => {
      const key = name.toLowerCase().replace(/[^a-z]/g, "")
      const value = key.includes("transcript")
        ? transcript
        : key.includes("summary")
          ? summary
          : key.includes("action") || key.includes("task")
            ? actions
            : key.includes("topic")
              ? (source.insights.topics ?? []).join(", ")
              : overview
      return [name, value]
    })
  ) as Record<string, string>
}

export function transcriptionWorkflowInput(
  source: TranscriptionWorkflowSource,
  fields: Record<string, string>
) {
  const transcript = transcriptionWorkflowTranscript(source)
  return {
    transcript: transcript.text,
    transcription: {
      sessionId: source.session.id,
      title: source.session.title,
      kind: source.session.kind,
      url: source.url,
      summary: source.insights.summary ?? "",
      chapters: source.insights.chapters ?? [],
      topics: source.insights.topics ?? [],
      actionItems: source.insights.actionItems ?? [],
      generatedAt: source.insights.generatedAt ?? null,
      transcriptTruncated: transcript.truncated,
    },
    ...fields,
  }
}
