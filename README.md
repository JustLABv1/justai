# JustAI

JustAI is the JustLAB workspace for routing chat, transcription, retrieval, and MCP tools through one local-first surface.

## Local development

1. Start PostgreSQL with pgvector:

   ```bash
   docker compose -f docker-compose.dev.yml up -d justai-postgres
   ```

2. Start the backend:

   ```bash
   cd services/backend
   cp config.example.yaml config.yaml
   go run . --config ./config.yaml
   ```

   The backend also accepts the short form `go run . -c ./config.yaml`.
   YAML values are loaded first; non-empty `JUSTAI_*` environment variables override them.

3. Start the frontend in another terminal:

   ```bash
   cd services/frontend
   pnpm install
   pnpm dev
   ```

Open [http://localhost:3000](http://localhost:3000). The production UI talks to the backend for authentication, persistence, retrieval, MCP, and transcription; it does not report successful work when the backend is unavailable.

## Product boundaries

- Provider keys and MCP credentials are encrypted and stay in the Go backend.
- Chat and transcription use short-lived WebSocket tickets rather than putting bearer tokens in socket URLs.
- RAG sources are scoped to an organization or user. URL ingestion blocks private and loopback targets by default.
- MCP uses outbound remote HTTP transports only. Tool names are allowlisted, tool calls require explicit approval by default, and only explicitly annotated read-only/non-destructive calls on trusted servers can run automatically. OAuth uses a backend-generated PKCE flow.
- The RAG worker stores chunks in PostgreSQL with full-text retrieval and optional provider-dimension embeddings; unavailable embeddings are reported as an explicit lexical-only state.
