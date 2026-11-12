"use client"

import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "@/components/panelui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/panelui/input"
import { Textarea } from "@/components/panelui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  defaultSummaryStandard,
  summaryTemplateStarters,
  type SummaryTemplate,
  type SummaryTemplateDraft,
} from "@/lib/transcription-summary-standard"

export function SummaryTemplatePicker({
  templates,
  selectedId,
  onSelect,
  onEdit,
  loading,
}: {
  templates: SummaryTemplate[]
  selectedId: string
  onSelect: (id: string) => void
  onEdit: (draft: SummaryTemplateDraft) => void
  loading: boolean
}) {
  const { t } = useTranslations()
  const selected = templates.find((item) => item.id === selectedId)
  const create = (preset?: (typeof summaryTemplateStarters)[number]) =>
    onEdit({
      ...defaultSummaryStandard,
      name: preset ? t(preset.name) : "",
      instructions: preset ? t(preset.instructions) : "",
      exclusionRules: preset ? t(preset.exclusionRules) : "",
    })
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>{t("Team template")}</FieldLabel>
        <div className="flex gap-2">
          <Select
            disabled={loading}
            items={[
              { value: "none", label: t("Without a template") },
              ...templates.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            value={selectedId || "none"}
            onValueChange={(value) =>
              onSelect(value === "none" ? "" : (value ?? ""))
            }
          >
            <SelectTrigger
              aria-label={t("Team template")}
              className="min-w-0 flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="none">{t("Without a template")}</SelectItem>
                {templates.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {selected ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t(
                selected.canEdit ? "Edit team template" : "Copy team template"
              )}
              onClick={() =>
                onEdit({
                  ...selected,
                  id: selected.canEdit ? selected.id : undefined,
                  name: selected.canEdit
                    ? selected.name
                    : t("{value0} (copy)", { value0: selected.name }),
                  revision: selected.canEdit ? selected.updatedAt : undefined,
                })
              }
            >
              <Pencil />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="secondary" size="sm" disabled={loading} />
              }
            >
              <Plus data-icon="inline-start" />
              {t("New template")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => create()}>
                {t("Create your own")}
              </DropdownMenuItem>
              {summaryTemplateStarters.map((preset) => (
                <DropdownMenuItem
                  key={preset.key}
                  onClick={() => create(preset)}
                >
                  {t(preset.name)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Field>
      {selected ? (
        <p className="text-sm text-muted-foreground">
          {t("Uses your team's saved choices.")}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("You can also create a template for your team.")}
        </p>
      )}
    </FieldGroup>
  )
}

export function SummaryTemplateEditor({
  draft,
  onChange,
  onClose,
  onSave,
  onDelete,
  saving,
  error,
  suggested,
}: {
  draft: SummaryTemplateDraft | null
  onChange: (draft: SummaryTemplateDraft) => void
  onClose: () => void
  onSave: () => void
  onDelete: () => void
  saving: boolean
  error: string
  suggested: boolean
}) {
  const { t } = useTranslations()
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <Dialog
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t(
              suggested
                ? "Review the suggested rule"
                : draft?.id
                  ? "Edit team template"
                  : "New team template"
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Your team can reuse this template. Existing summaries stay unchanged."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {draft ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="team-summary-template-name">
                  {t("Template name")}
                </FieldLabel>
                <Input
                  id="team-summary-template-name"
                  maxLength={120}
                  value={draft.name}
                  onChange={(event) =>
                    onChange({ ...draft, name: event.target.value })
                  }
                  placeholder={t("For example: Plenary debate")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="team-summary-template-style">
                  {t("What should the summary focus on?")}
                </FieldLabel>
                <Textarea
                  id="team-summary-template-style"
                  maxLength={4000}
                  value={draft.instructions}
                  onChange={(event) =>
                    onChange({ ...draft, instructions: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="team-summary-template-rules">
                  {t("What should be left out?")}
                </FieldLabel>
                <Textarea
                  id="team-summary-template-rules"
                  className="min-h-40"
                  maxLength={6000}
                  value={draft.exclusionRules}
                  onChange={(event) =>
                    onChange({ ...draft, exclusionRules: event.target.value })
                  }
                  placeholder={t(
                    "For example: Leave out purely organizational openings and closings. Keep substantive statements, including from the chair."
                  )}
                />
              </Field>
              <details className="rounded-lg bg-muted p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {t("File and appearance")}
                </summary>
                <FieldGroup className="mt-3">
                  <Field>
                    <FieldLabel>{t("File format")}</FieldLabel>
                    <Select
                      value={draft.format}
                      onValueChange={(value) =>
                        onChange({ ...draft, format: value ?? "pdf" })
                      }
                      items={[
                        { value: "pdf", label: "PDF" },
                        { value: "docx", label: "Word" },
                        { value: "md", label: "Markdown" },
                        { value: "txt", label: t("Plain text") },
                        { value: "json", label: "JSON" },
                      ]}
                    >
                      <SelectTrigger aria-label={t("File format")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="pdf">PDF</SelectItem>
                          <SelectItem value="docx">Word</SelectItem>
                          <SelectItem value="md">Markdown</SelectItem>
                          <SelectItem value="txt">{t("Plain text")}</SelectItem>
                          <SelectItem value="json">JSON</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["summary", "Summary"],
                        ["chapters", "Chapters"],
                        ["topics", "Topics"],
                        ["actionItems", "Action items"],
                        ["boldSpeakers", "Highlight speaker names"],
                      ] as const
                    ).map(([key, label]) => (
                      <Button
                        key={key}
                        size="sm"
                        variant={draft[key] ? "default" : "ghost"}
                        aria-pressed={draft[key]}
                        onClick={() =>
                          onChange({ ...draft, [key]: !draft[key] })
                        }
                      >
                        {t(label)}
                      </Button>
                    ))}
                  </div>
                </FieldGroup>
              </details>
              {suggested ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Check the proposed rule carefully. It is only shared with the team when you save."
                  )}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(error)}
                </p>
              ) : null}
            </FieldGroup>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {draft?.id ? (
            <Button
              className="text-destructive hover:not-disabled:text-destructive"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                if (confirmDelete) onDelete()
                else setConfirmDelete(true)
              }}
            >
              <Trash2 data-icon="inline-start" />
              {t(
                confirmDelete ? "Delete for the whole team?" : "Delete template"
              )}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={saving || !draft?.name.trim()} onClick={onSave}>
            {t(saving ? "Saving…" : "Save for team")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
