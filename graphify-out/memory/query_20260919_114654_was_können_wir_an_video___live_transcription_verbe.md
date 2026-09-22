---
type: "query"
date: "2026-09-19T11:46:54.720928+00:00"
question: "Was können wir an Video & Live Transcription verbessern? Fokusiere dich bitte auf UI, UX und Verbesserungen in Hinsicht Retry, Error handling, etc."
contributor: "graphify"
outcome: "useful"
source_nodes: ["LiveTranscriptionView()", "TranscriptionManager", "video-upload.ts", "VideoTranscriptionView()"]
---

# Q: Was können wir an Video & Live Transcription verbessern? Fokusiere dich bitte auf UI, UX und Verbesserungen in Hinsicht Retry, Error handling, etc.

## Answer

Expanded from original query via graph vocab: [live, transcription, recording, error, socket, media, audio, stream, status, source, segment, session]. Code review found: video upload already has three-attempt exponential part retries, resumable uploaded parts, polling recovery, and per-stage manual retry. Highest-priority gaps are live transcription's single global error string, missing capture reconnect, viewer initial-connect failures not retried, unrelated errors cleared on viewer open, recording chunk upload chain poisoned after one failed part, no MediaRecorder error handling, and misleading static production UI health values. Recommend typed per-operation state, actionable contextual recovery, retry countdown/manual retry, recording durability, idempotent state transitions, and honest derived health metrics.

## Outcome

- Signal: useful

## Source Nodes

- LiveTranscriptionView()
- TranscriptionManager
- video-upload.ts
- VideoTranscriptionView()