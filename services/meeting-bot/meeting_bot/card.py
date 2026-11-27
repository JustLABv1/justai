"""The picture the bot shows as its camera: the JustAI logo and a note that the
conversation is being transcribed, so every participant can see a bot is listening.

It is rendered once per bot with a short-lived headless browser and handed to
Chromium's fake camera as a one-frame MJPEG file, which Chromium repeats.
"""

from __future__ import annotations

import html
import logging
from pathlib import Path

from playwright.async_api import Playwright

log = logging.getLogger(__name__)

LOGO = Path(__file__).with_name("assets") / "justai-logo.svg"
WIDTH, HEIGHT = 1280, 720

TEXTS = {
    "de": ("Dieses Gespräch wird von JustAI transkribiert", "Bot"),
    "en": ("This conversation is being transcribed by JustAI", "Bot"),
}


def card_html(name: str, locale: str) -> str:
    notice, _ = TEXTS.get(locale.split("-")[0].lower(), TEXTS["en"])
    logo = LOGO.read_text(encoding="utf-8")
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
html, body {{ margin: 0; width: {WIDTH}px; height: {HEIGHT}px; background: #0b1020; }}
body {{ display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 36px;
       font-family: "Helvetica Neue", Arial, sans-serif; color: #e8ecf5; }}
.logo svg {{ width: 520px; height: auto; display: block; }}
.notice {{ font-size: 40px; font-weight: 600; text-align: center; max-width: 1100px; }}
.name {{ font-size: 28px; color: #9aa6bf; }}
.dot {{ display: inline-block; width: 18px; height: 18px; border-radius: 50%; background: #e5484d; margin-right: 14px; vertical-align: middle; }}
</style></head><body>
<div class="logo">{logo}</div>
<div class="notice"><span class="dot"></span>{html.escape(notice)}</div>
<div class="name">{html.escape(name)}</div>
</body></html>"""


async def render_card(playwright: Playwright, target: Path, name: str, locale: str) -> bool:
    """Writes the card as a one-frame MJPEG file. Returns False when rendering failed."""
    try:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page(viewport={"width": WIDTH, "height": HEIGHT})
            await page.set_content(card_html(name, locale))
            target.write_bytes(await page.screenshot(type="jpeg", quality=90))
        finally:
            await browser.close()
        return True
    except Exception as error:
        log.warning("could not render the bot's picture, showing a black one: %s", error)
        return False
