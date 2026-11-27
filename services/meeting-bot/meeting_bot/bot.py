"""Runs one bot: opens JustAI's capture stream, joins the meeting in headless
Chromium, forwards the meeting audio and leaves when the meeting is over."""

from __future__ import annotations

import asyncio
import base64
import logging
import signal
import struct
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from playwright.async_api import Browser, Page, async_playwright

from .card import render_card
from .frames import pcm_level
from .ingest import IngestError, JustAIIngest
from .platforms import PLATFORMS, JoinError, Selectors, WebMeeting

log = logging.getLogger(__name__)

CAPTURE_SCRIPT = Path(__file__).with_name("capture.js")

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_JOIN_FAILED = 3
EXIT_INGEST_FAILED = 4
EXIT_BROWSER_FAILED = 5

# Below this RMS level a chunk counts as silence for the "nobody is talking" stop.
SILENCE_LEVEL = 0.003


@dataclass
class BotConfig:
    justai_url: str
    source_id: str
    token: str
    meeting_url: str
    name: str = "JustAI Transkription (Bot)"
    platform: str = "cisco-meeting-server"
    meeting_id: str = ""
    passcode: str = ""
    locale: str = "de-DE"
    join_timeout: float = 600.0
    max_minutes: float = 240.0
    alone_minutes: float = 2.0
    silence_minutes: float = 30.0
    headful: bool = False
    selectors_file: str | None = None
    debug_dir: str | None = None
    # "card": the camera shows the JustAI logo and a note that the conversation is
    # transcribed, and stays on so everyone sees a bot is listening. "off": a black
    # picture, and the camera is switched off in the meeting.
    camera: str = "card"


def redact_url(url: str) -> str:
    """Scheme and host only: meeting links can carry a secret in path or query."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.hostname or ''}"


def silent_wav(path: Path, seconds: int = 1, rate: int = 48000) -> None:
    data = b"\x00\x00" * rate * seconds
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data))
    path.write_bytes(header + data)


def black_y4m(path: Path, width: int = 320, height: int = 180) -> None:
    luma, chroma = bytes([16]) * (width * height), bytes([128]) * (width * height // 4)
    path.write_bytes(f"YUV4MPEG2 W{width} H{height} F1:1 Ip A1:1 C420jpeg\n".encode() + b"FRAME\n" + luma + chroma + chroma)


class AudioMeter:
    """What the page delivered: how many remote tracks there are and when sound was last heard."""

    def __init__(self) -> None:
        now = time.monotonic()
        self.tracks = 0
        self.chunks = 0
        self.last_tracks_at = now
        self.last_sound_at = now

    def update(self, pcm: bytes, tracks: int) -> None:
        now = time.monotonic()
        self.chunks += 1
        self.tracks = tracks
        if tracks > 0:
            self.last_tracks_at = now
        if pcm_level(pcm) >= SILENCE_LEVEL:
            self.last_sound_at = now

    def reset(self) -> None:
        self.last_tracks_at = self.last_sound_at = time.monotonic()


class MeetingBot:
    """Statuses: starting, connecting (to JustAI), joining, in_call, then ended or failed."""

    def __init__(self, config: BotConfig, *, handle_signals: bool = True):
        self.config = config
        self.meter = AudioMeter()
        self.stop_requested = asyncio.Event()
        self.end_reason = ""
        self.status = "starting"
        self.exit_code: int | None = None
        self._handle_signals = handle_signals

    def stop(self) -> None:
        self.stop_requested.set()

    async def run(self) -> int:
        try:
            code = await self._run()
        except Exception as error:  # a bug must not leave the status hanging
            log.exception("bot crashed: %s", error)
            self.end_reason = self.end_reason or "the bot crashed"
            code = EXIT_BROWSER_FAILED
        self.exit_code = code
        self.status = "ended" if code == EXIT_OK else "failed"
        return code

    async def _run(self) -> int:
        config = self.config
        if config.platform not in PLATFORMS:
            log.error("unknown platform %r (known: %s)", config.platform, ", ".join(sorted(PLATFORMS)))
            return EXIT_CONFIG
        selectors = Selectors.load(config.selectors_file)
        if self._handle_signals:
            self._install_signal_handlers()
        self.status = "connecting"
        log.info("bot for %s on %s", config.platform, redact_url(config.meeting_url))
        async with aiohttp.ClientSession() as http:
            ingest = JustAIIngest(config.justai_url, config.source_id, config.token, http)
            try:
                await ingest.connect()
            except IngestError as error:
                log.error("JustAI capture stream failed: %s", error)
                self.end_reason = f"JustAI capture stream failed: {error}"
                await ingest.stop()
                return EXIT_INGEST_FAILED
            try:
                return await self._meeting(ingest, selectors)
            finally:
                await ingest.stop()
                log.info("finished: %s (%d batches, %d frames uploaded, %d chunks dropped)", self.end_reason or "stopped", ingest.stats.batches, ingest.stats.frames, ingest.stats.dropped_chunks)

    async def _meeting(self, ingest: JustAIIngest, selectors: Selectors) -> int:
        config = self.config
        with tempfile.TemporaryDirectory(prefix="justai-meeting-bot-") as scratch:
            audio, video = Path(scratch, "silence.wav"), Path(scratch, "black.y4m")
            silent_wav(audio)
            black_y4m(video)
            async with async_playwright() as playwright:
                if config.camera == "card":
                    card = Path(scratch, "card.mjpeg")
                    if await render_card(playwright, card, config.name, config.locale):
                        video = card
                browser = await playwright.chromium.launch(
                    headless=not config.headful,
                    args=[
                        "--use-fake-ui-for-media-stream",
                        "--use-fake-device-for-media-stream",
                        f"--use-file-for-fake-audio-capture={audio}",
                        f"--use-file-for-fake-video-capture={video}",
                        "--autoplay-policy=no-user-gesture-required",
                        "--disable-dev-shm-usage",
                    ],
                )
                try:
                    page = await self._open_page(browser, ingest)
                    meeting = WebMeeting(
                        page, PLATFORMS[config.platform], selectors, name=config.name, meeting_id=config.meeting_id, passcode=config.passcode,
                        keep_camera=config.camera == "card",
                    )
                    self.status = "joining"
                    try:
                        await page.goto(config.meeting_url, wait_until="domcontentloaded", timeout=60_000)
                        if not await self._until_stopped(ingest, meeting.join(config.join_timeout, lambda: self._in_call(page, meeting))):
                            self.end_reason = "stopped while joining"
                            return EXIT_OK if self.stop_requested.is_set() or ingest.session_ended else EXIT_INGEST_FAILED
                    except JoinError as error:
                        log.error("join failed: %s", error)
                        await self._debug_snapshot(page, "join-failed")
                        self.end_reason = f"join failed: {error}"
                        return EXIT_JOIN_FAILED
                    self.meter.reset()
                    self.status = "in_call"
                    await self._debug_snapshot(page, "joined")
                    code = await self._attend(page, meeting, ingest)
                    await meeting.leave()
                    return code
                except Exception as error:
                    if self.stop_requested.is_set():
                        return EXIT_OK
                    log.exception("browser failed: %s", error)
                    self.end_reason = "browser failed"
                    return EXIT_BROWSER_FAILED
                finally:
                    await browser.close()

    async def _open_page(self, browser: Browser, ingest: JustAIIngest) -> Page:
        # A headless browser announces itself in its user agent, which meeting web apps
        # may refuse as an unsupported browser. The engine is a current Chromium.
        major = browser.version.split(".")[0]
        user_agent = f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
        context = await browser.new_context(
            user_agent=user_agent,
            locale=self.config.locale,
            permissions=["microphone", "camera"],
            viewport={"width": 1280, "height": 800},
        )

        async def on_audio(_source, encoded: str, tracks: int) -> None:
            pcm = base64.b64decode(encoded)
            self.meter.update(pcm, int(tracks))
            ingest.push_pcm(pcm)

        await context.expose_binding("__justaiAudio", on_audio)
        await context.add_init_script(path=str(CAPTURE_SCRIPT))
        return await context.new_page()

    async def _until_stopped(self, ingest: JustAIIngest, work) -> bool:
        """Runs ``work`` unless a stop request or the end of the JustAI stream comes first."""
        task = asyncio.ensure_future(work)
        stop = asyncio.ensure_future(self.stop_requested.wait())
        closed = asyncio.ensure_future(ingest.closed.wait())
        try:
            await asyncio.wait({task, stop, closed}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            stop.cancel()
            closed.cancel()
        if task.done():
            task.result()  # re-raises JoinError
            return True
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return False

    async def _in_call(self, page: Page, meeting: WebMeeting) -> bool:
        if self.meter.tracks > 0:
            return True
        return await meeting.leave_visible()

    async def _attend(self, page: Page, meeting: WebMeeting, ingest: JustAIIngest) -> int:
        config = self.config
        started = time.monotonic()
        # The page's participant count tells best whether others are still there. Where
        # a page shows none, incoming audio tracks stand in (a meeting server that mixes
        # everyone into one stream keeps that stream even when the bot is alone).
        counted_at = 0.0
        last_count: int | None = None
        company_at = started
        while True:
            now = time.monotonic()
            if now - counted_at >= 5:
                counted_at = now
                count = await meeting.participant_count()
                if count != last_count and count is not None:
                    log.info("%d in the meeting (the bot included)", count)
                last_count = count if count is not None else last_count
                if count is not None and count > 1:
                    company_at = now
            # The call's toolbar appears after joining; keep trying for a minute.
            if not meeting.devices_off and now - started < 60:
                if await meeting.ensure_devices_off():
                    await self._debug_snapshot(page, "devices-off")
                elif now - started > 50:
                    log.warning("could not tell how to switch camera and microphone off; they only send a black picture and silence")
                    await self._debug_snapshot(page, "devices-unknown")
                    meeting._toggled.update({"camera", "microphone"})
            if self.stop_requested.is_set():
                self.end_reason = "stop requested"
                return EXIT_OK
            if ingest.closed.is_set():
                self.end_reason = ingest.close_reason or "the JustAI stream closed"
                return EXIT_OK if ingest.session_ended else EXIT_INGEST_FAILED
            if page.is_closed():
                self.end_reason = "the meeting page closed"
                return EXIT_BROWSER_FAILED
            if config.max_minutes and now - started >= config.max_minutes * 60:
                self.end_reason = "maximum duration reached"
                return EXIT_OK
            if config.alone_minutes:
                since = company_at if last_count is not None else self.meter.last_tracks_at
                if now - since >= config.alone_minutes * 60:
                    self.end_reason = "no other participant for a while"
                    return EXIT_OK
            if config.silence_minutes and now - self.meter.last_sound_at >= config.silence_minutes * 60:
                self.end_reason = "nothing was said for a while"
                return EXIT_OK
            if await meeting.has_ended():
                self.end_reason = "the meeting ended"
                return EXIT_OK
            try:
                await asyncio.wait_for(self.stop_requested.wait(), timeout=2)
            except TimeoutError:
                pass

    async def _debug_snapshot(self, page: Page, label: str) -> None:
        if not self.config.debug_dir:
            return
        target = Path(self.config.debug_dir)
        target.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        try:
            await page.screenshot(path=str(target / f"{stamp}-{label}.png"), full_page=True)
            (target / f"{stamp}-{label}.html").write_text(await page.content(), encoding="utf-8")
            log.info("saved a debug snapshot to %s", target)
        except Exception as error:
            log.warning("could not save a debug snapshot: %s", error)

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(signum, self.stop_requested.set)
            except (NotImplementedError, RuntimeError):
                pass
