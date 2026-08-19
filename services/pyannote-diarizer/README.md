# JustAI pyannote diarizer

This service hosts `pyannote/speaker-diarization-3.1` outside the Go backend.
It is intentionally a separate service because pyannote is a PyTorch pipeline,
not an OpenAI-compatible language model.

The image uses the versioned Minimus Python build/runtime pair
(`reg.mini.dev/python:3.14-dev` and `reg.mini.dev/python:3.14`). It installs the
matching CPU `torch`/`torchaudio` 2.9.1 wheels. FFmpeg is installed only in the
build stage; the final image contains the executable and its resolved runtime
libraries without a shell or package manager.

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

## Run locally

```bash
docker build -t justai-pyannote services/pyannote-diarizer
docker run --rm -p 8000:8000 \
  -e HF_TOKEN=hf_... \
  -e PYANNOTE_SERVICE_TOKEN=change-me \
  justai-pyannote
```

For a CUDA build, pass a CUDA PyTorch index when building and run the container
with the NVIDIA container runtime:

```bash
docker build \
  --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu126 \
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
