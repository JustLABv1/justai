"use client"

import { useMemo } from "react"

import { useTranslations } from "@/components/locale-provider"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  detectDelimiter,
  parseDelimited,
  parseJSON,
} from "@/lib/data-preview"

const maxJSONChildren = 200
const maxTableRows = 500

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function summary(value: object): string {
  return Array.isArray(value)
    ? `[${value.length}]`
    : `{${Object.keys(value).length}}`
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="text-emerald-600 dark:text-emerald-400">{JSON.stringify(value)}</span>
  }
  if (typeof value === "number") {
    return <span className="text-amber-600 dark:text-amber-400">{value}</span>
  }
  return <span className="text-primary">{String(value)}</span>
}

function JsonNode({
  name,
  value,
  depth,
}: {
  name?: string
  value: unknown
  depth: number
}) {
  const label =
    name === undefined ? null : (
      <span className="text-muted-foreground">{name}: </span>
    )

  if (!isContainer(value)) {
    return (
      <div className="py-0.5 pl-4">
        {label}
        <Scalar value={value} />
      </div>
    )
  }

  const entries = Object.entries(value)
  const shown = entries.slice(0, maxJSONChildren)
  return (
    <details className="py-0.5 pl-4" open={depth < 2}>
      <summary className="-ml-4 cursor-pointer select-none pl-4 marker:text-muted-foreground">
        {label}
        <span className="text-muted-foreground">{summary(value)}</span>
      </summary>
      {shown.map(([key, child]) => (
        <JsonNode depth={depth + 1} key={key} name={key} value={child} />
      ))}
      {entries.length > shown.length && (
        <div className="py-0.5 pl-4 text-muted-foreground">
          … {entries.length - shown.length}
        </div>
      )}
    </details>
  )
}

/** Collapsible tree for a JSON code block. */
export function JsonTree({ code }: { code: string }) {
  const { t } = useTranslations()
  const parsed = useMemo(() => parseJSON(code), [code])

  if (!parsed.ok) {
    return (
      <p className="rounded-xl bg-destructive/10 p-3 text-destructive" role="alert">
        {t("This is not valid JSON.")}
      </p>
    )
  }
  return (
    <div className="max-h-96 overflow-auto rounded-xl bg-muted/50 p-3 font-mono text-xs leading-5">
      <JsonNode depth={0} value={parsed.value} />
    </div>
  )
}

/** Table for CSV and TSV code blocks; the first row is the header. */
export function DelimitedTable({
  code,
  language,
  delimiter,
}: {
  code: string
  language: string
  /** Fixed delimiter; detected from the content when omitted. */
  delimiter?: string
}) {
  const { t } = useTranslations()
  const rows = useMemo(
    () => parseDelimited(code, delimiter ?? detectDelimiter(language, code)),
    [code, language, delimiter]
  )

  if (rows.length === 0) {
    return (
      <p className="rounded-xl bg-muted/50 p-3 text-muted-foreground">
        {t("No rows to show.")}
      </p>
    )
  }

  const [header, ...body] = rows
  const shown = body.slice(0, maxTableRows)
  return (
    <div className="max-h-96 overflow-auto rounded-xl bg-muted/30">
      <Table>
        <TableHeader>
          <TableRow>
            {header.map((cell, index) => (
              <TableHead key={index}>{cell}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {header.map((_cell, cellIndex) => (
                <TableCell key={cellIndex}>{row[cellIndex] ?? ""}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {body.length > shown.length && (
        <p className="p-2 text-xs text-muted-foreground">
          … {body.length - shown.length}
        </p>
      )}
    </div>
  )
}
