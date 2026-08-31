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

## Custom CA for backend connections

When S3, a proxy, or another backend dependency presents a certificate signed
by an internal CA, mount the PEM certificate through `trustedCA`. This shared
setting is used by the backend and, when enabled, Pyannote. The chart mounts
the certificate and sets `SSL_CERT_FILE` for the backend, which is honored by
FFmpeg/FFprobe and the backend's TLS clients.

```bash
kubectl -n justai-dev create secret generic justai-s3-ca \
  --from-file=ca.crt=internal-root-ca.pem
```

```yaml
trustedCA:
  existingSecret: justai-s3-ca
```

Use `existingConfigMap` instead for a ConfigMap. The mounted object must
expose its PEM certificate under the key `ca.crt` (or set `trustedCA.key`).
Redeploy the release after rotating the certificate.

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
  --set secrets.refs.pyannoteHttpsProxy.name=justai-pyannote-secrets \
  --set-string 'pyannote.allowedMediaOrigins={https://s3.example.com}'
```

The Secret keys default to `hf-token`, `service-token`, `http-proxy`,
`https-proxy`, and `no-proxy`; override them under `secrets.refs` when your
Secret uses different names. The Hugging Face and service tokens are both
required; the service refuses to start without the latter, and it must be used
as the credential on the JustAI Pyannote endpoint. `pyannote.allowedMediaOrigins`
must list the exact S3/media scheme, host, and port. Add an origin to
`pyannote.allowPrivateMediaOrigins` only when that exact origin is intentionally
private (for example an in-cluster MinIO service).

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

If an HTTPS-inspecting proxy presents certificates signed by an internal CA,
mount that CA from a ConfigMap or Secret. The chart combines it with the
image's system trust bundle, preserving the public CA roots:

```bash
kubectl -n justai-dev create configmap corporate-proxy-ca \
  --from-file=ca.crt=corporate-proxy-root-ca.pem
```

```yaml
trustedCA:
  existingConfigMap: corporate-proxy-ca
  key: ca.crt
```

For a Secret-managed CA, use `existingSecret` instead (not both sources):

```yaml
trustedCA:
  existingSecret: corporate-proxy-ca
  key: ca.crt
```

Do not disable TLS verification or set `SSL_CERT_FILE` manually when using
this option; the chart sets it to the generated combined bundle.

### Offline pyannote models from S3

When cluster egress to Hugging Face is blocked, mirror the accepted model
repositories into S3 and enable `pyannote.modelStore`. The init container
downloads them into an `emptyDir` before the diarizer starts; the diarizer then
runs with `HF_HUB_OFFLINE=1` and receives no Hugging Face token.

The object layout must preserve the three directories produced by
`snapshot_download`:

```text
s3://<bucket>/pyannote/pyannote--speaker-diarization-3.1/...
s3://<bucket>/pyannote/pyannote--segmentation-3.0/...
s3://<bucket>/pyannote/pyannote--wespeaker-voxceleb-resnet34-LM/...
```

Use the existing S3 secret references. The credentials only go to the init
container, not to the running pyannote service:

```yaml
pyannote:
  enabled: true
  modelStore:
    enabled: true
    endpoint: https://s3.example.com
    region: eu-central-1
    bucket: justai-models
    prefix: pyannote
    # Required by many MinIO and other S3-compatible installations.
    forcePathStyle: true

secrets:
  refs:
    s3AccessKey:
      name: justai-s3-credentials
      key: s3-access-key
    s3SecretKey:
      name: justai-s3-credentials
      key: s3-secret-key
```

When `endpoint`, `region`, or `bucket` are omitted, the chart falls back to
the respective `config.transcription.s3ProcessingEndpoint` (then
`s3Endpoint`), `s3Region`, and `s3Bucket` values. The S3 identity must be able
to list the configured prefix and read its objects.

The generated Kubernetes Service is reachable inside the namespace at:

```text
http://<release-name>-justai-pyannote:8000
```

Create a JustAI endpoint using that URL, provider `Pyannote`, model
`pyannote/speaker-diarization-3.1`, and capability `Speaker diarization`.
Override `pyannote.image.repository` and `pyannote.image.tag` when using a
private image registry. The release workflow publishes the default image as a
`pyannote-*` tag alongside the backend and frontend images.

Prerecorded video transcription uses S3-compatible multipart uploads streamed
through the JustAI backend. Set `config.transcription.storageDriver: s3`,
configure the backend-reachable `s3Endpoint`, `s3Region`, and `s3Bucket`, and
put the S3 access and secret keys in the shared Secret reference fields:

```yaml
config:
  transcription:
    storageDriver: s3
    s3Endpoint: https://s3.example.com
    s3ProcessingEndpoint: http://minio.storage.svc.cluster.local:9000
    s3Region: us-east-1
    s3Bucket: justai-transcription

secrets:
  existingSecret: justai-secrets
  refs:
    s3AccessKey:
      name: justai-s3-credentials
      key: s3-access-key
    s3SecretKey:
      name: justai-s3-credentials
      key: s3-secret-key
```

`s3ProcessingEndpoint` is optional and is used for worker-side playback and
processing URLs when workers need a different endpoint from the backend. The
access and secret key values can instead be supplied in a private
values file under `secrets.data.s3AccessKey` and `secrets.data.s3SecretKey`
with `secrets.create=true`. The chart injects them as
`JUSTAI_TRANSCRIPTION_S3_ACCESS_KEY` and
`JUSTAI_TRANSCRIPTION_S3_SECRET_KEY` into the backend (and monolith) only when
S3 storage is enabled.

Video parts are uploaded to the same-origin JustAI backend, which streams each
part into the S3 multipart upload. The bucket therefore does not need browser
CORS rules and `s3Endpoint` only needs to be reachable by the backend. Use
`s3ProcessingEndpoint` when media workers need a different in-cluster address.
Ingresses and reverse proxies must allow request bodies at least as large as
`videoUploadPartBytes` (16 MiB by default) and should permit slow request-body
streaming for clients on constrained connections. Configure their request
timeout to at least ten minutes so it matches the browser's per-part timeout.
