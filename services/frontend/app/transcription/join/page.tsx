import { Suspense } from "react"

import { TranscriptionJoin } from "@/components/transcription-join"

export default function TranscriptionJoinPage() {
  return <Suspense fallback={<main className="min-h-full flex-1 bg-background" />}><TranscriptionJoin /></Suspense>
}
