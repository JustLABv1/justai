"""Audio framing of JustAI's capture stream (see docs/transcription-ingress.md).

A frame is little-endian: version (1 byte), capture time in Unix milliseconds
(8 bytes), sequence number (4 bytes), sample rate (4 bytes), then mono PCM16. An
upload holds one or more frames, each prefixed by its big-endian uint32 length.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Iterable

FRAME_VERSION = 1
FRAME_HEADER = struct.Struct("<BQII")
SAMPLE_RATE = 16000

# The backend accepts up to 512 frames and 4 MiB per upload.
MAX_FRAMES_PER_BATCH = 512
MAX_BATCH_BYTES = 4 * 1024 * 1024


def encode_frame(pcm: bytes, sequence: int, timestamp_ms: int, sample_rate: int = SAMPLE_RATE) -> bytes:
    if not 8000 <= sample_rate <= 96000:
        raise ValueError("sample rate must be between 8000 and 96000")
    if len(pcm) % 2:
        raise ValueError("PCM16 audio must have an even number of bytes")
    return FRAME_HEADER.pack(FRAME_VERSION, timestamp_ms, sequence & 0xFFFFFFFF, sample_rate) + pcm


def encode_batch(frames: Iterable[bytes]) -> bytes:
    parts = []
    count = 0
    for frame in frames:
        count += 1
        parts.append(struct.pack(">I", len(frame)))
        parts.append(frame)
    if count == 0:
        raise ValueError("a batch needs at least one frame")
    if count > MAX_FRAMES_PER_BATCH:
        raise ValueError("too many frames for one batch")
    body = b"".join(parts)
    if len(body) > MAX_BATCH_BYTES:
        raise ValueError("batch is larger than the backend accepts")
    return body


def decode_batch(body: bytes) -> list[tuple[int, int, int, bytes]]:
    """Reads a batch back into (timestamp, sequence, sample rate, pcm) tuples. Used by tests."""
    out = []
    while body:
        (length,) = struct.unpack(">I", body[:4])
        frame, body = body[4 : 4 + length], body[4 + length :]
        version, timestamp, sequence, rate = FRAME_HEADER.unpack(frame[: FRAME_HEADER.size])
        if version != FRAME_VERSION:
            raise ValueError("unknown frame version")
        out.append((timestamp, sequence, rate, frame[FRAME_HEADER.size :]))
    return out


def pcm_level(pcm: bytes) -> float:
    """RMS level of PCM16 audio between 0 and 1."""
    count = len(pcm) // 2
    if count == 0:
        return 0.0
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    return min(1.0, math.sqrt(sum(s * s for s in samples) / count) / 32768.0)
