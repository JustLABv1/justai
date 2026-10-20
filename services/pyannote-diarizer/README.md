# JustAI pyannote diarizer

This service hosts `pyannote/speaker-diarization-3.1` outside the Go backend.
It is intentionally a separate service because pyannote is a PyTorch pipeline,
not an OpenAI-compatible language model.

The image uses the versioned Minimus Python build/runtime pair
(`reg.mini.dev/python:3.14-dev` and `reg.mini.dev/python:3.14`). It installs the
matching CPU `torch`/`torchaudio` 2.11.0 wheels. A source-verified, fully
static FFmpeg 9.0.1 binary (with static OpenSSL) is built in a separate stage,
then copied into the shell-less production image. Release builds replace that
fallback stage with the digest-pinned shared artifact built from
`docker/ffmpeg/Dockerfile`, avoiding repeated FFmpeg/OpenSSL compilation. This
keeps FFmpeg’s HTTPS support while avoiding Alpine’s vulnerable FFmpeg package
tree. The prepared Minimus runtime filesystem is flattened onto a scratch stage
after removing its build-time Python packaging tools. This ensures layer-aware
scanners cannot recover pip's historical embedded SBOM or its stale setuptools
component from a deleted lower layer. The cleanup also removes the Minimus base
image's `/usr/share/python-wheels` bootstrap cache. On amd64, that cache contains
a pip wheel whose nested SBOM declares historical vendored packages even though
they are not importable.

## Hugging Face setup

Before starting the service, accept the user conditions for:

- `pyannote/segmentation-3.0`
- `pyannote/speaker-diarization-3.1`

Create a Hugging Face access token and provide it as `HF_TOKEN`. The token is
only needed by this service to download the model and should not be entered as
the JustAI provider credential.

The Hugging Face client honors the standard `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY` environment variables. Set them when the container needs an egress
proxy to reach Hugging Face; include the S3/media host in `NO_PROXY` when that
traffic must stay on the internal network.

## Offline model bundle

For restricted production networks, the Helm chart can synchronize an internal
S3 mirror into `/models` before this service starts. The bundle must contain
`pyannote--speaker-diarization-3.1`, `pyannote--segmentation-3.0`,
and `pyannote--wespeaker-voxceleb-resnet34-LM`, as created by
`huggingface_hub.snapshot_download`. Set
`PYANNOTE_MODEL_PATH=/models/pyannote--speaker-diarization-3.1` and
`PYANNOTE_SEGMENTATION_MODEL_PATH=/models/pyannote--segmentation-3.0` along
with the matching local embedding path. In this mode the service patches the
local pipeline configuration to use only local dependencies and does not
require `HF_TOKEN`. It also skips an unused PLDA download that pyannote.audio
4.x otherwise performs for this AgglomerativeClustering pipeline.

## Run locally

```bash
docker build -t justai-pyannote services/pyannote-diarizer
docker run --rm -p 8000:8000 \
  -e HF_TOKEN=hf_... \
  -e PYANNOTE_SERVICE_TOKEN=replace-with-a-long-random-token \
  -e PYANNOTE_ALLOWED_MEDIA_ORIGINS=https://s3.example.com \
  justai-pyannote
```

`PYANNOTE_SERVICE_TOKEN` is mandatory (the service refuses to start without
it). `PYANNOTE_ALLOWED_MEDIA_ORIGINS` is also mandatory and must contain the
exact scheme/host/port origin used by the backend's signed media URLs. Private
origins are rejected unless repeated in
`PYANNOTE_ALLOW_PRIVATE_MEDIA_ORIGINS`; redirects are limited and must remain
on the same origin. Downloads are bounded to the configured byte and timeout
limits, so do not use a broad wildcard or an untrusted public origin. The
source-size limit defaults to 5 GiB and accepts up to 20 GiB so installations
upgraded from older chart releases keep working. Runtime caches use writable
directories below `/tmp`, including Matplotlib's configuration cache.

For a CUDA build, pass a CUDA PyTorch index when building and run the container
with the NVIDIA container runtime:

```bash
docker build \
  --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu130 \
  -t justai-pyannote services/pyannote-diarizer
```

The backend calls `POST /v1/diarize` with a short-lived signed `media_url`.
The service downloads the media, extracts mono 16 kHz WAV with ffmpeg, runs the
pipeline once for the complete recording, and returns timestamped speaker
turns. Temporary media is deleted after the request finishes. Audio shorter than
`PYANNOTE_MIN_AUDIO_SECONDS` (default: `1`) is rejected before inference because
pyannote cannot produce reliable speaker statistics from an empty or tiny input.

Inference runs in PyTorch inference mode to avoid retaining gradient state. If
the process still exits while handling a long recording, check whether the
container was killed for memory rather than treating the pooling warning as the
root cause. On macOS, Podman runs Linux containers inside a VM; allocate at
least 8 GB to that VM for this model and a long recording. For example:

```bash
podman machine stop
podman machine set --memory 8192
podman machine start
```

`PYANNOTE_TORCH_THREADS` defaults to `2` to keep CPU thread memory bounded. It
can be lowered to `1` on a small development machine, at the cost of slower
inference.

## Long recordings and memory

Audio is decoded in blocks of at most 60 seconds into one CPU float32 tensor.
This removes the two full-size PCM byte buffers previously held during loading.
Six hours at 16 kHz still require approximately 1.29 GiB for that final tensor,
plus model weights, segmentation, embeddings, clustering and CUDA allocations.
GPU acceleration does not remove the need for container RAM. This change does
not guarantee that a six-hour recording fits within an 8 GiB memory limit.

The service still invokes the pipeline once for the whole recording so speaker
labels remain consistent across it. Extraction, waveform loading, inference and
result conversion are serialized within the single Uvicorn worker. Other media
downloads stream to disk before waiting so signed URLs do not expire in the
inference queue. The source video is removed after extraction; queued downloads
and the extracted WAV still need adequate disk-backed temporary storage. Do not
mount `/tmp` as a memory-backed volume for long recordings.

The following settings are available in both CPU and GPU images:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PYANNOTE_SEGMENTATION_BATCH_SIZE` | `1` | Segmentation inference batch size (1–128). |
| `PYANNOTE_EMBEDDING_BATCH_SIZE` | `1` | Speaker embedding batch size (1–128). |
| `PYANNOTE_MEMORY_LOG_INTERVAL_SECONDS` | `30` | Periodic sampling interval (0–3600); 0 disables periodic sampling. |

Larger batches may improve throughput but increase per-batch RAM/VRAM. They do
not bound the whole-recording clustering footprint. Phase-boundary logs remain
enabled even with a zero sampling interval. INFO messages report the current
phase, process RSS, process lifetime peak RSS, cgroup memory usage/limit where
available, and allocated/reserved CUDA memory on GPU. No media URLs, tokens or
transcript content are included. Diagnostic logging continues during clustering
even when the pipeline does not emit intermediate progress.

Run the regression tests in a built image without model downloads:

```bash
docker run --rm --network=none --entrypoint python \
  -v "$PWD/services/pyannote-diarizer/tests:/tests:ro" \
  justai-pyannote -m unittest discover -s /tests -v
```
