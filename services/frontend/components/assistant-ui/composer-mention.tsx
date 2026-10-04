"use client"

import type { DirectiveChipProps } from "@assistant-ui/react-lexical"
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react"
import { cn } from "@/lib/utils"

export function ComposerMention({ directiveType, label }: DirectiveChipProps) {
  return (
    <span
      className={cn(
        "inline rounded-md px-1.5 py-0.5 font-medium",
        directiveType === "mcp"
          ? "bg-blue-500/10 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300"
          : "bg-muted text-foreground"
      )}
    >
      {directiveType === "mcp" ? "@" : "/"}
      {label}
    </span>
  )
}

export function MentionMessageText({ text }: { text: string }) {
  return (
    <div className="leading-6 break-words whitespace-pre-wrap">
      {unstable_defaultDirectiveFormatter
        .parse(text)
        .map((segment, index) =>
          segment.kind === "text" ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <ComposerMention
              key={index}
              directiveId={segment.id}
              directiveType={segment.type}
              label={segment.label}
            />
          )
        )}
    </div>
  )
}
