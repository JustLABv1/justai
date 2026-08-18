"use client"

export interface CompactMarkdownProps {
  content: unknown
  className?: string
}

/**
 * Try to parse and format JSON-like strings
 */
const formatJsonLikeString = (str: string): string => {
  try {
    const parsed = JSON.parse(str)
    return JSON.stringify(parsed, null, 2)
  } catch {
    // If it looks like truncated JSON, try to format it anyway
    return str
  }
}

/**
 * Normalize content for display
 */
const normalizeValue = (
  content: unknown
): { data: unknown; isStructured: boolean } => {
  if (typeof content === "object" && content !== null) {
    return { data: content, isStructured: true }
  }
  if (typeof content === "string") {
    const trimmed = content.trim()
    const looksLikeJson =
      (trimmed.startsWith("{") &&
        (trimmed.endsWith("}") || trimmed.includes("}"))) ||
      (trimmed.startsWith("[") &&
        (trimmed.endsWith("]") || trimmed.includes("]")))
    if (looksLikeJson) {
      return { data: content, isStructured: true }
    }
    return { data: content, isStructured: false }
  }
  return { data: String(content), isStructured: false }
}

/**
 * Compact display for structured data and markdown content.
 * Accepts any value and automatically formats it appropriately:
 * - Objects/Arrays: Pretty-printed JSON
 * - Strings that look like JSON: Formatted with indentation (even if truncated)
 * - Other strings: Simple text rendering or markdown if react-markdown available
 */
export function CompactMarkdown({
  content,
  className = "",
}: CompactMarkdownProps) {
  const { data, isStructured } = normalizeValue(content)

  const baseClasses =
    "w-fit max-w-[32rem] max-h-60 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-100 p-3 text-xs text-zinc-800 shadow-sm dark:border-zinc-700/70 dark:bg-zinc-900/60 dark:text-zinc-200"

  // For structured data, render as preformatted text
  if (isStructured) {
    const displayText =
      typeof data === "string"
        ? formatJsonLikeString(data)
        : JSON.stringify(data, null, 2)

    return (
      <pre
        className={`${baseClasses} break-words whitespace-pre-wrap ${className}`}
      >
        {displayText}
      </pre>
    )
  }

  // For text content, render with basic formatting
  const textContent = String(data)

  return (
    <div className={`${baseClasses} leading-relaxed ${className}`}>
      {textContent}
    </div>
  )
}

export default CompactMarkdown
