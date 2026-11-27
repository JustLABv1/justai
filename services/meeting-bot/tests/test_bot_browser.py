"""End to end: the bot joins a local stand-in meeting page and forwards its WebRTC
audio to a local stand-in JustAI. No external system is contacted.

The page imitates a guest join flow like the Cisco Meeting Server web app's (meeting
ID and passcode, then name and device toggles, then the call). Its markup is
invented; it checks the bot's mechanics, not any real deployment's markup.
"""

import asyncio
import math
import struct
import tempfile
import unittest
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

from meeting_bot.bot import EXIT_JOIN_FAILED, EXIT_OK, BotConfig, MeetingBot
from meeting_bot.service import BotService, ServiceConfig
from tests.fake_justai import SOURCE_ID, TOKEN, FakeJustAI

MEETING_PAGE = """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Web-App</title></head>
<body>
<div id="unsupported" hidden>Sie verwenden einen Browser, der nicht unterstützt wird.</div>
<form id="step1" hidden>
  <label for="cid">Meeting-ID</label><input id="cid">
  <label for="pw">Passcode</label><input id="pw" type="password">
  <button type="submit">Weiter</button>
</form>
<form id="step2" hidden>
  <label>Ihr Name <input id="name"></label>
  <button type="button" id="cam" aria-pressed="true" aria-label="Kamera">📷</button>
  <button type="button" id="mic" aria-pressed="true" aria-label="Mikrofon">🎤</button>
  <button type="submit" id="join">Besprechung beitreten</button>
</form>
<div id="call" hidden><p>Im Gespräch</p><button id="leave">Verlassen</button></div>
<div id="ended" hidden>Die Besprechung wurde beendet.</div>
<script>
const show = (id) => { for (const el of document.body.children) if (el.id) el.hidden = el.id !== id }
const endAfter = Number(new URLSearchParams(location.search).get("end_after") || 8)
if (navigator.userAgent.includes("Headless")) show("unsupported"); else show("step1")
for (const id of ["cam", "mic"]) document.getElementById(id).onclick = (e) =>
  e.currentTarget.setAttribute("aria-pressed", String(e.currentTarget.getAttribute("aria-pressed") !== "true"))
document.getElementById("step1").onsubmit = (e) => { e.preventDefault(); if (cid.value && pw.value) show("step2") }
let peers = []
document.getElementById("step2").onsubmit = async (e) => {
  e.preventDefault()
  if (!document.getElementById("name").value) return
  await fetch("/joined", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    meetingId: cid.value, passcode: pw.value, name: document.getElementById("name").value,
    camera: cam.getAttribute("aria-pressed"), microphone: mic.getAttribute("aria-pressed"),
  }) })
  const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  // The "far end": a second peer sends a 440 Hz tone, as other participants would speak.
  const ctx = new AudioContext()
  const osc = ctx.createOscillator(); osc.frequency.value = 440
  const gain = ctx.createGain(); gain.gain.value = 0.5
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain).connect(dest); osc.start()
  const far = new RTCPeerConnection(), near = new RTCPeerConnection()
  peers = [far, near]
  far.onicecandidate = (ev) => ev.candidate && near.addIceCandidate(ev.candidate)
  near.onicecandidate = (ev) => ev.candidate && far.addIceCandidate(ev.candidate)
  dest.stream.getTracks().forEach((t) => far.addTrack(t, dest.stream))
  local.getTracks().forEach((t) => near.addTrack(t, local))
  await far.setLocalDescription(await far.createOffer())
  await near.setRemoteDescription(far.localDescription)
  await near.setLocalDescription(await near.createAnswer())
  await far.setRemoteDescription(near.localDescription)
  show("call")
  setTimeout(() => { peers.forEach((p) => p.close()); show("ended") }, endAfter * 1000)
}
document.getElementById("leave").onclick = () => { peers.forEach((p) => p.close()); show("ended") }
</script></body></html>"""


# The name step of the BDBOS Cisco Meeting Server web app as seen on 27 Nov 2026
# (texts from a screenshot; the markup is invented): the link already holds the
# meeting and its secret, a popover asks for the name, and a storage notice sits on top.
CMS_NAME_PAGE = """<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>BDBOS Meeting Plattform</title></head>
<body>
<div id="lobby">
  <button>Zurück</button>
  <h1>test beitreten</h1><p>Wie lautet Ihr Name?</p>
  <div role="dialog" id="popover">
    <p>Legen Sie Ihren Namen fest, um fortzufahren</p>
    <input id="n" placeholder="Geben Sie Ihren Namen ein">
    <button id="setname" disabled>Anzeigenamen festlegen</button>
  </div>
  <button id="cam" aria-label="Kamera ausschalten" disabled>📷</button>
  <button id="join" disabled>Konferenz beitreten</button>
  <button>Weitere Methoden zum Beitreten</button>
</div>
<div id="notice" style="position:fixed;right:0;bottom:0;width:340px;height:160px;background:#fff;z-index:9">
  Wir verwenden den lokalen Browserspeicher … <button id="ok">OK</button>
</div>
<div id="call" hidden>
  <mdc-button id="mic" role="button" tabindex="0" aria-label="Mikrofon aktiviert" title="Mikrofon ist derzeit aktiviert" style="display:inline-block;width:52px;height:52px">🎤</mdc-button>
  <mdc-button id="video" role="button" tabindex="0" aria-label="Video aktiviert" title="Videoübertragung ist derzeit aktiviert" style="display:inline-block;width:52px;height:52px">📷</mdc-button>
  <mdc-button id="leave" role="button" tabindex="0" title="Meeting verlassen" style="display:inline-block;width:52px;height:52px">✖</mdc-button>
  <mdc-button id="people" role="button" tabindex="0" data-test="participants-button" title="Teilnehmende"
    aria-label="2 Teilnehmer im Meeting, 0 Teilnehmer mit erhobener Hand und Teilnehmer in der Lobby">👥</mdc-button>
  <span aria-label="4 Teilnehmer in der Lobby"></span>
</div>
<div id="ended" hidden>Die Konferenz wurde beendet.</div>
<script>
let displayName = "", peers = []
ok.onclick = () => notice.remove()
n.oninput = () => { setname.disabled = !n.value }
setname.onclick = () => { displayName = n.value; popover.remove(); join.disabled = false; cam.disabled = false }
let cameraOn = true, micOn = true
cam.onclick = () => { cameraOn = !cameraOn; cam.setAttribute("aria-label", cameraOn ? "Kamera ausschalten" : "Kamera einschalten") }
mic.onclick = () => {
  micOn = !micOn
  mic.setAttribute("aria-label", micOn ? "Mikrofon aktiviert" : "Mikrofon deaktiviert")
  mic.title = micOn ? "Mikrofon ist derzeit aktiviert" : "Mikrofon ist derzeit deaktiviert"
  fetch("/joined", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ microphone: micOn }) })
}
video.onclick = () => fetch("/joined", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video: "clicked" }) })
// What the bot's camera sends: brightest pixel and how blue the picture is.
async function cameraLooks(stream) {
  const element = document.createElement("video")
  element.muted = true; element.srcObject = stream; await element.play()
  await new Promise((r) => setTimeout(r, 800))
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180
  const g = canvas.getContext("2d"); g.drawImage(element, 0, 0, 320, 180)
  const px = g.getImageData(0, 0, 320, 180).data
  let bright = 0, blue = 0
  for (let i = 0; i < px.length; i += 4) {
    bright = Math.max(bright, (px[i] + px[i + 1] + px[i + 2]) / 3)
    if (px[i + 2] > 180 && px[i] < 120) blue++
  }
  return { bright: Math.round(bright), bluePixels: blue }
}
join.onclick = async () => {
  if (document.getElementById("notice")) return  // covered: a real click would not get through
  await fetch("/joined", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: displayName, secret: new URLSearchParams(location.search).get("secret"), camera: cameraOn }) })
  const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  cameraLooks(local).then((looks) => fetch("/joined", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ picture: looks }) }))
  const ctx = new AudioContext(), osc = ctx.createOscillator(), dest = ctx.createMediaStreamDestination()
  osc.frequency.value = 440; osc.connect(dest); osc.start()
  const far = new RTCPeerConnection(), near = new RTCPeerConnection()
  peers = [far, near]
  far.onicecandidate = (ev) => ev.candidate && near.addIceCandidate(ev.candidate)
  near.onicecandidate = (ev) => ev.candidate && far.addIceCandidate(ev.candidate)
  dest.stream.getTracks().forEach((t) => far.addTrack(t, dest.stream))
  near.addTransceiver("audio", { direction: "recvonly" })
  await far.setLocalDescription(await far.createOffer())
  await near.setRemoteDescription(far.localDescription)
  await near.setLocalDescription(await near.createAnswer())
  await far.setRemoteDescription(near.localDescription)
  lobby.hidden = true; call.hidden = false
  const params = new URLSearchParams(location.search)
  if (params.get("alone_after")) {
    // Everybody else leaves; the meeting stays open and the far end's stream keeps going.
    setTimeout(() => people.setAttribute("aria-label", "1 Teilnehmer im Meeting, 0 Teilnehmer mit erhobener Hand und Teilnehmer in der Lobby"), Number(params.get("alone_after")) * 1000)
  } else {
    setTimeout(() => { peers.forEach((p) => p.close()); call.hidden = true; ended.hidden = false }, 6000)
  }
}
</script></body></html>"""


def dominant_frequency(pcm: bytes, rate: int = 16000) -> float:
    count = len(pcm) // 2
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    crossings = sum(1 for a, b in zip(samples, samples[1:]) if a < 0 <= b)
    return crossings / (count / rate)


def rms(pcm: bytes) -> float:
    count = len(pcm) // 2
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    return math.sqrt(sum(s * s for s in samples) / max(1, count)) / 32768


class BrowserBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        try:
            from playwright.async_api import async_playwright

            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch()
                await browser.close()
        except Exception as error:  # no browser installed in this environment
            self.skipTest(f"Chromium is not available: {error}")

    async def serve_meeting(self, joined: list, html: str = MEETING_PAGE) -> TestServer:
        meeting = web.Application()

        async def page(_request):
            return web.Response(text=html, content_type="text/html")

        async def record(request):
            joined.append(await request.json())
            return web.Response(status=204)

        meeting.router.add_post("/joined", record)
        meeting.router.add_get("/{path:.*}", page)
        server = TestServer(meeting)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        return server

    async def serve_justai(self) -> tuple[FakeJustAI, TestServer]:
        fake = FakeJustAI()
        server = TestServer(fake.app)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        return fake, server

    async def test_joins_and_forwards_the_meeting_audio(self):
        joined = []
        meeting_server = await self.serve_meeting(joined)
        fake, justai_server = await self.serve_justai()

        bot = MeetingBot(
            BotConfig(
                justai_url=str(justai_server.make_url("")),
                source_id=SOURCE_ID,
                token=TOKEN,
                meeting_url=str(meeting_server.make_url("/meeting?end_after=8")),
                meeting_id="1234567",
                passcode="geheim",
                join_timeout=30,
                alone_minutes=0,
                silence_minutes=0,
                camera="off",
            )
        )
        code = await asyncio.wait_for(bot.run(), timeout=90)

        self.assertEqual(code, EXIT_OK, bot.end_reason)
        self.assertEqual(bot.end_reason, "the meeting ended")
        self.assertEqual(joined, [{"meetingId": "1234567", "passcode": "geheim", "name": "JustAI Transkription (Bot)", "camera": "false", "microphone": "false"}])

        types = [c["type"] for c in fake.controls]
        self.assertEqual(types[0], "transcription.start")
        self.assertEqual(types[-1], "transcription.stop")
        self.assertIn("source.level", types)

        pcm = fake.pcm()
        seconds = len(pcm) / 2 / 16000
        self.assertGreater(seconds, 4, "several seconds of call audio should arrive")
        loud = b"".join(f[3] for f in fake.frames if rms(f[3]) > 0.05)
        self.assertGreater(len(loud) / 2 / 16000, 3, "the far end's tone should be audible")
        self.assertAlmostEqual(dominant_frequency(loud), 440, delta=25)
        self.assertTrue(all(f[2] == 16000 for f in fake.frames))

    async def test_joins_the_cisco_meeting_server_name_step(self):
        joined = []
        meeting_server = await self.serve_meeting(joined, CMS_NAME_PAGE)
        fake, justai_server = await self.serve_justai()
        bot = MeetingBot(
            BotConfig(
                justai_url=str(justai_server.make_url("")),
                source_id=SOURCE_ID,
                token=TOKEN,
                meeting_url=str(meeting_server.make_url("/de-DE/meeting/32671669?secret=abc-123")),
                join_timeout=30,
                alone_minutes=0,
                silence_minutes=0,
            )
        )
        code = await asyncio.wait_for(bot.run(), timeout=90)
        self.assertEqual(code, EXIT_OK, bot.end_reason)
        self.assertEqual(bot.end_reason, "the meeting ended")
        # The camera stays on and shows the JustAI card; the microphone is muted once,
        # from its state label in the call's toolbar ("Mikrofon aktiviert").
        self.assertEqual(joined[0], {"name": "JustAI Transkription (Bot)", "secret": "abc-123", "camera": True})
        self.assertIn({"microphone": False}, joined)
        self.assertNotIn({"video": "clicked"}, joined)
        picture = next(item["picture"] for item in joined if "picture" in item)
        self.assertGreater(picture["bright"], 180, "the card's white text should show, not a black picture")
        self.assertGreater(picture["bluePixels"], 200, "the blue JustAI logo should show")
        loud = b"".join(f[3] for f in fake.frames if rms(f[3]) > 0.05)
        self.assertGreater(len(loud) / 2 / 16000, 2, "the far end's tone should be audible")

    async def test_leaves_when_alone_although_audio_still_arrives(self):
        joined = []
        meeting_server = await self.serve_meeting(joined, CMS_NAME_PAGE)
        fake, justai_server = await self.serve_justai()
        bot = MeetingBot(
            BotConfig(
                justai_url=str(justai_server.make_url("")),
                source_id=SOURCE_ID,
                token=TOKEN,
                meeting_url=str(meeting_server.make_url("/de-DE/meeting/1?secret=x&alone_after=3")),
                join_timeout=30,
                alone_minutes=0.1,  # six seconds
                silence_minutes=0,
            )
        )
        started = asyncio.get_running_loop().time()
        code = await asyncio.wait_for(bot.run(), timeout=90)
        self.assertEqual((code, bot.end_reason), (EXIT_OK, "no other participant for a while"))
        # Alone after about 3 s in the call plus 6 s; never on the lobby count of 4.
        self.assertLess(asyncio.get_running_loop().time() - started, 45)
        self.assertEqual(fake.controls[-1]["type"], "transcription.stop")

    async def test_a_failed_join_is_reported_and_the_stream_stopped(self):
        joined = []
        meeting_server = await self.serve_meeting(joined)
        fake, justai_server = await self.serve_justai()
        with tempfile.TemporaryDirectory() as debug:
            bot = MeetingBot(
                BotConfig(
                    justai_url=str(justai_server.make_url("")),
                    source_id=SOURCE_ID,
                    token=TOKEN,
                    meeting_url=str(meeting_server.make_url("/meeting")),
                    meeting_id="1234567",  # no passcode: the form never lets the bot through
                    join_timeout=6,
                    debug_dir=debug,
                )
            )
            code = await asyncio.wait_for(bot.run(), timeout=60)
            saved = sorted(p.suffix for p in Path(debug).iterdir())
        self.assertEqual(code, EXIT_JOIN_FAILED)
        self.assertEqual(joined, [])
        self.assertEqual(saved, [".html", ".png"])
        self.assertEqual(fake.controls[-1]["type"], "transcription.stop")

    async def test_the_service_runs_and_stops_a_real_bot(self):
        joined = []
        meeting_server = await self.serve_meeting(joined)
        fake, justai_server = await self.serve_justai()
        token = "service-token-0123456789"
        service = BotService(ServiceConfig(token=token, justai_url=str(justai_server.make_url("")).rstrip("/"), allow_http_meetings=True, join_timeout=30))
        service_server = TestServer(service.app)
        await service_server.start_server()
        self.addAsyncCleanup(service_server.close)
        bot_url = str(service_server.make_url(f"/v1/bots/{SOURCE_ID}"))
        async with aiohttp.ClientSession(headers={"Authorization": f"Bearer {token}"}) as http:
            body = {"sourceId": SOURCE_ID, "token": TOKEN, "meetingUrl": str(meeting_server.make_url("/meeting?end_after=120")), "meetingId": "1234567", "passcode": "geheim"}
            async with http.post(str(service_server.make_url("/v1/bots")), json=body) as response:
                self.assertEqual(response.status, 202)

            async def status():
                async with http.get(bot_url) as response:
                    return await response.json()

            for _ in range(120):
                if (await status())["status"] in ("in_call", "failed"):
                    break
                await asyncio.sleep(0.25)
            self.assertEqual((await status())["status"], "in_call")
            await asyncio.sleep(2)  # let some call audio through
            async with http.delete(bot_url) as response:
                self.assertEqual(response.status, 202)
            await asyncio.wait_for(service.jobs[SOURCE_ID].task, 30)
            final = await status()
        self.assertEqual((final["status"], final["reason"], final["exitCode"]), ("ended", "stop requested", 0))
        self.assertEqual(len(joined), 1)
        self.assertEqual(fake.controls[-1]["type"], "transcription.stop")
        self.assertGreater(len(fake.frames), 5)


if __name__ == "__main__":
    unittest.main()
