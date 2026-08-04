import { Suspense } from "react"

import { TranscriptionJoin } from "@/components/transcription-join"

export default function TranscriptionJoinPage() {
  return <Suspense fallback={<main className="min-h-svh bg-background" />}><TranscriptionJoin /></Suspense>
}
