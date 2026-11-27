"""Command line: ``python -m meeting_bot`` runs one bot; ``python -m meeting_bot serve``
runs the HTTP service the JustAI backend starts bots through (see service.py).

Secrets (the JustAI ingest token and a meeting passcode) are read from the
environment or from files, never from arguments, so they do not show up in process
listings.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from .bot import EXIT_CONFIG, BotConfig, MeetingBot
from .platforms import PLATFORMS


def _secret(name: str) -> str:
    """Reads NAME, or the file named by NAME_FILE."""
    path = os.environ.get(f"{name}_FILE", "").strip()
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    return os.environ.get(name, "").strip()


def _float_env(name: str, default: float) -> float:
    value = os.environ.get(name, "").strip()
    return float(value) if value else default


def parse_args(argv: list[str] | None = None) -> BotConfig:
    env = os.environ.get
    parser = argparse.ArgumentParser(prog="meeting_bot", description="Join a web meeting with headless Chromium and forward its audio to a JustAI live transcription.")
    parser.add_argument("--justai-url", default=env("JUSTAI_URL", ""), help="JustAI base URL, e.g. https://justai.example.org (JUSTAI_URL)")
    parser.add_argument("--source-id", default=env("JUSTAI_BOT_SOURCE_ID", ""), help="meeting-bot source id from POST …/bot-sources (JUSTAI_BOT_SOURCE_ID)")
    parser.add_argument("--meeting-url", default=env("MEETING_URL", ""), help="meeting link or the web app's join page (MEETING_URL)")
    parser.add_argument("--meeting-id", default=env("MEETING_ID", ""), help="meeting/call ID when the link does not contain it (MEETING_ID)")
    parser.add_argument("--name", default=env("BOT_NAME", "JustAI Transkription (Bot)"), help="name shown to participants (BOT_NAME)")
    parser.add_argument("--platform", default=env("BOT_PLATFORM", "cisco-meeting-server"), choices=sorted(PLATFORMS))
    parser.add_argument("--locale", default=env("BOT_LOCALE", "de-DE"))
    parser.add_argument("--join-timeout", type=float, default=_float_env("BOT_JOIN_TIMEOUT_SECONDS", 600), help="seconds to get in, waiting room included")
    parser.add_argument("--max-minutes", type=float, default=_float_env("BOT_MAX_MINUTES", 240), help="leave after this long (0: no limit)")
    parser.add_argument("--alone-minutes", type=float, default=_float_env("BOT_ALONE_MINUTES", 2), help="leave when the bot has been alone this long (0: never)")
    parser.add_argument("--silence-minutes", type=float, default=_float_env("BOT_SILENCE_MINUTES", 30), help="leave when nothing is heard this long (0: never)")
    parser.add_argument("--selectors-file", default=env("BOT_SELECTORS_FILE") or None, help="JSON file with Playwright selectors overriding the join heuristics")
    parser.add_argument("--debug-dir", default=env("BOT_DEBUG_DIR") or None, help="save a screenshot and the page HTML here when joining fails")
    parser.add_argument("--camera", default=env("BOT_CAMERA", "card"), choices=["card", "off"], help="card: show the JustAI logo and a transcription notice; off: black picture, camera switched off")
    parser.add_argument("--headful", action="store_true", help="show the browser window (local debugging)")
    parser.add_argument("--allow-http", action="store_true", help="allow a plain-http JustAI URL (local development only)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # aiohttp and Playwright log request URLs at debug level; those carry tickets.
    for noisy in ("aiohttp", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    token = _secret("JUSTAI_BOT_TOKEN")
    passcode = _secret("MEETING_PASSCODE")
    missing = [label for label, value in (("--justai-url", args.justai_url), ("--source-id", args.source_id), ("--meeting-url", args.meeting_url), ("JUSTAI_BOT_TOKEN or JUSTAI_BOT_TOKEN_FILE", token)) if not value]
    if missing:
        parser.error("missing " + ", ".join(missing))
    justai = urlsplit(args.justai_url)
    if justai.scheme not in ("https", "http") or (justai.scheme == "http" and not args.allow_http):
        parser.error("--justai-url must be https (use --allow-http for local development)")
    if urlsplit(args.meeting_url).scheme not in ("https", "http"):
        parser.error("--meeting-url must be an http(s) link")
    return BotConfig(
        justai_url=args.justai_url,
        source_id=args.source_id,
        token=token,
        meeting_url=args.meeting_url,
        name=args.name,
        platform=args.platform,
        meeting_id=args.meeting_id,
        passcode=passcode,
        locale=args.locale,
        join_timeout=args.join_timeout,
        max_minutes=args.max_minutes,
        alone_minutes=args.alone_minutes,
        silence_minutes=args.silence_minutes,
        headful=args.headful,
        camera=args.camera,
        selectors_file=args.selectors_file,
        debug_dir=args.debug_dir,
    )


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args[:1] == ["serve"]:
        from .service import serve

        return serve()
    try:
        config = parse_args(argv)
    except (OSError, ValueError) as error:
        print(f"meeting_bot: {error}", file=sys.stderr)
        return EXIT_CONFIG
    return asyncio.run(MeetingBot(config).run())


if __name__ == "__main__":
    sys.exit(main())
