"""HTTP service that runs meeting bots on behalf of the JustAI backend.

``python -m meeting_bot serve`` listens on MEETING_BOT_PORT (8091). The backend
starts a bot when someone adds a meeting-bot source with "join automatically", and
stops it when the source is stopped:

    POST   /v1/bots              {"sourceId", "token", "meetingUrl", "meetingId"?, "passcode"?, "name"?, "platform"?}
    GET    /v1/bots/{sourceId}   status of one bot
    DELETE /v1/bots/{sourceId}   leave the meeting
    GET    /v1/bots              all bots (no secrets)
    GET    /healthz

Every /v1 call needs ``Authorization: Bearer <MEETING_BOT_SERVICE_TOKEN>``. The JustAI
address comes from the service's own configuration (JUSTAI_URL), never from a
request, so a caller cannot point a bot's ingest token anywhere else. Bots live in
this process: a restart ends them, and the backend then reports the bot as gone.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from .bot import BotConfig, MeetingBot, redact_url
from .platforms import PLATFORMS

log = logging.getLogger(__name__)

KEEP_FINISHED_SECONDS = 3600
SHUTDOWN_GRACE_SECONDS = 25
MAX_FIELD_LENGTH = 4096


@dataclass
class ServiceConfig:
    token: str
    justai_url: str
    max_bots: int = 2
    port: int = 8091
    default_name: str = "JustAI Transkription (Bot)"
    locale: str = "de-DE"
    join_timeout: float = 600.0
    max_minutes: float = 240.0
    alone_minutes: float = 2.0
    silence_minutes: float = 30.0
    # Only for tests: the real service joins https meetings only.
    allow_http_meetings: bool = False
    debug_dir: str | None = None
    # Local debugging: show each bot's browser window (needs a desktop).
    headful: bool = False
    # "card" (JustAI logo and a transcription notice, camera on) or "off".
    camera: str = "card"

    @classmethod
    def from_env(cls) -> ServiceConfig:
        def secret(name: str) -> str:
            path = os.environ.get(f"{name}_FILE", "").strip()
            return Path(path).read_text(encoding="utf-8").strip() if path else os.environ.get(name, "").strip()

        def number(name: str, default: float) -> float:
            value = os.environ.get(name, "").strip()
            return float(value) if value else default

        config = cls(
            token=secret("MEETING_BOT_SERVICE_TOKEN"),
            justai_url=os.environ.get("JUSTAI_URL", "").strip().rstrip("/"),
            max_bots=int(number("MEETING_BOT_MAX_BOTS", 2)),
            port=int(number("MEETING_BOT_PORT", 8091)),
            default_name=os.environ.get("BOT_NAME", "").strip() or "JustAI Transkription (Bot)",
            locale=os.environ.get("BOT_LOCALE", "").strip() or "de-DE",
            join_timeout=number("BOT_JOIN_TIMEOUT_SECONDS", 600),
            max_minutes=number("BOT_MAX_MINUTES", 240),
            alone_minutes=number("BOT_ALONE_MINUTES", 2),
            silence_minutes=number("BOT_SILENCE_MINUTES", 30),
            debug_dir=os.environ.get("BOT_DEBUG_DIR", "").strip() or None,
            headful=os.environ.get("BOT_HEADFUL", "").strip().lower() in ("1", "true", "yes"),
            camera=os.environ.get("BOT_CAMERA", "").strip().lower() or "card",
        )
        config.validate()
        return config

    def validate(self) -> None:
        if len(self.token) < 16:
            raise ValueError("MEETING_BOT_SERVICE_TOKEN must be at least 16 characters")
        parts = urlsplit(self.justai_url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("JUSTAI_URL must be an absolute http(s) URL, for example the backend's cluster address")
        if not 1 <= self.max_bots <= 20:
            raise ValueError("MEETING_BOT_MAX_BOTS must be between 1 and 20")
        if self.camera not in ("card", "off"):
            raise ValueError("BOT_CAMERA must be card or off")


@dataclass
class Job:
    source_id: str
    bot: MeetingBot
    meeting_host: str
    task: asyncio.Task | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def view(self) -> dict:
        return {
            "sourceId": self.source_id,
            "status": self.bot.status,
            "reason": self.bot.end_reason,
            "exitCode": self.bot.exit_code,
            "meetingHost": self.meeting_host,
            "startedAt": int(self.started_at),
            "finishedAt": int(self.finished_at) if self.finished_at else None,
        }

    @property
    def active(self) -> bool:
        return self.finished_at is None


class BotService:
    def __init__(self, config: ServiceConfig, bot_factory=MeetingBot):
        self.config = config
        self.jobs: dict[str, Job] = {}
        self._bot_factory = bot_factory
        self.app = web.Application(middlewares=[self._auth], client_max_size=64 * 1024)
        self.app.router.add_get("/healthz", self.health)
        self.app.router.add_get("/v1/bots", self.list_bots)
        self.app.router.add_post("/v1/bots", self.start_bot)
        self.app.router.add_get("/v1/bots/{source_id}", self.get_bot)
        self.app.router.add_delete("/v1/bots/{source_id}", self.stop_bot)
        self.app.on_shutdown.append(self._shutdown)

    @web.middleware
    async def _auth(self, request: web.Request, handler):
        if request.path.startswith("/v1/"):
            given = request.headers.get("Authorization", "")
            if not hmac.compare_digest(given.encode(), f"Bearer {self.config.token}".encode()):
                return _error(401, "invalid service token")
        return await handler(request)

    def _active(self) -> list[Job]:
        self._prune()
        return [job for job in self.jobs.values() if job.active]

    def _prune(self) -> None:
        cutoff = time.time() - KEEP_FINISHED_SECONDS
        for key in [k for k, job in self.jobs.items() if job.finished_at and job.finished_at < cutoff]:
            del self.jobs[key]

    async def health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "bots": len(self._active()), "capacity": self.config.max_bots})

    async def list_bots(self, _request: web.Request) -> web.Response:
        self._prune()
        return web.json_response({"bots": [job.view() for job in self.jobs.values()]})

    async def get_bot(self, request: web.Request) -> web.Response:
        self._prune()
        job = self.jobs.get(request.match_info["source_id"])
        if job is None:
            return _error(404, "no bot for this source")
        return web.json_response(job.view())

    async def stop_bot(self, request: web.Request) -> web.Response:
        job = self.jobs.get(request.match_info["source_id"])
        if job is None:
            return _error(404, "no bot for this source")
        job.bot.stop()
        return web.json_response(job.view(), status=202)

    async def start_bot(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return _error(400, "a JSON body is required")
        if not isinstance(body, dict):
            return _error(400, "a JSON object is required")
        fields = {}
        for name in ("sourceId", "token", "meetingUrl", "meetingId", "passcode", "name", "platform"):
            value = body.get(name, "")
            if not isinstance(value, str) or len(value) > MAX_FIELD_LENGTH:
                return _error(400, f"{name} must be a string of at most {MAX_FIELD_LENGTH} characters")
            fields[name] = value.strip()
        try:
            source_id = str(uuid.UUID(fields["sourceId"]))
        except ValueError:
            return _error(400, "sourceId must be a UUID")
        if not fields["token"]:
            return _error(400, "token is required")
        meeting = urlsplit(fields["meetingUrl"])
        allowed = ("https", "http") if self.config.allow_http_meetings else ("https",)
        if meeting.scheme not in allowed or not meeting.hostname:
            return _error(400, "meetingUrl must be an https link")
        platform = fields["platform"] or "cisco-meeting-server"
        if platform not in PLATFORMS:
            return _error(400, f"platform must be one of {', '.join(sorted(PLATFORMS))}")

        existing = self.jobs.get(source_id)
        if existing and existing.active:
            return web.json_response(existing.view(), status=200)
        if len(self._active()) >= self.config.max_bots:
            return _error(429, f"all {self.config.max_bots} bot slots are busy")

        bot = self._bot_factory(
            BotConfig(
                justai_url=self.config.justai_url,
                source_id=source_id,
                token=fields["token"],
                meeting_url=fields["meetingUrl"],
                name=fields["name"] or self.config.default_name,
                platform=platform,
                meeting_id=fields["meetingId"],
                passcode=fields["passcode"],
                locale=self.config.locale,
                join_timeout=self.config.join_timeout,
                max_minutes=self.config.max_minutes,
                alone_minutes=self.config.alone_minutes,
                silence_minutes=self.config.silence_minutes,
                debug_dir=self.config.debug_dir,
                headful=self.config.headful,
                camera=self.config.camera,
            ),
            handle_signals=False,
        )
        job = Job(source_id=source_id, bot=bot, meeting_host=redact_url(fields["meetingUrl"]))
        self.jobs[source_id] = job
        job.task = asyncio.create_task(self._run(job), name=f"bot-{source_id}")
        log.info("bot %s starting for %s", source_id, job.meeting_host)
        return web.json_response(job.view(), status=202)

    async def _run(self, job: Job) -> None:
        try:
            await job.bot.run()
        finally:
            job.finished_at = time.time()
            log.info("bot %s %s: %s", job.source_id, job.bot.status, job.bot.end_reason or "-")

    async def _shutdown(self, _app: web.Application) -> None:
        running = [job for job in self.jobs.values() if job.active and job.task]
        for job in running:
            job.bot.stop()
        if running:
            log.info("stopping %d bots", len(running))
            await asyncio.wait([job.task for job in running], timeout=SHUTDOWN_GRACE_SECONDS)


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


def serve() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    try:
        config = ServiceConfig.from_env()
    except (OSError, ValueError) as error:
        log.error("%s", error)
        return 2
    service = BotService(config)
    log.info("meeting bot service on :%d for %s (up to %d bots)", config.port, redact_url(config.justai_url), config.max_bots)
    web.run_app(service.app, port=config.port, print=None, shutdown_timeout=SHUTDOWN_GRACE_SECONDS + 5)
    return 0
