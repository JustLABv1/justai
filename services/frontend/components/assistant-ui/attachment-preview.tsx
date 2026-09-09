"use client"

import Image from "next/image"
import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  File02Icon,
  FileImageIcon,
  Pdf02Icon,
  ReloadIcon,
} from "@hugeicons/core-free-icons"
import {
  AttachmentPrimitive,
  type CompleteAttachment,
  type PendingAttachment,
  useAui,
  useAuiState,
} from "@assistant-ui/react"

import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { cn } from "@/lib/utils"

type ChatAttachment = PendingAttachment | CompleteAttachment

type ChatAttachmentPreviewProps = {
  attachment: ChatAttachment
  showRemove?: boolean
  variant?: "composer" | "message"
}

function isImageAttachment(attachment: ChatAttachment) {
  return (
    attachment.type === "image" ||
    attachment.contentType?.toLowerCase().startsWith("image/") === true
  )
}

function isPdfAttachment(attachment: ChatAttachment) {
  return (
    attachment.contentType?.toLowerCase() === "application/pdf" ||
    attachment.name.toLowerCase().endsWith(".pdf")
  )
}

function getExtension(name: string) {
  const extension = name.split(".").pop()?.trim()
  return extension ? extension.toUpperCase().slice(0, 5) : "FILE"
}

function getImageContentSource(attachment: ChatAttachment) {
  const imagePart = attachment.content?.find((part) => part.type === "image")
  return imagePart?.type === "image" ? imagePart.image : undefined
}

function ObjectURLImagePreview({ attachment }: { attachment: ChatAttachment }) {
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!attachment.file || !previewRef.current) return

    const objectURL = URL.createObjectURL(attachment.file)
    const preview = previewRef.current
    preview.style.backgroundImage = `url("${objectURL}")`

    return () => {
      URL.revokeObjectURL(objectURL)
      preview.style.backgroundImage = ""
    }
  }, [attachment.file])

  return (
    <div
      ref={previewRef}
      aria-label={`${attachment.name} preview`}
      className="size-full bg-cover bg-center"
      role="img"
    />
  )
}

function AttachmentImagePreview({
  attachment,
}: {
  attachment: ChatAttachment
}) {
  const contentSource = getImageContentSource(attachment)

  if (contentSource) {
    return (
      <Image
        alt={`${attachment.name} preview`}
        className="size-full object-cover"
        height={56}
        src={contentSource}
        unoptimized
        width={56}
      />
    )
  }

  return <ObjectURLImagePreview attachment={attachment} />
}

function getStatusLabel(
  attachment: ChatAttachment,
  variant: ChatAttachmentPreviewProps["variant"]
) {
  if (variant === "message") {
    if (isPdfAttachment(attachment)) return "PDF document"
    if (isImageAttachment(attachment)) return "Image"
    return `${getExtension(attachment.name)} file`
  }

  switch (attachment.status.type) {
    case "running":
      return `Preparing attachment… ${Math.round(
        Math.max(0, Math.min(100, attachment.status.progress ?? 0))
      )}%`
    case "incomplete":
      return attachment.status.message ?? "Could not prepare attachment"
    case "complete":
      return "Ready to send"
    default:
      return "Ready to send"
  }
}

function AttachmentMediaIcon({ attachment }: { attachment: ChatAttachment }) {
  const isPDF = isPdfAttachment(attachment)
  const isImage = isImageAttachment(attachment)
  const icon = isPDF ? Pdf02Icon : isImage ? FileImageIcon : File02Icon

  return (
    <div
      className={cn(
        "flex size-full items-center justify-center p-1.5",
        isPDF
          ? "bg-destructive/5 text-destructive"
          : "bg-muted text-muted-foreground"
      )}
    >
      <HugeiconsIcon icon={icon} className="size-7" strokeWidth={1.8} />
    </div>
  )
}

export function ChatAttachmentPreview({
  attachment,
  showRemove = false,
  variant = "message",
}: ChatAttachmentPreviewProps) {
  const aui = useAui()
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState("")
  const attachmentIndex = useAuiState((state) =>
    state.thread.composer.attachments.findIndex(
      (item) => item.id === attachment.id
    )
  )
  const hasImagePreview =
    isImageAttachment(attachment) &&
    Boolean(attachment.file || getImageContentSource(attachment))
  const status =
    attachment.status.type === "running"
      ? "processing"
      : attachment.status.type === "incomplete"
        ? "error"
        : attachment.status.type === "complete"
          ? "done"
          : "idle"

  const canRetry =
    variant === "composer" &&
    showRemove &&
    attachment.status.type === "incomplete" &&
    Boolean(attachment.file) &&
    attachmentIndex >= 0

  async function retryAttachment() {
    if (!canRetry || !attachment.file || retrying) return
    setRetrying(true)
    setRetryError("")
    try {
      await aui.thread
        .composer()
        .attachment({ index: attachmentIndex })
        .remove()
      await aui.thread.composer().addAttachment(attachment.file)
    } catch (caught) {
      setRetryError(
        caught instanceof Error ? caught.message : "Retry failed. Try again."
      )
    } finally {
      setRetrying(false)
    }
  }

  if (variant === "composer") {
    const uploading = attachment.status.type === "running"
    const progress =
      attachment.status.type === "running"
        ? Math.round(
            Math.max(0, Math.min(100, attachment.status.progress ?? 0))
          )
        : 0
    return (
      <div
        className="group/thumbnail relative shrink-0"
        title={
          retryError ||
          `${attachment.name} · ${getStatusLabel(attachment, variant)}`
        }
      >
        <div
          className={cn(
            "relative size-14 overflow-hidden rounded-[13px] border bg-muted",
            status === "error" && "border-destructive"
          )}
        >
          {hasImagePreview ? (
            <AttachmentImagePreview attachment={attachment} />
          ) : (
            <AttachmentMediaIcon attachment={attachment} />
          )}
          {uploading && (
            <>
              <div className="absolute inset-0 bg-background/20" />
              <span className="absolute top-1 right-1.5 text-[11px] font-medium text-white drop-shadow">
                {progress}%
              </span>
            </>
          )}
          {!hasImagePreview && (
            <span className="absolute inset-x-0 bottom-0 truncate bg-background/90 px-1 py-0.5 text-center text-[9px] dark:text-muted-foreground">
              {attachment.name}
            </span>
          )}
        </div>
        {uploading && (
          <svg
            className="pointer-events-none absolute inset-0 size-14 text-[var(--composer-accent)]"
            viewBox="0 0 64 64"
            role="progressbar"
            aria-label={`Uploading ${attachment.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <path
              d="M 32 1.5 H 49 A 13.5 13.5 0 0 1 62.5 15 V 49 A 13.5 13.5 0 0 1 49 62.5 H 15 A 13.5 13.5 0 0 1 1.5 49 V 15 A 13.5 13.5 0 0 1 15 1.5 H 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray={`${progress} 100`}
              className="transition-[stroke-dasharray] duration-150 motion-reduce:transition-none"
            />
          </svg>
        )}
        {showRemove && (
          <AttachmentPrimitive.Remove
            aria-label={`Remove ${attachment.name}`}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-focus-within/thumbnail:opacity-100 group-hover/thumbnail:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
          </AttachmentPrimitive.Remove>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={() => void retryAttachment()}
            disabled={retrying}
            aria-label={`Retry ${attachment.name}`}
            className="absolute inset-x-1 bottom-1 rounded-md bg-background/95 px-1 py-0.5 text-[10px] text-destructive"
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
        {status === "error" && (
          <span role="alert" className="sr-only">
            {retryError || getStatusLabel(attachment, variant)}
          </span>
        )}
      </div>
    )
  }

  return (
    <Attachment
      className={cn("max-w-full", "max-w-96")}
      size="sm"
      state={status}
    >
      <AttachmentMedia
        className={cn("overflow-hidden rounded-lg border", "size-14!")}
        variant={hasImagePreview ? "image" : "icon"}
      >
        {hasImagePreview ? (
          <AttachmentImagePreview attachment={attachment} />
        ) : (
          <AttachmentMediaIcon attachment={attachment} />
        )}
      </AttachmentMedia>
      <AttachmentContent className="p-2">
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription>
          {retryError || getStatusLabel(attachment, variant)}
        </AttachmentDescription>
      </AttachmentContent>
      {showRemove && (
        <AttachmentActions className="gap-0.5">
          {canRetry && (
            <button
              aria-label={`Retry ${attachment.name}`}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              disabled={retrying}
              onClick={() => void retryAttachment()}
              title={`Retry ${attachment.name}`}
              type="button"
            >
              <HugeiconsIcon
                className={retrying ? "animate-spin" : ""}
                icon={ReloadIcon}
                size={16}
              />
            </button>
          )}
          <AttachmentPrimitive.Remove
            aria-label={`Remove ${attachment.name}`}
            className="size-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
          </AttachmentPrimitive.Remove>
        </AttachmentActions>
      )}
    </Attachment>
  )
}

export function isImageChatAttachment(attachment: ChatAttachment) {
  return isImageAttachment(attachment)
}
