"""Small internal HTTP service for pyannote speaker diarization.

The service deliberately owns the pyannote and Hugging Face dependencies. The
JustAI backend only has to send a short-lived media URL and consume timestamped
speaker turns, so it does not need to embed Python or a GPU runtime.
"""

from __future__ import annotations

import inspect
import logging
import math
import os
import subprocess
import tempfile
import wave
from pathlib import Path
from threading import Lock
from typing import Any

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
DOWNLOAD_TIMEOUT_SECONDS = float(
    os.getenv("PYANNOTE_DOWNLOAD_TIMEOUT_SECONDS", "1800")
)
MAX_SOURCE_BYTES = int(
    os.getenv("PYANNOTE_MAX_SOURCE_BYTES", str(20 * 1024 * 1024 * 1024))
)
MIN_AUDIO_SECONDS = float(os.getenv("PYANNOTE_MIN_AUDIO_SECONDS", "1"))


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
    if not SERVICE_TOKEN:
        return
    authorization = request.headers.get("authorization", "")
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid service token")


def download_source(url: str, destination: Path) -> None:
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(DOWNLOAD_TIMEOUT_SECONDS),
        ) as client:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > MAX_SOURCE_BYTES:
                    raise HTTPException(
                        status_code=413, detail="source media is too large"
                    )
                downloaded = 0
                with destination.open("wb") as output:
                    for chunk in response.iter_bytes(1024 * 1024):
                        downloaded += len(chunk)
                        if downloaded > MAX_SOURCE_BYTES:
                            raise HTTPException(
                                status_code=413, detail="source media is too large"
                            )
                        output.write(chunk)
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
