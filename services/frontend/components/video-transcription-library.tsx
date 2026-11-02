"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import {
  AudioLines,
  Mic,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileVideo,
  LoaderCircle,
  Search,
  Upload,
} from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { VideoTranscriptionThumbnail } from "@/components/video-transcription-thumbnail"
import { api } from "@/lib/api"
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
  type VideoTranscriptionLibraryPage,
} from "@/lib/video-transcription-library"

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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            id="video-library-title"
            className="text-xl font-semibold tracking-tight"
          >
            {t(kind === "live" ? "Your live sessions" : "Your recordings")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Pick up where you left off, or add a new recording.")}
          </p>
        </div>
        <Button onClick={onCreate}>
          {kind === "live" ? (
            <Mic data-icon="inline-start" />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {t(kind === "live" ? "New live session" : "Add recording")}
        </Button>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t("Search recordings")}
            placeholder={t("Search recordings")}
            className="pl-9"
            maxLength={200}
            value={searchText}
            onChange={(event) =>
              setSearch({ basis: query, text: event.target.value })
            }
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {data && data.counts.failed > 0 && filter !== "failed" ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() =>
                router.push(libraryPath(1, searchText, "failed"), {
                  scroll: false,
                })
              }
            >
              {t("Failed")}{" "}
              <span className="tabular-nums">{data.counts.failed}</span>
            </Button>
          ) : null}
          <Select
            value={filter}
            onValueChange={(value) => {
              if (value)
                router.push(
                  libraryPath(1, searchText, videoLibraryFilter(value)),
                  { scroll: false }
                )
            }}
          >
            <SelectTrigger
              aria-label={t("Filter recordings")}
              className="min-w-44"
            >
              <SelectValue>
                {t(
                  {
                    all: "All recordings",
                    pending: "In progress",
                    completed: "Ready",
                    failed: "Failed",
                    cancelled: "Cancelled",
                  }[filter]
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {VIDEO_LIBRARY_FILTERS.filter(
                (value) => kind !== "live" || value !== "cancelled"
              ).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(
                    {
                      all: "All recordings",
                      pending: "In progress",
                      completed: "Ready",
                      failed: "Failed",
                      cancelled: "Cancelled",
                    }[value]
                  )}
                  {data ? ` (${data.counts[value]})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {data ? (
        <p className="-mt-3 text-sm text-muted-foreground" role="status">
          {data.total === 1
            ? t("1 recording")
            : t("{value0} recordings", { value0: data.total })}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("Your recordings could not be loaded.")}</AlertTitle>
          <AlertDescription>{t(error)}</AlertDescription>
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
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),22rem))] gap-5"
        >
          {Array.from({ length: 8 }, (_, index) => (
            <Card key={index} className="gap-0 p-0">
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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),22rem))] gap-5">
            {data.items.map((item) => (
              <Link
                key={item.id}
                href={workspacePath(
                  kind === "live" ? "transcription" : "video-transcription",
                  null,
                  item.id
                )}
                prefetch={false}
                className="group w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="h-full gap-0 p-0">
                  {kind === "live" ? (
                    <div className="flex aspect-video items-center justify-center bg-muted text-muted-foreground">
                      <AudioLines aria-hidden="true" className="size-12" />
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
                        variant={
                          item.status === "failed" ? "destructive" : "secondary"
                        }
                      >
                        {videoLibraryPending(item.status) &&
                        !["live", "paused", "waiting"].includes(item.status) ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : null}
                        {t(videoLibraryStep(item))}
                      </Badge>
                      {item.hasSummary ? (
                        <FileText
                          className="size-3.5 text-muted-foreground"
                          aria-label={t("With summary")}
                          role="img"
                        >
                          <title>{t("With summary")}</title>
                        </FileText>
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
                  variant="secondary"
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
                  variant="secondary"
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
        <Empty className="min-h-64 border-0">
          <EmptyHeader>
            <FileVideo className="mb-2 size-8 text-muted-foreground" />
            <EmptyTitle>
              {t(
                query || filter !== "all"
                  ? "No recordings found"
                  : "Your first recording starts here"
              )}
            </EmptyTitle>
            <EmptyDescription>
              {t(
                query || filter !== "all"
                  ? "Try a different name or clear the search."
                  : kind === "live"
                    ? "Start a live session to capture a conversation and create a summary."
                    : "Add a video to turn it into text and a summary you can share."
              )}
            </EmptyDescription>
          </EmptyHeader>
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
        </Empty>
      ) : null}
    </section>
  )
}
