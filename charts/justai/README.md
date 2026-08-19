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
from `secrets.data.*` values. Do not commit those values.

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

## Optional pyannote diarization

The Helm chart includes the self-hosted pyannote service, disabled by default
because it downloads a gated model and needs substantially more memory than
the core JustAI services. Enable it after accepting the Hugging Face terms for
`pyannote/segmentation-3.0` and `pyannote/speaker-diarization-3.1`:

The chart uses Kubernetes-native `env`/`envFrom` entries for workload
configuration. Secret-backed values are resolved through `secrets.refs`, the
same mechanism used by the backend. The preferred production setup is to put
the model token, optional service token, and proxy credentials in an existing
Secret:

```bash
kubectl create secret generic justai-pyannote-secrets \
  --from-literal=hf-token=hf_... \
  --from-literal=service-token="$(openssl rand -hex 32)" \
  --from-literal=https-proxy=http://proxy.example:8080

helm upgrade --install justai ./charts/justai \
  --set pyannote.enabled=true \
  --set secrets.existingSecret=justai-secrets \
  --set secrets.refs.pyannoteHfToken.name=justai-pyannote-secrets \
  --set secrets.refs.pyannoteServiceToken.name=justai-pyannote-secrets \
  --set secrets.refs.pyannoteHttpsProxy.name=justai-pyannote-secrets
```

The Secret keys default to `hf-token`, `service-token`, `http-proxy`,
`https-proxy`, and `no-proxy`; override them under `secrets.refs` when your
Secret uses different names. The Hugging Face token is required to download
the gated model. The service token is optional, but when configured it must be
used as the credential on the JustAI Pyannote endpoint.

For a private test deployment only, `secrets.create=true` can create the
Secret from `secrets.data.pyannoteHfToken`, `secrets.data.pyannoteServiceToken`,
and the proxy data fields. Do not commit those values.

To send model downloads through a proxy without putting credentials in a
values file, use the Secret refs above. For non-sensitive proxy URLs, the
short form is:

```yaml
pyannote:
  proxy:
    http: http://proxy.example:8080
    https: http://proxy.example:8080
    noProxy:
      - localhost
      - .svc
```

These values become the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
environment variables, which are honored by Hugging Face Hub and the
Pyannote runtime. Additional Kubernetes-native entries can be supplied with
`pyannote.env` and `pyannote.envFrom`:

```yaml
pyannote:
  env:
    - name: HF_HUB_DISABLE_TELEMETRY
      value: "1"
  envFrom:
    - secretRef:
        name: pyannote-runtime-env
```

The generated Kubernetes Service is reachable inside the namespace at:

```text
http://<release-name>-justai-pyannote:8000
```

Create a JustAI endpoint using that URL, provider `Pyannote`, model
`pyannote/speaker-diarization-3.1`, and capability `Speaker diarization`.
Override `pyannote.image.repository` and `pyannote.image.tag` when using a
private image registry. The release workflow publishes the default image as a
`pyannote-*` tag alongside the backend and frontend images.

Prerecorded video transcription uses direct S3-compatible multipart uploads.
Set `config.transcription.storageDriver: s3`, provide the S3 credentials through
the backend environment or Secret, and configure bucket CORS for the public
frontend origin with `PUT`, `Content-Type`, and exposed `ETag`. The configured
S3 endpoint must be reachable by browsers; internal cluster DNS names will not
work for the upload URLs.
