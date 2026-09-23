---
type: "query"
date: "2026-09-23T19:41:18.272492+00:00"
question: "Welche Features können wir noch hinzufügen, verbessern und auch die stabilität verbessern?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Worker", "Metric()", "transcriptionAudioFrame", ".createUploadedSource()"]
---

# Q: Welche Features können wir noch hinzufügen, verbessern und auch die stabilität verbessern?

## Answer

Erweiterte Graph-Suche mit diesen Begriffen aus dem Graph-Vokabular: [chat, transcript, transcription, upload, diarization, audio, test, error, health, worker, stream, metric].

JustAI bietet bereits Chat/RAG, MCP und Agent-Workflows, Live- und Video-Transkription sowie Health- und Stream-Metriken. Die stärksten nächsten Schritte sind: (1) zuverlässige, idempotente Wiederholung von Audio-Batches: Steuerereignisse nutzen postWithRetry, Audio-Batches werden in sse-transport.ts direkt gesendet und bei einem POST-Fehler aus dem Puffer entfernt; (2) Browser-Ende-zu-Ende-Tests für Chat-Streaming, Upload/RAG, Wiederaufnahme von Transkriptionsstreams und Videotranskript-Retries; (3) /metrics um RAG-Queue-Alter, Retry-/Fehlerzahlen, Video-Pipeline-Stufen, Provider-Latenzen und verlorene Audiobatches ergänzen und Alerts darauf setzen; (4) Retry-Backoff für Ingestion mit Jitter und klarer Klassifikation permanenter gegenüber temporären Fehlern. Als Produktideen: vorhandene Transkript-Insights (Zusammenfassung, Kapitel, Themen, Action Items) in zuweisbare Aufgaben/Workflow-Runs mit Status, Fälligkeit und Zeitstempel-Link überführen; sitzungsübergreifende Suche nach Entscheidungen und Aufgaben mit Sprung zum Transkript-Zeitpunkt. Relevante Quellen: services/frontend/lib/sse-transport.ts, services/backend/server/http_stream.go, services/backend/server/worker_health.go, services/backend/rag/ingest.go, services/backend/server/handlers_transcription_workspace.go.

## Outcome

- Signal: useful

## Source Nodes

- Worker
- Metric()
- transcriptionAudioFrame
- .createUploadedSource()