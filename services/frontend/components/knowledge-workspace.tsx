"use client"

import { downloadFile } from "@/lib/download-file"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  Brain,
  Check,
  ChevronRight,
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
  GitBranch,
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
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
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
  repository: "Repository",
  transcript: "Transcript",
}

function itemIcon(item: KnowledgeItem, source?: KnowledgeSource | null) {
  if (item.resourceType === "memory") return Brain
  if (item.resourceType === "note") return NotebookPen
  if (item.resourceType === "repository") return GitBranch
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
  return ["source", "note", "memory", "repository", "transcript"].includes(
    item.resourceType
  )
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

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    ...sources.map((source) => ({
      id: `source:${source.id}`,
      resourceType: itemTypeForSource(source),
      resourceId: source.id,
      title: source.title,
      visibility: source.scopeType === "organization" ? "workspace" : "private",
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
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [repositoryURL, setRepositoryURL] = useState("")
  const [repositoryRef, setRepositoryRef] = useState("")
  const [repositoryToken, setRepositoryToken] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null)
  const [folderDeleteTarget, setFolderDeleteTarget] =
    useState<KnowledgeSpace | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const openInspector = useCallback((item: KnowledgeItem) => {
    setSelected(item)
    setInspectorOpen(true)
  }, [])

  const closeInspector = useCallback(() => {
    setInspectorOpen(false)
    setSelected(null)
    setSelectedDetail(null)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [itemResult, spaceResult, memoryResult] = await Promise.allSettled([
        api.get<{ items: KnowledgeItem[] }>(
          "/api/v1/knowledge/items?limit=100"
        ),
        api.get<{ spaces: KnowledgeSpace[] }>("/api/v1/knowledge/spaces"),
        api.get<{ memories: Memory[] }>("/api/v1/memories"),
      ])
      const fallback = localItems(
        sources,
        notes,
        transcriptionSessions,
        memoryResult.status === "fulfilled" ? memoryResult.value.memories : []
      )
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
      setError("")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Knowledge could not be loaded."
      )
      setItems(localItems(sources, notes, transcriptionSessions))
    } finally {
      setLoading(false)
    }
  }, [
    notes,
    openInspector,
    projects,
    requestedItemId,
    sources,
    transcriptionSessions,
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

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
        return
      }
      void api
        .get<{ item: KnowledgeItemDetail }>(
          `/api/v1/knowledge/items/${selected.id}`
        )
        .then((result) => setSelectedDetail(result.item))
        .catch(() => setSelectedDetail(null))
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
      ? (sources.find((source) => source.id === selected.resourceId) ?? null)
      : null
  const selectedSpaceItems = selectedSpace
    ? items.filter((item) =>
        item.spaceIds?.some((id) => selectedFolderIds.has(id))
      )
    : []
  const selectedSpaceProblems = selectedSpaceItems.filter(
    (item) => item.status === "failed"
  ).length
  const selectedSpaceRepositories = selectedSpaceItems.filter(
    (item) => item.resourceType === "repository"
  ).length

  useEffect(() => {
    const timer = window.setTimeout(
      () => setMemoryDraft(selectedMemory?.content ?? ""),
      0
    )
    return () => window.clearTimeout(timer)
  }, [selectedMemory?.content])

  async function uploadFile(file: File) {
    if (!file || busy) return
    if (file.size > 25 * 1024 * 1024) {
      setNotice("Files are limited to 25 MB.")
      return
    }
    setBusy(true)
    setNotice("")
    const form = new FormData()
    form.append("file", file)
    form.append("title", file.name)
    form.append(
      "scopeType",
      selectedSpace?.visibility === "workspace" ? "organization" : "user"
    )
    if (selectedSpace) form.append("spaceId", selectedSpace.id)
    try {
      const result = await api.upload<KnowledgeSource>(
        "/api/v1/knowledge/sources",
        form
      )
      onSourcesChange([result, ...sources])
      setNotice(`${file.name} queued for indexing.`)
      await load()
      setAddOpen(false)
    } catch (caught) {
      setError(
        caught instanceof APIError
          ? caught.message
          : "The file could not be uploaded."
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

  async function addRepository(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!repositoryURL.trim() || busy) return
    setBusy(true)
    try {
      await api.post<{ repositoryId: string }>(
        "/api/v1/knowledge/repositories",
        {
          url: repositoryURL.trim(),
          ref: repositoryRef.trim() || undefined,
          accessToken: repositoryToken.trim() || undefined,
        }
      )
      setRepositoryURL("")
      setRepositoryRef("")
      setRepositoryToken("")
      setRepositoryOpen(false)
      setNotice(
        "Repository queued for indexing. You can keep chatting while it syncs."
      )
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The repository could not be connected."
      )
    } finally {
      setBusy(false)
    }
  }

  async function createSpace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!spaceName.trim() || busy) return
    setBusy(true)
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
    if (!noteTitle.trim() && !noteContent.trim()) return
    setBusy(true)
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
    if (!memoryContent.trim()) return
    setBusy(true)
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
    try {
      let item = items.find(
        (candidate) =>
          candidate.resourceType === "transcript" &&
          candidate.resourceId === transcriptSessionId
      )
      if (!item) {
        const result = await api.get<{ items: KnowledgeItem[] }>(
          "/api/v1/knowledge/items?type=transcript&limit=100"
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

  async function removeSelectedSource() {
    if (!selectedSource || busy) return
    setBusy(true)
    try {
      await api.delete(`/api/v1/knowledge/sources/${selectedSource.id}`)
      onSourcesChange(
        sources.filter((source) => source.id !== selectedSource.id)
      )
      closeInspector()
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The source could not be removed."
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

  async function syncSelectedRepository() {
    if (!selected || selected.resourceType !== "repository" || busy) return
    setBusy(true)
    try {
      await api.post(
        `/api/v1/knowledge/repositories/${selected.resourceId}/sync`
      )
      setNotice("Repository sync queued.")
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The repository could not be synced."
      )
    } finally {
      setBusy(false)
    }
  }

  async function updateRepositorySchedule(intervalMinutes: number) {
    if (!selected || selected.resourceType !== "repository" || busy) return
    setBusy(true)
    try {
      await api.patch(
        `/api/v1/knowledge/repositories/${selected.resourceId}/schedule`,
        { intervalMinutes }
      )
      setItems((current) =>
        current.map((item) =>
          item.id === selected.id
            ? {
                ...item,
                metadata: {
                  ...(item.metadata ?? {}),
                  syncIntervalMinutes: intervalMinutes,
                },
              }
            : item
        )
      )
      setSelected((current) =>
        current && current.id === selected.id
          ? {
              ...current,
              metadata: {
                ...(current.metadata ?? {}),
                syncIntervalMinutes: intervalMinutes,
              },
            }
          : current
      )
      setNotice(
        intervalMinutes
          ? "Repository schedule updated."
          : "Automatic repository sync disabled."
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The repository schedule could not be updated."
      )
    } finally {
      setBusy(false)
    }
  }

  async function deleteKnowledgeItem(item: KnowledgeItem) {
    if (!canDeleteKnowledgeItem(item) || deleteBusy) return
    setDeleteBusy(true)
    try {
      const endpoint =
        item.resourceType === "source"
          ? `/api/v1/knowledge/sources/${item.resourceId}`
          : item.resourceType === "note"
            ? `/api/v1/notes/${item.resourceId}`
            : item.resourceType === "memory"
              ? `/api/v1/memories/${item.resourceId}`
              : item.resourceType === "repository"
                ? `/api/v1/knowledge/repositories/${item.resourceId}`
                : `/api/v1/transcription/sessions/${item.resourceId}`
      await api.delete(endpoint)
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
    <div className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.csv,.md,.markdown,.txt,.html,.htm,.json,text/*,application/pdf,application/json,application/vnd.ms-excel"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void uploadFile(file)
        }}
      />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FolderKanban className="text-primary" />
            <h1 className="text-xl font-semibold tracking-tight">Storage</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Organize files, notes, repositories, and transcripts in folders that
            chats and agent workflows can use as live context.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
        </div>
      </div>

      {(error || notice) && (
        <Alert variant={error ? "destructive" : "default"}>
          {error ? <X /> : <Check />}
          <AlertTitle>
            {error ? "Knowledge action failed" : "Knowledge updated"}
          </AlertTitle>
          <AlertDescription>{error || notice}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1">
        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="gap-3 border-b px-4 py-3">
            {selectedSpace && (
              <nav
                aria-label="Folder path"
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
              >
                <button
                  className="rounded-sm px-1.5 py-1 hover:bg-muted hover:text-foreground"
                  onClick={() => setSpaceId("all")}
                  type="button"
                >
                  My files
                </button>
                {folderPath.slice(0, -1).map((folder) => (
                  <span
                    className="flex min-w-0 items-center gap-1"
                    key={folder.id}
                  >
                    <ChevronRight
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <button
                      className={cn(
                        "truncate rounded-sm px-1.5 py-1 hover:bg-muted hover:text-foreground",
                        folder.id === selectedSpace.id &&
                          "font-medium text-foreground"
                      )}
                      onClick={() => setSpaceId(folder.id)}
                      type="button"
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </nav>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="text-sm">
                  {selectedSpace?.name ?? "My files"}
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
                      {new Date(selectedSpace.updatedAt).toLocaleDateString()}
                    </span>
                    {selectedSpaceRepositories > 0 && (
                      <>
                        <span>·</span>
                        <span>
                          {selectedSpaceRepositories}{" "}
                          {selectedSpaceRepositories === 1
                            ? "repository"
                            : "repositories"}
                        </span>
                      </>
                    )}
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
              <div className="relative min-w-0 sm:col-span-2 xl:col-span-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  className="w-full pl-7"
                  placeholder="Search this folder"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search this folder"
                />
              </div>
              <Select
                value={typeFilter}
                onValueChange={(value) =>
                  setTypeFilter((value as ItemFilter) || "all")
                }
              >
                <SelectTrigger className="w-full">
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
                <SelectTrigger className="w-full" aria-label="Filter by status">
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
                onValueChange={(value) => setOwnershipFilter(value ?? "all")}
              >
                <SelectTrigger
                  className="w-full"
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
                <SelectTrigger className="w-full" aria-label="Sort knowledge">
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
            </div>
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
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  )
                    setDraggingFiles(false)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  setDraggingFiles(false)
                  const file = event.dataTransfer.files?.[0]
                  if (file) void uploadFile(file)
                }}
              >
                <button
                  className={cn(
                    "mb-5 flex w-full items-center justify-center gap-3 rounded-xl bg-card px-4 py-5 text-left shadow-xs transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
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
                        ? "Uploading file…"
                        : "Drop a file here or click to upload"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      PDF, CSV, Markdown, text, HTML or JSON · up to 25 MB
                    </span>
                  </span>
                </button>

                {loading ? (
                  <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
                    <LoaderCircle className="animate-spin" /> Loading files…
                  </div>
                ) : visibleItems.length === 0 && childSpaces.length === 0 ? (
                  <Empty className="min-h-64 border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FolderKanban />
                      </EmptyMedia>
                      <EmptyTitle>
                        {query ? "No matching files" : "This folder is empty"}
                      </EmptyTitle>
                      <EmptyDescription>
                        Upload a file, or right-click here to create a folder.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {!query.trim() &&
                      childSpaces.map((folder) => (
                        <ContextMenu key={folder.id}>
                          <ContextMenuTrigger
                            className="group flex min-w-0 cursor-pointer flex-col rounded-xl bg-card p-3 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:bg-background hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                            onDoubleClick={() => setSpaceId(folder.id)}
                          >
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <span className="flex size-12 items-center justify-center rounded-lg bg-muted text-primary">
                                <Folder className="size-7" aria-hidden="true" />
                              </span>
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
                            <button
                              className="w-full truncate text-left text-sm font-medium"
                              onClick={() => setSpaceId(folder.id)}
                              type="button"
                            >
                              {folder.name}
                            </button>
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
                          ? sources.find(
                              (candidate) => candidate.id === item.resourceId
                            )
                          : null
                      const Icon = itemIcon(item, source)
                      const pending =
                        source?.status === "queued" ||
                        source?.status === "processing"
                      return (
                        <ContextMenu key={item.id}>
                          <ContextMenuTrigger
                            className={cn(
                              "group flex min-w-0 cursor-pointer flex-col rounded-xl bg-card p-3 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:bg-background hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
                              selected?.id === item.id &&
                                "ring-2 ring-primary/30"
                            )}
                            onDoubleClick={() => openInspector(item)}
                          >
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <span className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                <Icon className="size-6" aria-hidden="true" />
                              </span>
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
                                        onClick={() => setDeleteTarget(item)}
                                      >
                                        <Trash2 /> Delete
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                            <button
                              className="w-full truncate text-left text-sm font-medium"
                              onClick={() => openInspector(item)}
                              type="button"
                            >
                              {item.title}
                            </button>
                            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span className="truncate">
                                {typeLabels[item.resourceType] ??
                                  item.resourceType}
                              </span>
                              <span>
                                {new Date(item.updatedAt).toLocaleDateString()}
                              </span>
                            </div>
                            {pending && (
                              <Progress
                                className="mt-2 h-1"
                                value={source?.progress ?? 0}
                              />
                            )}
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-44">
                            <ContextMenuGroup>
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
                <ContextMenuItem onClick={() => fileInputRef.current?.click()}>
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
                            <p className="mt-2 text-destructive">
                              {selectedSource.error}
                            </p>
                          )}
                        </div>
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
                            onClick={() => void removeSelectedSource()}
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
                    {selected.resourceType === "repository" && (
                      <div className="flex flex-col gap-3">
                        <div className="rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                          <p className="flex items-center gap-2 font-medium text-foreground">
                            <GitBranch />{" "}
                            {String(
                              selectedDetail?.provider ??
                                selected.metadata?.provider ??
                                "Repository"
                            )}
                          </p>
                          <p className="mt-2 break-all">
                            {String(
                              selectedDetail?.repositoryUrl ??
                                selected.metadata?.repositoryUrl ??
                                ""
                            )}
                          </p>
                          <p className="mt-1">
                            Ref:{" "}
                            {String(
                              selectedDetail?.ref ??
                                selected.metadata?.ref ??
                                "HEAD"
                            )}
                          </p>
                        </div>
                        {selectedDetail?.files &&
                          selectedDetail.files.length > 0 && (
                            <div className="overflow-hidden rounded-xl bg-muted/50">
                              <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                                <p className="text-sm font-medium">
                                  Indexed files
                                </p>
                                <span className="text-xs text-muted-foreground">
                                  {selectedDetail.files.length} files
                                </span>
                              </div>
                              <div className="max-h-64 overflow-auto">
                                <table className="w-full min-w-[30rem] text-xs">
                                  <thead className="sticky top-0 bg-background/95 text-left text-muted-foreground backdrop-blur">
                                    <tr className="border-b">
                                      <th className="px-3 py-2 font-medium">
                                        Path
                                      </th>
                                      <th className="px-3 py-2 font-medium">
                                        State
                                      </th>
                                      <th className="px-3 py-2 text-right font-medium">
                                        Size
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {selectedDetail.files.map((file) => (
                                      <tr
                                        className="border-b last:border-b-0"
                                        key={file.sourceId}
                                      >
                                        <td
                                          className="max-w-[20rem] truncate px-3 py-2 text-muted-foreground"
                                          title={file.path}
                                        >
                                          {file.path}
                                        </td>
                                        <td
                                          className={cn(
                                            "px-3 py-2 whitespace-nowrap",
                                            file.status === "failed" &&
                                              "text-destructive"
                                          )}
                                        >
                                          {itemStatusLabel(file.status)}
                                        </td>
                                        <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                                          {formatBytes(file.sizeBytes)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void syncSelectedRepository()}
                        >
                          <RefreshCw data-icon="inline-start" /> Sync now
                        </Button>
                        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">Sync schedule</p>
                            <p className="text-xs text-muted-foreground">
                              Refresh this repository automatically.
                            </p>
                          </div>
                          <Select
                            value={String(
                              Number(
                                selected.metadata?.syncIntervalMinutes ?? 0
                              )
                            )}
                            onValueChange={(value) =>
                              void updateRepositorySchedule(Number(value))
                            }
                          >
                            <SelectTrigger
                              className="h-8 w-28"
                              aria-label="Repository sync schedule"
                            >
                              <SelectValue>
                                {Number(
                                  selected.metadata?.syncIntervalMinutes ?? 0
                                ) === 60
                                  ? "Hourly"
                                  : Number(
                                        selected.metadata
                                          ?.syncIntervalMinutes ?? 0
                                      ) === 1440
                                    ? "Daily"
                                    : Number(
                                          selected.metadata
                                            ?.syncIntervalMinutes ?? 0
                                        ) === 10080
                                      ? "Weekly"
                                      : "Manual"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">Manual</SelectItem>
                              <SelectItem value="60">Hourly</SelectItem>
                              <SelectItem value="1440">Daily</SelectItem>
                              <SelectItem value="10080">Weekly</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
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
            <AddKnowledgeOption
              icon={GitBranch}
              title="Connect a repository"
              description="Keep GitHub or GitLab code searchable by the AI"
              onClick={() => {
                setAddOpen(false)
                setRepositoryOpen(true)
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
              <Label>Parent folder</Label>
              <Select
                value={spaceParentId}
                onValueChange={(value) => setSpaceParentId(value ?? "root")}
              >
                <SelectTrigger>
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
              <Label>Visibility</Label>
              <Select
                value={spaceVisibility}
                onValueChange={(value) =>
                  setSpaceVisibility(
                    (value as "private" | "workspace") || "private"
                  )
                }
              >
                <SelectTrigger>
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
            <div className="py-4">
              <Textarea
                autoFocus
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

      <Dialog open={repositoryOpen} onOpenChange={setRepositoryOpen}>
        <DialogContent>
          <form onSubmit={addRepository}>
            <DialogHeader>
              <DialogTitle>Connect a repository</DialogTitle>
              <DialogDescription>
                JustAI fetches supported text files and keeps the index in your
                private Knowledge library.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 py-4">
              <Label htmlFor="knowledge-repository-url">Repository URL</Label>
              <Input
                id="knowledge-repository-url"
                type="url"
                value={repositoryURL}
                onChange={(event) => setRepositoryURL(event.target.value)}
                placeholder="https://github.com/org/repository"
              />
              <Label htmlFor="knowledge-repository-ref">
                Branch or ref{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="knowledge-repository-ref"
                value={repositoryRef}
                onChange={(event) => setRepositoryRef(event.target.value)}
                placeholder="main"
              />
              <Label htmlFor="knowledge-repository-token">
                Access token{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="knowledge-repository-token"
                type="password"
                value={repositoryToken}
                onChange={(event) => setRepositoryToken(event.target.value)}
                placeholder="Used only for this private repository"
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRepositoryOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !repositoryURL.trim()}>
                {busy ? "Connecting…" : "Connect repository"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget ? (typeLabels[deleteTarget.resourceType] ?? "item").toLocaleLowerCase() : "item"}?`}
        description={
          deleteTarget
            ? `“${deleteTarget.title}” will be permanently removed from Knowledge. This action cannot be undone.`
            : "This action cannot be undone."
        }
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
    </div>
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
