"use client"

import { Spinner } from "@/components/panelui/spinner"
import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"
import Link from "next/link"
import {
  SpeakerVideoCaptions,
  type CaptionRun,
} from "@/components/speaker-video-captions"

import {
  Bookmark,
  PanelRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  GitBranch,
  GitMerge,
  ImageIcon,
  MessageSquarePlus,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/panelui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/panelui/input"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Menu } from "@/components/panelui/menu"
import { Inspector } from "@/components/panelui/inspector"
import { Workbench } from "@/components/panelui/workbench"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/panelui/tabs"
import { Textarea } from "@/components/panelui/textarea"
import { Checkbox } from "@/components/panelui/checkbox"
import { api } from "@/lib/api"
import { TranscriptionExportDialog } from "@/components/transcription-export-dialog"
import {
  SummaryTemplatePicker,
  SummaryTemplateEditor,
} from "@/components/transcription-summary-templates"
import { SummaryOmissionReview } from "@/components/transcription-summary-omissions"
import { TranscriptionSummaryReadingView } from "@/components/transcription-summary-reading-view"
import {
  defaultSummaryStandard,
  summaryTimeOffset,
  resolveSummaryTemplateDefaults,
  type SummaryStandard,
  type SummaryTemplate,
  type SummaryTemplateDraft,
  type SummaryExportDraft,
} from "@/lib/transcription-summary-standard"
import { workflowInputNames } from "@/lib/agent-workflow-logic"
import {
  TRANSCRIPTION_WORKFLOW_TRANSCRIPT_LIMIT,
  transcriptionWorkflowInput,
  transcriptionWorkflowPrefill,
  transcriptionWorkflowTranscript,
  type TranscriptionWorkflowSource,
} from "@/lib/transcription-workflow"
import {
  activeTranscriptionMessageId,
  activeTranscriptionSegmentId,
  groupTranscriptionSegments,
  joinTranscriptText,
} from "@/lib/transcription"
import { cn } from "@/lib/utils"
import type {
  AgentRun,
  AgentWorkflow,
  TranscriptionAnnotation,
  TranscriptionInsights,
  TranscriptionRecording,
  TranscriptionSegment,
  TranscriptionSession,
  TranscriptionSpeaker,
  TranscriptionVideoPreviewSegment,
  TranscriptionVideoUpload,
} from "@/lib/types"

export type TranscriptWorkspaceSnapshot = {
  session: TranscriptionSession
  segments: TranscriptionSegment[]
  speakers: TranscriptionSpeaker[]
  annotations?: TranscriptionAnnotation[]
  insights?: TranscriptionInsights
  recordings?: TranscriptionRecording[]
  videoUpload?: TranscriptionVideoUpload | null
}

export type TranscriptWorkspaceMediaKind = "video" | "audio" | "none"

export type TranscriptWorkspaceProps = {
  snapshot: TranscriptWorkspaceSnapshot
  onSnapshotChange: (
    updater: (
      snapshot: TranscriptWorkspaceSnapshot
    ) => TranscriptWorkspaceSnapshot
  ) => void
  videoRef: RefObject<HTMLVideoElement | null>
  currentTimeMs: number
  onCurrentTimeChange: (value: number) => void
  videoDurationMs: number
  onVideoDurationChange: (value: number) => void
  videoPlaybackError: string
  onVideoPlaybackError: (value: string) => void
  onRefreshPlayback: () => Promise<void>
  onRenameSpeaker: (speaker: TranscriptionSpeaker) => void
  onStartChat: (sessionId: string) => Promise<void>
  onError: (value: string) => void
  mediaKind?: TranscriptWorkspaceMediaKind
}

/**
 * Kept as a compatibility alias for the video pipeline while the workspace
 * itself is shared by every completed transcript session.
 */
export type VideoTranscriptSnapshot = TranscriptWorkspaceSnapshot

type VideoTranscriptWorkspaceProps = TranscriptWorkspaceProps

type TranscriptMode = "verbatim" | "polished" | "edited"
type WorkspaceView = "review" | "insights" | "speakers" | "details"

type AnnotationTarget = {
  segmentId: string
  startOffsetMs: number
  endOffsetMs: number
}

type SpeakerSummary = {
  speaker: TranscriptionSpeaker
  segmentCount: number
  speakingMs: number
  sampleStartMs: number | null
  sampleEndMs: number | null
  sampleText: string
}

const insightLanguageOptionsMessages = [
  { value: "auto", label: "Auto (transcript language)" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "uk", label: "Ukrainian" },
  { value: "tr", label: "Turkish" },
  { value: "ar", label: "Arabic" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
] as const

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        className
      )}
      {...props}
    />
  )
}
function EmptyHeader(props: React.ComponentProps<"div">) {
  return <div className="flex flex-col items-center gap-1" {...props} />
}
function EmptyTitle(props: React.ComponentProps<"p">) {
  return <p className="text-sm font-medium" {...props} />
}
function EmptyDescription(props: React.ComponentProps<"p">) {
  return <p className="max-w-sm text-xs text-muted-foreground" {...props} />
}

function formatVideoDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

function formatVideoTimestamp(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function speakerInitials(value: string) {
  const initials = value
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return initials || "S"
}

function speakerDisplayName(
  speaker: TranscriptionSpeaker | undefined,
  translate?: ReturnType<typeof useTranslations>["t"]
) {
  const name = speaker?.displayName || speaker?.label || ""
  const generic = /^SPEAKER[_ -]?(\d+)$/i.exec(name)
  if (generic)
    return translate
      ? translate("Speaker {value0}", { value0: Number(generic[1]) })
      : `Speaker ${Number(generic[1])}`
  return name || (translate ? translate("Unknown speaker") : "Unknown speaker")
}

function qualityIssues(segment: TranscriptionSegment) {
  const issues: string[] = []
  if (typeof segment.confidence === "number" && segment.confidence < 0.65) {
    issues.push("Low confidence")
  }
  if (segment.endOffsetMs < segment.startOffsetMs) {
    issues.push("Invalid timing")
  }
  const words = segment.text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
  for (let size = 2; size <= 6; size += 1) {
    if (words.length < size * 2) continue
    const left = words.slice(-size)
    const right = words.slice(-size * 2, -size)
    if (left.join(" ") === right.join(" ")) {
      issues.push("Repeated phrase")
      break
    }
  }
  return issues
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function highlightText(value: string, query: string) {
  const normalized = query.trim()
  if (!normalized) return value
  const parts = value.split(new RegExp(`(${escapeRegExp(normalized)})`, "ig"))
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === normalized.toLocaleLowerCase() ? (
      <mark
        className="rounded bg-primary/20 px-0.5 text-inherit"
        key={`${part}-${index}`}
      >
        {part}
      </mark>
    ) : (
      part
    )
  )
}

function highlightActiveTranscriptSegment(
  messageText: string,
  segments: TranscriptionSegment[],
  activeSegmentId: string | null,
  query: string
) {
  const activeIndex = segments.findIndex(
    (segment) => segment.id === activeSegmentId
  )
  const activeText = segments[activeIndex]?.text.trim()
  if (!activeText) return highlightText(messageText, query)

  let prefix = ""
  for (let index = 0; index < activeIndex; index += 1) {
    prefix = joinTranscriptText(prefix, segments[index]?.text ?? "")
  }
  const start = messageText.indexOf(activeText, prefix.length)
  if (start < 0) return highlightText(messageText, query)

  const end = start + activeText.length
  return (
    <>
      {highlightText(messageText.slice(0, start), query)}
      <span className="rounded bg-primary/20 px-0.5 ring-1 ring-primary/25">
        {highlightText(messageText.slice(start, end), query)}
      </span>
      {highlightText(messageText.slice(end), query)}
    </>
  )
}

function transcriptMatches(
  segment: TranscriptionSegment,
  query: string,
  speakerFilter: string,
  speakerById: Map<string, TranscriptionSpeaker>,
  onlyQuality: boolean,
  translate: ReturnType<typeof useTranslations>["t"]
) {
  if (speakerFilter !== "all" && segment.speakerId !== speakerFilter) {
    return false
  }
  if (onlyQuality && qualityIssues(segment).length === 0) return false
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  const speaker = speakerDisplayName(
    segment.speakerId ? speakerById.get(segment.speakerId) : undefined,
    translate
  )
  const originalLabel = segment.speakerId
    ? (speakerById.get(segment.speakerId)?.label ?? "")
    : ""
  return `${speaker} ${originalLabel} ${segment.text}`
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}

function livePreviewSegments(
  upload: TranscriptionVideoUpload | null | undefined,
  processing: boolean
) {
  const parallelProgress = upload?.pipeline?.find(
    (step) => step.key === "transcription"
  )?.parallel
  if (
    !processing ||
    !["preparing", "transcribing", "fusing"].includes(
      parallelProgress?.phase ?? ""
    )
  ) {
    return [] as TranscriptionVideoPreviewSegment[]
  }
  return [...(parallelProgress?.previewSegments ?? [])]
    .filter((segment) => segment.text.trim())
    .sort((left, right) => left.startOffsetMs - right.startOffsetMs)
}

export function TranscriptWorkspace({
  snapshot,
  onSnapshotChange,
  videoRef,
  currentTimeMs,
  onCurrentTimeChange,
  videoDurationMs,
  onVideoDurationChange,
  videoPlaybackError,
  onVideoPlaybackError,
  onRefreshPlayback,
  onRenameSpeaker,
  onStartChat,
  onError,
  mediaKind = "video",
}: VideoTranscriptWorkspaceProps) {
  const insightLanguageOptions = useTranslatedConfig(
    insightLanguageOptionsMessages
  )

  const { t, locale } = useTranslations()
  const speakerName = (speaker: TranscriptionSpeaker | undefined) =>
    speakerDisplayName(speaker, t)

  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>(() =>
    snapshot.segments.some((segment) => segment.editedText != null)
      ? "edited"
      : snapshot.segments.some((segment) => segment.polishedText?.trim())
        ? "polished"
        : "verbatim"
  )
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("review")
  const [captionRun, setCaptionRun] = useState<CaptionRun | null>(null)
  const [selectedCaptionImage, setSelectedCaptionImage] = useState<{
    runId: string
    index: number
  } | null>(null)
  const [summaryRecordingOpen, setSummaryRecordingOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [transcriptQuery, setTranscriptQuery] = useState("")
  const [speakerFilter, setSpeakerFilter] = useState("all")
  const [qualityOnly, setQualityOnly] = useState(false)
  const [matchIndex, setMatchIndex] = useState(0)
  const [savingSegmentId, setSavingSegmentId] = useState<string | null>(null)
  const [paragraphDrafts, setParagraphDrafts] = useState<
    Record<string, string>
  >({})
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([])
  const [assignmentSpeakerId, setAssignmentSpeakerId] = useState("")
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationTarget | null>(null)
  const [annotationKind, setAnnotationKind] = useState<"bookmark" | "comment">(
    "comment"
  )
  const [annotationNote, setAnnotationNote] = useState("")
  const [annotationSaving, setAnnotationSaving] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeSourceId, setMergeSourceId] = useState("")
  const [mergeTargetId, setMergeTargetId] = useState("")
  const [mergeSaving, setMergeSaving] = useState(false)
  const [identifyOpen, setIdentifyOpen] = useState(false)
  const [identifyParticipants, setIdentifyParticipants] = useState("")
  const [identifyRunning, setIdentifyRunning] = useState(false)
  const [mediaPlaying, setMediaPlaying] = useState(false)
  const [audioSource, setAudioSource] = useState<{
    recordingId: string
    url: string
    error: string
  } | null>(null)
  const [audioDurationMs, setAudioDurationMs] = useState(0)
  const [selectedRecordingId, setSelectedRecordingId] = useState(
    () => snapshot.recordings?.[0]?.id ?? ""
  )
  const [polishGenerating, setPolishGenerating] = useState(false)
  const [insightsGenerating, setInsightsGenerating] = useState(false)
  const insightsPollingRef = useRef(false)
  const [chatStarting, setChatStarting] = useState(false)
  const [insightLanguage, setInsightLanguage] = useState(
    () => snapshot.insights?.language ?? "auto"
  )
  const [exportFormat, setExportFormat] = useState("pdf")
  const [includeInsightsInExport, setIncludeInsightsInExport] = useState(true)
  const [insightsOnlyExport, setInsightsOnlyExport] = useState(false)
  const [summaryExportOptions, setSummaryExportOptions] = useState({
    summary: true,
    chapters: true,
    topics: true,
    actionItems: true,
    boldSpeakers: false,
  })
  const [summaryInstructions, setSummaryInstructions] = useState(
    snapshot.insights?.customization?.instructions ?? ""
  )
  const [standardName, setStandardName] = useState("")
  const [savedStandard, setSavedStandard] = useState<SummaryStandard | null>(
    null
  )
  const [standardLoading, setStandardLoading] = useState(true)
  const [standardSaving, setStandardSaving] = useState(false)
  const [standardMessage, setStandardMessage] = useState("")
  const [standardError, setStandardError] = useState("")
  const [summarySetupOpen, setSummarySetupOpen] = useState(false)
  const [summaryTemplates, setSummaryTemplates] = useState<SummaryTemplate[]>(
    []
  )
  const [summaryTemplateId, setSummaryTemplateId] = useState(
    snapshot.insights?.customization?.templateId ?? ""
  )
  const [summaryExclusionRules, setSummaryExclusionRules] = useState(
    snapshot.insights?.customization?.exclusionRules ?? ""
  )
  const [restoredSummaryIds, setRestoredSummaryIds] = useState<string[]>(
    snapshot.insights?.customization?.restoredSegmentIds ?? []
  )
  const [templateDraft, setTemplateDraft] =
    useState<SummaryTemplateDraft | null>(null)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateError, setTemplateError] = useState("")
  const [templateSuggestion, setTemplateSuggestion] = useState(false)
  const [ruleProposing, setRuleProposing] = useState(false)

  const [sourceSearch, setSourceSearch] = useState("")
  const [sourceFrom, setSourceFrom] = useState("")
  const [sourceTo, setSourceTo] = useState("")
  const [sourceSpeaker, setSourceSpeaker] = useState("all")
  const sourceFromMs = summaryTimeOffset(sourceFrom)
  const sourceToMs = summaryTimeOffset(sourceTo)
  const sourceTimeRangeValid =
    sourceFromMs !== null &&
    sourceToMs !== null &&
    (sourceFromMs === undefined ||
      sourceToMs === undefined ||
      sourceFromMs <= sourceToMs)
  const matchingSourceSegments = snapshot.segments.filter(
    (segment) =>
      (segment.editedText ?? segment.polishedText ?? segment.text)
        .toLocaleLowerCase()
        .includes(sourceSearch.toLocaleLowerCase()) &&
      (sourceSpeaker === "all" || segment.speakerId === sourceSpeaker) &&
      sourceTimeRangeValid &&
      (sourceFromMs === undefined ||
        (segment.endOffsetMs || segment.startOffsetMs) >=
          (sourceFromMs ?? 0)) &&
      (sourceToMs === undefined || segment.startOffsetMs <= (sourceToMs ?? 0))
  )

  const sourcePassages = groupTranscriptionSegments(
    matchingSourceSegments.map((segment) => ({
      ...segment,
      text: segment.editedText ?? segment.polishedText ?? segment.text,
    })),
    4000,
    1200,
    90000
  )

  const [sourceSelection, setSourceSelection] = useState<{
    sessionId: string
    ids: string[]
  }>({
    sessionId: snapshot.session.id,
    ids: snapshot.insights?.customization?.excludedSegmentIds ?? [],
  })
  const sourceSegmentIds = new Set(
    snapshot.segments.map((segment) => segment.id)
  )
  const excludedSourceIds =
    sourceSelection.sessionId === snapshot.session.id
      ? sourceSelection.ids.filter((id) => sourceSegmentIds.has(id))
      : (snapshot.insights?.customization?.excludedSegmentIds ?? []).filter(
          (id) => sourceSegmentIds.has(id)
        )
  const setExcludedSourceIds = (ids: string[]) => {
    setSourceSelection({ sessionId: snapshot.session.id, ids })
    setRestoredSummaryIds((current) =>
      current.filter((id) => !ids.includes(id))
    )
  }
  const [exportDraft, setExportDraft] = useState<SummaryExportDraft | null>(
    null
  )
  const applySummaryExportPreferences = useCallback(
    (standard: SummaryStandard) => {
      setExportFormat(standard.format)
      setSummaryExportOptions({
        summary: standard.summary,
        chapters: standard.chapters,
        topics: standard.topics,
        actionItems: standard.actionItems,
        boldSpeakers: standard.boldSpeakers,
      })
    },
    []
  )
  const applySummaryStandard = useCallback(
    (standard: SummaryStandard) => {
      setStandardName(standard.name)
      setSummaryInstructions(standard.instructions)
      applySummaryExportPreferences(standard)
    },
    [applySummaryExportPreferences]
  )
  const initialSummaryCustomization = useRef(
    snapshot.insights && snapshot.insights.status !== "idle"
      ? snapshot.insights.customization
      : undefined
  )
  useEffect(() => {
    let active = true
    Promise.all([
      api.get<{ standard: SummaryStandard | null }>(
        "/api/v1/profile/transcription-summary-standard"
      ),
      api.get<{ templates: SummaryTemplate[]; selectedTemplateId: string }>(
        "/api/v1/transcription/summary-templates"
      ),
    ])
      .then(([{ standard }, catalog]) => {
        if (!active) return
        setSavedStandard(standard)
        setSummaryTemplates(catalog.templates)
        const defaults = resolveSummaryTemplateDefaults(
          catalog.templates,
          catalog.selectedTemplateId,
          standard,
          initialSummaryCustomization.current
        )
        setSummaryTemplateId(defaults.template?.id ?? "")
        applySummaryStandard({
          ...defaults.exportPreferences,
          name: defaults.template?.name ?? standard?.name ?? "",
          instructions: defaults.instructions,
        })
        setSummaryExclusionRules(defaults.exclusionRules)
      })
      .catch((error: unknown) => {
        if (active)
          setStandardError(
            error instanceof Error
              ? error.message
              : "Could not load summary standard."
          )
      })
      .finally(() => {
        if (active) setStandardLoading(false)
      })
    return () => {
      active = false
    }
  }, [applySummaryStandard])
  const saveSummaryStandard = async (
    instructions = summaryInstructions,
    writingStyleOnly = false
  ) => {
    setStandardSaving(true)
    setStandardMessage("")
    setStandardError("")
    try {
      const { standard } = await api.put<{ standard: SummaryStandard }>(
        "/api/v1/profile/transcription-summary-standard",
        writingStyleOnly
          ? { ...(savedStandard ?? defaultSummaryStandard), instructions }
          : {
              ...summaryExportOptions,
              name: standardName,
              instructions,
              format: exportFormat,
            }
      )
      setSavedStandard(standard)
      setStandardMessage(
        "Your standard will apply to future summaries and exports across devices."
      )
      return true
    } catch (error) {
      setStandardError(
        error instanceof Error
          ? error.message
          : "Could not save summary standard."
      )
      return false
    } finally {
      setStandardSaving(false)
    }
  }
  const chooseSummaryTemplate = (id: string) => {
    setSummaryTemplateId(id)
    setTemplateError("")
    const template = summaryTemplates.find((item) => item.id === id)
    if (template) {
      applySummaryStandard(template)
      setSummaryExclusionRules(template.exclusionRules)
    } else {
      setSummaryExclusionRules("")
      setSummaryInstructions(savedStandard?.instructions ?? "")
    }
    void api
      .put("/api/v1/transcription/summary-template-choice", { templateId: id })
      .catch((error: unknown) =>
        setTemplateError(
          error instanceof Error
            ? error.message
            : "Could not remember the selected template."
        )
      )
  }
  const saveTeamSummaryTemplate = async () => {
    if (!templateDraft || templateSaving) return
    setTemplateSaving(true)
    setTemplateError("")
    try {
      const result = templateDraft.id
        ? await api.put<{ template: SummaryTemplate }>(
            `/api/v1/transcription/summary-templates/${templateDraft.id}`,
            templateDraft
          )
        : await api.post<{ template: SummaryTemplate }>(
            "/api/v1/transcription/summary-templates",
            templateDraft
          )
      setSummaryTemplates((current) =>
        [
          ...current.filter((item) => item.id !== result.template.id),
          result.template,
        ].sort((a, b) => a.name.localeCompare(b.name))
      )
      setSummaryTemplateId(result.template.id)
      applySummaryStandard(result.template)
      setSummaryExclusionRules(result.template.exclusionRules)
      try {
        await api.put("/api/v1/transcription/summary-template-choice", {
          templateId: result.template.id,
        })
      } catch (error) {
        // The shared save already succeeded. A failed personal choice must not create another template on retry.
        onError(
          error instanceof Error
            ? error.message
            : t("Could not remember the selected template.")
        )
      }
      setTemplateDraft(null)
      setTemplateSuggestion(false)
    } catch (error) {
      setTemplateError(
        error instanceof Error
          ? error.message
          : "Could not save the team template."
      )
    } finally {
      setTemplateSaving(false)
    }
  }
  const deleteTeamSummaryTemplate = async () => {
    if (!templateDraft?.id || templateSaving) return
    setTemplateSaving(true)
    setTemplateError("")
    try {
      await api.delete(
        `/api/v1/transcription/summary-templates/${templateDraft.id}`
      )
      setSummaryTemplates((current) =>
        current.filter((item) => item.id !== templateDraft.id)
      )
      if (summaryTemplateId === templateDraft.id) {
        setSummaryTemplateId("")
        setSummaryExclusionRules("")
      }
      setTemplateDraft(null)
    } catch (error) {
      setTemplateError(
        error instanceof Error
          ? error.message
          : "Could not delete the team template."
      )
    } finally {
      setTemplateSaving(false)
    }
  }
  const proposeSummaryRule = async (text: string) => {
    if (ruleProposing) return
    setRuleProposing(true)
    setTemplateError("")
    try {
      const { rule } = await api.post<{ rule: string }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/summary-rule-proposal`,
        { text, language: locale },
        { timeoutMs: 150000 }
      )
      const original = summaryTemplates.find(
        (item) =>
          item.id ===
          (snapshot.insights?.customization?.templateId ?? summaryTemplateId)
      )
      const base = original ?? {
        ...defaultSummaryStandard,
        ...summaryExportOptions,
        format: exportFormat,
        name: t("My team's summary"),
        instructions: summaryInstructions,
        exclusionRules: summaryExclusionRules,
      }
      setTemplateDraft({
        ...base,
        id: original?.canEdit ? original.id : undefined,
        revision: original?.canEdit ? original.updatedAt : undefined,
        name:
          original && !original.canEdit
            ? t("{value0} (copy)", { value0: original.name })
            : base.name,
        exclusionRules: [base.exclusionRules, rule]
          .filter(Boolean)
          .join("\n\n"),
      })
      setTemplateSuggestion(true)
    } catch (error) {
      onError(
        error instanceof Error ? error.message : t("Could not suggest a rule.")
      )
    } finally {
      setRuleProposing(false)
    }
  }
  const summaryStandardControls = (
    <FieldGroup>
      <Field>
        <FieldLabel>{t("Language")}</FieldLabel>
        <Select
          disabled={
            insightsGenerating || snapshot.insights?.status === "processing"
          }
          items={insightLanguageOptions}
          value={insightLanguage}
          onValueChange={(value) => setInsightLanguage(value ?? "auto")}
        >
          <SelectTrigger aria-label={t("AI insight output language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {insightLanguageOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="summary-exclusion-rules">
          {t("What should be left out?")}
        </FieldLabel>
        <Textarea
          id="summary-exclusion-rules"
          maxLength={6000}
          value={summaryExclusionRules}
          onChange={(event) => setSummaryExclusionRules(event.target.value)}
          placeholder={t(
            "For example: Leave out purely organizational openings and closings. Keep substantive statements, including from the chair."
          )}
        />
      </Field>
      {templateError ? (
        <p role="alert" className="text-sm text-destructive">
          {t(templateError)}
        </p>
      ) : null}

      <Field>
        <FieldLabel htmlFor="summary-writing-style">
          {t("How should your summary read?")}
        </FieldLabel>
        <Textarea
          id="summary-writing-style"
          maxLength={4000}
          value={summaryInstructions}
          onChange={(event) => setSummaryInstructions(event.target.value)}
          placeholder={t(
            "For example: keep it brief, focus on decisions, and leave out small talk."
          )}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={standardLoading || standardSaving}
          onClick={() => void saveSummaryStandard(summaryInstructions, true)}
        >
          {t(standardSaving ? "Saving…" : "Remember writing style")}
        </Button>
        {savedStandard ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSummaryInstructions(savedStandard.instructions)}
          >
            {t("Use saved style")}
          </Button>
        ) : null}
      </div>
      {standardMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Saved for your next summaries.")}
        </p>
      ) : null}
      {standardError ? (
        <p role="alert" className="text-sm text-destructive">
          {t(standardError)}
        </p>
      ) : null}
    </FieldGroup>
  )
  const summaryExportQuery = () =>
    new URLSearchParams(
      Object.fromEntries(
        Object.entries(summaryExportOptions).map(([key, value]) => [
          key,
          String(value),
        ])
      )
    )
  const [actionItemsCopied, setActionItemsCopied] = useState(false)
  const [workflowDialogOpen, setWorkflowDialogOpen] = useState(false)
  const [workflowChoices, setWorkflowChoices] = useState<AgentWorkflow[]>([])
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowId, setWorkflowId] = useState("")
  const [workflowFields, setWorkflowFields] = useState<Record<string, string>>(
    {}
  )
  const [workflowRunning, setWorkflowRunning] = useState(false)
  const [workflowRunId, setWorkflowRunId] = useState("")
  const [workflowError, setWorkflowError] = useState("")
  const [workflowTranscriptTruncated, setWorkflowTranscriptTruncated] =
    useState(false)
  const [speakerSample, setSpeakerSample] = useState<{
    speakerId: string
    endOffsetMs: number
  } | null>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const recordings = useMemo(
    () => snapshot.recordings ?? [],
    [snapshot.recordings]
  )
  const effectiveRecordingId = recordings.some(
    (recording) => recording.id === selectedRecordingId
  )
    ? selectedRecordingId
    : (recordings[0]?.id ?? "")
  const selectedRecording = recordings.find(
    (recording) => recording.id === effectiveRecordingId
  )
  const audioSourceURL =
    mediaKind === "audio" &&
    audioSource?.recordingId === effectiveRecordingId &&
    !audioSource.error
      ? audioSource.url
      : ""
  const audioPlaybackError =
    mediaKind === "audio" && audioSource?.recordingId === effectiveRecordingId
      ? audioSource.error
      : ""
  const canSeek =
    mediaKind === "video"
      ? Boolean(snapshot.videoUpload?.playbackUrl)
      : mediaKind === "audio"
        ? Boolean(audioSourceURL)
        : false

  useEffect(() => {
    if (mediaKind !== "audio" || !effectiveRecordingId) {
      return
    }
    let cancelled = false
    let objectURL = ""
    const recordingId = effectiveRecordingId
    void api
      .getBlob(`/api/v1/transcription/recordings/${recordingId}`)
      .then((blob) => {
        if (cancelled) return
        objectURL = URL.createObjectURL(blob)
        setAudioSource({
          recordingId,
          url: objectURL,
          error: "",
        })
      })
      .catch((caught) => {
        if (cancelled) return
        setAudioSource({
          recordingId,
          url: "",
          error:
            caught instanceof Error
              ? caught.message
              : "Audio could not be loaded.",
        })
      })
    return () => {
      cancelled = true
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [effectiveRecordingId, mediaKind])

  const updateSnapshot = useCallback(
    (
      updater: (current: VideoTranscriptSnapshot) => VideoTranscriptSnapshot
    ) => {
      onSnapshotChange(updater)
    },
    [onSnapshotChange]
  )

  const speakerById = useMemo(
    () => new Map(snapshot.speakers.map((speaker) => [speaker.id, speaker])),
    [snapshot.speakers]
  )
  const displaySegments = useMemo(
    () =>
      snapshot.segments.map((segment) => {
        const verbatim = segment.text.trim() || segment.rawText?.trim() || ""
        const polished = segment.polishedText?.trim() || verbatim
        const edited = segment.editedText?.trim()
        return {
          ...segment,
          text:
            transcriptMode === "polished"
              ? polished
              : transcriptMode === "edited"
                ? (edited ?? polished)
                : verbatim,
        }
      }),
    [snapshot.segments, transcriptMode]
  )
  const displaySegmentById = useMemo(
    () => new Map(displaySegments.map((segment) => [segment.id, segment])),
    [displaySegments]
  )
  const transcript = useMemo(
    () => groupTranscriptionSegments(displaySegments),
    [displaySegments]
  )
  const isVideoProcessing = ["uploading", "queued", "processing"].includes(
    snapshot.videoUpload?.status ?? ""
  )
  const preview = useMemo(
    () => livePreviewSegments(snapshot.videoUpload, isVideoProcessing),
    [isVideoProcessing, snapshot.videoUpload]
  )
  const polishedAvailable = snapshot.segments.some((segment) =>
    segment.polishedText?.trim()
  )
  const editedAvailable = snapshot.segments.some(
    (segment) => segment.editedText != null
  )
  const filteredTranscript = useMemo(
    () =>
      transcript.filter((message) =>
        message.segmentIds.some((segmentId) => {
          const segment = displaySegmentById.get(segmentId)
          return (
            segment &&
            transcriptMatches(
              segment,
              transcriptQuery,
              speakerFilter,
              speakerById,
              qualityOnly,
              t
            )
          )
        })
      ),
    [
      displaySegmentById,
      qualityOnly,
      speakerById,
      speakerFilter,
      transcript,
      transcriptQuery,
      t,
    ]
  )
  const filteredSegments = useMemo(
    () =>
      displaySegments.filter((segment) =>
        transcriptMatches(
          segment,
          transcriptQuery,
          speakerFilter,
          speakerById,
          qualityOnly,
          t
        )
      ),
    [
      displaySegments,
      qualityOnly,
      speakerById,
      speakerFilter,
      transcriptQuery,
      t,
    ]
  )
  const editParagraphs = useMemo(
    () =>
      groupTranscriptionSegments(
        snapshot.segments.map((segment) => ({
          ...segment,
          text:
            segment.editedText?.trim() ??
            segment.polishedText?.trim() ??
            segment.text.trim(),
        })),
        4000,
        850,
        45_000
      ).filter((message) =>
        message.segmentIds.some((id) =>
          filteredSegments.some((segment) => segment.id === id)
        )
      ),
    [snapshot.segments, filteredSegments]
  )
  const activeMessageId = useMemo(
    () => activeTranscriptionMessageId(transcript, currentTimeMs),
    [currentTimeMs, transcript]
  )
  const activeSegmentId = useMemo(
    () => activeTranscriptionSegmentId(displaySegments, currentTimeMs),
    [currentTimeMs, displaySegments]
  )
  const displayDurationMs =
    mediaKind === "audio"
      ? audioDurationMs
      : mediaKind === "video"
        ? videoDurationMs || snapshot.videoUpload?.durationMs || 0
        : 0
  const hasActiveFilter = Boolean(
    transcriptQuery.trim() || speakerFilter !== "all" || qualityOnly
  )
  const activeMatchIndex = Math.min(
    matchIndex,
    Math.max(0, filteredTranscript.length - 1)
  )
  const annotations = snapshot.annotations ?? []
  const insights = snapshot.insights ?? {
    sessionId: snapshot.session.id,
    status: "idle" as const,
    language: "auto",
    chapters: [],
    topics: [],
    actionItems: [],
    updatedAt: "",
  }
  const summaryLanguage =
    insights.language === "auto" ? snapshot.session.language : insights.language
  const selectedWorkflow = workflowChoices.find(
    (item) => item.id === workflowId
  )
  const workflowInputFields = selectedWorkflow
    ? workflowInputNames(selectedWorkflow.definition)
    : []
  const validInsightChapters = useMemo(() => {
    const chapters = insights.chapters ?? []
    return chapters.filter(
      (chapter) =>
        Number.isFinite(chapter.startOffsetMs) &&
        chapter.startOffsetMs >= 0 &&
        (displayDurationMs <= 0 || chapter.startOffsetMs <= displayDurationMs)
    )
  }, [displayDurationMs, insights.chapters])
  const hiddenInsightChapterCount = Math.max(
    0,
    (insights.chapters?.length ?? 0) - validInsightChapters.length
  )
  const exportSupportsInsights = ["pdf", "docx", "md", "txt"].includes(
    exportFormat
  )
  const insightsReady = insights.status === "completed"
  const insightsProcessing =
    insightsGenerating || insights.status === "processing"
  const polishProcessing =
    polishGenerating || snapshot.session.polishStatus === "processing"
  const canPolishTranscript =
    snapshot.session.kind === "live" &&
    Boolean(snapshot.session.grammarEndpointId) &&
    snapshot.segments.length > 0
  const speakerSummaries = useMemo<SpeakerSummary[]>(() => {
    const segmentsBySpeaker = new Map<string, TranscriptionSegment[]>()
    for (const segment of displaySegments) {
      if (!segment.speakerId) continue
      const items = segmentsBySpeaker.get(segment.speakerId) ?? []
      items.push(segment)
      segmentsBySpeaker.set(segment.speakerId, items)
    }
    return snapshot.speakers.map((speaker) => {
      const segments = segmentsBySpeaker.get(speaker.id) ?? []
      const first = segments[0]
      const start = first ? Math.max(0, first.startOffsetMs) : null
      const end = first
        ? Math.max(start ?? 0, first.endOffsetMs || (start ?? 0) + 2500)
        : null
      const sampleEnd =
        start === null || end === null
          ? null
          : Math.min(
              displayDurationMs > start ? displayDurationMs : start + 8000,
              Math.max(start + 1500, Math.min(start + 8000, end + 4000))
            )
      return {
        speaker,
        segmentCount: segments.length,
        speakingMs: segments.reduce((total, item) => {
          const duration = item.endOffsetMs - item.startOffsetMs
          return total + (duration > 0 ? duration : 0)
        }, 0),
        sampleStartMs: start,
        sampleEndMs: sampleEnd,
        sampleText: first?.text.trim() ?? "",
      }
    })
  }, [displayDurationMs, displaySegments, snapshot.speakers])

  useEffect(() => {
    if (filteredTranscript.length === 0) return
    const message =
      filteredTranscript[Math.min(matchIndex, filteredTranscript.length - 1)]
    messageRefs.current.get(message.id)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    })
  }, [filteredTranscript, matchIndex])

  useEffect(() => {
    if (
      !mediaPlaying ||
      workspaceView !== "review" ||
      editorOpen ||
      hasActiveFilter ||
      !activeMessageId
    ) {
      return
    }
    const message = messageRefs.current.get(activeMessageId)
    if (!message) return
    const frame = window.requestAnimationFrame(() => {
      message.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeMessageId,
    editorOpen,
    hasActiveFilter,
    mediaPlaying,
    workspaceView,
  ])

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("t")
    const offset = raw ? Number(raw) : NaN
    const media = mediaKind === "audio" ? audioRef.current : videoRef.current
    if (!Number.isFinite(offset) || offset < 0 || !media) return
    const seek = () => {
      media.currentTime = offset / 1000
      onCurrentTimeChange(offset)
    }
    seek()
    media.addEventListener("loadedmetadata", seek)
    return () => media.removeEventListener("loadedmetadata", seek)
  }, [
    audioSourceURL,
    mediaKind,
    onCurrentTimeChange,
    snapshot.videoUpload?.playbackUrl,
    videoRef,
  ])

  const seekTo = useCallback(
    (offsetMs: number, play = true) => {
      const media = mediaKind === "audio" ? audioRef.current : videoRef.current
      if (!media) return
      setSpeakerSample(null)
      const durationFromElementMs =
        Number.isFinite(media.duration) && media.duration > 0
          ? media.duration * 1000
          : 0
      const knownDurationMs = Math.max(displayDurationMs, durationFromElementMs)
      const safeOffsetMs = Math.max(0, offsetMs)
      const boundedOffsetMs =
        knownDurationMs > 0
          ? Math.min(safeOffsetMs, knownDurationMs)
          : safeOffsetMs
      media.currentTime = boundedOffsetMs / 1000
      onCurrentTimeChange(boundedOffsetMs)
      if (play) void media.play().catch(() => undefined)
    },
    [displayDurationMs, mediaKind, onCurrentTimeChange, videoRef]
  )

  const playSpeakerSample = useCallback(
    (summary: SpeakerSummary) => {
      const media = mediaKind === "audio" ? audioRef.current : videoRef.current
      if (!media || !canSeek) return
      if (speakerSample?.speakerId === summary.speaker.id) {
        media.pause()
        setSpeakerSample(null)
        return
      }
      if (summary.sampleStartMs === null || summary.sampleEndMs === null) return
      media.currentTime = summary.sampleStartMs / 1000
      onCurrentTimeChange(summary.sampleStartMs)
      setSpeakerSample({
        speakerId: summary.speaker.id,
        endOffsetMs: summary.sampleEndMs,
      })
      void media.play().catch(() => setSpeakerSample(null))
    },
    [
      canSeek,
      mediaKind,
      onCurrentTimeChange,
      speakerSample?.speakerId,
      videoRef,
    ]
  )

  const saveParagraphEdit = async (
    message: (typeof editParagraphs)[number]
  ) => {
    const draft = paragraphDrafts[message.id]
    if (draft === undefined || draft.trim() === message.text.trim()) return
    const segments = message.segmentIds
      .map((id) => snapshot.segments.find((segment) => segment.id === id))
      .filter((segment): segment is TranscriptionSegment => Boolean(segment))
    if (!segments.length) return
    const words = draft.trim().split(/\s+/u).filter(Boolean)
    const originalCounts = segments.map(
      (segment) =>
        (
          segment.editedText?.trim() ||
          segment.polishedText?.trim() ||
          segment.text.trim()
        )
          .split(/\s+/u)
          .filter(Boolean).length
    )
    const total =
      originalCounts.reduce((sum, count) => sum + count, 0) || segments.length
    let position = 0
    const edits = segments.map((segment, index) => {
      const end =
        index === segments.length - 1
          ? words.length
          : Math.max(
              position,
              Math.round(
                (words.length *
                  originalCounts
                    .slice(0, index + 1)
                    .reduce((sum, count) => sum + count, 0)) /
                  total
              )
            )
      const editedText = words.slice(position, end).join(" ")
      position = end
      return { id: segment.id, editedText }
    })
    setSavingSegmentId(message.id)
    try {
      const result = await api.patch<{ segments: TranscriptionSegment[] }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/segments/batch`,
        { edits }
      )
      const updated = new Map(
        result.segments.map((segment) => [segment.id, segment])
      )
      updateSnapshot((current) => ({
        ...current,
        segments: current.segments.map((item) => updated.get(item.id) ?? item),
      }))
      setParagraphDrafts((current) => {
        const next = { ...current }
        delete next[message.id]
        return next
      })
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("The paragraph could not be saved.")
      )
    } finally {
      setSavingSegmentId(null)
    }
  }

  const assignSelectedSpeaker = async () => {
    if (!assignmentSpeakerId || selectedSegmentIds.length === 0) return
    try {
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/segments/assign-speaker`,
        { segmentIds: selectedSegmentIds, speakerId: assignmentSpeakerId }
      )
      updateSnapshot((current) => ({
        ...current,
        segments: current.segments.map((segment) =>
          selectedSegmentIds.includes(segment.id)
            ? { ...segment, speakerId: assignmentSpeakerId }
            : segment
        ),
      }))
      setSelectedSegmentIds([])
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("Speaker assignment failed.")
      )
    }
  }

  const createAnnotation = async () => {
    if (
      !annotationTarget ||
      (annotationKind === "comment" && !annotationNote.trim())
    ) {
      return
    }
    setAnnotationSaving(true)
    try {
      const result = await api.post<{ annotation: TranscriptionAnnotation }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/annotations`,
        {
          kind: annotationKind,
          note: annotationNote.trim(),
          segmentId: annotationTarget.segmentId,
          startOffsetMs: annotationTarget.startOffsetMs,
          endOffsetMs: annotationTarget.endOffsetMs,
        }
      )
      updateSnapshot((current) => ({
        ...current,
        annotations: [...(current.annotations ?? []), result.annotation].sort(
          (left, right) => left.startOffsetMs - right.startOffsetMs
        ),
      }))
      setAnnotationTarget(null)
      setAnnotationNote("")
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("The annotation could not be saved.")
      )
    } finally {
      setAnnotationSaving(false)
    }
  }

  const deleteAnnotation = async (annotation: TranscriptionAnnotation) => {
    try {
      await api.delete(
        `/api/v1/transcription/sessions/${snapshot.session.id}/annotations/${annotation.id}`
      )
      updateSnapshot((current) => ({
        ...current,
        annotations: (current.annotations ?? []).filter(
          (item) => item.id !== annotation.id
        ),
      }))
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("The annotation could not be deleted.")
      )
    }
  }

  const copyTimestampLink = async (offsetMs: number) => {
    const url = new URL(window.location.href)
    url.searchParams.set("t", String(Math.max(0, Math.floor(offsetMs))))
    try {
      await navigator.clipboard.writeText(url.toString())
      onError("")
    } catch {
      onError("The timestamp link could not be copied.")
    }
  }

  const identifySpeakers = async () => {
    setIdentifyRunning(true)
    try {
      const participants = identifyParticipants
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, ...role] = line.split(/[,;]/)
          return { name: name.trim(), role: role.join(",").trim() }
        })
      const result = await api.post<{ speakers: TranscriptionSpeaker[] }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/identify`,
        { participants }
      )
      updateSnapshot((current) => ({ ...current, speakers: result.speakers }))
      setIdentifyOpen(false)
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("The speakers could not be identified.")
      )
    } finally {
      setIdentifyRunning(false)
    }
  }

  const resolveSpeakerSuggestion = async (
    speaker: TranscriptionSpeaker,
    accept: boolean
  ) => {
    const base = `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/${speaker.id}`
    const name = speaker.suggestedName?.trim()
    try {
      if (accept && name) {
        await api.patch(base, { displayName: name })
      } else {
        await api.delete(`${base}/suggestion`)
      }
      updateSnapshot((current) => ({
        ...current,
        speakers: current.speakers.map((item) =>
          item.id === speaker.id
            ? {
                ...item,
                ...(accept && name
                  ? { displayName: name, nameSource: "manual" as const }
                  : {}),
                suggestedName: "",
                suggestionConfidence: 0,
                suggestionEvidence: "",
              }
            : item
        ),
      }))
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("The suggestion could not be saved.")
      )
    }
  }

  const mergeSpeakers = async () => {
    if (!mergeSourceId || !mergeTargetId || mergeSourceId === mergeTargetId)
      return
    setMergeSaving(true)
    try {
      await api.post(
        `/api/v1/transcription/sessions/${snapshot.session.id}/speakers/merge`,
        { sourceId: mergeSourceId, targetId: mergeTargetId }
      )
      updateSnapshot((current) => ({
        ...current,
        speakers: current.speakers.filter(
          (speaker) => speaker.id !== mergeSourceId
        ),
        segments: current.segments.map((segment) =>
          segment.speakerId === mergeSourceId
            ? { ...segment, speakerId: mergeTargetId }
            : segment
        ),
      }))
      setMergeOpen(false)
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("The speakers could not be merged.")
      )
    } finally {
      setMergeSaving(false)
    }
  }

  const polishTranscript = async () => {
    if (!canPolishTranscript || polishProcessing) return
    setPolishGenerating(true)
    updateSnapshot((current) => ({
      ...current,
      session: { ...current.session, polishStatus: "processing" },
    }))
    try {
      const result = await api.post<{
        snapshot: TranscriptWorkspaceSnapshot
      }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/polish`,
        undefined,
        { timeoutMs: 15 * 60 * 1000 }
      )
      updateSnapshot(() => result.snapshot)
      setTranscriptMode("polished")
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("Grammar polish could not be generated.")
      )
      updateSnapshot((current) => ({
        ...current,
        session: { ...current.session, polishStatus: "failed" },
      }))
    } finally {
      setPolishGenerating(false)
    }
  }

  const waitForInsights = async (initial: TranscriptionInsights) => {
    const insightsUrl = `/api/v1/transcription/sessions/${snapshot.session.id}/insights`
    const deadline = Date.now() + 35 * 60 * 1000
    let insights = initial
    while (insights.status === "processing") {
      if (Date.now() > deadline) {
        throw new Error("AI insights generation timed out.")
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
      insights = (
        await api.get<{ insights: TranscriptionInsights }>(insightsUrl)
      ).insights
    }
    if (insights.status === "failed") {
      throw new Error(
        insights.error || t("AI insights could not be generated.")
      )
    }
    return insights
  }

  // Resume polling after a reload while the backend is still generating.
  const insightsProcessingRemote = snapshot.insights?.status === "processing"
  useEffect(() => {
    if (!insightsProcessingRemote || !snapshot.insights) return
    if (insightsPollingRef.current) return
    insightsPollingRef.current = true
    let cancelled = false
    waitForInsights(snapshot.insights)
      .then((finished) => {
        if (!cancelled)
          updateSnapshot((current) => ({ ...current, insights: finished }))
      })
      .catch((caught) => {
        if (cancelled) return
        onError(
          caught instanceof Error
            ? caught.message
            : "AI insights could not be generated."
        )
        updateSnapshot((current) => ({
          ...current,
          insights: current.insights && {
            ...current.insights,
            status: "failed",
          },
        }))
      })
      .finally(() => {
        insightsPollingRef.current = false
      })
    return () => {
      cancelled = true
      insightsPollingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insightsProcessingRemote, snapshot.session.id])

  const generateInsights = async () => {
    if (insightsPollingRef.current) return
    insightsPollingRef.current = true
    setActionItemsCopied(false)
    setInsightsGenerating(true)
    updateSnapshot((current) => ({
      ...current,
      insights: {
        ...(current.insights ?? {
          sessionId: current.session.id,
          language: insightLanguage,
          updatedAt: "",
        }),
        sessionId: current.session.id,
        language: insightLanguage,
        status: "processing",
      },
    }))
    try {
      // The backend generates in the background; poll so no single request
      // outlives the gateway timeout.
      const result = await api.post<{ insights: TranscriptionInsights }>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/insights`,
        {
          language: insightLanguage,
          instructions: summaryInstructions,
          excludedSegmentIds: excludedSourceIds,
          templateId: summaryTemplateId,
          exclusionRules: summaryExclusionRules,
          restoredSegmentIds: restoredSummaryIds.filter((id) =>
            sourceSegmentIds.has(id)
          ),
        }
      )
      const finished = await waitForInsights(result.insights)
      updateSnapshot((current) => ({ ...current, insights: finished }))
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("AI insights could not be generated.")
      )
      updateSnapshot((current) => ({
        ...current,
        insights: {
          ...(current.insights ?? {
            sessionId: current.session.id,
            language: insightLanguage,
            updatedAt: "",
          }),
          language: insightLanguage,
          status: "failed",
        },
      }))
    } finally {
      insightsPollingRef.current = false
      setInsightsGenerating(false)
    }
  }

  const copyActionItems = async () => {
    const actionItems = insights.actionItems ?? []
    if (!actionItems.length) return
    try {
      await navigator.clipboard.writeText(
        actionItems.map((item) => `- ${item}`).join("\n")
      )
      setActionItemsCopied(true)
      onError("")
    } catch {
      onError("Action items could not be copied. Check clipboard permissions.")
    }
  }

  const workflowSource = (): TranscriptionWorkflowSource => ({
    session: snapshot.session,
    segments: snapshot.segments,
    speakers: snapshot.speakers,
    insights,
    url:
      typeof window === "undefined"
        ? ""
        : `${window.location.origin}${window.location.pathname}`,
  })

  const openWorkflowDialog = async () => {
    setWorkflowDialogOpen(true)
    setWorkflowLoading(true)
    setWorkflowChoices([])
    setWorkflowError("")
    setWorkflowRunId("")
    setWorkflowTranscriptTruncated(
      transcriptionWorkflowTranscript(workflowSource()).truncated
    )
    try {
      const result = await api.get<{ workflows: AgentWorkflow[] }>(
        "/api/v1/agent-workflows"
      )
      setWorkflowChoices(result.workflows)
      const selected =
        result.workflows.find((item) => item.id === workflowId) ??
        result.workflows.find((item) =>
          item.name.toLowerCase().includes("meeting")
        ) ??
        result.workflows[0]
      setWorkflowId(selected?.id ?? "")
      setWorkflowFields(
        selected ? transcriptionWorkflowPrefill(selected, workflowSource()) : {}
      )
    } catch (caught) {
      setWorkflowError(
        caught instanceof Error
          ? caught.message
          : "Workflows could not be loaded."
      )
    } finally {
      setWorkflowLoading(false)
    }
  }

  const runInsightWorkflow = async () => {
    if (!workflowId || workflowRunning) return
    const input = transcriptionWorkflowInput(workflowSource(), workflowFields)
    if (new TextEncoder().encode(JSON.stringify(input)).length > 512 * 1024) {
      setWorkflowError(
        "The workflow input is too large. Shorten the transcript field before starting."
      )
      return
    }
    setWorkflowRunning(true)
    setWorkflowError("")
    try {
      const result = await api.post<{ run: AgentRun }>(
        `/api/v1/agent-workflows/${workflowId}/runs`,
        { input }
      )
      setWorkflowRunId(result.run.id)
    } catch (caught) {
      setWorkflowError(
        caught instanceof Error
          ? caught.message
          : "The workflow could not be started."
      )
    } finally {
      setWorkflowRunning(false)
    }
  }

  const startChat = async () => {
    if (chatStarting) return
    setChatStarting(true)
    try {
      await onStartChat(snapshot.session.id)
      onError("")
    } catch (caught) {
      onError(
        caught instanceof Error
          ? caught.message
          : t("A chat could not be started from this transcript.")
      )
    } finally {
      setChatStarting(false)
    }
  }

  const restoreSummaryPassages = (ids: string[]) => {
    const customization = snapshot.insights?.customization
    setSourceSelection({
      sessionId: snapshot.session.id,
      ids: excludedSourceIds.filter((id) => !ids.includes(id)),
    })
    setRestoredSummaryIds([...new Set([...restoredSummaryIds, ...ids])])
    if (customization) {
      setSummaryInstructions(customization.instructions)
      setSummaryExclusionRules(customization.exclusionRules ?? "")
      setSummaryTemplateId(
        summaryTemplates.some((item) => item.id === customization.templateId)
          ? (customization.templateId ?? "")
          : ""
      )
    }
    setExportOpen(false)
    setSummarySetupOpen(true)
  }

  const exportHasSummaryContent =
    (summaryExportOptions.summary &&
      (
        exportDraft?.summaryParagraphs ?? [snapshot.insights?.summary ?? ""]
      ).some((text) => text.trim())) ||
    (summaryExportOptions.chapters &&
      (exportDraft?.chapterIndices ?? snapshot.insights?.chapters ?? [])
        .length > 0) ||
    (summaryExportOptions.topics &&
      (exportDraft?.topicIndices ?? snapshot.insights?.topics ?? []).length >
        0) ||
    (summaryExportOptions.actionItems &&
      (exportDraft?.actionItemIndices ?? snapshot.insights?.actionItems ?? [])
        .length > 0)

  const exportTranscript = async (remember = false) => {
    if (exporting) return
    setExporting(true)
    setExportError("")
    try {
      if (
        remember &&
        !(await saveSummaryStandard(
          savedStandard?.instructions ?? summaryInstructions
        ))
      )
        return
      const includeInsights =
        exportSupportsInsights && includeInsightsInExport && insightsReady
      const query = summaryExportQuery()
      if (insightsOnlyExport) query.set("insightsOnly", "true")
      else if (includeInsights) query.set("includeInsights", "true")
      const exportUrl = `/api/v1/transcription/sessions/${snapshot.session.id}/export/${exportFormat}?${query}`
      const blob =
        exportDraft && (insightsOnlyExport || includeInsights)
          ? await api.postBlob(exportUrl, exportDraft)
          : await api.getBlob(exportUrl)
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${snapshot.session.title || "transcript"}${insightsOnlyExport ? "-summary" : ""}.${exportFormat === "markdown" ? "md" : exportFormat}`
      link.click()
      URL.revokeObjectURL(url)
      setExportOpen(false)
      onError("")
    } catch (caught) {
      setExportError(
        caught instanceof Error
          ? caught.message
          : "The transcript export failed."
      )
    } finally {
      setExporting(false)
    }
  }

  const hasInspectorContent = mediaKind !== "none" || annotations.length > 0

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <Tabs
          aria-label={t("Transcript workspace sections")}
          onValueChange={(value) => {
            if (
              value === "review" ||
              value === "insights" ||
              value === "speakers"
            ) {
              if (value === "insights" && mediaPlaying)
                setSummaryRecordingOpen(true)
              setWorkspaceView(value)
            }
          }}
          value={workspaceView !== "details" ? workspaceView : null}
        >
          <TabsList>
            <TabsTrigger value="review">{t("Transcript")}</TabsTrigger>
            <TabsTrigger value="insights">{t("Summary")}</TabsTrigger>
            <TabsTrigger value="speakers">{t("Speakers")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={chatStarting || !snapshot.segments.length}
            onClick={() => void startChat()}
            size="sm"
            variant="ghost"
          >
            {chatStarting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <MessageSquarePlus data-icon="inline-start" />
            )}
            {chatStarting ? t("Starting chat…") : t("Ask about this")}
          </Button>
          <Menu>
            <Menu.Trigger
              render={
                <Button
                  aria-label={t("More actions")}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontal />
            </Menu.Trigger>
            <Menu.Content align="end" className="w-52">
              <Menu.Group>
                {workspaceView === "insights" ? (
                  <Menu.Item
                    disabled={
                      standardLoading ||
                      insightsProcessing ||
                      !snapshot.segments.length
                    }
                    onClick={() => setSummarySetupOpen(true)}
                  >
                    <Pencil data-icon="inline-start" />
                    {t(insightsReady ? "Adjust summary" : "Generate summary")}
                  </Menu.Item>
                ) : null}
                {insightsReady ? (
                  <Menu.Item onClick={() => void openWorkflowDialog()}>
                    <GitBranch data-icon="inline-start" />
                    {t("Use in workflow")}
                  </Menu.Item>
                ) : null}
                {workspaceView === "insights" && mediaKind !== "none" ? (
                  <Menu.Item
                    onClick={() => {
                      if (summaryRecordingOpen)
                        (mediaKind === "audio"
                          ? audioRef.current
                          : videoRef.current
                        )?.pause()
                      setSummaryRecordingOpen((current) => !current)
                    }}
                  >
                    <Play data-icon="inline-start" />
                    {t(
                      summaryRecordingOpen ? "Hide recording" : "Show recording"
                    )}
                  </Menu.Item>
                ) : null}
                <Menu.Item onClick={() => setWorkspaceView("details")}>
                  <Clock3 data-icon="inline-start" /> {t("Transcript details")}
                </Menu.Item>
              </Menu.Group>
            </Menu.Content>
          </Menu>
          <Button
            disabled={
              !snapshot.segments.length ||
              (workspaceView === "insights" &&
                (!insightsReady || standardLoading))
            }
            onClick={() => {
              setExportError("")
              const summaryOnly = workspaceView === "insights"
              setInsightsOnlyExport(summaryOnly)
              if (
                summaryOnly &&
                !["pdf", "docx", "md", "txt", "json"].includes(exportFormat)
              )
                setExportFormat(savedStandard?.format ?? "pdf")
              setExportDraft(null)
              setExportOpen(true)
            }}
            size="sm"
          >
            <Download data-icon="inline-start" /> {t("Download")}
          </Button>
        </div>
      </div>
      <Dialog open={summarySetupOpen} onOpenChange={setSummarySetupOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl sm:p-0">
          <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-4 sm:px-6 sm:pr-12">
            <DialogTitle>{t("Create your summary")}</DialogTitle>
            <DialogDescription>
              {t("Choose a template. We will take care of the rest.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-4 sm:px-6">
            <SummaryTemplatePicker
              templates={summaryTemplates}
              selectedId={summaryTemplateId}
              onSelect={chooseSummaryTemplate}
              loading={standardLoading}
              onEdit={(draft) => {
                setTemplateSuggestion(false)
                setTemplateError("")
                setTemplateDraft(draft)
              }}
            />

            <details className="rounded-lg bg-muted p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t("Adjust for this summary")}
              </summary>
              <div className="mt-4">{summaryStandardControls}</div>
            </details>
            {restoredSummaryIds.length ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t(
                  "{value0} passages will be included even if a template rule matches. Create the summary again to apply this.",
                  { value0: restoredSummaryIds.length }
                )}
              </p>
            ) : null}
            <details className="rounded-lg bg-muted p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t("Choose specific passages")}
                {excludedSourceIds.length ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("{value0} left out", {
                      value0: excludedSourceIds.length,
                    })}
                  </span>
                ) : null}
              </summary>
              <FieldGroup className="mt-4">
                <p className="text-sm text-muted-foreground">
                  {t(
                    "The whole conversation is used by default. Only change this if you want to leave out a specific passage yourself."
                  )}
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t("Use the checked passages")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExcludedSourceIds([])}
                    >
                      {t("Include all")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setExcludedSourceIds(
                          snapshot.segments.map((segment) => segment.id)
                        )
                      }
                    >
                      {t("Exclude all")}
                    </Button>
                  </div>
                </div>
                <details className="rounded-lg bg-muted p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("Find specific passages")}
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    <Input
                      aria-label={t("Search the conversation")}
                      placeholder={t("Search the conversation")}
                      value={sourceSearch}
                      onChange={(event) => setSourceSearch(event.target.value)}
                    />
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field>
                        <FieldLabel htmlFor="summary-source-from">
                          {t("From")}
                        </FieldLabel>
                        <Input
                          id="summary-source-from"
                          placeholder="0:00"
                          aria-invalid={sourceFromMs === null}
                          value={sourceFrom}
                          onChange={(event) =>
                            setSourceFrom(event.target.value)
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="summary-source-to">
                          {t("To")}
                        </FieldLabel>
                        <Input
                          id="summary-source-to"
                          placeholder="12:30"
                          aria-invalid={sourceToMs === null}
                          value={sourceTo}
                          onChange={(event) => setSourceTo(event.target.value)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{t("Speaker")}</FieldLabel>
                        <Select
                          value={sourceSpeaker}
                          onValueChange={(value) =>
                            setSourceSpeaker(value ?? "all")
                          }
                          items={[
                            { value: "all", label: t("All speakers") },
                            ...snapshot.speakers.map((speaker) => ({
                              value: speaker.id,
                              label: speaker.displayName || speaker.label,
                            })),
                          ]}
                        >
                          <SelectTrigger aria-label={t("Speaker")}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="all">
                                {t("All speakers")}
                              </SelectItem>
                              {snapshot.speakers.map((speaker) => (
                                <SelectItem key={speaker.id} value={speaker.id}>
                                  {speaker.displayName || speaker.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!matchingSourceSegments.length}
                        onClick={() =>
                          setExcludedSourceIds([
                            ...new Set([
                              ...excludedSourceIds,
                              ...matchingSourceSegments.map(
                                (segment) => segment.id
                              ),
                            ]),
                          ])
                        }
                      >
                        {t("Exclude matching passages")} (
                        {matchingSourceSegments.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!matchingSourceSegments.length}
                        onClick={() => {
                          const matching = new Set(
                            matchingSourceSegments.map((segment) => segment.id)
                          )
                          setExcludedSourceIds(
                            excludedSourceIds.filter((id) => !matching.has(id))
                          )
                        }}
                      >
                        {t("Include matching passages")}
                      </Button>
                      {selectedSegmentIds.length ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setExcludedSourceIds([
                              ...new Set([
                                ...excludedSourceIds,
                                ...selectedSegmentIds,
                              ]),
                            ])
                          }
                        >
                          {t("Exclude selected transcript lines")} (
                          {selectedSegmentIds.length})
                        </Button>
                      ) : null}
                    </div>
                    {!sourceTimeRangeValid ? (
                      <p role="status" className="text-sm text-destructive">
                        {t(
                          "Enter a time like 2:30, with the end after the start."
                        )}
                      </p>
                    ) : null}
                  </div>
                </details>
                <div className="flex max-h-80 flex-col gap-3 overflow-y-auto rounded-lg bg-muted p-3">
                  {sourcePassages.map((passage) => {
                    const includedCount = passage.segmentIds.filter(
                      (id) => !excludedSourceIds.includes(id)
                    ).length
                    const speaker = snapshot.speakers.find(
                      (item) => item.id === passage.speakerKey
                    )
                    const rawName = speaker?.displayName || speaker?.label || ""
                    const genericSpeaker = /^SPEAKER[_ -]?(\d+)$/i.exec(rawName)
                    const name = genericSpeaker
                      ? t("Speaker {value0}", {
                          value0: Number(genericSpeaker[1]),
                        })
                      : rawName || t("Speaker")
                    return (
                      <Field key={passage.id} orientation="horizontal">
                        <Checkbox
                          id={`summary-source-${passage.id}`}
                          checked={includedCount === passage.segmentIds.length}
                          indeterminate={
                            includedCount > 0 &&
                            includedCount < passage.segmentIds.length
                          }
                          onCheckedChange={(checked) => {
                            const groupIds = new Set(passage.segmentIds)
                            setExcludedSourceIds(
                              checked
                                ? excludedSourceIds.filter(
                                    (id) => !groupIds.has(id)
                                  )
                                : [
                                    ...new Set([
                                      ...excludedSourceIds,
                                      ...passage.segmentIds,
                                    ]),
                                  ]
                            )
                          }}
                        />
                        <FieldLabel htmlFor={`summary-source-${passage.id}`}>
                          <span className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                              {formatVideoDuration(passage.startOffsetMs)} ·{" "}
                              {name}
                            </span>
                            <span className="text-sm leading-6">
                              {passage.text}
                            </span>
                          </span>
                        </FieldLabel>
                      </Field>
                    )
                  })}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Generation replaces the shared summary, chapters, topics, and action items. The original transcript is preserved."
                  )}
                </p>
              </FieldGroup>
            </details>
            {snapshot.segments.length > 0 &&
            excludedSourceIds.length >= snapshot.segments.length ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("Keep at least one passage to create a summary.")}
              </p>
            ) : null}
            {templateError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(templateError)}
              </p>
            ) : null}
            {standardError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(standardError)}
              </p>
            ) : null}
          </div>
          <DialogFooter className="shrink-0 px-5 py-4 sm:px-6">
            <Button variant="ghost" onClick={() => setSummarySetupOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                standardLoading ||
                insightsProcessing ||
                excludedSourceIds.length >= snapshot.segments.length
              }
              onClick={() => {
                setSummarySetupOpen(false)
                void generateInsights()
              }}
            >
              {t("Generate summary")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SummaryTemplateEditor
        key={templateDraft?.id ?? "new"}
        draft={templateDraft}
        onChange={setTemplateDraft}
        onClose={() => {
          setTemplateDraft(null)
          setTemplateSuggestion(false)
          setTemplateError("")
        }}
        onSave={() => void saveTeamSummaryTemplate()}
        onDelete={() => void deleteTeamSummaryTemplate()}
        saving={templateSaving}
        error={templateError}
        suggested={templateSuggestion}
      />
      <TranscriptionExportDialog
        key={String(exportOpen)}
        open={exportOpen}
        onOpenChange={setExportOpen}
        summaryOnly={insightsOnlyExport}
        title={snapshot.session.title}
        speakerNames={snapshot.speakers
          .flatMap((speaker) => [speaker.displayName, speaker.label])
          .filter((name): name is string => Boolean(name))}
        insights={insights}
        format={exportFormat}
        onFormatChange={setExportFormat}
        options={summaryExportOptions}
        onOptionsChange={setSummaryExportOptions}
        includeSummary={includeInsightsInExport}
        onIncludeSummaryChange={setIncludeInsightsInExport}
        omissions={insights.customization?.automaticOmissions ?? []}
        restoredIds={restoredSummaryIds}
        onRestorePassages={restoreSummaryPassages}
        onSuggestRule={(text) => void proposeSummaryRule(text)}
        ruleProposing={ruleProposing}
        onDraftChange={setExportDraft}
        onDownload={(remember) => void exportTranscript(remember)}
        exporting={exporting}
        loading={standardLoading || standardSaving}
        hasContent={exportHasSummaryContent}
        error={exportError}
        preferencesError={standardError}
        hasSavedPreferences={Boolean(savedStandard)}
        onApplyPreferences={() =>
          applySummaryExportPreferences(savedStandard ?? defaultSummaryStandard)
        }
      />

      <Workbench
        className="h-[max(32rem,calc(100dvh-17.5rem))] p-3"
        compactBelow={680}
        focusShortcut={false}
        inspectorWidth={400}
      >
        {hasInspectorContent ? (
          <Workbench.Bar>
            <Workbench.InspectorTrigger className="w-auto gap-1.5 px-3 text-sm font-medium">
              <PanelRight />
              {t("Recording")}
            </Workbench.InspectorTrigger>
          </Workbench.Bar>
        ) : null}
        <Workbench.Canvas className="p-0!">
          <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
            <Card
              className={cn(
                "flex h-full min-h-[24rem] min-w-0 flex-col overflow-hidden shadow-none",
                workspaceView !== "review" && "hidden"
              )}
            >
              <CardHeader className="shrink-0 gap-3 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <FileText
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                      {t("Transcript")}
                    </CardTitle>
                    {transcriptQuery ? (
                      <CardDescription>
                        {t("{value0} matches", {
                          value0: filteredTranscript.length,
                        })}
                      </CardDescription>
                    ) : null}
                    {mediaPlaying && !hasActiveFilter ? (
                      <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-primary">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse motion-reduce:animate-none"
                        />
                        {t("Following playback")}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      disabled={!snapshot.segments.length}
                      onClick={() => {
                        setEditorOpen((current) => !current)
                        setTranscriptMode(
                          editorOpen && !editedAvailable ? "verbatim" : "edited"
                        )
                      }}
                      size="sm"
                      variant={editorOpen ? "default" : "outline"}
                    >
                      {editorOpen ? (
                        <Check data-icon="inline-start" />
                      ) : (
                        <Pencil data-icon="inline-start" />
                      )}
                      {editorOpen ? t("Done editing") : t("Edit")}
                    </Button>
                    <Menu>
                      <Menu.Trigger
                        render={
                          <Button
                            aria-label={t("Transcript tools")}
                            size="icon-sm"
                            variant="ghost"
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Menu.Trigger>
                      <Menu.Content align="end" className="w-52">
                        <Menu.Group>
                          <Menu.GroupLabel>{t("Text version")}</Menu.GroupLabel>
                          <Menu.RadioGroup
                            value={transcriptMode}
                            onValueChange={(value) => {
                              if (
                                value === "verbatim" ||
                                value === "polished" ||
                                value === "edited"
                              )
                                setTranscriptMode(value)
                            }}
                          >
                            <Menu.RadioItem
                              value="verbatim"
                              disabled={editorOpen}
                            >
                              {t("As spoken")}
                            </Menu.RadioItem>
                            <Menu.RadioItem
                              value="polished"
                              disabled={editorOpen || !polishedAvailable}
                            >
                              {t("Cleaned up")}
                            </Menu.RadioItem>
                            <Menu.RadioItem
                              value="edited"
                              disabled={editorOpen || !editedAvailable}
                            >
                              {t("My edits")}
                            </Menu.RadioItem>
                          </Menu.RadioGroup>
                          <Menu.Item
                            onClick={() =>
                              setFiltersOpen((current) => !current)
                            }
                          >
                            <CircleAlert data-icon="inline-start" />{" "}
                            {filtersOpen
                              ? t("Hide filters")
                              : t("Show filters")}
                          </Menu.Item>
                          {canPolishTranscript ? (
                            <Menu.Item
                              disabled={polishProcessing}
                              onClick={() => void polishTranscript()}
                            >
                              <Sparkles data-icon="inline-start" />
                              {polishProcessing
                                ? t("Polishing…")
                                : polishedAvailable
                                  ? t("Re-polish transcript")
                                  : t("Polish transcript")}
                            </Menu.Item>
                          ) : null}
                        </Menu.Group>
                      </Menu.Content>
                    </Menu>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative max-w-md min-w-48 flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label={t("Search transcript")}
                      className="h-9 pl-9"
                      onChange={(event) =>
                        setTranscriptQuery(event.target.value)
                      }
                      placeholder={t("Search transcript")}
                      value={transcriptQuery}
                    />
                  </div>
                  {filtersOpen ? (
                    <>
                      <Select
                        items={[
                          { value: "all", label: "All speakers" },
                          ...snapshot.speakers.map((speaker) => ({
                            value: speaker.id,
                            label: speakerName(speaker),
                          })),
                        ]}
                        onValueChange={(value) =>
                          setSpeakerFilter(value ?? "all")
                        }
                        value={speakerFilter}
                      >
                        <SelectTrigger
                          aria-label={t("Filter by speaker")}
                          className="h-9 w-40 text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">
                            {t("All speakers")}
                          </SelectItem>
                          {snapshot.speakers.map((speaker) => (
                            <SelectItem key={speaker.id} value={speaker.id}>
                              {speakerName(speaker)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        className="h-9"
                        onClick={() => setQualityOnly((current) => !current)}
                        size="sm"
                        variant={qualityOnly ? "default" : "outline"}
                      >
                        <CircleAlert data-icon="inline-start" />{" "}
                        {t("Review flags")}
                      </Button>
                    </>
                  ) : hasActiveFilter ? (
                    <Badge className="h-7" variant="outline">
                      {t("Filters active")}
                    </Badge>
                  ) : null}
                  {filteredTranscript.length > 0 &&
                  !editorOpen &&
                  hasActiveFilter ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Button
                        aria-label={t("Previous search match")}
                        disabled={filteredTranscript.length < 2}
                        onClick={() =>
                          setMatchIndex(
                            (current) =>
                              (current - 1 + filteredTranscript.length) %
                              filteredTranscript.length
                          )
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ChevronLeft />
                      </Button>
                      <span className="min-w-16 text-center tabular-nums">
                        {activeMatchIndex + 1} / {filteredTranscript.length}
                      </span>
                      <Button
                        aria-label={t("Next search match")}
                        disabled={filteredTranscript.length < 2}
                        onClick={() =>
                          setMatchIndex(
                            (current) =>
                              (current + 1) % filteredTranscript.length
                          )
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ChevronRight />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {editorOpen && selectedSegmentIds.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2 text-xs">
                    <span className="text-muted-foreground">
                      {selectedSegmentIds.length} {t("lines selected")}
                    </span>
                    <Select
                      items={snapshot.speakers.map((speaker) => ({
                        value: speaker.id,
                        label: speakerName(speaker),
                      }))}
                      onValueChange={(value) =>
                        setAssignmentSpeakerId(value ?? "")
                      }
                      value={assignmentSpeakerId}
                    >
                      <SelectTrigger className="h-8 w-40 text-xs">
                        <SelectValue placeholder={t("Assign speaker")} />
                      </SelectTrigger>
                      <SelectContent>
                        {snapshot.speakers.map((speaker) => (
                          <SelectItem key={speaker.id} value={speaker.id}>
                            {speakerName(speaker)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      disabled={!assignmentSpeakerId}
                      onClick={() => void assignSelectedSpeaker()}
                      size="sm"
                    >
                      <Users data-icon="inline-start" /> {t("Assign speaker")}
                    </Button>
                    <Button
                      onClick={() => setSelectedSegmentIds([])}
                      size="sm"
                      variant="ghost"
                    >
                      {t("Clear")}
                    </Button>
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,#000_calc(100%-2rem),transparent)] px-3 pt-3 pb-8 sm:px-4">
                {editorOpen ? (
                  editParagraphs.length > 0 ? (
                    <div className="flex flex-col gap-4">
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "Edit the text below. Your recording stays unchanged."
                        )}
                      </p>
                      {editParagraphs.map((message) => {
                        const segments = message.segmentIds
                          .map((id) =>
                            snapshot.segments.find(
                              (segment) => segment.id === id
                            )
                          )
                          .filter((segment): segment is TranscriptionSegment =>
                            Boolean(segment)
                          )
                        const draft =
                          paragraphDrafts[message.id] ?? message.text
                        const selectedCount = segments.filter((segment) =>
                          selectedSegmentIds.includes(segment.id)
                        ).length
                        return (
                          <div
                            className="rounded-xl bg-muted/30 p-3 sm:p-4"
                            key={message.id}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                aria-label={t("Select paragraph at {value0}", {
                                  value0: formatVideoTimestamp(
                                    message.startOffsetMs
                                  ),
                                })}
                                checked={
                                  segments.length > 0 &&
                                  selectedCount === segments.length
                                }
                                className="size-4 accent-primary"
                                onChange={(event) =>
                                  setSelectedSegmentIds((current) =>
                                    event.target.checked
                                      ? [
                                          ...new Set([
                                            ...current,
                                            ...message.segmentIds,
                                          ]),
                                        ]
                                      : current.filter(
                                          (id) =>
                                            !message.segmentIds.includes(id)
                                        )
                                  )
                                }
                                type="checkbox"
                              />
                              <button
                                className="font-mono text-xs text-primary hover:underline"
                                disabled={!canSeek}
                                onClick={() => seekTo(message.startOffsetMs)}
                                type="button"
                              >
                                {formatVideoTimestamp(message.startOffsetMs)}
                              </button>
                              <span className="text-xs text-muted-foreground">
                                {speakerName(
                                  speakerById.get(message.speakerKey)
                                )}
                              </span>
                              <Button
                                className="ml-auto"
                                disabled={
                                  savingSegmentId === message.id ||
                                  draft.trim() === message.text.trim()
                                }
                                onClick={() => void saveParagraphEdit(message)}
                                size="sm"
                                variant="outline"
                              >
                                {savingSegmentId === message.id ? (
                                  <Spinner data-icon="inline-start" />
                                ) : (
                                  <Check data-icon="inline-start" />
                                )}
                                {t("Save paragraph")}
                              </Button>
                            </div>
                            <Textarea
                              aria-label={t("Edit paragraph at {value0}", {
                                value0: formatVideoTimestamp(
                                  message.startOffsetMs
                                ),
                              })}
                              className="mt-3 min-h-32 resize-y bg-background text-sm leading-6"
                              onChange={(event) =>
                                setParagraphDrafts((current) => ({
                                  ...current,
                                  [message.id]: event.target.value,
                                }))
                              }
                              value={draft}
                            />
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <Empty className="min-h-48 border-0 p-4">
                      <EmptyHeader>
                        <EmptyTitle>{t("No lines need review")}</EmptyTitle>
                        <EmptyDescription>
                          {t("Try clearing a filter or turn off Review flags.")}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )
                ) : filteredTranscript.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {filteredTranscript.map((message) => {
                      const active = message.id === activeMessageId
                      const speaker = speakerById.get(message.speakerKey)
                      const issues = message.segmentIds
                        .flatMap((id) =>
                          qualityIssues(
                            displaySegmentById.get(id) ??
                              ({ text: "" } as TranscriptionSegment)
                          )
                        )
                        .filter(
                          (issue, index, list) => list.indexOf(issue) === index
                        )
                      const firstSegment = displaySegmentById.get(
                        message.segmentIds[0]
                      )
                      const messageSegments = message.segmentIds
                        .map((segmentId) => displaySegmentById.get(segmentId))
                        .filter((segment): segment is TranscriptionSegment =>
                          Boolean(segment)
                        )
                      return (
                        <div
                          className={cn(
                            "group grid w-full grid-cols-1 gap-1 rounded-lg px-2.5 py-3 text-left transition-colors sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3",
                            active
                              ? "bg-primary/10 ring-1 ring-primary/30"
                              : "hover:bg-muted/50"
                          )}
                          key={message.id}
                          ref={(element) => {
                            if (element)
                              messageRefs.current.set(message.id, element)
                            else messageRefs.current.delete(message.id)
                          }}
                        >
                          <button
                            aria-current={active ? "true" : undefined}
                            aria-label={t("Jump to {value0}", {
                              value0: formatVideoTimestamp(
                                message.startOffsetMs
                              ),
                            })}
                            disabled={!canSeek}
                            className={cn(
                              "flex h-fit items-start gap-1 rounded-sm pt-0.5 text-left font-mono text-[11px] tabular-nums",
                              active ? "text-primary" : "text-muted-foreground"
                            )}
                            onClick={() => seekTo(message.startOffsetMs)}
                            type="button"
                          >
                            {active ? (
                              <Play
                                aria-hidden="true"
                                className="mt-0.5 size-3 fill-current"
                              />
                            ) : null}
                            {formatVideoTimestamp(message.startOffsetMs)}
                          </button>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {speaker ? (
                                <Button
                                  aria-label={t("Rename {value0}", {
                                    value0: speakerName(speaker),
                                  })}
                                  className="group/speaker-name h-auto max-w-full justify-start p-0 hover:bg-transparent"
                                  onClick={() => onRenameSpeaker(speaker)}
                                  size="sm"
                                  title={t("Rename speaker")}
                                  variant="ghost"
                                >
                                  <Badge
                                    className="max-w-full truncate"
                                    variant="outline"
                                  >
                                    {speakerName(speaker)}
                                  </Badge>
                                  <Pencil
                                    aria-hidden="true"
                                    className="text-muted-foreground transition-colors group-hover/speaker-name:text-foreground"
                                    data-icon="inline-end"
                                  />
                                </Button>
                              ) : null}
                              {filtersOpen || qualityOnly
                                ? issues.map((issue) => (
                                    <Badge
                                      className="text-[10px]"
                                      key={issue}
                                      variant="destructive"
                                    >
                                      {issue}
                                    </Badge>
                                  ))
                                : null}
                              <div className="ml-auto flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                                <Button
                                  aria-label={t("Add bookmark")}
                                  onClick={() => {
                                    setAnnotationKind("bookmark")
                                    setAnnotationNote("")
                                    setAnnotationTarget({
                                      segmentId:
                                        firstSegment?.id ??
                                        message.segmentIds[0],
                                      startOffsetMs: message.startOffsetMs,
                                      endOffsetMs: message.endOffsetMs,
                                    })
                                  }}
                                  size="icon-sm"
                                  title={t("Add bookmark")}
                                  variant="ghost"
                                >
                                  <Bookmark />
                                </Button>
                                <Button
                                  aria-label={t("Add comment")}
                                  onClick={() => {
                                    setAnnotationKind("comment")
                                    setAnnotationNote("")
                                    setAnnotationTarget({
                                      segmentId:
                                        firstSegment?.id ??
                                        message.segmentIds[0],
                                      startOffsetMs: message.startOffsetMs,
                                      endOffsetMs: message.endOffsetMs,
                                    })
                                  }}
                                  size="icon-sm"
                                  title={t("Add comment")}
                                  variant="ghost"
                                >
                                  <MessageSquarePlus />
                                </Button>
                              </div>
                            </div>
                            <button
                              className="block min-w-0 text-left text-sm leading-6 text-foreground"
                              disabled={!canSeek}
                              onClick={() => seekTo(message.startOffsetMs)}
                              type="button"
                            >
                              {highlightActiveTranscriptSegment(
                                message.text,
                                messageSegments,
                                activeMessageId === message.id
                                  ? activeSegmentId
                                  : null,
                                transcriptQuery
                              )}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : transcript.length > 0 && transcriptQuery ? (
                  <Empty className="min-h-48 border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>{t("No matching lines")}</EmptyTitle>
                      <EmptyDescription>
                        {t("Try another word or clear the transcript search.")}
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button
                      onClick={() => setTranscriptQuery("")}
                      size="sm"
                      variant="outline"
                    >
                      {t("Clear search")}
                    </Button>
                  </Empty>
                ) : preview.length > 0 ? (
                  <LiveTranscriptPreview segments={preview} />
                ) : isVideoProcessing ? (
                  <Empty className="min-h-48 border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>
                        {t("Your transcript is on its way")}
                      </EmptyTitle>
                      <EmptyDescription>
                        {t(
                          "Text appears here as the recording is transcribed."
                        )}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <Empty className="min-h-48 border-0 p-4">
                    <EmptyHeader>
                      <EmptyTitle>{t("No transcript yet")}</EmptyTitle>
                      <EmptyDescription>
                        {t(
                          "The transcript will appear here after video processing starts."
                        )}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </CardContent>
            </Card>
            <Card
              className={cn(
                "min-w-0 gap-0 py-0 shadow-none",
                workspaceView !== "insights" && "hidden"
              )}
            >
              <TranscriptionSummaryReadingView
                insights={insights}
                processing={insightsProcessing}
                chapters={validInsightChapters}
                hiddenChapterCount={hiddenInsightChapterCount}
                canSeek={canSeek}
                onSeek={(offsetMs) => {
                  setSummaryRecordingOpen(true)
                  seekTo(offsetMs)
                }}
                onCreate={() => setSummarySetupOpen(true)}
                createDisabled={
                  standardLoading ||
                  insightsProcessing ||
                  !snapshot.segments.length
                }
                onCopyActions={() => void copyActionItems()}
                actionsCopied={actionItemsCopied}
                speakerNames={snapshot.speakers
                  .flatMap((speaker) => [speaker.displayName, speaker.label])
                  .filter((name): name is string => Boolean(name))}
                languageLabel={
                  summaryLanguage === "auto"
                    ? ""
                    : (insightLanguageOptions.find(
                        (option) => option.value === summaryLanguage
                      )?.label ?? summaryLanguage)
                }
                review={
                  <>
                    {(insights.customization?.excludedSegmentIds?.length ?? 0) >
                    0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("{value0} passages left out by you", {
                          value0:
                            insights.customization?.excludedSegmentIds
                              ?.length ?? 0,
                        })}
                      </p>
                    ) : null}
                    <SummaryOmissionReview
                      compact
                      omissions={
                        insights.customization?.automaticOmissions ?? []
                      }
                      restoredIds={restoredSummaryIds}
                      disabled={insightsProcessing}
                      onRestore={restoreSummaryPassages}
                    />
                  </>
                }
              />
            </Card>
            {speakerSummaries.length > 0 ? (
              <Card
                className={cn(
                  "shrink-0 shadow-none",
                  workspaceView !== "speakers" && "hidden"
                )}
              >
                <CardHeader className="gap-1 px-4 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Users className="size-4 text-primary" /> {t("Speakers")}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <Button
                        disabled={!snapshot.session.grammarEndpointId}
                        onClick={() => setIdentifyOpen(true)}
                        size="icon-sm"
                        title={
                          snapshot.session.grammarEndpointId
                            ? t("Identify speaker names with AI")
                            : t(
                                "Configure a grammar/chat endpoint to identify speakers"
                              )
                        }
                        variant="outline"
                      >
                        <Sparkles />
                      </Button>
                      <Button
                        onClick={() => {
                          setMergeSourceId("")
                          setMergeTargetId("")
                          setMergeOpen(true)
                        }}
                        size="icon-sm"
                        title={t("Merge speakers")}
                        variant="outline"
                      >
                        <GitMerge />
                      </Button>
                    </div>
                  </div>
                  <CardDescription>
                    {t("{value0} voices in this recording", {
                      value0: speakerSummaries.length,
                    })}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 px-4 pb-4">
                  {mediaKind === "video" ? (
                    <SpeakerVideoCaptions
                      key={snapshot.session.id}
                      sessionId={snapshot.session.id}
                      available={
                        snapshot.videoUpload?.status === "completed" &&
                        !!snapshot.videoUpload?.playbackUrl
                      }
                      speakers={snapshot.speakers}
                      onSpeakersChange={(speakers) =>
                        updateSnapshot((current) => ({ ...current, speakers }))
                      }
                      onSeek={(offsetMs) => seekTo(offsetMs, false)}
                      onRunChange={setCaptionRun}
                      selectedImage={selectedCaptionImage}
                      onSelectImage={setSelectedCaptionImage}
                      onResolveSuggestion={resolveSpeakerSuggestion}
                    />
                  ) : null}
                  <div className="space-y-2">
                    {speakerSummaries.map((summary) => {
                      const name = speakerName(summary.speaker)
                      const playing =
                        speakerSample?.speakerId === summary.speaker.id
                      const canPlay =
                        canSeek &&
                        summary.sampleStartMs !== null &&
                        summary.sampleEndMs !== null
                      return (
                        <div
                          className="rounded-xl bg-muted/30 p-3"
                          key={summary.speaker.id}
                        >
                          <div className="flex min-w-0 items-start gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                              {speakerInitials(name)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                                  {name}
                                </span>

                                {summary.speaker.nameSource === "ai" ? (
                                  <Badge
                                    className="shrink-0 text-[9px]"
                                    title={
                                      summary.speaker.suggestionEvidence ||
                                      "Named by AI"
                                    }
                                    variant="secondary"
                                  >
                                    <Sparkles className="size-2.5" />{" "}
                                    {t("Suggested")}
                                  </Badge>
                                ) : null}
                              </div>
                              {summary.speaker.suggestedName ? (
                                <div className="mt-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
                                  <div className="min-w-0 flex-1 text-[11px]">
                                    <p className="truncate font-medium">
                                      {t("Maybe")}{" "}
                                      {summary.speaker.suggestedName}{" "}
                                    </p>
                                    {summary.speaker.suggestionEvidence ? (
                                      <p className="line-clamp-2 text-muted-foreground">
                                        {summary.speaker.suggestionEvidence}
                                      </p>
                                    ) : null}
                                    {mediaKind === "video" && captionRun ? (
                                      <div className="mt-2 flex flex-wrap gap-1">
                                        {captionRun.results
                                          .filter(
                                            (result) =>
                                              result.speakerId ===
                                                summary.speaker.id &&
                                              result.name ===
                                                summary.speaker.suggestedName
                                          )
                                          .flatMap(
                                            (result) => result.frameIndices
                                          )
                                          .filter(
                                            (index, position, indices) =>
                                              indices.indexOf(index) ===
                                              position
                                          )
                                          .map((index) => {
                                            const frame =
                                              captionRun.frames[index]
                                            if (!frame) return null
                                            return (
                                              <Button
                                                key={index}
                                                size="sm"
                                                variant="secondary"
                                                aria-label={t(
                                                  "Video caption at {value0}: {value1}",
                                                  {
                                                    value0: formatVideoDuration(
                                                      frame.offsetMs
                                                    ),
                                                    value1:
                                                      summary.speaker
                                                        .suggestedName ?? "",
                                                  }
                                                )}
                                                onClick={() =>
                                                  setSelectedCaptionImage({
                                                    runId: captionRun.id,
                                                    index,
                                                  })
                                                }
                                              >
                                                <ImageIcon data-icon="inline-start" />
                                                {formatVideoDuration(
                                                  frame.offsetMs
                                                )}
                                              </Button>
                                            )
                                          })}
                                      </div>
                                    ) : null}
                                  </div>
                                  <Button
                                    aria-label={t("Accept name {value0}", {
                                      value0: summary.speaker.suggestedName,
                                    })}
                                    onClick={() =>
                                      void resolveSpeakerSuggestion(
                                        summary.speaker,
                                        true
                                      )
                                    }
                                    size="icon-sm"
                                    variant="default"
                                  >
                                    <Check />
                                  </Button>
                                  <Button
                                    aria-label={t("Dismiss suggestion")}
                                    onClick={() =>
                                      void resolveSpeakerSuggestion(
                                        summary.speaker,
                                        false
                                      )
                                    }
                                    size="icon-sm"
                                    variant="ghost"
                                  >
                                    <Trash2 />
                                  </Button>
                                </div>
                              ) : null}
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {t("{value0} speaking time", {
                                  value0: formatVideoDuration(
                                    summary.speakingMs
                                  ),
                                })}
                              </p>
                              {summary.sampleText ? (
                                <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                                  “{summary.sampleText}”
                                </p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                aria-label={
                                  playing
                                    ? t("Stop sample for {value0}", {
                                        value0: name,
                                      })
                                    : t("Play sample for {value0}", {
                                        value0: name,
                                      })
                                }
                                disabled={!canPlay}
                                onClick={() => playSpeakerSample(summary)}
                                size="icon-sm"
                                variant={playing ? "default" : "outline"}
                              >
                                {playing ? <Pause /> : <Play />}
                              </Button>
                              <Button
                                aria-label={t("Rename {value0}", {
                                  value0: name,
                                })}
                                onClick={() => onRenameSpeaker(summary.speaker)}
                                size="icon-sm"
                                variant="ghost"
                              >
                                <Pencil />
                              </Button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            ) : workspaceView === "speakers" ? (
              <Card className="shrink-0 shadow-none">
                <CardHeader className="gap-1 px-4 py-4">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Users className="size-4 text-primary" /> {t("Speakers")}
                  </CardTitle>
                  <CardDescription>
                    {t("There are no speaker names yet.")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-4 pb-4 text-xs text-muted-foreground">
                  {t(
                    "You can still read, edit, and download the conversation."
                  )}
                </CardContent>
              </Card>
            ) : null}
            <Card
              className={cn(
                "shrink-0 shadow-none",
                workspaceView !== "details" && "hidden"
              )}
            >
              <CardHeader className="gap-1 px-4 py-4">
                <CardTitle className="text-sm">{t("At a glance")}</CardTitle>
                <CardDescription>
                  {t("Transcript settings and coverage")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 px-4 pb-4 text-xs text-muted-foreground">
                {snapshot.videoUpload?.fileName ? (
                  <div className="flex items-center justify-between gap-3">
                    <span>{t("File")}</span>
                    <span
                      className="max-w-48 truncate font-medium text-foreground"
                      title={snapshot.videoUpload.fileName}
                    >
                      {snapshot.videoUpload.fileName}
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-3">
                  <span>{t("Language")}</span>
                  <span className="font-medium text-foreground">
                    {snapshot.session.language}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t("Messages")}</span>
                  <span className="font-medium text-foreground">
                    {transcript.length}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <Users className="size-3.5" /> {t("Speakers")}
                  </span>
                  <span className="font-medium text-foreground">
                    {snapshot.speakers.length || "Not separated"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t("Grammar")}</span>
                  <span className="font-medium text-foreground">
                    {snapshot.session.polishStatus === "completed"
                      ? t("Available")
                      : snapshot.session.polishStatus === "failed"
                        ? t("Failed")
                        : snapshot.session.polishStatus === "processing"
                          ? t("Processing")
                          : t("Not requested")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <Clock3 className="size-3.5" /> {t("Duration")}
                  </span>
                  <span className="font-medium text-foreground tabular-nums">
                    {displayDurationMs
                      ? formatVideoDuration(displayDurationMs)
                      : "—"}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </Workbench.Canvas>
        {hasInspectorContent ? (
          <Workbench.Inspector
            className="-m-1.5 p-1.5 ps-5"
            title={t("Recording")}
          >
            <Inspector
              defaultValue={mediaKind !== "none" ? "recording" : "notes"}
            >
              <Inspector.Rail>
                {mediaKind !== "none" ? (
                  <Inspector.Tab label={t("Recording")} value="recording">
                    <FileVideo />
                  </Inspector.Tab>
                ) : null}
                <Inspector.Tab label={t("Notes")} value="notes">
                  <Bookmark />
                </Inspector.Tab>
              </Inspector.Rail>
              <Inspector.Panel>
                {mediaKind !== "none" ? (
                  <Inspector.Page value="recording">
                    <Card className="border-0 bg-transparent shadow-none ring-0">
                      <CardHeader className="gap-2 px-4 py-4">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          {mediaKind === "video" ? (
                            <FileVideo className="size-4" />
                          ) : mediaKind === "audio" ? (
                            <FileAudio className="size-4" />
                          ) : (
                            <FileText className="size-4" />
                          )}{" "}
                          {mediaKind === "video"
                            ? t("Recording")
                            : mediaKind === "audio"
                              ? t("Recording")
                              : t("Transcript")}
                          {workspaceView === "insights" ? (
                            <Button
                              className="ml-auto"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("Hide recording")}
                              onClick={() => {
                                ;(mediaKind === "audio"
                                  ? audioRef.current
                                  : videoRef.current
                                )?.pause()
                                setSummaryRecordingOpen(false)
                              }}
                            >
                              <X />
                            </Button>
                          ) : null}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3 px-4 pb-4">
                        {mediaKind === "video" ? (
                          <>
                            <div className="overflow-hidden rounded-xl bg-muted">
                              {snapshot.videoUpload?.playbackUrl ? (
                                <video
                                  className="block aspect-video w-full bg-muted object-contain"
                                  controls
                                  onError={() => {
                                    setMediaPlaying(false)
                                    setSpeakerSample(null)
                                    onVideoPlaybackError(
                                      "The video link expired or the stored video is unavailable."
                                    )
                                  }}
                                  onLoadedMetadata={(event) => {
                                    if (
                                      Number.isFinite(
                                        event.currentTarget.duration
                                      )
                                    )
                                      onVideoDurationChange(
                                        Math.round(
                                          event.currentTarget.duration * 1000
                                        )
                                      )
                                  }}
                                  onEnded={() => {
                                    setMediaPlaying(false)
                                    setSpeakerSample(null)
                                  }}
                                  onPause={() => setMediaPlaying(false)}
                                  onPlay={() => setMediaPlaying(true)}
                                  onTimeUpdate={(event) => {
                                    const current = Math.round(
                                      event.currentTarget.currentTime * 1000
                                    )
                                    onCurrentTimeChange(current)
                                    if (
                                      speakerSample &&
                                      current >= speakerSample.endOffsetMs
                                    ) {
                                      event.currentTarget.pause()
                                      setSpeakerSample(null)
                                    }
                                  }}
                                  playsInline
                                  preload="metadata"
                                  ref={videoRef}
                                  src={snapshot.videoUpload.playbackUrl}
                                />
                              ) : (
                                <div className="flex aspect-video flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                                  <FileVideo aria-hidden="true" />
                                  <p className="text-xs">
                                    {t(
                                      "The video will be available here once the upload has finished."
                                    )}
                                  </p>
                                </div>
                              )}
                            </div>

                            {videoPlaybackError ? (
                              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                                <p className="font-medium">
                                  {t("Playback unavailable")}
                                </p>
                                <p className="mt-1">{t(videoPlaybackError)}</p>
                                <Button
                                  className="mt-2"
                                  onClick={() => void onRefreshPlayback()}
                                  size="sm"
                                  variant="outline"
                                >
                                  <RefreshCw data-icon="inline-start" />{" "}
                                  {t("Refresh link")}
                                </Button>
                              </div>
                            ) : null}
                          </>
                        ) : mediaKind === "audio" ? (
                          <>
                            {recordings.length > 1 ? (
                              <Select
                                items={recordings.map((recording, index) => ({
                                  value: recording.id,
                                  label: t("Recording {value0}", {
                                    value0: index + 1,
                                  }),
                                }))}
                                onValueChange={(value) =>
                                  setSelectedRecordingId(value ?? "")
                                }
                                value={selectedRecordingId}
                              >
                                <SelectTrigger
                                  aria-label={t("Select source recording")}
                                >
                                  <SelectValue
                                    placeholder={t("Select recording")}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {recordings.map((recording, index) => (
                                    <SelectItem
                                      key={recording.id}
                                      value={recording.id}
                                    >
                                      {t("Recording {value0}", {
                                        value0: index + 1,
                                      })}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : null}
                            <div className="rounded-xl bg-muted/40 p-3">
                              {audioSourceURL ? (
                                <audio
                                  className="w-full"
                                  controls
                                  onEnded={() => {
                                    setMediaPlaying(false)
                                    setSpeakerSample(null)
                                  }}
                                  onError={() => {
                                    setMediaPlaying(false)
                                    setSpeakerSample(null)
                                    setAudioSource((current) =>
                                      current?.recordingId ===
                                      effectiveRecordingId
                                        ? {
                                            ...current,
                                            url: "",
                                            error:
                                              "The source recording could not be decoded.",
                                          }
                                        : current
                                    )
                                  }}
                                  onLoadedMetadata={(event) => {
                                    if (
                                      Number.isFinite(
                                        event.currentTarget.duration
                                      )
                                    )
                                      setAudioDurationMs(
                                        Math.round(
                                          event.currentTarget.duration * 1000
                                        )
                                      )
                                  }}
                                  onPause={() => setMediaPlaying(false)}
                                  onPlay={() => setMediaPlaying(true)}
                                  onTimeUpdate={(event) => {
                                    const current = Math.round(
                                      event.currentTarget.currentTime * 1000
                                    )
                                    onCurrentTimeChange(current)
                                    if (
                                      speakerSample &&
                                      current >= speakerSample.endOffsetMs
                                    ) {
                                      event.currentTarget.pause()
                                      setSpeakerSample(null)
                                    }
                                  }}
                                  preload="metadata"
                                  ref={audioRef}
                                  src={audioSourceURL}
                                />
                              ) : (
                                <div className="flex min-h-20 items-center justify-center text-center text-xs text-muted-foreground">
                                  {audioPlaybackError ||
                                    (selectedRecording
                                      ? t("Loading the recording…")
                                      : t(
                                          "Record source audio to enable playback."
                                        ))}
                                </div>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="flex min-h-20 items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 text-xs text-muted-foreground">
                            <FileText
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                            <p>
                              {t(
                                "This session has no recording. The transcript remains fully editable and exportable."
                              )}
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </Inspector.Page>
                ) : null}
                <Inspector.Page value="notes">
                  <Card className="border-0 bg-transparent shadow-none ring-0">
                    <CardHeader className="gap-1 px-4 py-4">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Bookmark className="size-4 text-primary" />{" "}
                        {t("Notes")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex min-h-0 flex-1 flex-col px-4 pb-4">
                      {annotations.length > 0 ? (
                        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                          {annotations.map((annotation) => (
                            <div
                              className="rounded-lg bg-muted/40 p-2.5"
                              key={annotation.id}
                            >
                              <div className="flex items-start gap-2">
                                <button
                                  className="font-mono text-[11px] text-primary hover:underline"
                                  disabled={!canSeek}
                                  onClick={() =>
                                    seekTo(annotation.startOffsetMs)
                                  }
                                  type="button"
                                >
                                  {formatVideoTimestamp(
                                    annotation.startOffsetMs
                                  )}
                                </button>
                                <Badge variant="outline">
                                  {annotation.kind === "bookmark"
                                    ? t("Bookmark")
                                    : t("Comment")}
                                </Badge>
                                <Button
                                  className="ml-auto"
                                  aria-label={t("Delete note")}
                                  onClick={() =>
                                    void deleteAnnotation(annotation)
                                  }
                                  size="icon-sm"
                                  variant="ghost"
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                              {annotation.note ? (
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                  {annotation.note}
                                </p>
                              ) : null}
                              <Button
                                className="mt-2"
                                onClick={() =>
                                  void copyTimestampLink(
                                    annotation.startOffsetMs
                                  )
                                }
                                size="sm"
                                variant="ghost"
                              >
                                <Copy data-icon="inline-start" />{" "}
                                {t("Copy link to this moment")}
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {t(
                            "Bookmark a line or add a comment while reviewing."
                          )}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </Inspector.Page>
              </Inspector.Panel>
            </Inspector>
          </Workbench.Inspector>
        ) : null}
      </Workbench>

      <Dialog open={workflowDialogOpen} onOpenChange={setWorkflowDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t("Use transcript insights in a workflow")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Choose a saved workflow and review its inputs. The run receives this transcript, its summary, topics, chapters, and action items."
              )}
            </DialogDescription>
          </DialogHeader>
          {workflowLoading ? (
            <p className="text-sm text-muted-foreground">
              {t("Loading workflows…")}
            </p>
          ) : workflowChoices.length === 0 ? (
            workflowError ? null : (
              <p className="text-sm text-muted-foreground">
                {t("No saved workflows are available. Create one in")}{" "}
                <Link
                  className="text-primary underline"
                  href="/agents?tab=workflows"
                >
                  {t("Agent workflows")}
                </Link>
                .
              </p>
            )
          ) : (
            <div className="space-y-4">
              <Select
                items={workflowChoices.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onValueChange={(value) => {
                  const next = workflowChoices.find((item) => item.id === value)
                  setWorkflowId(value ?? "")
                  setWorkflowFields(
                    next
                      ? transcriptionWorkflowPrefill(next, workflowSource())
                      : {}
                  )
                  setWorkflowRunId("")
                  setWorkflowError("")
                }}
                value={workflowId}
              >
                <SelectTrigger aria-label={t("Workflow")} className="w-full">
                  <SelectValue placeholder={t("Choose a workflow")} />
                </SelectTrigger>
                <SelectContent>
                  {workflowChoices.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedWorkflow?.description ? (
                <p className="text-xs text-muted-foreground">
                  {selectedWorkflow.description}
                </p>
              ) : null}
              {workflowInputFields.map((name) => (
                <label className="block space-y-1.5" key={name}>
                  <span className="text-xs font-medium">{name}</span>
                  <Textarea
                    onChange={(event) =>
                      setWorkflowFields((current) => ({
                        ...current,
                        [name]: event.target.value,
                      }))
                    }
                    rows={name.toLowerCase().includes("transcript") ? 6 : 3}
                    value={workflowFields[name] ?? ""}
                  />
                </label>
              ))}
              {workflowInputFields.length === 0 ? (
                <p className="rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                  {t(
                    "This workflow has no named input fields. It receives the structured transcript context directly."
                  )}
                </p>
              ) : null}
              {workflowTranscriptTruncated ? (
                <p className="text-xs text-amber-600 dark:text-amber-300">
                  {t("The transcript exceeds")}{" "}
                  {TRANSCRIPTION_WORKFLOW_TRANSCRIPT_LIMIT.toLocaleString(
                    locale
                  )}{" "}
                  {t(
                    "characters. The run includes the opening excerpt and all generated insights."
                  )}
                </p>
              ) : null}
              {selectedWorkflow?.visibility === "workspace" ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Workspace members can inspect this workflow run and its input."
                  )}
                </p>
              ) : null}
            </div>
          )}
          {workflowError ? (
            <p className="text-sm text-destructive" role="alert">
              {t(workflowError)}
            </p>
          ) : null}
          {workflowRunId ? (
            <p className="text-sm" role="status">
              {t("Workflow started.")}{" "}
              <Link
                className="text-primary underline"
                href={
                  "/agents?tab=runs&run=" + encodeURIComponent(workflowRunId)
                }
              >
                {t("Open run")}
              </Link>
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setWorkflowDialogOpen(false)}
              variant="outline"
            >
              {workflowRunId ? t("Done") : t("Cancel")}
            </Button>
            {!workflowRunId && workflowChoices.length > 0 ? (
              <Button
                disabled={!workflowId || workflowLoading || workflowRunning}
                onClick={() => void runInsightWorkflow()}
              >
                {workflowRunning ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <GitBranch data-icon="inline-start" />
                )}{" "}
                {t("Start workflow")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(annotationTarget)}
        onOpenChange={(open) => {
          if (!open && !annotationSaving) setAnnotationTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {annotationKind === "bookmark"
                ? t("Add bookmark")
                : t("Add comment")}
            </DialogTitle>
            <DialogDescription>
              {t("This note stays linked to")}{" "}
              {annotationTarget
                ? formatVideoTimestamp(annotationTarget.startOffsetMs)
                : t("the selected moment")}{" "}
              {t("in the")} {mediaKind === "video" ? "video" : "transcript"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select
              items={[
                { value: "comment", label: "Comment" },
                { value: "bookmark", label: "Bookmark" },
              ]}
              onValueChange={(value) =>
                setAnnotationKind(
                  (value as "bookmark" | "comment") ?? "comment"
                )
              }
              value={annotationKind}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comment">{t("Comment")}</SelectItem>
                <SelectItem value="bookmark">{t("Bookmark")}</SelectItem>
              </SelectContent>
            </Select>
            <Textarea
              autoFocus={annotationKind === "comment"}
              onChange={(event) => setAnnotationNote(event.target.value)}
              placeholder={
                annotationKind === "bookmark"
                  ? t("Optional note")
                  : t("What should be reviewed here?")
              }
              value={annotationNote}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={annotationSaving}
              onClick={() => setAnnotationTarget(null)}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                annotationSaving ||
                (annotationKind === "comment" && !annotationNote.trim())
              }
              onClick={() => void createAnnotation()}
            >
              {annotationSaving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Bookmark data-icon="inline-start" />
              )}{" "}
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={identifyOpen}
        onOpenChange={(open) => {
          if (!open && !identifyRunning) setIdentifyOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Identify speaker names")}</DialogTitle>
            <DialogDescription>
              {t(
                "The AI looks for introductions and direct address in the transcript. Confident names are applied, uncertain ones are shown as suggestions. Names you set yourself are never changed."
              )}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>{t("Participants (optional)")}</FieldLabel>
            <Textarea
              onChange={(event) => setIdentifyParticipants(event.target.value)}
              placeholder={"Anna Schmidt, Project lead\nBen Weber, Developer"}
              rows={5}
              value={identifyParticipants}
            />
            <p className="text-[11px] text-muted-foreground">
              {t(
                "One person per line, optionally followed by a comma and a role. Without a list only names spoken in the transcript are used."
              )}
            </p>
          </Field>
          <DialogFooter>
            <Button
              disabled={identifyRunning}
              onClick={() => setIdentifyOpen(false)}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={identifyRunning}
              onClick={() => void identifySpeakers()}
            >
              {identifyRunning ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}{" "}
              {t("Identify")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mergeOpen}
        onOpenChange={(open) => {
          if (!open && !mergeSaving) setMergeOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Merge speakers")}</DialogTitle>
            <DialogDescription>
              {t(
                "All lines assigned to the source speaker will be moved to the target. Their transcript text is unchanged."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium">
                {t("Merge this speaker")}
              </p>
              <Select
                items={snapshot.speakers
                  .filter((speaker) => speaker.id !== mergeTargetId)
                  .map((speaker) => ({
                    value: speaker.id,
                    label: speakerName(speaker),
                  }))}
                onValueChange={(value) => setMergeSourceId(value ?? "")}
                value={mergeSourceId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("Source")} />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.speakers
                    .filter((speaker) => speaker.id !== mergeTargetId)
                    .map((speaker) => (
                      <SelectItem key={speaker.id} value={speaker.id}>
                        {speakerName(speaker)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium">
                {t("Keep this speaker")}
              </p>
              <Select
                items={snapshot.speakers
                  .filter((speaker) => speaker.id !== mergeSourceId)
                  .map((speaker) => ({
                    value: speaker.id,
                    label: speakerName(speaker),
                  }))}
                onValueChange={(value) => setMergeTargetId(value ?? "")}
                value={mergeTargetId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("Target")} />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.speakers
                    .filter((speaker) => speaker.id !== mergeSourceId)
                    .map((speaker) => (
                      <SelectItem key={speaker.id} value={speaker.id}>
                        {speakerName(speaker)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={mergeSaving}
              onClick={() => setMergeOpen(false)}
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                mergeSaving ||
                !mergeSourceId ||
                !mergeTargetId ||
                mergeSourceId === mergeTargetId
              }
              onClick={() => void mergeSpeakers()}
            >
              {mergeSaving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <GitMerge data-icon="inline-start" />
              )}{" "}
              {t("Merge speakers")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function VideoTranscriptWorkspace(props: VideoTranscriptWorkspaceProps) {
  return <TranscriptWorkspace {...props} mediaKind="video" />
}

function LiveTranscriptPreview({
  segments,
}: {
  segments: TranscriptionVideoPreviewSegment[]
}) {
  const { t } = useTranslations()

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        {t("Text is appearing live. Small corrections may follow.")}
      </div>
      {segments.map((segment) => (
        <div
          className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg border border-border/70 px-2.5 py-3"
          key={`${segment.startOffsetMs}-${segment.endOffsetMs}-${segment.text}`}
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatVideoTimestamp(segment.startOffsetMs)}
          </span>
          <span className="text-sm leading-6">{segment.text}</span>
        </div>
      ))}
    </div>
  )
}
