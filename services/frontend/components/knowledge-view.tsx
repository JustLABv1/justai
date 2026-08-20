"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"

import { APIError, api } from "@/lib/api"
import type { KnowledgeSource } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import { cn } from "@/lib/utils"

const sourceStatusStyles: Record<
  KnowledgeSource["status"],
  { label: string; text: string; dot: string }
> = {
  ready: {
    label: "Ready",
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  queued: {
    label: "Queued",
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  processing: {
    label: "Processing",
    text: "text-primary",
    dot: "bg-primary",
  },
  failed: {
    label: "Failed",
    text: "text-destructive",
    dot: "bg-destructive",
  },
}

const SOURCE_PAGE_SIZE = 12

type SourceFilter = "all" | "ready" | "in-progress" | "failed"

function getSourceParts(source: KnowledgeSource) {
  const separatorIndex = source.title.indexOf(" · ")
  if (separatorIndex === -1) {
    return {
      group: source.sourceType === "url" ? "URL source" : "Uploaded file",
      path: source.title,
    }
  }
  return {
    group: source.title.slice(0, separatorIndex),
    path: source.title.slice(separatorIndex + 3),
  }
}

function formatStage(stage: string) {
  return stage.replace(/[-_]/g, " ")
}

type Props = {
  sources: KnowledgeSource[]
  onChange: (sources: KnowledgeSource[]) => void
  organizationRole?: string
  userId?: string
  platformAdmin?: boolean
}

export type KnowledgeViewHandle = {
  openAddUrl: () => void
  openFilePicker: () => void
}

export const KnowledgeView = forwardRef<KnowledgeViewHandle, Props>(
  function KnowledgeView(
    { sources, onChange, organizationRole, userId, platformAdmin = false },
    ref
  ) {
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
    const [removeTarget, setRemoveTarget] = useState<KnowledgeSource | null>(
      null
    )
    const [busyId, setBusyId] = useState("")
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<SourceFilter>("all")
    const [page, setPage] = useState(1)

    const filteredSources = useMemo(() => {
      const query = searchQuery.trim().toLowerCase()
      return sources.filter((source) => {
        const sourceParts = getSourceParts(source)
        const matchesQuery =
          !query ||
          [source.title, source.sourceUrl, source.mimeType, sourceParts.group]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(query))
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "in-progress"
            ? source.status === "queued" || source.status === "processing"
            : source.status === statusFilter)
        return matchesQuery && matchesStatus
      })
    }, [searchQuery, sources, statusFilter])

    const pageCount = Math.max(
      1,
      Math.ceil(filteredSources.length / SOURCE_PAGE_SIZE)
    )
    const currentPage = Math.min(page, pageCount)
    const visibleSources = filteredSources.slice(
      (currentPage - 1) * SOURCE_PAGE_SIZE,
      currentPage * SOURCE_PAGE_SIZE
    )
    const rangeStart = filteredSources.length
      ? (currentPage - 1) * SOURCE_PAGE_SIZE + 1
      : 0
    const rangeEnd = Math.min(
      currentPage * SOURCE_PAGE_SIZE,
      filteredSources.length
    )

    useImperativeHandle(
      ref,
      () => ({
        openAddUrl: () => setDialogOpen(true),
        openFilePicker: () => {
          if (!uploading) fileInputRef.current?.click()
        },
      }),
      [uploading]
    )

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
        canManageOrganization || scopeType !== "organization"
          ? scopeType
          : "user"
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

        {notice && (
          <Alert>
            <Search aria-hidden="true" />
            <AlertTitle>Knowledge pipeline</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 md:grid-cols-3">
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
          <Metric
            label="Scope"
            value="Private"
            detail="org + personal access"
          />
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
          <Card className="overflow-hidden">
            <CardHeader className="gap-4 border-b bg-muted/10">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <CardTitle className="text-base">Sources</CardTitle>
                  <CardDescription className="mt-1">
                    Search and manage the files available for retrieval. Ready
                    sources are indexed automatically.
                  </CardDescription>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground">
                  {sources.length} total
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative min-w-0 flex-1">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value)
                      setPage(1)
                    }}
                    placeholder="Search files or paths"
                    aria-label="Search knowledge sources"
                    className="h-8 pl-8"
                  />
                </div>
                <Select
                  value={statusFilter}
                  onValueChange={(value) => {
                    setStatusFilter((value as SourceFilter) || "all")
                    setPage(1)
                  }}
                >
                  <SelectTrigger className="h-8 w-full sm:w-40">
                    <SelectValue>
                      {statusFilter === "all"
                        ? "All statuses"
                        : statusFilter === "in-progress"
                          ? "In progress"
                          : statusFilter === "ready"
                            ? "Ready"
                            : "Failed"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="ready">Ready</SelectItem>
                    <SelectItem value="in-progress">In progress</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {filteredSources.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
                  <Search
                    className="size-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium">No sources found</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Try a different file name, path, or status filter.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("")
                      setStatusFilter("all")
                      setPage(1)
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              ) : (
                <>
                  <div className="hidden grid-cols-[minmax(0,1fr)_8rem_5rem] gap-3 border-b bg-muted/20 px-4 py-2 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase sm:grid sm:px-5">
                    <span>Source</span>
                    <span>Status</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <div className="divide-y">
                    {visibleSources.map((source) => {
                      const manageable = canManageSource(source)
                      const statusStyle = sourceStatusStyles[source.status]
                      const sourceParts = getSourceParts(source)
                      const showStage = Boolean(
                        source.stage && source.stage !== source.status
                      )
                      const isPending =
                        source.status === "processing" ||
                        source.status === "queued"

                      return (
                        <div
                          key={source.id}
                          className="group grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/20 sm:grid-cols-[minmax(0,1fr)_8rem_5rem] sm:items-center sm:px-5"
                        >
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
                              {source.sourceType === "url" ? (
                                <Globe2 aria-hidden="true" />
                              ) : (
                                <FileText aria-hidden="true" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p
                                className="truncate text-sm font-medium"
                                title={sourceParts.path}
                              >
                                {sourceParts.path}
                              </p>
                              <p
                                className="mt-0.5 truncate text-xs text-muted-foreground"
                                title={sourceParts.group}
                              >
                                {sourceParts.group}
                                <span className="px-1.5 text-border">·</span>
                                {source.sourceType === "url"
                                  ? "URL"
                                  : source.mimeType || "Text source"}
                              </p>
                              {isPending && (
                                <Progress
                                  value={Math.max(
                                    0,
                                    Math.min(100, source.progress ?? 0)
                                  )}
                                  className="mt-2 h-1 max-w-xs"
                                />
                              )}
                              {showStage && (
                                <p className="mt-1.5 text-[11px] text-muted-foreground">
                                  {formatStage(source.stage ?? "")}
                                </p>
                              )}
                              {source.error && (
                                <p className="mt-1.5 text-[11px] text-destructive">
                                  {source.error}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-end sm:justify-start">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 text-xs",
                                statusStyle.text
                              )}
                            >
                              <span
                                className={cn(
                                  "size-1.5 rounded-full",
                                  statusStyle.dot
                                )}
                                aria-hidden="true"
                              />
                              {statusStyle.label}
                            </span>
                          </div>

                          <div className="col-span-2 flex justify-end gap-1 opacity-100 transition-opacity sm:col-span-1 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                            {manageable && (
                              <>
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
                                  onClick={() => setRemoveTarget(source)}
                                  aria-label={`Remove ${source.title}`}
                                >
                                  <Trash2 aria-hidden="true" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <p className="text-xs text-muted-foreground">
                      Showing {rangeStart}–{rangeEnd} of{" "}
                      {filteredSources.length} sources
                    </p>
                    {pageCount > 1 && (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={currentPage === 1}
                          onClick={() => setPage(currentPage - 1)}
                          aria-label="Previous page"
                        >
                          <ChevronLeft aria-hidden="true" />
                        </Button>
                        <span className="min-w-16 text-center text-xs text-muted-foreground">
                          Page {currentPage} of {pageCount}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={currentPage === pageCount}
                          onClick={() => setPage(currentPage + 1)}
                          aria-label="Next page"
                        >
                          <ChevronRight aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              )}
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
                  <FieldLabel htmlFor="knowledge-title">
                    Source title
                  </FieldLabel>
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
                        value ??
                          (canManageOrganization ? "organization" : "user")
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {canManageOrganization && (
                        <SelectItem value="organization">
                          Organization
                        </SelectItem>
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

        <AlertDialog
          open={removeTarget !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !busyId) setRemoveTarget(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove knowledge source?</AlertDialogTitle>
              <AlertDialogDescription>
                Remove “{removeTarget?.title}” from Knowledge? Existing messages
                keep their stored citations, but this source will no longer be
                available for new retrievals.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={Boolean(busyId)}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={!removeTarget || Boolean(busyId)}
                variant="destructive"
                onClick={() => {
                  const target = removeTarget
                  setRemoveTarget(null)
                  if (target) void remove(target)
                }}
              >
                Remove source
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }
)

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
    <Card size="sm" className="gap-0">
      <CardContent className="py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-heading mt-2 text-2xl font-semibold tracking-tight">
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
