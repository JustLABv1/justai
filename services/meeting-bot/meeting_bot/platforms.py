"""Joining and leaving a meeting's web app.

The join flow is found by what the page says, not by fixed CSS classes: inputs are
matched by their label, placeholder or ARIA name, buttons by their text, in German
and English. This covers the Cisco Meeting Server web app's guest flow (meeting ID,
passcode, name, then "Join") and similar web clients. It has not been checked
against a specific deployment; a selectors file (see README) overrides any step
once a deployment's real markup is known.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, fields
from pathlib import Path

from playwright.async_api import Frame, Page

log = logging.getLogger(__name__)


class JoinError(Exception):
    """The bot could not get into the meeting."""


@dataclass
class Selectors:
    """Playwright selectors that replace the text heuristics for one step."""

    meeting_id: str = ""
    passcode: str = ""
    name: str = ""
    join: str = ""
    leave: str = ""
    in_call: str = ""
    ended: str = ""
    # An element whose aria-label, title or text holds the participant count.
    participants: str = ""

    @classmethod
    def load(cls, path: str | None) -> Selectors:
        if not path:
            return cls()
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        known = {f.name for f in fields(cls)}
        unknown = set(data) - known
        if unknown:
            raise ValueError(f"unknown selector keys: {', '.join(sorted(unknown))}")
        return cls(**{k: str(v) for k, v in data.items()})


@dataclass(frozen=True)
class Patterns:
    meeting_id: re.Pattern
    passcode: re.Pattern
    name: re.Pattern
    join: re.Pattern
    leave: re.Pattern
    ended: re.Pattern
    camera_off: re.Pattern
    mic_off: re.Pattern
    turns_off: re.Pattern
    turns_on: re.Pattern
    state_on: re.Pattern
    state_off: re.Pattern
    consent: re.Pattern


_I = re.IGNORECASE

GENERIC = Patterns(
    meeting_id=re.compile(r"meeting[\s-]*(id|nummer|number)|call[\s-]*(id|number)|conference[\s-]*id|besprechungs[\s-]*(id|nummer)|konferenz[\s-]*(id|nummer)|anruf[\s-]*id|raum[\s-]*(id|nummer)", _I),
    passcode=re.compile(r"passcode|passwor[dt]|kenncode|zugangscode|access[\s-]*code|\bpin\b|kennwort", _I),
    # "Name", "Ihr Name", "Geben Sie Ihren Namen ein", "Anzeigename", "Your name".
    name=re.compile(r"\bnamen?\b|anzeigenamen?|your\s+name|display\s*name", _I),
    join=re.compile(
        r"^\s*(join|join (the )?(meeting|call|now)|join as (a )?guest|continue|next|weiter|fortfahren|teilnehmen|"
        r"beitreten|jetzt (teilnehmen|beitreten)|(an der |an )?besprechung (teilnehmen|beitreten)|als gast (teilnehmen|beitreten)|"
        r"meeting beitreten|konferenz beitreten|(anzeige)?namen? festlegen|set (display )?name|save name)\s*$",
        _I,
    ),
    leave=re.compile(r"^\s*(leave|leave (the )?(meeting|call)|hang ?up|end call|verlassen|auflegen|(besprechung|meeting|konferenz) verlassen|anruf beenden)\s*$", _I),
    ended=re.compile(
        r"meeting has ended|call has ended|meeting ended|you have left|you left the (meeting|call)|removed from the (meeting|call)|"
        r"besprechung (wurde |ist )?beendet|meeting (wurde |ist )?beendet|anruf (wurde |ist )?beendet|konferenz (wurde |ist )?beendet|"
        r"sie haben die (besprechung|konferenz) verlassen|aus der (besprechung|konferenz) entfernt",
        _I,
    ),
    camera_off=re.compile(r"camera|kamera|video", _I),
    mic_off=re.compile(r"micro?phone|\bmic\b|mikrofon|\baudio\b|mute|stumm", _I),
    # Toggle labels usually name what a click does: "Mikrofon stummschalten" while it
    # is on, "Stummschaltung aufheben" while it is off.
    turns_off=re.compile(r"\bmute\b|stumm ?schalten|turn off|switch off|aus ?schalten|deaktivieren|disable|\bstop\b|stoppen|\baus\b", _I),
    turns_on=re.compile(r"unmute|aufheben|turn on|switch on|ein ?schalten|(?<!de)aktivieren|enable|\bstart\b|starten|\bein\b", _I),
    # Or the current state, as the Cisco Meeting Server web app does:
    # aria-label "Mikrofon aktiviert", title "Mikrofon ist derzeit aktiviert".
    state_on=re.compile(r"(?<!de)aktiviert|eingeschaltet|\bunmuted\b|\bis on\b|\benabled\b", _I),
    state_off=re.compile(r"deaktiviert|ausgeschaltet|stummgeschaltet|\bmuted\b|\bis off\b|\bdisabled\b", _I),
    # Cookie and storage notices that can cover the join form.
    consent=re.compile(r"^\s*(ok|okay|verstanden|akzeptieren|alle akzeptieren|zustimmen|accept|accept all|got it|i agree)\s*$", _I),
)

PLATFORMS = {"generic": GENERIC, "cisco-meeting-server": GENERIC}

# Describes the visible inputs and buttons of a frame in one round trip.
_DESCRIBE = """
() => {
  const visible = (el) => {
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0
  }
  const labelText = (el) => {
    const parts = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("name"), el.id]
    if (el.labels) for (const label of el.labels) parts.push(label.innerText)
    const by = el.getAttribute("aria-labelledby")
    if (by) for (const id of by.split(/\\s+/)) parts.push(document.getElementById(id)?.innerText)
    return parts.filter(Boolean).join(" | ")
  }
  const inputs = [...document.querySelectorAll("input, textarea")].map((el, index) => ({
    index, visible: visible(el), type: (el.getAttribute("type") || "text").toLowerCase(),
    label: labelText(el), value: el.value || "", disabled: el.disabled || el.readOnly,
  }))
  const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")].map((el, index) => ({
    index, visible: visible(el),
    text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().replace(/\\s+/g, " "),
    label: [el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" | "),
    pressed: el.getAttribute("aria-pressed") || el.getAttribute("aria-checked") || "",
    disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
  }))
  return { inputs, buttons, text: (document.body?.innerText || "").slice(0, 20000) }
}
"""

_BUTTONS = "button, [role=button], input[type=submit], input[type=button]"

# "3 Teilnehmer im Meeting, 0 Teilnehmer mit erhobener Hand …" (Cisco Meeting Server),
# "Teilnehmende (3)", "3 participants", "Participants (3)".
_COUNT = re.compile(
    r"(\d+)\s+(?:teilnehmer(?:innen|inner|ende)?|teilnehmende|participants?|people)\b"
    r"|(?:teilnehmer(?:innen)?|teilnehmende|participants?|people)\s*\(\s*(\d+)\s*\)",
    re.IGNORECASE,
)

_IN_MEETING = re.compile(r"im meeting|in der (besprechung|konferenz)|in (the )?(meeting|call)", re.IGNORECASE)
_IN_LOBBY = re.compile(r"lobby|warteraum|waiting room", re.IGNORECASE)

# Labels that may carry the participant count.
_COUNT_LABELS = """
() => [...document.querySelectorAll("[aria-label], [title], [data-test*=participant]")]
  .filter((el) => /teilnehm|participant|people/i.test(
    (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("data-test") || "")))
  .map((el) => [el.getAttribute("aria-label") || "", el.getAttribute("title") || "", (el.innerText || "").slice(0, 200)].join(" | "))
  .slice(0, 20)
"""


def parse_participant_count(text: str) -> int | None:
    """The first participant count in a label, or None."""
    match = _COUNT.search(text or "")
    if not match:
        return None
    return int(match.group(1) or match.group(2))

_SKIP_INPUT_TYPES = {"hidden", "checkbox", "radio", "submit", "button", "file", "range", "color"}


class WebMeeting:
    def __init__(self, page: Page, patterns: Patterns, selectors: Selectors, *, name: str, meeting_id: str = "", passcode: str = "", keep_camera: bool = False):
        self.page = page
        self.patterns = patterns
        self.selectors = selectors
        self.name = name
        self.meeting_id = meeting_id
        self.passcode = passcode
        # With the JustAI card as its picture the camera stays on: people should see the bot.
        self._toggled: set[str] = {"camera"} if keep_camera else set()
        self._consented = False
        self._last_report = 0.0

    async def join(self, timeout: float, in_call) -> None:
        """Fills the join forms until ``in_call()`` reports the bot is in the meeting."""
        deadline = time.monotonic() + timeout
        clicks = 0
        while time.monotonic() < deadline:
            if await in_call() or await self._visible(self.selectors.in_call):
                log.info("joined the meeting")
                return
            if await self.has_ended():
                raise JoinError("the meeting refused the bot or has already ended")
            acted = False
            for frame in self.page.frames:
                try:
                    acted = await self._step(frame) or acted
                except Exception as error:  # a frame can detach while the page navigates
                    log.debug("join step skipped a frame: %s", error)
                if acted:
                    clicks += 1
                    break
            await self.page.wait_for_timeout(1500 if acted else 1000)
        raise JoinError(f"not in the meeting after {int(timeout)} seconds ({clicks} join steps taken); a waiting room may need a host, or the page needs a selectors file")

    async def _step(self, frame: Frame) -> bool:
        state = await frame.evaluate(_DESCRIBE)
        if not self._consented:
            for button in state["buttons"]:
                if button["visible"] and not button["disabled"] and self.patterns.consent.search(button["text"]):
                    await frame.locator(_BUTTONS).nth(button["index"]).click()
                    self._consented = True
                    log.info("dismissed a notice (%r)", button["text"][:40])
                    return True
        filled = await self._fill(frame, state["inputs"])
        await self._turn_off_devices(frame, state["buttons"])
        if self.selectors.join:
            button = frame.locator(self.selectors.join).first
            if await button.count() and await button.is_visible() and await button.is_enabled():
                await button.click()
                return True
            return filled
        for button in state["buttons"]:
            if button["visible"] and not button["disabled"] and self.patterns.join.search(button["text"]):
                log.info("clicking %r", button["text"][:60])
                await frame.locator(_BUTTONS).nth(button["index"]).click()
                return True
        if not filled and time.monotonic() - self._last_report > 15:
            # Says what the bot sees when it does not know what to do, for a selectors file.
            self._last_report = time.monotonic()
            visible = [b["text"][:40] + (" (disabled)" if b["disabled"] else "") for b in state["buttons"] if b["visible"] and b["text"]]
            fields = [i["label"][:60] or i["type"] for i in state["inputs"] if i["visible"] and i["type"] not in _SKIP_INPUT_TYPES]
            log.info("waiting to join; visible buttons %s, fields %s", visible[:12], fields[:8])
        return filled

    async def _fill(self, frame: Frame, inputs: list[dict]) -> bool:
        wanted = [
            ("meeting_id", self.meeting_id, self.patterns.meeting_id, self.selectors.meeting_id),
            ("passcode", self.passcode, self.patterns.passcode, self.selectors.passcode),
            ("name", self.name, self.patterns.name, self.selectors.name),
        ]
        changed = False
        used: set[int] = set()
        for field, value, pattern, selector in wanted:
            if not value:
                continue
            if selector:
                target = frame.locator(selector).first
                if await target.count() and await target.is_visible() and await target.input_value() != value:
                    await target.fill(value)
                    changed = True
                continue
            for item in inputs:
                if item["index"] in used or not item["visible"] or item["disabled"] or item["type"] in _SKIP_INPUT_TYPES:
                    continue
                matches = pattern.search(item["label"]) or (field == "passcode" and item["type"] == "password")
                if field == "name" and item["type"] == "password":
                    matches = False
                if not matches:
                    continue
                used.add(item["index"])
                if item["value"] != value:
                    await frame.locator("input, textarea").nth(item["index"]).fill(value)
                    log.info("filled the %s field", field.replace("_", " "))
                    changed = True
                break
        return changed

    @property
    def devices_off(self) -> bool:
        return {"camera", "microphone"} <= self._toggled

    async def ensure_devices_off(self) -> bool:
        """Switches camera and microphone off in the call's toolbar; True once both are."""
        for frame in self.page.frames:
            try:
                await self._turn_off_devices(frame, (await frame.evaluate(_DESCRIBE))["buttons"])
            except Exception:
                continue
        return self.devices_off

    async def _turn_off_devices(self, frame: Frame, buttons: list[dict]) -> None:
        # The bot's camera and microphone are blank fakes; switching them off keeps
        # the bot unobtrusive. A toggle is clicked only when it says it is on: pressed
        # state "true", or a label naming the action that switches it off. An unknown
        # toggle is never switched on by mistake.
        for kind, pattern in (("camera", self.patterns.camera_off), ("microphone", self.patterns.mic_off)):
            if kind in self._toggled:
                continue
            for button in buttons:
                if not button["visible"]:
                    continue
                words = f'{button["text"]} {button["label"]}'
                if not pattern.search(words):
                    continue
                turns_off = bool(self.patterns.turns_off.search(words))
                turns_on = bool(self.patterns.turns_on.search(words))
                state_on = bool(self.patterns.state_on.search(words)) and not self.patterns.state_off.search(words)
                state_off = bool(self.patterns.state_off.search(words))
                if button["pressed"] == "false" or state_off or (turns_on and not turns_off and not state_on):
                    self._toggled.add(kind)  # already off
                    log.info("the %s is already off", kind)
                    break
                if button["disabled"]:
                    continue
                if button["pressed"] == "true" or state_on or (turns_off and not turns_on):
                    await frame.locator(_BUTTONS).nth(button["index"]).click()
                    self._toggled.add(kind)
                    log.info("switched the %s off (%r)", kind, words.strip()[:50])
                    break

    async def leave_visible(self) -> bool:
        """A visible leave button means the bot is in the call."""
        if self.selectors.leave:
            return await self._visible(self.selectors.leave)
        for frame in self.page.frames:
            try:
                state = await frame.evaluate(_DESCRIBE)
            except Exception:
                continue
            if any(b["visible"] and self.patterns.leave.search(b["text"] or b["label"]) for b in state["buttons"]):
                return True
        return False

    async def participant_count(self) -> int | None:
        """How many are in the meeting (the bot included), when the page says so."""
        for frame in self.page.frames:
            try:
                if self.selectors.participants:
                    target = frame.locator(self.selectors.participants).first
                    if not await target.count():
                        continue
                    labels = [" | ".join(filter(None, [await target.get_attribute("aria-label"), await target.get_attribute("title"), await target.inner_text()]))]
                else:
                    labels = await frame.evaluate(_COUNT_LABELS)
            except Exception:
                continue
            # "… im Meeting" beats other counts such as people waiting in the lobby.
            ranked = sorted(labels, key=lambda label: 0 if _IN_MEETING.search(label) else 1)
            for label in ranked:
                if _IN_LOBBY.search(label) and not _IN_MEETING.search(label):
                    continue
                count = parse_participant_count(label)
                if count is not None:
                    return count
        return None

    async def has_ended(self) -> bool:
        if await self._visible(self.selectors.ended):
            return True
        for frame in self.page.frames:
            try:
                text = await frame.evaluate("() => (document.body?.innerText || '').slice(0, 20000)")
            except Exception:
                continue
            if self.patterns.ended.search(text):
                return True
        return False

    async def leave(self) -> None:
        """Clicks the leave button (and a confirmation, if one appears). Best effort."""
        for _ in range(2):
            clicked = False
            for frame in self.page.frames:
                try:
                    if self.selectors.leave:
                        target = frame.locator(self.selectors.leave).first
                        if await target.count() and await target.is_visible():
                            await target.click()
                            clicked = True
                            break
                        continue
                    state = await frame.evaluate(_DESCRIBE)
                    for button in state["buttons"]:
                        if button["visible"] and not button["disabled"] and self.patterns.leave.search(button["text"] or button["label"]):
                            await frame.locator("button, [role=button], input[type=submit], input[type=button]").nth(button["index"]).click()
                            clicked = True
                            break
                except Exception:
                    continue
                if clicked:
                    break
            if not clicked:
                return
            await self.page.wait_for_timeout(1000)

    async def _visible(self, selector: str) -> bool:
        if not selector:
            return False
        for frame in self.page.frames:
            try:
                target = frame.locator(selector).first
                if await target.count() and await target.is_visible():
                    return True
            except Exception:
                continue
        return False
