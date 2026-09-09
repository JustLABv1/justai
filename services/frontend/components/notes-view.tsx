"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  FileText,
  LockKeyhole,
  Pin,
  PinOff,
  Plus,
  Save,
  Share2,
  Trash2,
} from "lucide-react"

import { api } from "@/lib/api"
import { notifyError, notifySuccess } from "@/lib/feedback"
import type { Note } from "@/lib/types"
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmActionDialog } from "@/components/confirm-action-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type NotesViewProps = {
  onUseInChat?: (note: Note) => void | Promise<void>
  onNotesChange?: (notes: Note[]) => void
}

export function NotesView({ onUseInChat, onNotesChange }: NotesViewProps) {
  const searchParams = useSearchParams()
  const initialNoteId = searchParams.get("note")
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [visibility, setVisibility] = useState<"private" | "workspace">(
    "private"
  )
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [loadError, setLoadError] = useState("")
  const [pendingNote, setPendingNote] = useState<Note | null>(null)
  const [discardCreateOpen, setDiscardCreateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const notesRef = useRef<Note[]>([])
  const selectedIdRef = useRef<string | null>(null)
  const isDirtyRef = useRef(false)
  const requestIdRef = useRef(0)

  const selected = notes.find((note) => note.id === selectedId) ?? null
  const isDirty = Boolean(
    selected &&
    (title !== selected.title ||
      content !== selected.content ||
      (selected.canManage && visibility !== selected.visibility))
  )
  useEffect(() => {
    notesRef.current = notes
    selectedIdRef.current = selectedId
    isDirtyRef.current = isDirty
  }, [isDirty, notes, selectedId])

  const updateNotes = useCallback(
    (updater: (current: Note[]) => Note[]) => {
      const next = updater(notesRef.current)
      notesRef.current = next
      setNotes(next)
      onNotesChange?.(next)
    },
    [onNotesChange]
  )

  function applySelectedNote(note: Note | null) {
    setSelectedId(note?.id ?? null)
    setTitle(note?.title ?? "")
    setContent(note?.content ?? "")
    setVisibility(note?.visibility === "workspace" ? "workspace" : "private")
  }

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (query.trim()) params.set("q", query.trim())
        const response = await api.get<{ notes: Note[] }>(
          `/api/v1/notes${params.size ? `?${params.toString()}` : ""}`,
          { signal }
        )
        if (requestId !== requestIdRef.current || signal?.aborted) return
        const currentId = selectedIdRef.current ?? initialNoteId
        const currentBaseline = notesRef.current.find(
          (note) => note.id === currentId
        )
        const currentStillExists = response.notes.some(
          (note) => note.id === currentId
        )
        // Keep the editor mounted while a dirty note is filtered out. The
        // selected note is added back to the list until the draft is saved.
        const nextNotes =
          isDirtyRef.current && currentBaseline && !currentStillExists
            ? [currentBaseline, ...response.notes]
            : response.notes
        updateNotes(() => nextNotes)
        const next =
          nextNotes.find((note) => note.id === currentId) ??
          nextNotes[0] ??
          null
        if (!isDirtyRef.current || !currentId || !currentBaseline)
          applySelectedNote(next)
        setLoadError("")
        setError("")
      } catch (caught) {
        if (signal?.aborted) return
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "Notes could not be loaded."
        )
        setError(
          caught instanceof Error
            ? caught.message
            : "Notes could not be loaded."
        )
      } finally {
        if (requestId === requestIdRef.current && !signal?.aborted) {
          setLoading(false)
        }
      }
    },
    [initialNoteId, query, updateNotes]
  )

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void load(controller.signal)
    }, 0)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [load])

  function selectNote(note: Note) {
    if (note.id === selectedId) return
    if (isDirty) {
      setPendingNote(note)
      return
    }
    applySelectedNote(note)
  }

  async function createNote(force = false) {
    if (isDirty && !force) {
      setDiscardCreateOpen(true)
      return
    }
    if (saving) return
    setSaving(true)
    try {
      const response = await api.post<{ note: Note }>("/api/v1/notes", {
        title: "Untitled note",
        content: "",
      })
      updateNotes((current) => [response.note, ...current])
      applySelectedNote(response.note)
      notifySuccess("Note created")
      setError("")
    } catch (caught) {
      setError(
        notifyError(
          "Note could not be created",
          caught,
          "The note could not be created."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function saveNote() {
    if (!selected || saving) return
    setSaving(true)
    try {
      const response = await api.patch<{ note: Note }>(
        `/api/v1/notes/${selected.id}`,
        {
          title: title.trim() || "Untitled note",
          content,
          ...(selected.canManage ? { visibility } : {}),
        }
      )
      updateNotes((current) =>
        current.map((note) => (note.id === selected.id ? response.note : note))
      )
      applySelectedNote(response.note)
      notifySuccess("Note saved")
      setError("")
    } catch (caught) {
      setError(
        notifyError(
          "Note could not be saved",
          caught,
          "The note could not be saved."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function togglePin() {
    if (!selected || saving) return
    setSaving(true)
    try {
      const response = await api.patch<{ note: Note }>(
        `/api/v1/notes/${selected.id}`,
        {
          pinned: !selected.pinnedAt,
        }
      )
      updateNotes((current) =>
        current.map((note) => (note.id === selected.id ? response.note : note))
      )
      applySelectedNote(response.note)
      notifySuccess(selected.pinnedAt ? "Note unpinned" : "Note pinned")
      setError("")
    } catch (caught) {
      setError(
        notifyError(
          "Note could not be updated",
          caught,
          "The note could not be updated."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function deleteNote() {
    if (!selected || saving) return
    setSaving(true)
    try {
      await api.delete(`/api/v1/notes/${selected.id}`)
      const remaining = notesRef.current.filter(
        (note) => note.id !== selected.id
      )
      updateNotes(() => remaining)
      applySelectedNote(remaining[0] ?? null)
      setDeleteOpen(false)
      notifySuccess("Note deleted")
      setError("")
    } catch (caught) {
      setError(
        notifyError(
          "Note could not be deleted",
          caught,
          "The note could not be deleted."
        )
      )
    } finally {
      setSaving(false)
    }
  }

  async function addSelectedToChat() {
    if (!selected || !onUseInChat) return
    try {
      await onUseInChat({ ...selected, title, content })
    } catch (caught) {
      setError(
        notifyError(
          "Note could not be added to chat",
          caught,
          "The note could not be added to chat."
        )
      )
    }
  }

  return (
    <>
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="size-5 text-primary" />
              <h1 className="text-xl font-semibold tracking-tight">
                Notes workspace
              </h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Keep durable working notes, then bring any note back into a chat
              as context.
            </p>
          </div>
          <Button onClick={() => void createNote()} disabled={saving}>
            <Plus data-icon="inline-start" />
            New note
          </Button>
        </div>

        {error && (
          <Alert aria-live="polite" role="alert" variant="destructive">
            <AlertTitle>Notes action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid min-h-[34rem] gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Card className="min-h-0 overflow-hidden">
            <CardHeader className="gap-3 border-b">
              <CardTitle className="text-base">Workspace notes</CardTitle>
              <Input
                aria-label="Search notes"
                onChange={(event) => {
                  setQuery(event.target.value)
                }}
                placeholder="Search notes"
                type="search"
                value={query}
              />
            </CardHeader>
            <CardContent className="min-h-0 overflow-y-auto p-2">
              {loading ? (
                <p
                  aria-live="polite"
                  className="p-4 text-center text-xs text-muted-foreground"
                  role="status"
                >
                  Loading notes…
                </p>
              ) : loadError ? (
                <div className="flex flex-col items-center gap-3 p-6 text-center">
                  <p
                    aria-live="polite"
                    className="text-sm text-destructive"
                    role="alert"
                  >
                    Notes could not be loaded: {loadError}
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
              ) : notes.length === 0 ? (
                <Empty className="min-h-48 border-0 p-4">
                  <EmptyHeader>
                    <EmptyTitle>No notes yet</EmptyTitle>
                    <EmptyDescription>
                      Create a note to start a workspace.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col gap-1">
                  {notes.map((note) => (
                    <button
                      aria-pressed={note.id === selectedId}
                      className={`min-h-11 rounded-lg px-3 py-2 text-left transition-[background-color,color,transform] duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.99] ${
                        note.id === selectedId ? "bg-muted" : ""
                      }`}
                      key={note.id}
                      onClick={() => selectNote(note)}
                      type="button"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="min-w-0 flex-1 truncate">
                          {note.title || "Untitled note"}
                        </span>
                        {note.pinnedAt && (
                          <Pin className="size-3 shrink-0 text-primary" />
                        )}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {note.content || "Empty note"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="min-h-0">
            {selected ? (
              <>
                <CardHeader className="flex-row items-start justify-between gap-3 border-b">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base">Edit note</CardTitle>
                    <CardDescription>
                      Updated {new Date(selected.updatedAt).toLocaleString()}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      aria-label={selected.pinnedAt ? "Unpin note" : "Pin note"}
                      onClick={() => void togglePin()}
                      size="icon-sm"
                      title={selected.pinnedAt ? "Unpin note" : "Pin note"}
                      variant="ghost"
                    >
                      {selected.pinnedAt ? <PinOff /> : <Pin />}
                    </Button>
                    {selected.canManage && (
                      <Button
                        aria-label="Delete note"
                        onClick={() => setDeleteOpen(true)}
                        size="icon-sm"
                        title="Delete note"
                        variant="ghost"
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex min-h-0 flex-col gap-4 pt-5">
                  <label className="sr-only" htmlFor="notes-editor-title">
                    Note title
                  </label>
                  <Input
                    id="notes-editor-title"
                    maxLength={200}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Note title"
                    value={title}
                  />
                  {selected.canManage && (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 px-3 py-2">
                      {visibility === "workspace" ? (
                        <Share2 className="size-4 text-primary" />
                      ) : (
                        <LockKeyhole className="size-4 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium">Note visibility</p>
                        <p className="text-[11px] text-muted-foreground">
                          Workspace notes can be read and edited by members.
                        </p>
                      </div>
                      <label
                        className="sr-only"
                        htmlFor="notes-editor-visibility"
                      >
                        Note visibility
                      </label>
                      <Select
                        onValueChange={(value) =>
                          setVisibility(value as "private" | "workspace")
                        }
                        value={visibility}
                      >
                        <SelectTrigger
                          className="w-36"
                          id="notes-editor-visibility"
                          size="sm"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="private">Private</SelectItem>
                          <SelectItem value="workspace">Workspace</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <label className="sr-only" htmlFor="notes-editor-content">
                    Note content
                  </label>
                  <Textarea
                    id="notes-editor-content"
                    className="min-h-72 flex-1"
                    maxLength={100000}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="Write your note… Markdown is supported when you bring it into chat."
                    value={content}
                  />
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      {content.length} characters
                    </span>
                    <div className="flex items-center gap-2">
                      {onUseInChat && (
                        <Button
                          onClick={() => void addSelectedToChat()}
                          type="button"
                          variant="outline"
                        >
                          Use in chat
                        </Button>
                      )}
                      <Button
                        disabled={saving || !isDirty}
                        onClick={() => void saveNote()}
                        type="button"
                      >
                        <Save data-icon="inline-start" />
                        {saving ? "Saving…" : "Save note"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </>
            ) : (
              <Empty className="h-full min-h-72 border-0">
                <EmptyHeader>
                  <EmptyTitle>Select a note</EmptyTitle>
                  <EmptyDescription>
                    Choose a note or create a new one.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </Card>
        </div>
      </div>

      <AlertDialog
        open={pendingNote !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNote(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to “{selected?.title || "Untitled note"}” have not
              been saved. Switching notes will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                applySelectedNote(pendingNote)
                setPendingNote(null)
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardCreateOpen} onOpenChange={setDiscardCreateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new note?</AlertDialogTitle>
            <AlertDialogDescription>
              Save your current note first, or discard the unsaved changes to
              continue with a new note.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardCreateOpen(false)
                void createNote(true)
              }}
            >
              Discard and create
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmActionDialog
        open={Boolean(selected && deleteOpen)}
        title="Delete this note?"
        description={`“${selected?.title || "Untitled note"}” will be permanently removed. This action cannot be undone.`}
        confirmLabel="Delete note"
        pending={saving}
        onOpenChange={(open) => {
          if (!open && !saving) setDeleteOpen(false)
        }}
        onConfirm={deleteNote}
      />
    </>
  )
}
