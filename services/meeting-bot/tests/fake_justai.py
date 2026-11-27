"""An in-process stand-in for JustAI's meeting-bot ingress, following the rules of
services/backend/server/http_stream.go and handlers_transcription_ingress.go."""

from __future__ import annotations

import asyncio
import itertools
import json
import secrets
from dataclasses import dataclass, field

from aiohttp import web

from meeting_bot.frames import decode_batch

TOKEN = "ingest-token-for-tests"
SOURCE_ID = "5a3f8a8e-1111-4222-8333-944455556666"


@dataclass
class Stream:
    id: str
    upload_token: str
    resume_token: str
    events: list[tuple[int, dict]] = field(default_factory=list)
    wakeup: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    control_seq: int = 0
    batch_seq: int = 0

    def emit(self, kind: str, data: dict | None = None) -> None:
        self.events.append((len(self.events) + 1, {"type": kind, "data": data or {}}))
        self.wakeup.set()

    def close(self) -> None:
        self.closed = True
        self.wakeup.set()


class FakeJustAI:
    def __init__(self, *, drop_sse_once_after_ready: bool = False, error_before_ready: str = "", ready: bool = True):
        self.drop_sse_once_after_ready = drop_sse_once_after_ready
        self.error_before_ready = error_before_ready
        self.ready = ready
        self.tickets: set[str] = set()
        self.streams: dict[str, Stream] = {}
        self.controls: list[dict] = []
        self.frames: list[tuple[int, int, int, bytes]] = []
        self.batch_sequences: list[int] = []
        self.resumes = 0
        self._ids = itertools.count(1)
        self.app = web.Application()
        self.app.router.add_post("/api/v1/transcription/bot-sources/{source}/tickets", self.ticket)
        self.app.router.add_get("/api/v1/streams/transcription", self.sse)
        self.app.router.add_post("/api/v1/streams/{stream}/events", self.event)
        self.app.router.add_post("/api/v1/streams/{stream}/audio", self.audio)

    def pcm(self) -> bytes:
        return b"".join(frame[3] for frame in self.frames)

    async def ticket(self, request: web.Request) -> web.Response:
        if request.match_info["source"] != SOURCE_ID or request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return web.json_response({"error": {"message": "invalid or revoked bot ingest token"}}, status=401)
        ticket = secrets.token_urlsafe(8)
        self.tickets.add(ticket)
        return web.json_response({"ticket": ticket, "kind": "transcription-capture"}, status=201)

    async def sse(self, request: web.Request) -> web.StreamResponse:
        resume = request.query.get("resume")
        if resume:
            stream = next((s for s in self.streams.values() if s.resume_token == resume and not s.closed), None)
            if stream is None:
                return web.json_response({"error": {"message": "invalid stream resume token"}}, status=401)
            self.resumes += 1
            ready_type = "transport.resumed"
        else:
            ticket = request.query.get("ticket", "")
            if ticket not in self.tickets:
                return web.json_response({"error": {"message": "invalid ticket"}}, status=401)
            self.tickets.discard(ticket)
            stream = Stream(id=f"stream-{next(self._ids)}", upload_token=secrets.token_urlsafe(8), resume_token=secrets.token_urlsafe(8))
            self.streams[stream.id] = stream
            stream.emit("transcription.snapshot", {"session": {}})
            if self.error_before_ready:
                stream.emit("error", {"message": self.error_before_ready})
            elif self.ready:
                stream.emit("transcription.ready", {"sourceId": SOURCE_ID, "mode": "chunked"})
            ready_type = "transport.ready"
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
        await response.prepare(request)
        ready = {"type": ready_type, "data": {"streamId": stream.id, "uploadToken": stream.upload_token, "resumeToken": stream.resume_token}}
        await response.write(f"id: 0\ndata: {json.dumps(ready)}\n\n".encode())
        delivered = int(request.query.get("lastEventId") or 0)
        while True:
            for event_id, event in stream.events:
                if event_id > delivered:
                    await response.write(f"id: {event_id}\ndata: {json.dumps(event)}\n\n".encode())
                    delivered = event_id
            if stream.closed:
                return response
            if self.drop_sse_once_after_ready and any(e["type"] == "transcription.ready" for _, e in stream.events) and delivered >= 2:
                self.drop_sse_once_after_ready = False
                return response  # the connection drops; the stream lives on for a resume
            stream.wakeup.clear()
            try:
                await asyncio.wait_for(stream.wakeup.wait(), timeout=0.5)
            except TimeoutError:
                await response.write(b": keep-alive\n\n")

    def _stream(self, request: web.Request) -> Stream | None:
        stream = self.streams.get(request.match_info["stream"])
        if stream is None or stream.closed or request.headers.get("X-Stream-Token") != stream.upload_token:
            return None
        return stream

    async def event(self, request: web.Request) -> web.Response:
        if not request.headers.get("Content-Type", "").startswith("application/json"):
            return web.json_response({"error": "application/json is required"}, status=415)
        stream = self._stream(request)
        if stream is None:
            return web.json_response({"error": "stream not found"}, status=404)
        payload = await request.json()
        sequence = int(payload.get("transportSequence") or 0)
        if sequence <= 0:
            return web.json_response({"error": "a positive transportSequence is required"}, status=400)
        if sequence <= stream.control_seq:
            return web.Response(status=204)
        stream.control_seq = sequence
        self.controls.append(payload)
        if payload.get("type") == "transcription.stop":
            stream.close()
        return web.Response(status=202)

    async def audio(self, request: web.Request) -> web.Response:
        if request.headers.get("Content-Type") != "application/octet-stream":
            return web.json_response({"error": "application/octet-stream is required"}, status=415)
        stream = self._stream(request)
        if stream is None:
            return web.json_response({"error": "stream not found"}, status=404)
        sequence = int(request.headers.get("X-Audio-Batch-Sequence") or 0)
        if sequence <= stream.batch_seq:
            return web.Response(status=204)
        if sequence != stream.batch_seq + 1:
            return web.json_response({"error": "audio batch sequence is out of order"}, status=409)
        frames = decode_batch(await request.read())
        if not frames or len(frames) > 512:
            return web.json_response({"error": "invalid audio batch"}, status=400)
        stream.batch_seq = sequence
        self.batch_sequences.append(sequence)
        self.frames.extend(frames)
        return web.Response(status=202)
