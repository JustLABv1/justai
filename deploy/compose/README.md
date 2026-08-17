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
browsers (an internal Docker hostname is not sufficient). The backend defaults
to a 5 GiB upload limit and a four-hour duration limit; override
`JUSTAI_TRANSCRIPTION_VIDEO_UPLOAD_MAX_BYTES` or
`JUSTAI_TRANSCRIPTION_VIDEO_UPLOAD_PART_BYTES` or
`JUSTAI_TRANSCRIPTION_VIDEO_MAX_DURATION_HOURS` when needed.
