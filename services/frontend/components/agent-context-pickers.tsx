"use client"

import { useEffect, useState } from "react"

import { useTranslations } from "@/components/locale-provider"
import { Field, FieldDescription, FieldLabel } from "@/components/panelui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/panelui/select"
import { api } from "@/lib/api"
import type { KnowledgeItem, KnowledgeItemType, MCPServer } from "@/lib/types"

type Option = { value: string; label: string; description?: string }

const itemCache = new Map<string, Promise<Option[]>>()

function loadKnowledgeItems(type: KnowledgeItemType) {
  const cached = itemCache.get(type)
  if (cached) return cached
  const request = api
    .get<{ items: KnowledgeItem[] }>(
      `/api/v1/knowledge/items?type=${type}&limit=100`
    )
    .then((result) =>
      result.items.map((item) => ({
        value: item.resourceId,
        label: item.title || item.resourceId,
      }))
    )
    .catch((error: unknown) => {
      itemCache.delete(type)
      throw error
    })
  itemCache.set(type, request)
  return request
}

function loadMCPTools(serverId: string) {
  const key = `mcp:${serverId}`
  const cached = itemCache.get(key)
  if (cached) return cached
  const request = api
    .get<{ tools: Array<{ name: string; description?: string }> }>(
      `/api/v1/mcp/servers/${serverId}/tools?cached=1`
    )
    .then((result) =>
      result.tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
        description: tool.description,
      }))
    )
    .catch((error: unknown) => {
      itemCache.delete(key)
      throw error
    })
  itemCache.set(key, request)
  return request
}

type MultiPickerProps = {
  id: string
  label: string
  description?: string
  placeholder: string
  emptyText: string
  options: Option[] | null
  error?: boolean
  value: string[]
  disabled?: boolean
  onChange: (value: string[]) => void
}

/** A multi-select over named resources that stores their IDs. */
function MultiPicker({
  id,
  label,
  description,
  placeholder,
  emptyText,
  options,
  error,
  value,
  disabled,
  onChange,
}: MultiPickerProps) {
  const { t } = useTranslations()
  const known = new Map((options ?? []).map((option) => [option.value, option]))
  // Keep IDs that are saved but no longer listed, so nothing is dropped silently.
  const all: Option[] = [
    ...(options ?? []),
    ...value
      .filter((item) => !known.has(item))
      .map((item) => ({ value: item, label: item })),
  ]
  const unavailable = options === null || all.length === 0

  return (
    <Field disabled={disabled || unavailable}>
      <FieldLabel>{label}</FieldLabel>
      <Select
        multiple
        value={value}
        onValueChange={(next) => onChange(next as string[])}
        disabled={disabled || unavailable}
      >
        <SelectTrigger id={id} size="sm">
          <SelectValue placeholder={placeholder}>
            {(selected: string[]) =>
              selected.length === 0
                ? placeholder
                : selected.length <= 2
                  ? selected
                      .map((item) => known.get(item)?.label ?? item)
                      .join(", ")
                  : t("{count} selected", { count: selected.length })
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {all.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              description={option.description}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {options === null
          ? error
            ? t("Could not load this list.")
            : t("Loading…")
          : all.length === 0
            ? emptyText
            : description}
      </FieldDescription>
    </Field>
  )
}

function useOptions(load: () => Promise<Option[]>, key: string) {
  const [state, setState] = useState<{
    key: string
    options: Option[] | null
    error: boolean
  }>({ key, options: null, error: false })

  useEffect(() => {
    let cancelled = false
    load().then(
      (options) => {
        if (!cancelled) setState({ key, options, error: false })
      },
      () => {
        if (!cancelled) setState({ key, options: null, error: true })
      }
    )
    return () => {
      cancelled = true
    }
    // `load` is derived from `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return state.key === key ? state : { options: null, error: false }
}

const knowledgePickers: Record<
  "repository" | "note" | "transcript",
  { label: string; placeholder: string; empty: string }
> = {
  repository: {
    label: "Repositories",
    placeholder: "No repositories",
    empty: "No repositories in Storage yet.",
  },
  note: {
    label: "Notes",
    placeholder: "No notes",
    empty: "No notes yet.",
  },
  transcript: {
    label: "Transcriptions",
    placeholder: "No transcriptions",
    empty: "No transcriptions yet.",
  },
}

/** Picks repositories, notes or transcriptions from the workspace library. */
export function KnowledgeItemPicker({
  id,
  type,
  value,
  disabled,
  onChange,
}: {
  id: string
  type: "repository" | "note" | "transcript"
  value: string[] | undefined
  disabled?: boolean
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslations()
  const { options, error } = useOptions(() => loadKnowledgeItems(type), type)
  const copy = knowledgePickers[type]
  return (
    <MultiPicker
      id={id}
      label={t(copy.label)}
      placeholder={t(copy.placeholder)}
      emptyText={t(copy.empty)}
      options={options}
      error={error}
      value={value ?? []}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

/** Narrows a granted MCP server to some of its tools; none chosen means all. */
export function MCPToolPicker({
  server,
  value,
  disabled,
  onChange,
}: {
  server: MCPServer
  value: string[] | undefined
  disabled?: boolean
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslations()
  const { options, error } = useOptions(
    () => loadMCPTools(server.id),
    `mcp:${server.id}`
  )
  const prefix = `${server.id}:`
  const names = new Set((options ?? []).map((option) => option.value))
  // mcpTools is one list for the whole node. This picker owns the entries
  // qualified with its server, plus legacy plain names this server offers.
  const isMine = (entry: string) =>
    entry.startsWith(prefix) || (!entry.includes(":") && names.has(entry))
  const mine = (value ?? [])
    .filter(isMine)
    .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
  const others = (value ?? []).filter((entry) => !isMine(entry))
  return (
    <MultiPicker
      id={`mcp-tools-${server.id}`}
      label={t("Tools from {server}", { server: server.name })}
      description={t("Leave empty to allow every tool of this server.")}
      placeholder={t("All tools")}
      emptyText={t("This server offers no tools.")}
      options={options}
      error={error}
      value={mine}
      disabled={disabled}
      onChange={(next) =>
        onChange([...others, ...next.map((name) => prefix + name)])
      }
    />
  )
}
