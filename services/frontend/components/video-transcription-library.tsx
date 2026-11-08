"use client"

import { Spinner } from "@/components/panelui/spinner"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import {
  AudioLines,
  Mic,
  Check,
  CircleCheck,
  ListChecks,
  Undo2,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileVideo,
  Search,
  Upload,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Alert } from "@/components/panelui/alert"
import { Badge, type BadgeProps } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Card } from "@/components/panelui/card"
import { Checkbox } from "@/components/panelui/checkbox"
import { Chip } from "@/components/panelui/chip"
import { Input } from "@/components/panelui/input"
import { SectionHeading } from "@/components/section-heading"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/toast"
import { VideoTranscriptionThumbnail } from "@/components/video-transcription-thumbnail"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { workspacePath } from "@/lib/workspace-routes"
import {
  VIDEO_LIBRARY_PAGE_SIZE,
  videoLibraryDuration,
  videoLibraryPage,
  videoLibraryPath,
  videoLibraryPending,
  videoLibraryStep,
  videoLibraryFilter,
  VIDEO_LIBRARY_FILTERS,
  type VideoTranscriptionLibraryItem,
  type VideoTranscriptionLibraryPage,
} from "@/lib/video-transcription-library"

function statusTone(
  status: VideoTranscriptionLibraryItem["status"]
): BadgeProps["variant"] {
  if (status === "completed") return "success"
  if (status === "failed") return "destructive"
  if (status === "live") return "info"
  if (status === "paused" || status === "waiting") return "warning"
  if (status === "cancelled") return "secondary"
  return "info"
}

const FILTER_LABELS = {
  all: "All recordings",
  pending: "In progress",
  completed: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  open: "Not done",
  done: "Done",
} as const

const FILTER_TONES = {
  all: "primary",
  pending: "info",
  completed: "success",
  failed: "destructive",
  cancelled: "primary",
  open: "primary",
  done: "success",
} as const

export function VideoTranscriptionLibrary({
  onCreate,
  ownerId,
  revision = "",
  kind = "video",
}: {
  onCreate: () => void
  ownerId: string
  revision?: string
  kind?: "video" | "live"
}) {
  const { t, locale } = useTranslations()
  const router = useRouter()
  const params = useSearchParams()
  const page = videoLibraryPage(params.get("page"))
  const requestedFilter = videoLibraryFilter(params.get("status"))
  const filter =
    kind === "live" && requestedFilter === "cancelled" ? "all" : requestedFilter
  const libraryPath = (
    page: number,
    query = "",
    status: typeof filter = "all"
  ) => videoLibraryPath(page, query, status, kind)
  const query = (params.get("query") ?? "").slice(0, 200).trim()
  const [search, setSearch] = useState({ basis: query, text: query })
  const searchText = search.basis === query ? search.text : query
  const [retry, setRetry] = useState(0)
  const scope = `${ownerId}:${api.getOrganizationId() ?? ""}`
  const requestKey = JSON.stringify([
    scope,
    kind,
    page,
    query,
    filter,
    retry,
    revision,
  ])
  const [state, setState] = useState<{
    key: string
    data: VideoTranscriptionLibraryPage | null
    error: string
  }>({ key: "", data: null, error: "" })
  const rootRef = useRef<HTMLElement>(null)
  // Selection belongs to one page of results: it is keyed to the request, so
  // changing page, filter or search drops it instead of acting on hidden items.
  const [selection, setSelection] = useState<{
    key: string
    active: boolean
    ids: string[]
  }>({ key: "", active: false, ids: [] })
  const selecting = selection.active
  const selectedIds = selection.key === requestKey ? selection.ids : []
  const [bulkSaving, setBulkSaving] = useState(false)
  const data = state.key === requestKey ? state.data : null
  const error = state.key === requestKey ? state.error : ""
  const loading = !data && !error

  useEffect(() => {
    if (searchText.trim() === query) return
    const timer = window.setTimeout(
      () =>
        router.replace(videoLibraryPath(1, searchText, filter, kind), {
          scroll: false,
        }),
      300
    )
    return () => window.clearTimeout(timer)
  }, [searchText, query, filter, kind, router])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    const load = async () => {
      try {
        const searchParams = new URLSearchParams({
          page: String(page),
          pageSize: String(VIDEO_LIBRARY_PAGE_SIZE),
          query,
          status: filter,
        })
        const result = await api.get<VideoTranscriptionLibraryPage>(
          `/api/v1/transcription/${kind === "live" ? "live-library" : "videos"}?${searchParams}`,
          { signal: controller.signal }
        )
        if (!active) return
        if (result.page !== page) {
          router.replace(videoLibraryPath(result.page, query, filter, kind), {
            scroll: false,
          })
          return
        }
        setState({ key: requestKey, data: result, error: "" })
        if (result.counts.pending > 0)
          timer = setTimeout(() => void load(), 5000)
      } catch (caught) {
        if (!active) return
        setState({
          key: requestKey,
          data: null,
          error:
            caught instanceof Error
              ? caught.message
              : "Your recordings could not be loaded.",
        })
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [page, query, filter, kind, requestKey, router])

  const toggleSelected = (id: string) =>
    setSelection({
      key: requestKey,
      active: true,
      ids: selectedIds.includes(id)
        ? selectedIds.filter((value) => value !== id)
        : [...selectedIds, id],
    })
  const stopSelecting = () =>
    setSelection({ key: requestKey, active: false, ids: [] })
  const markSelected = async (done: boolean) => {
    if (!selectedIds.length) return
    setBulkSaving(true)
    try {
      await api.patch("/api/v1/transcription/sessions", {
        ids: selectedIds,
        done,
      })
      toast.add({
        type: "success",
        title: t(done ? "Marked as done" : "Reopened"),
      })
      stopSelecting()
      setRetry((value) => value + 1)
    } catch (caught) {
      toast.add({
        type: "destructive",
        priority: "high",
        title: t(
          caught instanceof Error
            ? caught.message
            : "The status could not be saved."
        ),
      })
    } finally {
      setBulkSaving(false)
    }
  }
  const changePage = (next: number) => {
    router.push(libraryPath(next, query, filter), { scroll: false })
    rootRef.current?.scrollIntoView({ block: "start" })
  }
  const pageCount = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })

  return (
    <section
      ref={rootRef}
      aria-labelledby="video-library-title"
      className="mx-auto flex w-full max-w-7xl flex-col gap-6"
    >
      <SectionHeading
        actions={
          <Button onClick={onCreate}>
            {kind === "live" ? (
              <Mic data-icon="inline-start" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            {t(kind === "live" ? "New live session" : "Add recording")}
          </Button>
        }
        description={t("Pick up where you left off, or add a new recording.")}
        id="video-library-title"
        title={t(kind === "live" ? "Your live sessions" : "Your recordings")}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input.Group className="w-full sm:w-80">
          <Input.Addon>
            <Search aria-hidden="true" />
          </Input.Addon>
          <Input
            aria-label={t("Search recordings")}
            placeholder={t("Search recordings")}
            maxLength={200}
            value={searchText}
            onChange={(event) =>
              setSearch({ basis: query, text: event.target.value })
            }
          />
        </Input.Group>
        <Chip.Group
          aria-label={t("Filter recordings")}
          multiple={false}
          onValueChange={(value) => {
            const next = videoLibraryFilter((value[0] as string) ?? "all")
            router.push(libraryPath(1, searchText, next), { scroll: false })
          }}
          value={[filter]}
        >
          {VIDEO_LIBRARY_FILTERS.filter(
            (value) => kind !== "live" || value !== "cancelled"
          )
            .filter(
              (value) =>
                value === "all" ||
                value === filter ||
                !data ||
                data.counts[value] > 0
            )
            .map((value) => (
              <Chip
                color={FILTER_TONES[value]}
                key={value}
                size="sm"
                value={value}
              >
                <span className="inline-flex items-center gap-1.5">
                  {t(FILTER_LABELS[value])}
                  {data ? (
                    <span className="text-muted-foreground tabular-nums">
                      {data.counts[value]}
                    </span>
                  ) : null}
                </span>
              </Chip>
            ))}
        </Chip.Group>
        {data?.items.length ? (
          <Button
            className="sm:ml-auto"
            onClick={() =>
              selecting
                ? stopSelecting()
                : setSelection({ key: requestKey, active: true, ids: [] })
            }
            size="sm"
            variant={selecting ? "default" : "secondary"}
          >
            <ListChecks data-icon="inline-start" />
            {t(selecting ? "Cancel selection" : "Select")}
          </Button>
        ) : null}
      </div>
      {selecting && data ? (
        <div
          role="toolbar"
          aria-label={t("Bulk actions")}
          className="flex flex-wrap items-center gap-3 rounded-xl bg-muted px-4 py-2"
        >
          <Checkbox
            aria-label={t("Select all on this page")}
            checked={
              data.items.length > 0 && selectedIds.length === data.items.length
            }
            indeterminate={
              selectedIds.length > 0 && selectedIds.length < data.items.length
            }
            onCheckedChange={(checked) =>
              setSelection({
                key: requestKey,
                active: true,
                ids: checked ? data.items.map((item) => item.id) : [],
              })
            }
          />
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {selectedIds.length
              ? t("{value0} selected", { value0: selectedIds.length })
              : t("Select all on this page")}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              disabled={!selectedIds.length || bulkSaving}
              onClick={() => void markSelected(false)}
              size="sm"
              variant="outline"
            >
              <Undo2 data-icon="inline-start" />
              {t("Reopen")}
            </Button>
            <Button
              disabled={!selectedIds.length || bulkSaving}
              onClick={() => void markSelected(true)}
              size="sm"
            >
              {bulkSaving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CircleCheck data-icon="inline-start" />
              )}
              {t("Mark as done")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <Alert tone="destructive">
          <Alert.Title>{t("Your recordings could not be loaded.")}</Alert.Title>
          <Alert.Description>{t(error)}</Alert.Description>
          <Button
            className="mt-3 justify-self-start"
            size="sm"
            variant="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("Try again")}
          </Button>
        </Alert>
      ) : null}
      {loading ? (
        <div
          role="status"
          aria-label={t("Loading recordings…")}
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-5"
        >
          {Array.from({ length: 8 }, (_, index) => (
            <Card key={index} className="gap-0 overflow-hidden p-0">
              <Skeleton className="aspect-video w-full rounded-none motion-reduce:animate-none" />
              <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
                <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
                <Skeleton className="h-3 w-3/5 motion-reduce:animate-none" />
                <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
              </div>
            </Card>
          ))}
        </div>
      ) : null}
      {data?.items.length ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-5">
            {data.items.map((item) => (
              <Link
                key={item.id}
                href={workspacePath(
                  kind === "live" ? "transcription" : "video-transcription",
                  null,
                  item.id
                )}
                prefetch={false}
                aria-pressed={selecting ? selectedIds.includes(item.id) : undefined}
                onClick={(event) => {
                  if (!selecting) return
                  event.preventDefault()
                  toggleSelected(item.id)
                }}
                className="group relative w-full rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {selecting ? (
                  <span className="absolute top-3 left-3 z-10 flex size-5 items-center justify-center drop-shadow-sm">
                    <Checkbox
                      aria-label={t("Select {value0}", {
                        value0: item.title.trim() || item.fileName,
                      })}
                      checked={selectedIds.includes(item.id)}
                      onCheckedChange={() => toggleSelected(item.id)}
                      tabIndex={-1}
                    />
                  </span>
                ) : null}
                <Card
                  className={cn(
                    "h-full gap-0 overflow-hidden p-0 transition-shadow group-hover:shadow-md",
                    item.doneAt && "opacity-70",
                    selecting &&
                      selectedIds.includes(item.id) &&
                      "ring-2 ring-primary"
                  )}
                >
                  {kind === "live" ? (
                    <div className="flex aspect-video items-center justify-center bg-muted text-muted-foreground">
                      <AudioLines aria-hidden="true" className="size-10" />
                    </div>
                  ) : (
                    <VideoTranscriptionThumbnail
                      url={item.thumbnailUrl}
                      scope={scope}
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
                    <h2
                      className="line-clamp-2 text-base leading-6 font-medium group-hover:underline"
                      title={item.fileName}
                    >
                      {item.title.trim() ||
                        item.fileName ||
                        t("Live transcription")}
                    </h2>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <time dateTime={item.createdAt}>
                        {dateFormatter.format(new Date(item.createdAt))}
                      </time>
                      {videoLibraryDuration(item.durationMs) ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {videoLibraryDuration(item.durationMs)}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        className="min-w-0 whitespace-normal"
                        dot={
                          !(
                            videoLibraryPending(item.status) &&
                            !["live", "paused", "waiting"].includes(item.status)
                          )
                        }
                        variant={statusTone(item.status)}
                      >
                        {videoLibraryPending(item.status) &&
                        !["live", "paused", "waiting"].includes(item.status) ? (
                          <Spinner className="size-3" />
                        ) : null}
                        {t(videoLibraryStep(item))}
                      </Badge>
                      {item.doneAt ? (
                        <Badge size="sm" variant="success">
                          <Check aria-hidden="true" className="size-3" />
                          {t("Done")}
                        </Badge>
                      ) : null}
                      {item.hasSummary ? (
                        <Badge size="sm" variant="outline">
                          <FileText aria-hidden="true" className="size-3" />
                          {t("With summary")}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
          {pageCount > 1 ? (
            <nav
              aria-label={t("Recording pages")}
              className="flex flex-wrap items-center justify-between gap-4 pt-2"
            >
              <p className="text-xs text-muted-foreground">
                {t("{value0}–{value1} of {value2}", {
                  value0: (data.page - 1) * data.pageSize + 1,
                  value1: Math.min(data.page * data.pageSize, data.total),
                  value2: data.total,
                })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={data.page <= 1}
                  onClick={() => changePage(data.page - 1)}
                  aria-label={t("Previous page")}
                >
                  <ChevronLeft data-icon="inline-start" />
                  {t("Previous")}
                </Button>
                <span className="px-1 text-xs text-muted-foreground">
                  {t("Page {value0} of {value1}", {
                    value0: data.page,
                    value1: pageCount,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={data.page >= pageCount}
                  onClick={() => changePage(data.page + 1)}
                  aria-label={t("Next page")}
                >
                  {t("Next")}
                  <ChevronRight data-icon="inline-end" />
                </Button>
              </div>
            </nav>
          ) : null}
        </>
      ) : data && !error ? (
        <Card className="border-dashed">
          <Card.Content className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
            <span className="rounded-full bg-muted p-3 text-muted-foreground">
              {kind === "live" ? (
                <Mic aria-hidden="true" className="size-6" />
              ) : (
                <FileVideo aria-hidden="true" className="size-6" />
              )}
            </span>
            <div className="flex flex-col gap-1">
              <p className="font-medium">
                {t(
                  query || filter !== "all"
                    ? "No recordings found"
                    : "Your first recording starts here"
                )}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t(
                  query || filter !== "all"
                    ? "Try a different name or clear the search."
                    : kind === "live"
                      ? "Start a live session to capture a conversation and create a summary."
                      : "Add a video to turn it into text and a summary you can share."
                )}
              </p>
            </div>
            {query || filter !== "all" ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch({ basis: query, text: "" })
                  router.replace(libraryPath(1), { scroll: false })
                }}
              >
                {t("Clear filters")}
              </Button>
            ) : (
              <Button variant="secondary" onClick={onCreate}>
                {t(kind === "live" ? "New live session" : "Add recording")}
              </Button>
            )}
          </Card.Content>
        </Card>
      ) : null}
    </section>
  )
}
