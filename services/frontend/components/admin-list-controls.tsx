"use client"

import { useState } from "react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/ui/button"

export function useAdminList<T>(
  items: T[],
  matches: (item: T, query: string, status: string) => boolean
) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [position, setPosition] = useState({ key: "", page: 1 })
  const key = JSON.stringify([query, status])
  const filtered = items.filter((item) =>
    matches(item, query.trim().toLocaleLowerCase(), status)
  )
  const page = Math.min(
    position.key === key ? position.page : 1,
    Math.max(1, Math.ceil(filtered.length / 20))
  )
  return {
    query,
    setQuery,
    status,
    setStatus,
    page,
    total: filtered.length,
    pageItems: filtered.slice((page - 1) * 20, page * 20),
    setPage: (page: number) => setPosition({ key, page }),
    clear: () => {
      setQuery("")
      setStatus("all")
    },
  }
}

export function AdminListFooter({
  page,
  total,
  onPageChange,
}: {
  page: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t } = useTranslations()
  const pageCount = Math.max(1, Math.ceil(total / 20))
  if (total === 0) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3 text-xs text-muted-foreground">
      <span aria-live="polite">
        {total
          ? t("{start}–{end} of {total}", {
              start: (page - 1) * 20 + 1,
              end: Math.min(page * 20, total),
              total,
            })
          : t("No results")}
      </span>
      {pageCount > 1 && (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            {t("Previous page")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            {t("Next page")}
          </Button>
        </div>
      )}
    </div>
  )
}
