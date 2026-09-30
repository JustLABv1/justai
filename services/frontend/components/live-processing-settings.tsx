"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "@/components/ui/select"
import type { Endpoint } from "@/lib/types"
import type { LiveTranscriptionSnapshot } from "./live-transcription-orbit"
import { api } from "@/lib/api"

export function LiveProcessingSettings({
  snapshot,
  diarizationEndpoints,
  grammarEndpoints,
  onChange,
}: {
  snapshot: LiveTranscriptionSnapshot
  diarizationEndpoints: Endpoint[]
  grammarEndpoints: Endpoint[]
  onChange: (next: LiveTranscriptionSnapshot) => void
}) {
  const [open, setOpen] = useState(false)
  const [diarization, setDiarization] = useState(
    snapshot.session.diarizationEndpointId || "none"
  )
  const [grammar, setGrammar] = useState(
    snapshot.session.grammarEndpointId || "none"
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const save = async () => {
    setBusy(true)
    setError("")
    try {
      const next = await api.put<LiveTranscriptionSnapshot>(
        `/api/v1/transcription/sessions/${snapshot.session.id}/processing`,
        {
          diarizationEndpointId: diarization === "none" ? "" : diarization,
          grammarEndpointId: grammar === "none" ? "" : grammar,
        }
      )
      onChange(next)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settings could not be saved.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value)
          setDiarization(snapshot.session.diarizationEndpointId || "none")
          setGrammar(snapshot.session.grammarEndpointId || "none")
          setError("")
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Processing settings
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>After capture ends</DialogTitle>
          <DialogDescription>
            Recognize speakers first, then polish the transcript automatically.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {[
            {
              label: "Speaker separation",
              capability: "diarization" as const,
              value: diarization,
              set: setDiarization,
            },
            {
              label: "Grammar polish",
              capability: "chat" as const,
              value: grammar,
              set: setGrammar,
            },
          ].map((field) => {
            const choices =
              field.capability === "diarization"
                ? diarizationEndpoints
                : grammarEndpoints
            return (
              <Field key={field.label}>
                <FieldLabel>{field.label}</FieldLabel>
                <Select
                  value={field.value}
                  onValueChange={(v) => field.set(v || "none")}
                  items={[
                    { value: "none", label: "Off" },
                    ...choices.map((e) => ({ value: e.id, label: e.name })),
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{field.label}</SelectLabel>
                      <SelectItem value="none">Off</SelectItem>
                      {choices.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {field.capability === "diarization" ? (
                  <FieldDescription>
                    Audio recording is automatically enabled for speaker
                    separation.
                  </FieldDescription>
                ) : null}
              </Field>
            )
          })}
        </FieldGroup>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
