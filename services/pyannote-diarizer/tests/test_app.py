"""Exercise the real decoder/PyTorch runtime without downloading gated models.

Run inside the diarizer image with tests mounted at /tests:
  python -m unittest discover -s /tests -v
"""
from __future__ import annotations

import array
import importlib.util
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch
import wave

import torch
from fastapi import HTTPException


class ModelStub:
    def to(self, device):
        return self


def load_service():
    audio = types.ModuleType("pyannote.audio")
    audio.Pipeline = types.SimpleNamespace(
        from_pretrained=lambda model, token=None: ModelStub()
    )
    speaker = types.ModuleType("pyannote.audio.pipelines.speaker_diarization")
    speaker.get_plda = lambda *args, **kwargs: None
    pipelines = types.ModuleType("pyannote.audio.pipelines")
    pipelines.speaker_diarization = speaker
    modules = {
        "pyannote": types.ModuleType("pyannote"),
        "pyannote.audio": audio,
        "pyannote.audio.pipelines": pipelines,
        "pyannote.audio.pipelines.speaker_diarization": speaker,
    }
    service_path = Path(os.getenv("PYANNOTE_TEST_APP", "/app/app.py"))
    spec = importlib.util.spec_from_file_location("diarizer_under_test", service_path)
    service = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules), patch.dict(os.environ, {
        "HF_TOKEN": "test-only",
        "PYANNOTE_SERVICE_TOKEN": "test-service-token-not-a-real-secret",
        "PYANNOTE_ALLOWED_MEDIA_ORIGINS": "https://media.example.com",
        "PYANNOTE_DEVICE": "cpu",
        "PYANNOTE_MODEL_PATH": "",
        "PYANNOTE_SEGMENTATION_BATCH_SIZE": "2",
        "PYANNOTE_EMBEDDING_BATCH_SIZE": "3",
        "PYANNOTE_MEMORY_LOG_INTERVAL_SECONDS": "0",
    }):
        sys.modules[spec.name] = service
        spec.loader.exec_module(service)
    return service


app = load_service()


def write_wav(path, samples, channels=1, width=2):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(16000)
        wav.writeframes(samples)


class AudioTests(unittest.TestCase):
    def test_block_decode_preserves_every_sample_and_never_reads_entire_audio(self):
        count = 16000 * app.AUDIO_READ_SECONDS * 2 + 5
        pattern = [-32768, -16384, -1, 0, 1, 16384, 32767]
        samples = array.array("h", (pattern[i % len(pattern)] for i in range(count)))
        reads = []
        original = wave.Wave_read.readframes

        def readframes(audio, frames):
            self.assertLessEqual(frames, 16000 * app.AUDIO_READ_SECONDS)
            reads.append(frames)
            return original(audio, frames)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            write_wav(path, samples.tobytes())
            with patch.object(wave.Wave_read, "readframes", readframes):
                result = app.load_extracted_audio(path)
        expected = torch.tensor(samples, dtype=torch.float32).unsqueeze(0).div_(32768)
        torch.testing.assert_close(result["waveform"], expected, rtol=0, atol=0)
        self.assertEqual(result["sample_rate"], 16000)
        self.assertEqual(result["waveform"].device.type, "cpu")
        self.assertEqual(reads, [16000 * app.AUDIO_READ_SECONDS] * 2 + [5])

    def test_rejects_invalid_format_before_allocating_waveform(self):
        with tempfile.TemporaryDirectory() as directory:
            for channels, width, data in [(2, 2, b"\0" * 8), (1, 1, b"\0" * 8), (1, 2, b"")]:
                with self.subTest(channels=channels, width=width, length=len(data)):
                    path = Path(directory) / "audio.wav"
                    write_wav(path, data, channels, width)
                    with patch.object(torch, "empty") as allocate, self.assertRaises(HTTPException) as caught:
                        app.load_extracted_audio(path)
                    self.assertEqual(caught.exception.status_code, 422)
                    allocate.assert_not_called()

    def test_rejects_forged_frame_count_without_allocating_large_tensor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            write_wav(path, b"\0\0" * 10)
            data = bytearray(path.read_bytes())
            struct.pack_into("<I", data, 40, 2_000_000_000)
            path.write_bytes(data)
            with patch.object(torch, "empty") as allocate, self.assertRaises(HTTPException) as caught:
                app.load_extracted_audio(path)
            self.assertEqual(caught.exception.status_code, 422)
            allocate.assert_not_called()

    def test_rejects_short_pcm_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            write_wav(path, b"\0\0" * 10)
            # Simulate a short read from truncated/corrupt storage.
            original = wave.Wave_read.readframes
            with patch.object(wave.Wave_read, "readframes", lambda audio, n: original(audio, max(0, n - 1))):
                with self.assertRaises(HTTPException) as caught:
                    app.load_extracted_audio(path)
            self.assertEqual(caught.exception.status_code, 422)

    def test_missing_wav_is_a_validation_error(self):
        with self.assertRaises(HTTPException) as caught:
            app.load_extracted_audio(Path("/nonexistent-audio-for-test.wav"))
        self.assertEqual(caught.exception.status_code, 422)


class PipelineTests(unittest.TestCase):
    def test_batch_settings_are_applied_to_loaded_pipeline(self):
        self.assertEqual(app.PIPELINE.segmentation_batch_size, 2)
        self.assertEqual(app.PIPELINE.embedding_batch_size, 3)

    def test_single_global_inference_keeps_wrapper_and_legacy_outputs_compatible(self):
        track = types.SimpleNamespace(start=1.23456, end=2.34567)
        invalid = types.SimpleNamespace(start=float("nan"), end=3)
        annotation = types.SimpleNamespace(itertracks=lambda **kw: [(track, None, "SPEAKER_02"), (invalid, None, "ignored")])
        request = app.DiarizeRequest(media_url="https://media.example.com/video", num_speakers=3)
        for output in [annotation, types.SimpleNamespace(speaker_diarization=annotation)]:
            def infer(audio, **kwargs):
                self.assertTrue(torch.is_inference_mode_enabled())
                self.assertEqual(kwargs["num_speakers"], 3)
                kwargs["hook"]("embeddings", audio)
                return output
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "audio.wav"
                write_wav(path, b"\0\0" * 16000)
                monitor = app.MemoryMonitor()
                with patch.object(app, "PIPELINE", Mock(side_effect=infer)) as pipeline:
                    turns = app.run_diarization(path, request, monitor)
                    pipeline.assert_called_once()
            self.assertEqual([(t.speaker, t.start, t.end) for t in turns], [("SPEAKER_02", 1.235, 2.346)])
            self.assertEqual(monitor.phase, "inference:embeddings")

    def test_monitor_stops_sampler_after_an_inference_failure(self):
        with patch.object(app, "MEMORY_LOG_INTERVAL_SECONDS", 0.01), patch.object(app.MemoryMonitor, "log") as log:
            monitor = app.MemoryMonitor()
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                with monitor:
                    monitor.set_phase("inference:clustering")
                    raise RuntimeError("inference failed")
            self.assertFalse(monitor.thread.is_alive())
            self.assertEqual(monitor.phase, "failed")
            self.assertGreaterEqual(log.call_count, 3)

    def test_monitor_samples_without_pipeline_progress_callbacks(self):
        sampled = threading.Event()
        calls = []

        def log():
            calls.append(1)
            if len(calls) >= 2:
                sampled.set()

        with patch.object(app, "MEMORY_LOG_INTERVAL_SECONDS", 0.01), patch.object(app.MemoryMonitor, "log", side_effect=log):
            with app.MemoryMonitor() as monitor:
                self.assertTrue(sampled.wait(2))
            self.assertFalse(monitor.thread.is_alive())

    def test_diagnostics_distinguish_cgroup_ram_from_cuda_allocator_usage(self):
        files = {
            "/proc/self/statm": "1000 100",
            "/sys/fs/cgroup/memory.current": str(7 * 1024**3),
            "/sys/fs/cgroup/memory.max": str(8 * 1024**3),
        }
        with patch.object(Path, "read_text", lambda path: files[str(path)]), patch.object(app, "DEVICE", types.SimpleNamespace(type="cuda")), patch.object(torch.cuda, "is_initialized", return_value=True), patch.object(torch.cuda, "memory_allocated", return_value=1024**3), patch.object(torch.cuda, "memory_reserved", return_value=2 * 1024**3):
            stats = app.memory_stats()
        self.assertEqual(stats["cgroup_memory_mib"], 7168)
        self.assertEqual(stats["cgroup_limit_mib"], 8192)
        self.assertEqual(stats["cuda_allocated_mib"], 1024)
        self.assertEqual(stats["cuda_reserved_mib"], 2048)

    def test_diagnostics_tolerate_missing_procfs_and_cgroup_files(self):
        with patch.object(Path, "read_text", side_effect=OSError("not available")):
            stats = app.memory_stats()
        self.assertIsNone(stats["rss_mib"])
        self.assertIsNone(stats["cgroup_memory_mib"])
        self.assertIsNone(stats["cgroup_limit_mib"])
        self.assertGreater(stats["process_peak_rss_mib"], 0)

    def test_extraction_and_inference_do_not_overlap_between_requests(self):
        started = threading.Event()
        release = threading.Event()
        second_waiting = threading.Event()
        lock = threading.Lock()
        lock_entries = []
        events = []
        errors = []

        class ObservedLock:
            def __enter__(self):
                lock_entries.append(1)
                if len(lock_entries) == 2:
                    second_waiting.set()
                lock.acquire()
            def __exit__(self, *args):
                lock.release()

        def download(url, destination):
            destination.write_bytes(b"source")

        def extract(source, destination):
            events.append("extract")
            destination.write_bytes(b"wav")

        def infer(*args):
            events.append("inference")
            if len(events) == 2:
                started.set()
                if not release.wait(5):
                    raise RuntimeError("test did not release first inference")
            return []

        def run():
            try:
                app.diarize(app.DiarizeRequest(media_url="https://media.example.com/video"), types.SimpleNamespace(headers={"authorization": f"Bearer {app.SERVICE_TOKEN}"}))
            except BaseException as error:
                errors.append(error)

        with patch.object(app, "PIPELINE_LOCK", ObservedLock()), patch.object(app, "download_source", download), patch.object(app, "extract_audio", extract), patch.object(app, "validate_audio", return_value=1), patch.object(app, "run_diarization", infer):
            first = threading.Thread(target=run)
            second = threading.Thread(target=run)
            first.start()
            try:
                self.assertTrue(started.wait(5))
                second.start()
                self.assertTrue(second_waiting.wait(5))
                self.assertEqual(events, ["extract", "inference"])
            finally:
                release.set()
                first.join(5)
                if second.ident is not None:
                    second.join(5)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(events, ["extract", "inference", "extract", "inference"])


if __name__ == "__main__":
    unittest.main()
