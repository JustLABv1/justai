"use client"
import { ToastFeedback } from "@/components/toast-feedback"

import { useTranslations } from "@/components/locale-provider"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  File as FileIcon,
  FileCode,
  FileSpreadsheet,
  FileText,
  MoreHorizontal,
  Plus,
  Presentation,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { api } from "@/lib/api"
import { downloadFile } from "@/lib/download-file"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Card } from "@/components/panelui/card"
import { Dialog } from "@/components/panelui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/panelui/field"
import { Input } from "@/components/panelui/input"
import { Menu } from "@/components/panelui/menu"
import { Textarea } from "@/components/panelui/textarea"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
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
const MAX_BYTES = 8 * 1024 * 1024
/** A search field only helps once the list is long enough to need it. */
const SEARCH_FROM = 6

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

/** The kind of document a template is, from its file name. */
function FileKindIcon({ filename }: { filename: string }) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? ""
  if (["xlsx", "xltx", "ods", "ots", "csv"].includes(extension))
    return <FileSpreadsheet aria-hidden="true" />
  if (["pptx", "potx", "odp", "otp"].includes(extension))
    return <Presentation aria-hidden="true" />
  if (["html", "json", "xml"].includes(extension))
    return <FileCode aria-hidden="true" />
  if (["docx", "dotx", "odt", "ott", "txt", "md"].includes(extension))
    return <FileText aria-hidden="true" />
  return <FileIcon aria-hidden="true" />
}

function formatSize(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
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
  const fileInput = useRef<HTMLInputElement>(null)
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
  const tooBig = file !== null && file.size > MAX_BYTES
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
            <Plus data-icon="inline-start" />
            {t("Add template")}
          </Button>
        </PageActions>
      </PageHeader>
      {error && !editor && !remove && (
        <ToastFeedback message={error} type={"destructive"} />
      )}
      {templates.length > SEARCH_FROM && (
        <Input.Group className="w-full sm:w-80">
          <Input.Addon>
            <Search aria-hidden="true" />
          </Input.Addon>
          <Input
            aria-label={t("Search templates")}
            placeholder={t("Search templates…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Input.Group>
      )}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton className="h-44 w-full rounded-[22px]" key={index} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card className="border-dashed">
          <Card.Content className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
            <span className="rounded-full bg-muted p-3 text-muted-foreground">
              <FileText aria-hidden="true" className="size-6" />
            </span>
            <div className="flex max-w-md flex-col gap-1">
              <p className="font-medium">
                {templates.length
                  ? t("No matching templates")
                  : t("Your reusable templates")}
              </p>
              <p className="text-sm text-muted-foreground">
                {templates.length
                  ? t("Try a different name or clear the search.")
                  : t(
                      "Upload a report, expense form, letter, spreadsheet, or presentation. Then ask: “Use my expense template with these receipts.”"
                    )}
              </p>
            </div>
            {templates.length === 0 ? (
              <Button disabled={busy} onClick={() => void open()}>
                <Plus data-icon="inline-start" />
                {t("Add template")}
              </Button>
            ) : (
              <Button onClick={() => setQuery("")} variant="outline">
                {t("Clear search")}
              </Button>
            )}
          </Card.Content>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((template) => (
            <Card className="min-w-0" key={template.id}>
              <Card.Header>
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
                    <FileKindIcon filename={template.filename} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Card.Title className="truncate">
                      {template.name}
                    </Card.Title>
                    <Card.Description className="truncate">
                      {template.filename}
                    </Card.Description>
                  </div>
                  <Menu>
                    <Menu.Trigger
                      render={
                        <Button
                          aria-label={t("More actions for {value0}", {
                            value0: template.name,
                          })}
                          className="-me-1 -mt-1 shrink-0"
                          disabled={busy}
                          size="icon-sm"
                          variant="ghost"
                        />
                      }
                    >
                      <MoreHorizontal />
                    </Menu.Trigger>
                    <Menu.Content align="end">
                      <Menu.Item onClick={() => void open(template)}>
                        {t("Edit")}
                      </Menu.Item>
                      <Menu.Item
                        onClick={() =>
                          void downloadFile(
                            `/api/v1/templates/${template.id}/file`,
                            template.filename
                          ).catch((err) => setError(err.message))
                        }
                      >
                        {t("Download original")}
                      </Menu.Item>
                      <Menu.Separator />
                      <Menu.Item
                        onClick={() => {
                          setError("")
                          setRemove(template)
                        }}
                        variant="destructive"
                      >
                        <Trash2 />
                        {t("Delete")}
                      </Menu.Item>
                    </Menu.Content>
                  </Menu>
                </div>
              </Card.Header>
              <Card.Content className="flex flex-col gap-3">
                <p className="line-clamp-3 text-sm text-muted-foreground">
                  {template.instructions ||
                    t("Ask the chat to use this template by name.")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge size="sm" variant="outline">
                    {t("Revision")} {template.revision}
                  </Badge>
                </div>
              </Card.Content>
              <Card.Footer className="justify-end" variant="panel">
                <Button
                  disabled={busy}
                  onClick={() => void open(template)}
                  size="sm"
                  variant="outline"
                >
                  {t("Edit")}
                </Button>
              </Card.Footer>
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
        <Dialog.Content className="sm:max-w-2xl">
          <Dialog.Header
            title={existing ? t("Edit template") : t("Add template")}
            description={t(
              "Office and OpenDocument files keep their document structure. PDF forms can be filled; PDFs without form fields are reference material for a new document."
            )}
          />
          <Dialog.Body>
            {error && <ToastFeedback message={error} type={"destructive"} />}
            <Field>
              <FieldLabel>{t("Name")}</FieldLabel>
              <Input
                value={name}
                maxLength={120}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Travel expenses")}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                {existing
                  ? t("Replace original (optional)")
                  : t("Template file")}
              </p>
              <input
                accept={formats}
                aria-label={
                  existing
                    ? t("Replace original (optional)")
                    : t("Template file")
                }
                className="sr-only"
                disabled={busy}
                key={existing?.id ?? "new"}
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null
                  setFile(next)
                  if (!name && next) setName(next.name.replace(/\.[^.]+$/, ""))
                }}
                ref={fileInput}
                type="file"
              />
              <div className="flex items-center gap-3 rounded-2xl border bg-muted/30 p-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground [&_svg]:size-5">
                  {file || existing ? (
                    <FileKindIcon filename={file?.name ?? existing!.filename} />
                  ) : (
                    <Upload aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {file
                      ? file.name
                      : existing
                        ? existing.filename
                        : t("No file chosen")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {file
                      ? formatSize(file.size)
                      : existing
                        ? t("Current original")
                        : t("Word, Excel, PowerPoint, PDF and more")}
                  </p>
                </div>
                {file ? (
                  <Button
                    aria-label={t("Remove file")}
                    disabled={busy}
                    onClick={() => {
                      setFile(null)
                      if (fileInput.current) fileInput.current.value = ""
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                ) : null}
                <Button
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                  size="sm"
                  variant="outline"
                >
                  {file || existing ? t("Replace") : t("Choose file")}
                </Button>
              </div>
              {tooBig ? (
                <p className="text-xs text-destructive" role="alert">
                  {t("The file exceeds 8 MB.")}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Up to 8 MB. Word, Excel, PowerPoint, OpenDocument, PDF, Markdown, text, CSV, HTML, JSON and XML. Convert older .doc, .xls, .ppt and .rtf files to a modern Office format first."
                  )}
                </p>
              )}
            </div>
            <Field>
              <FieldLabel>{t("How to use this template")}</FieldLabel>
              <Textarea
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
            {existing?.inspection && (
              <Alert tone="info" variant="plain">
                <Alert.Title>
                  {existing.inspection.mode === "reference"
                    ? t("Reference PDF · creates a new document")
                    : t("{value0} document targets", {
                        value0: existing.inspection.targets.length,
                      })}
                </Alert.Title>
                {existing.inspection.placeholders.length > 0 && (
                  <Alert.Description>
                    {t("Placeholders:")}{" "}
                    {existing.inspection.placeholders.join(", ")}
                  </Alert.Description>
                )}
              </Alert>
            )}
          </Dialog.Body>
          <Dialog.Footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={busy || !name.trim() || (!existing && !file) || tooBig}
              onClick={() => void save()}
            >
              {busy ? t("Saving…") : t("Save template")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      <ConfirmActionDialog
        confirmLabel={t("Delete template")}
        description={t(
          "The saved template will be removed. Files already generated from it remain available."
        )}
        onConfirm={deleteTemplate}
        onOpenChange={(value) => {
          if (!value && !busy) setRemove(null)
        }}
        open={remove !== null}
        pending={busy}
        title={`${t("Delete")} ${remove?.name ?? ""}?`}
      />
    </Page>
  )
}
