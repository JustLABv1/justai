---
type: "query"
date: "2026-09-04T09:45:31.941175+00:00"
question: "Is it possible to support transcription of live streams and meetings? Like JustAI Joins a meeting and starts the transcription. Or Captures a Youtube or TV Livestream?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["LiveTranscriptionView()", "audio-worklet.js", "RealtimeStream", "OpenRealtime()", "TranscriptionManager", "TranscriptionJoinRequest", "TranscriptionRecording", "TranscriptionSource", "Worker"]
---

# Q: Is it possible to support transcription of live streams and meetings? Like JustAI Joins a meeting and starts the transcription. Or Captures a Youtube or TV Livestream?

## Answer

Expanded from original query via vocab: [audio, capture, live, media, pcm, realtime, room, segment, speaker, stream, transcription, worker]. JustAI already supports browser-based live transcription rooms: microphone PCM is captured in the frontend, sent over WebSocket, passed to realtime or chunked transcription providers, and persisted as timestamped segments with sources and speakers. It does not currently contain an autonomous Zoom, Meet, or Teams bot adapter, nor a direct YouTube or TV livestream source. Video transcription is upload-based and finite, while URL ingestion is text/HTML/JSON/XML only. The clean extension is to add audio ingress adapters for browser tab or system audio, direct HLS/RTMP-style streams, and sanctioned meeting integrations, all feeding the existing TranscriptionSession pipeline. Browser tab capture is the smallest first slice; autonomous meeting bots are the largest and require consent, platform integration, reconnect logic, and speaker mapping.

## Outcome

- Signal: useful

## Source Nodes

- LiveTranscriptionView()
- audio-worklet.js
- RealtimeStream
- OpenRealtime()
- TranscriptionManager
- TranscriptionJoinRequest
- TranscriptionRecording
- TranscriptionSource
- Worker