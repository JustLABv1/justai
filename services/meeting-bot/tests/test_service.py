import asyncio
import unittest

import aiohttp
from aiohttp.test_utils import TestServer

from meeting_bot.bot import EXIT_OK, BotConfig
from meeting_bot.service import BotService, ServiceConfig

SERVICE_TOKEN = "service-token-0123456789"
SOURCE = "5a3f8a8e-1111-4222-8333-944455556666"
OTHER = "6b4f8a8e-1111-4222-8333-944455556666"


class StubBot:
    """Stands in for MeetingBot: stays "in_call" until stopped."""

    created: list[BotConfig] = []

    def __init__(self, config: BotConfig, *, handle_signals: bool = True):
        assert handle_signals is False, "service bots must leave signals to the service"
        StubBot.created.append(config)
        self.config = config
        self.status = "starting"
        self.end_reason = ""
        self.exit_code = None
        self._stop = asyncio.Event()

    def stop(self):
        self._stop.set()

    async def run(self):
        self.status = "in_call"
        await self._stop.wait()
        self.status, self.end_reason, self.exit_code = "ended", "stop requested", EXIT_OK
        return EXIT_OK


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        StubBot.created = []
        self.config = ServiceConfig(token=SERVICE_TOKEN, justai_url="http://justai-backend:8080", max_bots=1)
        self.service = BotService(self.config, bot_factory=StubBot)
        self.server = TestServer(self.service.app)
        await self.server.start_server()
        self.http = aiohttp.ClientSession(headers={"Authorization": f"Bearer {SERVICE_TOKEN}"})
        self.addAsyncCleanup(self.http.close)
        self.addAsyncCleanup(self.server.close)

    def url(self, path):
        return str(self.server.make_url(path))

    async def start(self, **overrides):
        body = {"sourceId": SOURCE, "token": "ingest-token", "meetingUrl": "https://meet.example.org/meeting/123?secret=abc", "meetingId": "123", "passcode": "456"} | overrides
        async with self.http.post(self.url("/v1/bots"), json=body) as response:
            return response.status, await response.json()

    async def test_requires_the_service_token(self):
        async with aiohttp.ClientSession() as anonymous:
            async with anonymous.post(self.url("/v1/bots"), json={}) as response:
                self.assertEqual(response.status, 401)
            async with anonymous.get(self.url("/v1/bots"), headers={"Authorization": "Bearer wrong"}) as response:
                self.assertEqual(response.status, 401)
            async with anonymous.get(self.url("/healthz")) as response:
                self.assertEqual(response.status, 200)

    async def test_starts_reports_and_stops_a_bot(self):
        status, body = await self.start()
        self.assertEqual(status, 202)
        self.assertEqual(body["meetingHost"], "https://meet.example.org")
        config = StubBot.created[0]
        # The JustAI address is the service's own, whatever the request says.
        self.assertEqual(config.justai_url, "http://justai-backend:8080")
        self.assertEqual((config.source_id, config.token, config.meeting_id, config.passcode), (SOURCE, "ingest-token", "123", "456"))
        self.assertEqual(config.name, "JustAI Transkription (Bot)")

        await asyncio.sleep(0)
        async with self.http.get(self.url(f"/v1/bots/{SOURCE}")) as response:
            self.assertEqual((await response.json())["status"], "in_call")
        async with self.http.get(self.url("/v1/bots")) as response:
            listed = await response.text()
        self.assertNotIn("ingest-token", listed)
        self.assertNotIn("456", listed)
        self.assertNotIn("secret=abc", listed)

        async with self.http.delete(self.url(f"/v1/bots/{SOURCE}")) as response:
            self.assertEqual(response.status, 202)
        await asyncio.wait_for(self.service.jobs[SOURCE].task, 2)
        async with self.http.get(self.url(f"/v1/bots/{SOURCE}")) as response:
            view = await response.json()
        self.assertEqual((view["status"], view["exitCode"]), ("ended", 0))

    async def test_start_is_idempotent_and_capacity_is_bounded(self):
        self.assertEqual((await self.start())[0], 202)
        self.assertEqual((await self.start())[0], 200)
        self.assertEqual(len(StubBot.created), 1)
        status, body = await self.start(sourceId=OTHER)
        self.assertEqual(status, 429)
        self.assertIn("slots", body["error"])

    async def test_rejects_bad_requests(self):
        for overrides, message in [
            ({"sourceId": "nope"}, "UUID"),
            ({"token": ""}, "token"),
            ({"meetingUrl": "http://meet.example.org/x"}, "https"),
            ({"meetingUrl": "javascript:alert(1)"}, "https"),
            ({"platform": "skype"}, "platform"),
            ({"passcode": 5}, "passcode"),
        ]:
            status, body = await self.start(**overrides)
            self.assertEqual(status, 400, overrides)
            self.assertIn(message, body["error"])
        async with self.http.get(self.url(f"/v1/bots/{OTHER}")) as response:
            self.assertEqual(response.status, 404)
        async with self.http.delete(self.url(f"/v1/bots/{OTHER}")) as response:
            self.assertEqual(response.status, 404)

    async def test_shutdown_stops_running_bots(self):
        await self.start()
        await asyncio.sleep(0)
        await self.service._shutdown(self.service.app)
        self.assertEqual(self.service.jobs[SOURCE].bot.status, "ended")

    def test_config_validation(self):
        for config, message in [
            (ServiceConfig(token="short", justai_url="http://x:1"), "TOKEN"),
            (ServiceConfig(token=SERVICE_TOKEN, justai_url="backend:8080"), "JUSTAI_URL"),
            (ServiceConfig(token=SERVICE_TOKEN, justai_url="http://x:1", max_bots=0), "MAX_BOTS"),
        ]:
            with self.assertRaisesRegex(ValueError, message):
                config.validate()


if __name__ == "__main__":
    unittest.main()
