"use client"

import { useCallback, useEffect, useState } from "react"
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
import type { Note } from "@/lib/types"
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set("q", query.trim())
      const response = await api.get<{ notes: Note[] }>(
        `/api/v1/notes${params.size ? `?${params.toString()}` : ""}`
      )
      setNotes(response.notes)
      onNotesChange?.(response.notes)
      const next = response.notes[0] ?? null
      setSelectedId(next?.id ?? null)
      setTitle(next?.title ?? "")
      setContent(next?.content ?? "")
      setVisibility(next?.visibility === "workspace" ? "workspace" : "private")
      setError("")
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Notes could not be loaded."
      )
    } finally {
      setLoading(false)
    }
  }, [onNotesChange, query])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const selected = notes.find((note) => note.id === selectedId) ?? null

  function selectNote(note: Note) {
    setSelectedId(note.id)
    setTitle(note.title)
    setContent(note.content)
    setVisibility(note.visibility === "workspace" ? "workspace" : "private")
  }

  async function createNote() {
    if (saving) return
    setSaving(true)
    try {
      const response = await api.post<{ note: Note }>("/api/v1/notes", {
        title: "Untitled note",
        content: "",
      })
      setNotes((current) => [response.note, ...current])
      onNotesChange?.([response.note, ...notes])
      selectNote(response.note)
      setError("")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The note could not be created."
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
      setNotes((current) =>
        current.map((note) => (note.id === selected.id ? response.note : note))
      )
      onNotesChange?.(
        notes.map((note) => (note.id === selected.id ? response.note : note))
      )
      setError("")
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The note could not be saved."
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
      setNotes((current) =>
        current.map((note) => (note.id === selected.id ? response.note : note))
      )
      onNotesChange?.(
        notes.map((note) => (note.id === selected.id ? response.note : note))
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The note could not be updated."
      )
    } finally {
      setSaving(false)
    }
  }

  async function deleteNote() {
    if (!selected || saving) return
    try {
      await api.delete(`/api/v1/notes/${selected.id}`)
      const remaining = notes.filter((note) => note.id !== selected.id)
      setNotes(remaining)
      onNotesChange?.(remaining)
      if (remaining[0]) selectNote(remaining[0])
      else {
        setSelectedId(null)
        setTitle("")
        setContent("")
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The note could not be deleted."
      )
    }
  }

  return (
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
            Keep durable working notes, then bring any note back into a chat as
            context.
          </p>
        </div>
        <Button onClick={() => void createNote()} disabled={saving}>
          <Plus data-icon="inline-start" />
          New note
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
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
              <p className="p-4 text-center text-xs text-muted-foreground">
                Loading notes…
              </p>
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
                    className={`rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted ${
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
                    onClick={() => void togglePin()}
                    size="icon-sm"
                    title={selected.pinnedAt ? "Unpin note" : "Pin note"}
                    variant="ghost"
                  >
                    {selected.pinnedAt ? <PinOff /> : <Pin />}
                  </Button>
                  {selected.canManage && (
                    <Button
                      onClick={() => void deleteNote()}
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
                <Input
                  aria-label="Note title"
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Note title"
                  value={title}
                />
                {selected.canManage && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
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
                    <Select
                      onValueChange={(value) =>
                        setVisibility(value as "private" | "workspace")
                      }
                      value={visibility}
                    >
                      <SelectTrigger className="w-36" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="private">Private</SelectItem>
                        <SelectItem value="workspace">Workspace</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Textarea
                  aria-label="Note content"
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
                        onClick={() =>
                          void onUseInChat({ ...selected, title, content })
                        }
                        variant="outline"
                      >
                        Use in chat
                      </Button>
                    )}
                    <Button disabled={saving} onClick={() => void saveNote()}>
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
  )
}
