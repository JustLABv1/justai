"use client"

import {
  IconAdjustmentsHorizontal,
  IconArrowUp,
  IconCirclePlus,
  IconClipboard,
  IconFileUpload,
  IconHistory,
  IconLink,
  IconMicrophone,
  IconPaperclip,
  IconPlayerPlay,
  IconPlus,
  IconSparkles,
  IconTemplate,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface AttachedFile {
  id: string
  name: string
  file: File
}

export type Ai04Submission = {
  prompt: string
  files: File[]
  streaming: boolean
}

export type Ai04Action = "endpoints" | "knowledge" | "mcp" | "transcription"

const ACTIONS = [
  { id: "endpoints", icon: IconPlus, label: "Add endpoint" },
  { id: "knowledge", icon: IconFileUpload, label: "Add knowledge" },
  { id: "mcp", icon: IconLink, label: "Connect MCP" },
  { id: "transcription", icon: IconPlayerPlay, label: "Live transcription" },
] as const

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export default function Ai04({
  onAction,
  onVoice,
  onSubmit,
  onHistory,
  onImportUrl,
  onImportText,
  compact = false,
}: {
  onAction?: (action: Ai04Action) => void
  onVoice?: () => void
  onSubmit?: (submission: Ai04Submission) => void | Promise<void>
  onHistory?: () => void
  onImportUrl?: (url: string, title?: string) => void | Promise<void>
  onImportText?: (content: string, title?: string) => void | Promise<void>
  compact?: boolean
}) {
  const [prompt, setPrompt] = useState("")
  const [isDragOver, setIsDragOver] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [notice, setNotice] = useState("")
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)
  const [urlValue, setUrlValue] = useState("")
  const [urlTitle, setUrlTitle] = useState("")
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [urlSubmitting, setUrlSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [settings, setSettings] = useState({
    autoComplete: true,
    streaming: false,
    showHistory: false,
  })
  const preferencesLoaded = useRef(false)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem("justai.composer.preferences")
        if (saved)
          setSettings((current) => ({ ...current, ...JSON.parse(saved) }))
      } catch {
        // Preferences are a convenience; malformed local state is ignored.
      } finally {
        preferencesLoaded.current = true
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!preferencesLoaded.current) return
    window.localStorage.setItem(
      "justai.composer.preferences",
      JSON.stringify(settings)
    )
  }, [settings])

  const generateFileId = () => Math.random().toString(36).substring(7)
  const processFiles = (files: File[]) => {
    const accepted = files.filter(
      (file) => isSupportedFile(file) && file.size <= MAX_ATTACHMENT_BYTES
    )
    const rejected = files.length - accepted.length
    if (rejected > 0) {
      setNotice(
        `${rejected} file${rejected === 1 ? "" : "s"} rejected. Use PDF, Markdown, text, HTML, or JSON files up to 25 MB.`
      )
    }
    for (const file of accepted) {
      const fileId = generateFileId()
      setAttachedFiles((prev) => [
        ...prev,
        { id: fileId, name: file.name, file },
      ])
    }
  }
  const submitPrompt = async () => {
    if (
      submitting ||
      (!prompt.trim() && attachedFiles.length === 0) ||
      !onSubmit
    )
      return
    setSubmitting(true)
    try {
      await onSubmit({
        prompt: prompt.trim(),
        files: attachedFiles.map((item) => item.file),
        streaming: settings.streaming,
      })
      setPrompt("")
      setAttachedFiles([])
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The message could not be sent."
      )
    } finally {
      setSubmitting(false)
    }
  }
  const updateSetting = (key: keyof typeof settings, value: boolean) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void submitPrompt()
  }
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      processFiles(files)
    }
  }
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value)
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void submitPrompt()
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    processFiles(files)

    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  async function pasteFromClipboard() {
    let content: string
    try {
      content = await navigator.clipboard.readText()
      if (!content.trim()) {
        setNotice("The clipboard does not contain text.")
        return
      }
      if (new TextEncoder().encode(content).length > 10 * 1024 * 1024) {
        setNotice("Clipboard text is limited to 10 MB.")
        return
      }
    } catch {
      setNotice(
        "Clipboard access was denied. Copy the text into the composer instead."
      )
      return
    }
    try {
      await onImportText?.(content, "Clipboard note")
      setNotice("Clipboard text added to conversation context.")
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The clipboard text could not be imported."
      )
    }
  }

  async function submitURL(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (urlSubmitting || !urlValue.trim()) return
    try {
      const parsed = new URL(urlValue.trim())
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("unsupported scheme")
    } catch {
      setNotice("Enter a valid public http(s) URL.")
      return
    }
    setUrlSubmitting(true)
    try {
      await onImportUrl?.(urlValue.trim(), urlTitle.trim() || undefined)
      setNotice("URL added to conversation context and queued for indexing.")
      setUrlValue("")
      setUrlTitle("")
      setUrlDialogOpen(false)
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : "The URL could not be imported."
      )
    } finally {
      setUrlSubmitting(false)
    }
  }

  const templates = [
    [
      "Summarize",
      "Summarize the following material in concise bullet points:\n\n",
    ],
    [
      "Rewrite",
      "Rewrite the following text for a clear, confident audience:\n\n",
    ],
    ["Brainstorm", "Brainstorm practical options and trade-offs for:\n\n"],
    [
      "Extract action items",
      "Extract action items with an owner and due date when available:\n\n",
    ],
  ] as const

  const handleRemoveFile = (fileId: string) => {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== fileId))
  }

  return (
    <div className="mx-auto flex w-full flex-col gap-4">
      {!compact && (
        <>
          <h1 className="text-center font-heading text-[29px] font-semibold tracking-tighter text-balance text-pretty text-foreground sm:text-[32px] md:text-[46px]">
            Your AI workspace.
          </h1>
          <h2 className="-my-5 pb-4 text-center text-xl text-balance text-muted-foreground">
            Connect models, knowledge, tools, and live transcription in one
            place.
          </h2>
        </>
      )}

      <div
        className={cn(
          "relative z-10 mx-auto flex w-full max-w-2xl flex-col content-center",
          compact && "max-w-5xl"
        )}
      >
        <form
          className="overflow-visible rounded-xl border p-2 transition-colors duration-200 focus-within:border-ring"
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onSubmit={handleSubmit}
        >
          {attachedFiles.length > 0 && (
            <div className="relative mb-2 flex w-fit items-center gap-2 overflow-hidden">
              {attachedFiles.map((file) => (
                <Badge
                  className="group relative h-6 max-w-30 cursor-pointer overflow-hidden px-0 text-[13px] transition-colors hover:bg-accent"
                  key={file.id}
                  variant="outline"
                >
                  <span className="flex h-full items-center gap-1.5 overflow-hidden pl-1 font-normal">
                    <span className="relative flex h-4 min-w-4 items-center justify-center">
                      <IconPaperclip className="opacity-60" size={12} />
                    </span>
                    <span className="inline truncate overflow-hidden pr-1.5">
                      {file.name}
                    </span>
                  </span>
                  <button
                    aria-label={`Remove ${file.name}`}
                    className="absolute right-1 z-10 rounded-sm p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-background"
                    onClick={() => handleRemoveFile(file.id)}
                    type="button"
                  >
                    <IconX size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="relative">
            <Textarea
              aria-label="Ask JustAI"
              className="max-h-50 min-h-12 resize-none rounded-none border-none bg-transparent! px-1.5 py-1.5 text-sm shadow-none placeholder:text-transparent focus-visible:border-transparent focus-visible:ring-0"
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask JustAI"
              value={prompt}
            />
            {!prompt && (
              <span className="pointer-events-none absolute inset-x-1.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                Ask JustAI
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <div className="flex items-end gap-0.5 sm:gap-1">
              <input
                className="sr-only"
                multiple
                onChange={handleFileSelect}
                ref={fileInputRef}
                accept=".pdf,.md,.markdown,.txt,.html,.htm,.json,text/*,application/pdf,application/json,text/html"
                type="file"
              />

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label="Add attachments"
                      className="ml-[-2px] rounded-md"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <IconPlus size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-w-xs rounded-2xl p-1.5"
                >
                  <DropdownMenuGroup className="space-y-1">
                    <DropdownMenuItem
                      className="rounded-md text-xs"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <div className="flex items-center gap-2">
                        <IconPaperclip
                          className="text-muted-foreground"
                          size={16}
                        />
                        <span>Attach Files</span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="rounded-md text-xs"
                      onClick={() => setUrlDialogOpen(true)}
                    >
                      <div className="flex items-center gap-2">
                        <IconLink className="text-muted-foreground" size={16} />
                        <span>Import from URL</span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="rounded-md text-xs"
                      onClick={() => void pasteFromClipboard()}
                    >
                      <div className="flex items-center gap-2">
                        <IconClipboard
                          className="text-muted-foreground"
                          size={16}
                        />
                        <span>Paste from Clipboard</span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="rounded-md text-xs"
                      onClick={() => setTemplateDialogOpen(true)}
                    >
                      <div className="flex items-center gap-2">
                        <IconTemplate
                          className="text-muted-foreground"
                          size={16}
                        />
                        <span>Use Template</span>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label="Adjust settings"
                      className="rounded-md"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <IconAdjustmentsHorizontal size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-48 rounded-2xl p-3"
                >
                  <DropdownMenuGroup className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconSparkles
                          className="text-muted-foreground"
                          size={16}
                        />
                        <Label className="text-xs">Prompt suggestions</Label>
                      </div>
                      <Switch
                        aria-label="Enable prompt suggestions"
                        checked={settings.autoComplete}
                        className="scale-75"
                        onCheckedChange={(value) =>
                          updateSetting("autoComplete", value)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconPlayerPlay
                          className="text-muted-foreground"
                          size={16}
                        />
                        <Label className="text-xs">Streaming</Label>
                      </div>
                      <Switch
                        aria-label="Enable streaming"
                        checked={settings.streaming}
                        className="scale-75"
                        onCheckedChange={(value) =>
                          updateSetting("streaming", value)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconHistory
                          className="text-muted-foreground"
                          size={16}
                        />
                        <Label className="text-xs">Show History</Label>
                      </div>
                      <Switch
                        aria-label="Show conversation history"
                        checked={settings.showHistory}
                        className="scale-75"
                        onCheckedChange={(value) => {
                          updateSetting("showHistory", value)
                          if (value) onHistory?.()
                        }}
                      />
                    </div>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
              <Button
                aria-label="Open Voice Mode"
                className="rounded-md"
                onClick={() => onVoice?.()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <IconMicrophone size={16} />
              </Button>
              <Button
                aria-label="Send message"
                className="rounded-md"
                disabled={
                  submitting || (!prompt.trim() && attachedFiles.length === 0)
                }
                size="icon-sm"
                type="submit"
                variant="default"
              >
                <IconArrowUp size={16} />
              </Button>
            </div>
          </div>

          {notice && (
            <p className="px-1 pt-2 text-xs text-destructive">{notice}</p>
          )}
          {settings.autoComplete && prompt.trim() && (
            <div className="flex flex-wrap gap-1.5 px-1 pt-2">
              {[
                "Summarize this",
                "Make it clearer",
                "Extract action items",
              ].map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full text-[11px]"
                  onClick={() => setPrompt(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          )}

          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] border border-dashed border-border bg-muted text-sm text-foreground transition-opacity duration-200",
              isDragOver ? "opacity-100" : "opacity-0"
            )}
          >
            <span className="flex w-full items-center justify-center gap-1 font-medium">
              <IconCirclePlus className="min-w-4" size={16} />
              Drop files here to add as attachments
            </span>
          </div>
        </form>
      </div>

      {!compact && (
        <div className="mx-auto flex min-h-0 max-w-250 shrink-0 flex-wrap items-center justify-center gap-3">
          {ACTIONS.map((action) => (
            <Button
              className="gap-2 rounded-full"
              key={action.id}
              onClick={() => onAction?.(action.id)}
              size="sm"
              variant="outline"
            >
              <action.icon size={16} />
              {action.label}
            </Button>
          ))}
          <Button
            className="gap-2 rounded-full"
            onClick={() => onVoice?.()}
            size="sm"
            variant="outline"
          >
            <IconMicrophone size={16} />
            Voice mode
          </Button>
        </div>
      )}

      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import a URL</DialogTitle>
            <DialogDescription>
              Public text pages are fetched and indexed as conversation
              Knowledge.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submitURL}>
            <Label htmlFor="composer-url-title">Title</Label>
            <Input
              id="composer-url-title"
              value={urlTitle}
              onChange={(event) => setUrlTitle(event.target.value)}
              placeholder="Product docs"
            />
            <Label htmlFor="composer-url">URL</Label>
            <Input
              id="composer-url"
              type="url"
              required
              value={urlValue}
              onChange={(event) => setUrlValue(event.target.value)}
              placeholder="https://example.com/docs"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setUrlDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button disabled={urlSubmitting} type="submit">
                {urlSubmitting ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use a template</DialogTitle>
            <DialogDescription>
              Start with a focused prompt, then add your material.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {templates.map(([label, value]) => (
              <Button
                key={label}
                className="justify-start"
                variant="outline"
                onClick={() => {
                  setPrompt(value)
                  setTemplateDialogOpen(false)
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function isSupportedFile(file: File) {
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase().split(";", 1)[0]
  if (
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    mediaExtension(name)
  )
    return false
  const supportedExtension = /\.(pdf|md|markdown|txt|html?|json)$/.test(name)
  return (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "application/json" ||
    (type === "" && supportedExtension) ||
    supportedExtension
  )
}

function mediaExtension(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|mp3|wav|ogg|m4a|mp4|mov|webm|avi)$/.test(
    name
  )
}
