"use client"

import Image from "next/image"
import { useEffect, useRef } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  File02Icon,
  FileImageIcon,
  Pdf02Icon,
} from "@hugeicons/core-free-icons"
import {
  AttachmentPrimitive,
  type CompleteAttachment,
  type PendingAttachment,
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

function AttachmentImagePreview({ attachment }: { attachment: ChatAttachment }) {
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
      return "Preparing attachment…"
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

  return (
    <Attachment
      className={cn(
        "max-w-full",
        variant === "composer" ? "w-full sm:w-auto sm:max-w-80" : "max-w-96"
      )}
      size="sm"
      state={status}
    >
      <AttachmentMedia
        className={cn(
          "overflow-hidden rounded-lg border",
          variant === "message" ? "size-14!" : "size-12!"
        )}
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
          {getStatusLabel(attachment, variant)}
        </AttachmentDescription>
      </AttachmentContent>
      {showRemove && (
        <AttachmentActions>
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
