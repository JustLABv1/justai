"""Small internal HTTP service for pyannote speaker diarization.

The service deliberately owns the pyannote and Hugging Face dependencies. The
JustAI backend only has to send a short-lived media URL and consume timestamped
speaker turns, so it does not need to embed Python or a GPU runtime.
"""

from __future__ import annotations

import hmac
import inspect
import ipaddress
import logging
import math
import os
import resource
import socket
import ssl
import subprocess
import tempfile
import time
import wave
import warnings
from pathlib import Path
from shutil import copytree
from threading import Event, Lock, Thread
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
import torch
from fastapi import FastAPI, HTTPException, Request
from pydantic import AnyHttpUrl, BaseModel, Field

# pyannote.audio warns when TorchCodec cannot load shared FFmpeg libraries.
# This service intentionally bypasses its path decoder and always passes a
# normalized in-memory waveform, so that optional decoder is never exercised.
warnings.filterwarnings(
    "ignore",
    message=r"\s*torchcodec is not installed correctly",
    category=UserWarning,
    module=r"pyannote\.audio\.core\.io",
)
from pyannote.audio import Pipeline
from pyannote.audio.pipelines import speaker_diarization


# Use Uvicorn's configured handlers so INFO diagnostics reach container logs.
logger = logging.getLogger("uvicorn.error.pyannote")

MODEL_ID = os.getenv(
    "PYANNOTE_MODEL_ID", "pyannote/speaker-diarization-3.1"
)
MODEL_PATH = os.getenv("PYANNOTE_MODEL_PATH", "").strip()
SEGMENTATION_MODEL_PATH = os.getenv("PYANNOTE_SEGMENTATION_MODEL_PATH", "").strip()
EMBEDDING_MODEL_PATH = os.getenv("PYANNOTE_EMBEDDING_MODEL_PATH", "").strip()
HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
SERVICE_TOKEN = os.getenv("PYANNOTE_SERVICE_TOKEN", "").strip()
DEVICE_NAME = os.getenv("PYANNOTE_DEVICE", "auto").strip().lower()
TORCH_THREADS = int(os.getenv("PYANNOTE_TORCH_THREADS", "2"))
DOWNLOAD_TIMEOUT_SECONDS = float(os.getenv("PYANNOTE_DOWNLOAD_TIMEOUT_SECONDS", "1800"))
MAX_SOURCE_BYTES = int(os.getenv("PYANNOTE_MAX_SOURCE_BYTES", str(5 * 1024 * 1024 * 1024)))
MAX_CONFIGURED_DOWNLOAD_TIMEOUT_SECONDS = 30 * 60
# Releases before the download hardening used 20 GiB as the Helm default.
# Keep that value as the bounded upper limit so existing installations can
# upgrade without the new image rejecting their retained configuration.
MAX_CONFIGURED_SOURCE_BYTES = 20 * 1024 * 1024 * 1024
ALLOWED_MEDIA_ORIGINS = tuple(
    origin.strip().rstrip("/")
    for origin in os.getenv("PYANNOTE_ALLOWED_MEDIA_ORIGINS", "").split(",")
    if origin.strip()
)
ALLOW_PRIVATE_MEDIA_ORIGINS = tuple(
    origin.strip().rstrip("/")
    for origin in os.getenv("PYANNOTE_ALLOW_PRIVATE_MEDIA_ORIGINS", "").split(",")
    if origin.strip()
)
MAX_REDIRECTS = 3
MIN_AUDIO_SECONDS = float(os.getenv("PYANNOTE_MIN_AUDIO_SECONDS", "1"))
SEGMENTATION_BATCH_SIZE = int(os.getenv("PYANNOTE_SEGMENTATION_BATCH_SIZE", "1"))
EMBEDDING_BATCH_SIZE = int(os.getenv("PYANNOTE_EMBEDDING_BATCH_SIZE", "1"))
MEMORY_LOG_INTERVAL_SECONDS = float(os.getenv("PYANNOTE_MEMORY_LOG_INTERVAL_SECONDS", "30"))
# A minute of mono PCM is less than 2 MiB. Never retain the full PCM source
# alongside the full float32 waveform (six hours would add two ~659 MiB copies).
AUDIO_READ_SECONDS = 60

for name, value in (
    ("PYANNOTE_SEGMENTATION_BATCH_SIZE", SEGMENTATION_BATCH_SIZE),
    ("PYANNOTE_EMBEDDING_BATCH_SIZE", EMBEDDING_BATCH_SIZE),
):
    if not 1 <= value <= 128:
        raise RuntimeError(f"{name} must be between 1 and 128")
if (
    not math.isfinite(MEMORY_LOG_INTERVAL_SECONDS)
    or not 0 <= MEMORY_LOG_INTERVAL_SECONDS <= 3600
):
    raise RuntimeError("PYANNOTE_MEMORY_LOG_INTERVAL_SECONDS must be between 0 and 3600")

if not SERVICE_TOKEN:
    raise RuntimeError("PYANNOTE_SERVICE_TOKEN is required; refusing to start unauthenticated")
if len(SERVICE_TOKEN) < 16:
    raise RuntimeError("PYANNOTE_SERVICE_TOKEN must be at least 16 characters")
if not ALLOWED_MEDIA_ORIGINS:
    raise RuntimeError("PYANNOTE_ALLOWED_MEDIA_ORIGINS must contain at least one exact origin")
if DOWNLOAD_TIMEOUT_SECONDS <= 0 or DOWNLOAD_TIMEOUT_SECONDS > MAX_CONFIGURED_DOWNLOAD_TIMEOUT_SECONDS:
    raise RuntimeError(
        f"PYANNOTE_DOWNLOAD_TIMEOUT_SECONDS must be between 1 and {MAX_CONFIGURED_DOWNLOAD_TIMEOUT_SECONDS}"
    )
if MAX_SOURCE_BYTES <= 0 or MAX_SOURCE_BYTES > MAX_CONFIGURED_SOURCE_BYTES:
    raise RuntimeError(
        "PYANNOTE_MAX_SOURCE_BYTES "
        f"({MAX_SOURCE_BYTES}) must be between 1 and {MAX_CONFIGURED_SOURCE_BYTES}"
    )


def resolve_device() -> torch.device:
    if DEVICE_NAME and DEVICE_NAME != "auto":
        return torch.device(DEVICE_NAME)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


DEVICE = resolve_device()
if TORCH_THREADS > 0:
    torch.set_num_threads(TORCH_THREADS)


def load_pipeline() -> Pipeline:
    model_source: str | Path = MODEL_ID
    skip_unused_plda = False
    if MODEL_PATH:
        source_directory = Path(MODEL_PATH)
        if not source_directory.is_dir():
            raise RuntimeError(f"PYANNOTE_MODEL_PATH does not exist: {source_directory}")
        if not (source_directory / "config.yaml").is_file():
            raise RuntimeError(f"PYANNOTE_MODEL_PATH has no config.yaml: {source_directory}")

        local_references = {
            "pyannote/segmentation-3.0": (
                "PYANNOTE_SEGMENTATION_MODEL_PATH", SEGMENTATION_MODEL_PATH
            ),
            "pyannote/wespeaker-voxceleb-resnet34-LM": (
                "PYANNOTE_EMBEDDING_MODEL_PATH", EMBEDDING_MODEL_PATH
            ),
        }
        resolved_references: dict[str, Path] = {}
        for remote_reference, (environment_name, local_path) in local_references.items():
            if not local_path:
                raise RuntimeError(
                    f"{environment_name} is required with PYANNOTE_MODEL_PATH"
                )
            local_directory = Path(local_path)
            if not local_directory.is_dir():
                raise RuntimeError(f"{environment_name} does not exist: {local_directory}")
            resolved_references[remote_reference] = local_directory.resolve()

        # speaker-diarization-3.1 references segmentation and embedding models
        # by Hub ID. Replace them in a per-process copy so an S3-mounted bundle
        # remains fully offline.
        model_source = Path(tempfile.mkdtemp(prefix="pyannote-pipeline-")) / "pipeline"
        copytree(source_directory, model_source)
        config_path = model_source / "config.yaml"
        config = config_path.read_text(encoding="utf-8")
        for remote_reference, local_directory in resolved_references.items():
            if remote_reference not in config:
                raise RuntimeError(
                    f"PYANNOTE_MODEL_PATH config does not reference {remote_reference}"
                )
            config = config.replace(remote_reference, str(local_directory))

        params_marker = "  params:\n"
        if params_marker not in config:
            raise RuntimeError("PYANNOTE_MODEL_PATH config has no pipeline params section")
        # pyannote.audio 4.x eagerly downloads the PLDA default even though
        # speaker-diarization-3.1 explicitly uses AgglomerativeClustering and
        # therefore never consumes it. Avoid that unrelated, gated download.
        skip_unused_plda = "clustering: AgglomerativeClustering" in config
        config_path.write_text(config, encoding="utf-8")

    if not HF_TOKEN and not MODEL_PATH:
        raise RuntimeError(
            "HF_TOKEN is required unless PYANNOTE_MODEL_PATH points to a local pipeline"
        )

    kwargs: dict[str, str] = {}
    if HF_TOKEN:
        parameters = inspect.signature(Pipeline.from_pretrained).parameters
        if "token" in parameters:
            auth_keyword = "token"
        elif "use_auth_token" in parameters:
            # pyannote.audio 3.x uses the legacy keyword. The requirements pin a
            # pre-1.0 huggingface_hub release because that loader still forwards
            # use_auth_token to hf_hub_download.
            auth_keyword = "use_auth_token"
        else:
            raise RuntimeError(
                "installed pyannote.audio exposes neither token nor use_auth_token"
            )
        kwargs[auth_keyword] = HF_TOKEN
    original_get_plda = speaker_diarization.get_plda
    if skip_unused_plda:
        speaker_diarization.get_plda = lambda *args, **kwargs: None
    try:
        pipeline = Pipeline.from_pretrained(model_source, **kwargs)
    finally:
        speaker_diarization.get_plda = original_get_plda
    if pipeline is None:
        raise RuntimeError(f"could not load pyannote pipeline {MODEL_ID}")
    pipeline.segmentation_batch_size = SEGMENTATION_BATCH_SIZE
    pipeline.embedding_batch_size = EMBEDDING_BATCH_SIZE
    pipeline.to(DEVICE)
    logger.info(
        "loaded pyannote pipeline (device=%s, segmentation_batch_size=%d, embedding_batch_size=%d)",
        DEVICE,
        SEGMENTATION_BATCH_SIZE,
        EMBEDDING_BATCH_SIZE,
    )
    return pipeline


PIPELINE = load_pipeline()
PIPELINE_LOCK = Lock()

app = FastAPI(title="JustAI pyannote diarizer", version="1.0.0")


class DiarizeRequest(BaseModel):
    media_url: AnyHttpUrl
    model: str | None = None
    language: str | None = None
    num_speakers: int | None = Field(default=None, ge=1, le=128)
    min_speakers: int | None = Field(default=None, ge=1, le=128)
    max_speakers: int | None = Field(default=None, ge=1, le=128)


class DiarizationTurn(BaseModel):
    speaker: str
    start: float
    end: float


class DiarizeResponse(BaseModel):
    model: str
    device: str
    speakers: list[str]
    segments: list[DiarizationTurn]


def memory_stats() -> dict[str, float | None]:
    """Best-effort diagnostics: missing procfs/cgroup files must not fail a job."""
    mib = 1024 * 1024
    stats: dict[str, float | None] = {}
    try:
        resident_pages = int(Path("/proc/self/statm").read_text().split()[1])
        stats["rss_mib"] = round(resident_pages * os.sysconf("SC_PAGE_SIZE") / mib, 1)
    except (OSError, ValueError, IndexError):
        stats["rss_mib"] = None
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    stats["process_peak_rss_mib"] = round(
        peak / (mib if os.uname().sysname == "Darwin" else 1024), 1
    )
    for name, paths in (
        (
            "cgroup_memory_mib",
            ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
        ),
        (
            "cgroup_limit_mib",
            ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        ),
    ):
        stats[name] = None
        for path in paths:
            try:
                stats[name] = round(int(Path(path).read_text().strip()) / mib, 1)
                break
            except (OSError, ValueError):
                continue
    if DEVICE.type == "cuda" and torch.cuda.is_initialized():
        stats["cuda_allocated_mib"] = round(torch.cuda.memory_allocated(DEVICE) / mib, 1)
        stats["cuda_reserved_mib"] = round(torch.cuda.memory_reserved(DEVICE) / mib, 1)
    return stats


class MemoryMonitor:
    """Sample even while clustering is busy and cannot report pipeline progress."""

    def __init__(self) -> None:
        self.phase = "audio_extraction"
        self.stopped = Event()
        self.thread: Thread | None = None

    def log(self) -> None:
        logger.info("pyannote memory phase=%s stats=%s", self.phase, memory_stats())

    def set_phase(self, phase: str) -> None:
        if self.phase != phase:
            self.phase = phase
            self.log()

    def hook(self, step_name: str, *args: Any, **kwargs: Any) -> None:
        # Do not retain step_artifact/file: these can contain the entire audio
        # and segmentation arrays. Only keep the small phase name.
        self.set_phase(f"inference:{step_name}")

    def sample(self) -> None:
        while not self.stopped.wait(MEMORY_LOG_INTERVAL_SECONDS):
            self.log()

    def __enter__(self) -> MemoryMonitor:
        self.log()
        if MEMORY_LOG_INTERVAL_SECONDS > 0:
            self.thread = Thread(target=self.sample, name="pyannote-memory", daemon=True)
            self.thread.start()
        return self

    def __exit__(self, error_type: Any, error: Any, traceback: Any) -> None:
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=2)
        self.phase = "failed" if error_type else "finished"
        self.log()


def require_service_token(request: Request) -> None:
    authorization = request.headers.get("authorization", "")
    if not hmac.compare_digest(authorization, f"Bearer {SERVICE_TOKEN}"):
        raise HTTPException(status_code=401, detail="invalid service token")


def origin_for_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="media_url must be an absolute HTTP(S) URL without credentials")
    try:
        port = parsed.port
    except ValueError as error:
        raise HTTPException(status_code=400, detail="media_url has an invalid port") from error
    effective_port = port or (443 if parsed.scheme == "https" else 80)
    return f"{parsed.scheme}://{parsed.hostname.lower()}:{effective_port}"


def validate_media_url(
    url: str, expected_origin: str | None = None
) -> tuple[str, tuple[str, ...]]:
    origin = origin_for_url(url)
    allowed_origins = {origin_for_url(value) for value in ALLOWED_MEDIA_ORIGINS}
    private_origins = {origin_for_url(value) for value in ALLOW_PRIVATE_MEDIA_ORIGINS}
    if origin not in allowed_origins:
        raise HTTPException(status_code=400, detail="media_url origin is not allowlisted")
    if expected_origin is not None and origin != expected_origin:
        raise HTTPException(status_code=502, detail="media URL redirect changed origin")
    parsed = urlsplit(url)
    host = parsed.hostname
    assert host is not None
    try:
        addresses = {
            ipaddress.ip_address(info[4][0])
            for info in socket.getaddrinfo(
                host,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        }
    except (socket.gaierror, ValueError) as error:
        raise HTTPException(status_code=502, detail="media URL hostname could not be resolved") from error
    if not addresses:
        raise HTTPException(status_code=502, detail="media URL hostname has no addresses")
    # A private origin is allowed only because its exact scheme/host/port was
    # explicitly configured above. Public origins must never resolve to a
    # private, reserved, multicast, or CGNAT address.
    if not all(address.is_global for address in addresses) and origin not in private_origins:
        raise HTTPException(status_code=400, detail="media URL resolves to a non-public address")
    return origin, tuple(sorted(address.compressed for address in addresses))


def pinned_media_url(url: str, address: str) -> str:
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    literal = f"[{address}]" if ":" in address else address
    return urlunsplit(
        (parsed.scheme, f"{literal}:{port}", parsed.path or "/", parsed.query, "")
    )


def media_ssl_context() -> ssl.SSLContext:
    # httpx disables SSL_CERT_FILE together with proxy environment variables
    # when trust_env=False. Keep proxy handling disabled for SSRF protection,
    # but explicitly load the chart-provided CA bundle for media downloads.
    certificate_file = os.getenv("SSL_CERT_FILE", "").strip()
    return ssl.create_default_context(cafile=certificate_file or None)


def download_source(url: str, destination: Path) -> None:
    current_url = url
    current_origin, _ = validate_media_url(current_url)
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    inactivity_timeout = min(DOWNLOAD_TIMEOUT_SECONDS, 30.0)
    try:
        with httpx.Client(
            follow_redirects=False,
            verify=media_ssl_context(),
            timeout=httpx.Timeout(
                inactivity_timeout, connect=min(15.0, inactivity_timeout)
            ),
            # Media egress is validated and allowlisted by this service; do
            # not let ambient proxy variables bypass that decision.
            trust_env=False,
        ) as client:
            for redirect_count in range(MAX_REDIRECTS + 1):
                if time.monotonic() >= deadline:
                    raise HTTPException(
                        status_code=504, detail="source media download timed out"
                    )
                _, addresses = validate_media_url(current_url, current_origin)
                parsed = urlsplit(current_url)
                assert parsed.hostname is not None
                redirected = False
                last_transport_error: httpx.TransportError | None = None
                for address in addresses:
                    try:
                        with client.stream(
                            "GET",
                            pinned_media_url(current_url, address),
                            headers={"Host": parsed.netloc},
                            extensions={"sni_hostname": parsed.hostname},
                        ) as response:
                            if response.is_redirect:
                                location = response.headers.get("location")
                                if not location or redirect_count >= MAX_REDIRECTS:
                                    raise HTTPException(
                                        status_code=502,
                                        detail="source media redirect limit exceeded",
                                    )
                                current_url = urljoin(current_url, location)
                                redirected = True
                                break
                            response.raise_for_status()
                            content_length = response.headers.get("content-length")
                            if content_length:
                                try:
                                    if int(content_length) > MAX_SOURCE_BYTES:
                                        raise HTTPException(
                                            status_code=413,
                                            detail="source media is too large",
                                        )
                                except ValueError as error:
                                    raise HTTPException(
                                        status_code=502,
                                        detail="source media returned an invalid content length",
                                    ) from error
                            downloaded = 0
                            with destination.open("wb") as output:
                                for chunk in response.iter_bytes(1024 * 1024):
                                    if time.monotonic() >= deadline:
                                        raise HTTPException(
                                            status_code=504,
                                            detail="source media download timed out",
                                        )
                                    downloaded += len(chunk)
                                    if downloaded > MAX_SOURCE_BYTES:
                                        raise HTTPException(
                                            status_code=413,
                                            detail="source media is too large",
                                        )
                                    output.write(chunk)
                            return
                    except httpx.TransportError as error:
                        last_transport_error = error
                if redirected:
                    continue
                if last_transport_error is not None:
                    raise last_transport_error
                raise HTTPException(
                    status_code=502, detail="media URL hostname has no addresses"
                )
            raise HTTPException(status_code=502, detail="source media redirect limit exceeded")
    except httpx.HTTPStatusError as error:
        logger.warning(
            "source media download returned an HTTP error (status=%s)",
            error.response.status_code,
        )
        raise HTTPException(
            status_code=502,
            detail=f"could not download source media ({error.response.status_code})",
        ) from error
    except httpx.HTTPError as error:
        logger.warning("source media download failed: %s", error)
        raise HTTPException(
            status_code=502, detail=f"could not download source media: {error}"
        ) from error


def extract_audio(source: Path, destination: Path) -> None:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-err_detect",
        "ignore_err",
        "-fflags",
        "+discardcorrupt",
        "-i",
        str(source),
        "-map",
        "0:a:0?",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(destination),
    ]
    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="ffmpeg is not installed") from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail="audio extraction timed out") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "audio extraction failed").strip()
        raise HTTPException(status_code=422, detail=detail[-2000:]) from error


def validate_audio(audio_path: Path) -> float:
    """Return the extracted WAV duration and reject unusable audio early."""

    try:
        with wave.open(str(audio_path), "rb") as audio:
            frame_count = audio.getnframes()
            sample_rate = audio.getframerate()
    except (OSError, wave.Error) as error:
        raise HTTPException(
            status_code=422, detail=f"extracted audio is invalid: {error}"
        ) from error

    if frame_count <= 0 or sample_rate <= 0:
        raise HTTPException(status_code=422, detail="source contains no audio")

    duration = frame_count / sample_rate
    if duration < MIN_AUDIO_SECONDS:
        raise HTTPException(
            status_code=422,
            detail=(
                "source audio is too short for speaker diarization "
                f"({duration:.3f}s; minimum is {MIN_AUDIO_SECONDS:.3f}s)"
            ),
        )
    return duration


def load_extracted_audio(audio_path: Path) -> dict[str, Any]:
    """Load the normalized PCM WAV without relying on TorchCodec.

    pyannote.audio 4 delegates path-based decoding to TorchCodec. The service
    already normalizes every input into mono 16 kHz 16-bit PCM with FFmpeg, so
    loading those bytes directly is both deterministic and avoids TorchCodec's
    optional system FFmpeg-library dependency. Decode in bounded blocks into
    one final tensor instead of retaining two complete PCM byte buffers.
    """

    try:
        with wave.open(str(audio_path), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            sample_rate = audio.getframerate()
            frame_count = audio.getnframes()
            if (
                channels != 1 or sample_width != 2
                or sample_rate <= 0 or frame_count <= 0
            ):
                raise HTTPException(
                    status_code=422, detail="extracted audio is not mono 16-bit PCM"
                )
            if frame_count * sample_width > audio_path.stat().st_size:
                raise HTTPException(status_code=422, detail="extracted audio is truncated")

            waveform = torch.empty((1, frame_count), dtype=torch.float32, device="cpu")
            offset = 0
            block_frames = sample_rate * AUDIO_READ_SECONDS
            while offset < frame_count:
                count = min(block_frames, frame_count - offset)
                frames = bytearray(audio.readframes(count))
                if len(frames) != count * sample_width:
                    raise HTTPException(status_code=422, detail="extracted audio is truncated")
                pcm = torch.frombuffer(frames, dtype=torch.int16)
                # copy_ converts int16 directly into the destination float32
                # slice without allocating a second float32 audio tensor.
                waveform[0, offset:offset + count].copy_(pcm)
                offset += count
                del pcm, frames
            waveform.div_(32768.0)
    except (OSError, wave.Error) as error:
        raise HTTPException(
            status_code=422, detail=f"extracted audio is invalid: {error}"
        ) from error

    return {"waveform": waveform, "sample_rate": sample_rate}


def run_diarization(
    audio_path: Path, request: DiarizeRequest, monitor: MemoryMonitor | None = None
) -> list[DiarizationTurn]:
    if request.model and request.model != MODEL_ID:
        raise HTTPException(
            status_code=400,
            detail=f"service is configured for model {MODEL_ID}, not {request.model}",
        )
    parameters: dict[str, Any] = {}
    if request.num_speakers is not None:
        parameters["num_speakers"] = request.num_speakers
    else:
        if request.min_speakers is not None:
            parameters["min_speakers"] = request.min_speakers
        if request.max_speakers is not None:
            parameters["max_speakers"] = request.max_speakers

    # The diarization service never needs gradients. Keeping inference mode
    # enabled is important for long recordings because it avoids retaining
    # autograd state while the pipeline processes the complete WAV.
    # The caller holds PIPELINE_LOCK across extraction, inference and result
    # conversion. Keeping one global invocation preserves speaker identities.
    with torch.inference_mode():
        if monitor is not None:
            monitor.set_phase("audio_loading")
            parameters["hook"] = monitor.hook
        audio = load_extracted_audio(audio_path)
        if monitor is not None:
            monitor.set_phase("inference")
        try:
            result = PIPELINE(audio, **parameters)
        finally:
            # Release the waveform even when inference raises an exception.
            del audio

    # pyannote.audio 4 returns a DiarizeOutput wrapper. Earlier releases (and
    # pipelines configured with legacy mode) return Annotation directly. Keep
    # both forms working so upgrading the worker image does not turn a valid
    # diarization request into a runtime 500.
    annotation = getattr(result, "speaker_diarization", result)
    if not hasattr(annotation, "itertracks"):
        raise RuntimeError("pyannote returned an unsupported diarization output")

    turns: list[DiarizationTurn] = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        start = float(turn.start)
        end = float(turn.end)
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or end <= start
        ):
            continue
        turns.append(
            DiarizationTurn(
                speaker=str(speaker),
                start=round(start, 3),
                end=round(end, 3),
            )
        )
    return turns


@app.get("/healthz")
def healthz() -> dict[str, str | bool]:
    return {
        "ok": True,
        "model": MODEL_ID,
        "device": str(DEVICE),
    }


@app.post("/v1/diarize", response_model=DiarizeResponse)
def diarize(request: DiarizeRequest, http_request: Request) -> DiarizeResponse:
    require_service_token(http_request)
    if request.model and request.model != MODEL_ID:
        raise HTTPException(
            status_code=400,
            detail=f"service is configured for model {MODEL_ID}, not {request.model}",
        )
    with tempfile.TemporaryDirectory(prefix="justai-pyannote-") as directory:
        directory_path = Path(directory)
        source_path = directory_path / "source.media"
        audio_path = directory_path / "audio.wav"
        download_source(str(request.media_url), source_path)
        # Downloads stream to disk before waiting, so signed URLs need not stay
        # valid throughout another long-running inference. Serialize FFmpeg too:
        # a second multi-hour extraction must not compete for the same RAM.
        with PIPELINE_LOCK, MemoryMonitor() as monitor:
            extract_audio(source_path, audio_path)
            source_path.unlink()
            duration = validate_audio(audio_path)
            logger.info(
                "starting pyannote diarization (duration=%.3fs, waveform_mib=%.1f, device=%s, model=%s)",
                duration,
                duration * 16000 * 4 / (1024 * 1024),
                DEVICE,
                MODEL_ID,
            )
            try:
                segments = run_diarization(audio_path, request, monitor)
            except HTTPException:
                raise
            except Exception as error:
                logger.exception("pyannote inference failed")
                raise HTTPException(
                    status_code=500,
                    detail=f"pyannote inference failed: {error}",
                ) from error
    speakers = sorted({segment.speaker for segment in segments})
    return DiarizeResponse(
        model=MODEL_ID,
        device=str(DEVICE),
        speakers=speakers,
        segments=segments,
    )
