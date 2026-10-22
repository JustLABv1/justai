"use client"

import { downloadFile } from "@/lib/download-file"
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useSearchParams } from "next/navigation"
import {
  Brain,
  Check,
  File,
  FileArchive,
  FileAudio2,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  Folder,
  FolderKanban,
  FolderPlus,
  Globe2,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
  UploadCloud,
  X,
  type LucideIcon,
} from "lucide-react"

import { APIError, api } from "@/lib/api"
import type {
  KnowledgeItem,
  KnowledgeItemDetail,
  KnowledgeItemType,
  KnowledgeSource,
  KnowledgeSpace,
  Memory,
  Note,
  TranscriptionSession,
  WorkspaceProject,
} from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
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
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { FilterBar } from "@/components/ui/filter-bar"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import { cn } from "@/lib/utils"

type KnowledgeWorkspaceProps = {
  sources: KnowledgeSource[]
  notes: Note[]
  projects: WorkspaceProject[]
  transcriptionSessions: TranscriptionSession[]
  onSourcesChange: (sources: KnowledgeSource[]) => void
  onNotesChange: (notes: Note[]) => void
  onProjectsChange: (projects: WorkspaceProject[]) => void
  onNavigate: (view: "chat", conversationId?: string | null) => void
}

type ItemFilter = "all" | KnowledgeItemType

type KnowledgeItemsResponse = {
  items: KnowledgeItem[]
  nextCursor?: string
  totalCount?: number
}

const KNOWLEDGE_PAGE_SIZE = 50

type KnowledgeSpaceTreeItem = KnowledgeSpace & { depth: number }

function flattenKnowledgeSpaces(spaces: KnowledgeSpace[]) {
  const children = new Map<string | null, KnowledgeSpace[]>()
  for (const space of spaces) {
    const parentId =
      space.parentId &&
      spaces.some((candidate) => candidate.id === space.parentId)
        ? space.parentId
        : null
    children.set(parentId, [...(children.get(parentId) ?? []), space])
  }
  for (const values of children.values()) {
    values.sort((left, right) => left.name.localeCompare(right.name))
  }
  const result: KnowledgeSpaceTreeItem[] = []
  const visit = (parentId: string | null, depth: number) => {
    for (const space of children.get(parentId) ?? []) {
      result.push({ ...space, depth })
      visit(space.id, depth + 1)
    }
  }
  visit(null, 0)
  return result
}

function descendantKnowledgeSpaceIds(spaces: KnowledgeSpace[], rootId: string) {
  const result = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const space of spaces) {
      if (
        space.parentId &&
        result.has(space.parentId) &&
        !result.has(space.id)
      ) {
        result.add(space.id)
        changed = true
      }
    }
  }
  return result
}

const typeLabels: Record<string, string> = {
  source: "File or URL",
  note: "Note",
  memory: "Memory",
  transcript: "Transcript",
}

function itemIcon(item: KnowledgeItem, source?: KnowledgeSource | null) {
  if (item.resourceType === "memory") return Brain
  if (item.resourceType === "note") return NotebookPen
  if (item.resourceType === "transcript") return FileText
  if (source?.sourceType === "url") return Globe2

  const extension = item.title.split(".").pop()?.toLocaleLowerCase() ?? ""
  const mimeType = source?.mimeType?.toLocaleLowerCase() ?? ""
  if (
    ["csv", "xls", "xlsx", "ods"].includes(extension) ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("csv")
  )
    return FileSpreadsheet
  if (extension === "json" || mimeType.includes("json")) return FileJson
  if (
    ["html", "htm", "xml", "yaml", "yml", "js", "ts", "tsx", "jsx"].includes(
      extension
    )
  )
    return FileCode2
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(extension) ||
    mimeType.startsWith("image/")
  )
    return FileImage
  if (
    ["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(extension) ||
    mimeType.startsWith("audio/")
  )
    return FileAudio2
  if (
    ["mp4", "mov", "webm", "mkv", "avi"].includes(extension) ||
    mimeType.startsWith("video/")
  )
    return FileVideo2
  if (["zip", "tar", "gz", "rar", "7z"].includes(extension)) return FileArchive
  if (
    ["pdf", "txt", "md", "markdown", "doc", "docx", "rtf"].includes(
      extension
    ) ||
    mimeType.startsWith("text/") ||
    mimeType.includes("pdf")
  )
    return FileText
  return File
}

function itemTypeForSource(source: KnowledgeSource): KnowledgeItemType {
  void source
  return "source"
}

function canDeleteKnowledgeItem(item: KnowledgeItem) {
  return ["source", "note", "memory", "transcript"].includes(item.resourceType)
}

function knowledgeItemDeleteEndpoint(item: KnowledgeItem) {
  return item.resourceType === "source"
    ? `/api/v1/knowledge/sources/${item.resourceId}`
    : item.resourceType === "note"
      ? `/api/v1/notes/${item.resourceId}`
      : item.resourceType === "memory"
        ? `/api/v1/memories/${item.resourceId}`
        : `/api/v1/transcription/sessions/${item.resourceId}`
}

function itemStatusLabel(status: string) {
  if (status === "ready") return "Ready"
  if (status === "processing") return "Indexing"
  if (status === "queued") return "Queued"
  if (status === "failed") return "Needs attention"
  if (status === "disabled") return "Disabled"
  if (status === "completed") return "Completed"
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function deleteDialogTitle(item: KnowledgeItem | null) {
  const type = item ? (typeLabels[item.resourceType] ?? "item") : "item"
  return "Delete " + type.toLocaleLowerCase() + "?"
}

function deleteDialogDescription(item: KnowledgeItem | null) {
  return item
    ? "“" +
        item.title +
        "” will be permanently removed from Knowledge. This action cannot be undone."
    : "This action cannot be undone."
}

function AddKnowledgeOption({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: LucideIcon
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <Button
      className="h-auto min-h-20 w-full items-start justify-start gap-3 rounded-xl border-border/80 p-4 text-left whitespace-normal transition-colors hover:bg-muted/50"
      onClick={onClick}
      variant="outline"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4">
        <Icon aria-hidden="true" />
      </span>
      <span className="min-w-0 whitespace-normal">
        <span className="block text-sm leading-5 font-medium">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </Button>
  )
}

function localItems(
  sources: KnowledgeSource[],
  notes: Note[],
  sessions: TranscriptionSession[],
  memories: Memory[] = []
): KnowledgeItem[] {
  return [
    ...sources
      .filter((source) => source.sourceType !== "repository")
      .map((source) => ({
        id: `source:${source.id}`,
        resourceType: itemTypeForSource(source),
        resourceId: source.id,
        title: source.title,
        visibility:
          source.scopeType === "organization" ? "workspace" : "private",
        status: source.status,
        spaceIds: [],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })),
    ...notes.map((note) => ({
      id: `note:${note.id}`,
      resourceType: "note" as const,
      resourceId: note.id,
      title: note.title || "Untitled note",
      visibility: note.visibility || "private",
      status: "ready",
      spaceIds: [],
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })),
    ...sessions.map((session) => ({
      id: `transcript:${session.id}`,
      resourceType: "transcript" as const,
      resourceId: session.id,
      title: session.title,
      visibility: "private",
      status: session.status,
      spaceIds: [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })),
    ...memories.map((memory) => ({
      id: `memory:${memory.id}`,
      resourceType: "memory" as const,
      resourceId: memory.id,
      title: memory.content.slice(0, 160),
      visibility: "private",
      status: memory.enabled ? "ready" : "disabled",
      spaceIds: [],
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    })),
  ]
}

export function KnowledgeWorkspace({
  sources,
  notes,
  projects,
  transcriptionSessions,
  onSourcesChange,
  onNotesChange,
  onProjectsChange,
  onNavigate,
}: KnowledgeWorkspaceProps) {
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const searchParams = useSearchParams()
  // `source` was the query key used by the former settings-only Knowledge
  // page. Keep accepting it while every new link uses the catalog-neutral
  // `item` key, so deep links remain useful during the migration.
  const requestedItemId = searchParams.get("item") ?? searchParams.get("source")
  const requestedType = searchParams.get("type")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [query, setQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<ItemFilter>(() =>
    requestedType && requestedType in typeLabels
      ? (requestedType as ItemFilter)
      : "all"
  )
  const [statusFilter, setStatusFilter] = useState("all")
  const [ownershipFilter, setOwnershipFilter] = useState("all")
  const [sortBy, setSortBy] = useState<"updated" | "title" | "type">("updated")
  const [spaceId, setSpaceId] = useState("all")
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [selected, setSelected] = useState<KnowledgeItem | null>(null)
  const [selectedDetail, setSelectedDetail] =
    useState<KnowledgeItemDetail | null>(null)
  const [selectedDetailLoading, setSelectedDetailLoading] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [spaceOpen, setSpaceOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [spaceName, setSpaceName] = useState("")
  const [spaceDescription, setSpaceDescription] = useState("")
  const [spaceVisibility, setSpaceVisibility] = useState<
    "private" | "workspace"
  >("private")
  const [spaceParentId, setSpaceParentId] = useState("root")
  const [noteTitle, setNoteTitle] = useState("")
  const [noteContent, setNoteContent] = useState("")
  const [memoryContent, setMemoryContent] = useState("")
  const [memoryDraft, setMemoryDraft] = useState("")
  const [transcriptSessionId, setTranscriptSessionId] = useState("")
  const [transcriptSpaceId, setTranscriptSpaceId] = useState("none")
  const [url, setUrl] = useState("")
  const [urlTitle, setUrlTitle] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null)
  const [folderDeleteTarget, setFolderDeleteTarget] =
    useState<KnowledgeSpace | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recentUploadIds, setRecentUploadIds] = useState<Set<string>>(new Set())
  const [sourceProgressById, setSourceProgressById] = useState<
    Record<string, KnowledgeSource>
  >({})
  const [nextCursor, setNextCursor] = useState("")
  const [totalCount, setTotalCount] = useState<number>()
  const [loadingMore, setLoadingMore] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const liveSources = useMemo(
    () => sources.map((source) => sourceProgressById[source.id] ?? source),
    [sourceProgressById, sources]
  )
  const pendingSourceKey = liveSources
    .filter(
      (source) => source.status === "queued" || source.status === "processing"
    )
    .map((source) => source.id)
    .sort()
    .join(",")

  const openInspector = useCallback((item: KnowledgeItem) => {
    setSelected(item)
    setInspectorOpen(true)
  }, [])

  const closeInspector = useCallback(() => {
    setInspectorOpen(false)
    setSelected(null)
    setSelectedDetail(null)
  }, [])

  const buildKnowledgeItemsPath = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({
        limit: String(KNOWLEDGE_PAGE_SIZE),
        sort: sortBy,
      })
      if (cursor) params.set("cursor", cursor)
      if (query.trim()) params.set("q", query.trim())
      if (typeFilter !== "all") params.set("type", typeFilter)
      if (statusFilter !== "all") params.set("status", statusFilter)
      if (ownershipFilter !== "all") params.set("ownership", ownershipFilter)
      if (spaceId !== "all") params.set("spaceId", spaceId)
      return `/api/v1/knowledge/items?${params.toString()}`
    },
    [ownershipFilter, query, sortBy, spaceId, statusFilter, typeFilter]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setNextCursor("")
    try {
      const [itemResult, spaceResult, memoryResult] = await Promise.allSettled([
        api.get<KnowledgeItemsResponse>(buildKnowledgeItemsPath()),
        api.get<{ spaces: KnowledgeSpace[] }>("/api/v1/knowledge/spaces"),
        api.get<{ memories: Memory[] }>("/api/v1/memories"),
      ])
      const fallback = localItems(
        sources,
        notes,
        transcriptionSessions,
        memoryResult.status === "fulfilled" ? memoryResult.value.memories : []
      )
      const failures = [
        itemResult.status === "rejected" ? "items" : null,
        spaceResult.status === "rejected" ? "folders" : null,
        memoryResult.status === "rejected" ? "memories" : null,
      ].filter(Boolean) as string[]
      const nextItems =
        itemResult.status === "fulfilled" ? itemResult.value.items : fallback
      const nextSpaces =
        spaceResult.status === "fulfilled"
          ? spaceResult.value.spaces
          : projects.map((project) => ({
              id: project.id,
              name: project.name,
              description: project.description,
              visibility: project.visibility,
              canManage: project.canManage ?? true,
              itemCount: 0,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            }))
      setItems(nextItems)
      setSpaces(nextSpaces)
      setTotalCount(
        itemResult.status === "fulfilled"
          ? (itemResult.value.totalCount ?? nextItems.length)
          : nextItems.length
      )
      setNextCursor(
        itemResult.status === "fulfilled"
          ? (itemResult.value.nextCursor ?? "")
          : ""
      )
      if (requestedItemId) {
        const target = nextItems.find(
          (item) =>
            item.id === requestedItemId || item.resourceId === requestedItemId
        )
        if (target) openInspector(target)
      }
      if (memoryResult.status === "fulfilled") {
        setMemories(memoryResult.value.memories)
      }
      if (failures.length) {
        const message = `Some Knowledge data could not be loaded (${failures.join(", ")}). Showing the latest available data.`
        setLoadError(message)
        setError(message)
      } else {
        setLoadError("")
        setError("")
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Knowledge could not be loaded."
      )
      const fallback = localItems(sources, notes, transcriptionSessions)
      setItems(fallback)
      setTotalCount(fallback.length)
      setNextCursor("")
    } finally {
      setLoading(false)
    }
  }, [
    buildKnowledgeItemsPath,
    notes,
    openInspector,
    projects,
    requestedItemId,
    sources,
    transcriptionSessions,
  ])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await api.get<KnowledgeItemsResponse>(
        buildKnowledgeItemsPath(nextCursor)
      )
      setItems((current) => {
        const existing = new Set(current.map((item) => item.id))
        return [
          ...current,
          ...result.items.filter((item) => !existing.has(item.id)),
        ]
      })
      setNextCursor(result.nextCursor ?? "")
      if (result.totalCount !== undefined) setTotalCount(result.totalCount)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "More Knowledge items could not be loaded."
      )
    } finally {
      setLoadingMore(false)
    }
  }, [buildKnowledgeItemsPath, loadingMore, nextCursor])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (!pendingSourceKey) return

    let cancelled = false
    const refreshSourceProgress = async () => {
      try {
        const result = await api.get<{ sources: KnowledgeSource[] }>(
          "/api/v1/knowledge/sources?limit=100"
        )
        if (cancelled) return
        const refreshedById = new Map(
          result.sources.map((source) => [source.id, source])
        )
        setSourceProgressById((current) => {
          const next = { ...current }
          for (const [id, source] of refreshedById) next[id] = source
          return next
        })
        setItems((current) =>
          current.map((item) => {
            if (item.resourceType !== "source") return item
            const source = refreshedById.get(item.resourceId)
            return source
              ? { ...item, status: source.status, updatedAt: source.updatedAt }
              : item
          })
        )

        if (recentUploadIds.size > 0) {
          const uploaded = result.sources.filter((source) =>
            recentUploadIds.has(source.id)
          )
          if (
            uploaded.length === recentUploadIds.size &&
            uploaded.every(
              (source) =>
                source.status === "ready" || source.status === "failed"
            )
          ) {
            const ready = uploaded.filter(
              (source) => source.status === "ready"
            ).length
            const failed = uploaded.length - ready
            setNotice(
              `${ready} uploaded file${ready === 1 ? " is" : "s are"} indexed and ready${failed ? `; ${failed} failed during indexing` : ""}.`
            )
            setRecentUploadIds(new Set())
          }
        }
      } catch {
        // Keep the last known state; the next poll can recover automatically.
      }
    }

    void refreshSourceProgress()
    const interval = window.setInterval(
      () => void refreshSourceProgress(),
      1500
    )
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [pendingSourceKey, recentUploadIds])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTypeFilter(
        requestedType && requestedType in typeLabels
          ? (requestedType as ItemFilter)
          : "all"
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [requestedType])

  useEffect(() => {
    if (!requestedItemId) {
      const timer = window.setTimeout(closeInspector, 0)
      return () => window.clearTimeout(timer)
    }
  }, [closeInspector, requestedItemId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selected) {
        setSelectedDetail(null)
        setSelectedDetailLoading(false)
        return
      }
      setSelectedDetailLoading(true)
      void api
        .get<{ item: KnowledgeItemDetail }>(
          `/api/v1/knowledge/items/${selected.id}`
        )
        .then((result) => setSelectedDetail(result.item))
        .catch(() => setSelectedDetail(null))
        .finally(() => setSelectedDetailLoading(false))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [selected])

  const spaceTree = useMemo(() => flattenKnowledgeSpaces(spaces), [spaces])
  const selectedFolderIds = useMemo(
    () =>
      spaceId !== "all" && spaceId !== "personal"
        ? descendantKnowledgeSpaceIds(spaces, spaceId)
        : new Set<string>(),
    [spaceId, spaces]
  )

  const selectedSpace =
    spaceId !== "all" ? spaces.find((space) => space.id === spaceId) : null
  const childSpaces = useMemo(
    () =>
      spaces
        .filter(
          (space) => (space.parentId ?? null) === (selectedSpace?.id ?? null)
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [selectedSpace?.id, spaces]
  )
  const folderPath = useMemo(() => {
    if (!selectedSpace) return []
    const byId = new Map(spaces.map((space) => [space.id, space]))
    const path: KnowledgeSpace[] = []
    const seen = new Set<string>()
    let current: KnowledgeSpace | undefined = selectedSpace
    while (current && !seen.has(current.id)) {
      path.unshift(current)
      seen.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return path
  }, [selectedSpace, spaces])

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const filtered = items.filter((item) => {
      const matchesType =
        typeFilter === "all" || item.resourceType === typeFilter
      const matchesStatus =
        statusFilter === "all" || item.status === statusFilter
      const matchesOwnership =
        ownershipFilter === "all" || item.visibility === ownershipFilter
      const matchesSpace = normalized
        ? spaceId === "all" ||
          item.spaceIds?.some((id) => selectedFolderIds.has(id))
        : selectedSpace
          ? item.spaceIds?.includes(selectedSpace.id)
          : !item.spaceIds?.length
      const matchesQuery =
        !normalized ||
        `${item.title} ${item.resourceType}`
          .toLocaleLowerCase()
          .includes(normalized)
      return (
        matchesType &&
        matchesStatus &&
        matchesOwnership &&
        matchesSpace &&
        matchesQuery
      )
    })
    return [...filtered].sort((left, right) => {
      if (sortBy === "title") return left.title.localeCompare(right.title)
      if (sortBy === "type")
        return (
          left.resourceType.localeCompare(right.resourceType) ||
          left.title.localeCompare(right.title)
        )
      return right.updatedAt.localeCompare(left.updatedAt)
    })
  }, [
    items,
    ownershipFilter,
    query,
    selectedFolderIds,
    selectedSpace,
    sortBy,
    spaceId,
    statusFilter,
    typeFilter,
  ])

  const selectedMemory =
    selected?.resourceType === "memory"
      ? (memories.find((memory) => memory.id === selected.resourceId) ?? null)
      : null
  const selectedNote =
    selected?.resourceType === "note"
      ? (notes.find((note) => note.id === selected.resourceId) ?? null)
      : null
  const selectedSource =
    selected?.resourceType === "source"
      ? (liveSources.find((source) => source.id === selected.resourceId) ??
        null)
      : null
  const selectedSpaceItems = selectedSpace
    ? items.filter((item) =>
        item.spaceIds?.some((id) => selectedFolderIds.has(id))
      )
    : []
  const selectedSpaceProblems = selectedSpaceItems.filter(
    (item) => item.status === "failed"
  ).length

  const displayedItemCount = visibleItems.length + childSpaces.length
  const libraryItemCount = totalCount ?? displayedItemCount

  useEffect(() => {
    const timer = window.setTimeout(
      () => setMemoryDraft(selectedMemory?.content ?? ""),
      0
    )
    return () => window.clearTimeout(timer)
  }, [selectedMemory?.content])

  async function uploadFiles(files: File[]) {
    if (!files.length || busy) return
    const acceptedExtensions = new Set([
      "pdf",
      "csv",
      "md",
      "markdown",
      "txt",
      "html",
      "htm",
      "json",
      "xml",
      "yaml",
      "yml",
      "rtf",
      "eml",
      "msg",
      "docx",
      "docm",
      "xlsx",
      "xlsm",
      "pptx",
      "pptm",
      "odt",
      "ods",
      "odp",
      "epub",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "svg",
      "heic",
    ])
    const rejected = files.filter((file) => {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? ""
      return (
        !acceptedExtensions.has(extension) && !file.type.startsWith("text/")
      )
    })
    if (rejected.length) {
      setError(`Unsupported: ${rejected.map((file) => file.name).join(", ")}.`)
      return
    }
    const oversized = files.filter((file) => file.size > 25 * 1024 * 1024)
    if (oversized.length) {
      setError(
        `Files are limited to 25 MB: ${oversized.map((file) => file.name).join(", ")}.`
      )
      return
    }
    setBusy(true)
    setNotice("")
    setError("")
    try {
      const results = await Promise.allSettled(
        files.map((file) => {
          const form = new FormData()
          form.append("file", file)
          form.append("title", file.name)
          form.append(
            "scopeType",
            selectedSpace?.visibility === "workspace" ? "organization" : "user"
          )
          if (selectedSpace) form.append("spaceId", selectedSpace.id)
          return api.upload<KnowledgeSource>("/api/v1/knowledge/sources", form)
        })
      )
      const uploaded = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      )
      const failed = results.length - uploaded.length
      if (uploaded.length) {
        const nextSources = [...uploaded.reverse(), ...sources]
        onSourcesChange(nextSources)
        setSourceProgressById((current) => {
          const next = { ...current }
          for (const source of uploaded) next[source.id] = source
          return next
        })
        setRecentUploadIds(new Set(uploaded.map((source) => source.id)))
      }
      setNotice(
        `Upload complete: ${uploaded.length} of ${files.length} files received and queued for indexing${failed ? `; ${failed} failed to upload` : ""}.`
      )
      if (failed)
        setError(
          results
            .flatMap((result) =>
              result.status === "rejected"
                ? [
                    result.reason instanceof Error
                      ? result.reason.message
                      : "Upload failed",
                  ]
                : []
            )
            .join(" · ")
        )
      await load()
      if (!failed) setAddOpen(false)
    } catch (caught) {
      setError(
        caught instanceof APIError
          ? caught.message
          : "The files could not be uploaded."
      )
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function addUrl(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      const result = await api.post<KnowledgeSource>(
        "/api/v1/knowledge/sources",
        {
          title: urlTitle.trim() || url.trim(),
          sourceType: "url",
          sourceUrl: url.trim(),
          scopeType: "user",
        }
      )
      onSourcesChange([result, ...sources])
      setUrl("")
      setUrlTitle("")
      setUrlOpen(false)
      setNotice("URL queued for indexing.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The URL could not be indexed."
      )
    } finally {
      setBusy(false)
    }
  }

  async function createSpace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!spaceName.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      const result = await api.post<{ space: KnowledgeSpace }>(
        "/api/v1/knowledge/spaces",
        {
          name: spaceName.trim(),
          description: spaceDescription.trim(),
          visibility: spaceVisibility,
          parentId: spaceParentId === "root" ? undefined : spaceParentId,
        }
      )
      setSpaces((current) => [result.space, ...current])
      onProjectsChange([
        {
          ...result.space,
          ownerId: undefined,
          canManage: true,
        } as WorkspaceProject,
        ...projects,
      ])
      setSpaceName("")
      setSpaceDescription("")
      setSpaceVisibility("private")
      setSpaceParentId("root")
      setSpaceOpen(false)
      setSpaceId(result.space.id)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The space could not be created."
      )
    } finally {
      setBusy(false)
    }
  }

  async function createNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if ((!noteTitle.trim() && !noteContent.trim()) || busy) return
    setBusy(true)
    setError("")
    try {
      const result = await api.post<{ note: Note }>("/api/v1/notes", {
        title: noteTitle.trim() || "Untitled note",
        content: noteContent,
      })
      onNotesChange([result.note, ...notes])
      setNoteTitle("")
      setNoteContent("")
      setNoteOpen(false)
      setNotice("Note added to Knowledge.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The note could not be created."
      )
    } finally {
      setBusy(false)
    }
  }

  async function createMemory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!memoryContent.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      const result = await api.post<{ memory: Memory }>("/api/v1/memories", {
        content: memoryContent.trim(),
        source: "manual",
      })
      setMemories((current) => [result.memory, ...current])
      setMemoryContent("")
      setMemoryOpen(false)
      setNotice("Memory saved and available across chats.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The memory could not be saved."
      )
    } finally {
      setBusy(false)
    }
  }

  async function importTranscript(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!transcriptSessionId || busy) return
    setBusy(true)
    setError("")
    try {
      let item = items.find(
        (candidate) =>
          candidate.resourceType === "transcript" &&
          candidate.resourceId === transcriptSessionId
      )
      if (!item) {
        const result = await api.get<{ items: KnowledgeItem[] }>(
          `/api/v1/knowledge/items?type=transcript&limit=${KNOWLEDGE_PAGE_SIZE}`
        )
        item = result.items.find(
          (candidate) => candidate.resourceId === transcriptSessionId
        )
        if (item)
          setItems((current) => [
            item as KnowledgeItem,
            ...current.filter((candidate) => candidate.id !== item?.id),
          ])
      }
      if (!item) throw new Error("That transcript is not available yet.")
      if (transcriptSpaceId !== "none") {
        await api.post(
          `/api/v1/knowledge/space-items/${transcriptSpaceId}/${item.id}`
        )
        item = {
          ...item,
          spaceIds: Array.from(
            new Set([...(item.spaceIds ?? []), transcriptSpaceId])
          ),
        }
      }
      openInspector(item)
      setTranscriptSessionId("")
      setTranscriptSpaceId("none")
      setTranscriptOpen(false)
      setNotice("Transcript added to Knowledge.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The transcript could not be imported."
      )
    } finally {
      setBusy(false)
    }
  }

  async function updateSelectedNote() {
    if (!selectedNote || busy) return
    setBusy(true)
    try {
      const result = await api.patch<{ note: Note }>(
        `/api/v1/notes/${selectedNote.id}`,
        {
          title: selectedNote.title,
          content: selectedNote.content,
          visibility: selectedNote.visibility,
        }
      )
      onNotesChange(
        notes.map((note) => (note.id === result.note.id ? result.note : note))
      )
      setNotice("Note updated.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The note could not be updated."
      )
    } finally {
      setBusy(false)
    }
  }

  async function reindexSelectedSource() {
    if (!selectedSource || busy) return
    setBusy(true)
    try {
      await api.post(`/api/v1/knowledge/sources/${selectedSource.id}/reindex`)
      onSourcesChange(
        sources.map((source) =>
          source.id === selectedSource.id
            ? { ...source, status: "queued" }
            : source
        )
      )
      setNotice("Reindexing started.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The source could not be reindexed."
      )
    } finally {
      setBusy(false)
    }
  }

  async function toggleSelectedMemory(enabled: boolean) {
    if (!selectedMemory || busy) return
    setBusy(true)
    try {
      const result = await api.patch<{ memory: Memory }>(
        `/api/v1/memories/${selectedMemory.id}`,
        { enabled }
      )
      setMemories((current) =>
        current.map((memory) =>
          memory.id === result.memory.id ? result.memory : memory
        )
      )
      setItems((current) =>
        current.map((item) =>
          item.resourceId === result.memory.id
            ? { ...item, status: enabled ? "ready" : "disabled" }
            : item
        )
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The memory could not be updated."
      )
    } finally {
      setBusy(false)
    }
  }

  async function updateSelectedMemory() {
    if (!selectedMemory || !memoryDraft.trim() || busy) return
    setBusy(true)
    try {
      const result = await api.patch<{ memory: Memory }>(
        `/api/v1/memories/${selectedMemory.id}`,
        { content: memoryDraft.trim() }
      )
      setMemories((current) =>
        current.map((memory) =>
          memory.id === result.memory.id ? result.memory : memory
        )
      )
      setItems((current) =>
        current.map((item) =>
          item.resourceId === result.memory.id
            ? {
                ...item,
                title: result.memory.content.slice(0, 160),
                updatedAt: result.memory.updatedAt,
              }
            : item
        )
      )
      setSelected((current) =>
        current && current.resourceId === result.memory.id
          ? {
              ...current,
              title: result.memory.content.slice(0, 160),
              updatedAt: result.memory.updatedAt,
            }
          : current
      )
      setNotice("Memory updated.")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The memory could not be updated."
      )
    } finally {
      setBusy(false)
    }
  }

  async function assignSelectedSpace(nextSpaceId: string) {
    if (!selected || !nextSpaceId || nextSpaceId === "none" || busy) return
    setBusy(true)
    try {
      await api.post(
        `/api/v1/knowledge/space-items/${nextSpaceId}/${selected.id}`
      )
      setItems((current) =>
        current.map((item) =>
          item.id === selected.id
            ? {
                ...item,
                spaceIds: Array.from(
                  new Set([...(item.spaceIds ?? []), nextSpaceId])
                ),
              }
            : item
        )
      )
      setSpaces((current) =>
        current.map((space) =>
          space.id === nextSpaceId
            ? { ...space, itemCount: space.itemCount + 1 }
            : space
        )
      )
      setSelected((current) =>
        current && current.id === selected.id
          ? {
              ...current,
              spaceIds: Array.from(
                new Set([...(current.spaceIds ?? []), nextSpaceId])
              ),
            }
          : current
      )
      setNotice("Item added to the space.")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The item could not be assigned to that space."
      )
    } finally {
      setBusy(false)
    }
  }

  async function removeSelectedSpace(removeSpaceId: string) {
    if (!selected || busy) return
    setBusy(true)
    try {
      await api.delete(
        `/api/v1/knowledge/space-items/${removeSpaceId}/${selected.id}`
      )
      setItems((current) =>
        current.map((item) =>
          item.id === selected.id
            ? {
                ...item,
                spaceIds: (item.spaceIds ?? []).filter(
                  (id) => id !== removeSpaceId
                ),
              }
            : item
        )
      )
      setSpaces((current) =>
        current.map((space) =>
          space.id === removeSpaceId
            ? { ...space, itemCount: Math.max(0, space.itemCount - 1) }
            : space
        )
      )
      setSelected((current) =>
        current && current.id === selected.id
          ? {
              ...current,
              spaceIds: (current.spaceIds ?? []).filter(
                (id) => id !== removeSpaceId
              ),
            }
          : current
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The item could not be removed from that space."
      )
    } finally {
      setBusy(false)
    }
  }

  async function deleteKnowledgeItem(item: KnowledgeItem) {
    if (!canDeleteKnowledgeItem(item) || deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.delete(knowledgeItemDeleteEndpoint(item))
      setItems((current) =>
        current.filter((candidate) => candidate.id !== item.id)
      )
      if (item.resourceType === "source") {
        onSourcesChange(
          sources.filter((source) => source.id !== item.resourceId)
        )
      }
      if (item.resourceType === "note") {
        onNotesChange(notes.filter((note) => note.id !== item.resourceId))
      }
      if (item.resourceType === "memory") {
        setMemories((current) =>
          current.filter((memory) => memory.id !== item.resourceId)
        )
      }
      if (selected?.id === item.id) {
        closeInspector()
      }
      setDeleteTarget(null)
      setNotice(`${typeLabels[item.resourceType] ?? "Item"} deleted.`)
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The item could not be deleted."
      )
    } finally {
      setDeleteBusy(false)
    }
  }

  async function deleteSelectedItems() {
    const targets = items.filter(
      (item) => selectedItemIds.has(item.id) && canDeleteKnowledgeItem(item)
    )
    if (!targets.length || deleteBusy) return
    setDeleteBusy(true)
    setError("")
    try {
      const results = await Promise.allSettled(
        targets.map((item) => api.delete(knowledgeItemDeleteEndpoint(item)))
      )
      const deletedIds = new Set(
        targets.flatMap((item, index) =>
          results[index]?.status === "fulfilled" ? [item.id] : []
        )
      )
      const deletedResourceIds = new Set(
        targets
          .filter((item) => deletedIds.has(item.id))
          .map((item) => item.resourceId)
      )
      setItems((current) => current.filter((item) => !deletedIds.has(item.id)))
      onSourcesChange(
        sources.filter((source) => !deletedResourceIds.has(source.id))
      )
      onNotesChange(notes.filter((note) => !deletedResourceIds.has(note.id)))
      setSelectedItemIds(new Set())
      setBulkDeleteOpen(false)
      const failed = targets.length - deletedIds.size
      setNotice(
        `${deletedIds.size} item${deletedIds.size === 1 ? "" : "s"} deleted${failed ? `; ${failed} failed` : ""}.`
      )
      if (failed)
        setError(
          "Some selected items could not be deleted. Reload and try again."
        )
      await load()
    } finally {
      setDeleteBusy(false)
    }
  }

  async function deleteKnowledgeFolder(folder: KnowledgeSpace) {
    if (!folder.canManage || deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.delete<void>(`/api/v1/knowledge/spaces/${folder.id}`)
      setSpaces((current) =>
        current
          .filter((candidate) => candidate.id !== folder.id)
          .map((candidate) =>
            candidate.parentId === folder.id
              ? { ...candidate, parentId: folder.parentId ?? null }
              : candidate
          )
      )
      setItems((current) =>
        current.map((item) => ({
          ...item,
          spaceIds: item.spaceIds?.filter((id) => id !== folder.id),
        }))
      )
      onProjectsChange(
        projects
          .filter((project) => project.id !== folder.id)
          .map((project) =>
            project.parentId === folder.id
              ? { ...project, parentId: folder.parentId ?? null }
              : project
          )
      )
      if (spaceId === folder.id) setSpaceId(folder.parentId ?? "all")
      setFolderDeleteTarget(null)
      setNotice(
        `Folder “${folder.name}” deleted. Its files were kept in My files.`
      )
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The folder could not be deleted."
      )
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <Page className="min-h-0 max-w-[1500px] flex-1 gap-4">
      <input
        aria-label="Upload knowledge file"
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.csv,.md,.markdown,.txt,.html,.htm,.json,.xml,.yaml,.yml,.rtf,.eml,.msg,.docx,.docm,.xlsx,.xlsm,.pptx,.pptm,.odt,.ods,.odp,.epub,image/*,text/*,application/pdf,application/json,message/rfc822,application/vnd.ms-outlook"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) void uploadFiles(files)
        }}
      />
      <PageHeader>
        <PageHeading>
          <PageTitle>Storage</PageTitle>
          <PageDescription>
            Organize files, notes, and transcripts in folders that chats and
            agent workflows can use as live context.
          </PageDescription>
        </PageHeading>
        <PageActions>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" /> Upload file
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSpaceParentId(selectedSpace?.id ?? "root")
              setSpaceOpen(true)
            }}
          >
            <FolderPlus data-icon="inline-start" /> New folder
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus data-icon="inline-start" /> Add knowledge
          </Button>
        </PageActions>
      </PageHeader>

      {(error || notice) && (
        <Alert
          aria-live="polite"
          role={error ? "alert" : "status"}
          variant={error ? "destructive" : "default"}
        >
          {error ? <X /> : <Check />}
          <AlertTitle>
            {error ? "Knowledge action failed" : "Knowledge updated"}
          </AlertTitle>
          <AlertDescription>{error || notice}</AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="min-h-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {`${libraryItemCount} library items`}
            </p>
          </div>
          <div className="min-h-0 flex-1">
            <Card className="min-h-0 overflow-hidden">
              <CardHeader className="gap-3 border-b px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex items-baseline gap-2 text-sm">
                      {selectedSpace ? (
                        <Breadcrumb
                          aria-label="Folder path"
                          className="min-w-0"
                        >
                          <BreadcrumbList className="flex-nowrap">
                            <BreadcrumbItem>
                              <BreadcrumbLink
                                render={
                                  <button
                                    onClick={() => setSpaceId("all")}
                                    type="button"
                                  />
                                }
                              >
                                My files
                              </BreadcrumbLink>
                            </BreadcrumbItem>
                            {folderPath.map((folder, index) => (
                              <Fragment key={folder.id}>
                                <BreadcrumbSeparator />
                                <BreadcrumbItem className="min-w-0">
                                  {index === folderPath.length - 1 ? (
                                    <BreadcrumbPage className="truncate font-medium">
                                      {folder.name}
                                    </BreadcrumbPage>
                                  ) : (
                                    <BreadcrumbLink
                                      className="truncate"
                                      render={
                                        <button
                                          onClick={() => setSpaceId(folder.id)}
                                          type="button"
                                        />
                                      }
                                    >
                                      {folder.name}
                                    </BreadcrumbLink>
                                  )}
                                </BreadcrumbItem>
                              </Fragment>
                            ))}
                          </BreadcrumbList>
                        </Breadcrumb>
                      ) : (
                        <span className="truncate">My files</span>
                      )}
                      <span
                        aria-live="polite"
                        className="shrink-0 font-normal text-muted-foreground"
                      >
                        {libraryItemCount} items
                      </span>
                    </CardTitle>
                    <CardDescription className="truncate text-xs">
                      {selectedSpace?.description ||
                        "Browse folders and files available to chats and agent workflows."}
                    </CardDescription>
                    {selectedSpace && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="rounded-full border px-2 py-0.5">
                          {selectedSpace.visibility === "workspace"
                            ? "Workspace"
                            : "Private"}
                        </span>
                        <span>{selectedSpace.itemCount} items</span>
                        <span>·</span>
                        <span>
                          Updated{" "}
                          {new Date(
                            selectedSpace.updatedAt
                          ).toLocaleDateString()}
                        </span>

                        {selectedSpaceProblems > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-destructive">
                              {selectedSpaceProblems} indexing{" "}
                              {selectedSpaceProblems === 1
                                ? "problem"
                                : "problems"}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {selectedSpace && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onNavigate("chat")}
                    >
                      Start chat
                    </Button>
                  )}
                </div>
                <FilterBar
                  className="-mx-4 -mb-3 border-0 px-4 sm:-mx-0 sm:px-0"
                  search={{
                    value: query,
                    onChange: setQuery,
                    placeholder: "Search this folder",
                    label: "Search this folder",
                  }}
                  hasActiveFilters={
                    Boolean(query.trim()) ||
                    typeFilter !== "all" ||
                    statusFilter !== "all" ||
                    ownershipFilter !== "all" ||
                    sortBy !== "updated"
                  }
                  onClear={() => {
                    setQuery("")
                    setTypeFilter("all")
                    setStatusFilter("all")
                    setOwnershipFilter("all")
                    setSortBy("updated")
                  }}
                >
                  <Select
                    value={typeFilter}
                    onValueChange={(value) =>
                      setTypeFilter((value as ItemFilter) || "all")
                    }
                  >
                    <SelectTrigger
                      aria-label="Filter by type"
                      className="min-w-32"
                    >
                      <SelectValue>
                        {typeFilter === "all"
                          ? "All types"
                          : (typeLabels[typeFilter] ?? "All types")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      {Object.entries(typeLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={statusFilter}
                    onValueChange={(value) => setStatusFilter(value ?? "all")}
                  >
                    <SelectTrigger
                      className="min-w-36"
                      aria-label="Filter by status"
                    >
                      <Settings2 data-icon="inline-start" />
                      <SelectValue>
                        {statusFilter === "all"
                          ? "All statuses"
                          : itemStatusLabel(statusFilter)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="ready">Ready</SelectItem>
                      <SelectItem value="processing">Processing</SelectItem>
                      <SelectItem value="queued">Queued</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={ownershipFilter}
                    onValueChange={(value) =>
                      setOwnershipFilter(value ?? "all")
                    }
                  >
                    <SelectTrigger
                      className="min-w-36"
                      aria-label="Filter by ownership"
                    >
                      <SelectValue>
                        {ownershipFilter === "all"
                          ? "All owners"
                          : ownershipFilter === "private"
                            ? "Personal"
                            : "Workspace"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All owners</SelectItem>
                      <SelectItem value="private">Personal</SelectItem>
                      <SelectItem value="workspace">Workspace</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={sortBy}
                    onValueChange={(value) =>
                      setSortBy(
                        (value as "updated" | "title" | "type") || "updated"
                      )
                    }
                  >
                    <SelectTrigger
                      className="min-w-40"
                      aria-label="Sort knowledge"
                    >
                      <SelectValue>
                        {sortBy === "updated"
                          ? "Recently updated"
                          : sortBy === "title"
                            ? "Title"
                            : "Type"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="updated">Recently updated</SelectItem>
                      <SelectItem value="title">Title</SelectItem>
                      <SelectItem value="type">Type</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    className="h-9"
                    disabled={visibleItems.length === 0}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setSelectedItemIds(
                        new Set(visibleItems.map((item) => item.id))
                      )
                    }
                  >
                    <Check data-icon="inline-start" /> Select visible
                  </Button>
                </FilterBar>
                {selectedItemIds.size > 0 && (
                  <div className="flex translate-y-0 flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground opacity-100 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transform-none starting:translate-y-1 starting:opacity-0">
                    <span>{selectedItemIds.size} selected</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      <Trash2 /> Delete selected
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelectedItemIds(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </CardHeader>
              <ContextMenu>
                <ContextMenuTrigger className="block min-h-96">
                  <CardContent
                    className={cn(
                      "min-h-96 overflow-y-auto bg-muted/20 p-4 transition-colors sm:p-5",
                      draggingFiles && "bg-muted/45"
                    )}
                    onDragEnter={(event) => {
                      event.preventDefault()
                      setDraggingFiles(true)
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node
                        )
                      )
                        setDraggingFiles(false)
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      setDraggingFiles(false)
                      const files = Array.from(event.dataTransfer.files ?? [])
                      if (files.length) void uploadFiles(files)
                    }}
                  >
                    <button
                      className={cn(
                        "mb-5 flex w-full items-center justify-center gap-3 rounded-xl bg-secondary/70 px-4 py-5 text-left shadow-xs transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
                        draggingFiles && "border-primary bg-primary/5"
                      )}
                      disabled={busy}
                      onClick={() => fileInputRef.current?.click()}
                      type="button"
                    >
                      {busy ? (
                        <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
                      ) : (
                        <UploadCloud className="size-6 text-primary" />
                      )}
                      <span>
                        <span className="block text-sm font-medium">
                          {busy
                            ? "Uploading files…"
                            : "Drop files here or click to upload"}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          PDF, Office, email, OpenDocument and text · 25 MB each
                        </span>
                      </span>
                    </button>

                    {loading ? (
                      <div
                        aria-live="polite"
                        className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"
                        role="status"
                      >
                        <LoaderCircle className="animate-spin" /> Loading files…
                      </div>
                    ) : loadError &&
                      visibleItems.length === 0 &&
                      childSpaces.length === 0 ? (
                      <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
                        <p className="text-sm text-destructive" role="alert">
                          Knowledge could not be loaded completely.
                        </p>
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={() => void load()}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : visibleItems.length === 0 &&
                      childSpaces.length === 0 ? (
                      <Empty className="min-h-64 border-0">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <FolderKanban />
                          </EmptyMedia>
                          <EmptyTitle>
                            {query
                              ? "No matching files"
                              : "This folder is empty"}
                          </EmptyTitle>
                          <EmptyDescription>
                            Upload a file, or right-click here to create a
                            folder.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                        {!query.trim() &&
                          childSpaces.map((folder) => (
                            <ContextMenu key={folder.id}>
                              <ContextMenuTrigger
                                className="group flex min-w-0 cursor-pointer flex-col rounded-xl bg-secondary/70 p-3 text-left shadow-xs transition-[background-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-secondary hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                                onClick={() => setSpaceId(folder.id)}
                                onKeyDown={(event) => {
                                  if (
                                    event.key === "Enter" ||
                                    event.key === " "
                                  ) {
                                    event.preventDefault()
                                    setSpaceId(folder.id)
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                              >
                                <div className="mb-3 flex items-start justify-between gap-2">
                                  <span className="flex size-12 items-center justify-center rounded-lg bg-muted text-primary">
                                    <Folder
                                      className="size-7"
                                      aria-hidden="true"
                                    />
                                  </span>
                                  <div
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) =>
                                      event.stopPropagation()
                                    }
                                  >
                                    <DropdownMenu>
                                      <DropdownMenuTrigger
                                        render={
                                          <Button
                                            aria-label={`Actions for ${folder.name}`}
                                            size="icon-sm"
                                            variant="ghost"
                                          />
                                        }
                                      >
                                        <MoreHorizontal />
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                          onClick={() => setSpaceId(folder.id)}
                                        >
                                          <Folder /> Open
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() => {
                                            setSpaceParentId(folder.id)
                                            setSpaceOpen(true)
                                          }}
                                        >
                                          <FolderPlus /> New subfolder
                                        </DropdownMenuItem>
                                        {folder.canManage && (
                                          <>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                              variant="destructive"
                                              onClick={() =>
                                                setFolderDeleteTarget(folder)
                                              }
                                            >
                                              <Trash2 /> Delete folder
                                            </DropdownMenuItem>
                                          </>
                                        )}
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                </div>
                                <p className="w-full truncate text-left text-sm font-medium">
                                  {folder.name}
                                </p>
                                <span className="mt-1 text-xs text-muted-foreground">
                                  {folder.itemCount}{" "}
                                  {folder.itemCount === 1 ? "item" : "items"}
                                </span>
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-48">
                                <ContextMenuGroup>
                                  <ContextMenuItem
                                    onClick={() => setSpaceId(folder.id)}
                                  >
                                    <Folder /> Open
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onClick={() => {
                                      setSpaceParentId(folder.id)
                                      setSpaceOpen(true)
                                    }}
                                  >
                                    <FolderPlus /> New subfolder
                                  </ContextMenuItem>
                                </ContextMenuGroup>
                                {folder.canManage && (
                                  <>
                                    <ContextMenuSeparator />
                                    <ContextMenuGroup>
                                      <ContextMenuItem
                                        variant="destructive"
                                        onClick={() =>
                                          setFolderDeleteTarget(folder)
                                        }
                                      >
                                        <Trash2 /> Delete folder
                                      </ContextMenuItem>
                                    </ContextMenuGroup>
                                  </>
                                )}
                              </ContextMenuContent>
                            </ContextMenu>
                          ))}
                        {visibleItems.map((item) => {
                          const source =
                            item.resourceType === "source"
                              ? liveSources.find(
                                  (candidate) =>
                                    candidate.id === item.resourceId
                                )
                              : null
                          const Icon = itemIcon(item, source)
                          const pending =
                            source?.status === "queued" ||
                            source?.status === "processing"
                          return (
                            <ContextMenu key={item.id}>
                              <ContextMenuTrigger
                                aria-selected={selectedItemIds.has(item.id)}
                                className={cn(
                                  "group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl bg-secondary/70 p-3 text-left shadow-xs transition-[background-color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:-translate-y-0.5 hover:bg-secondary hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none active:scale-[0.99] motion-reduce:transform-none",
                                  selectedItemIds.has(item.id) &&
                                    "bg-primary/10 shadow-md ring-2 ring-primary/50",
                                  pending &&
                                    "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:animate-pulse before:bg-primary motion-reduce:before:animate-none",
                                  selected?.id === item.id &&
                                    "ring-2 ring-primary/30"
                                )}
                                onClick={() =>
                                  setSelectedItemIds((current) => {
                                    const next = new Set(current)
                                    if (next.has(item.id)) next.delete(item.id)
                                    else next.add(item.id)
                                    return next
                                  })
                                }
                                onDoubleClick={() => openInspector(item)}
                              >
                                <div className="mb-3 flex items-start justify-between gap-2">
                                  <span className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                    <Icon
                                      className="size-6"
                                      aria-hidden="true"
                                    />
                                  </span>
                                  <div
                                    className="flex items-center gap-1"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <DropdownMenu>
                                      <DropdownMenuTrigger
                                        render={
                                          <Button
                                            aria-label={`Actions for ${item.title}`}
                                            size="icon-sm"
                                            variant="ghost"
                                          />
                                        }
                                      >
                                        <MoreHorizontal />
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                          onClick={() => openInspector(item)}
                                        >
                                          <Search /> Open details
                                        </DropdownMenuItem>
                                        {canDeleteKnowledgeItem(item) && (
                                          <>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                              variant="destructive"
                                              onClick={() =>
                                                setDeleteTarget(item)
                                              }
                                            >
                                              <Trash2 /> Delete
                                            </DropdownMenuItem>
                                          </>
                                        )}
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                </div>
                                <p className="w-full truncate text-left text-sm font-medium">
                                  {item.title}
                                </p>
                                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                  <span className="truncate">
                                    {typeLabels[item.resourceType] ??
                                      item.resourceType}
                                  </span>
                                  <span>
                                    {new Date(
                                      item.updatedAt
                                    ).toLocaleDateString()}
                                  </span>
                                </div>
                                {pending && (
                                  <div className="mt-2 flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                      <span className="flex items-center gap-1.5">
                                        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                                        {source?.status === "queued"
                                          ? "Upload complete · Waiting to index"
                                          : `Indexing${source?.stage ? ` · ${source.stage.replace(/[-_]/g, " ")}` : ""}`}
                                      </span>
                                      {source?.status === "processing" && (
                                        <span className="tabular-nums">
                                          {Math.round(source.progress ?? 0)}%
                                        </span>
                                      )}
                                    </div>
                                    <Progress value={source?.progress ?? 0} />
                                  </div>
                                )}
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-44">
                                <ContextMenuGroup>
                                  <ContextMenuItem
                                    onClick={() =>
                                      setSelectedItemIds((current) => {
                                        const next = new Set(current)
                                        if (next.has(item.id))
                                          next.delete(item.id)
                                        else next.add(item.id)
                                        return next
                                      })
                                    }
                                  >
                                    {selectedItemIds.has(item.id) ? (
                                      <X />
                                    ) : (
                                      <Check />
                                    )}
                                    {selectedItemIds.has(item.id)
                                      ? "Deselect"
                                      : "Select"}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onClick={() => openInspector(item)}
                                  >
                                    <Search /> Open details
                                  </ContextMenuItem>
                                </ContextMenuGroup>
                                {canDeleteKnowledgeItem(item) && (
                                  <>
                                    <ContextMenuSeparator />
                                    <ContextMenuGroup>
                                      <ContextMenuItem
                                        variant="destructive"
                                        onClick={() => setDeleteTarget(item)}
                                      >
                                        <Trash2 /> Delete
                                      </ContextMenuItem>
                                    </ContextMenuGroup>
                                  </>
                                )}
                              </ContextMenuContent>
                            </ContextMenu>
                          )
                        })}
                      </div>
                    )}
                    {nextCursor && !loading && (
                      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                        <span>
                          Showing {displayedItemCount} of {libraryItemCount}{" "}
                          items
                        </span>
                        <Button
                          disabled={loadingMore}
                          onClick={() => void loadMore()}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {loadingMore ? "Loading…" : "Load more"}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuGroup>
                    <ContextMenuItem
                      onClick={() => {
                        setSpaceParentId(selectedSpace?.id ?? "root")
                        setSpaceOpen(true)
                      }}
                    >
                      <FolderPlus /> New folder
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload /> Upload file
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => setAddOpen(true)}>
                      <Plus /> Add knowledge
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => void load()}>
                      <RefreshCw /> Refresh
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            </Card>
          </div>
        </div>

        <Sheet
          open={inspectorOpen && Boolean(selected)}
          onOpenChange={(open) => {
            if (open) setInspectorOpen(true)
            else closeInspector()
          }}
        >
          <SheetContent
            className="w-full overflow-y-auto p-0 sm:max-w-xl"
            showCloseButton={false}
            side="right"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{selected?.title ?? "Knowledge item"}</SheetTitle>
              <SheetDescription>
                Inspect and manage this Knowledge item.
              </SheetDescription>
            </SheetHeader>
            <Card className="min-h-full rounded-none border-0 shadow-none">
              {selected ? (
                <>
                  <CardHeader className="border-b px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-sm">
                          {selected.title}
                        </CardTitle>
                        <CardDescription>
                          {typeLabels[selected.resourceType] ??
                            selected.resourceType}
                        </CardDescription>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canDeleteKnowledgeItem(selected) && (
                          <Button
                            aria-label={`Delete ${selected.title}`}
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleteTarget(selected)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                        <Button
                          aria-label="Close item details"
                          size="icon-sm"
                          variant="ghost"
                          onClick={closeInspector}
                        >
                          <X />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
                    {spaces.length > 0 && (
                      <div className="rounded-xl bg-muted/50 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium">Spaces</p>
                            <p className="text-xs text-muted-foreground">
                              Assign this item to one or more spaces.
                            </p>
                          </div>
                          <Select
                            value="none"
                            onValueChange={(value) => {
                              if (value) void assignSelectedSpace(value)
                            }}
                          >
                            <SelectTrigger
                              className="h-8 w-28"
                              aria-label="Add to space"
                            >
                              <SelectValue>Add to…</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Add to…</SelectItem>
                              {spaces
                                .filter(
                                  (space) =>
                                    !selected.spaceIds?.includes(space.id)
                                )
                                .map((space) => (
                                  <SelectItem key={space.id} value={space.id}>
                                    {space.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(selected.spaceIds ?? []).map((assignedID) => {
                            const assigned = spaces.find(
                              (space) => space.id === assignedID
                            )
                            return (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-xs"
                                key={assignedID}
                              >
                                {assigned?.name ?? "Space"}
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground"
                                  aria-label={`Remove from ${assigned?.name ?? "space"}`}
                                  onClick={() =>
                                    void removeSelectedSpace(assignedID)
                                  }
                                >
                                  <X className="size-3" />
                                </button>
                              </span>
                            )
                          })}
                          {!selected.spaceIds?.length && (
                            <span className="text-xs text-muted-foreground">
                              Personal library (not assigned)
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {selectedSource && (
                      <>
                        <div className="rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                          <p className="flex items-center gap-2 font-medium text-foreground">
                            {selectedSource.sourceType === "url" ? (
                              <Globe2 />
                            ) : (
                              <FileText />
                            )}{" "}
                            {selectedSource.sourceType === "url"
                              ? selectedSource.sourceUrl
                              : "Uploaded source"}
                          </p>
                          <p className="mt-2">
                            Status: {selectedSource.status}
                            {selectedSource.stage
                              ? ` · ${selectedSource.stage}`
                              : ""}
                          </p>
                          {selectedSource.error && (
                            <p className="mt-2 text-destructive" role="alert">
                              {selectedSource.error}
                            </p>
                          )}
                        </div>
                        {selectedDetailLoading && (
                          <p
                            aria-live="polite"
                            className="text-xs text-muted-foreground"
                            role="status"
                          >
                            Loading item details…
                          </p>
                        )}
                        {selectedDetail?.content && (
                          <pre className="max-h-64 overflow-auto rounded-lg border bg-background p-3 text-xs leading-5 whitespace-pre-wrap">
                            {selectedDetail.content}
                          </pre>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {selectedSource.sourceType === "upload" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true)
                                try {
                                  await downloadFile(
                                    `/api/v1/knowledge/sources/${selectedSource.id}/file`,
                                    selectedSource.title
                                  )
                                } catch (error) {
                                  setNotice(
                                    error instanceof Error
                                      ? error.message
                                      : "Download failed."
                                  )
                                } finally {
                                  setBusy(false)
                                }
                              }}
                            >
                              Download original
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void reindexSelectedSource()}
                          >
                            <RefreshCw data-icon="inline-start" /> Reindex
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setDeleteTarget(selected)}
                          >
                            <Trash2 data-icon="inline-start" /> Remove
                          </Button>
                        </div>
                      </>
                    )}
                    {selectedNote && (
                      <NoteInspector
                        note={selectedNote}
                        onChange={(next) =>
                          onNotesChange(
                            notes.map((note) =>
                              note.id === next.id ? next : note
                            )
                          )
                        }
                        onSave={() => void updateSelectedNote()}
                        saving={busy}
                      />
                    )}
                    {selectedMemory && (
                      <div className="flex flex-col gap-4">
                        <div>
                          <Label htmlFor="inspector-memory-content">
                            Memory
                          </Label>
                          <Textarea
                            id="inspector-memory-content"
                            className="mt-2 min-h-28"
                            maxLength={2000}
                            value={memoryDraft}
                            onChange={(event) =>
                              setMemoryDraft(event.target.value)
                            }
                          />
                        </div>
                        <Button
                          size="sm"
                          className="w-fit"
                          onClick={() => void updateSelectedMemory()}
                          disabled={busy || !memoryDraft.trim()}
                        >
                          {busy ? "Saving…" : "Save memory"}
                        </Button>
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">Use in chats</p>
                            <p className="text-xs text-muted-foreground">
                              Available across your conversations.
                            </p>
                          </div>
                          <Switch
                            aria-label="Use memory in chats"
                            id="inspector-memory-enabled"
                            checked={selectedMemory.enabled}
                            onCheckedChange={(checked) =>
                              void toggleSelectedMemory(checked)
                            }
                            disabled={busy}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Provenance: {selectedMemory.source}
                        </p>
                      </div>
                    )}

                    {selected.resourceType === "transcript" && (
                      <>
                        <p className="text-sm leading-6 text-muted-foreground">
                          Transcript passages are searchable with
                          timestamp-aware citations. Open the transcript
                          workspace for the full recording.
                        </p>
                        {selectedDetail?.content && (
                          <pre className="max-h-64 overflow-auto rounded-xl bg-muted/50 p-3 text-xs leading-5 whitespace-pre-wrap">
                            {selectedDetail.content}
                          </pre>
                        )}
                      </>
                    )}
                    <div className="mt-auto rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                      <p>
                        Added{" "}
                        {new Date(selected.createdAt).toLocaleDateString()}
                      </p>
                      <p className="mt-1">
                        Updated{" "}
                        {new Date(selected.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </CardContent>
                </>
              ) : (
                <Empty className="h-full min-h-72 border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Search />
                    </EmptyMedia>
                    <EmptyTitle>Select an item</EmptyTitle>
                    <EmptyDescription>
                      Inspect, edit, or manage a Knowledge item here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </Card>
          </SheetContent>
        </Sheet>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent
          className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl sm:p-0"
          overlayClassName="bg-black/50"
        >
          <DialogHeader className="border-b bg-muted/20 px-6 py-5 pr-14">
            <DialogTitle className="text-base">Add knowledge</DialogTitle>
            <DialogDescription>
              Choose what you want JustAI to remember and make searchable.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4">
            <AddKnowledgeOption
              icon={Upload}
              title="Upload a file"
              description="PDF, CSV, Markdown, text, HTML, or JSON"
              onClick={() => {
                setAddOpen(false)
                fileInputRef.current?.click()
              }}
            />
            <AddKnowledgeOption
              icon={Link2}
              title="Index a URL"
              description="Make public documentation searchable"
              onClick={() => {
                setAddOpen(false)
                setUrlOpen(true)
              }}
            />
            <AddKnowledgeOption
              icon={NotebookPen}
              title="Write a note"
              description="Keep durable working context close at hand"
              onClick={() => {
                setAddOpen(false)
                setNoteOpen(true)
              }}
            />
            <AddKnowledgeOption
              icon={Brain}
              title="Save a memory"
              description="A preference or recurring fact used across chats"
              onClick={() => {
                setAddOpen(false)
                setMemoryOpen(true)
              }}
            />
            <AddKnowledgeOption
              icon={FileText}
              title="Import a transcript"
              description="Store a recorded session in a folder"
              onClick={() => {
                setAddOpen(false)
                setTranscriptSpaceId(selectedSpace?.id ?? "none")
                setTranscriptOpen(true)
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={spaceOpen} onOpenChange={setSpaceOpen}>
        <DialogContent>
          <form onSubmit={createSpace}>
            <DialogHeader>
              <DialogTitle>New storage folder</DialogTitle>
              <DialogDescription>
                Create it at the root or inside another folder.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>Could not create folder</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3 py-4">
              <Label htmlFor="space-name">Name</Label>
              <Input
                id="space-name"
                value={spaceName}
                onChange={(event) => setSpaceName(event.target.value)}
                placeholder="e.g. Product launch"
              />
              <Label htmlFor="space-description">Description</Label>
              <Textarea
                id="space-description"
                value={spaceDescription}
                onChange={(event) => setSpaceDescription(event.target.value)}
                placeholder="What belongs in this space?"
              />
              <Label htmlFor="space-parent">Parent folder</Label>
              <Select
                value={spaceParentId}
                onValueChange={(value) => setSpaceParentId(value ?? "root")}
              >
                <SelectTrigger id="space-parent">
                  <SelectValue>
                    {spaceParentId === "root"
                      ? "Storage root"
                      : (spaceTree.find((space) => space.id === spaceParentId)
                          ?.name ?? "Storage root")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">Storage root</SelectItem>
                  {spaceTree.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {`${"— ".repeat(space.depth)}${space.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="space-visibility">Visibility</Label>
              <Select
                value={spaceVisibility}
                onValueChange={(value) =>
                  setSpaceVisibility(
                    (value as "private" | "workspace") || "private"
                  )
                }
              >
                <SelectTrigger id="space-visibility">
                  <SelectValue>
                    {spaceVisibility === "workspace" ? "Workspace" : "Private"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="workspace">Workspace</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSpaceOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !spaceName.trim()}>
                {busy ? "Creating…" : "Create folder"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <form onSubmit={createNote}>
            <DialogHeader>
              <DialogTitle>Write a note</DialogTitle>
              <DialogDescription>
                Notes are durable context and can be updated from the inspector.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>Could not save note</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3 py-4">
              <Label htmlFor="knowledge-note-title">Title</Label>
              <Input
                id="knowledge-note-title"
                value={noteTitle}
                onChange={(event) => setNoteTitle(event.target.value)}
                placeholder="Note title"
              />
              <Label htmlFor="knowledge-note-content">Content</Label>
              <Textarea
                id="knowledge-note-content"
                className="min-h-36"
                value={noteContent}
                onChange={(event) => setNoteContent(event.target.value)}
                placeholder="What should JustAI know?"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setNoteOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || (!noteTitle.trim() && !noteContent.trim())}
              >
                {busy ? "Saving…" : "Save note"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={memoryOpen} onOpenChange={setMemoryOpen}>
        <DialogContent>
          <form onSubmit={createMemory}>
            <DialogHeader>
              <DialogTitle>Save a memory</DialogTitle>
              <DialogDescription>
                Keep it concise. You can disable or delete it any time.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>Could not save memory</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="py-4">
              <Label htmlFor="knowledge-memory-content">Memory</Label>
              <Textarea
                id="knowledge-memory-content"
                maxLength={2000}
                value={memoryContent}
                onChange={(event) => setMemoryContent(event.target.value)}
                placeholder="What should JustAI remember?"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMemoryOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !memoryContent.trim()}>
                {busy ? "Saving…" : "Save memory"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={transcriptOpen} onOpenChange={setTranscriptOpen}>
        <DialogContent>
          <form onSubmit={importTranscript}>
            <DialogHeader>
              <DialogTitle>Import transcript</DialogTitle>
              <DialogDescription>
                Choose a recorded session and optionally place it in a Knowledge
                space.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>Could not import transcript</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3 py-4">
              <Label htmlFor="knowledge-transcript-session">Transcript</Label>
              <Select
                value={transcriptSessionId || "none"}
                onValueChange={(value) =>
                  setTranscriptSessionId(value === "none" ? "" : (value ?? ""))
                }
              >
                <SelectTrigger id="knowledge-transcript-session">
                  <SelectValue>
                    {transcriptSessionId
                      ? (transcriptionSessions.find(
                          (session) => session.id === transcriptSessionId
                        )?.title ?? "Choose a transcript")
                      : "Choose a transcript"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Choose a transcript</SelectItem>
                  {transcriptionSessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="knowledge-transcript-space">
                Add to space{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Select
                value={transcriptSpaceId}
                onValueChange={(value) => setTranscriptSpaceId(value ?? "none")}
              >
                <SelectTrigger id="knowledge-transcript-space">
                  <SelectValue>
                    {transcriptSpaceId === "none"
                      ? "Personal library"
                      : (spaces.find((space) => space.id === transcriptSpaceId)
                          ?.name ?? "Choose a space")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Personal library</SelectItem>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTranscriptOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !transcriptSessionId}>
                {busy ? "Importing…" : "Import transcript"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent>
          <form onSubmit={addUrl}>
            <DialogHeader>
              <DialogTitle>Index a URL</DialogTitle>
              <DialogDescription>
                Public HTTP(S) pages are fetched and indexed asynchronously.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert aria-live="polite" role="alert" variant="destructive">
                <AlertTitle>Could not index URL</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3 py-4">
              <Label htmlFor="knowledge-url">URL</Label>
              <Input
                id="knowledge-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://docs.example.com"
              />
              <Label htmlFor="knowledge-url-title">
                Display title{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="knowledge-url-title"
                value={urlTitle}
                onChange={(event) => setUrlTitle(event.target.value)}
                placeholder="Documentation"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setUrlOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !url.trim()}>
                {busy ? "Indexing…" : "Index URL"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        title={deleteDialogTitle(deleteTarget)}
        description={deleteDialogDescription(deleteTarget)}
        confirmLabel="Delete permanently"
        pending={deleteBusy}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null)
        }}
        onConfirm={() => {
          if (deleteTarget) return deleteKnowledgeItem(deleteTarget)
        }}
      />
      <ConfirmActionDialog
        open={bulkDeleteOpen}
        title={`Delete ${selectedItemIds.size} selected item${selectedItemIds.size === 1 ? "" : "s"}?`}
        description="The selected files and knowledge items will be permanently removed."
        confirmLabel="Delete selected"
        pending={deleteBusy}
        onOpenChange={(open) => {
          if (!deleteBusy) setBulkDeleteOpen(open)
        }}
        onConfirm={deleteSelectedItems}
      />
      <ConfirmActionDialog
        open={Boolean(folderDeleteTarget)}
        title="Delete folder?"
        description={
          folderDeleteTarget
            ? `“${folderDeleteTarget.name}” will be deleted. Files are kept in My files, and subfolders move up one level.`
            : "Files in this folder will be kept."
        }
        confirmLabel="Delete folder"
        pending={deleteBusy}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setFolderDeleteTarget(null)
        }}
        onConfirm={() => {
          if (folderDeleteTarget)
            return deleteKnowledgeFolder(folderDeleteTarget)
        }}
      />
    </Page>
  )
}

function NoteInspector({
  note,
  onChange,
  onSave,
  saving,
}: {
  note: Note
  onChange: (note: Note) => void
  onSave: () => void
  saving: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="inspector-note-title">Title</Label>
      <Input
        id="inspector-note-title"
        value={note.title}
        onChange={(event) => onChange({ ...note, title: event.target.value })}
      />
      <Label htmlFor="inspector-note-content">Content</Label>
      <Textarea
        id="inspector-note-content"
        className="min-h-56"
        value={note.content}
        onChange={(event) => onChange({ ...note, content: event.target.value })}
      />
      <Label htmlFor="inspector-note-visibility">Visibility</Label>
      <Select
        value={note.visibility === "workspace" ? "workspace" : "private"}
        onValueChange={(value) =>
          onChange({ ...note, visibility: value ?? "private" })
        }
      >
        <SelectTrigger id="inspector-note-visibility">
          <SelectValue>
            {note.visibility === "workspace" ? "Workspace" : "Private"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="private">Private</SelectItem>
          <SelectItem value="workspace">Workspace</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" className="w-fit" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save note"}
      </Button>
    </div>
  )
}
