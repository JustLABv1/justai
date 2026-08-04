"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

const components: Components = {
  a: ({ children, href }) => (
    <a
      className="font-medium text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-s-2 border-border ps-4 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const isCodeBlock = className?.includes("language-")

    return (
      <code
        className={cn(
          "rounded bg-background/60 px-1 py-0.5 font-mono text-[0.9em]",
          isCodeBlock && "block overflow-x-auto bg-transparent p-3 text-xs",
          className
        )}
      >
        {String(children).replace(/\n$/, "")}
      </code>
    )
  },
  del: ({ children }) => (
    <del className="text-muted-foreground">{children}</del>
  ),
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-xl font-semibold tracking-tight first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-lg font-semibold tracking-tight first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-base font-semibold tracking-tight first:mt-0">
      {children}
    </h3>
  ),
  hr: () => <Separator className="my-4" />,
  li: ({ children }) => <li className="ps-1 [&>p]:my-0">{children}</li>,
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1 ps-5">{children}</ol>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  pre: ({ children }) => (
    <pre className="my-3 max-w-full overflow-x-auto rounded-lg border border-border/70 bg-background/60 p-1">
      {children}
    </pre>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto">
      <table className="w-full min-w-96 border-collapse text-sm">
        {children}
      </table>
    </div>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-2">{children}</td>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-background/60 px-3 py-2 text-start font-semibold">
      {children}
    </th>
  ),
  ul: ({ children }) => (
    <ul className="my-2 flex list-disc flex-col gap-1 ps-5">{children}</ul>
  ),
}

export function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={cn("max-w-none min-w-0 break-words", className)}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
