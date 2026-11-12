"use client"

import { useTranslations } from "@/components/locale-provider"
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
  isValidElement,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useAui } from "@assistant-ui/react"
import {
  MarkdownTextPrimitive,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown"
import { useTheme } from "next-themes"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import "katex/dist/katex.min.css"

import {
  type CodeActions,
  CodeActionsProvider,
} from "@/components/assistant-ui/code-actions"
import { CodeRunBlock } from "@/components/assistant-ui/code-run-block"
import { CodeToolbar } from "@/components/assistant-ui/code-toolbar"
import {
  DelimitedTable,
  JsonTree,
} from "@/components/assistant-ui/data-previews"
import { HtmlPreviewFrame } from "@/components/assistant-ui/html-preview-frame"
import {
  ChartPreview,
  DiffPreview,
  GraphvizPreview,
} from "@/components/assistant-ui/visual-previews"
import { api } from "@/lib/api"
import {
  buildPreviewDocument,
  fenceLanguage,
  looksLikeHTML,
  opensAsPreview,
  previewKind,
  previewLanguage,
  resolvePreviewLanguage,
  runnerLanguage,
} from "@/lib/code-preview"
import { isGeneratedPDFURL } from "@/lib/file-result-logic"
import { normalizeMath, replaceInlineMathSymbols } from "@/lib/inline-math"
import { cn } from "@/lib/utils"

type AssistantMarkdownProps = {
  className?: string
}

type StaticAssistantMarkdownProps = AssistantMarkdownProps & {
  content: string
}

type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> & { node?: unknown }

function MarkdownLink({
  children,
  href,
  node: _node,
  onClick,
  ...props
}: MarkdownLinkProps) {
  const { t } = useTranslations()

  void _node
  const [error, setError] = useState("")
  const [isDownloading, setIsDownloading] = useState(false)
  const pdfURL =
    typeof href === "string" && isGeneratedPDFURL(href) ? href : undefined

  if (!pdfURL) {
    return (
      <a href={href} onClick={onClick} {...props}>
        {children}
      </a>
    )
  }

  const downloadPDF = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (isDownloading) return
    setError("")
    setIsDownloading(true)
    try {
      const blob = await api.getBlob(pdfURL)
      const objectURL = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = objectURL
      link.download = "generated-document.pdf"
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 0)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The PDF could not be downloaded."
      )
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <>
      <a aria-busy={isDownloading} href={href} onClick={downloadPDF} {...props}>
        {children}
      </a>
      {error && (
        <span className="ml-2 text-destructive" role="alert">
          {t(error)}
        </span>
      )}
    </>
  )
}

const markdownClassName =
  "max-w-none text-sm leading-7 text-foreground [&_a]:text-primary [&_a]:underline-offset-2 [&_a:hover]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em] [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:bg-muted/50 [&_pre]:p-3 [&_strong]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5"

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown }

/** Models sometimes emit `![alt]()`; an empty src would reload the whole page. */
function MarkdownImage({ node: _node, src, alt, ...props }: MarkdownImageProps) {
  void _node
  if (typeof src !== "string" || src.trim() === "") {
    return alt ? <span className="text-muted-foreground">[{alt}]</span> : null
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt ?? ""} src={src} {...props} />
}

const inlineImagePattern = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/

/** The default transform blanks every `data:` URL; keep safe raster images. */
function urlTransform(url: string) {
  return inlineImagePattern.test(url) ? url : defaultUrlTransform(url)
}

/** Renders mermaid source to an <img>, so the SVG can never run scripts. */
function MermaidPreview({ code }: { code: string }) {
  const { t } = useTranslations()
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const [result, setResult] = useState<{
    key: string
    src?: string
    error?: string
  }>({ key: "" })
  const key = `${dark ? "dark" : "light"}:${code}`

  useEffect(() => {
    let active = true
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid")
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          flowchart: { htmlLabels: false },
        })
        const { svg } = await mermaid.render(id, code)
        if (active) {
          setResult({
            key,
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          })
        }
      } catch (caught) {
        // mermaid leaves its temporary render node behind on syntax errors
        document.getElementById(`d${id}`)?.remove()
        if (active) {
          setResult({
            key,
            error: caught instanceof Error ? caught.message : String(caught),
          })
        }
      }
    })()
    return () => {
      active = false
    }
  }, [code, dark, key])

  if (result.key !== key) {
    return (
      <p className="rounded-xl bg-muted/50 p-3 text-muted-foreground" role="status">
        {t("Loading…")}
      </p>
    )
  }
  if (result.error || !result.src) {
    return (
      <p className="rounded-xl bg-destructive/10 p-3 text-destructive" role="alert">
        {t("The diagram could not be rendered.")}
      </p>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={t("Diagram")}
      className={cn(
        "max-h-[32rem] w-full rounded-xl p-3",
        dark ? "bg-muted/30" : "bg-white"
      )}
      src={result.src}
    />
  )
}

/** Code/Preview switch for every block type that has a rendered form. */
function CodePreviewBlock({
  code,
  language,
  codeView,
}: {
  code: string
  language: string
  codeView: ReactNode
}) {
  const { t } = useTranslations()
  const kind = previewKind(language)
  const [showPreview, setShowPreview] = useState(opensAsPreview(kind))
  const tabClass = (active: boolean) =>
    cn(
      "rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
      active
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:text-foreground"
    )

  return (
    <div className="my-3">
      {showPreview ? (
        kind === "mermaid" ? (
          <MermaidPreview code={code} />
        ) : kind === "graphviz" ? (
          <GraphvizPreview code={code} />
        ) : kind === "chart" ? (
          <ChartPreview code={code} />
        ) : kind === "diff" ? (
          <DiffPreview code={code} />
        ) : kind === "json" ? (
          <JsonTree code={code} />
        ) : kind === "table" ? (
          <DelimitedTable code={code} language={language} />
        ) : kind === "markdown" ? (
          <div className="rounded-xl bg-muted/30 p-3">
            <StaticAssistantMarkdown content={code} />
          </div>
        ) : (
          <HtmlPreviewFrame srcDoc={buildPreviewDocument(code, language)} />
        )
      ) : (
        codeView
      )}
      <div className="mt-1 flex gap-1" role="tablist">
        <button
          aria-selected={!showPreview}
          className={tabClass(!showPreview)}
          onClick={() => setShowPreview(false)}
          role="tab"
          type="button"
        >
          {t("Code")}
        </button>
        <button
          aria-selected={showPreview}
          className={tabClass(showPreview)}
          onClick={() => setShowPreview(true)}
          role="tab"
          type="button"
        >
          {t("Preview")}
        </button>
      </div>
    </div>
  )
}

type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & { node?: unknown }

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children)
  }
  return ""
}

/** `pre` override for the static react-markdown renderer. */
function MarkdownPre({ node: _node, children, ...props }: MarkdownPreProps) {
  void _node
  const codeElement = isValidElement<{ className?: string; children?: ReactNode }>(
    children
  )
    ? children
    : null
  if (!codeElement) return <pre {...props}>{children}</pre>

  const className = codeElement.props.className
  const code = textOf(codeElement.props.children)
  const language = resolvePreviewLanguage(className, code)
  const runLanguage = runnerLanguage(className)
  const codeView = <pre {...props}>{children}</pre>

  return (
    <>
      <CodeToolbar code={code} language={fenceLanguage(className)} />
      {runLanguage ? (
        <CodeRunBlock code={code} codeView={codeView} language={runLanguage} />
      ) : language ? (
        <CodePreviewBlock code={code} codeView={codeView} language={language} />
      ) : (
        codeView
      )}
    </>
  )
}

/**
 * assistant-ui replaces `pre`/`code` for fenced blocks, so previews hook in
 * through its per-language `SyntaxHighlighter` slot instead.
 */
function PreviewSyntaxHighlighter({
  code,
  language,
  components: { Pre, Code },
}: SyntaxHighlighterProps) {
  const lang = previewLanguage(`language-${language}`) ?? "html"
  return (
    <CodePreviewBlock
      code={code}
      codeView={
        <Pre>
          <Code className={`language-${language}`}>{code}</Code>
        </Pre>
      }
      language={lang}
    />
  )
}

function RunnableSyntaxHighlighter({
  code,
  language,
  components: { Pre, Code },
}: SyntaxHighlighterProps) {
  const runLanguage = runnerLanguage(`language-${language}`) ?? "javascript"
  return (
    <CodeRunBlock
      code={code}
      codeView={
        <Pre>
          <Code className={`language-${language}`}>{code}</Code>
        </Pre>
      }
      language={runLanguage}
    />
  )
}

/** Blocks without a language tag: only full HTML documents get a preview. */
function UntaggedSyntaxHighlighter({
  code,
  components: { Pre, Code },
}: SyntaxHighlighterProps) {
  const codeView = (
    <Pre>
      <Code>{code}</Code>
    </Pre>
  )
  return looksLikeHTML(code) ? (
    <CodePreviewBlock code={code} codeView={codeView} language="html" />
  ) : (
    codeView
  )
}

/** Language label plus Copy/Save, shown above every fenced code block. */
function CodeToolbarHeader({
  language,
  code,
}: {
  language?: string | undefined
  code: string
}) {
  return <CodeToolbar code={code} language={language} />
}

const preview = { SyntaxHighlighter: PreviewSyntaxHighlighter }
const runnable = { SyntaxHighlighter: RunnableSyntaxHighlighter }

const componentsByLanguage = {
  "": { SyntaxHighlighter: UntaggedSyntaxHighlighter },
  html: preview,
  htm: preview,
  svg: preview,
  jsx: preview,
  tsx: preview,
  mermaid: preview,
  dot: preview,
  graphviz: preview,
  gv: preview,
  markdown: preview,
  md: preview,
  json: preview,
  csv: preview,
  tsv: preview,
  diff: preview,
  patch: preview,
  chart: preview,
  javascript: runnable,
  js: runnable,
  mjs: runnable,
  typescript: runnable,
  ts: runnable,
  python: runnable,
  python3: runnable,
  py: runnable,
  sql: runnable,
  sqlite: runnable,
}

type MarkdownPlugins = Pick<
  ComponentProps<typeof ReactMarkdown>,
  "remarkPlugins" | "rehypePlugins"
>

// Single-dollar math is normalised by `normalizeMath`, so prices stay text.
const markdownPlugins: MarkdownPlugins = {
  remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: false }]],
  rehypePlugins: [
    [rehypeKatex, { output: "html", throwOnError: false, strict: false }],
  ],
}

const prepareMarkdown = (text: string) =>
  normalizeMath(replaceInlineMathSymbols(text))

const markdownComponents = { a: MarkdownLink, img: MarkdownImage }
const assistantComponents = {
  ...markdownComponents,
  CodeHeader: CodeToolbarHeader,
}
// Only the static renderer needs the `pre` override; assistant-ui uses its own
// per-language SyntaxHighlighter slot and would otherwise wrap the block twice.
const staticMarkdownComponents = { ...markdownComponents, pre: MarkdownPre }

export function AssistantMarkdown({ className }: AssistantMarkdownProps = {}) {
  const aui = useAui()
  const actions = useMemo<CodeActions>(
    () => ({
      sendMessage: (text) => {
        const composer = aui.thread.composer()
        composer.setText(text)
        composer.send()
      },
    }),
    [aui]
  )
  return (
    <CodeActionsProvider value={actions}>
      <MarkdownTextPrimitive
        components={assistantComponents}
        componentsByLanguage={componentsByLanguage}
        preprocess={prepareMarkdown}
        urlTransform={urlTransform}
        {...markdownPlugins}
        className={cn(markdownClassName, className)}
      />
    </CodeActionsProvider>
  )
}

/** Renders persisted assistant output outside an assistant-ui message runtime. */
export function StaticAssistantMarkdown({
  content,
  className,
}: StaticAssistantMarkdownProps) {
  return (
    <div className={cn(markdownClassName, className)}>
      <ReactMarkdown
        components={staticMarkdownComponents}
        {...markdownPlugins}
        urlTransform={urlTransform}
      >
        {prepareMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
}
