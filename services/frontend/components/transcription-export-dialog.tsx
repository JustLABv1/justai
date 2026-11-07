"use client"

import { Spinner } from "@/components/panelui/spinner"
import { useState } from "react"
import { Check, Download } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Checkbox } from "@/components/panelui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/panelui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/panelui/tabs"
import { SummaryOmissionReview } from "@/components/transcription-summary-omissions"
import { TranscriptionSummaryExportEditor } from "@/components/transcription-summary-export-editor"
import type { TranscriptionInsights } from "@/lib/types"
import type {
  SummaryExportDraft,
  SummaryOmission,
  SummaryStandard,
} from "@/lib/transcription-summary-standard"

type ExportOptions = Pick<
  SummaryStandard,
  "summary" | "chapters" | "topics" | "actionItems" | "boldSpeakers"
>

export function TranscriptionExportDialog({
  open,
  onOpenChange,
  summaryOnly,
  title,
  speakerNames,
  insights,
  format,
  onFormatChange,
  options,
  onOptionsChange,
  includeSummary,
  onIncludeSummaryChange,
  omissions,
  restoredIds,
  onRestorePassages,
  onDraftChange,
  onSuggestRule,
  ruleProposing,
  onDownload,
  exporting,
  loading,
  hasContent,
  error,
  preferencesError,
  hasSavedPreferences,
  onApplyPreferences,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  summaryOnly: boolean
  title: string
  speakerNames: string[]
  insights: TranscriptionInsights
  format: string
  onFormatChange: (format: string) => void
  options: ExportOptions
  onOptionsChange: (options: ExportOptions) => void
  includeSummary: boolean
  onIncludeSummaryChange: (include: boolean) => void
  omissions: SummaryOmission[]
  restoredIds: string[]
  onRestorePassages: (ids: string[]) => void
  onDraftChange: (draft: SummaryExportDraft) => void
  onSuggestRule: (text: string) => void
  ruleProposing: boolean
  onDownload: (remember: boolean) => void
  exporting: boolean
  loading: boolean
  hasContent: boolean
  error: string
  preferencesError: string
  hasSavedPreferences: boolean
  onApplyPreferences: () => void
}) {
  const { t } = useTranslations()
  const [tab, setTab] = useState("content")
  const [remember, setRemember] = useState(false)
  const summaryReady = insights.status === "completed"
  const supportsSummary = ["pdf", "docx", "md", "txt"].includes(format)
  const showSummary =
    summaryReady && (summaryOnly || (supportsSummary && includeSummary))
  const supportsFormatting = ["pdf", "docx", "md"].includes(format)
  const formats = [
    { value: "pdf", label: "PDF" },
    { value: "docx", label: "Word" },
    { value: "md", label: "Markdown" },
    { value: "txt", label: t("Plain text") },
    ...(!summaryOnly
      ? [
          { value: "srt", label: t("Subtitles (.srt)") },
          { value: "vtt", label: "WebVTT" },
        ]
      : []),
    { value: "json", label: "JSON" },
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(50rem,90dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl sm:p-0">
        <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-4 sm:px-6 sm:pr-12">
          <DialogTitle>
            {t(summaryOnly ? "Download summary" : "Download transcript")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Keep what matters. Edit or leave out anything before downloading."
            )}
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(String(value))}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 pb-4 sm:px-6">
            <TabsList aria-label={t("Download options")}>
              <TabsTrigger value="content">{t("Content")}</TabsTrigger>
              <TabsTrigger value="appearance">{t("Appearance")}</TabsTrigger>
            </TabsList>
            <Select
              items={formats}
              value={format}
              onValueChange={(value) => onFormatChange(value ?? "pdf")}
            >
              <SelectTrigger
                aria-label={t("File format")}
                className="w-36"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {formats.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <TabsContent
            value="content"
            keepMounted
            className="min-h-0 overflow-y-auto bg-muted/40 px-5 py-4 sm:px-6"
          >
            {!summaryOnly && supportsSummary ? (
              <Field orientation="horizontal" className="mb-4">
                <Checkbox
                  id="download-include-summary"
                  checked={includeSummary}
                  disabled={!summaryReady}
                  onCheckedChange={(checked) =>
                    onIncludeSummaryChange(Boolean(checked))
                  }
                />
                <FieldLabel htmlFor="download-include-summary">
                  {t("Add summary to transcript")}
                </FieldLabel>
              </Field>
            ) : null}
            {summaryReady ? (
              <div hidden={!showSummary} className="flex flex-col gap-4">
                <SummaryOmissionReview
                  omissions={omissions}
                  restoredIds={restoredIds}
                  onRestore={onRestorePassages}
                  disabled={exporting}
                />
                <div
                  className="flex flex-wrap items-center gap-2"
                  aria-label={t("Include in document")}
                >
                  {(
                    [
                      ["summary", "Summary"],
                      ["chapters", "Chapters"],
                      ["topics", "Topics"],
                      ["actionItems", "Action items"],
                    ] as const
                  ).map(([key, label]) => (
                    <Button
                      key={key}
                      size="sm"
                      variant={options[key] ? "secondary" : "ghost"}
                      aria-pressed={options[key]}
                      onClick={() =>
                        onOptionsChange({ ...options, [key]: !options[key] })
                      }
                    >
                      {options[key] ? <Check data-icon="inline-start" /> : null}
                      {t(label)}
                    </Button>
                  ))}
                </div>
                <TranscriptionSummaryExportEditor
                  key={insights.updatedAt}
                  insights={insights}
                  sections={options}
                  boldSpeakers={options.boldSpeakers && supportsFormatting}
                  speakerNames={speakerNames}
                  title={title}
                  onChange={onDraftChange}
                  onSuggestRule={onSuggestRule}
                  ruleProposing={ruleProposing}
                />
              </div>
            ) : null}
            {!showSummary ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
                <Download className="size-6 text-muted-foreground" />
                <p className="text-sm">
                  {t("Your transcript is ready to download.")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("The original text stays unchanged.")}
                </p>
              </div>
            ) : null}
          </TabsContent>
          <TabsContent
            value="appearance"
            keepMounted
            className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6"
          >
            <FieldGroup>
              <div>
                <h3 className="text-sm font-medium">{t("Make it yours")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Your choices can be remembered for next time.")}
                </p>
              </div>
              <Field orientation="horizontal">
                <Switch
                  id="download-bold-speakers"
                  disabled={!supportsFormatting}
                  checked={options.boldSpeakers}
                  onCheckedChange={(checked) =>
                    onOptionsChange({ ...options, boldSpeakers: checked })
                  }
                />
                <FieldLabel htmlFor="download-bold-speakers">
                  {t("Highlight speaker names")}
                </FieldLabel>
              </Field>
              <p className="text-sm text-muted-foreground">
                {t("Available in PDF, Word, and Markdown.")}
              </p>
              {hasSavedPreferences ? (
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={onApplyPreferences}
                >
                  {t("Use my saved choices")}
                </Button>
              ) : null}
            </FieldGroup>
          </TabsContent>
        </Tabs>
        <div className="flex shrink-0 flex-col gap-3 px-5 py-4 sm:px-6">
          {error || preferencesError ? (
            <p role="alert" className="text-sm text-destructive">
              {t(error || preferencesError)}
            </p>
          ) : null}
          {summaryOnly && !hasContent ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("Keep at least one part to download.")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {showSummary ? (
              <Field orientation="horizontal" className="w-auto">
                <Checkbox
                  id="download-remember"
                  checked={remember}
                  disabled={
                    loading ||
                    exporting ||
                    !Object.values({
                      summary: options.summary,
                      chapters: options.chapters,
                      topics: options.topics,
                      actionItems: options.actionItems,
                    }).some(Boolean)
                  }
                  onCheckedChange={(checked) => setRemember(Boolean(checked))}
                />
                <FieldLabel htmlFor="download-remember">
                  {t("Remember for next time")}
                </FieldLabel>
              </Field>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("Cancel")}
              </Button>
              <Button
                disabled={loading || exporting || (summaryOnly && !hasContent)}
                onClick={() => onDownload(remember && showSummary)}
              >
                {exporting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Download data-icon="inline-start" />
                )}
                {t(exporting ? "Preparing…" : "Download")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
