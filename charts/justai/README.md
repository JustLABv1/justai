# JustAI Helm chart

The chart supports two modes:

- `microservices` (default): separate backend and frontend images.
- `monolith`: the combined image built by the root `Dockerfile`.

The default chart expects an existing Kubernetes Secret. It must contain these
keys (or configure `secrets.refs` to use different names/keys):

```text
database-url
jwt-secret
encryption-key
```

When `postgresql.enabled=true`, it also needs `postgresql-password`. For a
quick private test deployment, `secrets.create=true` can create the Secret
from private values. Do not commit those values.

Example using an existing Secret:

```bash
helm upgrade --install justai ./charts/justai \
  --set secrets.existingSecret=justai-secrets \
  --set ingress.hosts[0].host=justai.example.com \
  --set ingress.tls[0].hosts[0]=justai.example.com \
  --set ingress.tls[0].secretName=justai-tls \
  --set uploads.persistence.enabled=true
```

The Secret's `database-url` should point to a pgvector-capable PostgreSQL
database. To run the bundled pgvector instance instead, set
`postgresql.enabled=true` and provide the password through the configured
Secret key.

The default frontend images are built for same-origin `/api/v1` requests. Keep
Ingress enabled unless you build the frontend image with an explicit
`NEXT_PUBLIC_API_URL` using `services/frontend/Dockerfile`.

The chart defaults to Kubernetes Pod Security Standards `restricted`: app and
PostgreSQL containers disable privilege escalation, drop all Linux capabilities,
use the runtime-default seccomp profile, and run without a privileged data
directory init container. PostgreSQL volume ownership is handled with `fsGroup`
(`999`) instead.

The OIDC callback defaults to the first Ingress host:

```text
https://justai.example.com/api/v1/auth/oidc/callback
```

Override `config.oidc.redirectUrl` when the backend uses another public host.

Prerecorded video transcription uses direct S3-compatible multipart uploads.
Set `config.transcription.storageDriver: s3`, provide the S3 credentials through
the backend environment or Secret, and configure bucket CORS for the public
frontend origin with `PUT`, `Content-Type`, and exposed `ETag`. The configured
S3 endpoint must be reachable by browsers; internal cluster DNS names will not
work for the upload URLs.
