"use client"

import { useState } from "react"
import { api } from "@/lib/api"
import { downloadFile } from "@/lib/download-file"
import type { AgentArtifact, AgentRun, KnowledgeSpace } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"

export function RunFiles({ run }: { run: AgentRun }) {
  const [selected, setSelected] = useState<AgentArtifact | null>(null)
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([])
  const [folder, setFolder] = useState("personal")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const path = (file: AgentArtifact) =>
    `/api/v1/agent-runs/${run.id}/artifacts/${file.id}`
  async function openSave(file: AgentArtifact) {
    setError("")
    setNotice("")
    setBusy(true)
    try {
      const result = await api.get<{ spaces: KnowledgeSpace[] }>(
        "/api/v1/knowledge/spaces"
      )
      setSpaces(result.spaces)
      setFolder("personal")
      setSelected(file)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Folders could not be loaded."
      )
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    if (!selected || busy) return
    setBusy(true)
    setError("")
    try {
      const blob = await api.getBlob(path(selected))
      const form = new FormData()
      form.append(
        "file",
        new Blob([blob], { type: selected.mimeType }),
        selected.name
      )
      form.append("title", selected.name)
      form.append(
        "scopeType",
        spaces.find((space) => space.id === folder)?.visibility === "workspace"
          ? "organization"
          : "user"
      )
      if (folder !== "personal") form.append("spaceId", folder)
      await api.upload("/api/v1/knowledge/sources", form)
      setNotice(`${selected.name} saved to knowledge and queued for indexing.`)
      setSelected(null)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "File could not be saved."
      )
    } finally {
      setBusy(false)
    }
  }
  if (!run.artifacts?.length) return null
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="font-medium">Output files</h3>
        <p className="text-xs text-muted-foreground">
          Download files or keep a copy in your knowledge storage.
        </p>
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && !selected && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {run.artifacts.map((file) => (
        <div
          key={file.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {file.mimeType} · {Math.max(1, Math.ceil(file.sizeBytes / 1024))}{" "}
              KB
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {file.kind === "file_reference" ? "Reference" : "File"}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError("")
                try {
                  await downloadFile(path(file), file.name)
                } catch (error) {
                  setError(
                    error instanceof Error ? error.message : "Download failed."
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              Download
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || file.kind === "file_reference"}
              onClick={() => void openSave(file)}
            >
              Save to knowledge
            </Button>
          </div>
        </div>
      ))}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setSelected(null)
            setError("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to knowledge</DialogTitle>
            <DialogDescription>
              Save {selected?.name} as an original file and index its readable
              content.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel>Destination folder</FieldLabel>
            <Select
              value={folder}
              disabled={busy}
              onValueChange={(value) => setFolder(value ?? "personal")}
            >
              <SelectTrigger aria-label="Destination folder">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="personal">Personal storage</SelectItem>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name} ·{" "}
                      {space.visibility === "workspace"
                        ? "Workspace"
                        : "Private"}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Workspace folders share the saved copy with your workspace.
              Existing folder permissions apply.
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
