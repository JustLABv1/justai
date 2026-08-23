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
import socket
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
import torch
from fastapi import FastAPI, HTTPException, Request
from pydantic import AnyHttpUrl, BaseModel, Field
from pyannote.audio import Pipeline


logger = logging.getLogger(__name__)

MODEL_ID = os.getenv(
    "PYANNOTE_MODEL_ID", "pyannote/speaker-diarization-3.1"
)
HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
SERVICE_TOKEN = os.getenv("PYANNOTE_SERVICE_TOKEN", "").strip()
DEVICE_NAME = os.getenv("PYANNOTE_DEVICE", "auto").strip().lower()
TORCH_THREADS = int(os.getenv("PYANNOTE_TORCH_THREADS", "2"))
DOWNLOAD_TIMEOUT_SECONDS = float(os.getenv("PYANNOTE_DOWNLOAD_TIMEOUT_SECONDS", "1800"))
MAX_SOURCE_BYTES = int(os.getenv("PYANNOTE_MAX_SOURCE_BYTES", str(5 * 1024 * 1024 * 1024)))
MAX_CONFIGURED_DOWNLOAD_TIMEOUT_SECONDS = 30 * 60
MAX_CONFIGURED_SOURCE_BYTES = 8 * 1024 * 1024 * 1024
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
        f"PYANNOTE_MAX_SOURCE_BYTES must be between 1 and {MAX_CONFIGURED_SOURCE_BYTES}"
    )


def resolve_device() -> torch.device:
    if DEVICE_NAME and DEVICE_NAME != "auto":
        return torch.device(DEVICE_NAME)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


DEVICE = resolve_device()
if TORCH_THREADS > 0:
    torch.set_num_threads(TORCH_THREADS)


def load_pipeline() -> Pipeline:
    if not HF_TOKEN:
        raise RuntimeError(
            "HF_TOKEN is required to download the gated pyannote pipeline"
        )

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
    pipeline = Pipeline.from_pretrained(
        MODEL_ID, **{auth_keyword: HF_TOKEN}
    )
    if pipeline is None:
        raise RuntimeError(f"could not load pyannote pipeline {MODEL_ID}")
    pipeline.to(DEVICE)
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


def download_source(url: str, destination: Path) -> None:
    current_url = url
    current_origin, _ = validate_media_url(current_url)
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    inactivity_timeout = min(DOWNLOAD_TIMEOUT_SECONDS, 30.0)
    try:
        with httpx.Client(
            follow_redirects=False,
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
    optional system FFmpeg-library dependency.
    """

    try:
        with wave.open(str(audio_path), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            sample_rate = audio.getframerate()
            frames = audio.readframes(audio.getnframes())
    except (OSError, wave.Error) as error:
        raise HTTPException(
            status_code=422, detail=f"extracted audio is invalid: {error}"
        ) from error

    if channels != 1 or sample_width != 2 or sample_rate <= 0 or not frames:
        raise HTTPException(
            status_code=422,
            detail="extracted audio is not mono 16-bit PCM",
        )

    waveform = torch.frombuffer(bytearray(frames), dtype=torch.int16)
    waveform = waveform.to(dtype=torch.float32).div_(32768.0).unsqueeze(0)
    return {"waveform": waveform, "sample_rate": sample_rate}


def run_diarization(audio_path: Path, request: DiarizeRequest) -> list[DiarizationTurn]:
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
    with PIPELINE_LOCK, torch.inference_mode():
        annotation = PIPELINE(load_extracted_audio(audio_path), **parameters)
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
    with tempfile.TemporaryDirectory(prefix="justai-pyannote-") as directory:
        directory_path = Path(directory)
        source_path = directory_path / "source.media"
        audio_path = directory_path / "audio.wav"
        download_source(str(request.media_url), source_path)
        extract_audio(source_path, audio_path)
        duration = validate_audio(audio_path)
        logger.info(
            "starting pyannote diarization (duration=%.3fs, device=%s, model=%s)",
            duration,
            DEVICE,
            MODEL_ID,
        )
        try:
            segments = run_diarization(audio_path, request)
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
