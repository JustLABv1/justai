"use client"

import { useEffect, useRef, useState } from "react"
import {
  FileText,
  Globe2,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react"

import { APIError, api } from "@/lib/api"
import type { KnowledgeSource } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Props = {
  sources: KnowledgeSource[]
  onChange: (sources: KnowledgeSource[]) => void
  organizationRole?: string
  userId?: string
  platformAdmin?: boolean
}

export function KnowledgeView({
  sources,
  onChange,
  organizationRole,
  userId,
  platformAdmin = false,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [title, setTitle] = useState("")
  const canManageOrganization =
    platformAdmin ||
    organizationRole === "owner" ||
    organizationRole === "admin"
  const [scopeType, setScopeType] = useState(
    canManageOrganization ? "organization" : "user"
  )
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState("")
  const [busyId, setBusyId] = useState("")

  const hasPendingRemoteSources = sources.some(
    (source) => source.status === "queued" || source.status === "processing"
  )

  const canManageSource = (source: KnowledgeSource) => {
    if (userId === undefined && organizationRole === undefined) return true
    if (source.scopeType === "user") return source.scopeId === userId
    return source.scopeType === "organization" && canManageOrganization
  }

  useEffect(() => {
    if (!hasPendingRemoteSources) return
    let cancelled = false
    const refresh = async () => {
      try {
        const result = await api.get<{ sources: KnowledgeSource[] }>(
          "/api/v1/knowledge/sources"
        )
        if (!cancelled) onChange(result.sources)
      } catch {
        if (!cancelled)
          setNotice(
            "Knowledge status refresh failed. Retry when the backend is available."
          )
      }
    }
    const interval = window.setInterval(() => void refresh(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [hasPendingRemoteSources, onChange])

  async function uploadFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      setNotice("Files are limited to 25 MB.")
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    if (!isSupportedKnowledgeFile(file)) {
      setNotice(
        "Unsupported attachment. Use PDF, Markdown, text, HTML, or JSON; images and media are not supported."
      )
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    setUploading(true)
    setNotice("")
    const form = new FormData()
    form.append("file", file)
    form.append("title", title || file.name)
    form.append(
      "scopeType",
      canManageOrganization || scopeType !== "organization" ? scopeType : "user"
    )
    try {
      const result = await api.upload<KnowledgeSource>(
        "/api/v1/knowledge/sources",
        form
      )
      onChange([result, ...sources])
      setNotice(`${file.name} queued for indexing.`)
    } catch (caught) {
      if (caught instanceof APIError) {
        setNotice(`Upload failed: ${caught.message}`)
        return
      }
      setNotice(
        caught instanceof Error
          ? caught.message
          : "Upload failed. Check the backend and try again."
      )
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function addURL(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!url.trim()) return
    try {
      const parsed = new URL(url.trim())
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported scheme")
      }
    } catch {
      setNotice("Enter a valid public http(s) URL.")
      return
    }
    setUploading(true)
    try {
      const result = await api.post<KnowledgeSource>(
        "/api/v1/knowledge/sources",
        {
          title: title || url,
          sourceType: "url",
          sourceUrl: url,
          scopeType:
            canManageOrganization || scopeType !== "organization"
              ? scopeType
              : "user",
        }
      )
      onChange([result, ...sources])
      setNotice(
        "URL queued for indexing. Private network targets are blocked by the backend."
      )
      setDialogOpen(false)
      setUrl("")
      setTitle("")
    } catch (caught) {
      if (caught instanceof APIError) {
        setNotice(`URL indexing failed: ${caught.message}`)
        return
      }
      setNotice(
        caught instanceof Error
          ? caught.message
          : "URL indexing failed. Check the backend and try again."
      )
    } finally {
      setUploading(false)
    }
  }

  async function reindex(source: KnowledgeSource) {
    setBusyId(source.id)
    try {
      await api.post(`/api/v1/knowledge/sources/${source.id}/reindex`)
      onChange(
        sources.map((item) =>
          item.id === source.id
            ? { ...item, status: "queued", progress: 0, stage: "queued" }
            : item
        )
      )
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The source could not be reindexed."
      )
    } finally {
      setBusyId("")
    }
  }

  async function remove(source: KnowledgeSource) {
    if (!window.confirm(`Remove “${source.title}” from Knowledge?`)) return
    setBusyId(source.id)
    try {
      await api.delete(`/api/v1/knowledge/sources/${source.id}`)
      onChange(sources.filter((item) => item.id !== source.id))
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The source could not be removed."
      )
    } finally {
      setBusyId("")
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="secondary">Retrieval layer</Badge>
            <span className="text-xs text-muted-foreground">
              PDF · Markdown · text · URLs
            </span>
          </div>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">
            Give JustAI useful memory
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Upload source material or index a URL. Processing stays scoped to
            your organization or personal workspace, with status and citations
            visible here.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            <Link2 data-icon="inline-start" aria-hidden="true" />
            Add URL
          </Button>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <UploadCloud data-icon="inline-start" aria-hidden="true" />
            Upload file
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.md,.markdown,.txt,.html,.htm,.json,text/*,application/pdf,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadFile(file)
            }}
          />
        </div>
      </div>

      {notice && (
        <Alert>
          <Search aria-hidden="true" />
          <AlertTitle>Knowledge pipeline</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          label="Indexed sources"
          value={String(
            sources.filter((source) => source.status === "ready").length
          )}
          detail="ready for retrieval"
        />
        <Metric
          label="In progress"
          value={String(
            sources.filter(
              (source) =>
                source.status === "queued" || source.status === "processing"
            ).length
          )}
          detail="async jobs"
        />
        <Metric label="Scope" value="Private" detail="org + personal access" />
      </div>

      {sources.length === 0 ? (
        <Empty className="min-h-72 border bg-card shadow-xs">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Your knowledge base is empty</EmptyTitle>
            <EmptyDescription>
              Start with a project brief, a runbook, or a public documentation
              URL.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload a file
              </Button>
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Index a URL
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sources</CardTitle>
            <CardDescription>
              Each ready source is chunked for lexical retrieval, with optional
              semantic retrieval when an embedding endpoint is configured.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AttachmentGroup className="grid grid-cols-1 gap-3 overflow-visible sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source) => {
                const manageable = canManageSource(source)
                return (
                  <Attachment
                    key={source.id}
                    state={
                      source.status === "failed"
                        ? "error"
                        : source.status === "processing"
                          ? "processing"
                          : source.status === "queued"
                            ? "uploading"
                            : "done"
                    }
                    orientation="vertical"
                    className="w-full"
                  >
                    <AttachmentMedia variant="icon">
                      {source.sourceType === "url" ? (
                        <Globe2 aria-hidden="true" />
                      ) : (
                        <FileText aria-hidden="true" />
                      )}
                    </AttachmentMedia>
                    <AttachmentContent className="p-2">
                      <AttachmentTitle>{source.title}</AttachmentTitle>
                      <AttachmentDescription>
                        {source.sourceType === "url"
                          ? source.sourceUrl
                          : source.mimeType || "Text source"}
                      </AttachmentDescription>
                      <div className="mt-3 flex items-center gap-2">
                        <Badge
                          variant={
                            source.status === "ready"
                              ? "secondary"
                              : source.status === "failed"
                                ? "destructive"
                                : "outline"
                          }
                          className="text-[10px]"
                        >
                          {source.status}
                        </Badge>
                        {manageable && (
                          <div className="ml-auto flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={busyId === source.id}
                              onClick={() => void reindex(source)}
                              aria-label={`Reindex ${source.title}`}
                            >
                              <RefreshCw aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={busyId === source.id}
                              onClick={() => void remove(source)}
                              aria-label={`Remove ${source.title}`}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {(source.status === "processing" ||
                        source.status === "queued") && (
                        <Progress
                          value={Math.max(
                            0,
                            Math.min(100, source.progress ?? 0)
                          )}
                          className="mt-3"
                        />
                      )}
                      {source.stage && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {source.stage}
                        </p>
                      )}
                      {source.error && (
                        <p className="mt-2 text-[11px] text-destructive">
                          {source.error}
                        </p>
                      )}
                    </AttachmentContent>
                  </Attachment>
                )
              })}
            </AttachmentGroup>
          </CardContent>
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Index a URL</DialogTitle>
            <DialogDescription>
              JustAI fetches public HTTP(S) content and blocks private or
              loopback targets by default.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={addURL}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="knowledge-title">Source title</FieldLabel>
                <Input
                  id="knowledge-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Product docs"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="knowledge-url">URL</FieldLabel>
                <Input
                  id="knowledge-url"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://docs.example.com"
                  required
                />
                <FieldDescription>
                  Reindex manually when the source changes.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Visibility</FieldLabel>
                <Select
                  value={scopeType}
                  onValueChange={(value) =>
                    setScopeType(
                      value ?? (canManageOrganization ? "organization" : "user")
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {canManageOrganization && (
                      <SelectItem value="organization">Organization</SelectItem>
                    )}
                    <SelectItem value="user">Only me</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={uploading}>
                {uploading ? (
                  <>
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                      aria-hidden="true"
                    />
                    Indexing…
                  </>
                ) : (
                  "Start indexing"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-2 font-heading text-2xl font-semibold tracking-tight">
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function isSupportedKnowledgeFile(file: File) {
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase().split(";", 1)[0]
  if (
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|mp3|wav|ogg|m4a|mp4|mov|webm|avi)$/.test(
      name
    )
  ) {
    return false
  }
  return (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "application/json" ||
    /\.(pdf|md|markdown|txt|html?|json)$/.test(name)
  )
}
