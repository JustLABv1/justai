"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, ImagePlus, Loader2, Sparkles } from "lucide-react"
import Image from "next/image"

import { api } from "@/lib/api"
import type { Endpoint, GeneratedImage } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

type ImageStudioDialogProps = {
  endpoints: Endpoint[]
}

export function ImageStudioDialog({ endpoints }: ImageStudioDialogProps) {
  const imageEndpoints = useMemo(
    () => endpoints.filter((endpoint) => endpoint.enabled && endpoint.capabilities["image-generation"]),
    [endpoints]
  )
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"generate" | "edit">("generate")
  const [endpointId, setEndpointId] = useState("")
  const [prompt, setPrompt] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [image, setImage] = useState<GeneratedImage | null>(null)
  const [imageSrc, setImageSrc] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    return () => {
      if (imageSrc.startsWith("blob:")) URL.revokeObjectURL(imageSrc)
    }
  }, [imageSrc])

  async function loadImagePreview(value: GeneratedImage) {
    const blob = await api.getBlob(value.url)
    const nextURL = URL.createObjectURL(blob)
    setImageSrc(nextURL)
  }

  async function submit() {
    if (!prompt.trim() || saving) return
    if (imageEndpoints.length === 0) {
      setError("Configure an enabled image-generation endpoint in Settings first.")
      return
    }
    const selectedEndpointId = endpointId || imageEndpoints[0].id
    setSaving(true)
    setError("")
    try {
      if (mode === "generate") {
        const response = await api.post<{ image: GeneratedImage }>("/api/v1/images/generate", {
          endpointId: selectedEndpointId,
          prompt: prompt.trim(),
        })
        await loadImagePreview(response.image)
        setImage(response.image)
      } else {
        if (!file) {
          setError("Choose an image to edit.")
          return
        }
        const body = new FormData()
        body.set("endpointId", selectedEndpointId)
        body.set("prompt", prompt.trim())
        body.set("image", file)
        const response = await api.upload<{ image: GeneratedImage }>("/api/v1/images/edit", body)
        await loadImagePreview(response.image)
        setImage(response.image)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The image could not be created.")
    } finally {
      setSaving(false)
    }
  }

  function changeMode(value: string) {
    setMode(value === "edit" ? "edit" : "generate")
    setImage(null)
    setImageSrc("")
    setError("")
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button aria-label="Open image studio" size="icon-sm" title="Image studio" variant="ghost" />
        }
      >
        <ImagePlus />
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Image Studio</DialogTitle>
          <DialogDescription>
            Generate a new image or upload one to make a focused edit.
          </DialogDescription>
        </DialogHeader>

        {imageEndpoints.length === 0 && (
          <Alert>
            <Sparkles />
            <AlertTitle>No image endpoint configured</AlertTitle>
            <AlertDescription>
              Add an OpenAI-compatible endpoint with the image-generation capability in Settings → Endpoints.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Image action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Tabs onValueChange={changeMode} value={mode}>
          <TabsList>
            <TabsTrigger value="generate">Generate</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
          </TabsList>
          <TabsContent className="mt-4 space-y-4" value="generate">
            <p className="text-sm text-muted-foreground">
              Describe the image, composition, style, and any important constraints.
            </p>
          </TabsContent>
          <TabsContent className="mt-4 space-y-4" value="edit">
            <Field>
              <FieldLabel htmlFor="image-edit-file">Source image</FieldLabel>
              <Input
                accept="image/png,image/jpeg,image/webp"
                id="image-edit-file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                type="file"
              />
              <FieldDescription>PNG, JPEG, or WebP up to 15 MB.</FieldDescription>
            </Field>
          </TabsContent>
        </Tabs>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Image endpoint</FieldLabel>
            <Select onValueChange={(value) => setEndpointId(value ?? "")} value={endpointId || imageEndpoints[0]?.id || ""}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an endpoint" />
              </SelectTrigger>
              <SelectContent>
                {imageEndpoints.map((endpoint) => (
                  <SelectItem key={endpoint.id} value={endpoint.id}>
                    {endpoint.name} · {endpoint.imageModel || "image model"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              className="min-h-24"
              maxLength={4000}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={mode === "edit" ? "Remove the background and add…" : "A cinematic…"}
              value={prompt}
            />
          </Field>
        </div>

        {image && imageSrc && (
          <div className="overflow-hidden rounded-xl border bg-muted/20">
            <Image
              alt={image.prompt}
              className="max-h-[32rem] w-full object-contain"
              height={1024}
              src={imageSrc}
              unoptimized
              width={1024}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2">
              <span className="text-xs text-muted-foreground">{image.mode === "edit" ? "Edited image" : "Generated image"}</span>
              <a
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-input/50"
                download
                href={imageSrc}
              >
                <Download className="size-3" data-icon="inline-start" />
                Download
              </a>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Close
          </Button>
          <Button disabled={saving || !prompt.trim() || imageEndpoints.length === 0} onClick={() => void submit()}>
            {saving ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {saving ? "Creating…" : mode === "edit" ? "Edit image" : "Generate image"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
