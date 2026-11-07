"use client"

import { useState } from "react"
import { Pencil, RotateCcw, X } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Textarea } from "@/components/panelui/textarea"
import type { TranscriptionInsights } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  summaryParagraphs,
  type SummaryExportDraft,
} from "@/lib/transcription-summary-standard"

export function TranscriptionSummaryExportEditor({
  insights,
  sections,
  boldSpeakers,
  speakerNames,
  title,
  onChange,
  onSuggestRule,
  ruleProposing,
}: {
  insights: TranscriptionInsights
  sections: {
    summary: boolean
    chapters: boolean
    topics: boolean
    actionItems: boolean
  }
  boldSpeakers: boolean
  speakerNames: string[]
  title: string
  onChange: (draft: SummaryExportDraft) => void
  onSuggestRule: (text: string) => void
  ruleProposing: boolean
}) {
  const { t } = useTranslations()
  const paragraphs = summaryParagraphs(insights.summary ?? "")
  const initialDraft: SummaryExportDraft = {
    revision: insights.updatedAt,
    summaryParagraphs: paragraphs,
    chapterIndices: (insights.chapters ?? []).map((_, index) => index),
    topicIndices: (insights.topics ?? []).map((_, index) => index),
    actionItemIndices: (insights.actionItems ?? []).map((_, index) => index),
  }
  const [draft, setDraft] = useState(initialDraft)
  const [excludedParagraphs, setExcludedParagraphs] = useState<number[]>([])
  const [edits, setEdits] = useState(paragraphs)
  const [editing, setEditing] = useState<number | null>(null)
  const update = (next: SummaryExportDraft) => {
    setDraft(next)
    onChange(next)
  }
  const omittedCount =
    excludedParagraphs.length +
    (initialDraft.chapterIndices.length - draft.chapterIndices.length) +
    (initialDraft.topicIndices.length - draft.topicIndices.length) +
    (initialDraft.actionItemIndices.length - draft.actionItemIndices.length)
  const hasEdits = edits.some((text, index) => text !== paragraphs[index])
  const emphasizeSpeaker = (text: string) => {
    const name = boldSpeakers
      ? [...speakerNames]
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .find(
            (name) =>
              text === name ||
              [" ", ":", ","].some((separator) =>
                text.startsWith(name + separator)
              )
          )
      : undefined
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
    <div className="flex flex-col gap-3">
      <article
        aria-label={t("Your document")}
        className="rounded-xl bg-background px-5 py-6 sm:px-8 sm:py-8"
      >
        <h2 className="mb-7 text-lg font-semibold text-foreground">
          {title || t("Summary")}
        </h2>
        {sections.summary && paragraphs.length > 0 ? (
          <section className="flex flex-col gap-5" aria-label={t("Summary")}>
            <h3 className="text-sm font-semibold">{t("Summary")}</h3>
            {paragraphs.map((paragraph, index) =>
              !excludedParagraphs.includes(index) ? (
                <div key={index} className="group/paragraph rounded-lg">
                  {editing === index ? (
                    <div className="flex flex-col gap-2">
                      <Textarea
                        autoFocus
                        aria-label={t("Edit paragraph")}
                        value={edits[index] ?? paragraph}
                        className="min-h-36"
                        onChange={(event) => {
                          const next = edits.map((text, i) =>
                            i === index ? event.target.value : text
                          )
                          setEdits(next)
                          update({
                            ...draft,
                            summaryParagraphs: next.filter(
                              (_, i) => !excludedParagraphs.includes(i)
                            ),
                          })
                        }}
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setEditing(null)}
                        >
                          {t("Done")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm leading-7 whitespace-pre-wrap text-foreground">
                        {emphasizeSpeaker(edits[index] ?? paragraph)}
                      </p>
                      <div className="mt-1 flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(index)}
                        >
                          <Pencil data-icon="inline-start" />
                          {t("Edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("Leave out paragraph {value0}", {
                            value0: index + 1,
                          })}
                          onClick={() => {
                            const excluded = [...excludedParagraphs, index]
                            setExcludedParagraphs(excluded)
                            update({
                              ...draft,
                              summaryParagraphs: edits.filter(
                                (_, i) => !excluded.includes(i)
                              ),
                            })
                          }}
                        >
                          <X data-icon="inline-start" />
                          {t("Leave out")}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div
                  key={index}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2"
                >
                  <p className="w-full truncate text-xs text-muted-foreground">
                    {t("Left out")}: {edits[index] ?? paragraph}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={ruleProposing}
                    onClick={() => onSuggestRule(edits[index] ?? paragraph)}
                  >
                    {t(
                      ruleProposing
                        ? "Suggesting…"
                        : "Leave out similar contributions in future"
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("Restore paragraph {value0}", {
                      value0: index + 1,
                    })}
                    onClick={() => {
                      const excluded = excludedParagraphs.filter(
                        (i) => i !== index
                      )
                      setExcludedParagraphs(excluded)
                      update({
                        ...draft,
                        summaryParagraphs: edits.filter(
                          (_, i) => !excluded.includes(i)
                        ),
                      })
                    }}
                  >
                    {t("Restore")}
                  </Button>
                </div>
              )
            )}
          </section>
        ) : null}
        {(
          [
            [
              "chapterIndices",
              "chapters",
              t("Chapters"),
              (insights.chapters ?? []).map((chapter) => ({
                title: chapter.title,
                description: chapter.summary,
              })),
            ],
            [
              "topicIndices",
              "topics",
              t("Topics"),
              (insights.topics ?? []).map((text) => ({
                title: text,
                description: "",
              })),
            ],
            [
              "actionItemIndices",
              "actionItems",
              t("Action items"),
              (insights.actionItems ?? []).map((text) => ({
                title: text,
                description: "",
              })),
            ],
          ] as const
        ).map(([key, section, label, items]) =>
          sections[section] && items.length ? (
            <section
              key={key}
              aria-label={label}
              className="mt-7 flex flex-col gap-3"
            >
              <h3 className="text-sm font-semibold">{label}</h3>
              {items.map((item, index) => {
                const included = draft[key].includes(index)
                return (
                  <div
                    key={index}
                    className={cn(
                      "flex items-start justify-between gap-3 rounded-lg",
                      !included && "bg-muted p-3"
                    )}
                  >
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "text-sm leading-6",
                          !included && "text-muted-foreground line-through"
                        )}
                      >
                        {item.title}
                      </p>
                      {included && item.description ? (
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          {item.description}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t(
                        included ? "Leave out {value0}" : "Restore {value0}",
                        { value0: item.title }
                      )}
                      title={t(included ? "Leave out" : "Restore")}
                      onClick={() =>
                        update({
                          ...draft,
                          [key]: included
                            ? draft[key].filter((i) => i !== index)
                            : [...draft[key], index].sort((a, b) => a - b),
                        })
                      }
                    >
                      {included ? <X /> : <RotateCcw />}
                    </Button>
                  </div>
                )
              })}
            </section>
          ) : null
        )}
        {!Object.values(sections).some(Boolean) ? (
          <p className="text-sm text-muted-foreground">
            {t("Choose what to include above.")}
          </p>
        ) : null}
      </article>
      {omittedCount > 0 || hasEdits ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <p role="status" className="text-xs text-muted-foreground">
            {omittedCount > 0
              ? t("{value0} items left out", { value0: omittedCount })
              : t("Text edited")}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEdits(paragraphs)
              setExcludedParagraphs([])
              setEditing(null)
              update(initialDraft)
            }}
          >
            <RotateCcw data-icon="inline-start" />
            {t("Undo all changes")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
