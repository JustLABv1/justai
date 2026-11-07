"use client"

import { Spinner } from "@/components/panelui/spinner"
import { useState } from "react"
import { Download } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Alert } from "@/components/panelui/alert"
import { Checkbox } from "@/components/panelui/checkbox"
import { Chip } from "@/components/panelui/chip"
import { Dialog } from "@/components/panelui/dialog"
import { Frame } from "@/components/panelui/frame"
import { Switch } from "@/components/panelui/switch"
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
  const formatLabel =
    formats.find((item) => item.value === format)?.label ?? format.toUpperCase()
  const sectionRows = [
    ["summary", t("Summary overview"), t("The main text of the summary.")],
    ["chapters", t("Chapters"), t("Sections with their own short summary.")],
    ["topics", t("Topics"), t("The subjects that came up.")],
    ["actionItems", t("Action items"), t("Tasks and decisions to follow up.")],
  ] as const
  const anySection = sectionRows.some(([key]) => options[key])
  const message = error || preferencesError

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="sm:max-w-5xl">
        <Dialog.Header
          title={t(summaryOnly ? "Download summary" : "Download transcript")}
          description={t(
            "Keep what matters. Edit or leave out anything before downloading."
          )}
        />
        <Dialog.Body className="gap-3">
          {message ? (
            <Alert tone="destructive" variant="plain">
              <Alert.Description>{t(message)}</Alert.Description>
            </Alert>
          ) : null}
          {summaryOnly && !hasContent ? (
            <Alert tone="warning" variant="plain">
              <Alert.Description>
                {t("Keep at least one part to download.")}
              </Alert.Description>
            </Alert>
          ) : null}
          <div className="grid gap-4 md:h-[min(40rem,64dvh)] md:grid-cols-[17rem_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-4 md:overflow-y-auto md:pr-1 [&>*]:shrink-0">
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("File format")}
                </h3>
                <Chip.Group
                  aria-label={t("File format")}
                  multiple={false}
                  onValueChange={(value) => {
                    if (value[0]) onFormatChange(String(value[0]))
                  }}
                  value={[format]}
                >
                  {formats.map((item) => (
                    <Chip key={item.value} size="sm" value={item.value}>
                      {item.label}
                    </Chip>
                  ))}
                </Chip.Group>
              </section>

              {!summaryOnly && supportsSummary ? (
                <Frame>
                  <Frame.Panel>
                    <Frame.Row render={<label />}>
                      <Frame.Content>
                        <Frame.Title
                          as="p"
                          className="overflow-visible! text-clip! whitespace-normal!"
                        >
                          {t("Add summary to transcript")}
                        </Frame.Title>
                        {!summaryReady ? (
                          <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                            {t("There is no summary yet.")}
                          </Frame.Description>
                        ) : null}
                      </Frame.Content>
                      <Frame.Actions>
                        <Checkbox
                          checked={includeSummary}
                          disabled={!summaryReady}
                          label={t("Add summary to transcript")}
                          onCheckedChange={(checked) =>
                            onIncludeSummaryChange(Boolean(checked))
                          }
                        />
                      </Frame.Actions>
                    </Frame.Row>
                  </Frame.Panel>
                </Frame>
              ) : null}

              {showSummary ? (
                <Frame>
                  <Frame.Header>
                    <Frame.Title>{t("Include in document")}</Frame.Title>
                  </Frame.Header>
                  <Frame.Panel>
                    {sectionRows.map(([key, label, description]) => (
                      <Frame.Row key={key} render={<label />}>
                        <Frame.Content>
                          <Frame.Title
                            as="p"
                            className="overflow-visible! text-clip! whitespace-normal!"
                          >
                            {label}
                          </Frame.Title>
                          <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                            {description}
                          </Frame.Description>
                        </Frame.Content>
                        <Frame.Actions>
                          <Checkbox
                            checked={options[key]}
                            label={label}
                            onCheckedChange={(checked) =>
                              onOptionsChange({
                                ...options,
                                [key]: Boolean(checked),
                              })
                            }
                          />
                        </Frame.Actions>
                      </Frame.Row>
                    ))}
                  </Frame.Panel>
                </Frame>
              ) : null}

              <Frame>
                <Frame.Header>
                  <Frame.Title>{t("Appearance")}</Frame.Title>
                </Frame.Header>
                <Frame.Panel>
                  <Frame.Row render={<label />}>
                    <Frame.Content>
                      <Frame.Title
                        as="p"
                        className="overflow-visible! text-clip! whitespace-normal!"
                      >
                        {t("Highlight speaker names")}
                      </Frame.Title>
                      <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                        {t("Available in PDF, Word, and Markdown.")}
                      </Frame.Description>
                    </Frame.Content>
                    <Frame.Actions>
                      <Switch
                        aria-label={t("Highlight speaker names")}
                        checked={options.boldSpeakers}
                        disabled={!supportsFormatting}
                        onCheckedChange={(checked) =>
                          onOptionsChange({ ...options, boldSpeakers: checked })
                        }
                      />
                    </Frame.Actions>
                  </Frame.Row>
                  {showSummary ? (
                    <Frame.Row render={<label />}>
                      <Frame.Content>
                        <Frame.Title
                          as="p"
                          className="overflow-visible! text-clip! whitespace-normal!"
                        >
                          {t("Remember for next time")}
                        </Frame.Title>
                        <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                          {t("Your choices can be remembered for next time.")}
                        </Frame.Description>
                      </Frame.Content>
                      <Frame.Actions>
                        <Switch
                          aria-label={t("Remember for next time")}
                          checked={remember}
                          disabled={loading || exporting || !anySection}
                          onCheckedChange={setRemember}
                        />
                      </Frame.Actions>
                    </Frame.Row>
                  ) : null}
                </Frame.Panel>
              </Frame>
              {hasSavedPreferences ? (
                <Button
                  className="self-start"
                  onClick={onApplyPreferences}
                  size="sm"
                  variant="outline"
                >
                  {t("Use my saved choices")}
                </Button>
              ) : null}
            </div>

            <div className="flex min-h-0 min-w-0 flex-col gap-3 rounded-2xl bg-muted/40 p-3 md:overflow-y-auto">
              {summaryReady ? (
                <div hidden={!showSummary} className="flex flex-col gap-3">
                  <SummaryOmissionReview
                    omissions={omissions}
                    restoredIds={restoredIds}
                    onRestore={onRestorePassages}
                    disabled={exporting}
                  />
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
                  <Download
                    aria-hidden="true"
                    className="size-6 text-muted-foreground"
                  />
                  <p className="text-sm font-medium">
                    {t("Your transcript is ready to download.")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("The original text stays unchanged.")}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="secondary" />}>
            {t("Cancel")}
          </Dialog.Close>
          <Button
            disabled={loading || exporting || (summaryOnly && !hasContent)}
            onClick={() => onDownload(remember && showSummary)}
          >
            {exporting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Download data-icon="inline-start" />
            )}
            {exporting
              ? t("Preparing…")
              : t("Download as {value0}", { value0: formatLabel })}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
