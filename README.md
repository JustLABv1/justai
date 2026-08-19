# JustAI

<p align="center">
  <img src="services/frontend/public/images/logos/justai-logo.svg" alt="JustAI logo" width="96" />
</p>

JustAI is the JustLAB workspace for routing chat, transcription, retrieval, and MCP tools through one local-first surface.

## Local development

1. Start PostgreSQL with pgvector:

   ```bash
   docker compose -f docker-compose.dev.yml up -d justai-postgres
   ```

   To enable speaker separation for video transcription, start the optional
   local pyannote service as well. Accept the Hugging Face conditions for
   `pyannote/segmentation-3.0` and `pyannote/speaker-diarization-3.1` first:

   ```bash
   export HF_TOKEN=hf_...
   docker compose -f docker-compose.dev.yml --profile pyannote up -d --build justai-pyannote
   curl http://localhost:8001/healthz
   ```

   On macOS with Podman, allocate at least 8 GB to the Podman machine before
   processing long videos. A 2 GB machine can terminate the service with exit
   code `137` while pyannote is diarizing.

   Because the development backend runs directly on the host, configure the
   JustAI Pyannote endpoint with base URL `http://localhost:8001`. The
   container's internal name (`http://justai-pyannote:8000`) is only for a
   backend running inside the same Compose network.

   If S3/MinIO runs on the host at `http://localhost:9000`, keep that as the
   browser-facing `s3_endpoint` and set
   `s3_processing_endpoint: "http://host.containers.internal:9000"` for
   Podman. This gives pyannote a host-reachable signed URL without breaking
   browser uploads.

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

## Container deployment

The repository provides separate backend/frontend images and a combined image.
The Docker Compose installation is in [`deploy/compose`](deploy/compose) and
the Kubernetes chart is in [`charts/justai`](charts/justai). Published frontend
images use same-origin `/api/v1` requests, so route the browser through the
provided nginx/Ingress and keep the backend and frontend on one public origin.

For a Compose installation:

```bash
cd deploy/compose
cp .env.example .env
# Set the database, JWT, encryption, public-origin, and OIDC values in .env.
docker compose up -d
```

For Kubernetes, provide a Secret containing `database-url`, `jwt-secret`, and
`encryption-key`, then install `charts/justai`. Set
`postgresql.enabled=true` only when using the bundled pgvector database.

## Product boundaries

- Provider keys and MCP credentials are encrypted and stay in the Go backend.
- Chat and transcription use short-lived WebSocket tickets rather than putting bearer tokens in socket URLs.
- RAG sources are scoped to an organization or user. URL ingestion blocks private and loopback targets by default.
- MCP uses outbound remote HTTP transports only. Tool names are allowlisted, tool calls require explicit approval by default, and only explicitly annotated read-only/non-destructive calls on trusted servers can run automatically. OAuth uses a backend-generated PKCE flow.
- The RAG worker stores chunks in PostgreSQL with full-text retrieval and optional provider-dimension embeddings; unavailable embeddings are reported as an explicit lexical-only state.
