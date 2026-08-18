# JustAI Docker Compose deployment

This stack runs the JustAI backend, frontend, pgvector PostgreSQL, and an
nginx edge proxy. The published frontend images use same-origin `/api/v1`
requests, so nginx is the normal entry point and keeps browser traffic on one
origin.

```bash
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD, JUSTAI_JWT_SECRET,
# JUSTAI_ENCRYPTION_KEY, and the public/OIDC URLs.
docker compose up -d
docker compose ps
```

By default the edge listens on port 80. Set `EDGE_HTTP_PORT` for a different
local port. The backend and frontend ports are also bound to loopback for
debugging, but should not be used as the public entry point with a published
same-origin frontend image.

Register `JUSTAI_OIDC_REDIRECT_URL` with each identity provider. For a local
default deployment this is:

```text
http://localhost/api/v1/auth/oidc/callback
```

The backend config file contains only non-secret defaults. Runtime
`JUSTAI_*` environment variables override it. For S3 transcription storage,
set `JUSTAI_TRANSCRIPTION_STORAGE_DRIVER=s3` and the corresponding S3
variables in `.env`. Prerecorded video uploads use browser-to-S3 multipart
uploads, so configure the bucket CORS policy for the public frontend origin,
allow `PUT` and `GET`, allow the `Content-Type` request header, and expose the
`ETag` response header. The configured S3 endpoint must also be reachable by
browsers (an internal Docker hostname is not sufficient). If worker containers
need a different route to the same bucket, set
`JUSTAI_TRANSCRIPTION_S3_PROCESSING_ENDPOINT`; it is used only for signed media
URLs sent to processing services such as pyannote. The backend defaults to a
5 GiB upload limit and a four-hour duration limit; override
`JUSTAI_TRANSCRIPTION_VIDEO_UPLOAD_MAX_BYTES` or
`JUSTAI_TRANSCRIPTION_VIDEO_UPLOAD_PART_BYTES` or
`JUSTAI_TRANSCRIPTION_VIDEO_MAX_DURATION_HOURS` when needed.

## Self-hosted pyannote diarization

The pyannote service is optional and runs under the `pyannote` Compose profile.
This deployment file lives in `deploy/compose`, so run the command from that
directory:

```bash
cd deploy/compose
export HF_TOKEN=hf_...
docker compose --profile pyannote up -d --build pyannote-diarizer
```

From the repository root, pass the Compose file explicitly instead:

```bash
export HF_TOKEN=hf_...
docker compose -f deploy/compose/compose.yaml --profile pyannote up -d --build pyannote-diarizer
```

After it starts, create a Pyannote endpoint in JustAI with:

```text
Provider: Pyannote (self-hosted)
Base URL: http://pyannote-diarizer:8000
Diarization model: pyannote/speaker-diarization-3.1
Capability: Speaker diarization
```

If `PYANNOTE_SERVICE_TOKEN` is set, enter the same value as the endpoint
credential. The Hugging Face token remains only in the pyannote service. The
backend sends the service a short-lived S3 URL, so the S3 endpoint must be
reachable from the pyannote container. When the browser-facing and
container-facing routes differ, configure both S3 endpoint variables.

For the development stack, use the root-level file and its service name:

```bash
docker compose -f docker-compose.dev.yml --profile pyannote up -d --build justai-pyannote
```

When the backend also runs in that Compose stack, use
`http://justai-pyannote:8000` as the endpoint URL. If the backend runs directly
on the host, use `http://localhost:8001` instead.

Speaker diarization loads several neural-network stages and needs more memory
than the default 2 GB Podman machine. On macOS, allocate at least 8 GB before
processing long videos:

```bash
podman machine stop
podman machine set --memory 8192
podman machine start
```
