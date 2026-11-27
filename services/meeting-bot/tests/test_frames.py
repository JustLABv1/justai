import struct
import unittest

from meeting_bot.frames import decode_batch, encode_batch, encode_frame, pcm_level


class FrameTests(unittest.TestCase):
    def test_frame_layout_matches_the_backend_parser(self):
        # parseAudioFrame: version at 0, LE uint64 time at 1..9, LE uint32 sequence
        # at 9..13, LE uint32 rate at 13..17, PCM after.
        frame = encode_frame(b"\x01\x02\x03\x04", sequence=7, timestamp_ms=1_764_230_000_123)
        self.assertEqual(frame[0], 1)
        self.assertEqual(struct.unpack("<Q", frame[1:9])[0], 1_764_230_000_123)
        self.assertEqual(struct.unpack("<I", frame[9:13])[0], 7)
        self.assertEqual(struct.unpack("<I", frame[13:17])[0], 16000)
        self.assertEqual(frame[17:], b"\x01\x02\x03\x04")

    def test_batch_prefixes_each_frame_with_a_big_endian_length(self):
        a, b = encode_frame(b"\x00\x00", 1, 10), encode_frame(b"\x01\x00\x02\x00", 2, 20)
        body = encode_batch([a, b])
        self.assertEqual(struct.unpack(">I", body[:4])[0], len(a))
        self.assertEqual(decode_batch(body), [(10, 1, 16000, b"\x00\x00"), (20, 2, 16000, b"\x01\x00\x02\x00")])

    def test_limits(self):
        with self.assertRaises(ValueError):
            encode_frame(b"\x00", 0, 0)  # odd PCM length
        with self.assertRaises(ValueError):
            encode_frame(b"", 0, 0, sample_rate=4000)
        with self.assertRaises(ValueError):
            encode_batch([])
        with self.assertRaises(ValueError):
            encode_batch([encode_frame(b"", i, 0) for i in range(513)])

    def test_sequence_wraps_like_a_uint32(self):
        frame = encode_frame(b"", 2**32 + 5, 0)
        self.assertEqual(struct.unpack("<I", frame[9:13])[0], 5)

    def test_level(self):
        self.assertEqual(pcm_level(b""), 0.0)
        self.assertEqual(pcm_level(b"\x00\x00" * 10), 0.0)
        loud = struct.pack("<4h", 16384, -16384, 16384, -16384)
        self.assertAlmostEqual(pcm_level(loud), 0.5, places=3)


if __name__ == "__main__":
    unittest.main()
