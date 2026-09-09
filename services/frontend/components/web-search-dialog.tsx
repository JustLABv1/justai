"use client"

import { useState } from "react"
import { ExternalLink, Globe2, Loader2, Plus, Search } from "lucide-react"

import { api } from "@/lib/api"
import type { WebSearchResult } from "@/lib/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type WebSearchDialogProps = {
  onEnsureConversation: () => Promise<string>
  onAttached?: () => void
}

export function WebSearchDialog({
  onEnsureConversation,
  onAttached,
}: WebSearchDialogProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [urlInput, setURLInput] = useState("")
  const [results, setResults] = useState<WebSearchResult[]>([])
  const [preview, setPreview] = useState<{
    url: string
    content: string
  } | null>(null)
  const [searching, setSearching] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [attaching, setAttaching] = useState("")
  const [error, setError] = useState("")

  async function search() {
    const value = query.trim()
    if (!value || searching) return
    setSearching(true)
    setError("")
    try {
      const response = await api.get<{ results: WebSearchResult[] }>(
        `/api/v1/web/search?q=${encodeURIComponent(value)}`
      )
      setResults(response.results)
      setPreview(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Web search failed.")
    } finally {
      setSearching(false)
    }
  }

  async function browse(result: WebSearchResult) {
    setPreviewing(true)
    setError("")
    try {
      const response = await api.get<{ url: string; content: string }>(
        `/api/v1/web/fetch?url=${encodeURIComponent(result.url)}`
      )
      setPreview(response)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "This URL could not be browsed."
      )
    } finally {
      setPreviewing(false)
    }
  }

  async function browseDirect() {
    const value = urlInput.trim()
    if (!/^https?:\/\//i.test(value)) {
      setError("Enter a complete http:// or https:// URL.")
      return
    }
    await browse({ title: value, url: value, snippet: "" })
  }

  async function attach(result: WebSearchResult) {
    setAttaching(result.url)
    setError("")
    try {
      const conversationId = await onEnsureConversation()
      await api.post(
        `/api/v1/conversations/${conversationId}/attachments/url`,
        {
          title: result.title,
          url: result.url,
        }
      )
      onAttached?.()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The URL could not be attached."
      )
    } finally {
      setAttaching("")
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label="Search the web"
            size="icon-sm"
            title="Search the web"
            variant="ghost"
          />
        }
      >
        <Globe2 />
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(44rem,calc(100vh-2rem))] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Web search and browsing</DialogTitle>
          <DialogDescription>
            Search the public web, preview a page, or attach it as durable chat
            context.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert aria-live="polite" role="alert" variant="destructive">
            <AlertTitle>Web action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <Input
            aria-label="Web search query"
            autoFocus
            id="web-search-query"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the web…"
            value={query}
          />
          <Button disabled={searching || !query.trim()} type="submit">
            {searching ? <Loader2 className="animate-spin" /> : <Search />}
            Search
          </Button>
        </form>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void browseDirect()
          }}
        >
          <Input
            aria-label="URL to browse"
            id="web-browse-url"
            onChange={(event) => setURLInput(event.target.value)}
            placeholder="Or browse a URL directly, e.g. https://example.com"
            type="url"
            value={urlInput}
          />
          <Button
            disabled={previewing || !urlInput.trim()}
            type="submit"
            variant="outline"
          >
            {previewing ? <Loader2 className="animate-spin" /> : <Globe2 />}
            Browse URL
          </Button>
        </form>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto rounded-lg border">
            <div className="flex flex-col gap-1 p-2">
              {results.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Search results will appear here.
                </p>
              ) : (
                results.map((result) => (
                  <article
                    className="rounded-lg p-3 hover:bg-muted/60"
                    key={result.url}
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <a
                          className="line-clamp-2 text-sm font-medium hover:underline"
                          href={result.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {result.title}
                        </a>
                        <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                          {result.snippet || result.url}
                        </p>
                        <Badge className="mt-2" variant="outline">
                          {result.domain || new URL(result.url).hostname}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        <Button
                          aria-label={`Preview ${result.title}`}
                          disabled={previewing}
                          onClick={() => void browse(result)}
                          size="icon-sm"
                          title="Preview page"
                          type="button"
                          variant="ghost"
                        >
                          {previewing && preview?.url === result.url ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Globe2 />
                          )}
                        </Button>
                        <Button
                          aria-label={`Attach ${result.title} to chat`}
                          disabled={attaching === result.url}
                          onClick={() => void attach(result)}
                          size="icon-sm"
                          title="Attach to chat"
                          type="button"
                          variant="ghost"
                        >
                          {attaching === result.url ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Plus />
                          )}
                        </Button>
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto rounded-xl bg-muted/50">
            {preview ? (
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">
                      Page preview
                    </p>
                    <p className="mt-1 text-xs break-all">{preview.url}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      aria-label="Attach preview to chat"
                      disabled={attaching === preview.url}
                      onClick={() =>
                        void attach({
                          title: preview.url,
                          url: preview.url,
                          snippet: "",
                        })
                      }
                      size="icon-sm"
                      title="Attach page to chat"
                      type="button"
                      variant="ghost"
                    >
                      {attaching === preview.url ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Plus />
                      )}
                    </Button>
                    <Button
                      aria-label="Open preview in a new tab"
                      onClick={() =>
                        window.open(
                          preview.url,
                          "_blank",
                          "noopener,noreferrer"
                        )
                      }
                      size="icon-sm"
                      title="Open page"
                      type="button"
                      variant="ghost"
                    >
                      <ExternalLink />
                    </Button>
                  </div>
                </div>
                <p className="mt-4 text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
                  {preview.content}
                </p>
              </div>
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                Select Preview on a result to read a safe text extraction.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => setOpen(false)}
            type="button"
            variant="outline"
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
