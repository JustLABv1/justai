"use client"
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react"
import {
  CalendarDays,
  ChevronDown,
  ChevronsUpDown,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Frame } from "@/components/panelui/frame"
import { Field } from "@/components/panelui/field"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Input } from "@/components/panelui/input"
import { Sheet } from "@/components/panelui/sheet"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { de, enUS } from "react-day-picker/locale"
import { api } from "@/lib/api"
import { Command } from "@/components/panelui/command"
import { AnalyticsEntityFilter } from "@/components/analytics-entity-filter"
import { cn } from "@/lib/utils"
function Pagination({
  page,
  compact = false,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  compact?: boolean
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t } = useTranslations()

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (pageCount <= 1) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground",
        !compact && "border-t pt-3"
      )}
    >
      {!compact && (
        <span className="min-w-0 flex-1">
          {t("Page")} {page} {t("of")} {pageCount} · {total} total
        </span>
      )}
      <div className="flex shrink-0 gap-1">
        <Button
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          size="sm"
          variant="outline"
        >
          {t("Previous page")}
        </Button>
        <Button
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          size="sm"
          variant="outline"
        >
          {t("Next page")}
        </Button>
      </div>
    </div>
  )
}

export function PlatformAuditView({
  events,
  filters,
  onFiltersChange,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  events: any[]
  filters: Record<string, string>
  onFiltersChange: (filters: Record<string, string>) => void
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { t, locale } = useTranslations()

  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null)
  const setFilter = (key: string, value: string) =>
    onFiltersChange({ ...filters, [key]: value })
  const advancedFilterCount = Object.entries(filters).filter(
    ([key, value]) => key !== "search" && Boolean(value.trim())
  ).length
  const hasActiveFilters = Object.values(filters).some((value) =>
    Boolean(value.trim())
  )
  return (
    <Frame>
      <Frame.Header>
        <Frame.Title>{t("Audit log")}</Frame.Title>
        <Frame.Description>
          {t("Inspect recorded platform actions and their request details.")}
        </Frame.Description>
        <Frame.Action>{total}</Frame.Action>
      </Frame.Header>
      <Frame.Panel>
        <Frame.Row className="items-stretch">
          <div className="w-full min-w-0">
            <Collapsible
              className="flex flex-col gap-2"
              onOpenChange={setMoreFiltersOpen}
              open={moreFiltersOpen}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  aria-label={t("Audit search")}
                  className="min-w-0 flex-1"
                  onChange={(event) => setFilter("search", event.target.value)}
                  placeholder={t("Search actions or details")}
                  value={filters.search}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <CollapsibleTrigger
                    className="gap-1.5 sm:w-auto"
                    render={<Button size="sm" variant="outline" />}
                  >
                    <SlidersHorizontal data-icon="inline-start" />
                    {moreFiltersOpen ? t("Hide filters") : t("More filters")}
                    {advancedFilterCount > 0 ? (
                      <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                        {advancedFilterCount}
                      </span>
                    ) : null}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 transition-transform",
                        moreFiltersOpen && "rotate-180"
                      )}
                    />
                  </CollapsibleTrigger>
                  {hasActiveFilters ? (
                    <Button
                      className="shrink-0"
                      onClick={() =>
                        onFiltersChange({
                          search: "",
                          action: "",
                          resourceType: "",
                          actorId: "",
                          organizationId: "",
                          from: "",
                          to: "",
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      <X data-icon="inline-start" /> {t("Clear filters")}
                    </Button>
                  ) : null}
                </div>
              </div>
              <CollapsibleContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Field>
                  <Field.Label>{t("Action")}</Field.Label>
                  <AuditValueFilter
                    kind="action"
                    label={t("Action")}
                    value={filters.action}
                    onChange={(value) => setFilter("action", value)}
                  />
                </Field>
                <Field>
                  <Field.Label>{t("Resource type")}</Field.Label>
                  <AuditValueFilter
                    kind="resourceType"
                    label={t("Resource type")}
                    value={filters.resourceType}
                    onChange={(value) => setFilter("resourceType", value)}
                  />
                </Field>
                <Field>
                  <Field.Label>{t("Actor")}</Field.Label>
                  <AnalyticsEntityFilter
                    kind="users"
                    className="w-full justify-between"
                    value={filters.actorId}
                    onChange={(value) => setFilter("actorId", value)}
                  />
                </Field>
                <Field>
                  <Field.Label>{t("Workspace")}</Field.Label>
                  <AnalyticsEntityFilter
                    kind="workspaces"
                    className="w-full justify-between"
                    value={filters.organizationId}
                    onChange={(value) => setFilter("organizationId", value)}
                  />
                </Field>
                <Field>
                  <Field.Label>{t("From")}</Field.Label>
                  <AuditDatePicker
                    label={t("From")}
                    value={filters.from}
                    onChange={(value) => setFilter("from", value)}
                  />
                </Field>
                <Field>
                  <Field.Label>{t("To")}</Field.Label>
                  <AuditDatePicker
                    label={t("To")}
                    value={filters.to}
                    onChange={(value) => setFilter("to", value)}
                  />
                </Field>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </Frame.Row>
        {events.map((event) => (
          <Frame.Row
            className="flex-wrap gap-3 py-4 text-left"
            key={event.id}
            onClick={() => setSelectedEvent(event)}
          >
            <Frame.Content className="min-w-40">
              <Frame.Title as="p" className="break-all">
                {event.action}
              </Frame.Title>
              <Frame.Description className="overflow-visible! break-all text-clip! whitespace-normal!">
                {event.resourceType} · {event.resourceId ?? "—"}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions className="ml-auto flex-wrap justify-end gap-2">
              <Badge
                variant={
                  event.outcome && event.outcome !== "success"
                    ? "destructive"
                    : "success"
                }
              >
                {t(
                  event.outcome && event.outcome !== "success"
                    ? "Failed"
                    : "Success"
                )}
              </Badge>
              <time
                dateTime={event.createdAt}
                className="text-xs text-muted-foreground"
              >
                {event.createdAt
                  ? new Date(event.createdAt).toLocaleString(locale)
                  : ""}
              </time>
            </Frame.Actions>
          </Frame.Row>
        ))}
        {events.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("No audit events found.")}
          </p>
        )}
      </Frame.Panel>
      <Frame.Footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {total
            ? t("{start}–{end} of {total}", {
                start: (page - 1) * pageSize + 1,
                end: Math.min((page - 1) * pageSize + events.length, total),
                total,
              })
            : t("No audit events found.")}
        </span>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          compact
        />
      </Frame.Footer>
      <Sheet
        side="right"
        open={selectedEvent !== null}
        onOpenChange={(open) => !open && setSelectedEvent(null)}
      >
        <Sheet.Content className="w-[min(42rem,calc(100vw-2*var(--sheet-gap)))]!">
          <Sheet.Header>
            <Sheet.Title className="break-all">
              {selectedEvent?.action ?? t("Audit event")}
            </Sheet.Title>
            <Sheet.Description className="break-all">
              {selectedEvent?.resourceType ?? "—"} ·{" "}
              {selectedEvent?.resourceId ?? t("No resource ID")}
            </Sheet.Description>
          </Sheet.Header>
          <Sheet.Body className="flex flex-col gap-5">
            <Frame variant="band">
              <Frame.Header>
                <Frame.Title>{t("Event metadata")}</Frame.Title>
              </Frame.Header>
              <Frame.Panel className="grid gap-4 p-4 text-sm sm:grid-cols-2">
                <AuditDetail label={t("Actor")} value={selectedEvent?.userId} />
                <AuditDetail
                  label={t("Organization")}
                  value={selectedEvent?.organizationId}
                />
                <AuditDetail
                  label={t("Outcome")}
                  value={selectedEvent?.outcome ?? "success"}
                />
                <AuditDetail
                  label={t("Request ID")}
                  value={selectedEvent?.requestId}
                />
                <AuditDetail
                  label={t("IP address")}
                  value={selectedEvent?.ipAddress}
                />
                <AuditDetail
                  label={t("Time")}
                  value={
                    selectedEvent?.createdAt
                      ? new Date(selectedEvent.createdAt).toLocaleString(locale)
                      : undefined
                  }
                />
              </Frame.Panel>
            </Frame>
            {selectedEvent?.userAgent && (
              <AuditDetail
                label={t("User agent")}
                value={selectedEvent.userAgent}
              />
            )}
            <Frame variant="band">
              <Frame.Header>
                <Frame.Title>{t("Details")}</Frame.Title>
              </Frame.Header>
              <Frame.Panel>
                <pre className="overflow-x-auto p-4 text-xs break-words whitespace-pre-wrap">
                  {t(formatAuditDetails(selectedEvent?.details))}
                </pre>
              </Frame.Panel>
            </Frame>
          </Sheet.Body>
          <Sheet.Footer>
            <Button onClick={() => setSelectedEvent(null)} variant="outline">
              {t("Close")}
            </Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet>
    </Frame>
  )
}

function formatAuditDetails(value: unknown) {
  if (value == null || value === "") return "No additional details."
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function AuditDetail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs break-words">
        {value == null || value === "" ? "—" : String(value)}
      </p>
    </div>
  )
}

function AuditDatePicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const { t, locale } = useTranslations()
  const [open, setOpen] = useState(false)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const candidate = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : undefined
  const selected =
    candidate && Number.isFinite(candidate.getTime()) ? candidate : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-start font-normal"
            aria-label={label}
          />
        }
      >
        <CalendarDays className="size-4" aria-hidden="true" />
        {selected
          ? selected.toLocaleDateString(locale, {
              day: "numeric",
              month: "short",
              year: "numeric",
            })
          : t("Select date")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={locale.startsWith("de") ? de : enUS}
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            if (date)
              onChange(
                `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
              )
            else onChange("")
            setOpen(false)
          }}
        />
        {value && (
          <div className="border-t border-border p-2">
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
            >
              {t("Clear")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function AuditValueFilter({
  kind,
  label,
  value,
  onChange,
}: {
  kind: "action" | "resourceType"
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<{
    actions: string[]
    resourceTypes: string[]
  } | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void api
      .get<{ actions: string[]; resourceTypes: string[] }>(
        "/api/v1/admin/audit/options",
        { signal: controller.signal }
      )
      .then((result) => {
        if (!controller.signal.aborted) {
          setOptions(result)
          setError(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [open, attempt])
  const values = options
    ? kind === "action"
      ? options.actions
      : options.resourceTypes
    : []
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-between"
            role="combobox"
            aria-expanded={open}
            aria-label={label}
          />
        }
      >
        <span className="min-w-0 truncate">
          {value || t(kind === "action" ? "All actions" : "All resource types")}
        </span>
        <ChevronsUpDown className="size-4 shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
      >
        <Command variant="compact">
          <Command.Input placeholder={t("Search…")} aria-label={label} />
          <Command.List>
            <Command.Group>
              <Command.Item value="all" onSelect={() => choose("")}>
                {t(kind === "action" ? "All actions" : "All resource types")}
              </Command.Item>
            </Command.Group>
            {error ? (
              <div className="p-3 text-xs text-destructive">
                {t("Filter options could not be loaded.")}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAttempt(attempt + 1)}
                >
                  {t("Retry")}
                </Button>
              </div>
            ) : !options ? (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {t("Loading…")}
              </p>
            ) : (
              <Command.Group>
                {values.map((option) => (
                  <Command.Item
                    key={option}
                    value={option}
                    textValue={option}
                    onSelect={() => choose(option)}
                  >
                    {option}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            <Command.Empty>{t("No results")}</Command.Empty>
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
