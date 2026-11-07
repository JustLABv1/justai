"use client"

import { Spinner } from "@/components/panelui/spinner"
import type { ReactNode } from "react"
import { Check, Copy, FileText } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Badge } from "@/components/panelui/badge"
import type {
  TranscriptionInsights,
  TranscriptionInsightChapter,
} from "@/lib/types"
import { summaryParagraphs } from "@/lib/transcription-summary-standard"

export function TranscriptionSummaryReadingView({
  insights,
  processing,
  chapters,
  hiddenChapterCount,
  canSeek,
  onSeek,
  onCreate,
  createDisabled,
  onCopyActions,
  actionsCopied,
  speakerNames,
  languageLabel,
  review,
  actions,
}: {
  insights: TranscriptionInsights
  processing: boolean
  chapters: TranscriptionInsightChapter[]
  hiddenChapterCount: number
  canSeek: boolean
  onSeek: (offsetMs: number) => void
  onCreate: () => void
  createDisabled: boolean
  onCopyActions: () => void
  actionsCopied: boolean
  speakerNames: string[]
  languageLabel: string
  review: ReactNode
  /** Controls shown beside the title, such as a toolbar. */
  actions?: ReactNode
}) {
  const { t } = useTranslations()
  const paragraphs = summaryParagraphs(insights.summary ?? "")
  const hasContent =
    paragraphs.length > 0 ||
    chapters.length > 0 ||
    Boolean(insights.topics?.length || insights.actionItems?.length)
  const namedParagraph = (text: string) => {
    const generic = /^SPEAKER[_ -]?(\d+)\b/i.exec(text)
    if (generic)
      return (
        <>
          <strong>
            {t("Speaker {value0}", { value0: Number(generic[1]) })}
          </strong>
          {text.slice(generic[0].length)}
        </>
      )
    const name = [...speakerNames]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .find(
        (name) =>
          text === name ||
          [" ", ":", ","].some((separator) => text.startsWith(name + separator))
      )
    return name ? (
      <>
        <strong>{name}</strong>
        {text.slice(name.length)}
      </>
    ) : (
      text
    )
  }
  return (
    <article className="mx-auto w-full max-w-[76ch] px-2 pt-1 pb-6 text-base sm:px-3 sm:pt-1 sm:pb-8">
      {processing ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-6 flex items-start gap-3 rounded-xl bg-muted p-4"
        >
          <Spinner className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              {t("Your summary is taking shape…")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "We are reading the conversation and gathering the key points."
              )}
            </p>
          </div>
        </div>
      ) : null}
      {!processing && insights.error ? (
        <div
          role="alert"
          className="mb-6 flex flex-col gap-3 rounded-xl bg-muted p-4"
        >
          <p className="text-sm font-medium">
            {t("The summary could not be created.")}
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("Show details")}</summary>
            <p className="mt-2 whitespace-pre-wrap">{insights.error}</p>
          </details>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={createDisabled}
            onClick={onCreate}
          >
            {t("Try again")}
          </Button>
        </div>
      ) : null}
      {hasContent ? (
        <>
          <header className="mb-6 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight">
              {t(
                processing || insights.status === "failed"
                  ? "Previous summary"
                  : "Summary"
              )}
            </h2>
            {actions}
          </header>
          <div className="flex flex-col gap-6">
            {paragraphs.map((paragraph, index) => (
              <p
                key={index}
                className="text-sm leading-7 whitespace-pre-wrap text-foreground sm:text-base sm:leading-8"
              >
                {namedParagraph(paragraph)}
              </p>
            ))}
          </div>
          {(insights.actionItems?.length ?? 0) > 0 ? (
            <section
              className="mt-8 flex flex-col gap-3"
              aria-label={t("Action items")}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold">{t("Action items")}</h3>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("Copy action items")}
                  onClick={onCopyActions}
                >
                  {actionsCopied ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Copy data-icon="inline-start" />
                  )}
                  {t(actionsCopied ? "Copied" : "Copy")}
                </Button>
              </div>
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-7 sm:text-base">
                {insights.actionItems?.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {chapters.length > 0 || hiddenChapterCount > 0 ? (
            <details className="mt-8 rounded-xl bg-muted/50 p-4">
              <summary className="cursor-pointer text-sm font-medium">
                {t("Browse chapters")}{" "}
                <span className="ml-2 text-xs text-muted-foreground">
                  {chapters.length}
                </span>
              </summary>
              <div className="mt-3 flex flex-col gap-2">
                {chapters.map((chapter) => (
                  <Button
                    key={`${chapter.startOffsetMs}-${chapter.title}`}
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 py-3 text-left whitespace-normal"
                    disabled={!canSeek}
                    onClick={() => onSeek(chapter.startOffsetMs)}
                  >
                    <span className="self-start text-xs text-muted-foreground tabular-nums">
                      {Math.floor(chapter.startOffsetMs / 60000)}:
                      {String(
                        Math.floor(chapter.startOffsetMs / 1000) % 60
                      ).padStart(2, "0")}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span>{chapter.title}</span>
                      {chapter.summary ? (
                        <span className="text-sm leading-6 font-normal text-muted-foreground">
                          {chapter.summary}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                ))}
                {hiddenChapterCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Some chapter times are unavailable.")}
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
          {(insights.topics?.length ?? 0) > 0 ? (
            <details className="mt-3 rounded-xl bg-muted/50 p-4">
              <summary className="cursor-pointer text-sm font-medium">
                {t("Topics at a glance")}
              </summary>
              <div className="mt-3 flex flex-wrap gap-2">
                {insights.topics?.map((topic) => (
                  <Badge key={topic} variant="secondary">
                    {topic}
                  </Badge>
                ))}
              </div>
            </details>
          ) : null}
          {insights.status === "completed" ? (
            <footer className="mt-6 flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                {[languageLabel, insights.customization?.templateName]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {review}
            </footer>
          ) : null}
        </>
      ) : !processing && !insights.error ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
          <FileText className="size-7 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">
              {t("The important points, in one place")}
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              {t(
                "Turn this conversation into a clear report you can read and share."
              )}
            </p>
          </div>
          <Button disabled={createDisabled} onClick={onCreate}>
            {t("Generate summary")}
          </Button>
        </div>
      ) : null}
    </article>
  )
}
