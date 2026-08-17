"use client"

import { useCallback, useEffect, useState } from "react"
import { Brain, Plus, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type { Memory } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

export function MemoryView() {
  const [memories, setMemories] = useState<Memory[]>([])
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await api.get<{ memories: Memory[] }>("/api/v1/memories")
      setMemories(response.memories)
      setError("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Memories could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  async function addMemory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = content.trim()
    if (!value || saving) return
    setSaving(true)
    try {
      const response = await api.post<{ memory: Memory }>("/api/v1/memories", {
        content: value,
        source: "manual",
      })
      setMemories((current) => [response.memory, ...current])
      setContent("")
      setError("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The memory could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  async function toggleMemory(memory: Memory, enabled: boolean) {
    try {
      const response = await api.patch<{ memory: Memory }>(
        `/api/v1/memories/${memory.id}`,
        { enabled }
      )
      setMemories((current) =>
        current.map((item) => (item.id === memory.id ? response.memory : item))
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The memory could not be updated.")
    }
  }

  async function removeMemory(memory: Memory) {
    try {
      await api.delete(`/api/v1/memories/${memory.id}`)
      setMemories((current) => current.filter((item) => item.id !== memory.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The memory could not be deleted.")
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div>
        <div className="flex items-center gap-2">
          <Brain className="size-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">Persistent memory</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Save stable preferences and facts you want JustAI to use in future chats.
          You can disable or remove any memory at any time.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Memory action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a memory</CardTitle>
          <CardDescription>
            Keep it concise, for example: “I prefer concise answers in German.”
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={addMemory}>
            <Field>
              <FieldLabel htmlFor="new-memory">Memory</FieldLabel>
              <Textarea
                id="new-memory"
                maxLength={2000}
                onChange={(event) => setContent(event.target.value)}
                placeholder="What should JustAI remember?"
                value={content}
              />
              <FieldDescription>{content.length}/2000 characters</FieldDescription>
            </Field>
            <Button className="w-fit" disabled={saving || !content.trim()} type="submit">
              <Plus data-icon="inline-start" />
              {saving ? "Saving…" : "Save memory"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {loading ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Loading memories…
        </div>
      ) : memories.length === 0 ? (
        <Empty className="min-h-52">
          <EmptyHeader>
            <EmptyTitle>No memories saved</EmptyTitle>
            <EmptyDescription>
              Add a preference or recurring detail and it will be available in later chats.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {memories.map((memory) => (
            <Card key={memory.id} size="sm">
              <CardContent className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-sm leading-6">{memory.content}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{memory.source}</Badge>
                    <span className="text-xs text-muted-foreground">
                      Updated {new Date(memory.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    aria-label={`${memory.enabled ? "Disable" : "Enable"} memory`}
                    checked={memory.enabled}
                    onCheckedChange={(checked) => void toggleMemory(memory, checked)}
                  />
                  <Button
                    aria-label="Delete memory"
                    onClick={() => void removeMemory(memory)}
                    size="icon-sm"
                    title="Delete memory"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
