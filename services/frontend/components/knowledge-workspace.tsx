"use client"

import { Spinner } from "@/components/panelui/spinner"
import {
  useTranslations,
  useTranslatedConfig,
} from "@/components/locale-provider"

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
  MoreHorizontal,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  ArrowUpDown,
  Settings2,
  Users,
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
import { Alert as PuAlert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Checkbox } from "@/components/panelui/checkbox"
import { Chip } from "@/components/panelui/chip"
import { SectionHeading } from "@/components/section-heading"
import { publishFolderTrail } from "@/lib/knowledge-folder-trail"
import { Button } from "@/components/panelui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/panelui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "@/components/panelui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/panelui/input"
import { Label } from "@/components/panelui/label"
import { Progress } from "@/components/ui/progress"
import {
  Page,
  PageActions,
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
} from "@/components/panelui/select"
import { Switch } from "@/components/panelui/switch"
import { Textarea } from "@/components/panelui/textarea"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Menu } from "@/components/panelui/menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/panelui/sheet"
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

const typeLabelsMessages: Record<string, string> = {
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
  const type = item ? (typeLabelsMessages[item.resourceType] ?? "item") : "item"
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
  const typeLabels = useTranslatedConfig(typeLabelsMessages)

  const { t, locale } = useTranslations()

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
  }, [requestedType, typeLabels])

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

  // Share the open folder's path with the top bar's breadcrumb.
  const trailKey = folderPath
    .map((folder) => `${folder.id}:${folder.name}`)
    .join("|")
  useEffect(() => {
    publishFolderTrail({
      items: folderPath.map((folder) => ({ id: folder.id, name: folder.name })),
      select: (id) => setSpaceId(id),
    })
    return () => publishFolderTrail(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailKey])

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
        title: noteTitle.trim() || t("Untitled note"),
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
        aria-label={t("Upload knowledge file")}
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
      {/* Its title is screen-reader only and its actions live in the top bar, so on desktop it is empty: pull the page up over the gap it leaves. */}
      <PageHeader className="sm:-mb-4">
        <PageHeading>
          <PageTitle>{t("Storage")}</PageTitle>
        </PageHeading>
        <PageActions>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" /> {t("Upload file")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSpaceParentId(selectedSpace?.id ?? "root")
              setSpaceOpen(true)
            }}
          >
            <FolderPlus data-icon="inline-start" /> {t("New folder")}
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus data-icon="inline-start" /> {t("Add knowledge")}
          </Button>
        </PageActions>
      </PageHeader>

      {(error || notice) && (
        <PuAlert
          aria-live="polite"
          role={error ? "alert" : "status"}
          tone={error ? "destructive" : "success"}
          variant="plain"
        >
          <PuAlert.Title>
            {error ? t("Knowledge action failed") : t("Knowledge updated")}
          </PuAlert.Title>
          <PuAlert.Description>{error || notice}</PuAlert.Description>
        </PuAlert>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="min-h-0 flex-1">
          <div className="min-h-0 flex-1">
            <Card className="min-h-0 gap-0 overflow-visible rounded-none border-0 bg-transparent py-0 shadow-none ring-0">
              <CardHeader className="gap-4 px-0 py-0 pb-4">
                <SectionHeading
                  actions={
                    selectedSpace && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onNavigate("chat")}
                      >
                        {t("Start chat")}
                      </Button>
                    )
                  }
                  as="h2"
                  count={
                    selectedSpace
                      ? undefined
                      : t("{value0} items", { value0: libraryItemCount })
                  }
                  description={selectedSpace?.description}
                  title={
                    selectedSpace
                      ? (folderPath[folderPath.length - 1]?.name ??
                        selectedSpace.name)
                      : t("My files")
                  }
                />
                {selectedSpace && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <Badge size="sm" variant="outline">
                      {selectedSpace.visibility === "workspace"
                        ? t("Workspace")
                        : t("Private")}
                    </Badge>
                    <span>
                      {t("{value0} items", {
                        value0: selectedSpace.itemCount,
                      })}
                    </span>
                    <span>·</span>
                    <span>
                      {t("Updated")}{" "}
                      {new Date(selectedSpace.updatedAt).toLocaleDateString(
                        locale
                      )}
                    </span>

                    {selectedSpaceProblems > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-destructive">
                          {selectedSpaceProblems} indexing{" "}
                          {selectedSpaceProblems === 1 ? "problem" : "problems"}
                        </span>
                      </>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Input.Group className="w-full sm:w-80">
                    <Input.Addon>
                      <Search aria-hidden="true" />
                    </Input.Addon>
                    <Input
                      aria-label={t("Search this folder")}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("Search this folder")}
                      value={query}
                    />
                  </Input.Group>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={statusFilter}
                      onValueChange={(value) => setStatusFilter(value ?? "all")}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-44 shrink-0"
                        aria-label={t("Filter by status")}
                      >
                        <Settings2 data-icon="inline-start" />
                        <SelectValue>
                          {statusFilter === "all"
                            ? t("All statuses")
                            : t(itemStatusLabel(statusFilter))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("All statuses")}</SelectItem>
                        <SelectItem value="ready">{t("Ready")}</SelectItem>
                        <SelectItem value="processing">
                          {t("Processing")}
                        </SelectItem>
                        <SelectItem value="queued">{t("Queued")}</SelectItem>
                        <SelectItem value="failed">{t("Failed")}</SelectItem>
                        <SelectItem value="disabled">
                          {t("Disabled")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={ownershipFilter}
                      onValueChange={(value) =>
                        setOwnershipFilter(value ?? "all")
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-44 shrink-0"
                        aria-label={t("Filter by ownership")}
                      >
                        <Users data-icon="inline-start" />
                        <SelectValue>
                          {ownershipFilter === "all"
                            ? t("All owners")
                            : ownershipFilter === "private"
                              ? t("Personal")
                              : t("Workspace")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("All owners")}</SelectItem>
                        <SelectItem value="private">{t("Personal")}</SelectItem>
                        <SelectItem value="workspace">
                          {t("Workspace")}
                        </SelectItem>
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
                        size="sm"
                        className="w-48 shrink-0"
                        aria-label={t("Sort knowledge")}
                      >
                        <ArrowUpDown data-icon="inline-start" />
                        <SelectValue>
                          {sortBy === "updated"
                            ? t("Recently updated")
                            : sortBy === "title"
                              ? t("Title")
                              : t("Type")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="updated">
                          {t("Recently updated")}
                        </SelectItem>
                        <SelectItem value="title">{t("Title")}</SelectItem>
                        <SelectItem value="type">{t("Type")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Chip.Group
                    aria-label={t("Filter by type")}
                    multiple={false}
                    onValueChange={(value) =>
                      setTypeFilter((value[0] as ItemFilter) || "all")
                    }
                    value={[typeFilter]}
                  >
                    {["all", ...Object.keys(typeLabels)].map((key) => (
                      <Chip key={key} size="sm" value={key}>
                        {key === "all"
                          ? t("All types")
                          : (typeLabels[key] ?? key)}
                      </Chip>
                    ))}
                  </Chip.Group>
                  <div className="flex flex-wrap items-center gap-2">
                    {Boolean(query.trim()) ||
                    typeFilter !== "all" ||
                    statusFilter !== "all" ||
                    ownershipFilter !== "all" ||
                    sortBy !== "updated" ? (
                      <Button
                        onClick={() => {
                          setQuery("")
                          setTypeFilter("all")
                          setStatusFilter("all")
                          setOwnershipFilter("all")
                          setSortBy("updated")
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        {t("Clear filters")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {selectedItemIds.size > 0 && (
                  <div
                    className="flex flex-wrap items-center gap-3 rounded-2xl bg-primary/5 px-3.5 py-2.5 ring-1 ring-primary/20 transition-opacity duration-200 starting:opacity-0"
                    role="status"
                  >
                    <Checkbox
                      checked={
                        visibleItems.length > 0 &&
                        selectedItemIds.size >= visibleItems.length
                      }
                      indeterminate={
                        selectedItemIds.size > 0 &&
                        selectedItemIds.size < visibleItems.length
                      }
                      label={t("Select visible")}
                      onCheckedChange={() =>
                        setSelectedItemIds(
                          selectedItemIds.size >= visibleItems.length
                            ? new Set()
                            : new Set(visibleItems.map((item) => item.id))
                        )
                      }
                    />
                    <span className="text-sm font-medium">
                      {selectedItemIds.size} {t("selected")}
                    </span>
                    <div className="ms-auto flex items-center gap-2">
                      <Button
                        className="text-destructive hover:text-destructive"
                        onClick={() => setBulkDeleteOpen(true)}
                        size="sm"
                        variant="outline"
                      >
                        <Trash2 data-icon="inline-start" />{" "}
                        {t("Delete selected")}
                      </Button>
                      <Button
                        aria-label={t("Clear selection")}
                        onClick={() => setSelectedItemIds(new Set())}
                        size="icon-sm"
                        title={t("Clear selection")}
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                )}
              </CardHeader>
              <ContextMenu>
                <ContextMenuTrigger className="block min-h-96">
                  <CardContent
                    className={cn(
                      "-m-1.5 min-h-96 overflow-y-auto bg-transparent p-1.5 transition-colors",
                      draggingFiles && "rounded-xl bg-primary/5"
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
                    {(draggingFiles || busy) && (
                      <div
                        aria-live="polite"
                        className="mb-4 flex items-center justify-center gap-2 rounded-xl border border-dashed border-primary/50 bg-primary/5 px-4 py-3 text-sm font-medium"
                        role="status"
                      >
                        {busy ? (
                          <Spinner className="size-4 text-muted-foreground" />
                        ) : (
                          <UploadCloud className="size-4 text-primary" />
                        )}
                        {busy
                          ? t("Uploading files…")
                          : t("Drop files here or click to upload")}
                      </div>
                    )}

                    {loading ? (
                      <div
                        aria-live="polite"
                        className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"
                        role="status"
                      >
                        <Spinner /> {t("Loading files…")}
                      </div>
                    ) : loadError &&
                      visibleItems.length === 0 &&
                      childSpaces.length === 0 ? (
                      <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
                        <p className="text-sm text-destructive" role="alert">
                          {t("Knowledge could not be loaded completely.")}
                        </p>
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={() => void load()}
                        >
                          {t("Try again")}
                        </Button>
                      </div>
                    ) : visibleItems.length === 0 &&
                      childSpaces.length === 0 ? (
                      <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-[22px] border border-dashed p-8 text-center">
                        <span className="rounded-full bg-muted p-3 text-muted-foreground">
                          <FolderKanban aria-hidden="true" className="size-6" />
                        </span>
                        <div className="flex max-w-md flex-col gap-1">
                          <p className="font-medium">
                            {query
                              ? t("No matching files")
                              : t("This folder is empty")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {t("Drop files here or click to upload")}
                            {" · "}
                            {t(
                              "PDF, Office, email, OpenDocument and text · 25 MB each"
                            )}
                          </p>
                        </div>
                        <Button
                          disabled={busy}
                          onClick={() => fileInputRef.current?.click()}
                          variant="outline"
                        >
                          <Upload data-icon="inline-start" /> {t("Upload file")}
                        </Button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                        {!query.trim() &&
                          childSpaces.map((folder) => (
                            <ContextMenu key={folder.id}>
                              <ContextMenuTrigger
                                className="group flex min-w-0 cursor-pointer flex-col rounded-[20px] bg-card p-3.5 text-left ring-1 ring-foreground/10 transition-[background-color,box-shadow] hover:bg-muted/40 hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
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
                                  <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-primary">
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
                                    <Menu>
                                      <Menu.Trigger
                                        render={
                                          <Button
                                            aria-label={t(
                                              "Actions for {value0}",
                                              { value0: folder.name }
                                            )}
                                            size="icon-sm"
                                            variant="ghost"
                                          />
                                        }
                                      >
                                        <MoreHorizontal />
                                      </Menu.Trigger>
                                      <Menu.Content align="end">
                                        <Menu.Item
                                          onClick={() => setSpaceId(folder.id)}
                                        >
                                          <Folder /> {t("Open")}
                                        </Menu.Item>
                                        <Menu.Item
                                          onClick={() => {
                                            setSpaceParentId(folder.id)
                                            setSpaceOpen(true)
                                          }}
                                        >
                                          <FolderPlus /> {t("New subfolder")}
                                        </Menu.Item>
                                        {folder.canManage && (
                                          <>
                                            <Menu.Separator />
                                            <Menu.Item
                                              variant="destructive"
                                              onClick={() =>
                                                setFolderDeleteTarget(folder)
                                              }
                                            >
                                              <Trash2 /> {t("Delete folder")}
                                            </Menu.Item>
                                          </>
                                        )}
                                      </Menu.Content>
                                    </Menu>
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
                                    <Folder /> {t("Open")}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onClick={() => {
                                      setSpaceParentId(folder.id)
                                      setSpaceOpen(true)
                                    }}
                                  >
                                    <FolderPlus /> {t("New subfolder")}
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
                                        <Trash2 /> {t("Delete folder")}
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
                                data-selected={
                                  selectedItemIds.has(item.id) ? "" : undefined
                                }
                                className={cn(
                                  "group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-[20px] bg-card p-3.5 text-left ring-1 ring-foreground/10 transition-[background-color,box-shadow] duration-200 hover:bg-muted/40 hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                                  selectedItemIds.has(item.id) &&
                                    "bg-primary/5 ring-2 ring-primary/50",
                                  pending &&
                                    "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:animate-pulse before:bg-primary motion-reduce:before:animate-none",
                                  selected?.id === item.id &&
                                    "ring-2 ring-primary/30"
                                )}
                                onClick={() => openInspector(item)}
                                onKeyDown={(event) => {
                                  if (
                                    event.target === event.currentTarget &&
                                    (event.key === "Enter" || event.key === " ")
                                  ) {
                                    event.preventDefault()
                                    openInspector(item)
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                              >
                                <div className="mb-3 flex items-start justify-between gap-2">
                                  <span
                                    className="relative flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground"
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) =>
                                      event.stopPropagation()
                                    }
                                  >
                                    <Icon
                                      aria-hidden="true"
                                      className={cn(
                                        "size-6 transition-opacity",
                                        (selectedItemIds.size > 0 ||
                                          selectedItemIds.has(item.id)) &&
                                          "opacity-0",
                                        selectedItemIds.size === 0 &&
                                          "group-focus-within:opacity-0 group-hover:opacity-0"
                                      )}
                                    />
                                    <Checkbox
                                      checked={selectedItemIds.has(item.id)}
                                      className={cn(
                                        "absolute transition-opacity",
                                        selectedItemIds.size > 0
                                          ? "opacity-100"
                                          : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                                      )}
                                      label={t("Select {value0}", {
                                        value0: item.title,
                                      })}
                                      onCheckedChange={() =>
                                        setSelectedItemIds((current) => {
                                          const next = new Set(current)
                                          if (next.has(item.id))
                                            next.delete(item.id)
                                          else next.add(item.id)
                                          return next
                                        })
                                      }
                                    />
                                  </span>
                                  <div
                                    className="flex items-center gap-1"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <Menu>
                                      <Menu.Trigger
                                        render={
                                          <Button
                                            aria-label={t(
                                              "Actions for {value0}",
                                              { value0: item.title }
                                            )}
                                            size="icon-sm"
                                            variant="ghost"
                                          />
                                        }
                                      >
                                        <MoreHorizontal />
                                      </Menu.Trigger>
                                      <Menu.Content align="end">
                                        <Menu.Item
                                          onClick={() => openInspector(item)}
                                        >
                                          <Search /> {t("Open details")}
                                        </Menu.Item>
                                        {canDeleteKnowledgeItem(item) && (
                                          <>
                                            <Menu.Separator />
                                            <Menu.Item
                                              variant="destructive"
                                              onClick={() =>
                                                setDeleteTarget(item)
                                              }
                                            >
                                              <Trash2 /> {t("Delete")}
                                            </Menu.Item>
                                          </>
                                        )}
                                      </Menu.Content>
                                    </Menu>
                                  </div>
                                </div>
                                <p className="w-full truncate text-left text-sm font-medium">
                                  {item.title}
                                </p>
                                {source?.status === "failed" ? (
                                  <Badge
                                    className="mt-1.5 w-fit"
                                    dot
                                    size="sm"
                                    variant="destructive"
                                  >
                                    {t(itemStatusLabel(source.status))}
                                  </Badge>
                                ) : null}
                                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                  <span className="truncate">
                                    {typeLabels[item.resourceType] ??
                                      item.resourceType}
                                  </span>
                                  <span>
                                    {new Date(
                                      item.updatedAt
                                    ).toLocaleDateString(locale)}
                                  </span>
                                </div>
                                {pending && (
                                  <div className="mt-2 flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                      <span className="flex items-center gap-1.5">
                                        <Spinner className="size-3" />
                                        {source?.status === "queued"
                                          ? t(
                                              "Upload complete · Waiting to index"
                                            )
                                          : t("Indexing{value0}", {
                                              value0: source?.stage
                                                ? ` · ${source.stage.replace(/[-_]/g, " ")}`
                                                : "",
                                            })}
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
                                      ? t("Deselect")
                                      : t("Select")}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    onClick={() => openInspector(item)}
                                  >
                                    <Search /> {t("Open details")}
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
                                        <Trash2 /> {t("Delete")}
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
                          {t("Showing")} {displayedItemCount} {t("of")}{" "}
                          {libraryItemCount} items
                        </span>
                        <Button
                          disabled={loadingMore}
                          onClick={() => void loadMore()}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {loadingMore ? t("Loading…") : t("Load more")}
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
                      <FolderPlus /> {t("New folder")}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload /> {t("Upload file")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => setAddOpen(true)}>
                      <Plus /> {t("Add knowledge")}
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => void load()}>
                      <RefreshCw /> {t("Refresh")}
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            </Card>
          </div>
        </div>

        <Sheet
          side="right"
          open={inspectorOpen && Boolean(selected)}
          onOpenChange={(open) => {
            if (open) setInspectorOpen(true)
            else closeInspector()
          }}
        >
          <SheetContent
            className="w-[min(36rem,calc(100vw-2*var(--sheet-gap)))]! overflow-y-auto p-0"
            showClose={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{selected?.title ?? "Knowledge item"}</SheetTitle>
              <SheetDescription>
                {t("Inspect and manage this Knowledge item.")}
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
                            aria-label={t("Delete {value0}", {
                              value0: selected.title,
                            })}
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleteTarget(selected)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                        <Button
                          aria-label={t("Close item details")}
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
                            <p className="text-sm font-medium">{t("Spaces")}</p>
                            <p className="text-xs text-muted-foreground">
                              {t("Assign this item to one or more spaces.")}
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
                              aria-label={t("Add to space")}
                            >
                              <SelectValue>{t("Add to…")}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">
                                {t("Add to…")}
                              </SelectItem>
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
                                  aria-label={t("Remove from {value0}", {
                                    value0: assigned?.name ?? "space",
                                  })}
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
                              {t("Personal library (not assigned)")}
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
                              : t("Uploaded source")}
                          </p>
                          <p className="mt-2">
                            {t("Status:")} {selectedSource.status}
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
                            {t("Loading item details…")}
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
                              {t("Download original")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void reindexSelectedSource()}
                          >
                            <RefreshCw data-icon="inline-start" />{" "}
                            {t("Reindex")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setDeleteTarget(selected)}
                          >
                            <Trash2 data-icon="inline-start" /> {t("Remove")}
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
                            {t("Memory")}
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
                          {busy ? t("Saving…") : t("Save memory")}
                        </Button>
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">
                              {t("Use in chats")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t("Available across your conversations.")}
                            </p>
                          </div>
                          <Switch
                            aria-label={t("Use memory in chats")}
                            id="inspector-memory-enabled"
                            checked={selectedMemory.enabled}
                            onCheckedChange={(checked) =>
                              void toggleSelectedMemory(checked)
                            }
                            disabled={busy}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("Provenance:")} {selectedMemory.source}
                        </p>
                      </div>
                    )}

                    {selected.resourceType === "transcript" && (
                      <>
                        <p className="text-sm leading-6 text-muted-foreground">
                          {t(
                            "Transcript passages are searchable with timestamp-aware citations. Open the transcript workspace for the full recording."
                          )}
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
                        {t("Added")}{" "}
                        {new Date(selected.createdAt).toLocaleDateString(
                          locale
                        )}
                      </p>
                      <p className="mt-1">
                        {t("Updated")}{" "}
                        {new Date(selected.updatedAt).toLocaleDateString(
                          locale
                        )}
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
                    <EmptyTitle>{t("Select an item")}</EmptyTitle>
                    <EmptyDescription>
                      {t("Inspect, edit, or manage a Knowledge item here.")}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </Card>
          </SheetContent>
        </Sheet>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("Add knowledge")}</DialogTitle>
            <DialogDescription>
              {t(
                "Choose what you want JustAI to remember and make searchable."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4">
              <AddKnowledgeOption
                icon={Upload}
                title={t("Upload a file")}
                description={t("PDF, CSV, Markdown, text, HTML, or JSON")}
                onClick={() => {
                  setAddOpen(false)
                  fileInputRef.current?.click()
                }}
              />
              <AddKnowledgeOption
                icon={Link2}
                title={t("Index a URL")}
                description={t("Make public documentation searchable")}
                onClick={() => {
                  setAddOpen(false)
                  setUrlOpen(true)
                }}
              />
              <AddKnowledgeOption
                icon={NotebookPen}
                title={t("Write a note")}
                description={t("Keep durable working context close at hand")}
                onClick={() => {
                  setAddOpen(false)
                  setNoteOpen(true)
                }}
              />
              <AddKnowledgeOption
                icon={Brain}
                title={t("Save a memory")}
                description={t(
                  "A preference or recurring fact used across chats"
                )}
                onClick={() => {
                  setAddOpen(false)
                  setMemoryOpen(true)
                }}
              />
              <AddKnowledgeOption
                icon={FileText}
                title={t("Import a transcript")}
                description={t("Store a recorded session in a folder")}
                onClick={() => {
                  setAddOpen(false)
                  setTranscriptSpaceId(selectedSpace?.id ?? "none")
                  setTranscriptOpen(true)
                }}
              />
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={spaceOpen} onOpenChange={setSpaceOpen}>
        <DialogContent>
          <form className="contents" onSubmit={createSpace}>
            <DialogHeader>
              <DialogTitle>{t("New storage folder")}</DialogTitle>
              <DialogDescription>
                {t("Create it at the root or inside another folder.")}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {error && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertTitle>{t("Could not create folder")}</AlertTitle>
                  <AlertDescription>{t(error)}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-3 py-4">
                <Label htmlFor="space-name">{t("Name")}</Label>
                <Input
                  id="space-name"
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  placeholder={t("e.g. Product launch")}
                />
                <Label htmlFor="space-description">{t("Description")}</Label>
                <Textarea
                  id="space-description"
                  value={spaceDescription}
                  onChange={(event) => setSpaceDescription(event.target.value)}
                  placeholder={t("What belongs in this space?")}
                />
                <Label htmlFor="space-parent">{t("Parent folder")}</Label>
                <Select
                  value={spaceParentId}
                  onValueChange={(value) => setSpaceParentId(value ?? "root")}
                >
                  <SelectTrigger id="space-parent">
                    <SelectValue>
                      {spaceParentId === "root"
                        ? t("Storage root")
                        : (spaceTree.find((space) => space.id === spaceParentId)
                            ?.name ?? t("Storage root"))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="root">{t("Storage root")}</SelectItem>
                    {spaceTree.map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {`${"— ".repeat(space.depth)}${space.name}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Label htmlFor="space-visibility">{t("Visibility")}</Label>
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
                      {spaceVisibility === "workspace"
                        ? t("Workspace")
                        : t("Private")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">{t("Private")}</SelectItem>
                    <SelectItem value="workspace">{t("Workspace")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSpaceOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy || !spaceName.trim()}>
                {busy ? t("Creating…") : t("Create folder")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <form className="contents" onSubmit={createNote}>
            <DialogHeader>
              <DialogTitle>{t("Write a note")}</DialogTitle>
              <DialogDescription>
                {t(
                  "Notes are durable context and can be updated from the inspector."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {error && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertTitle>{t("Could not save note")}</AlertTitle>
                  <AlertDescription>{t(error)}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-3 py-4">
                <Label htmlFor="knowledge-note-title">{t("Title")}</Label>
                <Input
                  id="knowledge-note-title"
                  value={noteTitle}
                  onChange={(event) => setNoteTitle(event.target.value)}
                  placeholder={t("Note title")}
                />
                <Label htmlFor="knowledge-note-content">{t("Content")}</Label>
                <Textarea
                  id="knowledge-note-content"
                  className="min-h-36"
                  value={noteContent}
                  onChange={(event) => setNoteContent(event.target.value)}
                  placeholder={t("What should JustAI know?")}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setNoteOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                disabled={busy || (!noteTitle.trim() && !noteContent.trim())}
              >
                {busy ? t("Saving…") : t("Save note")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={memoryOpen} onOpenChange={setMemoryOpen}>
        <DialogContent>
          <form className="contents" onSubmit={createMemory}>
            <DialogHeader>
              <DialogTitle>{t("Save a memory")}</DialogTitle>
              <DialogDescription>
                {t("Keep it concise. You can disable or delete it any time.")}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {error && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertTitle>{t("Could not save memory")}</AlertTitle>
                  <AlertDescription>{t(error)}</AlertDescription>
                </Alert>
              )}
              <div className="py-4">
                <Label htmlFor="knowledge-memory-content">{t("Memory")}</Label>
                <Textarea
                  id="knowledge-memory-content"
                  maxLength={2000}
                  value={memoryContent}
                  onChange={(event) => setMemoryContent(event.target.value)}
                  placeholder={t("What should JustAI remember?")}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMemoryOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy || !memoryContent.trim()}>
                {busy ? t("Saving…") : t("Save memory")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={transcriptOpen} onOpenChange={setTranscriptOpen}>
        <DialogContent>
          <form className="contents" onSubmit={importTranscript}>
            <DialogHeader>
              <DialogTitle>{t("Import transcript")}</DialogTitle>
              <DialogDescription>
                {t(
                  "Choose a recorded session and optionally place it in a Knowledge space."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {error && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertTitle>{t("Could not import transcript")}</AlertTitle>
                  <AlertDescription>{t(error)}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-3 py-4">
                <Label htmlFor="knowledge-transcript-session">
                  {t("Transcript")}
                </Label>
                <Select
                  value={transcriptSessionId || "none"}
                  onValueChange={(value) =>
                    setTranscriptSessionId(
                      value === "none" ? "" : (value ?? "")
                    )
                  }
                >
                  <SelectTrigger id="knowledge-transcript-session">
                    <SelectValue>
                      {transcriptSessionId
                        ? (transcriptionSessions.find(
                            (session) => session.id === transcriptSessionId
                          )?.title ?? t("Choose a transcript"))
                        : t("Choose a transcript")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("Choose a transcript")}
                    </SelectItem>
                    {transcriptionSessions.map((session) => (
                      <SelectItem key={session.id} value={session.id}>
                        {session.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Label htmlFor="knowledge-transcript-space">
                  {t("Add to space")}{" "}
                  <span className="text-muted-foreground">
                    {t("(optional)")}
                  </span>
                </Label>
                <Select
                  value={transcriptSpaceId}
                  onValueChange={(value) =>
                    setTranscriptSpaceId(value ?? "none")
                  }
                >
                  <SelectTrigger id="knowledge-transcript-space">
                    <SelectValue>
                      {transcriptSpaceId === "none"
                        ? t("Personal library")
                        : (spaces.find(
                            (space) => space.id === transcriptSpaceId
                          )?.name ?? "Choose a space")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("Personal library")}
                    </SelectItem>
                    {spaces.map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {space.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTranscriptOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy || !transcriptSessionId}>
                {busy ? t("Importing…") : t("Import transcript")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent>
          <form className="contents" onSubmit={addUrl}>
            <DialogHeader>
              <DialogTitle>{t("Index a URL")}</DialogTitle>
              <DialogDescription>
                {t(
                  "Public HTTP(S) pages are fetched and indexed asynchronously."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {error && (
                <Alert aria-live="polite" role="alert" variant="destructive">
                  <AlertTitle>{t("Could not index URL")}</AlertTitle>
                  <AlertDescription>{t(error)}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-3 py-4">
                <Label htmlFor="knowledge-url">{t("URL")}</Label>
                <Input
                  id="knowledge-url"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://docs.example.com"
                />
                <Label htmlFor="knowledge-url-title">
                  {t("Display title")}{" "}
                  <span className="text-muted-foreground">
                    {t("(optional)")}
                  </span>
                </Label>
                <Input
                  id="knowledge-url-title"
                  value={urlTitle}
                  onChange={(event) => setUrlTitle(event.target.value)}
                  placeholder={t("Documentation")}
                />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setUrlOpen(false)}
              >
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy || !url.trim()}>
                {busy ? t("Indexing…") : t("Index URL")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        title={deleteDialogTitle(deleteTarget)}
        description={t(deleteDialogDescription(deleteTarget))}
        confirmLabel={t("Delete permanently")}
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
        title={t(
          selectedItemIds.size === 1
            ? "Delete {count} selected item?"
            : "Delete {count} selected items?",
          { count: selectedItemIds.size }
        )}
        description={t(
          "The selected files and knowledge items will be permanently removed."
        )}
        confirmLabel={t("Delete selected")}
        pending={deleteBusy}
        onOpenChange={(open) => {
          if (!deleteBusy) setBulkDeleteOpen(open)
        }}
        onConfirm={deleteSelectedItems}
      />
      <ConfirmActionDialog
        open={Boolean(folderDeleteTarget)}
        title={t("Delete folder?")}
        description={
          folderDeleteTarget
            ? t(
                "“{value0}” will be deleted. Files are kept in My files, and subfolders move up one level.",
                { value0: folderDeleteTarget.name }
              )
            : t("Files in this folder will be kept.")
        }
        confirmLabel={t("Delete folder")}
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
  const { t } = useTranslations()

  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="inspector-note-title">{t("Title")}</Label>
      <Input
        id="inspector-note-title"
        value={note.title}
        onChange={(event) => onChange({ ...note, title: event.target.value })}
      />
      <Label htmlFor="inspector-note-content">{t("Content")}</Label>
      <Textarea
        id="inspector-note-content"
        className="min-h-56"
        value={note.content}
        onChange={(event) => onChange({ ...note, content: event.target.value })}
      />
      <Label htmlFor="inspector-note-visibility">{t("Visibility")}</Label>
      <Select
        value={note.visibility === "workspace" ? "workspace" : "private"}
        onValueChange={(value) =>
          onChange({ ...note, visibility: value ?? "private" })
        }
      >
        <SelectTrigger id="inspector-note-visibility">
          <SelectValue>
            {note.visibility === "workspace" ? t("Workspace") : t("Private")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="private">{t("Private")}</SelectItem>
          <SelectItem value="workspace">{t("Workspace")}</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" className="w-fit" onClick={onSave} disabled={saving}>
        {saving ? t("Saving…") : t("Save note")}
      </Button>
    </div>
  )
}
