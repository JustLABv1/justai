"""Client for JustAI's meeting-bot ingress.

Flow (docs/transcription-ingress.md): exchange the source's ingest token for a
one-use ticket, open the SSE stream, wait for ``transport.ready`` (stream id and
upload/resume tokens) and ``transcription.ready`` (the provider is connected), then
upload audio batches and sequenced JSON controls. A dropped SSE connection is
resumed within the server's 15 second window.

The ingest token, the upload token and the resume token are bearer secrets and are
never logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections import deque
from dataclasses import dataclass, field
from urllib.parse import urlencode

import aiohttp

from .frames import SAMPLE_RATE, encode_batch, encode_frame, pcm_level

log = logging.getLogger(__name__)

TICKET_PATH = "/api/v1/transcription/bot-sources/{source_id}/tickets"
STREAM_PATH = "/api/v1/streams/transcription"

# Audio waiting for upload is bounded like the browser client: past this it is
# dropped (oldest first) rather than delivered ever later.
MAX_QUEUED_AUDIO_BYTES = 1024 * 1024
BATCH_INTERVAL = 0.1
LEVEL_INTERVAL = 1.0
RESUME_ATTEMPTS = 5


class IngestError(Exception):
    """The capture stream could not be opened or was ended by JustAI."""


@dataclass
class IngestStats:
    batches: int = 0
    frames: int = 0
    dropped_chunks: int = 0
    resumes: int = 0
    errors: list[str] = field(default_factory=list)


class JustAIIngest:
    def __init__(self, base_url: str, source_id: str, token: str, http: aiohttp.ClientSession, *, ready_timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.source_id = source_id
        self._token = token
        self._http = http
        self._ready_timeout = ready_timeout
        self.stats = IngestStats()

        self._stream_id = ""
        self._upload_token = ""
        self._resume_token = ""
        self._last_event_id = "0"
        self._transport_ready = asyncio.Event()
        self._transcription_ready = asyncio.Event()
        self.closed = asyncio.Event()
        self.close_reason = ""
        # The JustAI session itself ended (stopped by a user), which is a normal end.
        self.session_ended = False

        self._control_sequence = 0
        self._control_lock = asyncio.Lock()
        self._batch_sequence = 0
        self._frame_sequence = 0
        self._audio: deque[tuple[int, bytes]] = deque()
        self._queued_bytes = 0
        self._audio_wakeup = asyncio.Event()
        self._recent_pcm = bytearray()
        self._tasks: list[asyncio.Task] = []
        self._stopping = False

    # ---- lifecycle ----

    async def connect(self) -> None:
        """Opens the capture stream and returns once JustAI accepts audio."""
        ticket = await self._ticket()
        self._tasks.append(asyncio.create_task(self._read_events(f"{self.base_url}{STREAM_PATH}?{urlencode({'ticket': ticket})}"), name="justai-sse"))
        await self._wait_for(self._transport_ready, 30.0, "the JustAI stream did not become ready")
        await self.send_control("transcription.start", sourceId=self.source_id)
        await self._wait_for(self._transcription_ready, self._ready_timeout, "JustAI did not connect a transcription provider")
        self._tasks.append(asyncio.create_task(self._upload_audio(), name="justai-audio"))
        self._tasks.append(asyncio.create_task(self._report_level(), name="justai-level"))
        log.info("JustAI capture stream is ready")

    async def _wait_for(self, event: asyncio.Event, timeout: float, message: str) -> None:
        ready = asyncio.create_task(event.wait())
        closed = asyncio.create_task(self.closed.wait())
        try:
            done, _ = await asyncio.wait({ready, closed}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            ready.cancel()
            closed.cancel()
        if event.is_set():
            return
        if self.closed.is_set():
            raise IngestError(self.close_reason or message)
        raise IngestError(message)

    async def stop(self) -> None:
        """Uploads what is queued, asks JustAI to finalize the transcript and closes."""
        if self._stopping:
            return
        self._stopping = True
        if self._transcription_ready.is_set() and not self.closed.is_set():
            deadline = time.monotonic() + 5
            while self._audio and time.monotonic() < deadline and not self.closed.is_set():
                self._audio_wakeup.set()
                await asyncio.sleep(0.05)
            try:
                await self.send_control("transcription.stop")
            except IngestError as error:
                log.warning("could not send the stop control: %s", error)
            # Give the server a moment to commit the last turn before the stream closes.
            try:
                await asyncio.wait_for(self.closed.wait(), timeout=10)
            except TimeoutError:
                pass
        self._close("stopped by the bot")
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def _close(self, reason: str) -> None:
        if not self.closed.is_set():
            self.close_reason = reason
            self.closed.set()
            self._audio_wakeup.set()

    # ---- ticket and SSE ----

    async def _ticket(self) -> str:
        url = f"{self.base_url}{TICKET_PATH.format(source_id=self.source_id)}"
        try:
            async with self._http.post(url, headers={"Authorization": f"Bearer {self._token}"}) as response:
                if response.status != 201:
                    raise IngestError(f"JustAI refused the ingest token ({response.status}): {await _error_text(response)}")
                payload = await response.json()
        except aiohttp.ClientError as error:
            raise IngestError(f"JustAI is unreachable: {error}") from error
        ticket = str(payload.get("ticket") or "")
        if not ticket:
            raise IngestError("JustAI returned no stream ticket")
        return ticket

    async def _read_events(self, url: str) -> None:
        attempts = 0
        while not self.closed.is_set():
            try:
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=60)
                async with self._http.get(url, headers={"Accept": "text/event-stream"}, timeout=timeout) as response:
                    if response.status != 200:
                        message = f"the JustAI stream was refused ({response.status}): {await _error_text(response)}"
                        if response.status in (401, 403, 404):
                            self._close(message)  # the ticket or the resume token is no longer valid
                            return
                        raise IngestError(message)
                    attempts = 0
                    await self._consume(response)
            except asyncio.CancelledError:
                raise
            except IngestError as error:
                if not self._resume_token or attempts >= RESUME_ATTEMPTS:
                    self._close(str(error))
                    return
            except (aiohttp.ClientError, TimeoutError) as error:
                log.warning("JustAI stream interrupted: %s", error)
            if self._stopping:
                self._close("stopped by the bot")  # JustAI ended the stream after transcription.stop
                return
            if self.closed.is_set():
                return
            if not self._resume_token or attempts >= RESUME_ATTEMPTS:
                self._close(self.close_reason or "the JustAI stream ended")
                return
            delay = min(10.0, 0.5 * 2**attempts) + random.random() * 0.25
            attempts += 1
            self.stats.resumes += 1
            await asyncio.sleep(delay)
            url = f"{self.base_url}{STREAM_PATH}?{urlencode({'resume': self._resume_token, 'lastEventId': self._last_event_id})}"

    async def _consume(self, response: aiohttp.ClientResponse) -> None:
        event_id, data = "", []
        async for raw in response.content:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line == "":
                if data:
                    if event_id:
                        self._last_event_id = event_id
                    self._handle("\n".join(data))
                event_id, data = "", []
                continue
            if line.startswith(":"):
                continue
            name, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if name == "id":
                event_id = value
            elif name == "data":
                data.append(value)

    def _handle(self, payload: str) -> None:
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            return
        kind = event.get("type")
        data = event.get("data") or {}
        if kind in ("transport.ready", "transport.resumed"):
            self._stream_id = str(data.get("streamId") or "")
            self._upload_token = str(data.get("uploadToken") or "")
            self._resume_token = str(data.get("resumeToken") or self._resume_token)
            if self._stream_id and self._upload_token:
                self._transport_ready.set()
        elif kind == "transcription.ready":
            self._transcription_ready.set()
        elif kind == "error":
            message = str(data.get("message") or "JustAI reported an error")
            self.stats.errors.append(message)
            log.warning("JustAI: %s", message)
            if "no longer live" in message:
                self.session_ended = True
            if not self._transcription_ready.is_set() or self.session_ended:
                self._close(message)
        elif kind == "transcription.session" and data.get("status") in ("completed", "processing"):
            self.session_ended = True
            self._close("the JustAI session ended")

    # ---- uploads ----

    async def send_control(self, kind: str, **fields) -> None:
        async with self._control_lock:
            self._control_sequence += 1
            body = json.dumps({"type": kind, **fields, "transportSequence": self._control_sequence})
            last: Exception | None = None
            for attempt in range(3):
                try:
                    status = await self._post("events", body.encode(), "application/json")
                    if status in (202, 204):
                        return
                    last = IngestError(f"control {kind} was refused ({status})")
                    if status < 500:
                        break
                except (aiohttp.ClientError, TimeoutError) as error:
                    last = error
                await asyncio.sleep(0.1 * 2**attempt)
            raise IngestError(f"could not send {kind}: {last}")

    def push_pcm(self, pcm: bytes, captured_at_ms: int | None = None) -> None:
        """Queues 16 kHz mono PCM16 audio for upload (called from the browser bridge)."""
        if not pcm or self.closed.is_set():
            return
        self._recent_pcm.extend(pcm)
        del self._recent_pcm[: max(0, len(self._recent_pcm) - SAMPLE_RATE * 2)]
        self._audio.append((captured_at_ms or int(time.time() * 1000), pcm))
        self._queued_bytes += len(pcm)
        while self._queued_bytes > MAX_QUEUED_AUDIO_BYTES and self._audio:
            _, dropped = self._audio.popleft()
            self._queued_bytes -= len(dropped)
            self.stats.dropped_chunks += 1
            if self.stats.dropped_chunks == 1 or self.stats.dropped_chunks % 25 == 0:
                log.warning("JustAI upload is slower than realtime; dropped %d audio chunks", self.stats.dropped_chunks)

    async def _upload_audio(self) -> None:
        while not self.closed.is_set():
            if not self._audio:
                self._audio_wakeup.clear()
                try:
                    await asyncio.wait_for(self._audio_wakeup.wait(), timeout=BATCH_INTERVAL)
                except TimeoutError:
                    pass
                continue
            frames = []
            while self._audio and len(frames) < 64:
                captured, pcm = self._audio.popleft()
                self._queued_bytes -= len(pcm)
                frames.append(encode_frame(pcm, self._frame_sequence, captured))
                self._frame_sequence += 1
            self._batch_sequence += 1
            await self._upload_batch(encode_batch(frames), self._batch_sequence)
            self.stats.batches += 1
            self.stats.frames += len(frames)
            await asyncio.sleep(BATCH_INTERVAL)

    async def _upload_batch(self, body: bytes, sequence: int) -> None:
        attempt = 0
        while not self.closed.is_set():
            if not self._transport_ready.is_set():
                await asyncio.sleep(0.25)
                continue
            try:
                status = await self._post("audio", body, "application/octet-stream", {"X-Audio-Batch-Sequence": str(sequence)})
            except (aiohttp.ClientError, TimeoutError):
                status = 0
            if status in (202, 204):
                return
            if status in (404, 410):
                # The server keeps a stream for 15 seconds while its SSE reconnects, so a
                # missing stream has ended for good.
                self._close("JustAI closed the capture stream")
                return
            if status not in (0, 408, 429) and status < 500:
                self._close(f"JustAI refused audio ({status})")
                return
            attempt += 1
            await asyncio.sleep(min(5.0, 0.25 * 2 ** min(attempt, 5)) + random.random() * 0.25)

    async def _report_level(self) -> None:
        while not self.closed.is_set():
            await asyncio.sleep(LEVEL_INTERVAL)
            try:
                await self.send_control("source.level", level=round(pcm_level(bytes(self._recent_pcm[-SAMPLE_RATE // 5 * 2 :])), 4))
            except IngestError:
                pass

    async def _post(self, kind: str, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> int:
        headers = {"Content-Type": content_type, "X-Stream-Token": self._upload_token, **(extra or {})}
        timeout = aiohttp.ClientTimeout(total=15)
        async with self._http.post(f"{self.base_url}/api/v1/streams/{self._stream_id}/{kind}", data=body, headers=headers, timeout=timeout) as response:
            await response.read()
            return response.status


async def _error_text(response: aiohttp.ClientResponse) -> str:
    try:
        payload = await response.json(content_type=None)
    except (aiohttp.ContentTypeError, json.JSONDecodeError, ValueError):
        return response.reason or ""
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get("message") or "")
    return str(error or "")
