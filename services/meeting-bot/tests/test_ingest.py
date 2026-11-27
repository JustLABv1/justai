import asyncio
import struct
import unittest

import aiohttp
from aiohttp.test_utils import TestServer

from meeting_bot.ingest import IngestError, JustAIIngest
from tests.fake_justai import SOURCE_ID, TOKEN, FakeJustAI


def tone(samples: int = 1600) -> bytes:
    return struct.pack(f"<{samples}h", *([8000, -8000] * (samples // 2)))


class IngestTests(unittest.IsolatedAsyncioTestCase):
    async def start(self, fake: FakeJustAI, token: str = TOKEN):
        self.server = TestServer(fake.app)
        await self.server.start_server()
        self.http = aiohttp.ClientSession()
        self.addAsyncCleanup(self.http.close)
        self.addAsyncCleanup(self.server.close)
        return JustAIIngest(str(self.server.make_url("")), SOURCE_ID, token, self.http, ready_timeout=5)

    async def wait_until(self, predicate, timeout=5.0):
        deadline = asyncio.get_running_loop().time() + timeout
        while not predicate():
            if asyncio.get_running_loop().time() > deadline:
                self.fail("condition not reached")
            await asyncio.sleep(0.05)

    async def test_streams_audio_and_stops(self):
        fake = FakeJustAI()
        ingest = await self.start(fake)
        await ingest.connect()
        for _ in range(5):
            ingest.push_pcm(tone())
        await self.wait_until(lambda: len(fake.frames) == 5)
        await ingest.stop()

        self.assertEqual(fake.controls[0]["type"], "transcription.start")
        self.assertEqual(fake.controls[-1]["type"], "transcription.stop")
        sequences = [c["transportSequence"] for c in fake.controls]
        self.assertEqual(sequences, sorted(set(sequences)), "control sequences must strictly increase")
        self.assertEqual(fake.batch_sequences, list(range(1, len(fake.batch_sequences) + 1)))
        self.assertEqual([f[1] for f in fake.frames], [0, 1, 2, 3, 4])
        self.assertTrue(all(f[2] == 16000 for f in fake.frames))
        self.assertEqual(fake.pcm(), tone() * 5)
        self.assertTrue(ingest.closed.is_set())

    async def test_resumes_a_dropped_event_stream(self):
        fake = FakeJustAI(drop_sse_once_after_ready=True)
        ingest = await self.start(fake)
        await ingest.connect()
        await self.wait_until(lambda: fake.resumes == 1)
        ingest.push_pcm(tone())
        await self.wait_until(lambda: len(fake.frames) == 1)
        self.assertFalse(ingest.closed.is_set())
        await ingest.stop()
        self.assertEqual(ingest.stats.resumes, 1)

    async def test_wrong_token_is_reported(self):
        ingest = await self.start(FakeJustAI(), token="wrong")
        with self.assertRaisesRegex(IngestError, "invalid or revoked bot ingest token"):
            await ingest.connect()

    async def test_provider_error_before_ready_is_reported(self):
        ingest = await self.start(FakeJustAI(error_before_ready="transcription provider connection failed: boom"))
        with self.assertRaisesRegex(IngestError, "provider connection failed"):
            await ingest.connect()
        await ingest.stop()

    async def test_session_end_closes_as_a_normal_end(self):
        fake = FakeJustAI()
        ingest = await self.start(fake)
        await ingest.connect()
        stream = next(iter(fake.streams.values()))
        stream.emit("transcription.session", {"status": "completed"})
        await asyncio.wait_for(ingest.closed.wait(), 5)
        self.assertTrue(ingest.session_ended)
        await ingest.stop()

    async def test_backlog_is_bounded(self):
        fake = FakeJustAI(ready=False)
        ingest = await self.start(fake)
        for _ in range(400):  # 1.28 MB at 3.2 kB each, more than the 1 MB bound
            ingest.push_pcm(tone())
        self.assertGreater(ingest.stats.dropped_chunks, 0)
        await ingest.stop()


if __name__ == "__main__":
    unittest.main()
