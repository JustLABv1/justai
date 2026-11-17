"use client"

import { Download } from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { downloadFile } from "@/lib/download-file"

/**
 * Downloads agenda items as Markdown or PDF: only the summaries, or with the transcript.
 * `path` is the export endpoint without the format, e.g. `/topics/<id>/export`.
 */
export function TopicExportMenu({
  path,
  fileName,
  label,
  onError,
}: {
  path: string
  fileName: string
  label?: string
  onError: (message: string) => void
}) {
  const { t } = useTranslations()
  const download = (format: "md" | "pdf", transcript: boolean) =>
    void downloadFile(
      `${path}/${format}${transcript ? "?transcript=1" : ""}`,
      `${fileName}.${format}`
    ).catch((caught) =>
      onError(
        caught instanceof Error ? caught.message : t("The download failed.")
      )
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        <Download data-icon="inline-start" /> {label ?? t("Export")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("Summary only")}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => download("pdf", false)}>
            PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => download("md", false)}>
            Markdown
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("With transcript")}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => download("pdf", true)}>
            PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => download("md", true)}>
            Markdown
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
