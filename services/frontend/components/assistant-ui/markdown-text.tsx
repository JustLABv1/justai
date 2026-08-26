"use client"

import {
  type ComponentPropsWithoutRef,
  type MouseEvent,
  useState,
} from "react"
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown"
import remarkGfm from "remark-gfm"

import { api } from "@/lib/api"
import { isGeneratedPDFURL } from "@/lib/file-result-logic"
import { cn } from "@/lib/utils"

type AssistantMarkdownProps = {
  className?: string
}

type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> & { node?: unknown }

function MarkdownLink({
  children,
  href,
  node: _node,
  onClick,
  ...props
}: MarkdownLinkProps) {
  void _node
  const [error, setError] = useState("")
  const [isDownloading, setIsDownloading] = useState(false)
  const pdfURL =
    typeof href === "string" && isGeneratedPDFURL(href) ? href : undefined

  if (!pdfURL) {
    return (
      <a href={href} onClick={onClick} {...props}>
        {children}
      </a>
    )
  }

  const downloadPDF = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (isDownloading) return
    setError("")
    setIsDownloading(true)
    try {
      const blob = await api.getBlob(pdfURL)
      const objectURL = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = objectURL
      link.download = "generated-document.pdf"
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 0)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The PDF could not be downloaded."
      )
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <>
      <a
        aria-busy={isDownloading}
        href={href}
        onClick={downloadPDF}
        {...props}
      >
        {children}
      </a>
      {error && (
        <span className="ml-2 text-destructive" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

export function AssistantMarkdown({ className }: AssistantMarkdownProps = {}) {
  return (
    <MarkdownTextPrimitive
      components={{ a: MarkdownLink }}
      remarkPlugins={[remarkGfm]}
      className={cn(
        "max-w-none text-sm leading-7 text-foreground [&_a]:text-primary [&_a]:underline-offset-2 [&_a:hover]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em] [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:bg-muted/50 [&_pre]:p-3 [&_strong]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5",
        className
      )}
    />
  )
}
