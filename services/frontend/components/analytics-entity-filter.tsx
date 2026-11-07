"use client"

import { useEffect, useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { api } from "@/lib/api"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Command } from "@/components/panelui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** Search the complete admin directory rather than only the usage leaderboard. */
export function AnalyticsEntityFilter({
  kind,
  value,
  label,
  onChange,
}: {
  kind: "users" | "workspaces"
  value: string
  label?: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<{
    key: string
    items: Array<{ id: string; name: string; detail: string }>
  } | null>(null)
  const [failed, setFailed] = useState("")
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(
    null
  )
  const key = `${kind}:${query}`
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const path = kind === "users" ? "users" : "organizations"
      void api
        .get<{
          users?: Array<{ id: string; displayName: string; email: string }>
          organizations?: Array<{ id: string; name: string; slug: string }>
        }>(
          `/api/v1/admin/${path}?pageSize=25&query=${encodeURIComponent(query)}`,
          { signal: controller.signal }
        )
        .then((data) => {
          if (!controller.signal.aborted) {
            setResult({
              key,
              items:
                kind === "users"
                  ? (data.users || []).map((item) => ({
                      id: item.id,
                      name: item.displayName || item.email,
                      detail: item.email,
                    }))
                  : (data.organizations || []).map((item) => ({
                      id: item.id,
                      name: item.name,
                      detail: item.slug,
                    })),
            })
            setFailed("")
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(key)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, kind, query, key])
  const all = kind === "users" ? "All users" : "All workspaces"
  const select = (id: string, name?: string) => {
    onChange(id)
    setChosen(id ? { id, name: name || id } : null)
    setOpen(false)
    setQuery("")
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t(
              kind === "users" ? "Filter user" : "Filter workspace"
            )}
          />
        }
      >
        <span className="max-w-44 truncate">
          {value
            ? label ||
              (chosen?.id === value
                ? chosen.name
                : t(kind === "users" ? "Selected user" : "Selected workspace"))
            : t(all)}
        </span>
        <ChevronsUpDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
      >
        <Command
          variant="compact"
          filter={false}
          search={query}
          onSearchChange={setQuery}
        >
          <Command.Input
            aria-label={t(
              kind === "users" ? "Search users…" : "Search workspaces…"
            )}
            placeholder={t(
              kind === "users" ? "Search users…" : "Search workspaces…"
            )}
          />
          <Command.List>
            <Command.Group>
              <Command.Item value="all" onSelect={() => select("")}>
                <span className="flex-1">{t(all)}</span>
              </Command.Item>
            </Command.Group>
            {failed === key ? (
              <p className="p-3 text-xs text-destructive">
                {t("Directory search failed. Try another search.")}
              </p>
            ) : result?.key !== key ? (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {t("Loading…")}
              </p>
            ) : (
              <>
                {!result.items.length && (
                  <p className="p-3 text-xs text-muted-foreground">
                    {t("No results")}
                  </p>
                )}
                <Command.Group>
                  {result.items.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={item.id}
                      onSelect={() => select(item.id, item.name)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.detail}
                        </span>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              </>
            )}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
