import { Suspense } from "react"

import { TranscriptionViewer } from "@/components/transcription-viewer"

export default function TranscriptionViewPage() {
  return (
    <Suspense fallback={<main className="min-h-full flex-1 bg-background" />}>
      <TranscriptionViewer />
    </Suspense>
  )
}
