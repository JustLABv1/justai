"use client"

import { useMemo, useState } from "react"
import { Bot, Pencil, Plus, Sparkles, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type { Endpoint, SavedAssistant } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

type AssistantForm = {
  name: string
  description: string
  instructions: string
  endpointId: string
  model: string
  visibility: "private" | "workspace"
  useMemory: boolean
  deepContext: boolean
}

type AssistantTemplate = Partial<AssistantForm> & {
  name: string
  description: string
  instructions: string
}

type AssistantsViewProps = {
  assistants: SavedAssistant[]
  endpoints: Endpoint[]
  onChange: (assistants: SavedAssistant[]) => void
}

const emptyForm: AssistantForm = {
  name: "",
  description: "",
  instructions: "",
  endpointId: "",
  model: "",
  visibility: "private",
  useMemory: true,
  deepContext: false,
}

const templates: AssistantTemplate[] = [
  {
    name: "Meeting Editor",
    description:
      "Turn transcripts into clear summaries, decisions, and action items.",
    instructions:
      "Act as a precise meeting editor. Prefer concise summaries, clearly separate decisions from open questions, and extract action items with an owner and deadline when the transcript supports them. Do not invent details that are not present in the transcript.",
    useMemory: true,
  },
  {
    name: "Codebase Analyst",
    description:
      "Explain architecture and implementation details using repository context.",
    instructions:
      "Act as a senior codebase analyst. Ground claims in the attached repository, name relevant files when useful, distinguish observed behavior from inference, and call out uncertainty. Prefer actionable explanations over broad tutorials.",
    useMemory: true,
    deepContext: true,
  },
  {
    name: "Research Brief",
    description:
      "Produce structured, source-aware briefs from attached material.",
    instructions:
      "Act as a research editor. Start with the answer, organize evidence into clear sections, distinguish facts from interpretation, and cite attached sources naturally. Surface gaps instead of filling them with speculation.",
    useMemory: false,
  },
]

export function AssistantsView({
  assistants,
  endpoints,
  onChange,
}: AssistantsViewProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<AssistantForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const chatEndpoints = useMemo(
    () =>
      endpoints.filter(
        (endpoint) => endpoint.enabled && endpoint.capabilities?.chat
      ),
    [endpoints]
  )

  function openCreate(template?: AssistantTemplate) {
    setEditingId(null)
    setForm({ ...emptyForm, ...template })
    setError("")
    setDialogOpen(true)
  }

  function openEdit(assistant: SavedAssistant) {
    setEditingId(assistant.id)
    setForm({
      name: assistant.name,
      description: assistant.description,
      instructions: assistant.instructions,
      endpointId: assistant.endpointId ?? "",
      model: assistant.model ?? "",
      visibility:
        assistant.visibility === "workspace" ? "workspace" : "private",
      useMemory: assistant.useMemory,
      deepContext: assistant.deepContext,
    })
    setError("")
    setDialogOpen(true)
  }

  async function saveAssistant() {
    if (!form.name.trim()) {
      setError("Give this assistant a name.")
      return
    }
    setSaving(true)
    setError("")
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      endpointId: form.endpointId,
      model: form.model.trim(),
      visibility: form.visibility,
      useMemory: form.useMemory,
      deepContext: form.deepContext,
    }
    try {
      const response = editingId
        ? await api.patch<{ assistant: SavedAssistant }>(
            `/api/v1/assistants/${editingId}`,
            payload
          )
        : await api.post<{ assistant: SavedAssistant }>(
            "/api/v1/assistants",
            payload
          )
      onChange(
        editingId
          ? assistants.map((assistant) =>
              assistant.id === editingId ? response.assistant : assistant
            )
          : [response.assistant, ...assistants]
      )
      setDialogOpen(false)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The assistant could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }

  async function deleteAssistant(assistant: SavedAssistant) {
    if (
      !window.confirm(
        `Delete “${assistant.name}”? Existing conversations will keep their pinned version.`
      )
    ) {
      return
    }
    setError("")
    try {
      await api.delete(`/api/v1/assistants/${assistant.id}`)
      onChange(assistants.filter((item) => item.id !== assistant.id))
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The assistant could not be deleted."
      )
    }
  }

  function endpointName(endpointId?: string | null) {
    return (
      chatEndpoints.find((endpoint) => endpoint.id === endpointId)?.name ??
      "Workspace default"
    )
  }

  return (
    <div className="min-h-full w-full bg-muted/10 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
              Reusable behavior
            </p>
            <h1 className="font-heading mt-2 text-3xl font-semibold tracking-tight">
              Saved assistants
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Save instructions, memory defaults, context behavior, and model
              preferences for the kinds of work you repeat.
            </p>
          </div>
          <Button onClick={() => openCreate()}>
            <Plus data-icon="inline-start" />
            New assistant
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Assistant action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {assistants.length === 0 ? (
          <Card className="min-h-80">
            <CardContent className="flex min-h-80 flex-col items-center justify-center gap-5 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles aria-hidden="true" />
              </span>
              <div className="flex max-w-md flex-col gap-1">
                <h2 className="text-base font-semibold">
                  Start with a focused role
                </h2>
                <p className="text-sm text-muted-foreground">
                  These starters are editable. Pick one to make your first saved
                  assistant, or build one from scratch.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {templates.map((template) => (
                  <Button
                    key={template.name}
                    variant="outline"
                    onClick={() => openCreate(template)}
                  >
                    {template.name}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {assistants.map((assistant) => (
              <Card key={assistant.id}>
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                      <Bot aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <CardTitle className="truncate">
                        {assistant.name}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {assistant.description || "No description yet."}
                      </CardDescription>
                    </div>
                  </div>
                  <CardAction className="flex gap-1">
                    <Button
                      aria-label={`Edit ${assistant.name}`}
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => openEdit(assistant)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      aria-label={`Delete ${assistant.name}`}
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void deleteAssistant(assistant)}
                    >
                      <Trash2 />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {assistant.visibility === "workspace"
                      ? "Workspace"
                      : "Private"}
                  </Badge>
                  <Badge variant="secondary">
                    {endpointName(assistant.endpointId)}
                  </Badge>
                  {assistant.useMemory && (
                    <Badge variant="secondary">Memory on</Badge>
                  )}
                  {assistant.deepContext && (
                    <Badge variant="secondary">Deep context default</Badge>
                  )}
                </CardContent>
                <CardFooter className="border-t text-muted-foreground">
                  <span>Version {assistant.version}</span>
                  <span className="ml-auto">Ready for new chats</span>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[min(860px,calc(100vh-2rem))] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "Edit saved assistant" : "New saved assistant"}
            </DialogTitle>
            <DialogDescription>
              This configuration is applied when you start a new conversation
              with the assistant.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="assistant-name">Name</FieldLabel>
              <Input
                id="assistant-name"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Meeting Editor"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="assistant-description">
                Description
              </FieldLabel>
              <Input
                id="assistant-description"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                placeholder="What this assistant is best at"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="assistant-instructions">
                Instructions
              </FieldLabel>
              <Textarea
                id="assistant-instructions"
                rows={8}
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                placeholder="Describe the role, priorities, tone, and boundaries."
              />
              <FieldDescription>
                These instructions are kept on the backend and added to the
                system context for this assistant.
              </FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Default endpoint</FieldLabel>
                <Select
                  value={form.endpointId || "workspace-default"}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      endpointId:
                        value === "workspace-default" ? "" : (value ?? ""),
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workspace-default">
                      Use workspace default
                    </SelectItem>
                    {chatEndpoints.map((endpoint) => (
                      <SelectItem key={endpoint.id} value={endpoint.id}>
                        {endpoint.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="assistant-model">Default model</FieldLabel>
                <Input
                  id="assistant-model"
                  value={form.model}
                  onChange={(event) =>
                    setForm({ ...form, model: event.target.value })
                  }
                  placeholder="Use endpoint default"
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field orientation="horizontal" className="rounded-lg border p-3">
                <FieldLabel htmlFor="assistant-memory">Use memory</FieldLabel>
                <Switch
                  id="assistant-memory"
                  checked={form.useMemory}
                  onCheckedChange={(useMemory) =>
                    setForm({ ...form, useMemory })
                  }
                />
              </Field>
              <Field orientation="horizontal" className="rounded-lg border p-3">
                <FieldLabel htmlFor="assistant-deep-context">
                  Deep context default
                </FieldLabel>
                <Switch
                  id="assistant-deep-context"
                  checked={form.deepContext}
                  onCheckedChange={(deepContext) =>
                    setForm({ ...form, deepContext })
                  }
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Visibility</FieldLabel>
              <Select
                value={form.visibility}
                onValueChange={(value) =>
                  value &&
                  setForm({
                    ...form,
                    visibility: value as AssistantForm["visibility"],
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private · only me</SelectItem>
                  <SelectItem value="workspace">
                    Workspace · available to members
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void saveAssistant()}>
              {saving
                ? "Saving…"
                : editingId
                  ? "Save changes"
                  : "Create assistant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
