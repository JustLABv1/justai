"use client"

import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useState } from "react"
import { api } from "@/lib/api"
import { downloadFile } from "@/lib/download-file"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Page,
  PageHeader,
  PageHeading,
  PageTitle,
  PageDescription,
  PageActions,
} from "@/components/ui/page"
import { Skeleton } from "@/components/ui/skeleton"

const formats =
  ".docx,.dotx,.xlsx,.xltx,.pptx,.potx,.odt,.ott,.ods,.ots,.odp,.otp,.pdf,.txt,.md,.csv,.html,.json,.xml"
type Template = {
  id: string
  name: string
  instructions: string
  filename: string
  revision: number
  inspection?: {
    mode: string
    placeholders: string[]
    targets: { id: string; text: string; readOnly?: boolean }[]
  }
}

export function TemplatesView() {
  const { t } = useTranslations()

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [editor, setEditor] = useState<Template | "new" | null>(null)
  const [name, setName] = useState("")
  const [instructions, setInstructions] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<Template | null>(null)
  const [query, setQuery] = useState("")
  const refresh = useCallback(async () => {
    const result = await api.get<{ templates: Template[] }>("/api/v1/templates")
    setTemplates(result.templates)
  }, [])
  useEffect(() => {
    let active = true
    api
      .get<{ templates: Template[] }>("/api/v1/templates")
      .then((result) => {
        if (active) setTemplates(result.templates)
      })
      .catch((err) => {
        if (active) setError(String(err.message ?? err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function open(template?: Template) {
    setError("")
    setBusy(true)
    try {
      const detail = template
        ? (
            await api.get<{ template: Template }>(
              `/api/v1/templates/${template.id}`
            )
          ).template
        : null
      setName(detail?.name ?? "")
      setInstructions(detail?.instructions ?? "")
      setFile(null)
      setEditor(detail ?? "new")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open template")
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    if (!editor) return
    setBusy(true)
    setError("")
    try {
      const form = new FormData()
      form.set("name", name)
      form.set("instructions", instructions)
      if (file) form.set("file", file)
      if (editor !== "new") form.set("revision", String(editor.revision))
      await api.upload(
        `/api/v1/templates${editor === "new" ? "" : `/${editor.id}`}`,
        form
      )
      setEditor(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template")
    } finally {
      setBusy(false)
    }
  }
  async function deleteTemplate() {
    if (!remove) return
    setBusy(true)
    setError("")
    try {
      await api.delete(`/api/v1/templates/${remove.id}`)
      setRemove(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete template")
    } finally {
      setBusy(false)
    }
  }
  const visible = templates.filter((t) =>
    `${t.name} ${t.instructions} ${t.filename}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
  const existing = editor && editor !== "new" ? editor : null
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("Templates")}</PageTitle>
          <PageDescription>
            {t(
              "Save a template once, then ask for it by name in any chat. Your templates are private to you in this workspace."
            )}
          </PageDescription>
        </PageHeading>
        <PageActions>
          <Button disabled={busy} onClick={() => void open()}>
            {t("Add template")}
          </Button>
        </PageActions>
      </PageHeader>
      {error && !editor && !remove && (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      <Input
        aria-label={t("Search templates")}
        placeholder={t("Search templates…")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {templates.length
                ? t("No matching templates")
                : t("Your reusable templates")}
            </EmptyTitle>
            <EmptyDescription>
              {t(
                "Upload a report, expense form, letter, spreadsheet, or presentation. Then ask: “Use my expense template with these receipts.”"
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((template) => (
            <Card key={template.id}>
              <CardHeader>
                <CardTitle>{template.name}</CardTitle>
                <CardDescription>{template.filename}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-3 text-sm text-muted-foreground">
                  {template.instructions ||
                    "Ask the chat to use this template by name."}
                </p>
                <Badge variant="secondary">
                  {t("Revision")} {template.revision}
                </Badge>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void open(template)}
                >
                  {t("Edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void downloadFile(
                      `/api/v1/templates/${template.id}/file`,
                      template.filename
                    ).catch((err) => setError(err.message))
                  }
                >
                  {t("Original")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setError("")
                    setRemove(template)
                  }}
                >
                  {t("Delete")}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <Dialog
        open={editor !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setEditor(null)
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {existing ? t("Edit template") : t("Add template")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Office and OpenDocument files keep their document structure. PDF forms can be filled; PDFs without form fields are reference material for a new document."
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="template-name">{t("Name")}</FieldLabel>
              <Input
                id="template-name"
                value={name}
                maxLength={120}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Travel expenses")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="template-file">
                {existing
                  ? t("Replace original (optional)")
                  : t("Template file")}
              </FieldLabel>
              <Input
                key={existing?.id ?? "new"}
                id="template-file"
                type="file"
                accept={formats}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null
                  setFile(next)
                  if (!name && next) setName(next.name.replace(/\.[^.]+$/, ""))
                }}
              />
              <FieldDescription>
                {t(
                  "Up to 8 MB. Word, Excel, PowerPoint, OpenDocument, PDF, Markdown, text, CSV, HTML, JSON and XML. Convert older .doc, .xls, .ppt and .rtf files to a modern Office format first."
                )}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="template-instructions">
                {t("How to use this template")}
              </FieldLabel>
              <Textarea
                id="template-instructions"
                value={instructions}
                maxLength={12000}
                disabled={busy}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t(
                  "Describe required information, which fields or cells to fill, and rules the assistant should follow."
                )}
                rows={5}
              />
              <FieldDescription>
                {t("Optional placeholders such as")} {"{{name}}"}{" "}
                {t(
                  "are supported. Existing paragraphs, spreadsheet cells and PDF form fields can also be filled without placeholders."
                )}
              </FieldDescription>
            </Field>
          </FieldGroup>
          {existing?.inspection && (
            <div className="flex flex-col gap-2">
              <Badge variant="secondary">
                {existing.inspection.mode === "reference"
                  ? t("Reference PDF · creates a new document")
                  : t("{value0} document targets", {
                      value0: existing.inspection.targets.length,
                    })}
              </Badge>
              {existing.inspection.placeholders.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("Placeholders:")}{" "}
                  {existing.inspection.placeholders.join(", ")}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                busy ||
                !name.trim() ||
                (!existing && !file) ||
                (file !== null && file.size > 8 * 1024 * 1024)
              }
              onClick={() => void save()}
            >
              {busy ? t("Saving…") : t("Save template")}
            </Button>
          </DialogFooter>
          {file && file.size > 8 * 1024 * 1024 && (
            <Alert variant="destructive">
              <AlertDescription>{t("The file exceeds 8 MB.")}</AlertDescription>
            </Alert>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={remove !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setRemove(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Delete")} {remove?.name}?
            </DialogTitle>
            <DialogDescription>
              {t(
                "The saved template will be removed. Files already generated from it remain available."
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void deleteTemplate()}
            >
              {t("Delete template")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}
